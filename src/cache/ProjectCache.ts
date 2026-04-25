import * as path from 'path';
import { createHash } from 'crypto';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import {
    getProjectCacheDir,
    getClassIndexJsonlPath,
    getScanStatePath,
    getClasspathPath,
} from '../utils/cachePaths.js';
import { Logger } from '../utils/Logger.js';

export interface ClassIndexEntry {
    className: string;
    jarPath: string;
    packageName: string;
    simpleName: string;
}

export interface ClasspathData {
    pomHash: string;
    jarPaths: string[];
    classpathHash: string;
    timestamp: string;
}

export interface ScanStateData {
    jarCount: number;
    processedJars: string[];
    isComplete: boolean;
    lastUpdated: string;
    sampleEntries: string[];
    pomHash: string;
    classpathHash: string;
}

export interface ClassIndexData {
    jarCount: number;
    classCount: number;
    indexPath: string;
    sampleEntries: string[];
    classIndex: ClassIndexEntry[];
    lastUpdated: string;
    isComplete: boolean;
}

export class ProjectCache {
    // In-memory indexes per project: Map<className, ClassIndexEntry>
    private indexes: Map<string, Map<string, ClassIndexEntry>> = new Map();
    // Scan state per project
    private states: Map<string, ScanStateData> = new Map();
    // Deduplicate concurrent loads
    private loadPromises: Map<string, Promise<void>> = new Map();
    // Per-project write locks
    private locks: Map<string, Promise<void>> = new Map();

    private async withLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
        while (this.locks.has(projectPath)) {
            await this.locks.get(projectPath);
        }
        const promise = fn();
        const lockPromise = promise.then(() => {}).catch(() => {});
        this.locks.set(projectPath, lockPromise);
        try {
            return await promise;
        } finally {
            this.locks.delete(projectPath);
        }
    }

    /**
     * Ensure the in-memory index and state are loaded from disk.
     * This is idempotent and deduplicates concurrent calls.
     */
    private async ensureLoaded(projectPath: string): Promise<void> {
        if (this.indexes.has(projectPath) && this.states.has(projectPath)) {
            return;
        }

        if (this.loadPromises.has(projectPath)) {
            return this.loadPromises.get(projectPath)!;
        }

        const loadPromise = this.loadFromDisk(projectPath);
        this.loadPromises.set(projectPath, loadPromise);
        try {
            await loadPromise;
        } finally {
            this.loadPromises.delete(projectPath);
        }
    }

    /**
     * Load index and state from disk into memory.
     */
    private async loadFromDisk(projectPath: string): Promise<void> {
        const index = new Map<string, ClassIndexEntry>();
        const jsonlPath = getClassIndexJsonlPath(projectPath);

        if (await fs.pathExists(jsonlPath)) {
            try {
                const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
                const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
                let lineNumber = 0;

                for await (const line of rl) {
                    lineNumber++;
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    try {
                        const batch: ClassIndexEntry[] = JSON.parse(trimmed);
                        if (Array.isArray(batch)) {
                            for (const entry of batch) {
                                if (entry && entry.className) {
                                    index.set(entry.className, entry);
                                }
                            }
                        }
                    } catch {
                        // If the last line is corrupt (e.g. crash during write), skip it.
                        // If any non-last line is corrupt, that's a real problem.
                        // We handle this by just warning; if it's not the last line,
                        // the file may be seriously corrupted.
                        if (lineNumber > 1) {
                            console.warn(`Corrupt JSONL line ${lineNumber} in ${jsonlPath}, skipping`);
                        }
                    }
                }
            } catch (err) {
                console.error(`Failed to load JSONL for ${projectPath}:`, err);
            }
        }

        this.indexes.set(projectPath, index);

        // Load scan state
        const statePath = getScanStatePath(projectPath);
        let state: ScanStateData | null = null;

        if (await fs.pathExists(statePath)) {
            try {
                state = await fs.readJson(statePath) as ScanStateData;
            } catch {
                // ignore corrupt state
            }
        }

        // If no state but we have entries, create a default state
        if (!state && index.size > 0) {
            state = {
                jarCount: 0,
                processedJars: [],
                isComplete: false,
                lastUpdated: new Date().toISOString(),
                sampleEntries: [],
                pomHash: '',
                classpathHash: '',
            };
        }

        if (state) {
            this.states.set(projectPath, state);
        }
    }

    /**
     * Compute SHA-256 hash of the project's pom.xml file.
     */
    async getPomHash(projectPath: string): Promise<string> {
        const pomPath = path.join(projectPath, 'pom.xml');
        const content = await fs.readFile(pomPath, 'utf-8');
        return createHash('sha256').update(content).digest('hex').substring(0, 16);
    }

    /**
     * Compute hash of the classpath JAR list.
     * This catches changes from parent POMs or dependency management.
     */
    getClasspathHash(jarPaths: string[]): string {
        return createHash('sha256').update(jarPaths.join('\n')).digest('hex').substring(0, 16);
    }

    /**
     * Read the cached classpath for a project.
     * Returns null if no cache exists or pom.xml has changed.
     */
    async getClasspath(projectPath: string): Promise<string[] | null> {
        const classpathPath = getClasspathPath(projectPath);
        if (!(await fs.pathExists(classpathPath))) {
            return null;
        }

        try {
            const data: ClasspathData = await fs.readJson(classpathPath);
            const currentHash = await this.getPomHash(projectPath);
            if (data.pomHash !== currentHash) {
                return null;
            }
            return data.jarPaths;
        } catch {
            return null;
        }
    }

    /**
     * Read the cached classpath hash for a project.
     */
    private async getCachedClasspathHash(projectPath: string): Promise<string | null> {
        const classpathPath = getClasspathPath(projectPath);
        if (!(await fs.pathExists(classpathPath))) {
            return null;
        }

        try {
            const data: ClasspathData = await fs.readJson(classpathPath);
            return data.classpathHash;
        } catch {
            return null;
        }
    }

    /**
     * Save the classpath list, pom.xml hash, and classpath hash.
     */
    async saveClasspath(projectPath: string, jarPaths: string[], pomHash: string): Promise<void> {
        await this.withLock(projectPath, async () => {
            const classpathPath = getClasspathPath(projectPath);
            const data: ClasspathData = {
                pomHash,
                jarPaths,
                classpathHash: this.getClasspathHash(jarPaths),
                timestamp: new Date().toISOString(),
            };
            await fs.outputJson(classpathPath, data, { spaces: 0 });
        });
    }

    /**
     * Get a single entry by class name. O(1) memory lookup.
     */
    async getEntry(projectPath: string, className: string): Promise<ClassIndexEntry | undefined> {
        await this.ensureLoaded(projectPath);
        const index = this.indexes.get(projectPath);
        if (!index) return undefined;
        return index.get(className);
    }

    /**
     * Get all entries as an iterable. O(1) to get iterator, O(n) to iterate.
     */
    async getAllEntries(projectPath: string): Promise<IterableIterator<ClassIndexEntry>> {
        await this.ensureLoaded(projectPath);
        const index = this.indexes.get(projectPath);
        if (!index) return [][Symbol.iterator]();
        return index.values();
    }

    /**
     * Backward-compatible: get full index as an object.
     */
    async getClassIndex(projectPath: string): Promise<ClassIndexData | null> {
        await this.ensureLoaded(projectPath);
        const index = this.indexes.get(projectPath);
        const state = this.states.get(projectPath);

        if (!index || !state) {
            return null;
        }

        const classIndex = Array.from(index.values());
        return {
            jarCount: state.jarCount,
            classCount: classIndex.length,
            indexPath: getProjectCacheDir(projectPath),
            sampleEntries: state.sampleEntries,
            classIndex,
            lastUpdated: state.lastUpdated,
            isComplete: state.isComplete,
        };
    }

    /**
     * Get the raw scan state (including processedJars).
     */
    async getScanState(projectPath: string): Promise<ScanStateData | null> {
        await this.ensureLoaded(projectPath);
        return this.states.get(projectPath) ?? null;
    }

    /**
     * Check if a complete index exists for the project.
     * Validates both pomHash and classpathHash (catches parent POM changes).
     */
    async isIndexComplete(projectPath: string): Promise<boolean> {
        await this.ensureLoaded(projectPath);
        const state = this.states.get(projectPath);
        if (!state || !state.isComplete) {
            return false;
        }

        // Validate pomHash
        try {
            const currentHash = await this.getPomHash(projectPath);
            if (state.pomHash !== currentHash) {
                return false;
            }
        } catch {
            return false;
        }

        // Validate classpathHash (catches parent POM / dependency management changes)
        const cachedCpHash = await this.getCachedClasspathHash(projectPath);
        if (cachedCpHash && state.classpathHash !== cachedCpHash) {
            return false;
        }

        return true;
    }

    /**
     * Get scan progress (processed / total JARs).
     */
    async getScanProgress(projectPath: string): Promise<{ processed: number; total: number } | null> {
        const classpath = await this.getClasspath(projectPath);
        if (!classpath) return null;

        const total = classpath.length;
        await this.ensureLoaded(projectPath);
        const state = this.states.get(projectPath);

        if (!state) {
            return { processed: 0, total };
        }

        if (state.isComplete) {
            return { processed: total, total };
        }

        const processed = state.processedJars?.length ?? 0;
        return { processed, total };
    }

    /**
     * Append entries to the index atomically.
     * Updates both disk (JSONL) and memory (Map).
     */
    async appendToClassIndex(
        projectPath: string,
        entries: ClassIndexEntry[],
        processedJars?: string[],
        jarCount?: number,
        pomHash?: string,
        classpathHash?: string
    ): Promise<void> {
        if (entries.length === 0 && !processedJars) return;

        await this.withLock(projectPath, async () => {
            await this.ensureLoaded(projectPath);

            const index = this.indexes.get(projectPath);
            if (!index) {
                this.indexes.set(projectPath, new Map());
            }
            const map = this.indexes.get(projectPath)!;

            // Update memory
            for (const entry of entries) {
                map.set(entry.className, entry);
            }

            // Append to JSONL
            const jsonlPath = getClassIndexJsonlPath(projectPath);
            const line = JSON.stringify(entries) + '\n';
            await fs.appendFile(jsonlPath, line, 'utf-8');

            // Update state
            let state = this.states.get(projectPath);
            if (!state) {
                state = {
                    jarCount: jarCount ?? 0,
                    processedJars: processedJars ?? [],
                    isComplete: false,
                    lastUpdated: new Date().toISOString(),
                    sampleEntries: [],
                    pomHash: pomHash ?? '',
                    classpathHash: classpathHash ?? '',
                };
                this.states.set(projectPath, state);
            } else {
                if (jarCount !== undefined) state.jarCount = jarCount;
                if (processedJars) {
                    state.processedJars = [...new Set([...state.processedJars, ...processedJars])];
                }
                state.lastUpdated = new Date().toISOString();
                if (pomHash) state.pomHash = pomHash;
                if (classpathHash) state.classpathHash = classpathHash;
            }

            // Update sample entries (first 10)
            const allEntries = Array.from(map.values());
            state.sampleEntries = allEntries
                .slice(0, 10)
                .map((e: ClassIndexEntry) => `${e.className} -> ${e.jarPath.split(/[/\\]/).pop()}`);

            // Write scan state
            await this.writeScanState(projectPath, state);
        });
    }

    /**
     * Mark the index as complete.
     */
    async saveClassIndex(
        projectPath: string,
        data: { jarCount: number; classCount?: number; sampleEntries: string[] },
        pomHash?: string,
        classpathHash?: string
    ): Promise<void> {
        await this.withLock(projectPath, async () => {
            await this.ensureLoaded(projectPath);

            let state = this.states.get(projectPath);
            if (!state) {
                state = {
                    jarCount: data.jarCount,
                    processedJars: [],
                    isComplete: true,
                    lastUpdated: new Date().toISOString(),
                    sampleEntries: data.sampleEntries,
                    pomHash: pomHash ?? '',
                    classpathHash: classpathHash ?? '',
                };
            } else {
                state.jarCount = data.jarCount;
                state.isComplete = true;
                state.lastUpdated = new Date().toISOString();
                state.sampleEntries = data.sampleEntries;
                if (pomHash) state.pomHash = pomHash;
                if (classpathHash) state.classpathHash = classpathHash;
            }

            this.states.set(projectPath, state);
            await this.writeScanState(projectPath, state);
        });
    }

    /**
     * Invalidate all cached data for a project.
     */
    async invalidate(projectPath: string): Promise<void> {
        Logger.get(projectPath).info('[CACHE] Invalidating cache...');
        await this.withLock(projectPath, async () => {
            this.indexes.delete(projectPath);
            this.states.delete(projectPath);
            this.loadPromises.delete(projectPath);

            const cacheDir = getProjectCacheDir(projectPath);
            if (await fs.pathExists(cacheDir)) {
                await fs.remove(cacheDir);
                Logger.get(projectPath).info('[CACHE] Cache directory removed.');
            }
        });
        Logger.clearLog(projectPath);
    }

    /**
     * Write scan state to disk (internal, assumes lock is held).
     */
    private async writeScanState(projectPath: string, state: ScanStateData): Promise<void> {
        const statePath = getScanStatePath(projectPath);
        await fs.outputJson(statePath, state, { spaces: 0 });
    }
}

// Singleton instance
export const projectCache = new ProjectCache();
