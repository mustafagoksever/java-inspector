import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import archiver from 'archiver';
import { BackgroundScanner } from './BackgroundScanner.js';
import { projectCache } from '../cache/ProjectCache.js';
import { Logger } from '../utils/Logger.js';

function createTestProject(): string {
    const dir = path.join(os.tmpdir(), `java-inspector-bg-test-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>', 'utf-8');
    return dir;
}

async function cleanupTestProject(projectPath: string): Promise<void> {
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

describe('BackgroundScanner', () => {
    let scanner: BackgroundScanner;

    beforeEach(() => {
        scanner = new BackgroundScanner();
    });

    describe('state management', () => {
        it('should start a scan and mark as scanning', async () => {
            const project = createTestProject();
            try {
                const jarPath = await createTestJar(project, 'test.jar', ['com.example.Foo']);
                expect(scanner.isScanning(project)).toBe(false);

                const promise = scanner.start(project, [jarPath]);
                expect(scanner.isScanning(project)).toBe(true);

                await promise;
                expect(scanner.isScanning(project)).toBe(false);
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should get scan state', async () => {
            const project = createTestProject();
            try {
                const jarPath = await createTestJar(project, 'test.jar', ['com.example.Foo']);
                const promise = scanner.start(project, [jarPath]);

                const state = scanner.getState(project);
                expect(state).toBeDefined();
                expect(state!.total).toBe(1);
                expect(state!.isComplete).toBe(false);

                await promise;
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should return existing promise if already scanning', async () => {
            const project = createTestProject();
            try {
                const jarPath = await createTestJar(project, 'test.jar', ['com.example.Foo']);
                const promise1 = scanner.start(project, [jarPath]);
                const promise2 = scanner.start(project, [jarPath]);

                expect(promise1).toBe(promise2);
                await promise1;
            } finally {
                await cleanupTestProject(project);
            }
        });

        it('should reset scan state', async () => {
            const project = createTestProject();
            try {
                const jarPath = await createTestJar(project, 'test.jar', ['com.example.Foo']);
                await scanner.start(project, [jarPath]);
                expect(scanner.isScanning(project)).toBe(false);

                scanner.reset(project);
                expect(scanner.getState(project)).toBeUndefined();
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('batch processing', () => {
        it('should process multiple JARs in batches', async () => {
            const project = createTestProject();
            try {
                const jarPaths: string[] = [];
                for (let i = 0; i < 25; i++) {
                    jarPaths.push(await createTestJar(project, `lib${i}.jar`, [`com.example.Class${i}`]));
                }

                await scanner.start(project, jarPaths);
                const state = scanner.getState(project);
                expect(state).toBeDefined();
                expect(state!.isComplete).toBe(true);
                expect(state!.processed).toBe(25);

                const index = await projectCache.getClassIndex(project);
                expect(index).not.toBeNull();
                expect(index!.classCount).toBe(25);
            } finally {
                await cleanupTestProject(project);
            }
        }, 30000);

        it('should skip inner classes', async () => {
            const project = createTestProject();
            try {
                const jarPath = await createTestJar(project, 'test.jar', [
                    'com.example.Outer',
                    'com.example.Outer$Inner',
                    'com.example.Outer$1',
                ]);

                await scanner.start(project, [jarPath]);
                const index = await projectCache.getClassIndex(project);
                expect(index!.classCount).toBe(1);
                expect(index!.classIndex[0].className).toBe('com.example.Outer');
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('resume logic', () => {
        it('should resume from partial index', async () => {
            const project = createTestProject();
            try {
                const jar1 = await createTestJar(project, 'a.jar', ['com.example.A']);
                const jar2 = await createTestJar(project, 'b.jar', ['com.example.B']);

                // Simulate partial scan
                const pomHash = await projectCache.getPomHash(project);
                await projectCache.appendToClassIndex(project, [
                    { className: 'com.example.A', jarPath: jar1, packageName: 'com.example', simpleName: 'A' },
                ], [jar1], 2, pomHash, '');

                await scanner.start(project, [jar1, jar2]);
                const index = await projectCache.getClassIndex(project);
                expect(index!.classCount).toBe(2);
            } finally {
                await cleanupTestProject(project);
            }
        });
    });

    describe('progress callback', () => {
        it('should call progress callback during scan', async () => {
            const project = createTestProject();
            try {
                const jarPaths: string[] = [];
                for (let i = 0; i < 5; i++) {
                    jarPaths.push(await createTestJar(project, `lib${i}.jar`, [`com.example.Class${i}`]));
                }

                const progressMessages: string[] = [];
                await scanner.start(project, jarPaths, undefined, undefined, async (msg) => {
                    progressMessages.push(msg);
                });

                expect(progressMessages.length).toBeGreaterThan(0);
                expect(progressMessages[progressMessages.length - 1]).toContain('complete');
            } finally {
                await cleanupTestProject(project);
            }
        });
    });
});
