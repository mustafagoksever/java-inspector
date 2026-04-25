import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ProjectCache, ClassIndexEntry } from './ProjectCache.js';
import { getProjectCacheDir } from '../utils/cachePaths.js';
import { CrossProcessLock } from '../utils/CrossProcessLock.js';
import { Logger } from '../utils/Logger.js';

function createTestProject(): string {
    const dir = path.join(os.tmpdir(), `java-inspector-pcache-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>', 'utf-8');
    return dir;
}

async function cleanupTestProject(projectPath: string): Promise<void> {
    try {
        await CrossProcessLock.release(projectPath, 'write');
        await CrossProcessLock.release(projectPath, 'scan');
    } catch {
        // ignore
    }
    try {
        const cacheDir = getProjectCacheDir(projectPath);
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
        if (fs.existsSync(projectPath)) {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }
    } catch {
        // ignore
    }
    Logger.clearLog(projectPath);
}

describe('ProjectCache', () => {
    let cache: ProjectCache;

    beforeEach(() => {
        cache = new ProjectCache();
    });

    afterEach(async () => {
        // No shared state to clean; each test cleans its own project
    });

    describe('hash computation', () => {
        it('getPomHash should return consistent 16-char hex hash', async () => {
            const project = createTestProject();
            try {
                const hash1 = await cache.getPomHash(project);
                const hash2 = await cache.getPomHash(project);
                expect(hash1).toBe(hash2);
                expect(hash1).toMatch(/^[a-f0-9]{16}$/);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getPomHash should change when pom.xml changes', async () => {
            const project = createTestProject();
            try {
                const hash1 = await cache.getPomHash(project);
                fs.writeFileSync(path.join(project, 'pom.xml'), '<project>changed</project>', 'utf-8');
                const hash2 = await cache.getPomHash(project);
                expect(hash2).not.toBe(hash1);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getClasspathHash should be order-sensitive', () => {
            const h1 = cache.getClasspathHash(['a.jar', 'b.jar']);
            const h2 = cache.getClasspathHash(['a.jar', 'b.jar']);
            const h3 = cache.getClasspathHash(['b.jar', 'a.jar']);
            expect(h1).toBe(h2);
            expect(h1).not.toBe(h3);
            expect(h1).toMatch(/^[a-f0-9]{16}$/);
        });
    });

    describe('classpath persistence', () => {
        it('should save and retrieve classpath', async () => {
            const project = createTestProject();
            try {
                const jars = ['/path/to/a.jar', '/path/to/b.jar'];
                const pomHash = await cache.getPomHash(project);
                await cache.saveClasspath(project, jars, pomHash);

                const retrieved = await cache.getClasspath(project);
                expect(retrieved).toEqual(jars);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should return null when pom hash mismatch', async () => {
            const project = createTestProject();
            try {
                const jars = ['/path/to/a.jar'];
                const pomHash = await cache.getPomHash(project);
                await cache.saveClasspath(project, jars, pomHash);

                fs.writeFileSync(path.join(project, 'pom.xml'), '<project>changed</project>', 'utf-8');
                expect(await cache.getClasspath(project)).toBeNull();
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should return null when no classpath cache exists', async () => {
            const project = createTestProject();
            try {
                expect(await cache.getClasspath(project)).toBeNull();
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('index operations', () => {
        it('should append entries and allow O(1) lookup', async () => {
            const project = createTestProject();
            try {
                const entries: ClassIndexEntry[] = [
                    { className: 'com.example.Foo', jarPath: '/path/to/a.jar', packageName: 'com.example', simpleName: 'Foo' },
                    { className: 'com.example.Bar', jarPath: '/path/to/a.jar', packageName: 'com.example', simpleName: 'Bar' },
                ];
                await cache.appendToClassIndex(project, entries);

                const foo = await cache.getEntry(project, 'com.example.Foo');
                expect(foo).toBeDefined();
                expect(foo!.simpleName).toBe('Foo');

                const bar = await cache.getEntry(project, 'com.example.Bar');
                expect(bar).toBeDefined();
                expect(bar!.jarPath).toBe('/path/to/a.jar');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getAllEntries should return all indexed classes', async () => {
            const project = createTestProject();
            try {
                const entries: ClassIndexEntry[] = [
                    { className: 'a.A', jarPath: '/a.jar', packageName: 'a', simpleName: 'A' },
                    { className: 'b.B', jarPath: '/b.jar', packageName: 'b', simpleName: 'B' },
                ];
                await cache.appendToClassIndex(project, entries);

                const all = Array.from(await cache.getAllEntries(project));
                expect(all.length).toBe(2);
                const names = all.map(e => e.className).sort();
                expect(names).toEqual(['a.A', 'b.B']);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getEntry should return undefined for unknown class', async () => {
            const project = createTestProject();
            try {
                expect(await cache.getEntry(project, 'unknown.Class')).toBeUndefined();
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('scan state', () => {
        it('getScanState should return null when no state exists', async () => {
            const project = createTestProject();
            try {
                expect(await cache.getScanState(project)).toBeNull();
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('appendToClassIndex should create and update scan state', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar', '/b.jar'];
                await cache.appendToClassIndex(project, [], ['/a.jar'], 2);

                let state = await cache.getScanState(project);
                expect(state).not.toBeNull();
                expect(state!.processedJars).toContain('/a.jar');
                expect(state!.jarCount).toBe(2);

                await cache.appendToClassIndex(project, [], ['/b.jar'], 2);
                state = await cache.getScanState(project);
                expect(state!.processedJars).toContain('/a.jar');
                expect(state!.processedJars).toContain('/b.jar');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getScanProgress should reflect processed/total JARs', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar', '/b.jar', '/c.jar'];
                const pomHash = await cache.getPomHash(project);
                await cache.saveClasspath(project, jars, pomHash);
                await cache.appendToClassIndex(project, [], ['/a.jar'], 3);

                const progress = await cache.getScanProgress(project);
                expect(progress).toEqual({ processed: 1, total: 3 });
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getScanProgress should return null without classpath cache', async () => {
            const project = createTestProject();
            try {
                expect(await cache.getScanProgress(project)).toBeNull();
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getScanProgress should show total=processed when complete', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await cache.getPomHash(project);
                await cache.saveClasspath(project, jars, pomHash);
                await cache.saveClassIndex(project, { jarCount: 1, sampleEntries: [] });

                const progress = await cache.getScanProgress(project);
                expect(progress).toEqual({ processed: 1, total: 1 });
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('class index data', () => {
        it('getClassIndex should return structured data', async () => {
            const project = createTestProject();
            try {
                const entries: ClassIndexEntry[] = [
                    { className: 'a.A', jarPath: '/a.jar', packageName: 'a', simpleName: 'A' },
                ];
                await cache.appendToClassIndex(project, entries, ['/a.jar'], 1);
                await cache.saveClassIndex(project, { jarCount: 1, sampleEntries: ['a.A -> a.jar'] });

                const index = await cache.getClassIndex(project);
                expect(index).not.toBeNull();
                expect(index!.classCount).toBe(1);
                expect(index!.jarCount).toBe(1);
                expect(index!.isComplete).toBe(true);
                expect(index!.sampleEntries).toContain('a.A -> a.jar');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getClassIndex should return null when no data exists', async () => {
            const project = createTestProject();
            try {
                expect(await cache.getClassIndex(project)).toBeNull();
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('index completeness', () => {
        it('isIndexComplete should return true when all hashes match', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await cache.getPomHash(project);
                const classpathHash = cache.getClasspathHash(jars);

                await cache.saveClasspath(project, jars, pomHash);
                await cache.appendToClassIndex(project, [], ['/a.jar'], 1, pomHash, classpathHash);
                await cache.saveClassIndex(project, { jarCount: 1, sampleEntries: [] }, pomHash, classpathHash);

                expect(await cache.isIndexComplete(project)).toBe(true);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('isIndexComplete should return false when state is incomplete', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await cache.getPomHash(project);
                await cache.saveClasspath(project, jars, pomHash);
                await cache.appendToClassIndex(project, [], ['/a.jar'], 1, pomHash, '');

                expect(await cache.isIndexComplete(project)).toBe(false);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('isIndexComplete should return false when pom hash mismatch', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await cache.getPomHash(project);
                const classpathHash = cache.getClasspathHash(jars);

                await cache.saveClasspath(project, jars, pomHash);
                await cache.appendToClassIndex(project, [], ['/a.jar'], 1, pomHash, classpathHash);
                await cache.saveClassIndex(project, { jarCount: 1, sampleEntries: [] }, pomHash, classpathHash);

                fs.writeFileSync(path.join(project, 'pom.xml'), '<project>changed</project>', 'utf-8');
                expect(await cache.isIndexComplete(project)).toBe(false);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('isIndexComplete should return false when classpath hash mismatch', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await cache.getPomHash(project);
                const classpathHash = cache.getClasspathHash(jars);

                await cache.saveClasspath(project, jars, pomHash);
                await cache.appendToClassIndex(project, [], ['/a.jar'], 1, pomHash, classpathHash);
                await cache.saveClassIndex(project, { jarCount: 1, sampleEntries: [] }, pomHash, classpathHash);

                // Change cached classpath to simulate dependency change
                await cache.saveClasspath(project, ['/b.jar'], pomHash);
                expect(await cache.isIndexComplete(project)).toBe(false);
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('disk loading', () => {
        it('should load existing JSONL index from disk into fresh cache', async () => {
            const project = createTestProject();
            try {
                const entries: ClassIndexEntry[] = [
                    { className: 'x.X', jarPath: '/x.jar', packageName: 'x', simpleName: 'X' },
                ];
                const cacheDir = getProjectCacheDir(project);
                fs.mkdirSync(cacheDir, { recursive: true });
                fs.writeFileSync(path.join(cacheDir, 'class-index.jsonl'), JSON.stringify(entries) + '\n', 'utf-8');

                const freshCache = new ProjectCache();
                const result = await freshCache.getEntry(project, 'x.X');
                expect(result).toBeDefined();
                expect(result!.simpleName).toBe('X');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should skip corrupt last JSONL line and load valid lines', async () => {
            const project = createTestProject();
            try {
                const validEntries: ClassIndexEntry[] = [
                    { className: 'x.X', jarPath: '/x.jar', packageName: 'x', simpleName: 'X' },
                ];
                const cacheDir = getProjectCacheDir(project);
                fs.mkdirSync(cacheDir, { recursive: true });
                fs.writeFileSync(
                    path.join(cacheDir, 'class-index.jsonl'),
                    JSON.stringify(validEntries) + '\n{corrupt json',
                    'utf-8'
                );

                const freshCache = new ProjectCache();
                const result = await freshCache.getEntry(project, 'x.X');
                expect(result).toBeDefined();
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should deduplicate concurrent loads on the same project', async () => {
            const project = createTestProject();
            try {
                const entries: ClassIndexEntry[] = [
                    { className: 'a.A', jarPath: '/a.jar', packageName: 'a', simpleName: 'A' },
                    { className: 'b.B', jarPath: '/b.jar', packageName: 'b', simpleName: 'B' },
                ];
                const cacheDir = getProjectCacheDir(project);
                fs.mkdirSync(cacheDir, { recursive: true });
                fs.writeFileSync(path.join(cacheDir, 'class-index.jsonl'), JSON.stringify(entries) + '\n', 'utf-8');

                const freshCache = new ProjectCache();
                const [all1, all2] = await Promise.all([
                    freshCache.getAllEntries(project),
                    freshCache.getAllEntries(project),
                ]);

                expect(Array.from(all1).length).toBe(2);
                expect(Array.from(all2).length).toBe(2);
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('invalidation', () => {
        it('invalidate should clear memory index and disk cache', async () => {
            const project = createTestProject();
            try {
                const entries: ClassIndexEntry[] = [
                    { className: 'a.A', jarPath: '/a.jar', packageName: 'a', simpleName: 'A' },
                ];
                await cache.appendToClassIndex(project, entries);
                expect(await cache.getEntry(project, 'a.A')).toBeDefined();

                await cache.invalidate(project);

                expect(await cache.getEntry(project, 'a.A')).toBeUndefined();
                const cacheDir = getProjectCacheDir(project);
                expect(fs.existsSync(cacheDir)).toBe(false);
            } finally {
                await cleanupTestProject(project);
            }
        });
    });
});
