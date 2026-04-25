import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import archiver from 'archiver';
import { LazyResolver } from './LazyResolver.js';
import { projectCache } from '../cache/ProjectCache.js';
import { Logger } from '../utils/Logger.js';

function createTestProject(): string {
    const dir = path.join(os.tmpdir(), `java-inspector-lazy-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>', 'utf-8');
    return dir;
}

async function cleanupTestProject(projectPath: string): Promise<void> {
    try {
        await projectCache.invalidate(projectPath);
    } catch {
        // ignore
    }
    try {
        if (fs.existsSync(projectPath)) {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }
    } catch {
        // ignore
    }
    Logger.clearLog(projectPath);
}

async function createTestJar(projectPath: string, jarName: string, classNames: string[]): Promise<string> {
    const jarPath = path.join(projectPath, jarName);
    const output = fs.createWriteStream(jarPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
        output.on('close', () => resolve(jarPath));
        archive.on('error', reject);
        archive.pipe(output);

        for (const className of classNames) {
            const entryPath = className.replace(/\./g, '/') + '.class';
            archive.append(Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]), { name: entryPath });
        }

        archive.finalize();
    });
}

describe('LazyResolver', () => {
    let resolver: LazyResolver;

    beforeEach(() => {
        resolver = new LazyResolver();
    });

    describe('searchClasses', () => {
        it('should return empty array for empty query', async () => {
            const project = createTestProject();
            try {
                const results = await resolver.searchClasses(project, '');
                expect(results).toEqual([]);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should score exact simple name match highest', async () => {
            const project = createTestProject();
            try {
                await projectCache.appendToClassIndex(project, [
                    { className: 'com.example.UserRepository', jarPath: '/a.jar', packageName: 'com.example', simpleName: 'UserRepository' },
                    { className: 'org.other.UserService', jarPath: '/b.jar', packageName: 'org.other', simpleName: 'UserService' },
                ]);

                const results = await resolver.searchClasses(project, 'UserRepository');
                expect(results.length).toBeGreaterThan(0);
                expect(results[0].simpleName).toBe('UserRepository');
                expect(results[0].score).toBeGreaterThanOrEqual(100);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should score suffix match higher than contains', async () => {
            const project = createTestProject();
            try {
                await projectCache.appendToClassIndex(project, [
                    { className: 'com.example.JpaRepository', jarPath: '/a.jar', packageName: 'com.example', simpleName: 'JpaRepository' },
                    { className: 'com.example.RepositoryHelper', jarPath: '/b.jar', packageName: 'com.example', simpleName: 'RepositoryHelper' },
                ]);

                const results = await resolver.searchClasses(project, 'Repository');
                const jpa = results.find(r => r.simpleName === 'JpaRepository');
                const helper = results.find(r => r.simpleName === 'RepositoryHelper');
                expect(jpa).toBeDefined();
                expect(helper).toBeDefined();
                expect(jpa!.score).toBeGreaterThan(helper!.score);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should limit results', async () => {
            const project = createTestProject();
            try {
                const entries = Array.from({ length: 30 }, (_, i) => ({
                    className: `com.example.Class${i}`,
                    jarPath: '/a.jar',
                    packageName: 'com.example',
                    simpleName: `Class${i}`,
                }));
                await projectCache.appendToClassIndex(project, entries);

                const results = await resolver.searchClasses(project, 'Class', 5);
                expect(results.length).toBe(5);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should handle multi-part query', async () => {
            const project = createTestProject();
            try {
                await projectCache.appendToClassIndex(project, [
                    { className: 'com.example.order.OrderService', jarPath: '/a.jar', packageName: 'com.example.order', simpleName: 'OrderService' },
                    { className: 'com.example.user.UserService', jarPath: '/b.jar', packageName: 'com.example.user', simpleName: 'UserService' },
                ]);

                const results = await resolver.searchClasses(project, 'order service');
                const order = results.find(r => r.simpleName === 'OrderService');
                expect(order).toBeDefined();
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should sort by score descending then alphabetically', async () => {
            const project = createTestProject();
            try {
                await projectCache.appendToClassIndex(project, [
                    { className: 'a.Beta', jarPath: '/a.jar', packageName: 'a', simpleName: 'Beta' },
                    { className: 'a.Alpha', jarPath: '/a.jar', packageName: 'a', simpleName: 'Alpha' },
                ]);

                const results = await resolver.searchClasses(project, 'a');
                // Both match with same score; should be sorted alphabetically
                expect(results[0].simpleName).toBe('Alpha');
                expect(results[1].simpleName).toBe('Beta');
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('getAllClassNames', () => {
        it('should return all indexed class names', async () => {
            const project = createTestProject();
            try {
                await projectCache.appendToClassIndex(project, [
                    { className: 'a.A', jarPath: '/a.jar', packageName: 'a', simpleName: 'A' },
                    { className: 'b.B', jarPath: '/b.jar', packageName: 'b', simpleName: 'B' },
                ]);

                const names = await resolver.getAllClassNames(project);
                expect(names.length).toBe(2);
                expect(names).toContain('a.A');
                expect(names).toContain('b.B');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should return empty array when no index exists', async () => {
            const project = createTestProject();
            try {
                const names = await resolver.getAllClassNames(project);
                expect(names).toEqual([]);
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('findJarForClass', () => {
        it('should find class from in-memory cache', async () => {
            const project = createTestProject();
            try {
                await projectCache.appendToClassIndex(project, [
                    { className: 'com.example.Foo', jarPath: '/path/to/test.jar', packageName: 'com.example', simpleName: 'Foo' },
                ]);

                const jarPath = await resolver.findJarForClass('com.example.Foo', project);
                expect(jarPath).toBe('/path/to/test.jar');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should throw when classpath is empty', async () => {
            const project = createTestProject();
            try {
                const pomHash = await projectCache.getPomHash(project);
                await projectCache.saveClasspath(project, [], pomHash);

                await expect(resolver.findJarForClass('unknown.Class', project))
                    .rejects.toThrow('Classpath not found');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should resolve simple name to fully qualified name when unique', async () => {
            const project = createTestProject();
            try {
                await projectCache.appendToClassIndex(project, [
                    { className: 'com.example.Foo', jarPath: '/path/to/test.jar', packageName: 'com.example', simpleName: 'Foo' },
                ]);

                const jarPath = await resolver.findJarForClass('Foo', project);
                expect(jarPath).toBe('/path/to/test.jar');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should search JARs on cache miss', async () => {
            const project = createTestProject();
            try {
                const jarPath = await createTestJar(project, 'test.jar', ['com.example.Bar']);
                const pomHash = await projectCache.getPomHash(project);
                await projectCache.saveClasspath(project, [jarPath], pomHash);

                const foundJar = await resolver.findJarForClass('com.example.Bar', project);
                expect(foundJar).toBe(jarPath);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should throw when classpath not found', async () => {
            const project = createTestProject();
            try {
                await expect(resolver.findJarForClass('com.example.Missing', project))
                    .rejects.toThrow('Classpath not found');
            } finally {
                await cleanupTestProject(project);
            }
        });
    });
});
