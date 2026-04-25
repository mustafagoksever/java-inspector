import { jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DependencyScanner } from './DependencyScanner.js';
import { projectCache } from '../cache/ProjectCache.js';
import { CrossProcessLock } from '../utils/CrossProcessLock.js';
import { Logger } from '../utils/Logger.js';

function createTestProject(): string {
    const dir = path.join(os.tmpdir(), `java-inspector-dep-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>', 'utf-8');
    return dir;
}

async function cleanupTestProject(projectPath: string): Promise<void> {
    try {
        await CrossProcessLock.release(projectPath, 'scan');
        await CrossProcessLock.release(projectPath, 'write');
    } catch { /* ignore */ }
    try {
        await projectCache.invalidate(projectPath);
    } catch { /* ignore */ }
    try {
        if (fs.existsSync(projectPath)) {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }
    } catch { /* ignore */ }
    Logger.clearLog(projectPath);
}

describe('DependencyScanner', () => {
    let scanner: DependencyScanner;
    const originalMavenCmd = process.env.MAVEN_CMD;
    const originalMavenHome = process.env.MAVEN_HOME;

    beforeEach(() => {
        (DependencyScanner as any).instance = undefined;
        scanner = new DependencyScanner();
        (scanner as any).mavenCommand = null;
        delete process.env.MAVEN_CMD;
        delete process.env.MAVEN_HOME;
    });

    afterEach(() => {
        if (originalMavenCmd !== undefined) {
            process.env.MAVEN_CMD = originalMavenCmd;
        } else {
            delete process.env.MAVEN_CMD;
        }
        if (originalMavenHome !== undefined) {
            process.env.MAVEN_HOME = originalMavenHome;
        } else {
            delete process.env.MAVEN_HOME;
        }
    });

    describe('resolveMavenCommand', () => {
        it('should prefer MAVEN_CMD env var', async () => {
            process.env.MAVEN_CMD = '/custom/mvn';
            const cmd = await (scanner as any).resolveMavenCommand('/tmp/project');
            expect(cmd).toBe('/custom/mvn');
        });

        it('should cache resolved command', async () => {
            process.env.MAVEN_CMD = '/cached/mvn';
            const cmd1 = await (scanner as any).resolveMavenCommand('/tmp/project');
            const cmd2 = await (scanner as any).resolveMavenCommand('/tmp/project');
            expect(cmd1).toBe(cmd2);
            expect(cmd1).toBe('/cached/mvn');
        });
    });

    describe('scanProject state machine', () => {
        it('should return complete when cached index exists', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await projectCache.getPomHash(project);
                const classpathHash = projectCache.getClasspathHash(jars);
                await projectCache.saveClasspath(project, jars, pomHash);
                await projectCache.appendToClassIndex(project, [], jars, 1, pomHash, classpathHash);
                await projectCache.saveClassIndex(project, { jarCount: 1, sampleEntries: [] }, pomHash, classpathHash);

                const result = await scanner.scanProject(project);
                expect(result.status).toBe('complete');
                expect(result.jarCount).toBe(1);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should return in_progress when another process holds scan lock', async () => {
            const project = createTestProject();
            try {
                await CrossProcessLock.acquire(project, 'scan');

                const result = await scanner.scanProject(project);
                expect(result.status).toBe('in_progress');
                expect(result.message).toContain('Another process');
            } finally {
                await CrossProcessLock.release(project, 'scan');
                await cleanupTestProject(project);
            }
        });

        it('should start background scan when cached classpath exists', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar', '/b.jar'];
                const pomHash = await projectCache.getPomHash(project);
                await projectCache.saveClasspath(project, jars, pomHash);

                const result = await scanner.scanProject(project);
                expect(result.status).toBe('in_progress');
                expect(result.jarCount).toBe(2);
                expect(result.progress).toEqual({ processed: 0, total: 2 });
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should return in_progress when classpath resolution already in progress', async () => {
            const project = createTestProject();
            try {
                // Simulate in-progress classpath resolution
                (scanner as any).classpathPromises.set(project, new Promise(() => {}));

                const result = await scanner.scanProject(project);
                expect(result.status).toBe('in_progress');
                expect(result.message).toContain('Maven classpath');
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('forceRefresh should invalidate cache and restart', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await projectCache.getPomHash(project);
                const classpathHash = projectCache.getClasspathHash(jars);
                await projectCache.saveClasspath(project, jars, pomHash);
                await projectCache.saveClassIndex(project, { jarCount: 1, sampleEntries: [] }, pomHash, classpathHash);

                // First call should be complete
                const result1 = await scanner.scanProject(project);
                expect(result1.status).toBe('complete');

                // Mock background classpath resolution to avoid real Maven execution
                const resolveSpy = jest.spyOn(scanner as any, 'resolveClasspathAndStartScan').mockResolvedValue(undefined);

                // forceRefresh should invalidate and return in_progress
                const result2 = await scanner.scanProject(project, true);
                expect(result2.status).toBe('in_progress');
                expect(await projectCache.isIndexComplete(project)).toBe(false);

                resolveSpy.mockRestore();
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('utility methods', () => {
        it('isResolvingClasspath should return true when promise exists', async () => {
            const project = createTestProject();
            try {
                expect(scanner.isResolvingClasspath(project)).toBe(false);
                (scanner as any).classpathPromises.set(project, Promise.resolve([]));
                expect(scanner.isResolvingClasspath(project)).toBe(true);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('getScanProgress should delegate to ProjectCache', async () => {
            const project = createTestProject();
            try {
                const jars = ['/a.jar'];
                const pomHash = await projectCache.getPomHash(project);
                await projectCache.saveClasspath(project, jars, pomHash);
                await projectCache.appendToClassIndex(project, [], jars, 1);

                const progress = await scanner.getScanProgress(project);
                expect(progress).toEqual({ processed: 1, total: 1 });
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('isIndexComplete should delegate to ProjectCache', async () => {
            const project = createTestProject();
            try {
                expect(await scanner.isIndexComplete(project)).toBe(false);

                const jars = ['/a.jar'];
                const pomHash = await projectCache.getPomHash(project);
                const classpathHash = projectCache.getClasspathHash(jars);
                await projectCache.saveClasspath(project, jars, pomHash);
                await projectCache.saveClassIndex(project, { jarCount: 1, sampleEntries: [] }, pomHash, classpathHash);

                expect(await scanner.isIndexComplete(project)).toBe(true);
            } finally {
                await cleanupTestProject(project);
            }
        });
    });
});
