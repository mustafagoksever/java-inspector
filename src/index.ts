import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { encode as toonEncode } from '@toon-format/toon';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import fs from 'fs-extra';
import { JavaClassAnalyzer, ClassAnalysis, HierarchyEntry } from './analyzer/JavaClassAnalyzer.js';
import { jdkSourceService } from './analyzer/JdkSourceService.js';
import { DependencyScanner } from './scanner/DependencyScanner.js';
import { DecompilerService } from './decompiler/DecompilerService.js';
import { artifactService, ArtifactSelector, ClassCandidate } from './scanner/ArtifactService.js';
import { jarIndexer } from './scanner/JarIndexer.js';
import { projectDiscovery } from './scanner/ProjectDiscovery.js';
import { ClassFileMetadataReader } from './scanner/ClassFileMetadataReader.js';
import { getResultCacheDir } from './utils/cachePaths.js';
import { extractMethod, extractTypeDeclaration } from './utils/methodExtractor.js';
import { Logger } from './utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
type Format = 'text' | 'json' | 'toon';
type SourceSlice = { source: string; sourceRange?: { startLine: number; endLine: number; totalLines: number }; sourceOrigin?: 'embedded-source' | 'sources-jar' | 'decompiled' | 'jdk-src.zip'; enclosingClass?: string; sourceNote?: string };
type Progress = (message: string, progress?: number, total?: number) => Promise<void>;

/**
 * Sent to the client in the initialize response. Clients such as Claude Code and
 * Cursor inject this into the model's context, which is what makes the agent pick
 * these tools over shelling out to javap / unzip / jar / find ~/.m2.
 */
export const SERVER_INSTRUCTIONS = `java-inspector gives read-only access to compiled Java code: Maven dependencies of the workspace, local JAR/WAR/Spring Boot fat JARs, and JDK classes.

Prefer these tools over shell commands for anything inside a JAR or the JDK:
- Instead of \`javap\` / \`javap -c\` / \`javap -p\`: inspect_class with view "api" (signatures) or "bytecode".
- Instead of decompiling by hand or guessing library behaviour: inspect_class with view "source" (uses -sources.jar when present, otherwise Vineflower). Pass methodName to get a single method; nested classes are addressed as Outer$Inner.
- For classes from the project's Maven dependencies, pass only className (fully qualified). Do NOT look up the JAR in ~/.m2 or pass jarPath first: the server knows the project classpath and finds the JAR itself, waiting for Maven if the project is opened for the first time.
- Instead of \`unzip -l\`, \`jar tf\`, \`find ~/.m2 -name\`, \`grep -r\` over JARs: search_class, find_jar, inspect_jar, search_resources, read_resource.
- Instead of \`mvn dependency:tree\`: explain_dependency. For version conflicts / the same class in several JARs (NoSuchMethodError, ClassCastException): find_duplicates.
- To find who implements an interface or calls/declares a member or uses a string: find_implementations / search_code.

Workflow: inspect_class with the fully qualified name; if you only know the simple name, search_class first. No scan is required first: the Maven classpath is resolved in the background at startup and tools return partial results with complete=false instead of waiting. When a result is ambiguous, the response lists candidates; repeat the call with jarPath set to one of them. All paths must be absolute.`;

const FORMAT = z.enum(['text', 'json', 'toon']).default('text').describe('Response format. "text" is compact and human-readable; "json" returns the full structured result; "toon" is a token-efficient structured encoding.');
const MODE = z.enum(['fast', 'balanced']).default('balanced').describe('"fast" opens fewer unindexed JARs per call (lower latency, more likely partial); "balanced" opens more.');
const num = (description: string) => z.coerce.number().int().optional().describe(description);
const SELECTOR = {
    workspacePath: z.string().optional().describe('Absolute path of the Java workspace (directory containing pom.xml, or a parent of several Maven projects). Defaults to the server cwd when no other selector is given.'),
    jarPath: z.string().optional().describe('Absolute path to one exact JAR. Not needed for Maven dependencies of the workspace (they are resolved from the classpath). Use it for JARs outside the Maven classpath, or to choose one of the candidates a previous response listed.'),
    jarDirectory: z.string().optional().describe('Absolute directory to search for JARs on demand (for non-Maven projects, e.g. a lib/ folder).'),
    jarNamePrefix: z.string().optional().describe('Restrict to JARs whose file name starts with this, e.g. "spring-web" or "jackson-databind-2.17".'),
    coordinates: z.string().optional().describe('Maven coordinates groupId:artifactId[:version[:classifier]] resolved from the local repository, e.g. "com.fasterxml.jackson.core:jackson-databind".'),
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export class JavaClassAnalyzerMCPServer {
    private mcp: McpServer;
    private analyzer = new JavaClassAnalyzer();
    private scanner = new DependencyScanner();
    private decompiler = new DecompilerService();

    /** Low-level protocol server (kept for tests and advanced use). */
    get server() { return this.mcp.server; }

    constructor() {
        this.mcp = new McpServer(
            { name: 'java-inspector', title: 'Java Inspector', version },
            { capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS },
        );
        this.setupHandlers();
    }

    private setupHandlers(): void {
        type Handler = (args: any, sendProgress: Progress) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
        const register = (name: string, title: string, description: string, inputSchema: z.ZodRawShape, handler: Handler) => {
            this.mcp.registerTool(name, { title, description, inputSchema, annotations: { title, ...READ_ONLY } }, async (args: any, extra: any) => {
                const sendProgress: Progress = async (message, progress, total) => {
                    const progressToken = extra?._meta?.progressToken;
                    if (progressToken === undefined) return;
                    // MCP requires a numeric progress value on every progress notification.
                    await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, message, progress: progress ?? 0, total } }).catch(() => {});
                };
                try {
                    // Must be awaited: returning the bare promise would let rejections escape this
                    // try/catch and surface as JSON-RPC protocol errors instead of tool errors the model can read.
                    return await handler(args, sendProgress);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { content: [{ type: 'text' as const, text: `Tool call failed: ${message}` }], isError: true };
                }
            });
        };

        register('scan_project', 'Scan Maven dependencies',
            'Start, refresh, or poll the background index of a Maven workspace\'s dependency JARs. Returns immediately. ' +
            'Usually NOT needed: the server auto-scans the top-level pom.xml files under its cwd at startup and every other tool works on a partial index. ' +
            'Call it to index a different workspace, to check progress, or with forceRefresh=true after pom.xml changes.',
            { workspacePath: z.string().describe('Absolute workspace path containing pom.xml (or parent of several Maven projects).'), forceRefresh: z.boolean().default(false).describe('Drop the cached classpath/index and re-run Maven.'), format: FORMAT },
            (args, progress) => this.handleScanProject(args, progress));

        register('find_jar', 'Find JAR',
            'Locate dependency/local JAR files by file name prefix, substring, exact name, or Maven coordinates, without opening them. ' +
            'Use instead of `find ~/.m2 -name "*.jar"` or `ls lib/`. Returns absolute jarPath values usable as the jarPath selector of other tools.',
            { ...SELECTOR, match: z.enum(['exact', 'prefix', 'contains']).default('prefix').describe('How jarNamePrefix / the coordinates artifactId is matched against JAR file names.'), limit: num('Max results (1-100, default 20).'), format: FORMAT },
            args => this.handleFindJar(args));

        register('inspect_jar', 'Inspect JAR contents',
            'List what is inside ONE JAR: manifest, Maven coordinates (pom.properties), layout (plain, Spring Boot, WAR, multi-release), packages, classes, resources and nested JARs. ' +
            'Use instead of `unzip -l` / `jar tf`. If the selector matches several JARs, candidates are returned; repeat with jarPath. Entries are paginated with offset/limit and can be filtered with query.',
            { ...SELECTOR, query: z.string().optional().describe('Case-insensitive substring filter on class names and resource paths.'), offset: num('1-based index of the first entry to return (default 1).'), limit: num('Max entries to return (1-1000, default 100).'), format: FORMAT },
            args => this.handleInspectJar(args));

        register('search_class', 'Search classes',
            'Find classes by simple name, fully qualified name, or partial name (e.g. "ObjectMapper", "jackson ObjectMapper", "web.client.RestTemplate") across the workspace\'s Maven dependencies, a JAR directory, or one JAR. ' +
            'First step before inspect_class when the package is unknown. Uses the live (possibly still-building) index and opens unindexed JARs on demand; complete=false means more JARs remain, so call again or narrow with jarNamePrefix. ' +
            'Use instead of `unzip -l *.jar | grep` or `find ~/.m2`.',
            { query: z.string().describe('Class name or fragment. Space/dot separated parts must all appear in the fully qualified name.'), ...SELECTOR, includeJdk: z.boolean().default(false).describe('Also search JDK classes (java.*, javax.*, jdk.*).'), mode: MODE, limit: num('Max results (1-100, default 20).'), format: FORMAT },
            (args, progress) => this.handleSearchClass(args, progress));

        register('search_code', 'Search compiled code',
            'Search bytecode metadata without decompiling: method or field declarations by name, annotations, references (calls/field accesses to an owner#member), or string constants (e.g. an exception message or config key). ' +
            'Use to answer "where is this log/error message thrown?", "who calls RestTemplate#exchange?", "which classes are annotated @AutoConfiguration?". Use instead of `grep` over decompiled code or `javap -c | grep`. ' +
            'Deep indexes are built lazily per JAR; complete=false means some JARs were not searched yet. Calling again continues where it stopped; narrowing with jarNamePrefix/jarPath is faster.',
            { query: z.string().describe('Case-insensitive substring. For kind=reference you may use "Owner#member" or "com.foo.Owner.member".'), kind: z.enum(['method', 'field', 'annotation', 'reference', 'string']).describe('What to search.'), ...SELECTOR, mode: MODE, limit: num('Max matches (1-100, default 20).'), format: FORMAT },
            (args, progress) => this.handleSearchCode(args, progress));

        register('find_implementations', 'Find implementations',
            'Find classes that implement an interface or extend a class (direct or transitive) across dependency JARs, using lazily built bytecode indexes. ' +
            'Use for "what implementations of HttpMessageConverter exist?", SPI lookups, etc. complete=false means more JARs remain; call again to continue.',
            { className: z.string().describe('Fully qualified name of the interface or superclass, e.g. "org.springframework.core.convert.converter.Converter".'), ...SELECTOR, transitive: z.boolean().default(true).describe('Include indirect subtypes (subclass of an implementation, sub-interfaces).'), mode: MODE, limit: num('Max results (1-200, default 50).'), format: FORMAT },
            (args, progress) => this.handleFindImplementations(args, progress));

        register('find_duplicates', 'Find duplicate classes',
            'List classes that exist in more than one JAR of the Maven classpath: the same artifact in two versions, split packages, or shaded/relocated copies (typical causes of NoSuchMethodError, ClassCastException, "works in IDE, fails in prod"). ' +
            'Groups duplicates by the set of JARs that share them, with Maven coordinates, class counts and sample classes. Use instead of comparing `jar tf` listings by hand; then explain_dependency tells why each JAR is on the classpath. ' +
            'complete=false means some JARs were not indexed yet; call again.',
            {
                ...SELECTOR,
                query: z.string().optional().describe('Only report duplicate classes whose fully qualified name contains this (case-insensitive), e.g. "org.slf4j" or "Logger".'),
                limit: num('Max JAR groups (1-200, default 30).'),
                classLimit: num('Sample classes listed per group (1-100, default 10).'),
                mode: MODE,
                format: FORMAT,
            },
            (args, progress) => this.handleFindDuplicates(args, progress));

        register('inspect_class', 'Inspect / decompile class',
            'Show a Java class from a Maven dependency, local JAR, or the JDK. view="source": real source from a -sources.jar if present, otherwise decompiled with Vineflower (nested classes included; ask for Outer$Inner to get only one nested class); pass methodName (and optionally paramTypes) to return a single method, or offset/limit to page large files. ' +
            'view="api": compact member signatures (replaces `javap -p`). view="bytecode": `javap -c -l -p -s` output. view="hierarchy": superclass chain and interfaces. view="all": everything. ' +
            'Use this instead of running javap or a decompiler in the shell. For Maven dependencies pass ONLY className: the JAR is found from the project classpath (no need to locate it in ~/.m2). jarPath/jarDirectory are for non-Maven JARs or to pick one of several candidates. Use search_class first if you only know the simple name.',
            {
                className: z.string().describe('Fully qualified class name, e.g. "com.fasterxml.jackson.databind.ObjectMapper". Nested classes: "com.acme.Outer$Inner" (or "com.acme.Outer.Inner"); view=source then returns just the nested declaration.'),
                ...SELECTOR,
                view: z.enum(['source', 'api', 'hierarchy', 'bytecode', 'all']).default('source').describe('Which view to return.'),
                methodName: z.string().optional().describe('view=source only: return just this method (all overloads unless paramTypes is given).'),
                paramTypes: z.array(z.string()).optional().describe('Simple or qualified parameter type names to select one overload, e.g. ["String", "int"].'),
                offset: num('view=source: 1-based first line to return (default 1). The response reports totalLines.'),
                limit: num('view=source: number of lines to return; 0 = all (default 0).'),
                useCache: z.boolean().default(true).describe('Reuse cached decompiled source.'),
                format: FORMAT,
            },
            (args, progress) => this.handleInspectClass(args, progress));

        register('explain_dependency', 'Explain dependency',
            'Explain why an artifact is on the classpath: runs a filtered `mvn dependency:tree -Dincludes=<coordinates> -Dverbose` for each Maven project in the workspace (paths from root to the artifact, conflicts, omitted versions). ' +
            'Use instead of running mvn dependency:tree yourself. Slower (runs Maven).',
            { workspacePath: z.string().describe('Absolute workspace path containing pom.xml.'), coordinates: z.string().optional().describe('groupId:artifactId (or groupId only). Optional if jarPath is given.'), jarPath: z.string().optional().describe('Absolute JAR path; coordinates are read from its pom.properties.'), format: FORMAT },
            (args, progress) => this.handleExplainDependency(args, progress));

        register('search_resources', 'Search JAR resources',
            'Find non-class files inside JARs (META-INF/spring/*.imports, META-INF/services/*, *.properties, *.xml, *.json ...) by path substring and optionally by text content. ' +
            'Use instead of `unzip -p x.jar | grep`. Then use read_resource to read a match.',
            { ...SELECTOR, pathQuery: z.string().default('').describe('Case-insensitive substring of the resource path, e.g. "META-INF/services".'), contentQuery: z.string().optional().describe('Case-insensitive text to look for inside text resources (<= 1 MB).'), limit: num('Max results (1-100, default 20).'), format: FORMAT },
            args => this.handleSearchResources(args));

        register('read_resource', 'Read JAR resource',
            'Read one text resource from inside a JAR (exact path as returned by search_resources/inspect_jar), paginated by lines. Binary resources are rejected. Use instead of `unzip -p`.',
            { ...SELECTOR, resourcePath: z.string().describe('Exact entry path inside the JAR, e.g. "META-INF/spring.factories".'), offset: num('1-based first line (default 1).'), limit: num('Number of lines (1-1000, default 200).'), format: FORMAT },
            args => this.handleReadResource(args));
    }

    private async handleScanProject(args: any, sendProgress?: Progress) {
        const workspacePath = await this.validateWorkspacePath(args.workspacePath);
        const pomRoots = await projectDiscovery.findTopLevelPomDirectories(workspacePath);
        if (pomRoots.length === 0) {
            const structured = { workspacePath, status: 'no_maven_project', pomRoots: [], message: 'Direct/local JAR tools remain available.' };
            return this.formatResponse('No Maven project found. Direct and local JAR inspection is available.', structured, args.format);
        }
        await sendProgress?.(`Starting/polling ${pomRoots.length} Maven context(s)`, 0, pomRoots.length);
        const projects = [];
        for (let i = 0; i < pomRoots.length; i++) {
            const result = await this.scanner.scanProject(pomRoots[i], Boolean(args.forceRefresh), async message => sendProgress?.(`[${path.basename(pomRoots[i])}] ${message}`, i, pomRoots.length));
            projects.push({ projectPath: pomRoots[i], ...result });
        }
        const complete = projects.every(project => project.status === 'complete');
        const structured = { workspacePath, status: complete ? 'complete' : 'in_progress', pomRoots, projects };
        const text = complete ? `Maven scan complete for ${pomRoots.length} top-level project(s).` : `Maven auto-scan is running for ${pomRoots.length} top-level project(s). Tools can be used immediately.`;
        return this.formatResponse(text, structured, args.format);
    }

    private async handleFindJar(args: any) {
        const selector = await this.selectorFromArgs(args);
        const result = await artifactService.findJars(selector, args.match ?? 'prefix', this.clamp(args.limit, 1, 100, 20));
        let text = result.results.length ? `Found ${result.results.length} JAR(s):\n${result.results.map(item => `- ${item.jarPath} (${item.origin})`).join('\n')}` : 'No matching JAR found.';
        if (!result.complete) text += '\n\nJAR search is partial.';
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.contextPath ?? error.jarPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleInspectJar(args: any) {
        const inspected = await artifactService.inspectJar(await this.selectorFromArgs(args));
        if (!inspected.index) return this.ambiguityResponse('JAR selector', inspected.candidates ?? [], args.format);
        const index = inspected.index;
        const query = String(args.query ?? '').toLowerCase();
        const offset = this.clamp(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
        const limit = this.clamp(args.limit, 1, 1000, 100);
        const classes = index.classes.filter(item => !item.isInner && (!query || item.className.toLowerCase().includes(query)));
        const resources = index.resources.filter(item => !query || item.path.toLowerCase().includes(query));
        const entries = [
            ...classes.map(item => ({ type: item.isSource ? 'source' : 'class', path: item.entryPath, className: item.className })),
            ...resources.map(item => ({ type: 'resource', path: item.path, size: item.size })),
        ].slice(offset - 1, offset - 1 + limit);
        const structured = { jarPath: index.jarPath, jarName: index.jarName, fingerprint: index.fingerprint, layout: index.layout, isMultiRelease: index.isMultiRelease, isSourceJar: index.isSourceJar, manifest: index.manifest, mavenCoordinates: index.mavenCoordinates, counts: { classes: classes.length, packages: index.packages.length, resources: resources.length, nestedJars: index.nestedJars.length }, packages: index.packages, nestedJars: index.nestedJars, entries, totalMatchingEntries: classes.length + resources.length };
        const text = `JAR: ${index.jarPath}\nLayout: ${index.layout}\nClasses: ${classes.length}\nPackages: ${index.packages.length}\nResources: ${resources.length}\nNested JARs: ${index.nestedJars.length}\n\n${entries.map(item => `- [${item.type}] ${item.path}`).join('\n')}`;
        return this.formatResponse(text, structured, args.format);
    }

    private async handleSearchClass(args: any, sendProgress?: Progress) {
        if (!args.query || typeof args.query !== 'string') throw new Error('query is required');
        const selector = await this.selectorFromArgs(args, true);
        await sendProgress?.(`Searching for class: ${args.query}`, 0, 100);
        const result = await artifactService.searchClasses(args.query, { ...selector, classpathWaitMs: args.mode === 'fast' ? 0 : 30_000, onWait: message => sendProgress?.(message, 10, 100) ?? Promise.resolve() }, this.clamp(args.limit, 1, 100, 20), args.mode === 'fast' ? 5 : 20);
        const jdkResults = args.includeJdk ? await jdkSourceService.searchClasses(args.query, this.clamp(args.limit, 1, 100, 20)) : [];
        const structured = { ...result, jdkResults, backgroundScanProgress: await this.aggregateScanProgress(selector.workspacePath) };
        const totalResults = result.results.length + jdkResults.length;
        let text = totalResults ? `Found ${totalResults} class candidate(s):\n${[
            ...result.results.map(item => `- ${item.className} -> ${item.jarPath}`),
            ...jdkResults.map(item => `- ${item.className} -> jdk:${item.module ?? 'unknown-module'}`),
        ].join('\n')}` : `No class found matching "${args.query}".`;
        if (!result.complete) text += `\n\nSearch is partial; ${result.remainingJarCount} candidate JAR(s) remain.`;
        if (result.errors.length) text += `\n\nScan errors:\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, structured, args.format);
    }

    private async handleSearchCode(args: any, sendProgress?: Progress) {
        if (!args.query || !args.kind) throw new Error('query and kind are required');
        const selector = await this.selectorFromArgs(args, true);
        await sendProgress?.(`Searching deep metadata for ${args.kind}: ${args.query}`, 0, 100);
        const result = await artifactService.searchCode(args.query, args.kind, selector, this.clamp(args.limit, 1, 100, 20), args.mode === 'fast' ? 3 : 10);
        let text = result.matches.length ? `Found ${result.matches.length} match(es):\n${result.matches.map(item => `- ${item.className}${item.member ? `#${item.member}` : ''} -> ${item.jarPath}`).join('\n')}` : `No ${args.kind} match found for "${args.query}".`;
        if (!result.complete) text += `\n\nSearch is partial; ${result.remainingJarCount} JAR(s) remain.`;
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleFindImplementations(args: any, sendProgress?: Progress) {
        this.validateClassName(args.className);
        const selector = await this.selectorFromArgs(args, true);
        await sendProgress?.(`Finding implementations of ${args.className}`, 0, 100);
        const result = await artifactService.findImplementations(args.className, selector, args.transitive !== false, this.clamp(args.limit, 1, 200, 50), args.mode === 'fast' ? 3 : 10);
        let text = result.implementations.length ? `Found ${result.implementations.length} implementation(s):\n${result.implementations.map(item => `- ${item.className} -> ${item.jarPath}`).join('\n')}` : `No implementations found for ${args.className}${result.complete ? '.' : ' in the currently deep-indexed JARs.'}`;
        if (!result.complete && result.remainingJarCount > 0) text += `\n\nSearch is partial; ${result.remainingJarCount} JAR(s) not deep-indexed yet. Call again to continue, or narrow with jarNamePrefix.`;
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleFindDuplicates(args: any, sendProgress?: Progress) {
        const selector = await this.selectorFromArgs(args, true);
        await sendProgress?.('Collecting classpath class index', 0, 100);
        const result = await artifactService.findDuplicateClasses(
            { ...selector, classpathWaitMs: args.mode === 'fast' ? 0 : 60_000, onWait: message => sendProgress?.(message, 10, 100) ?? Promise.resolve() },
            {
                query: args.query,
                limit: this.clamp(args.limit, 1, 200, 30),
                classLimit: this.clamp(args.classLimit, 1, 100, 10),
                maxNewJars: args.mode === 'fast' ? 50 : 500,
                deadlineMs: args.mode === 'fast' ? 5_000 : 25_000,
            },
        );
        const describeJar = (jar: { jarPath: string; groupId?: string; artifactId?: string; version?: string }) =>
            jar.artifactId ? `${jar.groupId ?? '?'}:${jar.artifactId}:${jar.version} (${jar.jarPath})` : jar.jarPath;
        let text = result.groups.length
            ? `Found ${result.totalDuplicateClasses} duplicate class(es) in ${result.totalGroups} JAR group(s)${result.groups.length < result.totalGroups ? ` (showing ${result.groups.length})` : ''}:\n\n` +
              result.groups.map((group, index) => [
                  `${index + 1}. ${group.kind === 'same-artifact-multiple-versions' ? 'Same artifact, multiple versions' : 'Different artifacts'} - ${group.classCount} class(es)`,
                  ...group.jars.map(jar => `   - ${describeJar(jar)}`),
                  `   Packages: ${group.packages.join(', ') || '(default)'}`,
                  `   Classes: ${group.sampleClasses.join(', ')}${group.classCount > group.sampleClasses.length ? ', ...' : ''}`,
              ].join('\n')).join('\n\n')
            : `No duplicate classes found${args.query ? ` matching "${args.query}"` : ''}${result.complete ? '.' : ' in the JARs indexed so far.'}`;
        if (!result.complete) text += `\n\nResult is partial${result.remainingJarCount ? `; ${result.remainingJarCount} JAR(s) not indexed yet` : ''}. Call again to continue.`;
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleInspectClass(args: any, sendProgress?: Progress) {
        this.validateClassName(args.className);
        const selector = await this.selectorFromArgs(args, true);
        const contextPath = selector.workspacePath || (selector.jarPath ? path.dirname(selector.jarPath) : process.cwd());
        const view = args.view ?? 'source';
        await sendProgress?.(`Resolving ${args.className}`, 0, 100);
        if (jdkSourceService.isLikelyJdkClass(args.className) && !selector.jarPath && !selector.jarNamePrefix && !selector.jarDirectory && !selector.coordinates) {
            const result = await this.inspectJdkClass(args.className, contextPath, view, args);
            return this.formatResponse(this.classInspectionText(args.className, result), result, args.format);
        }
        // Single-class lookups may wait for a cold-start Maven resolution instead of failing immediately;
        // otherwise agents give up and go hunting for JARs in ~/.m2 themselves.
        const resolved = await artifactService.resolveClass(args.className, {
            ...selector,
            classpathWaitMs: 90_000,
            onWait: message => sendProgress?.(message, 10, 100) ?? Promise.resolve(),
        });
        let requested = String(args.className);
        const isQualified = requested.includes('.');
        // Never fall back to fuzzy matches here: silently decompiling "FooBar" when "Foo" was asked is worse than an error.
        const exactMatches = (result: typeof resolved, name: string) => this.uniqueClassCandidates(result.results.filter(item => isQualified ? item.className === name : item.simpleName === name));
        let unique = exactMatches(resolved, requested);
        const binaryName = unique.length ? undefined : this.nestedBinaryName(requested);
        if (binaryName) {
            // Source-style nested name (java.util.Map.Entry style): retry as the binary name Outer$Inner.
            const retry = await artifactService.resolveClass(binaryName, { ...selector, classpathWaitMs: 90_000 });
            const retryUnique = exactMatches(retry, binaryName);
            if (retryUnique.length) { unique = retryUnique; requested = binaryName; }
        }
        if (!unique.length) {
            const suggestions = this.uniqueClassCandidates(resolved.results).slice(0, 10).map(item => `- ${item.className} -> ${item.jarPath}`);
            const partial = resolved.complete ? '' : (resolved.results.length === 0 && resolved.scannedJarCount === 0
                ? ' The Maven classpath is still being resolved (first run for this project); call again in a moment with the same arguments.'
                : ` ${resolved.remainingJarCount} dependency JAR(s) were not searched yet; call again with the same arguments.`);
            throw new Error(`Class not found: ${requested}.${partial}${suggestions.length ? `\nSimilar classes:\n${suggestions.join('\n')}` : ' Use search_class with a partial name.'}`);
        }
        if (unique.length > 1) return this.ambiguityResponse('Class', unique, args.format);
        let candidate = unique[0];
        let inspection = await artifactService.inspectJar({ jarPath: candidate.jarPath, workspacePath: selector.workspacePath });
        let classEntry = inspection.index!.classes.find(item => item.className === candidate.className && !item.isSource) ?? inspection.index!.classes.find(item => item.className === candidate.className);
        if (!classEntry) throw new Error(`Class entry not found after indexing: ${candidate.className}`);
        if (classEntry.isSource && view !== 'source') {
            const binaryJar = candidate.jarPath.replace(/-sources\.jar$/i, '.jar');
            if (!(await fs.pathExists(binaryJar))) throw new Error(`API/bytecode view requires a binary JAR; only source JAR is available: ${candidate.jarPath}`);
            candidate = { ...candidate, jarPath: binaryJar };
            inspection = await artifactService.inspectJar({ jarPath: binaryJar, workspacePath: selector.workspacePath });
            classEntry = inspection.index!.classes.find(item => item.className === candidate.className && !item.isSource)!;
            if (!classEntry) throw new Error(`Binary class not found for source: ${candidate.className}`);
        }
        const result: any = { className: candidate.className, jarPath: candidate.jarPath, entryPath: classEntry.entryPath, origin: candidate.origin, backgroundSearchComplete: resolved.complete };
        if (view === 'source' || view === 'all') {
            await sendProgress?.('Loading source/decompiling class', 35, 100);
            Object.assign(result, await this.loadClassSource(candidate, classEntry.entryPath, contextPath, args));
        }
        const normalEntryPath = `${candidate.className.replace(/\./g, '/')}.class`;
        const needsExtractedClass = classEntry.entryPath !== normalEntryPath;
        let inspectionClassFile: string | undefined;
        if (view === 'api' || view === 'all') {
            const bytes = await jarIndexer.readEntry(candidate.jarPath, classEntry.entryPath, 20 * 1024 * 1024);
            const classFileMetadata = ClassFileMetadataReader.read(bytes);
            if (needsExtractedClass) inspectionClassFile = await this.getInspectionClassFile(candidate, classEntry.entryPath, contextPath, bytes);
            const signatures = await this.analyzer.getSignatures(candidate.className, contextPath, inspectionClassFile ? { classFile: inspectionClassFile } : { jarPath: candidate.jarPath });
            result.api = {
                signatures: signatures.trim(),
                superClass: classFileMetadata.superClass,
                interfaces: classFileMetadata.interfaces,
                accessFlags: classFileMetadata.accessFlags,
                fields: classFileMetadata.fields,
                methods: classFileMetadata.methods,
            };
        }
        if (view === 'hierarchy' || view === 'all') result.hierarchy = await this.resolveHierarchy(candidate, selector, contextPath, classEntry.entryPath);
        if (view === 'bytecode' || view === 'all') {
            if (needsExtractedClass && !inspectionClassFile) inspectionClassFile = await this.getInspectionClassFile(candidate, classEntry.entryPath, contextPath);
            result.bytecode = inspectionClassFile
                ? await this.analyzer.getBytecodeFromClassFile(inspectionClassFile, contextPath)
                : await this.analyzer.getBytecode(candidate.className, contextPath, candidate.jarPath);
        }
        await sendProgress?.('Class inspection complete', 100, 100);
        return this.formatResponse(this.classInspectionText(candidate.className, result), result, args.format);
    }

    private async handleExplainDependency(args: any, sendProgress?: Progress) {
        const workspacePath = await this.validateWorkspacePath(args.workspacePath);
        let coordinates = args.coordinates as string | undefined;
        if (!coordinates && args.jarPath) {
            const inspected = await artifactService.inspectJar({ jarPath: args.jarPath, workspacePath });
            const coordinate = inspected.index?.mavenCoordinates[0];
            if (coordinate?.groupId && coordinate.artifactId) coordinates = `${coordinate.groupId}:${coordinate.artifactId}`;
        }
        if (!coordinates) throw new Error('coordinates or a JAR containing Maven pom.properties is required');
        const contexts = await projectDiscovery.findTopLevelPomDirectories(workspacePath);
        if (!contexts.length) throw new Error(`No pom.xml found under ${workspacePath}; explain_dependency needs a Maven project.`);
        const outputs: Array<{ projectPath: string; output?: string; error?: string }> = [];
        for (let i = 0; i < contexts.length; i++) {
            try { outputs.push({ projectPath: contexts[i], output: await this.scanner.explainDependency(contexts[i], coordinates) }); }
            catch (error) { outputs.push({ projectPath: contexts[i], error: error instanceof Error ? error.message : String(error) }); }
            await sendProgress?.(`Checked ${i + 1}/${contexts.length} Maven context(s)`, i + 1, contexts.length);
        }
        const text = outputs.map(item => `Project: ${item.projectPath}\n${item.output || `Error: ${item.error}`}`).join('\n\n');
        return this.formatResponse(text, { coordinates, outputs }, args.format);
    }

    private async handleSearchResources(args: any) {
        const result = await artifactService.searchResources(await this.selectorFromArgs(args, true), args.pathQuery ?? '', args.contentQuery, this.clamp(args.limit, 1, 100, 20));
        let text = result.results.length ? `Found ${result.results.length} resource(s):\n${result.results.map(item => `- ${item.resourcePath} -> ${item.jarPath}${item.contentMatch ? `\n    ...${item.contentMatch.replace(/\s+/g, ' ').trim()}...` : ''}`).join('\n')}` : 'No matching resources found.';
        if (!result.complete) text += '\n\nResource search is partial.';
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleReadResource(args: any) {
        if (!args.resourcePath) throw new Error('resourcePath is required');
        const result = await artifactService.readResource(await this.selectorFromArgs(args), args.resourcePath, args.offset, args.limit);
        return this.formatResponse(`Resource ${result.resourcePath} (${result.startLine}-${result.endLine}/${result.totalLines}):\n\n${result.text}`, result, args.format);
    }

    private async loadClassSource(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any): Promise<SourceSlice> {
        const dollar = candidate.className.indexOf('$', candidate.className.lastIndexOf('.') + 1);
        if (dollar < 0) {
            const raw = await this.loadRawSource(candidate, entryPath, contextPath, args);
            return { ...this.sliceSource(raw.source, args), sourceOrigin: raw.sourceOrigin };
        }
        // Nested class: sources and Vineflower output live in the top-level class; cut out the nested declaration.
        const outerClassName = candidate.className.substring(0, dollar);
        const outerEntryPath = entryPath.replace(/\$[^/]*(\.class|\.java)$/i, '$1');
        const raw = await this.loadRawSource({ ...candidate, className: outerClassName }, outerEntryPath, contextPath, args);
        const names = candidate.className.substring(dollar + 1).split('$');
        const nested = extractTypeDeclaration(raw.source, names);
        if (nested) return { ...this.sliceSource(nested, args), sourceOrigin: raw.sourceOrigin, enclosingClass: outerClassName };
        return {
            ...this.sliceSource(raw.source, args),
            sourceOrigin: raw.sourceOrigin,
            enclosingClass: outerClassName,
            sourceNote: `${candidate.className} is an anonymous/local or synthetic class; showing the source of ${outerClassName}. Use view=bytecode for its exact code.`,
        };
    }

    private async loadRawSource(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any): Promise<{ source: string; sourceOrigin: NonNullable<SourceSlice['sourceOrigin']> }> {
        const sameJarIndex = await jarIndexer.getLightIndex(candidate.jarPath, contextPath);
        const embeddedSource = sameJarIndex.classes.find(item => item.className === candidate.className && item.isSource);
        if (embeddedSource) {
            return { source: (await jarIndexer.readEntry(candidate.jarPath, embeddedSource.entryPath, 10 * 1024 * 1024)).toString('utf8'), sourceOrigin: 'embedded-source' };
        }
        const sourceJar = candidate.jarPath.replace(/\.jar$/i, '-sources.jar');
        if (sourceJar !== candidate.jarPath && await fs.pathExists(sourceJar)) {
            const sourceIndex = await jarIndexer.getLightIndex(sourceJar, contextPath);
            const sourceEntry = sourceIndex.classes.find(item => item.className === candidate.className && item.isSource);
            if (sourceEntry) return { source: (await jarIndexer.readEntry(sourceJar, sourceEntry.entryPath, 10 * 1024 * 1024)).toString('utf8'), sourceOrigin: 'sources-jar' };
        }
        const source = await this.decompiler.decompileClassFromJar(candidate.className, candidate.jarPath, contextPath, entryPath, args.useCache !== false);
        return { source, sourceOrigin: 'decompiled' };
    }

    private sliceSource(source: string, args: any): SourceSlice {
        if (args.methodName) {
            const extracted = extractMethod(source, args.methodName, args.paramTypes);
            if (!extracted) throw new Error(`Method not found: ${args.methodName}${args.paramTypes ? `(${args.paramTypes.join(', ')})` : ''}. Use view=api to list the declared methods.`);
            return { source: extracted };
        }
        const lines = source.split('\n');
        const totalLines = lines.length;
        const offset = this.clamp(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
        const requestedLimit = Number(args.limit ?? 0);
        if (offset === 1 && !(requestedLimit > 0)) return { source };
        if (offset > totalLines) throw new Error(`offset ${offset} is past the end of the source (${totalLines} lines).`);
        const end = requestedLimit > 0 ? Math.min(totalLines, offset - 1 + requestedLimit) : totalLines;
        return { source: lines.slice(offset - 1, end).join('\n'), sourceRange: { startLine: offset, endLine: end, totalLines } };
    }

    private async inspectJdkClass(className: string, contextPath: string, view: string, args: any): Promise<any> {
        const result: any = { className, origin: 'jdk' };
        if (view === 'source' || view === 'all') {
            const dollar = className.indexOf('$');
            const outerName = dollar > 0 ? className.substring(0, dollar) : className;
            const outerSource = await jdkSourceService.getSource(outerName);
            const nested = outerSource && dollar > 0 ? extractTypeDeclaration(outerSource, className.substring(dollar + 1).split('$')) : null;
            const source = nested ?? outerSource;
            if (source) Object.assign(result, this.sliceSource(source, args), { sourceOrigin: 'jdk-src.zip' }, dollar > 0 ? { enclosingClass: outerName } : {}); else result.sourceUnavailable = true;
        }
        if (view === 'api' || view === 'all') result.api = { signatures: (await this.analyzer.getSignatures(className, contextPath)).trim() };
        if (view === 'hierarchy' || view === 'all') result.hierarchy = await this.resolveJdkHierarchy(className, contextPath);
        if (view === 'bytecode' || view === 'all') result.bytecode = await this.analyzer.getBytecode(className, contextPath);
        return result;
    }

    private async resolveJdkHierarchy(className: string, contextPath: string): Promise<HierarchyEntry[]> {
        const hierarchy: HierarchyEntry[] = [];
        const visited = new Set<string>();
        let current: string | undefined = className;
        while (current && hierarchy.length < 20 && !visited.has(current)) {
            visited.add(current);
            hierarchy.push({ className: current, level: hierarchy.length, resolved: true });
            try {
                const analysis = await this.analyzer.analyzeJdkClass(current, contextPath);
                hierarchy[hierarchy.length - 1].interfaces = analysis.interfaces;
                current = analysis.superClass;
            }
            catch { hierarchy[hierarchy.length - 1].resolved = false; break; }
        }
        return hierarchy.reverse().map((entry, level) => ({ ...entry, level }));
    }

    private async resolveHierarchy(candidate: ClassCandidate, selector: ArtifactSelector, contextPath: string, firstEntryPath?: string): Promise<HierarchyEntry[]> {
        const chain: HierarchyEntry[] = [];
        const visited = new Set<string>();
        let current: string | undefined = candidate.className;
        let currentJar: string | undefined = candidate.jarPath;
        let entryPath: string | undefined = firstEntryPath;
        while (current && chain.length < 20 && !visited.has(current)) {
            visited.add(current);
            try {
                let analysis: ClassAnalysis;
                if (jdkSourceService.isLikelyJdkClass(current)) analysis = await this.analyzer.analyzeJdkClass(current, contextPath);
                else if (currentJar && entryPath) {
                    const metadata = ClassFileMetadataReader.read(await jarIndexer.readEntry(currentJar, entryPath, 20 * 1024 * 1024));
                    analysis = { className: current, packageName: current.includes('.') ? current.substring(0, current.lastIndexOf('.')) : '', modifiers: [], superClass: metadata.superClass, interfaces: metadata.interfaces, fields: [], methods: [] };
                } else if (currentJar) analysis = await this.analyzer.analyzeClassFromJar(current, currentJar, contextPath, false);
                else throw new Error('unresolved');
                chain.push({ className: current, level: chain.length, resolved: true, interfaces: analysis.interfaces });
                const analyzedJar = currentJar;
                current = analysis.superClass;
                entryPath = undefined;
                if (current && !jdkSourceService.isLikelyJdkClass(current)) {
                    currentJar = undefined;
                    if (analyzedJar) {
                        const sameJarEntry = (await jarIndexer.getLightIndex(analyzedJar, contextPath)).classes
                            .find(item => item.className === current && !item.isSource);
                        if (sameJarEntry) {
                            currentJar = analyzedJar;
                            entryPath = sameJarEntry.entryPath;
                        }
                    }
                    if (!currentJar) {
                        const next = (await artifactService.resolveClass(current, selector)).results.find(item => item.className === current);
                        currentJar = next?.jarPath;
                        if (next) entryPath = (await jarIndexer.getLightIndex(next.jarPath, contextPath)).classes.find(item => item.className === current && !item.isSource)?.entryPath;
                    }
                } else if (current) {
                    currentJar = undefined;
                }
            } catch { chain.push({ className: current!, level: chain.length, resolved: false }); break; }
        }
        return chain.reverse().map((entry, level) => ({ ...entry, level }));
    }

    private async getInspectionClassFile(candidate: ClassCandidate, entryPath: string, contextPath: string, existingBytes?: Buffer): Promise<string> {
        const fingerprint = await jarIndexer.fingerprint(candidate.jarPath);
        const simpleName = candidate.className.substring(candidate.className.lastIndexOf('.') + 1);
        const classKey = createHash('sha256').update(`${candidate.className}\n${entryPath}`).digest('hex').substring(0, 12);
        const target = path.join(getResultCacheDir(contextPath), fingerprint.key, 'class-files', `${simpleName}-${classKey}.class`);
        if (!(await fs.pathExists(target))) {
            const bytes = existingBytes ?? await jarIndexer.readEntry(candidate.jarPath, entryPath, 20 * 1024 * 1024);
            await fs.outputFile(target, bytes);
        }
        return target;
    }

    private classInspectionText(className: string, result: any): string {
        let text = `Class inspection: ${className}\nOrigin: ${result.origin}${result.jarPath ? `\nJAR: ${result.jarPath}` : ''}`;
        if (result.sourceOrigin) text += `\nSource origin: ${result.sourceOrigin === 'decompiled' ? 'decompiled with Vineflower (not original source; comments and local names may differ)' : result.sourceOrigin}`;
        if (result.enclosingClass) text += `\nEnclosing class: ${result.enclosingClass}`;
        if (result.sourceNote) text += `\nNote: ${result.sourceNote}`;
        if (result.sourceRange) text += `\nLines: ${result.sourceRange.startLine}-${result.sourceRange.endLine} of ${result.sourceRange.totalLines}${result.sourceRange.endLine < result.sourceRange.totalLines ? ` (call again with offset=${result.sourceRange.endLine + 1} for more)` : ''}`;
        if (result.sourceUnavailable) text += '\n\nSource: unavailable (JDK src.zip not found; use view=api or view=bytecode).';
        if (result.source) text += `\n\nSource:\n\n\`\`\`java\n${result.source}\n\`\`\``;
        if (result.api) text += `\n\nAPI (javap -p):\n\n\`\`\`text\n${result.api.signatures}\n\`\`\``;
        if (result.hierarchy) text += `\n\nHierarchy (root first):\n${result.hierarchy.map((item: HierarchyEntry) => `${'  '.repeat(item.level)}${item.className}${item.resolved ? '' : ' (unresolved)'}${item.interfaces?.length ? ` implements ${item.interfaces.join(', ')}` : ''}`).join('\n')}`;
        if (result.bytecode) text += `\n\nBytecode:\n\n\`\`\`text\n${result.bytecode}\n\`\`\``;
        return text;
    }

    /** "com.acme.Outer.Inner" -> "com.acme.Outer$Inner" (first capitalised segment that is not the last starts the nesting). */
    private nestedBinaryName(className: string): string | undefined {
        if (className.includes('$')) return undefined;
        const segments = className.split('.');
        const outer = segments.findIndex((segment, index) => index < segments.length - 1 && /^[A-Z]/.test(segment));
        if (outer < 0) return undefined;
        return `${segments.slice(0, outer + 1).join('.')}$${segments.slice(outer + 1).join('$')}`;
    }

    private uniqueClassCandidates(candidates: ClassCandidate[]): ClassCandidate[] {
        const map = new Map<string, ClassCandidate>();
        for (const candidate of candidates) map.set(`${candidate.className}::${path.resolve(candidate.jarPath)}`, candidate);
        return [...map.values()];
    }

    private async aggregateScanProgress(workspacePath?: string): Promise<{ processed: number; total: number; percent: number } | undefined> {
        if (!workspacePath) return undefined;
        let processed = 0, total = 0;
        for (const context of await projectDiscovery.findTopLevelPomDirectories(workspacePath)) {
            const progress = await this.scanner.getScanProgress(context);
            processed += progress?.processed ?? 0;
            total += progress?.total ?? 0;
        }
        return { processed, total, percent: total ? Math.floor(processed / total * 100) : 0 };
    }

    private async selectorFromArgs(args: any, allowEmpty: boolean = false): Promise<ArtifactSelector> {
        const selector: ArtifactSelector = { workspacePath: args.workspacePath, jarPath: args.jarPath, jarDirectory: args.jarDirectory, jarNamePrefix: args.jarNamePrefix, coordinates: args.coordinates };
        if (!selector.workspacePath && !selector.jarPath && !selector.jarDirectory && !selector.coordinates) {
            selector.workspacePath = process.cwd();
        }
        if (selector.workspacePath) selector.workspacePath = await this.validateWorkspacePath(selector.workspacePath);
        if (selector.jarDirectory) selector.jarDirectory = await this.validateDirectory(selector.jarDirectory, 'jarDirectory');
        if (selector.jarPath) {
            if (!path.isAbsolute(selector.jarPath)) throw new Error('jarPath must be absolute');
            selector.jarPath = path.resolve(selector.jarPath);
        }
        if (!allowEmpty && !selector.workspacePath && !selector.jarPath && !selector.jarDirectory && !selector.coordinates) throw new Error('Provide workspacePath, jarPath, jarDirectory, or coordinates');
        return selector;
    }

    private ambiguityResponse(label: string, candidates: any[], format: Format = 'text') {
        const structured = { ambiguous: true, candidates };
        const text = `${label} is ambiguous. Provide an exact path/name:\n${candidates.map(candidate => `- ${candidate.jarPath ?? candidate.className}`).join('\n')}`;
        return this.formatResponse(text, structured, format);
    }

    private formatResponse(text: string, structured: object, format: Format = 'text'): { content: Array<{ type: 'text'; text: string }> } {
        const wrap = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
        if (format === 'json') return wrap(JSON.stringify(structured, null, 2));
        if (format === 'toon') { try { return wrap(toonEncode(structured)); } catch { return wrap(text); } }
        return wrap(text);
    }

    private clamp(value: unknown, min: number, max: number, fallback: number): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
    }

    private validateClassName(className: string): void {
        if (!className || typeof className !== 'string') throw new Error('className is required and must be a string');
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(className)) throw new Error('className must be a valid Java class name');
    }

    private async validateWorkspacePath(workspacePath: string): Promise<string> { return this.validateDirectory(workspacePath, 'workspacePath'); }
    private async validateDirectory(value: string, label: string): Promise<string> {
        if (!value || typeof value !== 'string') throw new Error(`${label} is required and must be a string`);
        if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
        const resolved = path.resolve(value);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat) throw new Error(`${label} does not exist: ${resolved}`);
        if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
        return resolved;
    }

    private async tryAutoScan(): Promise<void> {
        const workspacePath = process.cwd();
        const logger = Logger.get(workspacePath);
        try {
            const pomRoots = await projectDiscovery.findTopLevelPomDirectories(workspacePath);
            if (!pomRoots.length) { logger.info('[AUTO-SCAN] No Maven project found. Waiting for direct/local JAR calls.'); return; }
            logger.info(`[AUTO-SCAN] Found ${pomRoots.length} top-level Maven project(s): ${pomRoots.join(', ')}`);
            for (const pomRoot of pomRoots) {
                this.scanner.scanProject(pomRoot, false, async message => logger.info(`[AUTO-SCAN:${path.basename(pomRoot)}] ${message}`))
                    .catch(error => logger.error(`[AUTO-SCAN] ${pomRoot}: ${error instanceof Error ? error.message : String(error)}`));
            }
        } catch (error) { logger.error(`[AUTO-SCAN] Discovery failed: ${error instanceof Error ? error.message : String(error)}`); }
    }

    async run(): Promise<void> {
        await this.mcp.connect(new StdioServerTransport());
        Logger.get(process.cwd()).info(`[SERVER] java-inspector v${version} running; cwd=${process.cwd()}, node=${process.version}, pid=${process.pid}`);
        void this.tryAutoScan();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const mcpServer = new JavaClassAnalyzerMCPServer();
    process.on('uncaughtException', error => console.error('Uncaught exception:', error));
    process.on('unhandledRejection', reason => console.error('Unhandled Promise rejection:', reason));
    mcpServer.run().catch(error => { console.error('Server startup failed:', error); process.exit(1); });
}
