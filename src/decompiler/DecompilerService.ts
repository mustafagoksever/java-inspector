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

const __dfFilename = fileURLToPath(import.meta.url);
const __dfDirname = path.dirname(__dfFilename);

const execFileAsync = promisify(execFile);

export class DecompilerService {
    private scanner: DependencyScanner;

    constructor() {
        this.scanner = DependencyScanner.getInstance();
    }

    private async resolveDecompilerPath(externalDecompilerPath?: string, logger?: Logger): Promise<string> {
        if (externalDecompilerPath) {
            logger?.info(`[DECOMPILE] Using external decompiler: ${externalDecompilerPath}`);
            return externalDecompilerPath;
        }

        const decompilerPath = await this.findVineflowerJar(logger);
        if (!decompilerPath) {
            throw new Error('Vineflower decompiler tool not found. Please download Vineflower jar to lib directory or set DECOMPILER_PATH environment variable');
        }
        logger?.info(`[DECOMPILE] Vineflower tool path: ${decompilerPath}`);
        return decompilerPath;
    }

    /**
     * Decompile specified Java class file
     */
    async decompileClass(className: string, projectPath: string, useCache: boolean = true, externalDecompilerPath?: string): Promise<string> {
        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info(`[DECOMPILE] Request: className=${className}, useCache=${useCache}, decompilerPath=${externalDecompilerPath || 'auto'}`);

        try {
            // Resolve the decompiler path for this specific request
            const activeDecompilerPath = await this.resolveDecompilerPath(externalDecompilerPath, logger);

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

            // 4. Use Vineflower to decompile
            const decompStart = performance.now();
            const sourceCode = await this.decompileWithVineflower(classFilePath, className, projectPath, activeDecompilerPath, logger);
            const decompDuration = ((performance.now() - decompStart) / 1000).toFixed(2);
            logger.debug(`[DECOMPILE] Vineflower completed in ${decompDuration}s. Source length: ${sourceCode.length}`);

            // 5. Save to cache
            if (useCache) {
                await fs.ensureDir(path.dirname(cachePath));
                await fs.outputFile(cachePath, sourceCode, 'utf-8');
                logger.debug(`[DECOMPILE] Cached result: ${cachePath}`);
            }

            // 6. Clean up temporary .class file (always, since decompiler only reads it)
            try {
                await fs.remove(classFilePath);
            } catch (cleanupError) {
                logger.warn(`[DECOMPILE] Failed to clean up temp class file: ${cleanupError}`);
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
     * Use Vineflower to decompile .class file.
     * Vineflower writes output to a directory, so we create a temporary
     * output folder, run the decompiler, read the generated .java file,
     * and clean up afterwards.
     */
    private async decompileWithVineflower(classFilePath: string, className: string, projectPath: string, decompilerPath: string, logger?: Logger): Promise<string> {
        if (!decompilerPath) {
            throw new Error('Vineflower decompiler tool not found, please ensure Vineflower jar is in classpath');
        }

        const outputDir = path.join(getClassTempDir(projectPath), `vine-out-${Date.now()}`);
        await fs.ensureDir(outputDir);

        try {
            const javaCmd = this.getJavaCommand(logger);
            const cmdMsg = `Executing Vineflower: ${javaCmd} -jar "${decompilerPath}" "${classFilePath}" "${outputDir}"`;
            logger?.debug(`[DECOMPILE] ${cmdMsg}`);
            console.error(cmdMsg);

            const { stdout, stderr } = await execFileAsync(
                javaCmd,
                ['-jar', decompilerPath, classFilePath, outputDir],
                {
                    timeout: 30000
                }
            );

            if (stderr && stderr.trim()) {
                // Vineflower logs INFO/WARN to stderr; only surface real errors
                const errorLines = stderr.split('\n').filter((line: string) =>
                    line.toLowerCase().includes('error') || line.toLowerCase().includes('exception')
                );
                if (errorLines.length > 0) {
                    logger?.warn(`[DECOMPILE] Vineflower stderr errors: ${errorLines.join('\n')}`);
                } else {
                    logger?.debug(`[DECOMPILE] Vineflower stderr: ${stderr.substring(0, 500)}`);
                }
            }

            // Vineflower writes <outputDir>/<SimpleClassName>.java for single-class decompilation
            const simpleName = className.substring(className.lastIndexOf('.') + 1);
            const outputFilePath = path.join(outputDir, `${simpleName}.java`);

            if (!(await fs.pathExists(outputFilePath))) {
                throw new Error(`Vineflower did not produce expected output file: ${outputFilePath}. stdout: ${stdout || '(empty)'}`);
            }

            const sourceCode = await readFile(outputFilePath, 'utf-8');

            if (!sourceCode || sourceCode.trim() === '') {
                throw new Error('Vineflower decompilation returned empty result, possibly due to corrupted class file or incompatible decompiler version');
            }

            return sourceCode;
        } catch (error) {
            logger?.error(`[DECOMPILE] Vineflower execution failed: ${error instanceof Error ? error.message : String(error)}`);
            console.error('Vineflower decompilation execution failed:', error);
            if (error instanceof Error && error.message.includes('timeout')) {
                throw new Error('Vineflower decompilation timeout, please check Java environment and decompiler tool');
            }
            throw new Error(`Vineflower decompilation failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // Always clean up temporary output directory
            try {
                await fs.remove(outputDir);
            } catch (cleanupError) {
                logger?.warn(`[DECOMPILE] Failed to clean up temp output dir: ${cleanupError}`);
            }
        }
    }

    /**
     * Get package root directory (works with npx, npm install -g, and local dev)
     */
    private getPackageRoot(): string {
        // When running from compiled dist/decompiler/DecompilerService.js
        // __dfDirname = dist/decompiler/, so we go up 3 levels to get package root
        const distDir = path.dirname(__dfDirname); // dist/
        return path.dirname(distDir); // package root
    }

    /**
     * Find Vineflower jar package path
     */
    private async findVineflowerJar(logger?: Logger): Promise<string> {
        // 1. Check DECOMPILER_PATH env var first (allows custom version)
        if (process.env.DECOMPILER_PATH) {
            logger?.debug(`[DECOMPILE] DECOMPILER_PATH set: ${process.env.DECOMPILER_PATH}`);
            if (await fs.pathExists(process.env.DECOMPILER_PATH)) {
                logger?.debug(`[DECOMPILE] DECOMPILER_PATH resolved successfully.`);
                return process.env.DECOMPILER_PATH;
            }
            logger?.warn(`[DECOMPILE] DECOMPILER_PATH file does not exist: ${process.env.DECOMPILER_PATH}`);
        }

        // 2. Try bundled Vineflower at package root lib/ (works with npx and npm install)
        const bundledLibPath = path.join(this.getPackageRoot(), 'lib');
        logger?.debug(`[DECOMPILE] Checking bundled Vineflower at: ${bundledLibPath}`);
        if (await fs.pathExists(bundledLibPath)) {
            const files = await readdir(bundledLibPath);
            const vineflowerJar = files.find(file => /^vineflower-.*\.jar$/.test(file));
            if (vineflowerJar) {
                logger?.debug(`[DECOMPILE] Bundled Vineflower found: ${vineflowerJar}`);
                return path.join(bundledLibPath, vineflowerJar);
            }
            logger?.debug(`[DECOMPILE] No vineflower-*.jar in bundled lib. Files: ${files.join(', ')}`);
        }

        // 3. Try current working directory lib/ (for local development)
        const cwdLibPath = path.join(process.cwd(), 'lib');
        logger?.debug(`[DECOMPILE] Checking local Vineflower at: ${cwdLibPath}`);
        if (await fs.pathExists(cwdLibPath)) {
            const files = await readdir(cwdLibPath);
            const vineflowerJar = files.find(file => /^vineflower-.*\.jar$/.test(file));
            if (vineflowerJar) {
                logger?.debug(`[DECOMPILE] Local Vineflower found: ${vineflowerJar}`);
                return path.join(cwdLibPath, vineflowerJar);
            }
            logger?.debug(`[DECOMPILE] No vineflower-*.jar in local lib. Files: ${files.join(', ')}`);
        }

        logger?.error(`[DECOMPILE] Vineflower jar not found in any location.`);
        return '';
    }

    /**
     * Batch decompile multiple classes
     */
    async decompileClasses(classNames: string[], projectPath: string, useCache: boolean = true, externalDecompilerPath?: string): Promise<Map<string, string>> {
        const results = new Map<string, string>();

        for (const className of classNames) {
            try {
                const sourceCode = await this.decompileClass(className, projectPath, useCache, externalDecompilerPath);
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
