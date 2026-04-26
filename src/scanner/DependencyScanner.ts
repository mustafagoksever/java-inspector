import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import fs from 'fs-extra';
import { projectCache } from '../cache/ProjectCache.js';
import { backgroundScanner } from './BackgroundScanner.js';
import { lazyResolver, ScoredClassEntry } from './LazyResolver.js';
import { getProjectCacheDir } from '../utils/cachePaths.js';
import { Logger } from '../utils/Logger.js';
import { CrossProcessLock } from '../utils/CrossProcessLock.js';

const execFileAsync = promisify(execFile);

export interface ScanResult {
    jarCount: number;
    classCount: number;
    sampleEntries: string[];
    status: 'complete' | 'in_progress';
    progress?: { processed: number; total: number };
    message?: string;
}

export class DependencyScanner {
    private static instance: DependencyScanner;
    private classpathPromises = new Map<string, Promise<string[]>>();
    private mavenCommand: string | null = null;
    // Track scan.lock release functions so we can release when scan completes
    private scanLockReleases = new Map<string, () => Promise<void>>();

    static getInstance(): DependencyScanner {
        if (!DependencyScanner.instance) {
            DependencyScanner.instance = new DependencyScanner();
        }
        return DependencyScanner.instance;
    }

    constructor() {
        if (DependencyScanner.instance) {
            return DependencyScanner.instance;
        }
        DependencyScanner.instance = this;
    }

    /**
     * Scan project dependencies.
     * If a complete index already exists, returns it immediately.
     * Otherwise starts a background scan and returns the current status.
     * Maven classpath resolution is non-blocking — it runs in the background
     * and the method returns immediately with status 'in_progress'.
     */
    async scanProject(
        projectPath: string,
        forceRefresh: boolean = false,
        onProgress?: (message: string, progress?: number, total?: number) => Promise<void>
    ): Promise<ScanResult> {
        const logger = Logger.get(projectPath);
        const isDebug = process.env.NODE_ENV === 'development';

        logger.info(`[SCAN] scanProject called. forceRefresh=${forceRefresh}`);

        if (forceRefresh) {
            logger.info('[SCAN] forceRefresh=true. Invalidating cache and breaking locks...');
            await projectCache.invalidate(projectPath);
            backgroundScanner.reset(projectPath);
            this.classpathPromises.delete(projectPath);
            // Release any stale scan lock held by this process
            const existingRelease = this.scanLockReleases.get(projectPath);
            if (existingRelease) {
                try { await existingRelease(); } catch { /* ignore */ }
                this.scanLockReleases.delete(projectPath);
            }
        }

        // Check for complete index
        if (!forceRefresh && await projectCache.isIndexComplete(projectPath)) {
            const index = await projectCache.getClassIndex(projectPath);
            if (index) {
                logger.info(`[SCAN] Using cached class index. ${index.classCount} classes, ${index.jarCount} JARs.`);
                await onProgress?.('Using cached class index', 100, 100);
                return {
                    jarCount: index.jarCount,
                    classCount: index.classCount,
                    sampleEntries: index.sampleEntries,
                    status: 'complete',
                };
            }
        }

        // Cross-process check: is another process currently scanning?
        const isLockedByOther = await CrossProcessLock.check(projectPath, 'scan');
        if (isLockedByOther) {
            logger.info('[SCAN] Another process is currently scanning this project.');
            const progress = await projectCache.getScanProgress(projectPath) ?? undefined;
            const progressText = progress
                ? `${progress.processed}/${progress.total} JARs processed`
                : 'scanning in progress';
            await onProgress?.(
                `Another process is scanning: ${progressText}`,
                progress ? Math.floor((progress.processed / progress.total) * 100) : 0,
                100
            );
            return {
                jarCount: progress?.total ?? 0,
                classCount: 0,
                sampleEntries: [],
                status: 'in_progress',
                progress,
                message: 'Another process is currently scanning this project. Please wait or call again later.',
            };
        }

        // Check if classpath resolution is already in progress (in-process)
        if (this.classpathPromises.has(projectPath)) {
            await onProgress?.('Maven classpath resolution in progress...', 5, 100);
            return {
                jarCount: 0,
                classCount: 0,
                sampleEntries: [],
                status: 'in_progress',
                message: 'Maven classpath is being resolved in the background. This may take a few minutes for large projects (e.g. Spring Boot). Call scan_dependencies again to check progress.',
            };
        }

        // Check if background scan is already running (in-process)
        if (backgroundScanner.isScanning(projectPath)) {
            const state = backgroundScanner.getState(projectPath);
            const progress = await projectCache.getScanProgress(projectPath) ?? undefined;
            await onProgress?.(
                `Background scan in progress: ${progress?.processed ?? 0}/${progress?.total ?? 0} JARs`,
                progress ? Math.floor((progress.processed / progress.total) * 100) : 0,
                100
            );
            return {
                jarCount: state?.total ?? 0,
                classCount: 0,
                sampleEntries: [],
                status: 'in_progress',
                progress,
            };
        }

        // Check if we already have classpath cached (scan may have finished or been interrupted)
        const cachedClasspath = await projectCache.getClasspath(projectPath);
        if (cachedClasspath && cachedClasspath.length > 0) {
            const pomHash = await projectCache.getPomHash(projectPath);
            const classpathHash = projectCache.getClasspathHash(cachedClasspath);
            // Start scan and hold the cross-process lock until it completes
            await this.acquireScanLockAndStart(projectPath, cachedClasspath, pomHash, classpathHash, onProgress);
            await onProgress?.(
                `Background scan started with ${cachedClasspath.length} JARs`,
                0,
                100
            );
            return {
                jarCount: cachedClasspath.length,
                classCount: 0,
                sampleEntries: [],
                status: 'in_progress',
                progress: { processed: 0, total: cachedClasspath.length },
            };
        }

        // Start classpath resolution in the background (non-blocking)
        await onProgress?.('Starting Maven classpath resolution in background...', 5, 100);
        this.resolveClasspathAndStartScan(projectPath, onProgress).catch((error) => {
            console.error('Background classpath resolution failed:', error);
        });

        return {
            jarCount: 0,
            classCount: 0,
            sampleEntries: [],
            status: 'in_progress',
            message: 'Maven classpath resolution started in the background. This may take a few minutes for large projects (e.g. Spring Boot). Call scan_dependencies again to check progress.',
        };
    }

    /**
     * Acquire the cross-process scan lock, start the background scan,
     * and release the lock when the scan finishes.
     */
    private async acquireScanLockAndStart(
        projectPath: string,
        jarPaths: string[],
        pomHash: string,
        classpathHash: string,
        onProgress?: (message: string, progress?: number, total?: number) => Promise<void>
    ): Promise<void> {
        const logger = Logger.get(projectPath);
        try {
            const release = await CrossProcessLock.acquire(projectPath, 'scan');
            this.scanLockReleases.set(projectPath, release);

            // Start background scan and release lock when done
            const scanPromise = backgroundScanner.start(
                projectPath, jarPaths, pomHash, classpathHash, onProgress
            );

            scanPromise
                .then(() => {
                    logger.info('[SCAN] Scan completed, releasing cross-process lock.');
                })
                .catch((err) => {
                    logger.error(`[SCAN] Scan failed: ${err instanceof Error ? err.message : String(err)}`);
                })
                .finally(async () => {
                    try { await release(); } catch { /* ignore */ }
                    this.scanLockReleases.delete(projectPath);
                });
        } catch (lockError) {
            logger.warn(`[SCAN] Could not acquire scan lock: ${lockError instanceof Error ? lockError.message : String(lockError)}`);
            // Fall back to starting scan without cross-process lock (best-effort)
            backgroundScanner.start(projectPath, jarPaths, pomHash, classpathHash, onProgress).catch(() => {});
        }
    }

    /**
     * Resolve Maven classpath in the background and start scanning.
     * This runs detached from the caller — errors are logged but not thrown.
     */
    private async resolveClasspathAndStartScan(
        projectPath: string,
        onProgress?: (message: string, progress?: number, total?: number) => Promise<void>
    ): Promise<void> {
        const logger = Logger.get(projectPath);
        const promise = this.getBuildClasspath(projectPath, onProgress);
        this.classpathPromises.set(projectPath, promise);

        try {
            const jarPaths = await promise;
            this.classpathPromises.delete(projectPath);

            if (jarPaths.length === 0) {
                logger.warn('[MAVEN] No dependency JARs found after classpath resolution.');
                return;
            }

            const pomHash = await projectCache.getPomHash(projectPath);
            const classpathHash = projectCache.getClasspathHash(jarPaths);
            await projectCache.saveClasspath(projectPath, jarPaths, pomHash);

            logger.info(`[MAVEN] Classpath resolved. ${jarPaths.length} JARs found. Starting background scan...`);
            await onProgress?.(`Classpath resolved: ${jarPaths.length} JARs. Starting background scan...`, 10, 100);
            await this.acquireScanLockAndStart(projectPath, jarPaths, pomHash, classpathHash, onProgress);
        } catch (error) {
            this.classpathPromises.delete(projectPath);
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[MAVEN] Classpath resolution failed: ${msg}`);
            await onProgress?.(`Maven classpath resolution failed: ${msg}`);
            throw error;
        }
    }

    /**
     * Use Maven to get the dependency classpath.
     */
    private async getBuildClasspath(
        projectPath: string,
        onProgress?: (message: string, progress?: number, total?: number) => Promise<void>
    ): Promise<string[]> {
        const logger = Logger.get(projectPath);
        const mavenCmd = await this.resolveMavenCommand(projectPath);
        const cacheDir = getProjectCacheDir(projectPath);
        await fs.ensureDir(cacheDir);
        const outputFile = path.join(cacheDir, 'maven-cp.txt');

        const isDebug = process.env.NODE_ENV === 'development';

        logger.info(`[MAVEN] Running: ${mavenCmd} dependency:build-classpath...`);
        logger.debug(`[MAVEN] Config: cwd=${projectPath}, timeout=300000ms, shell=${process.platform === 'win32'}, maxBuffer=1MB, outputFile=${outputFile}`);
        await onProgress?.(`Running Maven: ${mavenCmd} dependency:build-classpath...`, 5, 100);

        const start = performance.now();
        try {
            const { stdout, stderr } = await execFileAsync(
                mavenCmd,
                ['dependency:build-classpath', `-Dmdep.outputFile=${outputFile}`, '-q'],
                {
                    cwd: projectPath,
                    timeout: 300000, // 5 minutes for large projects (e.g. Spring Boot)
                    shell: process.platform === 'win32',
                    maxBuffer: 1024 * 1024, // 1MB buffer for error output
                }
            );

            const duration = ((performance.now() - start) / 1000).toFixed(2);
            logger.info(`[MAVEN] Classpath resolved in ${duration}s.`);

            if (isDebug) {
                if (stdout) logger.debug(`[MAVEN] stdout: ${stdout}`);
                if (stderr) logger.debug(`[MAVEN] stderr: ${stderr}`);
            }
        } catch (error: any) {
            const duration = ((performance.now() - start) / 1000).toFixed(2);
            let details = '';
            if (error.stdout) details += `\nstdout: ${error.stdout}`;
            if (error.stderr) details += `\nstderr: ${error.stderr}`;
            if (error.code) details += `\nexit code: ${error.code}`;
            logger.error(`[MAVEN] Command failed after ${duration}s: ${error.message}${details}`);
            throw new Error(`Maven command failed: ${error.message}${details}`);
        }

        if (!(await fs.pathExists(outputFile))) {
            throw new Error('Maven did not produce classpath output file');
        }

        const content = await fs.readFile(outputFile, 'utf-8');
        // Remove the temp file
        try {
            await fs.remove(outputFile);
        } catch {
            // ignore cleanup errors
        }

        // Classpath entries are separated by path.delimiter (: on Unix, ; on Windows)
        const jarPaths = content
            .trim()
            .split(path.delimiter)
            .map(p => p.trim())
            .filter(p => p.length > 0 && p.endsWith('.jar'));

        // Validate paths exist
        const validPaths: string[] = [];
        for (const jar of jarPaths) {
            if (await fs.pathExists(jar)) {
                validPaths.push(jar);
            } else {
                logger.warn(`[MAVEN] JAR not found, skipping: ${jar}`);
            }
        }

        logger.info(`[MAVEN] Validated ${validPaths.length}/${jarPaths.length} JAR paths.`);
        return validPaths;
    }

    /**
     * Check if Maven classpath resolution is currently in progress.
     */
    isResolvingClasspath(projectPath: string): boolean {
        return this.classpathPromises.has(projectPath);
    }

    /**
     * Find corresponding JAR package path by class name.
     * Uses cache + lazy on-demand scanning.
     */
    async findJarForClass(className: string, projectPath: string): Promise<string | null> {
        return lazyResolver.findJarForClass(className, projectPath);
    }

    /**
     * Search indexed classes with fuzzy matching.
     */
    async searchClasses(
        projectPath: string,
        query: string,
        limit: number = 20
    ): Promise<ScoredClassEntry[]> {
        return lazyResolver.searchClasses(projectPath, query, limit);
    }

    /**
     * Get all indexed class names.
     */
    async getAllClassNames(projectPath: string): Promise<string[]> {
        return lazyResolver.getAllClassNames(projectPath);
    }

    /**
     * Get current scan progress.
     */
    async getScanProgress(projectPath: string): Promise<{ processed: number; total: number } | null> {
        return projectCache.getScanProgress(projectPath);
    }

    /**
     * Check if the index is complete.
     */
    async isIndexComplete(projectPath: string): Promise<boolean> {
        return projectCache.isIndexComplete(projectPath);
    }

    /**
     * Get cached classpath for a project.
     */
    async getClasspath(projectPath: string): Promise<string[] | null> {
        return projectCache.getClasspath(projectPath);
    }

    /**
     * Resolve the Maven command to use.
     * Preference order:
     * 1. MAVEN_CMD env var (explicit override)
     * 2. mvnd (Maven Daemon) — auto-detected, ~2x faster on warm cache
     * 3. MAVEN_HOME/bin/mvn
     * 4. mvn (system PATH)
     */
    private async resolveMavenCommand(projectPath: string): Promise<string> {
        if (this.mavenCommand) return this.mavenCommand;

        const logger = Logger.get(projectPath);
        logger.info(`[MAVEN] Resolving Maven command... MAVEN_HOME=${process.env.MAVEN_HOME || '<not set>'}, MAVEN_CMD=${process.env.MAVEN_CMD || '<not set>'}`);

        // 1. Explicit override via env var
        if (process.env.MAVEN_CMD) {
            this.mavenCommand = process.env.MAVEN_CMD;
            logger.info(`[MAVEN] Using MAVEN_CMD override: ${this.mavenCommand}`);
            return this.mavenCommand;
        }

        // 2. Try mvnd (Maven Daemon) via PATH lookup (~50ms vs ~2-3s with --version)
        const mvndStart = performance.now();
        try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which';
            await execFileAsync(whichCmd, ['mvnd'], { timeout: 2000, shell: process.platform === 'win32' });
            const mvndDuration = (performance.now() - mvndStart).toFixed(0);
            this.mavenCommand = 'mvnd';
            logger.info(`[MAVEN] mvnd detected via ${whichCmd} in ${mvndDuration}ms. Selected: mvnd`);
            return 'mvnd';
        } catch {
            const mvndDuration = (performance.now() - mvndStart).toFixed(0);
            logger.info(`[MAVEN] mvnd not available (tried ${mvndDuration}ms). Falling back to mvn.`);
        }

        // 3. Standard Maven
        const mavenHome = process.env.MAVEN_HOME;
        this.mavenCommand = mavenHome ? path.join(mavenHome, 'bin', 'mvn') : 'mvn';
        logger.info(`[MAVEN] Selected: ${this.mavenCommand} (reason: ${mavenHome ? 'MAVEN_HOME' : 'PATH fallback'})`);
        return this.mavenCommand;
    }
}
