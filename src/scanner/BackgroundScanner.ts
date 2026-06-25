import * as path from 'path';
import * as yauzl from 'yauzl';
import { projectCache, ClassIndexEntry } from '../cache/ProjectCache.js';
import { Logger } from '../utils/Logger.js';

export interface ScanState {
    total: number;
    processed: number;
    isComplete: boolean;
    promise: Promise<void>;
}

export class BackgroundScanner {
    private states: Map<string, ScanState> = new Map();

    /**
     * Start a background scan for the given project.
     * Returns a promise that resolves when the scan completes (or rejects on failure).
     * The scan continues in the background.
     */
    start(
        projectPath: string,
        jarPaths: string[],
        pomHash?: string,
        classpathHash?: string,
        onProgress?: (message: string, progress?: number, total?: number) => Promise<void>
    ): Promise<void> {
        // Don't start if already running
        if (this.states.has(projectPath)) {
            const existing = this.states.get(projectPath)!;
            if (!existing.isComplete) {
                // Return the existing promise so caller can await completion
                return existing.promise;
            }
        }

        const state: ScanState = {
            total: jarPaths.length,
            processed: 0,
            isComplete: false,
            promise: Promise.resolve(),
        };

        state.promise = this.runScan(projectPath, jarPaths, state, pomHash, classpathHash, onProgress).catch(err => {
            console.error(`Background scan failed for ${projectPath}:`, err);
            throw err; // Re-throw so the returned promise rejects
        });

        this.states.set(projectPath, state);
        return state.promise;
    }

    /**
     * Get the current scan state for a project.
     */
    getState(projectPath: string): ScanState | undefined {
        return this.states.get(projectPath);
    }

    /**
     * Check if a scan is currently in progress.
     */
    isScanning(projectPath: string): boolean {
        const state = this.states.get(projectPath);
        return !!state && !state.isComplete;
    }

    /**
     * Reset (cancel) any existing scan state for a project.
     */
    reset(projectPath: string): void {
        this.states.delete(projectPath);
    }

    private async runScan(
        projectPath: string,
        jarPaths: string[],
        state: ScanState,
        pomHash?: string,
        classpathHash?: string,
        onProgress?: (message: string, progress?: number, total?: number) => Promise<void>
    ): Promise<void> {
        const logger = Logger.get(projectPath);
        const scanStart = performance.now();
        logger.info(`[SCAN] Background scan started. Total JARs: ${jarPaths.length}, Batches: ${Math.ceil(jarPaths.length / 20)}`);

        // Resume from partial index if available
        const scanState = await projectCache.getScanState(projectPath);
        const processedJars = scanState && !scanState.isComplete
            ? new Set<string>(scanState.processedJars ?? [])
            : new Set<string>();

        const batchSize = 20;

        for (let i = 0; i < jarPaths.length; i += batchSize) {
            if (state.isComplete) break; // Allow early termination

            const batchStart = performance.now();
            const batch = jarPaths.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(jarPaths.length / batchSize);
            logger.debug(`[SCAN] Processing batch ${batchNum}/${totalBatches} (${batch.length} JARs)...`);

            const results = await Promise.all(
                batch.map((jar: string) =>
                    processedJars.has(jar)
                        ? Promise.resolve<ClassIndexEntry[]>([])
                        : this.extractClassesFromJarWithTimeout(jar, 30000).catch((err: Error) => {
                            logger.warn(`[SCAN] Failed to process JAR: ${path.basename(jar)}, error: ${err.message}`);
                            return [] as ClassIndexEntry[];
                        })
                )
            );

            for (const jar of batch) {
                processedJars.add(jar);
            }

            state.processed = processedJars.size;
            const batchClasses = results.reduce((a: ClassIndexEntry[], b: ClassIndexEntry[]) => a.concat(b), []);
            const batchDuration = ((performance.now() - batchStart) / 1000).toFixed(2);
            logger.debug(`[SCAN] Batch ${batchNum}/${totalBatches} complete in ${batchDuration}s. Indexed ${batchClasses.length} classes.`);

            // Flush partial index every batch (atomically append)
            await projectCache.appendToClassIndex(
                projectPath,
                batchClasses,
                batch,
                jarPaths.length
            );

            const progress = Math.floor((state.processed / state.total) * 100);
            const msg = `Processed ${state.processed}/${state.total} JARs`;
            await onProgress?.(msg, progress, 100);
        }

        // Mark complete — read the final accumulated index and write it as complete
        const finalIndex = await projectCache.getClassIndex(projectPath);
        const allEntries = finalIndex?.classIndex ?? [];
        const sampleEntries = allEntries
            .slice(0, 10)
            .map((e: ClassIndexEntry) => `${e.className} -> ${path.basename(e.jarPath)}`);

        await projectCache.saveClassIndex(projectPath, {
            jarCount: jarPaths.length,
            classCount: allEntries.length,
            sampleEntries,
        }, pomHash, classpathHash);

        const scanDuration = ((performance.now() - scanStart) / 1000).toFixed(2);
        state.isComplete = true;
        state.processed = state.total;
        logger.info(`[SCAN] Background scan complete in ${scanDuration}s. Total: ${jarPaths.length} JARs, ${allEntries.length} classes indexed.`);
        await onProgress?.(`Scan complete: ${jarPaths.length} JARs, ${allEntries.length} classes`, 100, 100);
    }

    private async extractClassesFromJarWithTimeout(jarPath: string, timeoutMs: number): Promise<ClassIndexEntry[]> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timeout after ${timeoutMs}ms reading JAR: ${jarPath}`));
            }, timeoutMs);

            this.extractClassesFromJar(jarPath)
                .then((result: ClassIndexEntry[]) => {
                    clearTimeout(timer);
                    resolve(result);
                })
                .catch((err: Error) => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    private async extractClassesFromJar(jarPath: string): Promise<ClassIndexEntry[]> {
        return new Promise((resolve, reject) => {
            const classes: ClassIndexEntry[] = [];

            yauzl.open(jarPath, { lazyEntries: true }, (err: any, zipfile: any) => {
                if (err) {
                    reject(err);
                    return;
                }

                zipfile.readEntry();

                zipfile.on('entry', (entry: any) => {
                    if (entry.fileName.endsWith('.class') && !entry.fileName.includes('$')) {
                        const className = entry.fileName
                            .replace(/\.class$/, '')
                            .replace(/\//g, '.');

                        const lastDotIndex = className.lastIndexOf('.');
                        const packageName = lastDotIndex > 0 ? className.substring(0, lastDotIndex) : '';
                        const simpleName = lastDotIndex > 0 ? className.substring(lastDotIndex + 1) : className;

                        classes.push({
                            className,
                            jarPath,
                            packageName,
                            simpleName
                        });
                    }

                    zipfile.readEntry();
                });

                zipfile.on('end', () => {
                    try {
                        zipfile.close();
                    } catch (e) {
                        // ignore close errors
                    }
                    resolve(classes);
                });

                zipfile.on('error', (err: any) => {
                    try {
                        zipfile.close();
                    } catch (e) {
                        // ignore close errors
                    }
                    reject(err);
                });
            });
        });
    }
}

// Singleton instance
export const backgroundScanner = new BackgroundScanner();
