import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { JavaClassAnalyzer } from './analyzer/JavaClassAnalyzer.js';
import { DependencyScanner } from './scanner/DependencyScanner.js';
import { DecompilerService } from './decompiler/DecompilerService.js';
import { extractMethod, extractMethodMap, MethodLineRange } from './utils/methodExtractor.js';
import { encode as toonEncode } from '@toon-format/toon';

import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import * as path from 'path';
import fs from 'fs-extra';
import { Logger } from './utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));

export class JavaClassAnalyzerMCPServer {
    private server: Server;
    private analyzer: JavaClassAnalyzer;
    private scanner: DependencyScanner;
    private decompiler: DecompilerService;

    constructor() {
        this.server = new Server(
            {
                name: 'java-inspector',
                version,
            },
            {
                capabilities: {
                    tools: {},
                    logging: {},
                },
            }
        );

        this.analyzer = new JavaClassAnalyzer();
        this.scanner = new DependencyScanner();
        this.decompiler = new DecompilerService();

        this.setupHandlers();
    }

    private setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'scan_dependencies',
                        description: 'Start or check the background scan of Maven dependencies. The server automatically indexes classes in the background after the first call. Use forceRefresh to rebuild the index.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven project root directory path',
                                },
                                forceRefresh: {
                                    type: 'boolean',
                                    description: 'Whether to force refresh index',
                                    default: false,
                                },
                                format: {
                                    type: 'string',
                                    enum: ['text', 'json', 'toon'],
                                    description: 'Output format. Default is text (human-readable). Use json for structured machine-readable data. Use toon for Token-Oriented Object Notation — a compact, LLM-friendly format that reduces tokens by ~40% compared to JSON while preserving structure (https://github.com/toon-format/toon).',
                                    default: 'text',
                                },
                            },
                            required: ['projectPath'],
                        },
                    },
                    {
                        name: 'decompile_class',
                        description: 'Decompile a Java class from Maven dependencies into full Java source code using Vineflower. Returns the complete .java source file (method bodies included). Optionally extract a single method by name, or paginate with offset/limit. Use this when you need to read the actual implementation.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                className: {
                                    type: 'string',
                                    description: 'Fully qualified name of the Java class to decompile, e.g., io.micrometer.observation.ObservationRegistry or com.example.QueryBizOrderDO',
                                },
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven project root directory path',
                                },
                                useCache: {
                                    type: 'boolean',
                                    description: 'Whether to use cache, default true',
                                    default: true,
                                },
                                decompilerPath: {
                                    type: 'string',
                                    description: 'JAR package path of Vineflower decompiler, optional',
                                },
                                methodName: {
                                    type: 'string',
                                    description: 'Optional method name to extract instead of the full class. When provided, only the method body is returned.',
                                },
                                offset: {
                                    type: 'number',
                                    description: 'Start line number (1-based, default: 1)',
                                    default: 1,
                                },
                                limit: {
                                    type: 'number',
                                    description: 'Max lines to return (0 = all lines)',
                                    default: 0,
                                },
                                format: {
                                    type: 'string',
                                    enum: ['text', 'json', 'toon'],
                                    description: 'Output format. Default is text (human-readable). Use json for structured machine-readable data. Use toon for Token-Oriented Object Notation — a compact, LLM-friendly format that reduces tokens by ~40% compared to JSON while preserving structure (https://github.com/toon-format/toon).',
                                    default: 'text',
                                },
                            },
                            required: ['className', 'projectPath'],
                        },
                    },
                    {
                        name: 'analyze_class',
                        description: 'Analyze a Java class structure (signatures only, no method bodies) from Maven dependencies using javap. Returns fields, methods, constructors, superclass and interfaces. Use this for a lightweight overview when you do not need full source code.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                className: {
                                    type: 'string',
                                    description: 'Fully qualified name of the Java class to analyze, e.g., io.micrometer.observation.ObservationRegistry or com.example.QueryBizOrderDO',
                                },
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven project root directory path',
                                },
                                filter: {
                                    type: 'string',
                                    enum: ['all', 'public', 'private', 'protected', 'fields', 'methods'],
                                    description: 'Filter members by visibility or type',
                                    default: 'all'
                                },
                                format: {
                                    type: 'string',
                                    enum: ['text', 'json', 'toon'],
                                    description: 'Output format. Default is text (human-readable). Use json for structured machine-readable data. Use toon for Token-Oriented Object Notation — a compact, LLM-friendly format that reduces tokens by ~40% compared to JSON while preserving structure (https://github.com/toon-format/toon).',
                                    default: 'text',
                                },
                            },
                            required: ['className', 'projectPath'],
                        },
                    },
                    {
                        name: 'search_class',
                        description: 'Fuzzy search for Java classes inside the project\'s Maven dependencies. Results may be partial while the background scan is in progress.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'Search query (partial class name, e.g. "ObservationRegistry", "JpaRepository", or "QueryBizOrderDO")',
                                },
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven project root directory path',
                                },
                                limit: {
                                    type: 'number',
                                    description: 'Maximum number of results to return',
                                    default: 20,
                                },
                                format: {
                                    type: 'string',
                                    enum: ['text', 'json', 'toon'],
                                    description: 'Output format. Default is text (human-readable). Use json for structured machine-readable data. Use toon for Token-Oriented Object Notation — a compact, LLM-friendly format that reduces tokens by ~40% compared to JSON while preserving structure (https://github.com/toon-format/toon).',
                                    default: 'text',
                                },
                            },
                            required: ['query', 'projectPath'],
                        },
                    },
                    {
                        name: 'get_inheritance_tree',
                        description: 'Get the full inheritance hierarchy (superclasses) of a Java class from Maven dependencies. The server resolves classes on-demand if they are not yet indexed.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                className: {
                                    type: 'string',
                                    description: 'Fully qualified name of the Java class, e.g., io.micrometer.observation.ObservationRegistry or com.example.QueryBizOrderDO',
                                },
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven project root directory path',
                                },
                                format: {
                                    type: 'string',
                                    enum: ['text', 'json', 'toon'],
                                    description: 'Output format. Default is text (human-readable). Use json for structured machine-readable data. Use toon for Token-Oriented Object Notation — a compact, LLM-friendly format that reduces tokens by ~40% compared to JSON while preserving structure (https://github.com/toon-format/toon).',
                                    default: 'text',
                                },
                            },
                            required: ['className', 'projectPath'],
                        },
                    },

                ],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request: any, extra: any) => {
            const { name, arguments: args } = request.params;
            const sendProgress = async (message: string, progress?: number, total?: number) => {
                if (extra._meta?.progressToken !== undefined) {
                    await extra.sendNotification({
                        method: 'notifications/progress',
                        params: {
                            progressToken: extra._meta.progressToken,
                            progress,
                            total,
                            message
                        }
                    });
                }
                console.error(`[${name}] ${message}`);
            };

            try {
                await sendProgress(`Starting tool: ${name}`);
                switch (name) {
                    case 'scan_dependencies':
                        await this.validateProjectPath(args.projectPath);
                        return await this.handleScanDependencies(args, sendProgress);
                    case 'decompile_class':
                        await this.validateProjectPath(args.projectPath);
                        return await this.handleDecompileClass(args, sendProgress);
                    case 'analyze_class':
                        await this.validateProjectPath(args.projectPath);
                        return await this.handleAnalyzeClass(args, sendProgress);
                    case 'search_class':
                        await this.validateProjectPath(args.projectPath);
                        return await this.handleSearchClass(args, sendProgress);
                    case 'get_inheritance_tree':
                        await this.validateProjectPath(args.projectPath);
                        return await this.handleGetInheritanceTree(args, sendProgress);
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`Tool call exception [${name}]:`, error);
                await sendProgress(`Failed: ${errorMessage}`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Tool call failed: ${errorMessage}`,
                        },
                    ],
                };
            }
        });
    }

    private formatResponse(text: string, structured: object, format: string) {
        if (format === 'json') {
            return { structuredContent: structured };
        }
        if (format === 'toon') {
            try {
                const toonText = toonEncode(structured);
                return { content: [{ type: 'text', text: toonText }] };
            } catch {
                return { content: [{ type: 'text', text }] };
            }
        }
        return { content: [{ type: 'text', text }] };
    }

    private async handleScanDependencies(args: any, sendProgress?: (message: string, progress?: number, total?: number) => Promise<void>) {
        const { projectPath, forceRefresh = false, format = 'text' } = args;
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[TOOL:scan_dependencies] Request: forceRefresh=${forceRefresh}`);
        this.logToolDebug(logger, 'scan_dependencies', projectPath, { forceRefresh });

        await sendProgress?.(`Scanning project: ${projectPath}`, 0, 100);
        const result = await this.scanner.scanProject(projectPath, forceRefresh, sendProgress);
        const duration = ((performance.now() - start) / 1000).toFixed(2);
        logger.info(`[TOOL:scan_dependencies] Complete in ${duration}s. Status: ${result.status}, JARs: ${result.jarCount}, Classes: ${result.classCount}`);

        if (result.status === 'complete') {
            await sendProgress?.(`Scan complete: ${result.jarCount} JARs, ${result.classCount} classes`, 100, 100);
            const text = `Dependency scanning complete! Indexed ${result.classCount} classes from ${result.jarCount} JARs.`;
            const structured = {
                status: result.status,
                jarCount: result.jarCount,
                classCount: result.classCount,
            };
            return this.formatResponse(text, structured, format);
        }

        // Background scan in progress
        const progressText = result.progress
            ? `${result.progress.processed}/${result.progress.total} JARs processed`
            : 'starting...';
        const progressPct = result.progress ? Math.floor((result.progress.processed / result.progress.total) * 100) : 0;
        await sendProgress?.(`Background scan in progress: ${progressText}`, progressPct, 100);

        let text = `Background dependency scan is in progress.\n\n`;
        if (result.message) {
            text += `${result.message}\n\n`;
        }
        text += `Total JARs: ${result.jarCount}\n`;
        text += `Progress: ${progressText}\n\n`;
        text += `You can already use \`decompile_class\` and \`analyze_class\` — the server will resolve classes on-demand. `;
        text += `Call \`scan_dependencies\` again later to check progress.`;

        const structured = {
            status: result.status,
            jarCount: result.jarCount,
            progress: result.progress,
        };
        return this.formatResponse(text, structured, format);
    }

    private async handleDecompileClass(args: any, sendProgress?: (message: string, progress?: number, total?: number) => Promise<void>) {
        const { className, projectPath, useCache = true, decompilerPath, offset = 1, limit = 0, format = 'text' } = args;
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[TOOL:decompile_class] Request: className=${className}, useCache=${useCache}, decompilerPath=${decompilerPath || 'auto-detect'}`);
        this.logToolDebug(logger, 'decompile_class', projectPath, { className, useCache, decompilerPath: decompilerPath || 'auto-detect' });

        try {
            await sendProgress?.(`Starting decompilation of class: ${className}`, 0, 100);

            // Check if index exists, create if not
            await sendProgress?.('Checking class index...', 10, 100);
            await this.ensureScanStarted(projectPath, sendProgress);

            await sendProgress?.('Decompiling class...', 50, 100);
            const sourceCode = await this.decompiler.decompileClass(className, projectPath, useCache, decompilerPath);

            await sendProgress?.('Decompilation complete', 100, 100);

            if (!sourceCode || sourceCode.trim() === '') {
                const text = `Warning: Decompilation result for class ${className} is empty, possibly due to Vineflower decompiler issues or corrupted class file`;
                const structured = { className, sourceCode: '', totalLines: 0, methods: [] };
                return this.formatResponse(text, structured, format);
            }

            const totalLines = sourceCode.split('\n').length;
            const methods = (format === 'json' || format === 'toon') ? extractMethodMap(sourceCode) : [];

            // Apply method extraction or offset/limit slicing
            let finalSourceCode = sourceCode;
            let sliceInfo = '';
            let extractedMethodRange: MethodLineRange | undefined;

            if (args.methodName) {
                const extracted = extractMethod(sourceCode, args.methodName);
                if (!extracted) {
                    const text = `Method "${args.methodName}" not found in class ${className}.`;
                    const structured = { className, totalLines, methods };
                    return this.formatResponse(text, structured, format);
                }
                finalSourceCode = extracted;
                sliceInfo = ` (method: ${args.methodName})`;
                extractedMethodRange = methods.find(m => m.name === args.methodName);
            } else if (offset > 1 || limit > 0) {
                const lines = sourceCode.split('\n');

                const effectiveOffset = offset <= 0 ? 1 : offset;
                if (effectiveOffset > totalLines) {
                    const text = `Offset ${effectiveOffset} exceeds total lines ${totalLines} for class ${className}.`;
                    const structured = { className, totalLines, methods };
                    return this.formatResponse(text, structured, format);
                }

                const effectiveLimit = limit < 0 ? 0 : limit;
                const startIndex = effectiveOffset - 1;
                const endIndex = effectiveLimit > 0
                    ? Math.min(startIndex + effectiveLimit, totalLines)
                    : totalLines;

                finalSourceCode = lines.slice(startIndex, endIndex).join('\n');
                sliceInfo = ` (lines ${effectiveOffset}-${endIndex} of ${totalLines})`;
            }

            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.info(`[TOOL:decompile_class] Complete in ${duration}s. Source length: ${sourceCode.length} chars.`);

            const text = `Decompiled source code for class ${className}${sliceInfo}:\n\n\`\`\`java\n${finalSourceCode}\n\`\`\``;

            const structured: any = {
                className,
                totalLines,
                sourceCode: finalSourceCode,
                methods,
            };
            if (extractedMethodRange) {
                structured.extractedMethod = {
                    name: extractedMethodRange.name,
                    startLine: extractedMethodRange.startLine,
                    endLine: extractedMethodRange.endLine,
                };
            }
            return this.formatResponse(text, structured, format);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.error(`[TOOL:decompile_class] Failed after ${duration}s: ${errorMessage}`);
            await sendProgress?.(`Decompilation failed: ${errorMessage}`);
            const text = `Decompilation failed: ${errorMessage}`;
            const structured = { className, error: errorMessage };
            return this.formatResponse(text, structured, format);
        }
    }

    private async handleAnalyzeClass(args: any, sendProgress?: (message: string, progress?: number, total?: number) => Promise<void>) {
        const { className, projectPath, filter = 'all', format = 'text' } = args;
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[TOOL:analyze_class] Request: className=${className}, filter=${filter}`);
        this.logToolDebug(logger, 'analyze_class', projectPath, { className, filter });

        await sendProgress?.(`Analyzing class: ${className}`, 0, 100);

        // Check if index exists, create if not
        await sendProgress?.('Checking class index...', 20, 100);
        await this.ensureScanStarted(projectPath, sendProgress);

        await sendProgress?.('Running javap analysis...', 50, 100);
        const analysis = await this.analyzer.analyzeClass(className, projectPath);

        await sendProgress?.('Analysis complete', 100, 100);
        const duration = ((performance.now() - start) / 1000).toFixed(2);
        logger.info(`[TOOL:analyze_class] Complete in ${duration}s. Fields: ${analysis.fields.length}, Methods: ${analysis.methods.length}`);

        const { fields, methods } = this.applyFilter(analysis, filter);

        let text = `Analysis result for class ${className}:\n\n`;
        text += `Package name: ${analysis.packageName}\n`;
        text += `Class name: ${analysis.className}\n`;
        text += `Modifiers: ${analysis.modifiers.join(' ')}\n`;
        text += `Super class: ${analysis.superClass || 'None'}\n`;
        text += `Implemented interfaces: ${analysis.interfaces.join(', ') || 'None'}\n\n`;

        if (fields.length > 0) {
            text += `Fields (${fields.length}):\n`;
            fields.forEach(field => {
                text += `  - ${field.modifiers.join(' ')} ${field.type} ${field.name}\n`;
            });
            text += '\n';
        }

        if (methods.length > 0) {
            text += `Methods (${methods.length}):\n`;
            methods.forEach(method => {
                text += `  - ${method.modifiers.join(' ')} ${method.returnType} ${method.name}(${method.parameters.join(', ')})\n`;
            });
            text += '\n';
        }

        const structured = {
            className: analysis.className,
            packageName: analysis.packageName,
            modifiers: analysis.modifiers,
            superClass: analysis.superClass,
            interfaces: analysis.interfaces,
            fields,
            methods,
        };
        return this.formatResponse(text, structured, format);
    }

    private async handleSearchClass(args: any, sendProgress?: (message: string, progress?: number, total?: number) => Promise<void>) {
        const { query, projectPath, limit = 20, format = 'text' } = args;
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[TOOL:search_class] Request: query="${query}", limit=${limit}`);
        this.logToolDebug(logger, 'search_class', projectPath, { query, limit });

        await sendProgress?.(`Searching for classes matching: "${query}"`, 0, 100);
        await this.ensureScanStarted(projectPath, sendProgress);

        await sendProgress?.('Searching index...', 50, 100);
        const results = await this.scanner.searchClasses(projectPath, query, limit);
        const duration = ((performance.now() - start) / 1000).toFixed(2);
        logger.info(`[TOOL:search_class] Complete in ${duration}s. Found ${results.length} results.`);

        await sendProgress?.(`Found ${results.length} matches`, 100, 100);

        const isComplete = await this.scanner.isIndexComplete(projectPath);
        const scanProgress = isComplete ? undefined : await this.scanner.getScanProgress(projectPath);
        const pct = scanProgress ? Math.floor((scanProgress.processed / scanProgress.total) * 100) : undefined;

        if (results.length === 0) {
            const text = `No classes found matching "${query}".\n\nSuggestions:\n1. Check your spelling\n2. Run scan_dependencies first if you haven't already\n3. Try a broader query (e.g. "Repository" instead of "JpaRepository")`;
            const structured = { query, results: [], isComplete, scanProgressPct: pct };
            return this.formatResponse(text, structured, format);
        }

        let text = `Found ${results.length} class(es) matching "${query}":\n\n`;
        text += '| # | Class Name | Package | JAR | Score |\n';
        text += '|---|------------|---------|-----|-------|\n';
        results.forEach((entry, idx) => {
            text += `| ${idx + 1} | \`${entry.simpleName}\` | ${entry.packageName} | ${path.basename(entry.jarPath)} | ${entry.score} |\n`;
        });
        text += '\nUse the fully qualified class name with `decompile_class` or `analyze_class` to inspect it further.';

        if (!isComplete && pct !== undefined) {
            text += `\n\n_Note: Background dependency scan is ${pct}% complete. Results may be partial._`;
        }

        const structured = {
            query,
            results: results.map((r: any) => ({
                className: `${r.packageName}.${r.simpleName}`,
                packageName: r.packageName,
                simpleName: r.simpleName,
                jarName: path.basename(r.jarPath),
                score: r.score,
            })),
            isComplete,
            scanProgressPct: pct,
        };
        return this.formatResponse(text, structured, format);
    }

    private async handleGetInheritanceTree(args: any, sendProgress?: (message: string, progress?: number, total?: number) => Promise<void>) {
        const { className, projectPath, format = 'text' } = args;
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[TOOL:get_inheritance_tree] Request: className=${className}`);
        this.logToolDebug(logger, 'get_inheritance_tree', projectPath, { className });

        await sendProgress?.(`Building inheritance tree for: ${className}`, 0, 100);
        await this.ensureScanStarted(projectPath, sendProgress);

        await sendProgress?.('Analyzing class hierarchy...', 50, 100);
        const hierarchy = await this.analyzer.getInheritanceHierarchy(className, projectPath);
        const duration = ((performance.now() - start) / 1000).toFixed(2);
        logger.info(`[TOOL:get_inheritance_tree] Complete in ${duration}s. Hierarchy depth: ${hierarchy.length}`);

        await sendProgress?.('Hierarchy complete', 100, 100);

        let text = `Inheritance hierarchy for \`${className}\`:\n\n`;
        hierarchy.forEach((entry, idx) => {
            const indent = '  '.repeat(idx);
            const arrow = idx === 0 ? '' : '▸ ';
            text += `${indent}${arrow}\`${entry.className}\`${entry.resolved ? '' : ' (not in indexed dependencies)'}\n`;
        });

        if (hierarchy.length === 1) {
            text += '\n(This class has no superclass in the indexed dependencies; it likely extends java.lang.Object or a JDK class not present in the Maven dependencies.)';
        }

        const structured = {
            className,
            hierarchy: hierarchy.map(entry => ({
                className: entry.className,
                level: entry.level,
                resolved: entry.resolved,
            })),
        };
        return this.formatResponse(text, structured, format);
    }

    private applyFilter(
        analysis: { fields: any[]; methods: any[] },
        filter: string
    ): { fields: any[]; methods: any[] } {
        let fields = analysis.fields;
        let methods = analysis.methods;

        if (filter === 'fields') {
            methods = [];
        } else if (filter === 'methods') {
            fields = [];
        } else if (filter !== 'all') {
            fields = fields.filter(f => f.modifiers.includes(filter));
            methods = methods.filter(m => m.modifiers.includes(filter));
        }

        return { fields, methods };
    }

/**
     * Validate that projectPath is a valid Maven project root.
     */
    private async validateProjectPath(projectPath: string): Promise<void> {
        if (!projectPath || typeof projectPath !== 'string') {
            throw new Error('projectPath is required and must be a string.');
        }
        if (!path.isAbsolute(projectPath)) {
            throw new Error(`projectPath must be an absolute path. Received: ${projectPath}`);
        }
        if (!(await fs.pathExists(projectPath))) {
            throw new Error(`projectPath does not exist: ${projectPath}`);
        }
        const stat = await fs.stat(projectPath);
        if (!stat.isDirectory()) {
            throw new Error(`projectPath is not a directory: ${projectPath}`);
        }
        const pomPath = path.join(projectPath, 'pom.xml');
        if (!(await fs.pathExists(pomPath))) {
            throw new Error(`No pom.xml found in ${projectPath}. Ensure this is a Maven project root.`);
        }
    }

    /**
     * Ensure classpath is resolved and background scan has started.
     * This is non-blocking — the scan continues in the background.
     */
    private async ensureScanStarted(projectPath: string, sendProgress?: (message: string, progress?: number, total?: number) => Promise<void>): Promise<void> {
        // Check if we have a complete and valid index
        if (await this.scanner.isIndexComplete(projectPath)) {
            return; // Already have a complete index
        }

        // Check if classpath cache exists (scan already started)
        if (await this.scanner.getClasspath(projectPath)) {
            return; // Background scan already in progress
        }

        console.error('No index found. Starting background dependency scan...');
        await sendProgress?.('No index found. Starting background dependency scan...');
        try {
            await this.scanner.scanProject(projectPath, false, sendProgress);
            console.error('Background scan started');
            await sendProgress?.('Background scan started');
        } catch (error) {
            console.error('Failed to start background scan:', error);
            throw new Error(`Unable to start dependency scan: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private getDebugEnv(): Record<string, string | undefined> {
        return {
            NODE_ENV: process.env.NODE_ENV,
            JAVA_HOME: process.env.JAVA_HOME,
            MAVEN_HOME: process.env.MAVEN_HOME,
            MAVEN_CMD: process.env.MAVEN_CMD,
            MAVEN_REPO: process.env.MAVEN_REPO,
            DECOMPILER_PATH: process.env.DECOMPILER_PATH,
        };
    }

    private logServerStartup(logger?: Logger): void {
        const env = process.env.NODE_ENV || 'development';
        const modeLabel = env === 'development' ? 'DEBUG MODE' : 'production';
        const startupMsg = `java-inspector v${version} MCP Server running on stdio (${modeLabel})`;
        const envMsg = `[SERVER] Environment: ${JSON.stringify(this.getDebugEnv())}`;
        const runtimeMsg = `[SERVER] Runtime: cwd=${process.cwd()}, platform=${process.platform}, arch=${process.arch}, node=${process.version}, pid=${process.pid}`;

        console.error(startupMsg);
        console.error(`[SERVER] ${runtimeMsg}`);
        console.error(envMsg);

        if (logger) {
            logger.info(`[SERVER] ${startupMsg}`);
            logger.info(runtimeMsg);
            logger.info(envMsg);
        }
    }

    private logToolDebug(logger: Logger, toolName: string, projectPath: string, extra?: Record<string, unknown>): void {
        const isDebug = process.env.NODE_ENV === 'development';
        if (!isDebug) return;
        logger.debug(`[TOOL:${toolName}] Context: projectPath=${projectPath}, serverVersion=${version}, node=${process.version}, platform=${process.platform}`);
        if (extra) {
            logger.debug(`[TOOL:${toolName}] Params: ${JSON.stringify(extra)}`);
        }
    }

    private async tryAutoScan(): Promise<void> {
        const cwd = process.cwd();
        const pomPath = path.join(cwd, 'pom.xml');

        if (!(await fs.pathExists(pomPath))) {
            return;
        }

        const logger = Logger.get(cwd);
        logger.info(`[AUTO-SCAN] Maven project detected at ${cwd}. Starting dependency scan...`);
        try {
            await this.validateProjectPath(cwd);
            const start = performance.now();
            await this.scanner.scanProject(cwd, false, async (msg) => {
                logger.info(`[AUTO-SCAN] ${msg}`);
            });
            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.info(`[AUTO-SCAN] scanProject returned in ${duration}s.`);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[AUTO-SCAN] Failed: ${msg}`);
        }
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        const startupLogger = Logger.get(process.cwd());
        this.logServerStartup(startupLogger);

        await this.tryAutoScan();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const mcpServer = new JavaClassAnalyzerMCPServer();

    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Promise rejection:', reason);
    });

    mcpServer.run().catch((error) => {
        console.error('Server startup failed:', error);
        process.exit(1);
    });
}
