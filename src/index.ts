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
import { diffApi } from './analyzer/ApiDiff.js';
import { DependencyNode, DependencyScanner, ModuleDependencies } from './scanner/DependencyScanner.js';
import { DecompilerService } from './decompiler/DecompilerService.js';
import { artifactService, ArtifactSelector, ClassCandidate } from './scanner/ArtifactService.js';
import { DeepClassEntry, jarIndexer } from './scanner/JarIndexer.js';
import { buildToolOf, projectDiscovery } from './scanner/ProjectDiscovery.js';
import { ClassFileMetadataReader } from './scanner/ClassFileMetadataReader.js';
import { getResultCacheDir } from './utils/cachePaths.js';
import { extractMethod, extractTypeDeclaration } from './utils/methodExtractor.js';
import { buildOutline, cleanDecompilerFailures, extractMembers, formatOutline, JavapMember, javapMemberAtLine, memberAtLine, memberRangeWithDoc, OutlineMember, parseJavapMembers, selectJavapMembers } from './utils/javaOutline.js';
import { Logger } from './utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
type Format = 'text' | 'json' | 'toon';
type SourceSlice = { source: string; sourceRange?: { startLine: number; endLine: number; totalLines: number }; sourceOrigin?: 'embedded-source' | 'sources-jar' | 'decompiled' | 'jdk-src.zip'; enclosingClass?: string; sourceNote?: string; outline?: string; lineInfo?: string; declaredIn?: string };
type FullSource = { source: string; sourceOrigin: NonNullable<SourceSlice['sourceOrigin']>; enclosingClass?: string; sourceNote?: string; rawSource: string };

/** Source files longer than this are not returned whole by default: outline + first lines instead. */
const SOURCE_AUTO_LIMIT = 400;
const SOURCE_AUTO_PREVIEW = 120;
/** javap -c output longer than this is replaced by the member list unless methodName/line is given. */
const BYTECODE_AUTO_LIMIT = 400;
/** Hard cap for any single tool response (~10k tokens). */
const MAX_RESPONSE_CHARS = 40_000;

class MemberNotFoundError extends Error {
    constructor(readonly memberName: string, readonly outline: OutlineMember[], paramTypes?: string[]) {
        const lower = memberName.toLowerCase();
        const similar = [...new Set(outline.filter(member => (member.kind === 'method' || member.kind === 'constructor') && member.name.toLowerCase().includes(lower.substring(0, Math.max(3, lower.length - 2)))).map(member => member.signature))].slice(0, 15);
        super(`Method not found: ${memberName}${paramTypes?.length ? `(${paramTypes.join(', ')})` : ''}.${similar.length ? `\nSimilar members:\n${similar.map(item => `- ${item}`).join('\n')}` : ' Use view=outline to list the members.'}`);
    }
}
type Progress = (message: string, progress?: number, total?: number) => Promise<void>;

/**
 * Sent to the client in the initialize response. Clients such as Claude Code and
 * Cursor inject this into the model's context, which is what makes the agent pick
 * these tools over shelling out to javap / unzip / jar / find ~/.m2.
 */
export const SERVER_INSTRUCTIONS = `java-inspector gives read-only access to compiled Java code: Maven/Gradle dependencies of the workspace, local JAR/WAR/Spring Boot fat JARs, and JDK classes.

Prefer these tools over shell commands for anything inside a JAR or the JDK:
- Instead of \`javap\` / \`javap -c\` / \`javap -p\`: inspect_class with view "api" (signatures) or "bytecode".
- Instead of decompiling by hand or guessing library behaviour: inspect_class with view "source" (uses -sources.jar when present, otherwise Vineflower). Large class: view "outline" first, then methodName for one method (inherited methods are found too). Stack-trace frame "Foo.java:123": pass line=123. Nested classes: Outer$Inner.
- For classes from the project's dependencies, pass only className (fully qualified). Do NOT look up the JAR in ~/.m2 / ~/.gradle or pass jarPath first: the server knows the project classpath and finds the JAR itself, waiting for Maven/Gradle if the project is opened for the first time.
- Instead of \`unzip -l\`, \`jar tf\`, \`find ~/.m2 -name\`, \`grep -r\` over JARs: search_class, find_jar, inspect_jar, search_resources, read_resource.
- Before upgrading a library, or for NoSuchMethodError/AbstractMethodError: compare_versions (API diff between two versions).
- Instead of \`mvn dependency:tree\` or reading pom.xml: list_dependencies (real versions, scope, direct/transitive); explain_dependency for why one artifact is there. For version conflicts / the same class in several JARs (NoSuchMethodError, ClassCastException): find_duplicates.
- To find who implements an interface or calls/declares a member or uses a string: find_implementations / search_code.

Workflow: inspect_class with the fully qualified name; if you only know the simple name, search_class first. No scan is required first: the classpath is resolved in the background at startup and tools return partial results with complete=false instead of waiting. When a result is ambiguous, the response lists candidates; repeat the call with jarPath set to one of them. All paths must be absolute.`;

const FORMAT = z.enum(['text', 'json', 'toon']).default('text').describe('"text": compact; "json": full structured result; "toon": compact structured.');
const MODE = z.enum(['fast', 'balanced']).default('balanced').describe('"fast" opens fewer unindexed JARs per call (quicker, more often partial).');
const num = (description: string) => z.coerce.number().int().optional().describe(description);
/** Shared by many tools, so kept short: every word here is repeated in tools/list once per tool. */
const SELECTOR = {
    workspacePath: z.string().optional().describe('Absolute project directory (pom.xml or Gradle build, or a parent of several). Default: server cwd.'),
    jarPath: z.string().optional().describe('Absolute path of one JAR. Not needed for project dependencies; use it for other JARs or to pick a listed candidate.'),
    jarDirectory: z.string().optional().describe('Absolute directory of JARs to search (projects without Maven/Gradle, e.g. lib/).'),
    jarNamePrefix: z.string().optional().describe('Only JARs whose file name starts with this, e.g. "jackson-databind".'),
    coordinates: z.string().optional().describe('groupId:artifactId[:version[:classifier]] from the local Maven repository.'),
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export class JavaClassAnalyzerMCPServer {
    private mcp: McpServer;
    private analyzer = new JavaClassAnalyzer();
    private scanner = new DependencyScanner();
    private sourceDownloads = new Map<string, Promise<{ ok: boolean; message?: string }>>();
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

        register('scan_project', 'Scan dependencies',
            'Start, refresh, or poll the background index of a workspace\'s dependency JARs (Maven or Gradle). Returns immediately. ' +
            'Usually NOT needed: the server auto-scans the top-level Maven/Gradle builds under its cwd at startup and every other tool works on a partial index. ' +
            'Call it to index a different workspace, to check progress, or with forceRefresh=true after build files change.',
            { workspacePath: z.string().describe('Absolute project directory (pom.xml or Gradle build, or a parent of several).'), forceRefresh: z.boolean().default(false).describe('Drop the cached classpath/index and resolve it again.'), format: FORMAT },
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
            'Find classes by simple name, fully qualified name, or partial name (e.g. "ObjectMapper", "jackson ObjectMapper", "web.client.RestTemplate") across the workspace\'s dependencies, a JAR directory, or one JAR. ' +
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
            'List classes that exist in more than one JAR of the classpath: the same artifact in two versions, split packages, or shaded/relocated copies (typical causes of NoSuchMethodError, ClassCastException, "works in IDE, fails in prod"). ' +
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
            'Read a Java class from a project dependency, local JAR, or the JDK. Use instead of javap, unzip or a decompiler in the shell. ' +
            'view="source": real source from a -sources.jar if present, otherwise decompiled with Vineflower; files over 400 lines return the first lines plus an outline. view="outline": members with line ranges (cheapest way to see a large class). ' +
            'view="api": compact member signatures (replaces `javap -p`). view="bytecode": `javap -c` (per method with methodName). view="hierarchy": superclass chain and interfaces. view="all": everything. ' +
            'Efficient pattern: outline (or api) first, then methodName for the code you need. For a stack trace, pass line. For project dependencies pass ONLY className: the JAR comes from the classpath (do not locate it in ~/.m2). Use search_class first if you only know part of the name.',
            {
                className: z.string().describe('Fully qualified class name, e.g. "com.fasterxml.jackson.databind.ObjectMapper". Nested classes: "com.acme.Outer$Inner" (or "com.acme.Outer.Inner"); view=source then returns just the nested declaration.'),
                ...SELECTOR,
                view: z.enum(['source', 'outline', 'api', 'hierarchy', 'bytecode', 'all']).default('source').describe('Which view to return.'),
                methodName: z.string().optional().describe('source/bytecode: return just this method or constructor (all overloads unless paramTypes is given). If the class does not declare it, superclasses and interfaces are searched.'),
                paramTypes: z.array(z.string()).optional().describe('Simple or qualified parameter type names to select one overload, e.g. ["String", "int"].'),
                line: num('Source line from a stack trace, e.g. 123 from "at com.acme.Foo.bar(Foo.java:123)": returns the method containing it (also for decompiled code, via the line table).'),
                offset: num('view=source: 1-based first line to return (default 1).'),
                limit: num(`view=source: number of lines to return. Default: whole file up to ${SOURCE_AUTO_LIMIT} lines; larger files return the first ${SOURCE_AUTO_PREVIEW} lines plus an outline.`),
                useCache: z.boolean().default(true).describe('Reuse cached decompiled source.'),
                downloadSources: z.boolean().optional().describe('Maven: download a missing -sources.jar (`mvn dependency:get`, network) instead of decompiling. Default: env JAVA_INSPECTOR_DOWNLOAD_SOURCES.'),
                format: FORMAT,
            },
            (args, progress) => this.handleInspectClass(args, progress));

        register('explain_dependency', 'Explain dependency',
            'Explain why an artifact is on the classpath: runs a filtered `mvn dependency:tree -Dincludes=<coordinates> -Dverbose` for each Maven project in the workspace (paths from root to the artifact, conflicts, omitted versions). ' +
            'Use instead of running mvn dependency:tree yourself. Slower (runs Maven).',
            { workspacePath: z.string().optional().describe('Absolute workspace path containing pom.xml. Defaults to the server cwd.'), coordinates: z.string().optional().describe('groupId:artifactId (or groupId only). Optional if jarPath is given.'), jarPath: z.string().optional().describe('Absolute JAR path; coordinates are read from its pom.properties.'), format: FORMAT },
            (args, progress) => this.handleExplainDependency(args, progress));

        register('compare_versions', 'Compare API between versions',
            'Binary API diff of a library between two versions (or any two JARs): added/removed classes, and per class the public/protected methods and fields that were added, removed or changed (visibility, static, final, abstract, supertypes), with breaking changes flagged. ' +
            'Use before upgrading a dependency, or to explain NoSuchMethodError/AbstractMethodError, instead of decompiling both versions and comparing by hand. ' +
            'Give coordinates + toVersion (fromVersion defaults to the version on the project classpath), or fromJarPath + toJarPath. Then inspect_class with jarPath shows the code of a changed member.',
            {
                coordinates: z.string().optional().describe('groupId:artifactId, e.g. "com.fasterxml.jackson.core:jackson-databind".'),
                fromVersion: z.string().optional().describe('Old version. Default: the version on the workspace classpath.'),
                toVersion: z.string().optional().describe('New version (required with coordinates).'),
                fromJarPath: z.string().optional().describe('Absolute path of the old JAR (instead of coordinates/fromVersion).'),
                toJarPath: z.string().optional().describe('Absolute path of the new JAR (instead of coordinates/toVersion).'),
                className: z.string().optional().describe('Compare only this class (fully qualified; its nested classes are included).'),
                packagePrefix: z.string().optional().describe('Compare only classes in this package and its subpackages, e.g. "org.apache.commons.lang3.time".'),
                download: z.boolean().default(false).describe('Download a version missing from ~/.m2 with `mvn dependency:get` (network).'),
                workspacePath: z.string().optional().describe('Absolute workspace path used to find the classpath version. Defaults to the server cwd.'),
                limit: num('Max changed classes listed in the text output (1-500, default 40).'),
                format: FORMAT,
            },
            (args, progress) => this.handleCompareVersions(args, progress));

        register('list_dependencies', 'List Maven dependencies',
            'Resolved dependencies of every Maven module in the workspace with groupId:artifactId:version, scope, and whether each is direct (declared in the pom) or transitive (with the path that pulls it in). ' +
            'Use instead of running `mvn dependency:tree` or reading pom.xml files to find out which version of a library the project really uses. Runs Maven once, then cached until pom.xml changes.',
            {
                workspacePath: z.string().optional().describe('Absolute workspace path containing pom.xml. Defaults to the server cwd.'),
                query: z.string().optional().describe('Only dependencies whose groupId:artifactId contains this (case-insensitive), e.g. "jackson" or "org.slf4j"; each match is shown with its path from the module.'),
                directOnly: z.boolean().default(false).describe('Only dependencies declared directly in the module poms.'),
                scope: z.string().optional().describe('Only this scope: compile, runtime, test, provided, system or import.'),
                limit: num('Max dependency lines in the text output (1-2000, default 300).'),
                format: FORMAT,
            },
            (args, progress) => this.handleListDependencies(args, progress));

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
        const text = complete ? `Scan complete for ${pomRoots.length} top-level project(s).` : `Auto-scan is running for ${pomRoots.length} top-level project(s). Tools can be used immediately.`;
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
            this.groupByJar(result.results, item => item.className),
            ...jdkResults.map(item => `jdk:${item.module ?? 'unknown-module'}\n  - ${item.className}`),
        ].filter(Boolean).join('\n')}` : `No class found matching "${args.query}".`;
        if (!result.complete) text += `\n\nSearch is partial; ${result.remainingJarCount} candidate JAR(s) remain.`;
        if (result.errors.length) text += `\n\nScan errors:\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, structured, args.format);
    }

    private async handleSearchCode(args: any, sendProgress?: Progress) {
        if (!args.query || !args.kind) throw new Error('query and kind are required');
        const selector = await this.selectorFromArgs(args, true);
        await sendProgress?.(`Searching deep metadata for ${args.kind}: ${args.query}`, 0, 100);
        const result = await artifactService.searchCode(args.query, args.kind, selector, this.clamp(args.limit, 1, 100, 20), args.mode === 'fast' ? 3 : 10);
        let text = result.matches.length ? `Found ${result.matches.length} match(es):\n${this.groupByJar(result.matches, item => `${item.className}${item.member ? `#${item.member}${item.descriptor ? ` ${item.descriptor}` : ''}` : ''}${item.owner ? ` -> ${item.owner}` : ''}${item.value !== undefined ? ` "${item.value.length > 120 ? `${item.value.substring(0, 117)}...` : item.value}"` : ''}`)}` : `No ${args.kind} match found for "${args.query}".`;
        if (!result.complete) text += `\n\nSearch is partial; ${result.remainingJarCount} JAR(s) remain.`;
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleFindImplementations(args: any, sendProgress?: Progress) {
        this.validateClassName(args.className);
        const selector = await this.selectorFromArgs(args, true);
        await sendProgress?.(`Finding implementations of ${args.className}`, 0, 100);
        const result = await artifactService.findImplementations(args.className, selector, args.transitive !== false, this.clamp(args.limit, 1, 200, 50), args.mode === 'fast' ? 3 : 10);
        let text = result.implementations.length ? `Found ${result.implementations.length} implementation(s):\n${this.groupByJar(result.implementations, item => item.className)}` : `No implementations found for ${args.className}${result.complete ? '.' : ' in the currently deep-indexed JARs.'}`;
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
        const entryPath = classEntry.entryPath;
        const needsExtractedClass = entryPath !== `${candidate.className.replace(/\./g, '/')}.class`;
        let inspectionClassFile: string | undefined;
        const classFile = async (bytes?: Buffer) => {
            if (needsExtractedClass && !inspectionClassFile) inspectionClassFile = await this.getInspectionClassFile(candidate, entryPath, contextPath, bytes);
            return inspectionClassFile;
        };
        let bytecodeOutput: Promise<string> | undefined;
        const bytecode = () => bytecodeOutput ??= classFile().then(file => file
            ? this.analyzer.getBytecodeFromClassFile(file, contextPath)
            : this.analyzer.getBytecode(candidate.className, contextPath, candidate.jarPath));
        const javapMembers = async () => parseJavapMembers(await bytecode(), candidate.className).members;
        if (view === 'source' || view === 'all' || view === 'outline') {
            await sendProgress?.('Loading source/decompiling class', 35, 100);
            if (view === 'outline') Object.assign(result, await this.loadClassOutline(candidate, entryPath, contextPath, args));
            else Object.assign(result, await this.loadClassSource(candidate, entryPath, contextPath, args, selector, classEntry.isSource ? undefined : javapMembers));
        }
        if (view === 'api' || view === 'all') {
            const bytes = await jarIndexer.readEntry(candidate.jarPath, entryPath, 20 * 1024 * 1024);
            const classFileMetadata = ClassFileMetadataReader.read(bytes);
            const file = await classFile(bytes);
            const signatures = await this.analyzer.getSignatures(candidate.className, contextPath, file ? { classFile: file } : { jarPath: candidate.jarPath });
            result.api = {
                signatures: signatures.trim(),
                superClass: classFileMetadata.superClass,
                interfaces: classFileMetadata.interfaces,
                accessFlags: classFileMetadata.accessFlags,
            };
        }
        if (view === 'hierarchy' || view === 'all') result.hierarchy = await this.resolveHierarchy(candidate, selector, contextPath, entryPath);
        if (view === 'bytecode' || view === 'all') Object.assign(result, this.bytecodeView(await bytecode(), candidate.className, args));
        await sendProgress?.('Class inspection complete', 100, 100);
        return this.formatResponse(this.classInspectionText(candidate.className, result), result, args.format);
    }

    private async handleCompareVersions(args: any, sendProgress?: Progress) {
        const workspacePath = args.workspacePath ? await this.validateWorkspacePath(args.workspacePath) : process.cwd();
        const [groupId, artifactId] = typeof args.coordinates === 'string' ? args.coordinates.split(':') : [];
        if (args.coordinates && (!groupId || !artifactId)) throw new Error('coordinates must be groupId:artifactId');
        const notes: string[] = [];
        const resolveJar = async (label: 'from' | 'to', jarPath?: string, version?: string): Promise<{ jarPath: string; version?: string }> => {
            if (jarPath) {
                if (!path.isAbsolute(jarPath) || !(await fs.pathExists(jarPath))) throw new Error(`${label}JarPath does not exist or is not absolute: ${jarPath}`);
                return { jarPath: path.resolve(jarPath), version: artifactService.coordinatesFromJarPath(jarPath).version };
            }
            if (!groupId) throw new Error(`Give coordinates (groupId:artifactId) or ${label}JarPath.`);
            if (!version && label === 'from') {
                const found = await artifactService.findJars({ workspacePath, jarNamePrefix: `${artifactId}-`, classpathWaitMs: 60_000 }, 'prefix', 50);
                const match = found.results.find(item => { const c = artifactService.coordinatesFromJarPath(item.jarPath); return c.groupId === groupId && c.artifactId === artifactId; });
                if (!match) throw new Error(`${groupId}:${artifactId} is not on the classpath of ${workspacePath}; pass fromVersion or fromJarPath.`);
                notes.push(`fromVersion taken from the project classpath.`);
                return { jarPath: match.jarPath, version: artifactService.coordinatesFromJarPath(match.jarPath).version };
            }
            if (!version) throw new Error(`${label}Version is required with coordinates.`);
            let jar = (await artifactService.findCoordinateJars(`${groupId}:${artifactId}:${version}`))[0];
            if (!jar && args.download) {
                await sendProgress?.(`Downloading ${groupId}:${artifactId}:${version}`, 10, 100);
                const result = await this.scanner.downloadArtifact(workspacePath, { groupId, artifactId, version });
                jar = (await artifactService.findCoordinateJars(`${groupId}:${artifactId}:${version}`))[0];
                if (!jar) throw new Error(`Could not download ${groupId}:${artifactId}:${version}${result.message ? `: ${result.message}` : ''}`);
                notes.push(`Downloaded ${groupId}:${artifactId}:${version}.`);
            }
            if (!jar) throw new Error(`${groupId}:${artifactId}:${version} is not in the local Maven repository. Pass download: true to fetch it with mvn dependency:get.`);
            return { jarPath: jar, version };
        };
        const from = await resolveJar('from', args.fromJarPath, args.fromVersion);
        const to = await resolveJar('to', args.toJarPath, args.toVersion);
        await sendProgress?.('Reading class files of both versions', 40, 100);
        const select = (classes: DeepClassEntry[]) => classes.filter(cls => !cls.entryPath.startsWith('META-INF/versions/')
            && (!args.className || cls.className === args.className || cls.className.startsWith(`${args.className}$`))
            && (!args.packagePrefix || cls.className.startsWith(`${String(args.packagePrefix).replace(/\.$/, '')}.`)));
        const [fromIndex, toIndex] = await Promise.all([jarIndexer.getDeepIndex(from.jarPath, workspacePath), jarIndexer.getDeepIndex(to.jarPath, workspacePath)]);
        const fromClasses = select(fromIndex.classes);
        const toClasses = select(toIndex.classes);
        if (args.className && !fromClasses.length && !toClasses.length) throw new Error(`${args.className} exists in neither JAR.`);
        const diff = diffApi(fromClasses, toClasses);
        const limit = this.clamp(args.limit, 1, 500, 40);
        const label = (side: { jarPath: string; version?: string }) => side.version && groupId ? side.version : path.basename(side.jarPath);
        const listNames = (names: string[], max = 50) => names.slice(0, max).join(', ') + (names.length > max ? `, ... (${names.length - max} more)` : '');
        const lines = [
            `API diff${groupId ? ` of ${groupId}:${artifactId}` : ''}: ${label(from)} -> ${label(to)}`,
            `From: ${from.jarPath}`,
            `To:   ${to.jarPath}`,
            ...notes,
            `Public classes: ${diff.addedClasses.length} added, ${diff.removedClasses.length} removed, ${diff.changedClasses.length} changed, ${diff.unchangedClassCount} unchanged. Breaking changes: ${diff.breakingChangeCount}.`,
        ];
        if (diff.removedClasses.length) lines.push('', `Removed classes (breaking): ${listNames(diff.removedClasses)}`);
        if (diff.addedClasses.length) lines.push('', `Added classes: ${listNames(diff.addedClasses)}`);
        if (diff.changedClasses.length) {
            lines.push('', 'Changed classes:');
            for (const cls of diff.changedClasses.slice(0, limit)) {
                lines.push(`${cls.breaking ? '[BREAKING] ' : ''}${cls.className}`);
                for (const change of cls.classChanges) lines.push(`    * ${change}`);
                for (const member of cls.removed) lines.push(`    - ${member}`);
                for (const change of cls.changed) lines.push(`    ~ ${change.member}: ${change.change}${change.breaking ? ' (breaking)' : ''}`);
                for (const member of cls.added) lines.push(`    + ${member}`);
            }
            if (diff.changedClasses.length > limit) lines.push(`... ${diff.changedClasses.length - limit} more changed class(es); narrow with className/packagePrefix or raise limit.`);
        }
        if (!diff.addedClasses.length && !diff.removedClasses.length && !diff.changedClasses.length) lines.push('', 'No public/protected API differences.');
        lines.push('', 'Legend: - removed, + added, ~ changed, * class-level change. Only public/protected, non-synthetic members are compared; method bodies are not.');
        return this.formatResponse(lines.join('\n'), { from, to, ...diff }, args.format);
    }

    private async handleListDependencies(args: any, sendProgress?: Progress) {
        const workspacePath = await this.validateWorkspacePath(args.workspacePath ?? process.cwd());
        const contexts = await projectDiscovery.findTopLevelPomDirectories(workspacePath);
        if (!contexts.length) throw new Error(`No Maven/Gradle build found under ${workspacePath}; list_dependencies needs a Maven project.`);
        const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
        const limit = this.clamp(args.limit, 1, 2000, 300);
        const projects: Array<{ projectPath: string; modules?: Array<ModuleDependencies & { directCount: number; transitiveCount: number }>; error?: string }> = [];
        for (let i = 0; i < contexts.length; i++) {
            await sendProgress?.(`Resolving dependency tree of ${path.basename(contexts[i])}`, i, contexts.length);
            try {
                const { modules } = await this.scanner.listDependencies(contexts[i]);
                projects.push({
                    projectPath: contexts[i],
                    modules: modules.map(module => {
                        // Keep each match's ancestors so the path is visible (query) and direct-only/scope filters apply per node.
                        const stack: string[] = [];
                        const dependencies = module.dependencies.filter(dep => {
                            stack.length = dep.depth - 1;
                            stack.push(`${dep.groupId}:${dep.artifactId}`);
                            if (args.directOnly && dep.depth > 1) return false;
                            if (args.scope && dep.scope !== args.scope) return false;
                            return !query || stack[stack.length - 1].toLowerCase().includes(query);
                        });
                        return { module: module.module, dependencies, directCount: module.dependencies.filter(dep => dep.depth === 1).length, transitiveCount: module.dependencies.filter(dep => dep.depth > 1).length };
                    }),
                });
            } catch (error) {
                projects.push({ projectPath: contexts[i], error: error instanceof Error ? error.message : String(error) });
            }
        }
        let remaining = limit;
        let truncated = 0;
        const render = (dep: DependencyNode) => `${dep.groupId}:${dep.artifactId}:${dep.version}${dep.classifier ? `:${dep.classifier}` : ''}${dep.type !== 'jar' ? ` (${dep.type})` : ''} [${dep.scope ?? '?'}]${dep.optional ? ' optional' : ''}`;
        const text = projects.map(project => {
            if (project.error) return `Project: ${project.projectPath}\nError: ${project.error}`;
            const filtered = Boolean(query || args.directOnly || args.scope);
            const shown = project.modules!.filter(module => module.dependencies.length || (!filtered && module.directCount));
            if (!shown.length) return `Project: ${project.projectPath}\nNo ${filtered ? 'matching ' : ''}dependencies.`;
            return shown.map(module => {
                const header = `Module ${module.module}: ${module.directCount} direct, ${module.transitiveCount} transitive${query || args.directOnly || args.scope ? `; ${module.dependencies.length} shown` : ''}`;
                const rows = module.dependencies.flatMap(dep => {
                    if (remaining <= 0) { truncated++; return []; }
                    remaining--;
                    if (query) return [`- ${render(dep)}${dep.depth > 1 ? ` (transitive, via ${dep.via})` : ' (direct)'}`];
                    return [`${'  '.repeat(dep.depth - 1)}${dep.depth === 1 ? '- ' : '\\- '}${render(dep)}`];
                });
                return [header, ...rows].join('\n');
            }).join('\n\n');
        }).join('\n\n') + (truncated ? `\n\n${truncated} more dependency line(s) not shown; narrow with query, directOnly or scope, or raise limit.` : '');
        return this.formatResponse(text, { projects }, args.format);
    }

    private async handleExplainDependency(args: any, sendProgress?: Progress) {
        const workspacePath = await this.validateWorkspacePath(args.workspacePath ?? process.cwd());
        let coordinates = args.coordinates as string | undefined;
        if (!coordinates && args.jarPath) {
            const inspected = await artifactService.inspectJar({ jarPath: args.jarPath, workspacePath });
            const coordinate = inspected.index?.mavenCoordinates[0];
            if (coordinate?.groupId && coordinate.artifactId) coordinates = `${coordinate.groupId}:${coordinate.artifactId}`;
        }
        if (!coordinates) throw new Error('coordinates or a JAR containing Maven pom.properties is required');
        const contexts = await projectDiscovery.findTopLevelPomDirectories(workspacePath);
        if (!contexts.length) throw new Error(`No Maven/Gradle build found under ${workspacePath}; explain_dependency needs a Maven project.`);
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

    /** Full source of the class (for nested classes: just the nested declaration), plus the outer raw source. */
    private async loadFullSource(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any): Promise<FullSource> {
        const dollar = candidate.className.indexOf('$', candidate.className.lastIndexOf('.') + 1);
        if (dollar < 0) {
            const raw = await this.loadRawSource(candidate, entryPath, contextPath, args);
            return { ...raw, rawSource: raw.source };
        }
        // Nested class: sources and Vineflower output live in the top-level class; cut out the nested declaration.
        const outerClassName = candidate.className.substring(0, dollar);
        const outerEntryPath = entryPath.replace(/\$[^/]*(\.class|\.java)$/i, '$1');
        const raw = await this.loadRawSource({ ...candidate, className: outerClassName }, outerEntryPath, contextPath, args);
        const nested = extractTypeDeclaration(raw.source, candidate.className.substring(dollar + 1).split('$'));
        if (nested) return { source: nested, sourceOrigin: raw.sourceOrigin, enclosingClass: outerClassName, rawSource: raw.source, ...(raw.sourceNote ? { sourceNote: raw.sourceNote } : {}) };
        return {
            source: raw.source,
            rawSource: raw.source,
            sourceOrigin: raw.sourceOrigin,
            enclosingClass: outerClassName,
            sourceNote: [`${candidate.className} is an anonymous/local or synthetic class; showing the source of ${outerClassName}. Use view=bytecode for its exact code.`, raw.sourceNote].filter(Boolean).join(' '),
        };
    }

    private async loadClassSource(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any, selector: ArtifactSelector, javapMembers?: () => Promise<JavapMember[]>): Promise<SourceSlice> {
        const full = await this.loadFullSource(candidate, entryPath, contextPath, args);
        const meta = { sourceOrigin: full.sourceOrigin, ...(full.enclosingClass ? { enclosingClass: full.enclosingClass } : {}), ...(full.sourceNote ? { sourceNote: full.sourceNote } : {}) };
        if (args.line) return { ...meta, ...await this.sourceAtLine(full.rawSource, full.sourceOrigin, Number(args.line), candidate.className, javapMembers) };
        try {
            const slice = this.sliceSource(full.source, args);
            return { ...meta, ...slice, sourceNote: [meta.sourceNote, slice.sourceNote].filter(Boolean).join(' ') || undefined };
        } catch (error) {
            if (!(error instanceof MemberNotFoundError)) throw error;
            const inherited = await this.inheritedMemberSource(candidate, entryPath, contextPath, args, selector);
            if (!inherited) throw error;
            return inherited;
        }
    }

    private async loadClassOutline(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any): Promise<any> {
        const full = await this.loadFullSource(candidate, entryPath, contextPath, args);
        const members = buildOutline(full.source);
        return {
            sourceOrigin: full.sourceOrigin,
            ...(full.enclosingClass ? { enclosingClass: full.enclosingClass } : {}),
            ...(full.sourceNote ? { sourceNote: full.sourceNote } : {}),
            totalLines: full.source.split('\n').length,
            memberCount: members.length,
            outline: formatOutline(members),
        };
    }

    /**
     * methodName was not declared in the class: walk superclasses and interfaces (breadth-first) and
     * return the first declaration found, so "where does getBean() come from?" needs one call.
     */
    private async inheritedMemberSource(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any, selector: ArtifactSelector): Promise<SourceSlice | null> {
        const parentsOf = async (jarPath: string | undefined, entry: string | undefined, className: string): Promise<string[]> => {
            try {
                if (jdkSourceService.isLikelyJdkClass(className)) {
                    const analysis = await this.analyzer.analyzeJdkClass(className, contextPath);
                    return [analysis.superClass, ...analysis.interfaces].filter(Boolean) as string[];
                }
                if (!jarPath || !entry || entry.endsWith('.java')) return [];
                const metadata = ClassFileMetadataReader.read(await jarIndexer.readEntry(jarPath, entry, 20 * 1024 * 1024));
                return [metadata.superClass, ...metadata.interfaces].filter(Boolean) as string[];
            } catch { return []; }
        };
        const queue = (await parentsOf(candidate.jarPath, entryPath, candidate.className)).filter(name => name !== 'java.lang.Object');
        const visited = new Set<string>([candidate.className]);
        while (queue.length && visited.size < 25) {
            const parent = queue.shift()!;
            if (visited.has(parent)) continue;
            visited.add(parent);
            try {
                let source: string | null = null;
                let origin: NonNullable<SourceSlice['sourceOrigin']> = 'jdk-src.zip';
                let parentJar: string | undefined;
                let parentEntry: string | undefined;
                if (jdkSourceService.isLikelyJdkClass(parent)) {
                    source = await this.jdkClassSource(parent);
                } else {
                    const sameJar = (await jarIndexer.getLightIndex(candidate.jarPath, contextPath)).classes.find(item => item.className === parent && !item.isSource);
                    const located = sameJar
                        ? { ...candidate, className: parent, entryPath: sameJar.entryPath }
                        : (await artifactService.resolveClass(parent, selector.workspacePath ? { workspacePath: selector.workspacePath } : selector)).results.find(item => item.className === parent);
                    if (located) {
                        parentJar = located.jarPath;
                        parentEntry = located.entryPath ?? (await jarIndexer.getLightIndex(located.jarPath, contextPath)).classes.find(item => item.className === parent && !item.isSource)?.entryPath;
                        if (parentEntry) {
                            const full = await this.loadFullSource(located, parentEntry, contextPath, args);
                            source = full.source;
                            origin = full.sourceOrigin;
                        }
                    }
                }
                if (source) {
                    const members = extractMembers(source, args.methodName, args.paramTypes);
                    if (members.length) {
                        return {
                            source: members.map(member => member.text).join('\n\n// ===== Method Overload =====\n\n'),
                            sourceOrigin: origin,
                            declaredIn: parent,
                            lineInfo: `${args.methodName} is not declared in ${candidate.className}; inherited from ${parent}${parentJar ? ` (${path.basename(parentJar)})` : ''}.`,
                        };
                    }
                }
                for (const grandParent of await parentsOf(parentJar, parentEntry, parent)) {
                    if (grandParent !== 'java.lang.Object' && !visited.has(grandParent)) queue.push(grandParent);
                }
            } catch { /* unresolved parent: keep walking the others */ }
        }
        return null;
    }

    /** Stack-trace style lookup: show the member that contains original source line `line`. */
    private async sourceAtLine(source: string, sourceOrigin: NonNullable<SourceSlice['sourceOrigin']>, line: number, className: string, javapMembers?: () => Promise<JavapMember[]>): Promise<SourceSlice> {
        if (!Number.isInteger(line) || line < 1) throw new Error('line must be a positive integer (the line number from a stack trace).');
        const lines = source.split('\n');
        const outline = buildOutline(source);
        if (sourceOrigin !== 'decompiled') {
            if (line > lines.length) throw new Error(`line ${line} is past the end of the source (${lines.length} lines). Is the dependency version the one from the stack trace?`);
            const member = memberAtLine(outline, line);
            let range = member ? memberRangeWithDoc(lines, member) : { start: Math.max(1, line - 20), end: Math.min(lines.length, line + 20) };
            if (range.end - range.start > 300) range = { start: Math.max(range.start, line - 60), end: Math.min(range.end, line + 60) };
            return {
                source: this.numberLines(lines, range.start, range.end, line),
                sourceRange: { startLine: range.start, endLine: range.end, totalLines: lines.length },
                lineInfo: `Line ${line} (marked >>) is in ${member ? member.signature : 'the class body (no enclosing method)'}.`,
            };
        }
        if (!javapMembers) throw new Error('Line lookup in decompiled source needs the class file.');
        const members = await javapMembers();
        const hit = javapMemberAtLine(members, line);
        if (!hit) {
            const all = members.flatMap(member => member.lines);
            throw new Error(all.length
                ? `Line ${line} is not in ${className} (its code spans original lines ${Math.min(...all)}-${Math.max(...all)}). Check the class in the stack trace: lambdas/anonymous/inner classes appear as Outer$1, Outer$Inner, and a different dependency version shifts lines.`
                : `${className} was compiled without line numbers (no LineNumberTable); use methodName instead.`);
        }
        let name = hit.name;
        let paramTypes: string[] | undefined = hit.paramTypes.map(type => type.replace(/<.*>/g, ''));
        let where = hit.signature.replace(/;$/, '');
        const lambda = name.match(/^lambda\$(.+)\$\d+$/);
        if (lambda) { name = lambda[1]; paramTypes = undefined; where = `a lambda inside ${name}()`; }
        const simple = className.substring(className.lastIndexOf('.') + 1).split('$').pop()!;
        const ownMembers = outline.filter(member => member.owner[member.owner.length - 1] === simple);
        const scope = ownMembers.length ? ownMembers : outline;
        let found: { text: string } | undefined;
        if (name === '<clinit>') {
            const init = scope.find(member => member.kind === 'initializer');
            if (init) { const range = memberRangeWithDoc(lines, init); found = { text: lines.slice(range.start - 1, range.end).join('\n') }; }
        } else {
            const memberName = name === '<init>' ? simple : name;
            found = extractMembers(source, memberName, paramTypes, scope)[0] ?? extractMembers(source, memberName, undefined, scope)[0];
        }
        if (!found) return { source: hit.text, lineInfo: `Original line ${line} is in ${where}; it could not be located in the decompiled source, showing its bytecode instead.` };
        return { source: found.text, lineInfo: `Original line ${line} is in ${where}. The source is decompiled, so its line numbers differ from the stack trace; the whole member is shown.` };
    }

    private numberLines(lines: string[], start: number, end: number, mark: number): string {
        const width = String(end).length;
        return lines.slice(start - 1, end).map((text, index) => {
            const number = start + index;
            return `${number === mark ? '>>' : '  '} ${String(number).padStart(width)} | ${text}`;
        }).join('\n');
    }

    private bytecodeView(output: string, className: string, args: any): { bytecode: string; bytecodeNote?: string } {
        const parsed = parseJavapMembers(output, className);
        if (args.methodName) {
            const selected = selectJavapMembers(parsed.members, args.methodName, args.paramTypes, className);
            if (!selected.length) {
                const names = [...new Set(parsed.members.filter(member => member.isMethod).map(member => member.name))];
                throw new Error(`Method not found in bytecode: ${args.methodName}. Methods: ${names.slice(0, 60).join(', ')}${names.length > 60 ? ', ...' : ''}`);
            }
            return { bytecode: selected.map(member => member.text).join('\n\n') };
        }
        if (args.line) {
            const member = javapMemberAtLine(parsed.members, Number(args.line));
            if (member) return { bytecode: member.text, bytecodeNote: `Line ${args.line} is in ${member.signature.replace(/;$/, '')}.` };
        }
        const lineCount = output.split('\n').length;
        if (lineCount <= BYTECODE_AUTO_LIMIT) return { bytecode: output.trim() };
        return {
            bytecode: `${parsed.header}\n${parsed.members.map(member => `  ${member.signature}`).join('\n')}\n}`,
            bytecodeNote: `Full bytecode is ${lineCount} lines; only member signatures are listed. Pass methodName (and paramTypes) for one method's bytecode, or line for the method at a stack-trace line.`,
        };
    }

    private async loadRawSource(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any): Promise<{ source: string; sourceOrigin: NonNullable<SourceSlice['sourceOrigin']>; sourceNote?: string }> {
        const sameJarIndex = await jarIndexer.getLightIndex(candidate.jarPath, contextPath);
        const embeddedSource = sameJarIndex.classes.find(item => item.className === candidate.className && item.isSource);
        if (embeddedSource) {
            return { source: (await jarIndexer.readEntry(candidate.jarPath, embeddedSource.entryPath, 10 * 1024 * 1024)).toString('utf8'), sourceOrigin: 'embedded-source' };
        }
        let sourceJar = await artifactService.findSourcesJar(candidate.jarPath);
        if (sourceJar) {
            const sourceIndex = await jarIndexer.getLightIndex(sourceJar, contextPath);
            const sourceEntry = sourceIndex.classes.find(item => item.className === candidate.className && item.isSource);
            if (sourceEntry) return { source: (await jarIndexer.readEntry(sourceJar, sourceEntry.entryPath, 10 * 1024 * 1024)).toString('utf8'), sourceOrigin: 'sources-jar' };
        }
        const downloadNote = await this.tryDownloadSources(candidate, contextPath, args);
        if (downloadNote === true) sourceJar = await artifactService.findSourcesJar(candidate.jarPath);
        if (downloadNote === true && sourceJar) {
            const sourceIndex = await jarIndexer.getLightIndex(sourceJar, contextPath);
            const sourceEntry = sourceIndex.classes.find(item => item.className === candidate.className && item.isSource);
            if (sourceEntry) return { source: (await jarIndexer.readEntry(sourceJar, sourceEntry.entryPath, 10 * 1024 * 1024)).toString('utf8'), sourceOrigin: 'sources-jar', sourceNote: 'Sources JAR downloaded with mvn dependency:get.' };
        }
        const decompiled = cleanDecompilerFailures(await this.decompiler.decompileClassFromJar(candidate.className, candidate.jarPath, contextPath, entryPath, args.useCache !== false));
        return {
            source: decompiled.source,
            sourceOrigin: 'decompiled',
            ...(typeof downloadNote === 'string' || decompiled.failedMethods.length ? { sourceNote: [typeof downloadNote === 'string' ? downloadNote : '', decompiled.failedMethods.length ? `Vineflower could not decompile ${decompiled.failedMethods.length} method(s): ${decompiled.failedMethods.join('; ')}. Their bodies contain a bytecode listing; use view=bytecode with methodName for javap output.` : ''].filter(Boolean).join(' ') } : {}),
        };
    }

    /** true = a sources JAR was downloaded; string = why not (shown to the agent); undefined = not requested. */
    private async tryDownloadSources(candidate: ClassCandidate, contextPath: string, args: any): Promise<true | string | undefined> {
        const requested = args.downloadSources ?? /^(1|true|yes)$/i.test(process.env.JAVA_INSPECTOR_DOWNLOAD_SOURCES ?? '');
        if (!requested) return undefined;
        const coordinates = artifactService.coordinatesFromJarPath(candidate.jarPath);
        if (!coordinates.groupId || !coordinates.artifactId || !coordinates.version) return 'downloadSources skipped: the JAR is not in a Maven repository layout.';
        if (await buildToolOf(contextPath) === 'gradle') return 'downloadSources needs Maven; for Gradle projects add the sources to the Gradle cache (e.g. the IDE "Download Sources" action).';
        const key = `${coordinates.groupId}:${coordinates.artifactId}:${coordinates.version}`;
        let attempt = this.sourceDownloads.get(key);
        if (!attempt) {
            attempt = this.scanner.downloadSources(contextPath, coordinates as { groupId: string; artifactId: string; version: string });
            this.sourceDownloads.set(key, attempt);
        }
        const result = await attempt;
        if (result.ok && await artifactService.findSourcesJar(candidate.jarPath)) return true;
        return `No sources JAR could be downloaded for ${key}${result.message ? ` (${result.message})` : ''}; showing decompiled code.`;
    }

    private sliceSource(source: string, args: any): SourceSlice {
        const lines = source.split('\n');
        const totalLines = lines.length;
        if (args.methodName) {
            const outline = buildOutline(source);
            const members = extractMembers(source, args.methodName, args.paramTypes, outline);
            if (members.length) {
                return {
                    source: members.map(member => member.text).join('\n\n// ===== Method Overload =====\n\n'),
                    lineInfo: members.length === 1 ? `Lines ${members[0].start}-${members[0].end} of ${totalLines}.` : `${members.length} overloads.`,
                };
            }
            const extracted = extractMethod(source, args.methodName, args.paramTypes);
            if (extracted) return { source: extracted };
            throw new MemberNotFoundError(args.methodName, outline, args.paramTypes);
        }
        const offset = this.clamp(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
        const requestedLimit = Number(args.limit ?? 0);
        if (offset === 1 && !(requestedLimit > 0)) {
            if (totalLines <= SOURCE_AUTO_LIMIT) return { source };
            // Large file: never dump it whole. First lines + member outline; the agent then reads one member.
            return {
                source: lines.slice(0, SOURCE_AUTO_PREVIEW).join('\n'),
                sourceRange: { startLine: 1, endLine: SOURCE_AUTO_PREVIEW, totalLines },
                outline: formatOutline(buildOutline(source)),
                sourceNote: `Large file (${totalLines} lines): showing lines 1-${SOURCE_AUTO_PREVIEW} and the member outline. Read a member with methodName, or a range with offset/limit using the outline's line numbers.`,
            };
        }
        if (offset > totalLines) throw new Error(`offset ${offset} is past the end of the source (${totalLines} lines).`);
        const end = requestedLimit > 0 ? Math.min(totalLines, offset - 1 + requestedLimit) : totalLines;
        return { source: lines.slice(offset - 1, end).join('\n'), sourceRange: { startLine: offset, endLine: end, totalLines } };
    }

    private async jdkClassSource(className: string): Promise<string | null> {
        const dollar = className.indexOf('$');
        const outerName = dollar > 0 ? className.substring(0, dollar) : className;
        const outerSource = await jdkSourceService.getSource(outerName);
        if (!outerSource || dollar < 0) return outerSource;
        return extractTypeDeclaration(outerSource, className.substring(dollar + 1).split('$')) ?? outerSource;
    }

    private async inspectJdkClass(className: string, contextPath: string, view: string, args: any): Promise<any> {
        const result: any = { className, origin: 'jdk' };
        const dollar = className.indexOf('$');
        let bytecodeOutput: Promise<string> | undefined;
        const bytecode = () => bytecodeOutput ??= this.analyzer.getBytecode(className, contextPath);
        if (view === 'source' || view === 'all' || view === 'outline') {
            const source = args.line && dollar > 0 ? await jdkSourceService.getSource(className.substring(0, dollar)) : await this.jdkClassSource(className);
            if (!source) result.sourceUnavailable = true;
            else if (view === 'outline') Object.assign(result, { sourceOrigin: 'jdk-src.zip', outline: formatOutline(buildOutline(source)), totalLines: source.split('\n').length });
            else if (args.line) Object.assign(result, await this.sourceAtLine(source, 'jdk-src.zip', Number(args.line), className), { sourceOrigin: 'jdk-src.zip' });
            else Object.assign(result, this.sliceSource(source, args), { sourceOrigin: 'jdk-src.zip' });
            if (source && dollar > 0) result.enclosingClass = className.substring(0, dollar);
        }
        if (view === 'api' || view === 'all') result.api = { signatures: (await this.analyzer.getSignatures(className, contextPath)).trim() };
        if (view === 'hierarchy' || view === 'all') result.hierarchy = await this.resolveJdkHierarchy(className, contextPath);
        if (view === 'bytecode' || view === 'all') Object.assign(result, this.bytecodeView(await bytecode(), className, args));
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
        if (result.lineInfo) text += `\n${result.lineInfo}`;
        if (result.declaredIn) text += `\nDeclared in: ${result.declaredIn}`;
        if (result.totalLines && result.outline && !result.source) text += `\nLines: ${result.totalLines}`;
        if (result.sourceUnavailable) text += '\n\nSource: unavailable - the JDK has no lib/src.zip (install the JDK source package, e.g. openjdk-<version>-source, or a JDK that ships src.zip). view=api and view=bytecode still work.';
        if (result.source) text += `\n\nSource:\n\n\`\`\`java\n${result.source}\n\`\`\``;
        if (result.outline) text += `\n\nOutline (line ranges; read a member with methodName or offset/limit):\n\n\`\`\`text\n${result.outline}\n\`\`\``;
        if (result.api) text += `\n\nAPI (javap -p):\n\n\`\`\`text\n${result.api.signatures}\n\`\`\``;
        if (result.hierarchy) text += `\n\nHierarchy (root first):\n${result.hierarchy.map((item: HierarchyEntry) => `${'  '.repeat(item.level)}${item.className}${item.resolved ? '' : ' (unresolved)'}${item.interfaces?.length ? ` implements ${item.interfaces.join(', ')}` : ''}`).join('\n')}`;
        if (result.bytecodeNote) text += `\n\n${result.bytecodeNote}`;
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
        const wrap = (value: string) => ({ content: [{ type: 'text' as const, text: this.capResponse(value) }] });
        if (format === 'json') return wrap(JSON.stringify(structured, null, 2));
        if (format === 'toon') { try { return wrap(toonEncode(structured)); } catch { return wrap(text); } }
        return wrap(text);
    }

    /** Text lists grouped under their JAR, so long Maven paths are printed once instead of per line. */
    private groupByJar<T extends { jarPath: string }>(items: T[], render: (item: T) => string): string {
        const groups = new Map<string, string[]>();
        for (const item of items) {
            if (!groups.has(item.jarPath)) groups.set(item.jarPath, []);
            groups.get(item.jarPath)!.push(`  - ${render(item)}`);
        }
        return [...groups].map(([jarPath, lines]) => `${jarPath}\n${lines.join('\n')}`).join('\n');
    }

    /** Last-resort guard: no single response may flood the agent's context. */
    private capResponse(text: string): string {
        if (text.length <= MAX_RESPONSE_CHARS) return text;
        const cut = text.lastIndexOf('\n', MAX_RESPONSE_CHARS);
        const kept = text.substring(0, cut > MAX_RESPONSE_CHARS * 0.8 ? cut : MAX_RESPONSE_CHARS);
        const fence = (kept.match(/```/g)?.length ?? 0) % 2 === 1 ? '\n```' : '';
        return `${kept}${fence}\n\n[Response truncated at ${MAX_RESPONSE_CHARS} of ${text.length} characters. Narrow the request: methodName/line/offset+limit for source, methodName for bytecode, a smaller limit or a more specific query for searches.]`;
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
