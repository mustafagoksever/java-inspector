import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import { readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as yauzl from 'yauzl';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { DependencyScanner } from '../scanner/DependencyScanner.js';
import { getDecompileCacheDir, getClassTempDir } from '../utils/cachePaths.js';
import { Logger } from '../utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

export class DecompilerService {
    private scanner: DependencyScanner;
    private cfrPath: string;

    constructor() {
        this.scanner = DependencyScanner.getInstance();
        this.cfrPath = '';
    }

    private async initializeCfrPath(logger?: Logger): Promise<void> {
        if (!this.cfrPath) {
            this.cfrPath = await this.findCfrJar(logger);
            if (!this.cfrPath) {
                throw new Error('CFR decompiler tool not found. Please download CFR jar to lib directory or set CFR_PATH environment variable');
            }
            logger?.info(`[DECOMPILE] CFR tool path: ${this.cfrPath}`);
            console.error(`CFR tool path: ${this.cfrPath}`);
        }
    }

    /**
     * Decompile specified Java class file
     */
    async decompileClass(className: string, projectPath: string, useCache: boolean = true, cfrPath?: string): Promise<string> {
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[DECOMPILE] Request: className=${className}, useCache=${useCache}, cfrPath=${cfrPath || 'auto'}`);

        try {
            // If external CFR path is specified, use external path
            if (cfrPath) {
                this.cfrPath = cfrPath;
                logger.info(`[DECOMPILE] Using external CFR: ${this.cfrPath}`);
            } else {
                await this.initializeCfrPath(logger);
                logger.info(`[DECOMPILE] CFR path: ${this.cfrPath}`);
            }

            // 1. Check cache
            const cachePath = this.getCachePath(className, projectPath);
            if (useCache && await fs.pathExists(cachePath)) {
                const source = await readFile(cachePath, 'utf-8');
                const duration = ((performance.now() - start) / 1000).toFixed(2);
                logger.info(`[DECOMPILE] Cache hit in ${duration}s. Source length: ${source.length}`);
                return source;
            }

            // 2. Find corresponding JAR package for class
            logger.debug(`[DECOMPILE] Finding JAR for class ${className}...`);
            const jarStart = performance.now();
            const jarPath = await Promise.race([
                this.scanner.findJarForClass(className, projectPath),
                new Promise<null>((_, reject) =>
                    setTimeout(() => reject(new Error('JAR package lookup timeout')), 20000)
                )
            ]);
            const jarDuration = ((performance.now() - jarStart) / 1000).toFixed(2);

            if (!jarPath) {
                throw new Error(`JAR package for class ${className} not found. Please ensure the class name is correct and belongs to a Maven dependency.`);
            }
            logger.debug(`[DECOMPILE] Found JAR in ${jarDuration}s: ${path.basename(jarPath)}`);

            // 3. Extract .class file from JAR package
            const extractStart = performance.now();
            const classFilePath = await this.extractClassFile(jarPath, className, projectPath);
            const extractDuration = ((performance.now() - extractStart) / 1000).toFixed(2);
            logger.debug(`[DECOMPILE] Extracted .class in ${extractDuration}s: ${path.basename(classFilePath)}`);

            // 4. Use CFR to decompile
            const cfrStart = performance.now();
            const sourceCode = await this.decompileWithCfr(classFilePath, logger);
            const cfrDuration = ((performance.now() - cfrStart) / 1000).toFixed(2);
            logger.debug(`[DECOMPILE] CFR completed in ${cfrDuration}s. Source length: ${sourceCode.length}`);

            // 5. Save to cache
            if (useCache) {
                await fs.ensureDir(path.dirname(cachePath));
                await fs.outputFile(cachePath, sourceCode, 'utf-8');
                logger.debug(`[DECOMPILE] Cached result: ${cachePath}`);
            }

            // 6. Clean up temporary .class file (always, since CFR only reads it)
            try {
                await fs.remove(classFilePath);
            } catch (cleanupError) {
                logger.warn(`[DECOMPILE] Failed to clean up temp file: ${cleanupError}`);
            }

            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.info(`[DECOMPILE] Complete in ${duration}s. Source length: ${sourceCode.length}`);
            return sourceCode;
        } catch (error) {
            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.error(`[DECOMPILE] Failed after ${duration}s: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Get cache file path
     */
    private getCachePath(className: string, projectPath: string): string {
        const packagePath = className.substring(0, className.lastIndexOf('.'));
        const simpleName = className.substring(className.lastIndexOf('.') + 1);
        const cacheDir = getDecompileCacheDir(projectPath);
        const packageDir = path.join(cacheDir, packagePath.replace(/\./g, path.sep));
        return path.join(packageDir, `${simpleName}.java`);
    }

    /**
     * Extract specified .class file from JAR package
     */
    private async extractClassFile(jarPath: string, className: string, projectPath: string): Promise<string> {
        const classFileName = className.replace(/\./g, '/') + '.class';
        const tempDir = getClassTempDir(projectPath);
        // Create directory structure by full package name path
        const packagePath = className.substring(0, className.lastIndexOf('.'));
        const packageDir = path.join(tempDir, packagePath.replace(/\./g, path.sep));
        const classFilePath = path.join(packageDir, `${className.substring(className.lastIndexOf('.') + 1)}.class`);

        await fs.ensureDir(packageDir);

        console.error(`Extracting class file from JAR package: ${jarPath} -> ${classFileName}`);

        return new Promise((resolve, reject) => {
            yauzl.open(jarPath, { lazyEntries: true }, (err: any, zipfile: any) => {
                if (err) {
                    reject(new Error(`Unable to open JAR package ${jarPath}: ${err.message}`));
                    return;
                }

                let found = false;
                zipfile.readEntry();

                const closeAndReject = (err: Error) => {
                    try {
                        zipfile.close();
                    } catch (e) {
                        // ignore close errors
                    }
                    reject(err);
                };

                zipfile.on('entry', (entry: any) => {
                    if (entry.fileName === classFileName) {
                        found = true;
                        zipfile.openReadStream(entry, (err: any, readStream: any) => {
                            if (err) {
                                closeAndReject(new Error(`Unable to read class file ${classFileName} from JAR package: ${err.message}`));
                                return;
                            }

                            const writeStream = createWriteStream(classFilePath);
                            readStream.pipe(writeStream);

                            writeStream.on('close', () => {
                                console.error(`Class file extracted successfully: ${classFilePath}`);
                                try {
                                    zipfile.close();
                                } catch (e) {
                                    // ignore close errors
                                }
                                resolve(classFilePath);
                            });

                            writeStream.on('error', (err: any) => {
                                closeAndReject(new Error(`Failed to write temporary file: ${err.message}`));
                            });
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });

                zipfile.on('end', () => {
                    if (!found) {
                        closeAndReject(new Error(`Class file ${classFileName} not found in JAR package ${jarPath}`));
                    }
                });

                zipfile.on('error', (err: any) => {
                    closeAndReject(new Error(`Failed to read JAR package: ${err.message}`));
                });
            });
        });
    }

    /**
     * Use CFR to decompile .class file
     */
    private async decompileWithCfr(classFilePath: string, logger?: Logger): Promise<string> {
        if (!this.cfrPath) {
            throw new Error('CFR decompiler tool not found, please ensure CFR jar is in classpath');
        }

        try {
            const javaCmd = this.getJavaCommand(logger);
            const cmdMsg = `Executing CFR: ${javaCmd} -jar "${this.cfrPath}" "${classFilePath}"`;
            logger?.debug(`[DECOMPILE] ${cmdMsg}`);
            console.error(cmdMsg);

            const { stdout, stderr } = await execFileAsync(
                javaCmd,
                ['-jar', this.cfrPath, classFilePath, '--silent', 'true'],
                {
                    timeout: 30000
                }
            );

            if (stderr && stderr.trim()) {
                logger?.warn(`[DECOMPILE] CFR stderr: ${stderr}`);
                console.warn('CFR warning:', stderr);
            }

            if (!stdout || stdout.trim() === '') {
                throw new Error('CFR decompilation returned empty result, possibly due to corrupted class file or incompatible CFR version');
            }

            return stdout;
        } catch (error) {
            logger?.error(`[DECOMPILE] CFR execution failed: ${error instanceof Error ? error.message : String(error)}`);
            console.error('CFR decompilation execution failed:', error);
            if (error instanceof Error && error.message.includes('timeout')) {
                throw new Error('CFR decompilation timeout, please check Java environment and CFR tool');
            }
            throw new Error(`CFR decompilation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get package root directory (works with npx, npm install -g, and local dev)
     */
    private getPackageRoot(): string {
        // When running from compiled dist/decompiler/DecompilerService.js
        // __dirname = dist/decompiler/, so we go up 3 levels to get package root
        const distDir = path.dirname(__dirname); // dist/
        return path.dirname(distDir); // package root
    }

    /**
     * Find CFR jar package path
     */
    private async findCfrJar(logger?: Logger): Promise<string> {
        // 1. Check CFR_PATH env var first (allows custom CFR version)
        if (process.env.CFR_PATH) {
            logger?.debug(`[DECOMPILE] CFR_PATH set: ${process.env.CFR_PATH}`);
            if (await fs.pathExists(process.env.CFR_PATH)) {
                logger?.debug(`[DECOMPILE] CFR_PATH resolved successfully.`);
                return process.env.CFR_PATH;
            }
            logger?.warn(`[DECOMPILE] CFR_PATH file does not exist: ${process.env.CFR_PATH}`);
        }

        // 2. Try bundled CFR at package root lib/ (works with npx and npm install)
        const bundledLibPath = path.join(this.getPackageRoot(), 'lib');
        logger?.debug(`[DECOMPILE] Checking bundled CFR at: ${bundledLibPath}`);
        if (await fs.pathExists(bundledLibPath)) {
            const files = await readdir(bundledLibPath);
            const cfrJar = files.find(file => /^cfr-.*\.jar$/.test(file));
            if (cfrJar) {
                logger?.debug(`[DECOMPILE] Bundled CFR found: ${cfrJar}`);
                return path.join(bundledLibPath, cfrJar);
            }
            logger?.debug(`[DECOMPILE] No cfr-*.jar in bundled lib. Files: ${files.join(', ')}`);
        }

        // 3. Try current working directory lib/ (for local development)
        const cwdLibPath = path.join(process.cwd(), 'lib');
        logger?.debug(`[DECOMPILE] Checking local CFR at: ${cwdLibPath}`);
        if (await fs.pathExists(cwdLibPath)) {
            const files = await readdir(cwdLibPath);
            const cfrJar = files.find(file => /^cfr-.*\.jar$/.test(file));
            if (cfrJar) {
                logger?.debug(`[DECOMPILE] Local CFR found: ${cfrJar}`);
                return path.join(cwdLibPath, cfrJar);
            }
            logger?.debug(`[DECOMPILE] No cfr-*.jar in local lib. Files: ${files.join(', ')}`);
        }

        // 4. Try CLASSPATH (legacy support)
        const classpath = process.env.CLASSPATH || '';
        logger?.debug(`[DECOMPILE] Checking CLASSPATH for CFR. Entries: ${classpath.split(path.delimiter).length}`);
        const classpathEntries = classpath.split(path.delimiter);
        for (const entry of classpathEntries) {
            if (entry.includes('cfr') && entry.endsWith('.jar') && await fs.pathExists(entry)) {
                logger?.debug(`[DECOMPILE] CFR found in CLASSPATH: ${entry}`);
                return entry;
            }
        }

        logger?.error(`[DECOMPILE] CFR jar not found in any location.`);
        return '';
    }

    /**
     * Batch decompile multiple classes
     */
    async decompileClasses(classNames: string[], projectPath: string, useCache: boolean = true, cfrPath?: string): Promise<Map<string, string>> {
        const results = new Map<string, string>();

        for (const className of classNames) {
            try {
                const sourceCode = await this.decompileClass(className, projectPath, useCache, cfrPath);
                results.set(className, sourceCode);
            } catch (error) {
                console.warn(`Failed to decompile class ${className}: ${error}`);
                results.set(className, `// Decompilation failed: ${error}`);
            }
        }

        return results;
    }


    /**
     * Get Java command path
     */
    private getJavaCommand(logger?: Logger): string {
        const javaHome = process.env.JAVA_HOME;
        if (javaHome) {
            const javaCmd = process.platform === 'win32' ? 'java.exe' : 'java';
            const fullPath = path.join(javaHome, 'bin', javaCmd);
            logger?.debug(`[DECOMPILE] Using Java from JAVA_HOME: ${fullPath}`);
            return fullPath;
        }
        logger?.debug(`[DECOMPILE] JAVA_HOME not set, falling back to 'java' in PATH`);
        return 'java'; // Fallback to java in PATH
    }
}
