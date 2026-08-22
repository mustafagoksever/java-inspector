import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
import { extractMethod } from './utils/methodExtractor.js';
import { Logger } from './utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
type Format = 'text' | 'json' | 'toon';
type Progress = (message: string, progress?: number, total?: number) => Promise<void>;

const FORMAT_PROPERTY = { type: 'string', enum: ['text', 'json', 'toon'], default: 'text', description: 'Output format.' };
const SELECTOR_PROPERTIES = {
    workspacePath: { type: 'string', description: 'Absolute Java workspace path. Maven is optional.' },
    jarPath: { type: 'string', description: 'Absolute path to an exact JAR. Fastest selector.' },
    jarDirectory: { type: 'string', description: 'Absolute directory to search for a JAR on demand.' },
    jarNamePrefix: { type: 'string', description: 'JAR basename prefix.' },
    coordinates: { type: 'string', description: 'groupId:artifactId[:version[:classifier]].' },
};

export class JavaClassAnalyzerMCPServer {
    private server: Server;
    private analyzer = new JavaClassAnalyzer();
    private scanner = new DependencyScanner();
    private decompiler = new DecompilerService();

    constructor() {
        this.server = new Server({ name: 'java-inspector', version }, { capabilities: { tools: {}, logging: {} } });
        this.setupHandlers();
    }

    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
            {
                name: 'scan_project',
                description: 'Start, refresh, or poll the non-blocking Maven dependency scan. Startup automatically calls this for the highest-level pom.xml files.',
                inputSchema: { type: 'object', properties: { workspacePath: { type: 'string' }, forceRefresh: { type: 'boolean', default: false }, format: FORMAT_PROPERTY }, required: ['workspacePath'] },
            },
            {
                name: 'find_jar',
                description: 'Find JAR paths by exact path, filename, prefix, substring, or Maven coordinates without opening the JAR.',
                inputSchema: { type: 'object', properties: { ...SELECTOR_PROPERTIES, match: { type: 'string', enum: ['exact', 'prefix', 'contains'], default: 'prefix' }, limit: { type: 'number', default: 20 }, format: FORMAT_PROPERTY } },
            },
            {
                name: 'inspect_jar',
                description: 'Inspect one JAR: manifest, Maven coordinates, layout, packages, classes, resources, and nested JAR metadata.',
                inputSchema: { type: 'object', properties: { ...SELECTOR_PROPERTIES, query: { type: 'string' }, offset: { type: 'number', default: 1 }, limit: { type: 'number', default: 100 }, format: FORMAT_PROPERTY } },
            },
            {
                name: 'search_class',
                description: 'Search the live partial index, then foreground-scan only relevant JARs without waiting for background scan completion.',
                inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...SELECTOR_PROPERTIES, includeJdk: { type: 'boolean', default: false }, mode: { type: 'string', enum: ['fast', 'balanced'], default: 'balanced' }, limit: { type: 'number', default: 20 }, format: FORMAT_PROPERTY }, required: ['query'] },
            },
            {
                name: 'search_code',
                description: 'Find method/field declarations, annotations, references, and real string constants from lazy class-file metadata.',
                inputSchema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['method', 'field', 'annotation', 'reference', 'string'] }, ...SELECTOR_PROPERTIES, mode: { type: 'string', enum: ['fast', 'balanced'], default: 'balanced' }, limit: { type: 'number', default: 20 }, format: FORMAT_PROPERTY }, required: ['query', 'kind'] },
            },
            {
                name: 'find_implementations',
                description: 'Find direct or transitive implementations/subtypes using lazy deep class metadata.',
                inputSchema: { type: 'object', properties: { className: { type: 'string' }, ...SELECTOR_PROPERTIES, transitive: { type: 'boolean', default: true }, mode: { type: 'string', enum: ['fast', 'balanced'], default: 'balanced' }, limit: { type: 'number', default: 50 }, format: FORMAT_PROPERTY }, required: ['className'] },
            },
            {
                name: 'inspect_class',
                description: 'Resolve and inspect a class from Maven, a local JAR, or the JDK. Views: source, API, hierarchy, bytecode, or all.',
                inputSchema: { type: 'object', properties: { className: { type: 'string' }, ...SELECTOR_PROPERTIES, view: { type: 'string', enum: ['source', 'api', 'hierarchy', 'bytecode', 'all'], default: 'source' }, methodName: { type: 'string' }, paramTypes: { type: 'array', items: { type: 'string' } }, offset: { type: 'number', default: 1 }, limit: { type: 'number', default: 0 }, useCache: { type: 'boolean', default: true }, format: FORMAT_PROPERTY }, required: ['className'] },
            },
            {
                name: 'explain_dependency',
                description: 'Run a filtered Maven dependency tree and explain why an artifact is present.',
                inputSchema: { type: 'object', properties: { workspacePath: { type: 'string' }, coordinates: { type: 'string' }, jarPath: { type: 'string' }, format: FORMAT_PROPERTY }, required: ['workspacePath'] },
            },
            {
                name: 'search_resources',
                description: 'Search resource paths or bounded text resource content in selected JARs.',
                inputSchema: { type: 'object', properties: { ...SELECTOR_PROPERTIES, pathQuery: { type: 'string', default: '' }, contentQuery: { type: 'string' }, limit: { type: 'number', default: 20 }, format: FORMAT_PROPERTY } },
            },
            {
                name: 'read_resource',
                description: 'Read an exact text resource with safe line pagination. Binary resources are rejected.',
                inputSchema: { type: 'object', properties: { ...SELECTOR_PROPERTIES, resourcePath: { type: 'string' }, offset: { type: 'number', default: 1 }, limit: { type: 'number', default: 200 }, format: FORMAT_PROPERTY }, required: ['resourcePath'] },
            },
        ] }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request: any, extra: any) => {
            const { name, arguments: args = {} } = request.params;
            const sendProgress: Progress = async (message, progress, total) => {
                if (extra._meta?.progressToken !== undefined) {
                    await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, message, progress, total } });
                }
            };
            try {
                switch (name) {
                    case 'scan_project': return this.handleScanProject(args, sendProgress);
                    case 'find_jar': return this.handleFindJar(args);
                    case 'inspect_jar': return this.handleInspectJar(args);
                    case 'search_class': return this.handleSearchClass(args, sendProgress);
                    case 'search_code': return this.handleSearchCode(args, sendProgress);
                    case 'find_implementations': return this.handleFindImplementations(args, sendProgress);
                    case 'inspect_class': return this.handleInspectClass(args, sendProgress);
                    case 'explain_dependency': return this.handleExplainDependency(args, sendProgress);
                    case 'search_resources': return this.handleSearchResources(args);
                    case 'read_resource': return this.handleReadResource(args);
                    default: throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await sendProgress(`Failed: ${message}`);
                return { content: [{ type: 'text', text: `Tool call failed: ${message}` }], isError: true };
            }
        });
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
        const result = await artifactService.searchClasses(args.query, selector, this.clamp(args.limit, 1, 100, 20), args.mode === 'fast' ? 5 : 20);
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
        const result = await artifactService.searchCode(args.query, args.kind, selector, this.clamp(args.limit, 1, 100, 20), args.mode === 'fast' ? 2 : 5);
        let text = result.matches.length ? `Found ${result.matches.length} match(es):\n${result.matches.map(item => `- ${item.className}${item.member ? `#${item.member}` : ''} -> ${item.jarPath}`).join('\n')}` : `No ${args.kind} match found for "${args.query}".`;
        if (!result.complete) text += `\n\nSearch is partial; ${result.remainingJarCount} JAR(s) remain.`;
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleFindImplementations(args: any, sendProgress?: Progress) {
        this.validateClassName(args.className);
        const selector = await this.selectorFromArgs(args, true);
        await sendProgress?.(`Finding implementations of ${args.className}`, 0, 100);
        const result = await artifactService.findImplementations(args.className, selector, args.transitive !== false, this.clamp(args.limit, 1, 200, 50), args.mode === 'fast' ? 2 : 5);
        let text = result.implementations.length ? `Found ${result.implementations.length} implementation(s):\n${result.implementations.map(item => `- ${item.className} -> ${item.jarPath}`).join('\n')}` : `No implementations found for ${args.className}${result.complete ? '.' : ' in the currently deep-indexed JARs.'}`;
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
        const resolved = await artifactService.resolveClass(args.className, selector);
        const exact = resolved.results.filter(item => item.className.toLowerCase() === String(args.className).toLowerCase() || item.simpleName.toLowerCase() === String(args.className).toLowerCase());
        const unique = this.uniqueClassCandidates(exact.length ? exact : resolved.results);
        if (!unique.length) throw new Error(`Class not found: ${args.className}`);
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
            result.source = await this.loadClassSource(candidate, classEntry.entryPath, contextPath, args);
        }
        const normalEntryPath = `${candidate.className.replace(/\./g, '/')}.class`;
        const needsExtractedClass = classEntry.entryPath !== normalEntryPath;
        let inspectionClassFile: string | undefined;
        if (view === 'api' || view === 'all') {
            const bytes = await jarIndexer.readEntry(candidate.jarPath, classEntry.entryPath, 20 * 1024 * 1024);
            const classFileMetadata = ClassFileMetadataReader.read(bytes);
            if (needsExtractedClass) inspectionClassFile = await this.getInspectionClassFile(candidate, classEntry.entryPath, contextPath, bytes);
            const summary = inspectionClassFile
                ? await this.analyzer.analyzeClassFile(candidate.className, inspectionClassFile, contextPath)
                : await this.analyzer.analyzeClassFromJar(candidate.className, candidate.jarPath, contextPath, true);
            result.api = { summary, classFileMetadata };
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
        let text = result.results.length ? `Found ${result.results.length} resource(s):\n${result.results.map(item => `- ${item.resourcePath} -> ${item.jarPath}`).join('\n')}` : 'No matching resources found.';
        if (!result.complete) text += '\n\nResource search is partial.';
        if (result.errors.length) text += `\n${result.errors.map(error => `- ${error.jarPath ?? error.contextPath ?? 'workspace'}: ${error.message}`).join('\n')}`;
        return this.formatResponse(text, result, args.format);
    }

    private async handleReadResource(args: any) {
        if (!args.resourcePath) throw new Error('resourcePath is required');
        const result = await artifactService.readResource(await this.selectorFromArgs(args), args.resourcePath, args.offset, args.limit);
        return this.formatResponse(`Resource ${result.resourcePath} (${result.startLine}-${result.endLine}/${result.totalLines}):\n\n${result.text}`, result, args.format);
    }

    private async loadClassSource(candidate: ClassCandidate, entryPath: string, contextPath: string, args: any): Promise<string> {
        const sameJarIndex = await jarIndexer.getLightIndex(candidate.jarPath, contextPath);
        const embeddedSource = sameJarIndex.classes.find(item => item.className === candidate.className && item.isSource);
        if (embeddedSource) {
            return this.sliceSource((await jarIndexer.readEntry(candidate.jarPath, embeddedSource.entryPath, 10 * 1024 * 1024)).toString('utf8'), args);
        }
        const sourceJar = candidate.jarPath.replace(/\.jar$/i, '-sources.jar');
        if (await fs.pathExists(sourceJar)) {
            const sourceIndex = await jarIndexer.getLightIndex(sourceJar, contextPath);
            const sourceEntry = sourceIndex.classes.find(item => item.className === candidate.className && item.isSource);
            if (sourceEntry) return this.sliceSource((await jarIndexer.readEntry(sourceJar, sourceEntry.entryPath, 10 * 1024 * 1024)).toString('utf8'), args);
        }
        const source = await this.decompiler.decompileClassFromJar(candidate.className, candidate.jarPath, contextPath, entryPath, args.useCache !== false);
        return this.sliceSource(source, args);
    }

    private sliceSource(source: string, args: any): string {
        if (args.methodName) {
            const extracted = extractMethod(source, args.methodName, args.paramTypes);
            if (!extracted) throw new Error(`Method not found: ${args.methodName}`);
            return extracted;
        }
        const lines = source.split('\n');
        const offset = this.clamp(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
        const requestedLimit = Number(args.limit ?? 0);
        if (offset === 1 && requestedLimit <= 0) return source;
        const end = requestedLimit > 0 ? Math.min(lines.length, offset - 1 + requestedLimit) : lines.length;
        return lines.slice(offset - 1, end).join('\n');
    }

    private async inspectJdkClass(className: string, contextPath: string, view: string, args: any): Promise<any> {
        const result: any = { className, origin: 'jdk' };
        if (view === 'source' || view === 'all') {
            const source = await jdkSourceService.getSource(className);
            if (source) result.source = this.sliceSource(source, args); else result.sourceUnavailable = true;
        }
        if (view === 'api' || view === 'all' || view === 'hierarchy') result.api = await this.analyzer.analyzeJdkClass(className, contextPath);
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
            try { current = (await this.analyzer.analyzeJdkClass(current, contextPath)).superClass; }
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
                chain.push({ className: current, level: chain.length, resolved: true });
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
        if (result.source) text += `\n\nSource:\n\n\`\`\`java\n${result.source}\n\`\`\``;
        if (result.api) text += `\n\nAPI:\n${JSON.stringify(result.api, null, 2)}`;
        if (result.hierarchy) text += `\n\nHierarchy:\n${result.hierarchy.map((item: HierarchyEntry) => `${'  '.repeat(item.level)}${item.className}${item.resolved ? '' : ' (unresolved)'}`).join('\n')}`;
        if (result.bytecode) text += `\n\nBytecode:\n\n\`\`\`text\n${result.bytecode}\n\`\`\``;
        return text;
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

    private formatResponse(text: string, structured: object, format: Format = 'text') {
        if (format === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }] };
        if (format === 'toon') { try { return { content: [{ type: 'text', text: toonEncode(structured) }] }; } catch { return { content: [{ type: 'text', text }] }; } }
        return { content: [{ type: 'text', text }] };
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

    private async validateProjectPath(projectPath: string): Promise<void> {
        const resolved = await this.validateDirectory(projectPath, 'projectPath');
        if (!(await fs.pathExists(path.join(resolved, 'pom.xml')))) throw new Error(`No pom.xml found in ${resolved}`);
    }

    private async ensureScanStarted(projectPath: string, sendProgress?: Progress): Promise<void> {
        if (await this.scanner.isIndexComplete(projectPath)) return;
        if (await this.scanner.getClasspath(projectPath)) return;
        try { await this.scanner.scanProject(projectPath, false, sendProgress); }
        catch (error) { throw new Error(`Unable to start dependency scan: ${error instanceof Error ? error.message : String(error)}`); }
    }

    private applyFilter(analysis: { fields: any[]; methods: any[] }, filter: string): { fields: any[]; methods: any[] } {
        let fields = analysis.fields, methods = analysis.methods;
        if (filter === 'fields') methods = [];
        else if (filter === 'methods') fields = [];
        else if (filter !== 'all') { fields = fields.filter(field => field.modifiers.includes(filter)); methods = methods.filter(method => method.modifiers.includes(filter)); }
        return { fields, methods };
    }

    private getDebugEnv(): Record<string, string | undefined> {
        return { NODE_ENV: process.env.NODE_ENV, JAVA_HOME: process.env.JAVA_HOME, MAVEN_HOME: process.env.MAVEN_HOME, MAVEN_CMD: process.env.MAVEN_CMD, MAVEN_REPO: process.env.MAVEN_REPO, DECOMPILER_PATH: process.env.DECOMPILER_PATH };
    }

    private logToolDebug(logger: Logger, toolName: string, projectPath: string, extra?: Record<string, unknown>): void {
        if (process.env.NODE_ENV !== 'development') return;
        logger.debug(`[TOOL:${toolName}] Context: projectPath=${projectPath}, serverVersion=${version}`);
        if (extra) logger.debug(`[TOOL:${toolName}] Params: ${JSON.stringify(extra)}`);
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
        await this.server.connect(new StdioServerTransport());
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
