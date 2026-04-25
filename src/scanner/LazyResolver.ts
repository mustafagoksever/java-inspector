import * as yauzl from 'yauzl';
import { projectCache, ClassIndexEntry } from '../cache/ProjectCache.js';

export interface ScoredClassEntry extends ClassIndexEntry {
    score: number;
}

export class LazyResolver {
    /**
     * Lazily find which JAR contains the given class.
     * Checks in-memory cache first (O(1)), then scans JARs from the classpath in parallel batches.
     */
    async findJarForClass(className: string, projectPath: string): Promise<string | null> {
        let targetClassName = className;

        // 0. If className is a simple name (no dot), try to resolve from index first
        if (!className.includes('.')) {
            const resolved = await this.resolveSimpleName(className, projectPath);
            if (resolved) {
                targetClassName = resolved;
            }
        }

        // 1. Try in-memory cache first (O(1))
        const entry = await projectCache.getEntry(projectPath, targetClassName);
        if (entry) return entry.jarPath;

        // 2. Get classpath
        const jarPaths = await projectCache.getClasspath(projectPath);
        if (!jarPaths || jarPaths.length === 0) {
            throw new Error('Classpath not found. Please run scan_dependencies first.');
        }

        // 3. Exclude already-scanned JARs if we have a partial index
        const scanState = await projectCache.getScanState(projectPath);
        const processedJars = scanState && !scanState.isComplete
            ? new Set<string>(scanState.processedJars ?? [])
            : new Set<string>();
        const jarsToSearch = jarPaths.filter((j: string) => !processedJars.has(j));

        // 4. Search in parallel batches of 20 (exact match)
        const batchSize = 20;
        for (let i = 0; i < jarsToSearch.length; i += batchSize) {
            const batch = jarsToSearch.slice(i, i + batchSize);
            const results = await Promise.all(
                batch.map((jar: string) =>
                    this.findClassInJar(targetClassName, jar).catch(() => null)
                )
            );
            const found = results.find((r: ClassIndexEntry | null) => r !== null);
            if (found) {
                // Add to index so future lookups are faster
                // NOTE: we do NOT mark the JAR as processedJars here,
                // because we only scanned for one class, not all classes in the JAR.
                await projectCache.appendToClassIndex(projectPath, [found]);
                return found.jarPath;
            }
        }

        // 5. If the original input was a simple name and exact search failed,
        // try suffix matching inside JARs (e.g. ObservationRegistry -> io/.../ObservationRegistry.class)
        if (!className.includes('.') && targetClassName === className) {
            for (let i = 0; i < jarsToSearch.length; i += batchSize) {
                const batch = jarsToSearch.slice(i, i + batchSize);
                const results = await Promise.all(
                    batch.map((jar: string) =>
                        this.findSimpleNameInJar(className, jar).catch(() => null)
                    )
                );
                const found = results.find((r: ClassIndexEntry | null) => r !== null);
                if (found) {
                    await projectCache.appendToClassIndex(projectPath, [found]);
                    return found.jarPath;
                }
            }
        }

        return null;
    }

    /**
     * Resolve a simple class name (e.g. "ObservationRegistry") to a fully qualified name
     * by looking at the existing index. If multiple matches exist, returns null
     * so the caller can report an ambiguity error.
     */
    private async resolveSimpleName(simpleName: string, projectPath: string): Promise<string | null> {
        const entries = await projectCache.getAllEntries(projectPath);
        const matches: string[] = [];
        for (const entry of entries) {
            if (entry.simpleName === simpleName) {
                matches.push(entry.className);
            }
        }
        if (matches.length === 1) {
            return matches[0];
        }
        return null;
    }

    /**
     * Search indexed classes with fuzzy matching.
     * Only searches what is already in memory (complete or partial index).
     */
    async searchClasses(
        projectPath: string,
        query: string,
        limit: number = 20
    ): Promise<ScoredClassEntry[]> {
        const entries = await projectCache.getAllEntries(projectPath);
        const lowerQuery = query.toLowerCase().trim();
        if (!lowerQuery) {
            return [];
        }

        const queryParts = lowerQuery.split(/[\s.]+/).filter(p => p.length > 0);
        const results: ScoredClassEntry[] = [];

        for (const entry of entries) {
            const lowerClassName = entry.className.toLowerCase();
            const lowerSimpleName = entry.simpleName.toLowerCase();
            const lowerPackage = entry.packageName.toLowerCase();
            let score = 0;

            // Exact simple name match (highest priority)
            if (lowerSimpleName === lowerQuery) {
                score += 100;
            }
            // Exact full class name match
            else if (lowerClassName === lowerQuery) {
                score += 90;
            }

            // Query matches end of simple name (e.g. "Repository" -> "JpaRepository")
            if (lowerSimpleName.endsWith(lowerQuery)) {
                score += 70;
            }

            // Simple name contains query
            if (lowerSimpleName.includes(lowerQuery)) {
                score += 60;
            }

            // Full class name contains query
            if (lowerClassName.includes(lowerQuery)) {
                score += 50;
            }

            // Package contains query
            if (lowerPackage.includes(lowerQuery)) {
                score += 20;
            }

            // All query parts appear somewhere in the full class name
            if (queryParts.length > 1) {
                const allPartsMatch = queryParts.every(part => lowerClassName.includes(part));
                if (allPartsMatch) {
                    score += 30;
                }
            }

            if (score > 0) {
                results.push({ ...entry, score });
            }
        }

        // Sort by score descending, then alphabetically for stability
        results.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.className.localeCompare(b.className);
        });

        return results.slice(0, limit);
    }

    /**
     * Get all indexed class names.
     */
    async getAllClassNames(projectPath: string): Promise<string[]> {
        const entries = await projectCache.getAllEntries(projectPath);
        const names: string[] = [];
        for (const entry of entries) {
            names.push(entry.className);
        }
        return names;
    }

    /**
     * Search a JAR for a class whose simple name matches the input.
     * Returns the first match found (FQCN resolved automatically).
     */
    private async findSimpleNameInJar(simpleName: string, jarPath: string): Promise<ClassIndexEntry | null> {
        const suffix = '/' + simpleName + '.class';

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timeout reading JAR: ${jarPath}`));
            }, 5000);

            yauzl.open(jarPath, { lazyEntries: true }, (err: any, zipfile: any) => {
                if (err) {
                    clearTimeout(timer);
                    reject(err);
                    return;
                }

                zipfile.readEntry();

                zipfile.on('entry', (entry: any) => {
                    if (entry.fileName.endsWith(suffix)) {
                        clearTimeout(timer);
                        try {
                            zipfile.close();
                        } catch (e) {
                            // ignore
                        }
                        const className = entry.fileName
                            .replace(/\.class$/, '')
                            .replace(/\//g, '.');
                        const packageName = className.substring(0, className.lastIndexOf('.'));
                        resolve({
                            className,
                            jarPath,
                            packageName,
                            simpleName,
                        });
                        return;
                    }
                    zipfile.readEntry();
                });

                zipfile.on('end', () => {
                    clearTimeout(timer);
                    try {
                        zipfile.close();
                    } catch (e) {
                        // ignore
                    }
                    resolve(null);
                });

                zipfile.on('error', (err: any) => {
                    clearTimeout(timer);
                    try {
                        zipfile.close();
                    } catch (e) {
                        // ignore
                    }
                    reject(err);
                });
            });
        });
    }

    /**
     * Check if a specific JAR contains the given class.
     * Returns the ClassIndexEntry if found, null otherwise.
     */
    private async findClassInJar(className: string, jarPath: string): Promise<ClassIndexEntry | null> {
        const classFileName = className.replace(/\./g, '/') + '.class';

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timeout reading JAR: ${jarPath}`));
            }, 5000);

            yauzl.open(jarPath, { lazyEntries: true }, (err: any, zipfile: any) => {
                if (err) {
                    clearTimeout(timer);
                    reject(err);
                    return;
                }

                zipfile.readEntry();

                zipfile.on('entry', (entry: any) => {
                    if (entry.fileName === classFileName) {
                        clearTimeout(timer);
                        try {
                            zipfile.close();
                        } catch (e) {
                            // ignore
                        }
                        const packageName = className.substring(0, className.lastIndexOf('.'));
                        const simpleName = className.substring(className.lastIndexOf('.') + 1);
                        resolve({
                            className,
                            jarPath,
                            packageName,
                            simpleName,
                        });
                        return;
                    }
                    zipfile.readEntry();
                });

                zipfile.on('end', () => {
                    clearTimeout(timer);
                    try {
                        zipfile.close();
                    } catch (e) {
                        // ignore
                    }
                    resolve(null);
                });

                zipfile.on('error', (err: any) => {
                    clearTimeout(timer);
                    try {
                        zipfile.close();
                    } catch (e) {
                        // ignore
                    }
                    reject(err);
                });
            });
        });
    }
}

// Singleton instance
export const lazyResolver = new LazyResolver();
