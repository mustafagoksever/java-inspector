import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import fs from 'fs-extra';
import { projectCache } from '../cache/ProjectCache.js';
import { backgroundScanner } from './BackgroundScanner.js';
import { lazyResolver, ScoredClassEntry } from './LazyResolver.js';
import { getProjectCacheDir } from '../utils/cachePaths.js';
import { Logger } from '../utils/Logger.js';
import { CrossProcessLock } from '../utils/CrossProcessLock.js';
import { buildToolOf } from './ProjectDiscovery.js';

const execFileAsync = promisify(execFile);

export interface ScanResult {
    jarCount: number;
    classCount: number;
    sampleEntries: string[];
    status: 'complete' | 'in_progress';
    progress?: { processed: number; total: number };
    message?: string;
}

export interface DependencyNode {
    groupId: string;
    artifactId: string;
    version: string;
    type: string;
    classifier?: string;
    scope?: string;
    optional?: boolean;
    /** 1 = declared in the module's pom (direct), >1 = transitive. */
    depth: number;
    /** groupId:artifactId of the dependency that pulled this one in (direct dependencies: the module). */
    via?: string;
}

export interface ModuleDependencies {
    module: string;
    dependencies: DependencyNode[];
}

/** Parse the text output of `mvn dependency:tree -DoutputFile=...` (one module per file). */
export function parseDependencyTree(text: string): ModuleDependencies | null {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) return null;
    const parse = (token: string) => {
        const parts = token.split(':');
        if (parts.length < 4) return null;
        const [groupId, artifactId, type] = parts;
        if (parts.length === 4) return { groupId, artifactId, type, version: parts[3] };
        if (parts.length === 5) return { groupId, artifactId, type, version: parts[3], scope: parts[4] };
        return { groupId, artifactId, type, classifier: parts[3], version: parts[4], scope: parts[5] };
    };
    const root = parse(lines[0].trim().split(/\s+/)[0]);
    if (!root) return null;
    const module = `${root.groupId}:${root.artifactId}:${root.version}`;
    const stack: string[] = [`${root.groupId}:${root.artifactId}`];
    const dependencies: DependencyNode[] = [];
    for (const line of lines.slice(1)) {
        const prefix = line.match(/^[| +\\-]*/)?.[0] ?? '';
        const depth = Math.max(1, Math.round(prefix.length / 3));
        const body = line.substring(prefix.length).trim();
        const node = parse(body.split(/\s+/)[0]);
        if (!node) continue;
        stack.length = depth;
        dependencies.push({ ...node, depth, via: stack[depth - 1], ...(/\(optional\)/.test(body) ? { optional: true } : {}) });
        stack[depth] = `${node.groupId}:${node.artifactId}`;
    }
    return { module, dependencies };
}

const GRADLE_INIT_SCRIPT = `
allprojects { p ->
    p.tasks.register('javaInspectorClasspath') {
        doLast {
            def outDir = new File(System.getProperty('javaInspector.out'))
            def files = new LinkedHashSet<File>()
            ['compileClasspath', 'runtimeClasspath', 'testCompileClasspath', 'testRuntimeClasspath'].each { name ->
                def conf = p.configurations.findByName(name)
                if (conf != null && conf.canBeResolved) {
                    try {
                        files.addAll(conf.incoming.artifactView { lenient = true }.files.files)
                    } catch (Exception e) {
                        p.logger.warn("java-inspector: could not resolve " + p.path + ":" + name + ": " + e.message)
                    }
                }
            }
            def safe = p.path.replaceAll('[^A-Za-z0-9_.-]', '_')
            new File(outDir, "cp-" + (safe ?: 'root') + ".txt").text = files.collect { it.absolutePath }.join('\\n')
        }
    }
}
`;

export class DependencyScanner {
    /** Projects whose last classpath came from recoverReactorClasspath with JARs missing. */
    private partialClasspaths = new Set<string>();
    private static instance: DependencyScanner;
    private classpathPromises = new Map<string, Promise<string[]>>();
    private mavenCommand: string | null = null;
    private scanErrors = new Map<string, string>();
    private activeClasspathResolutions = 0;
    private classpathResolutionQueue: Array<() => void> = [];
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
            this.scanErrors.delete(projectPath);
            // Release any stale scan lock held by this process
            const existingRelease = this.scanLockReleases.get(projectPath);
            if (existingRelease) {
                try { await existingRelease(); } catch { /* ignore */ }
                this.scanLockReleases.delete(projectPath);
            }
        }

        // Check for stored scan errors
        const storedError = this.scanErrors.get(projectPath);
        if (storedError) {
            this.scanErrors.delete(projectPath);
            return {
                jarCount: 0,
                classCount: 0,
                sampleEntries: [],
                status: 'in_progress' as const,
                message: `Previous scan failed: ${storedError}. Call scan_project with forceRefresh=true to retry.`,
            };
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

        // Check if classpath resolution is already in progress (in-process)
        if (this.classpathPromises.has(projectPath)) {
            await onProgress?.('Maven classpath resolution in progress...', 5, 100);
            return {
                jarCount: 0,
                classCount: 0,
                sampleEntries: [],
                status: 'in_progress',
                message: 'Maven classpath is being resolved in the background. This may take a few minutes for large projects (e.g. Spring Boot). Call scan_project again to check progress; other tools already work on the partial index.',
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
            const msg = error instanceof Error ? error.message : String(error);
            this.scanErrors.set(projectPath, msg);
            console.error('Background classpath resolution failed:', error);
        });

        return {
            jarCount: 0,
            classCount: 0,
            sampleEntries: [],
            status: 'in_progress',
            message: 'Maven classpath resolution started in the background. This may take a few minutes for large projects (e.g. Spring Boot). Call scan_project again to check progress; other tools already work on the partial index.',
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
                    const msg = err instanceof Error ? err.message : String(err);
                    this.scanErrors.set(projectPath, msg);
                    logger.error(`[SCAN] Scan failed: ${msg}`);
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
        const promise = this.withClasspathResolutionSlot(() => this.getBuildClasspath(projectPath, onProgress));
        this.classpathPromises.set(projectPath, promise);

        try {
            const jarPaths = await promise;
            this.classpathPromises.delete(projectPath);

            if (jarPaths.length === 0) {
                logger.warn('[MAVEN] No dependency JARs found after classpath resolution.');
                const pomHash = await projectCache.getPomHash(projectPath);
                const classpathHash = projectCache.getClasspathHash([]);
                await projectCache.saveClasspath(projectPath, [], pomHash);
                await projectCache.saveClassIndex(projectPath, {
                    jarCount: 0,
                    classCount: 0,
                    sampleEntries: [],
                }, pomHash, classpathHash);
                return;
            }

            const pomHash = await projectCache.getPomHash(projectPath);
            const classpathHash = projectCache.getClasspathHash(jarPaths);
            const partial = this.partialClasspaths.delete(projectPath);
            await projectCache.saveClasspath(projectPath, jarPaths, pomHash, partial);
            if (partial) logger.warn('[MAVEN] Classpath is partial (some dependencies are not in the local repository); it will be resolved again in 10 minutes.');

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
        if (await buildToolOf(projectPath) === 'gradle') return this.getGradleClasspath(projectPath, onProgress);
        const logger = Logger.get(projectPath);
        const mavenCmd = await this.resolveMavenCommand(projectPath);
        const cacheDir = getProjectCacheDir(projectPath);
        await fs.ensureDir(cacheDir);
        // One output file per reactor module. A single shared -Dmdep.outputFile is overwritten by every
        // module of a multi-module build (only the last module would survive), and -Dmdep.appendOutput
        // is not reliable across plugin versions. Maven interpolates ${project.*} in the CLI property.
        const outputDir = path.join(cacheDir, 'maven-cp');
        await fs.remove(outputDir).catch(() => {});
        await fs.ensureDir(outputDir);
        const outputFile = path.join(outputDir, 'cp-${project.groupId}__${project.artifactId}.txt');

        const isDebug = process.env.NODE_ENV === 'development';

        logger.info(`[MAVEN] Running: ${mavenCmd} dependency:build-classpath...`);
        logger.debug(`[MAVEN] Config: cwd=${projectPath}, timeout=300000ms, shell=${process.platform === 'win32'}, maxBuffer=1MB, outputFile=${outputFile}`);
        await onProgress?.(`Running Maven: ${mavenCmd} dependency:build-classpath...`, 5, 100);

        const start = performance.now();
        let recovered: string[] | null = null;
        try {
            const { stdout, stderr } = await execFileAsync(
                mavenCmd,
                // -B: never block on interactive prompts.
                ['-B', '-q', 'dependency:build-classpath', `-Dmdep.outputFile=${outputFile}`],
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
            recovered = await this.recoverReactorClasspath(projectPath, mavenCmd, outputFile, details);
            if (!recovered) throw new Error(`Maven command failed: ${error.message}${details}`);
        }

        const outputFiles = (await fs.readdir(outputDir)).filter(name => name.endsWith('.txt')).sort();
        if (outputFiles.length === 0 && !recovered?.length) {
            throw new Error('Maven did not produce classpath output file');
        }
        const contents: string[] = [];
        for (const name of outputFiles) contents.push(await fs.readFile(path.join(outputDir, name), 'utf-8'));
        await fs.remove(outputDir).catch(() => {});

        // Classpath entries are separated by path.delimiter (: on Unix, ; on Windows); the same JAR
        // usually appears in several modules.
        const jarPaths = [...new Set(contents
            .flatMap(content => content.split(/\r?\n/))
            .flatMap(line => line.split(path.delimiter))
            .map(p => p.trim())
            .filter(p => p.length > 0 && p.endsWith('.jar'))
            .concat(recovered ?? []))];
        logger.info(`[MAVEN] Read classpath of ${outputFiles.length} module(s).`);

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
     * Wait (bounded) for a classpath that is being resolved by this process or, via scan.lock,
     * by another server process. Returns null if it is still unavailable when the time is up.
     * Single-class lookups use this so a cold start does not answer "class not found" while
     * Maven is still running.
     */
    /** The last classpath/scan failure of a project, without clearing it (scanProject reports and clears it). */
    peekScanError(projectPath: string): string | undefined {
        return this.scanErrors.get(projectPath);
    }

    async waitForClasspath(projectPath: string, timeoutMs: number, onWait?: (elapsedMs: number) => Promise<void>): Promise<string[] | null> {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        const started = Date.now();
        while (true) {
            const cached = await projectCache.getClasspath(projectPath).catch(() => null);
            if (cached !== null) return cached;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            const inProcess = this.classpathPromises.get(projectPath);
            if (inProcess) {
                let timer: NodeJS.Timeout | undefined;
                const result = await Promise.race([
                    inProcess.then(paths => paths, () => null),
                    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.min(remaining, 2_000)); }),
                ]);
                if (timer) clearTimeout(timer);
                if (result === null) return null; // resolution failed; the error is reported by scanProject
                if (result !== undefined) return result;
            } else if (await CrossProcessLock.check(projectPath, 'scan')) {
                await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 500)));
            } else {
                return null;
            }
            await onWait?.(Date.now() - started);
        }
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

    async explainDependency(projectPath: string, coordinates: string): Promise<string> {
        if (await buildToolOf(projectPath) === 'gradle') throw new Error(`explain_dependency supports Maven only; for this Gradle build run \`gradle dependencyInsight --dependency ${coordinates}\`.`);
        if (!coordinates || /[&|;<>$()]/.test(coordinates)) {
            throw new Error('coordinates is required and may not contain shell metacharacters');
        }
        const mavenCmd = await this.resolveMavenCommand(projectPath);
        const { stdout, stderr } = await execFileAsync(
            mavenCmd,
            ['-B', 'dependency:tree', `-Dincludes=${coordinates}`, '-Dverbose'],
            {
                cwd: projectPath,
                timeout: 120000,
                shell: process.platform === 'win32',
                maxBuffer: 10 * 1024 * 1024,
            },
        );
        return [stdout, stderr].filter(value => value?.trim()).join('\n');
    }

    /**
     * Download the -sources.jar of one artifact into the local repository (`mvn dependency:get`).
     * Opt-in: it reaches the network. Returns Maven's error output on failure.
     */
    async downloadSources(projectPath: string, coordinates: { groupId: string; artifactId: string; version: string }): Promise<{ ok: boolean; message?: string }> {
        return this.downloadArtifact(projectPath, coordinates, 'sources');
    }

    /** `mvn dependency:get` for one artifact (no transitives) into the local repository. Opt-in: it reaches the network. */
    async downloadArtifact(projectPath: string, coordinates: { groupId: string; artifactId: string; version: string }, classifier?: string): Promise<{ ok: boolean; message?: string }> {
        const gav = `${coordinates.groupId}:${coordinates.artifactId}:${coordinates.version}`;
        if (!/^[\w.\-]+:[\w.\-]+:[\w.\-+]+$/.test(gav)) return { ok: false, message: `Invalid coordinates: ${gav}` };
        const mavenCmd = await this.resolveMavenCommand(projectPath);
        const logger = Logger.get(projectPath);
        logger.info(`[MAVEN] Downloading ${gav}${classifier ? `:${classifier}` : ''}`);
        try {
            await execFileAsync(mavenCmd, ['-B', '-q', 'dependency:get', `-Dartifact=${gav}:jar${classifier ? `:${classifier}` : ''}`, '-Dtransitive=false'], {
                cwd: projectPath,
                timeout: 120000,
                shell: process.platform === 'win32',
                maxBuffer: 10 * 1024 * 1024,
            });
            return { ok: true };
        } catch (error: any) {
            const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.split('\n').filter(line => /ERROR|Could not/.test(line)).slice(0, 3).join(' ').trim();
            logger.info(`[MAVEN] Download failed for ${gav}: ${output || error?.message}`);
            return { ok: false, message: output || String(error?.message ?? error) };
        }
    }

    /**
     * Gradle: an init script adds a task to every project that writes the resolved compile/runtime/test
     * classpath files (lenient, so one unresolvable dependency does not lose the rest) to one file per project.
     */
    private async getGradleClasspath(
        projectPath: string,
        onProgress?: (message: string, progress?: number, total?: number) => Promise<void>,
    ): Promise<string[]> {
        const logger = Logger.get(projectPath);
        const gradleCmd = await this.resolveGradleCommand(projectPath);
        const outputDir = path.join(getProjectCacheDir(projectPath), `gradle-cp-${process.pid}`);
        await fs.remove(outputDir).catch(() => {});
        await fs.ensureDir(outputDir);
        const initScript = path.join(outputDir, 'java-inspector-init.gradle');
        await fs.writeFile(initScript, GRADLE_INIT_SCRIPT, 'utf-8');
        logger.info(`[GRADLE] Running: ${gradleCmd} javaInspectorClasspath`);
        await onProgress?.(`Running Gradle: ${gradleCmd} (resolving classpath)...`, 5, 100);
        const start = performance.now();
        try {
            await execFileAsync(gradleCmd, ['-q', '--console=plain', '--no-configuration-cache', '--init-script', initScript, `-DjavaInspector.out=${outputDir}`, 'javaInspectorClasspath'], {
                cwd: projectPath,
                timeout: 300000,
                shell: process.platform === 'win32',
                maxBuffer: 10 * 1024 * 1024,
            });
            const contents = await Promise.all((await fs.readdir(outputDir)).filter(name => name.endsWith('.txt')).map(name => fs.readFile(path.join(outputDir, name), 'utf-8')));
            if (!contents.length) throw new Error('Gradle did not produce classpath output (no Java projects?)');
            const jars = [...new Set(contents.flatMap(content => content.split(/\r?\n/)).map(line => line.trim()).filter(line => line.endsWith('.jar')))];
            const existing: string[] = [];
            for (const jar of jars) if (await fs.pathExists(jar)) existing.push(jar);
            logger.info(`[GRADLE] Classpath of ${contents.length} project(s) resolved in ${((performance.now() - start) / 1000).toFixed(1)}s: ${existing.length} JARs.`);
            return existing;
        } catch (error: any) {
            const details = [error?.stdout, error?.stderr].filter(Boolean).join('\n').split('\n').filter(line => line.trim()).slice(0, 15).join('\n');
            logger.error(`[GRADLE] Classpath resolution failed: ${error?.message}\n${details}`);
            throw new Error(`Gradle command failed: ${String(error?.message ?? error).split('\n')[0]}${details ? `\n${details}` : ''}`);
        } finally {
            await fs.remove(outputDir).catch(() => {});
        }
    }

    /** GRADLE_CMD, then the project's wrapper (gradlew), then GRADLE_HOME/bin/gradle, then gradle on PATH. */
    private async resolveGradleCommand(projectPath: string): Promise<string> {
        if (process.env.GRADLE_CMD) {
            if (/[&|;<>$()]/.test(process.env.GRADLE_CMD)) throw new Error('Invalid GRADLE_CMD: Shell metacharacters are not allowed.');
            return process.env.GRADLE_CMD;
        }
        const wrapper = path.join(projectPath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
        if (await fs.pathExists(wrapper)) return wrapper;
        return process.env.GRADLE_HOME ? path.join(process.env.GRADLE_HOME, 'bin', 'gradle') : 'gradle';
    }

    /**
     * A multi-module checkout whose modules depend on each other fails `dependency:build-classpath` on Maven 3
     * until the sibling modules are installed ("Could not resolve dependencies ... demo:a:jar"). Recover by
     * re-running with --fail-at-end (modules that resolve still write their file) and adding the external
     * dependencies of the dependency tree (which only needs poms) that exist in the local repository.
     */
    private async recoverReactorClasspath(projectPath: string, mavenCmd: string, outputFile: string, details: string): Promise<string[] | null> {
        if (!/Could not resolve dependencies|was not found in|Could not find artifact/.test(details)) return null;
        const logger = Logger.get(projectPath);
        const reactorPoms = await this.reactorCoordinates(projectPath);
        // Only an unresolved *reactor module* is recoverable; a missing external artifact (network or
        // repository problem) must stay an error instead of becoming a silently incomplete classpath.
        const unresolved = details.replace(/for project \S+/g, '');
        if (![...reactorPoms].some(ga => unresolved.includes(`${ga}:`))) return null;
        logger.info('[MAVEN] Classpath resolution failed on a module dependency; retrying with --fail-at-end and dependency:tree (unbuilt sibling modules?)');
        await execFileAsync(mavenCmd, ['-B', '-q', '-fae', 'dependency:build-classpath', `-Dmdep.outputFile=${outputFile}`], {
            cwd: projectPath, timeout: 300000, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024,
        }).catch(() => {});
        let modules: ModuleDependencies[];
        try {
            modules = await this.runDependencyTree(projectPath, mavenCmd);
        } catch (error) {
            logger.error(`[MAVEN] dependency:tree fallback failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
        const reactor = new Set(modules.map(module => module.module.split(':').slice(0, 2).join(':')));
        const repository = path.resolve(process.env.MAVEN_REPO || path.join(os.homedir(), '.m2', 'repository'));
        const jars: string[] = [];
        let missing = 0;
        for (const dep of modules.flatMap(module => module.dependencies)) {
            if (reactor.has(`${dep.groupId}:${dep.artifactId}`) || (dep.type !== 'jar' && dep.type !== 'bundle' && dep.type !== 'test-jar')) continue;
            const classifier = dep.classifier ?? (dep.type === 'test-jar' ? 'tests' : undefined);
            const jar = path.join(repository, ...dep.groupId.split('.'), dep.artifactId, dep.version, `${dep.artifactId}-${dep.version}${classifier ? `-${classifier}` : ''}.jar`);
            if (await fs.pathExists(jar)) jars.push(jar); else missing++;
        }
        logger.info(`[MAVEN] Recovered ${jars.length} JAR(s) from the dependency tree of ${modules.length} module(s)${missing ? `; ${missing} not downloaded yet` : ''}. Reactor modules are skipped (their code is in the workspace).`);
        if (missing) this.partialClasspaths.add(projectPath); else this.partialClasspaths.delete(projectPath);
        return jars;
    }

    /** groupId:artifactId of every module pom under the project (parent groupId when the module has none). */
    private async reactorCoordinates(projectPath: string): Promise<Set<string>> {
        const result = new Set<string>();
        const visit = async (directory: string, depth: number) => {
            const pom = await fs.readFile(path.join(directory, 'pom.xml'), 'utf-8').catch(() => null);
            if (pom === null) return;
            const withoutParent = pom.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<(dependencies|dependencyManagement|build|profiles|plugins)>[\s\S]*$/, '');
            const parentGroup = pom.match(/<parent>[\s\S]*?<groupId>\s*([^<\s]+)\s*<\/groupId>/)?.[1];
            const groupId = withoutParent.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/)?.[1] ?? parentGroup;
            const artifactId = withoutParent.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1];
            if (groupId && artifactId) result.add(`${groupId}:${artifactId}`);
            if (depth >= 6) return;
            for (const module of pom.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) await visit(path.resolve(directory, module[1]), depth + 1);
        };
        await visit(projectPath, 0);
        return result;
    }

    private async runDependencyTree(projectPath: string, mavenCmd: string): Promise<ModuleDependencies[]> {
        const outputDir = path.join(getProjectCacheDir(projectPath), `maven-tree-${process.pid}-${Date.now()}`);
        await fs.ensureDir(outputDir);
        const outputFile = path.join(outputDir, 'tree-${project.groupId}__${project.artifactId}.txt');
        try {
            try {
                await execFileAsync(mavenCmd, ['-B', '-q', 'dependency:tree', `-DoutputFile=${outputFile}`, '-DoutputType=text'], {
                    cwd: projectPath, timeout: 300000, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024,
                });
            } catch (error: any) {
                const details = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.split('\n').filter(line => /ERROR/.test(line)).slice(0, 5).join('\n');
                throw new Error(`mvn dependency:tree failed: ${error?.message?.split('\n')[0] ?? error}${details ? `\n${details}` : ''}`);
            }
            const modules: ModuleDependencies[] = [];
            for (const name of (await fs.readdir(outputDir)).filter(file => file.endsWith('.txt')).sort()) {
                const parsed = parseDependencyTree(await fs.readFile(path.join(outputDir, name), 'utf-8'));
                if (parsed) modules.push(parsed);
            }
            if (!modules.length) throw new Error('Maven did not produce dependency:tree output');
            return modules;
        } finally {
            await fs.remove(outputDir).catch(() => {});
        }
    }

    /**
     * Resolved dependency tree of every reactor module (`mvn dependency:tree`, one output file per module).
     * Cached per project until pom.xml or the resolved classpath changes.
     */
    async listDependencies(projectPath: string): Promise<{ modules: ModuleDependencies[]; cached: boolean }> {
        if (await buildToolOf(projectPath) === 'gradle') throw new Error('list_dependencies supports Maven only; for this Gradle build run `gradle dependencies`. Classes, sources and the other tools work for Gradle projects.');
        const key = `${await projectCache.getPomHash(projectPath).catch(() => '')}:${projectCache.getClasspathHash((await projectCache.getClasspath(projectPath).catch(() => null)) ?? [])}`;
        const cacheFile = path.join(getProjectCacheDir(projectPath), 'dependency-tree.json');
        const cached = await fs.readJson(cacheFile).catch(() => null);
        if (cached?.key === key && Array.isArray(cached.modules)) return { modules: cached.modules, cached: true };

        const logger = Logger.get(projectPath);
        const start = performance.now();
        logger.info('[MAVEN] Running dependency:tree for list_dependencies');
        const modules = await this.runDependencyTree(projectPath, await this.resolveMavenCommand(projectPath));
        logger.info(`[MAVEN] Dependency tree of ${modules.length} module(s) in ${((performance.now() - start) / 1000).toFixed(1)}s`);
        await fs.writeJson(cacheFile, { key, modules }).catch(() => {});
        return { modules, cached: false };
    }

    private async withClasspathResolutionSlot<T>(task: () => Promise<T>): Promise<T> {
        if (this.activeClasspathResolutions >= 2) {
            await new Promise<void>(resolve => this.classpathResolutionQueue.push(resolve));
        }
        this.activeClasspathResolutions++;
        try {
            return await task();
        } finally {
            this.activeClasspathResolutions--;
            this.classpathResolutionQueue.shift()?.();
        }
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
            if (/[&|;<>$()]/.test(process.env.MAVEN_CMD)) {
                throw new Error(`Invalid MAVEN_CMD: Shell metacharacters are not allowed to prevent command injection.`);
            }
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
