import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DependencyScanner } from '../scanner/DependencyScanner.js';
import { Logger } from '../utils/Logger.js';

const execFileAsync = promisify(execFile);

export interface ClassField {
    name: string;
    type: string;
    modifiers: string[];
}

export interface ClassMethod {
    name: string;
    returnType: string;
    parameters: string[];
    modifiers: string[];
}

export interface ClassAnalysis {
    className: string;
    packageName: string;
    modifiers: string[];
    superClass?: string;
    interfaces: string[];
    fields: ClassField[];
    methods: ClassMethod[];
}

export interface HierarchyEntry {
    className: string;
    level: number;
    resolved: boolean;
}

export class JavaClassAnalyzer {
    private scanner: DependencyScanner;

    constructor() {
        this.scanner = DependencyScanner.getInstance();
    }

    /**
     * Analyze Java class structure information
     * @param verbose Use javap -v (default true). Set to false for lightweight superclass/interface checks.
     */
    async analyzeClass(className: string, projectPath: string, verbose: boolean = true): Promise<ClassAnalysis> {
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[JAVAP] Analyzing class: ${className}`);

        try {
            // 1. Get class file path
            const jarPath = await this.scanner.findJarForClass(className, projectPath);
            if (!jarPath) {
                const suggestion = className.includes('.')
                    ? `Ensure the class name is correct and belongs to a Maven dependency. You may need to run scan_dependencies first.`
                    : `Class name looks like a simple name. Try using the fully qualified name (e.g. com.example.${className}).`;
                throw new Error(`JAR package for class ${className} not found. ${suggestion}`);
            }
            logger.debug(`[JAVAP] Found in JAR: ${path.basename(jarPath)}`);

            // 2. Use javap to analyze class in JAR package directly
            const analysis = await this.analyzeClassWithJavap(jarPath, className, verbose, logger);

            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.info(`[JAVAP] Analysis complete in ${duration}s. Fields: ${analysis.fields.length}, Methods: ${analysis.methods.length}`);
            return analysis;
        } catch (error) {
            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.error(`[JAVAP] Failed after ${duration}s: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Run async tasks with a concurrency limit.
     */
    private async runWithConcurrencyLimit<T>(
        items: T[],
        concurrency: number,
        fn: (item: T) => Promise<void>
    ): Promise<void> {
        let index = 0;
        const workers: Promise<void>[] = [];

        const worker = async (): Promise<void> => {
            while (index < items.length) {
                const currentIndex = index++;
                try {
                    await fn(items[currentIndex]);
                } catch {
                    // fn is expected to handle its own errors; swallow here
                }
            }
        };

        for (let i = 0; i < Math.min(concurrency, items.length); i++) {
            workers.push(worker());
        }

        await Promise.all(workers);
    }

    /**
     * Use javap tool to analyze class structure in JAR package
     */
    private async analyzeClassWithJavap(jarPath: string, className: string, verbose: boolean = true, logger?: Logger): Promise<ClassAnalysis> {
        try {
            const javapCmd = this.getJavapCommand(logger);
            const args = verbose
                ? ['-v', '-cp', jarPath, className]
                : ['-cp', jarPath, className];

            logger?.debug(`[JAVAP] Running: ${javapCmd} ${args.join(' ')}`);
            logger?.debug(`[JAVAP] Config: timeout=10000ms, maxBuffer=10MB`);
            const javapStart = performance.now();
            const { stdout, stderr } = await execFileAsync(
                javapCmd,
                args,
                { timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
            );
            const javapDuration = ((performance.now() - javapStart) / 1000).toFixed(2);
            logger?.debug(`[JAVAP] javap completed in ${javapDuration}s. Output length: ${stdout.length} chars.`);

            if (stderr && stderr.trim()) {
                logger?.warn(`[JAVAP] stderr for ${className}: ${stderr}`);
            }

            return this.parseJavapOutput(stdout, className);
        } catch (error: any) {
            logger?.error(`[JAVAP] javap analysis failed: ${error.message || error}`);
            console.error('javap analysis failed:', error);
            let details = error.message || '';
            if (error.stderr) {
                details += `\nstderr: ${error.stderr}`;
            }
            throw new Error(`javap analysis failed: ${details}`);
        }
    }

    /**
     * Parse javap output
    */
    private parseJavapOutput(output: string, className: string): ClassAnalysis {
        const lines = output.split('\n');
        const analysis: ClassAnalysis = {
            className: className.split('.').pop() || className,
            packageName: '',
            modifiers: [],
            superClass: undefined,
            interfaces: [],
            fields: [],
            methods: []
        };

        let currentMethod: any = null;
        let inLocalVariableTable = false;
        let methodParameters: { [key: string]: string } = {};

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // Parse class declaration
            if (trimmedLine.startsWith('public class') || trimmedLine.startsWith('public interface') ||
                trimmedLine.startsWith('public enum')) {
                this.parseClassDeclaration(trimmedLine, analysis);
                continue;
            }

            // Parse method declaration
            if (trimmedLine.startsWith('public ') && trimmedLine.includes('(') && trimmedLine.includes(')')) {
                currentMethod = this.parseMethodFromJavap(trimmedLine);
                if (currentMethod) {
                    analysis.methods.push(currentMethod);
                    methodParameters = {};
                }
                continue;
            }

            // Detect LocalVariableTable start
            if (trimmedLine === 'LocalVariableTable:') {
                inLocalVariableTable = true;
                continue;
            }

            // Parse parameter names in LocalVariableTable
            if (inLocalVariableTable && currentMethod) {
                if (trimmedLine.startsWith('Start') || trimmedLine.startsWith('Slot')) {
                    continue; // Skip header
                }

                if (trimmedLine === '') {
                    // LocalVariableTable ended, immediately update current method's parameter names
                    if (Object.keys(methodParameters).length > 0) {
                        const updatedParams: string[] = [];
                        for (let j = 0; j < currentMethod.parameters.length; j++) {
                            const paramType = currentMethod.parameters[j];
                            const paramName = methodParameters[j] || `param${j + 1}`;
                            updatedParams.push(`${paramType} ${paramName}`);
                        }
                        currentMethod.parameters = updatedParams;
                    }
                    inLocalVariableTable = false;
                    methodParameters = {};
                    continue;
                }

                // Parse parameter line: "0       6     0  file   Ljava/io/File;"
                const paramMatch = trimmedLine.match(/^\s*\d+\s+\d+\s+(\d+)\s+(\w+)\s+(.+)$/);
                if (paramMatch) {
                    const slot = parseInt(paramMatch[1]);
                    const paramName = paramMatch[2];
                    const paramType = paramMatch[3];

                    // Only handle parameters (slot >= 0, but exclude local variables)
                    // Parameters are usually in the first few slots, local variables come after
                    if (slot >= 0 && slot < currentMethod.parameters.length) {
                        methodParameters[slot] = paramName;
                    }
                }
            }

            // Detect method end - when next method or class end is encountered
            if (currentMethod && (
                (trimmedLine.startsWith('public ') && trimmedLine.includes('(') && trimmedLine.includes(')')) ||
                trimmedLine.startsWith('}') ||
                trimmedLine.startsWith('SourceFile:')
            )) {
                // Update method's parameter names
                if (Object.keys(methodParameters).length > 0) {
                    const updatedParams: string[] = [];
                    for (let j = 0; j < currentMethod.parameters.length; j++) {
                        const paramType = currentMethod.parameters[j];
                        const paramName = methodParameters[j] || `param${j + 1}`;
                        updatedParams.push(`${paramType} ${paramName}`);
                    }
                    currentMethod.parameters = updatedParams;
                }
                currentMethod = null;
                inLocalVariableTable = false;
                methodParameters = {};
            }
        }

        return analysis;
    }

    /**
     * Parse class declaration
     */
    private parseClassDeclaration(line: string, analysis: ClassAnalysis): void {
        // Extract modifiers
        const modifiers = line.match(/\b(public|private|protected|static|final|abstract|strictfp)\b/g) || [];
        analysis.modifiers = modifiers;

        // Extract package name (inferred from class name)
        const classMatch = line.match(/(?:public\s+)?(?:class|interface|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$.]*)/);
        if (classMatch) {
            const fullClassName = classMatch[1];
            const parts = fullClassName.split('.');
            if (parts.length > 1) {
                analysis.packageName = parts.slice(0, -1).join('.');
                analysis.className = parts[parts.length - 1];
            }
        }

        // Extract superclass
        const extendsMatch = line.match(/extends\s+([a-zA-Z_$][a-zA-Z0-9_$.]*)/);
        if (extendsMatch) {
            analysis.superClass = extendsMatch[1];
        }

        // Extract interfaces
        const implementsMatch = line.match(/implements\s+([^{]+)/);
        if (implementsMatch) {
            const interfaces = implementsMatch[1]
                .split(',')
                .map(iface => iface.trim())
                .filter(iface => iface);
            analysis.interfaces = interfaces;
        }
    }

    /**
     * Parse method from javap output
     */
    private parseMethodFromJavap(line: string): ClassMethod | null {
        try {
            const trimmedLine = line.trim();

// Extract modifiers
            const modifiers: string[] = [];
            let startIndex = 0;
            const modifierWords = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native'];

            // Handle multiple modifiers
            let remainingLine = trimmedLine;
            while (true) {
                let foundModifier = false;
                for (const modifier of modifierWords) {
                    if (remainingLine.startsWith(modifier + ' ')) {
                        modifiers.push(modifier);
                        remainingLine = remainingLine.substring(modifier.length + 1);
                        startIndex += modifier.length + 1;
                        foundModifier = true;
                        break;
                    }
                }
                if (!foundModifier) {
                    break;
                }
            }

            // Find method name and parameters part
            const parenIndex = trimmedLine.indexOf('(');
            if (parenIndex === -1) return null;

            const closeParenIndex = trimmedLine.indexOf(')', parenIndex);
            if (closeParenIndex === -1) return null;

            // Extract return type and method name
            const beforeParen = trimmedLine.substring(startIndex, parenIndex).trim();
            const lastSpaceIndex = beforeParen.lastIndexOf(' ');
            if (lastSpaceIndex === -1) return null;

            const returnType = beforeParen.substring(0, lastSpaceIndex).trim();
            const methodName = beforeParen.substring(lastSpaceIndex + 1).trim();

            // Extract parameters
            const paramsStr = trimmedLine.substring(parenIndex + 1, closeParenIndex).trim();
            const parameters: string[] = [];

            if (paramsStr) {
                // Handle parameters, need to consider generics and nested types
                const paramParts = this.splitParameters(paramsStr);
                for (const param of paramParts) {
                    const trimmedParam = param.trim();
                    if (trimmedParam) {
                        parameters.push(trimmedParam);
                    }
                }
            }

            return {
                name: methodName,
                returnType,
                parameters,
                modifiers
            };
        } catch (error) {
            console.error('Failed to parse method:', line, error);
            return null;
        }
    }

    /**
     * Smart parameter splitting, handling generics and nested types
     */
    private splitParameters(paramsStr: string): string[] {
        const params: string[] = [];
        let current = '';
        let angleBracketCount = 0;

        for (let i = 0; i < paramsStr.length; i++) {
            const char = paramsStr[i];

            if (char === '<') {
                angleBracketCount++;
            } else if (char === '>') {
                angleBracketCount--;
            } else if (char === ',' && angleBracketCount === 0) {
                params.push(current.trim());
                current = '';
                continue;
            }

            current += char;
        }

        if (current.trim()) {
            params.push(current.trim());
        }

        return params;
    }


    /**
     * Get javap command path
     */
    private getJavapCommand(logger?: Logger): string {
        const javaHome = process.env.JAVA_HOME;
        if (javaHome) {
            const javapCmd = process.platform === 'win32' ? 'javap.exe' : 'javap';
            const fullPath = path.join(javaHome, 'bin', javapCmd);
            logger?.debug(`[JAVAP] Using javap from JAVA_HOME: ${fullPath}`);
            return fullPath;
        }
        logger?.debug(`[JAVAP] JAVA_HOME not set, falling back to 'javap' in PATH`);
        return 'javap';
    }

    /**
     * Get class inheritance hierarchy
     */
    async getInheritanceHierarchy(className: string, projectPath: string): Promise<HierarchyEntry[]> {
        const hierarchy: HierarchyEntry[] = [];
        let currentName = className;
        let level = 0;

        while (currentName) {
            let resolved = false;
            let superClass: string | undefined;

            try {
                const analysis = await this.analyzeClass(currentName, projectPath, false);
                resolved = true;
                superClass = analysis.superClass;
            } catch {
                // Class not found in indexed dependencies
                resolved = false;
            }

            hierarchy.unshift({ className: currentName, level: 0, resolved });

            if (!superClass) {
                break;
            }
            currentName = superClass;
            level++;
        }

        // Re-assign levels so root is 0
        hierarchy.forEach((entry, idx) => {
            entry.level = idx;
        });

        return hierarchy;
    }

}
