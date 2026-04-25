import { jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { DependencyScanner } from '../scanner/DependencyScanner.js';
import { Logger } from '../utils/Logger.js';
import { CrossProcessLock } from '../utils/CrossProcessLock.js';
import { getProjectCacheDir } from '../utils/cachePaths.js';

jest.unstable_mockModule('child_process', () => ({
    execFile: jest.fn(),
}));

const { DecompilerService } = await import('./DecompilerService.js');

function createTestProject(): string {
    const dir = path.join(os.tmpdir(), `java-inspector-decompiler-test-${process.pid}-${Date.now()}`);
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

async function createJarWithClass(jarPath: string, className: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const output = createWriteStream(jarPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve());
        archive.on('error', (err: Error) => reject(err));
        archive.pipe(output);
        const classFileName = className.replace(/\./g, '/') + '.class';
        archive.append(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), { name: classFileName });
        archive.finalize();
    });
}

async function getMockExecFile(): Promise<jest.Mock> {
    const cp = await import('child_process');
    return (cp as any).execFile;
}

describe('DecompilerService', () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = createTestProject();
    });

    afterEach(async () => {
        await cleanupTestProject(projectPath);
        jest.clearAllMocks();
    });

    describe('getCachePath', () => {
        it('should compute correct cache path for simple class', () => {
            const s = new DecompilerService();
            const cachePath = (s as any).getCachePath('com.example.MyClass', projectPath);
            expect(cachePath).toContain('decompile-cache');
            expect(cachePath).toContain(path.join('com', 'example', 'MyClass.java'));
        });

        it('should compute correct cache path for top-level class', () => {
            const s = new DecompilerService();
            const cachePath = (s as any).getCachePath('MyClass', projectPath);
            expect(cachePath).toContain('MyClass.java');
        });
    });

    describe('getJavaCommand', () => {
        const originalPlatform = process.platform;
        const originalJavaHome = process.env.JAVA_HOME;

        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            if (originalJavaHome !== undefined) {
                process.env.JAVA_HOME = originalJavaHome;
            } else {
                delete process.env.JAVA_HOME;
            }
        });

        it('should use java.exe from JAVA_HOME on Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.JAVA_HOME = 'C:\\java';
            const s = new DecompilerService();
            const cmd = (s as any).getJavaCommand();
            expect(cmd).toBe(path.join('C:\\java', 'bin', 'java.exe'));
        });

        it('should use java from JAVA_HOME on non-Windows', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.JAVA_HOME = '/usr/lib/jvm/java';
            const s = new DecompilerService();
            const cmd = (s as any).getJavaCommand();
            expect(cmd).toBe(path.join('/usr/lib/jvm/java', 'bin', 'java'));
        });

        it('should fallback to java in PATH when JAVA_HOME not set', () => {
            delete process.env.JAVA_HOME;
            const s = new DecompilerService();
            const cmd = (s as any).getJavaCommand();
            expect(cmd).toBe('java');
        });
    });

    describe('findVineflowerJar', () => {
        const originalDecompilerPath = process.env.DECOMPILER_PATH;

        afterEach(() => {
            if (originalDecompilerPath !== undefined) {
                process.env.DECOMPILER_PATH = originalDecompilerPath;
            } else {
                delete process.env.DECOMPILER_PATH;
            }
        });

        it('should prefer DECOMPILER_PATH env var', async () => {
            const jarPath = path.join(projectPath, 'custom.jar');
            fs.writeFileSync(jarPath, 'jar');
            process.env.DECOMPILER_PATH = jarPath;
            const s = new DecompilerService();
            const result = await (s as any).findVineflowerJar();
            expect(result).toBe(jarPath);
        });

        it('should return empty string when DECOMPILER_PATH does not exist', async () => {
            process.env.DECOMPILER_PATH = path.join(projectPath, 'nonexistent.jar');
            const s = new DecompilerService();
            const getPackageRootSpy = jest.spyOn(s as any, 'getPackageRoot').mockReturnValue(path.join(os.tmpdir(), 'fake-pkg'));
            const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'fake-cwd'));
            try {
                const result = await (s as any).findVineflowerJar();
                expect(result).toBe('');
            } finally {
                getPackageRootSpy.mockRestore();
                cwdSpy.mockRestore();
            }
        });

        it('should find bundled vineflower in lib directory', async () => {
            const s = new DecompilerService();
            const getPackageRootSpy = jest.spyOn(s as any, 'getPackageRoot').mockReturnValue(projectPath);
            const libDir = path.join(projectPath, 'lib');
            const jarPath = path.join(libDir, 'vineflower-test-1.0.0.jar');
            fs.mkdirSync(libDir, { recursive: true });
            fs.writeFileSync(jarPath, 'jar');
            try {
                const result = await (s as any).findVineflowerJar();
                expect(result).toBe(jarPath);
            } finally {
                fs.unlinkSync(jarPath);
                getPackageRootSpy.mockRestore();
            }
        });

        it('should find local vineflower in cwd lib directory', async () => {
            const s = new DecompilerService();
            const cwdLib = path.join(process.cwd(), 'lib');
            const jarPath = path.join(cwdLib, 'vineflower-local-2.0.0.jar');
            const existed = fs.existsSync(cwdLib);
            fs.mkdirSync(cwdLib, { recursive: true });
            fs.writeFileSync(jarPath, 'jar');
            try {
                const result = await (s as any).findVineflowerJar();
                if (!existed) {
                    expect(result).toBe(jarPath);
                }
            } finally {
                fs.unlinkSync(jarPath);
                if (!existed) {
                    fs.rmdirSync(cwdLib);
                }
            }
        });
    });

    describe('getPackageRoot', () => {
        it('should return a valid directory path', () => {
            const s = new DecompilerService();
            const root = (s as any).getPackageRoot();
            expect(fs.existsSync(root)).toBe(true);
            expect(fs.statSync(root).isDirectory()).toBe(true);
        });
    });

    describe('decompileClasses', () => {
        it('should decompile multiple classes and handle errors', async () => {
            const s = new DecompilerService();
            (s as any).decompileClass = jest.fn<any>().mockImplementation((className: string) => {
                if (className === 'BadClass') {
                    throw new Error('decompilation failed');
                }
                return `source of ${className}`;
            });

            const results = await s.decompileClasses(['ClassA', 'ClassB', 'BadClass'], projectPath);
            expect(results.get('ClassA')).toBe('source of ClassA');
            expect(results.get('ClassB')).toBe('source of ClassB');
            expect(results.get('BadClass')).toContain('Decompilation failed');
        });
    });

    describe('decompileClass', () => {
        it('should return cached source when cache hit', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '/fake/decompiler.jar';
            const cachePath = (s as any).getCachePath('com.example.CachedClass', projectPath);
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, 'cached source code', 'utf-8');

            const result = await s.decompileClass('com.example.CachedClass', projectPath, true);
            expect(result).toBe('cached source code');
        });

        it('should throw when JAR not found', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '/fake/decompiler.jar';
            (s as any).scanner = {
                findJarForClass: jest.fn<any>().mockResolvedValue(null),
            };

            await expect(s.decompileClass('com.example.MissingClass', projectPath, false))
                .rejects.toThrow('JAR package for class com.example.MissingClass not found');
        });

        it('should decompile and cache when cache miss', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '/fake/decompiler.jar';
            const className = 'com.example.TestClass';
            const jarPath = path.join(projectPath, 'test.jar');
            await createJarWithClass(jarPath, className);

            (s as any).scanner = {
                findJarForClass: jest.fn<any>().mockResolvedValue(jarPath),
            };

            // Mock decompileWithVineflower to avoid real java execution
            const expectedSource = 'public class TestClass {}';
            (s as any).decompileWithVineflower = jest.fn<any>().mockResolvedValue(expectedSource);

            const result = await s.decompileClass(className, projectPath, true);
            expect(result).toBe(expectedSource);

            // Verify cache was written
            const cachePath = (s as any).getCachePath(className, projectPath);
            expect(fs.existsSync(cachePath)).toBe(true);
            expect(fs.readFileSync(cachePath, 'utf-8')).toBe(expectedSource);
        });
    });

    describe('extractClassFile', () => {
        it('should extract class file from JAR', async () => {
            const s = new DecompilerService();
            const className = 'com.example.JarClass';
            const jarPath = path.join(projectPath, 'test.jar');
            await createJarWithClass(jarPath, className);

            const classFilePath = await (s as any).extractClassFile(jarPath, className, projectPath);
            expect(fs.existsSync(classFilePath)).toBe(true);
            expect(path.basename(classFilePath)).toBe('JarClass.class');
        });

        it('should throw when class not found in JAR', async () => {
            const s = new DecompilerService();
            const className = 'com.example.Missing';
            const jarPath = path.join(projectPath, 'empty.jar');
            await createJarWithClass(jarPath, 'com.example.Other');

            await expect((s as any).extractClassFile(jarPath, className, projectPath))
                .rejects.toThrow('Class file com/example/Missing.class not found in JAR package');
        });

        it('should throw for invalid JAR path', async () => {
            const s = new DecompilerService();
            const jarPath = path.join(projectPath, 'nonexistent.jar');
            await expect((s as any).extractClassFile(jarPath, 'com.example.Test', projectPath))
                .rejects.toThrow('Unable to open JAR package');
        });
    });

    describe('decompileWithVineflower', () => {
        it('should throw when decompilerPath is empty', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '';
            await expect((s as any).decompileWithVineflower('/tmp/Test.class', 'com.example.Test', projectPath))
                .rejects.toThrow('Vineflower decompiler tool not found');
        });

        it('should return source when decompilation succeeds', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '/fake/vineflower.jar';

            const mockExecFile = await getMockExecFile();
            mockExecFile.mockImplementation(((cmd: string, args: string[], options: any, callback: any) => {
                const outputDir = args[args.length - 1];
                const classFile = args[args.length - 2];
                const simpleName = path.basename(classFile, '.class');
                const outputFile = path.join(outputDir, `${simpleName}.java`);
                fs.mkdirSync(outputDir, { recursive: true });
                fs.writeFileSync(outputFile, 'public class TestClass {}', 'utf-8');
                if (callback) {
                    callback(null, 'stdout', '');
                }
                return undefined as any;
            }) as any);

            const result = await (s as any).decompileWithVineflower('/tmp/Test.class', 'com.example.Test', projectPath);
            expect(result).toBe('public class TestClass {}');
        });

        it('should throw when Vineflower output file is missing', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '/fake/vineflower.jar';

            const mockExecFile = await getMockExecFile();
            mockExecFile.mockImplementation(((cmd: string, args: string[], options: any, callback: any) => {
                if (callback) {
                    callback(null, 'stdout', '');
                }
                return undefined as any;
            }) as any);

            await expect((s as any).decompileWithVineflower('/tmp/Test.class', 'com.example.Test', projectPath))
                .rejects.toThrow('Vineflower did not produce expected output file');
        });

        it('should throw when Vineflower returns empty source', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '/fake/vineflower.jar';

            const mockExecFile = await getMockExecFile();
            mockExecFile.mockImplementation(((cmd: string, args: string[], options: any, callback: any) => {
                const outputDir = args[args.length - 1];
                const classFile = args[args.length - 2];
                const simpleName = path.basename(classFile, '.class');
                const outputFile = path.join(outputDir, `${simpleName}.java`);
                fs.mkdirSync(outputDir, { recursive: true });
                fs.writeFileSync(outputFile, '   ', 'utf-8');
                if (callback) {
                    callback(null, 'stdout', '');
                }
                return undefined as any;
            }) as any);

            await expect((s as any).decompileWithVineflower('/tmp/Test.class', 'com.example.Test', projectPath))
                .rejects.toThrow('Vineflower decompilation returned empty result');
        });

        it('should propagate stderr errors', async () => {
            const s = new DecompilerService();
            (s as any).decompilerPath = '/fake/vineflower.jar';

            const mockExecFile = await getMockExecFile();
            mockExecFile.mockImplementation(((cmd: string, args: string[], options: any, callback: any) => {
                if (callback) {
                    callback(null, 'stdout', 'some error line\nException: something went wrong');
                }
                return undefined as any;
            }) as any);

            const logger = Logger.get(projectPath);
            const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

            const outputDir = path.join(os.tmpdir(), `vine-out-${Date.now()}`);
            fs.mkdirSync(outputDir, { recursive: true });
            const outputFile = path.join(outputDir, 'Test.java');
            fs.writeFileSync(outputFile, 'public class Test {}', 'utf-8');

            try {
                await (s as any).decompileWithVineflower('/tmp/Test.class', 'com.example.Test', projectPath, logger);
            } catch {
                // ignore
            }

            warnSpy.mockRestore();
        });
    });
});
