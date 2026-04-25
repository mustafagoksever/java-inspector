import { jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Import modules that have platform-specific code
import { JavaClassAnalyzer } from './analyzer/JavaClassAnalyzer.js';
import { DecompilerService } from './decompiler/DecompilerService.js';
import { DependencyScanner } from './scanner/DependencyScanner.js';
import { ProjectCache, projectCache } from './cache/ProjectCache.js';
import { getProjectCacheDir } from './utils/cachePaths.js';
import { extractMethod, extractMethodMap } from './utils/methodExtractor.js';
import { Logger } from './utils/Logger.js';
import { CrossProcessLock } from './utils/CrossProcessLock.js';

function createTestProject(): string {
    const dir = path.join(os.tmpdir(), `java-inspector-crossplat-test-${process.pid}-${Date.now()}`);
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

describe('Cross-Platform Compatibility', () => {
    const originalPlatform = process.platform;
    const originalJavaHome = process.env.JAVA_HOME;
    const originalMavenHome = process.env.MAVEN_HOME;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        if (originalJavaHome !== undefined) {
            process.env.JAVA_HOME = originalJavaHome;
        } else {
            delete process.env.JAVA_HOME;
        }
        if (originalMavenHome !== undefined) {
            process.env.MAVEN_HOME = originalMavenHome;
        } else {
            delete process.env.MAVEN_HOME;
        }
    });

    describe('JavaClassAnalyzer.getJavapCommand', () => {
        it('should use javap.exe on Windows when JAVA_HOME is set', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.JAVA_HOME = 'C:\\Program Files\\Java\\jdk-17';
            const analyzer = new JavaClassAnalyzer();
            const cmd = (analyzer as any).getJavapCommand();
            // path.join uses actual OS separator, so on Windows test we expect backslashes
            expect(cmd).toContain('javap');
            if (process.platform === 'win32') {
                expect(cmd).toContain('javap.exe');
                expect(cmd).toContain('\\');
            }
        });

        it('should use javap (no extension) on Linux when JAVA_HOME is set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.JAVA_HOME = '/usr/lib/jvm/java-17';
            const analyzer = new JavaClassAnalyzer();
            const cmd = (analyzer as any).getJavapCommand();
            expect(cmd).toContain('javap');
            expect(cmd).not.toContain('.exe');
            // The method uses path.join which respects the actual OS, but the logic uses process.platform
            // to decide the extension. We verify the core logic: no .exe when platform is linux.
        });

        it('should use javap (no extension) on macOS when JAVA_HOME is set', () => {
            Object.defineProperty(process, 'platform', { value: 'darwin' });
            process.env.JAVA_HOME = '/Library/Java/JavaVirtualMachines/jdk-17';
            const analyzer = new JavaClassAnalyzer();
            const cmd = (analyzer as any).getJavapCommand();
            expect(cmd).toContain('javap');
            expect(cmd).not.toContain('.exe');
        });

        it('should fallback to javap in PATH without JAVA_HOME', () => {
            delete process.env.JAVA_HOME;
            const analyzer = new JavaClassAnalyzer();
            const cmd = (analyzer as any).getJavapCommand();
            expect(cmd).toBe('javap');
        });
    });

    describe('DecompilerService.getJavaCommand', () => {
        it('should use java.exe on Windows when JAVA_HOME is set', () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.JAVA_HOME = 'C:\\Java';
            const service = new DecompilerService();
            const cmd = (service as any).getJavaCommand();
            expect(cmd).toContain('java');
            if (process.platform === 'win32') {
                expect(cmd).toContain('java.exe');
            }
        });

        it('should use java (no extension) on Linux when JAVA_HOME is set', () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.JAVA_HOME = '/opt/java';
            const service = new DecompilerService();
            const cmd = (service as any).getJavaCommand();
            expect(cmd).toContain('java');
            expect(cmd).not.toContain('.exe');
        });

        it('should use java (no extension) on macOS when JAVA_HOME is set', () => {
            Object.defineProperty(process, 'platform', { value: 'darwin' });
            process.env.JAVA_HOME = '/System/Library/Java';
            const service = new DecompilerService();
            const cmd = (service as any).getJavaCommand();
            expect(cmd).toContain('java');
            expect(cmd).not.toContain('.exe');
        });

        it('should fallback to java in PATH without JAVA_HOME', () => {
            delete process.env.JAVA_HOME;
            const service = new DecompilerService();
            const cmd = (service as any).getJavaCommand();
            expect(cmd).toBe('java');
        });
    });

    describe('DecompilerService path separators', () => {
        let projectPath: string;

        beforeEach(() => {
            projectPath = createTestProject();
        });

        afterEach(async () => {
            await cleanupTestProject(projectPath);
        });

        it('should use platform-specific separators in cache path', () => {
            const service = new DecompilerService();
            const cachePath = (service as any).getCachePath('com.example.MyClass', projectPath);
            // On Windows, path.sep is '\' but path.join normalizes everything
            // The key assertion is that the path is valid for the current platform
            expect(path.isAbsolute(cachePath)).toBe(true);
            expect(cachePath).toContain('com');
            expect(cachePath).toContain('example');
            expect(cachePath).toContain('MyClass.java');
        });
    });

    describe('ProjectCache JAR path handling', () => {
        let projectPath: string;

        beforeEach(() => {
            projectPath = createTestProject();
        });

        afterEach(async () => {
            await cleanupTestProject(projectPath);
        });

        it('should handle forward slashes in JAR paths', async () => {
            const cache = new ProjectCache();
            const entry = {
                className: 'com.example.Test',
                packageName: 'com.example',
                simpleName: 'Test',
                jarPath: '/home/user/.m2/repository/org/example/lib/1.0/lib-1.0.jar',
                jarIndex: 0,
            };
            await cache.appendToClassIndex(projectPath, [entry], undefined, undefined, 'pomhash', 'cphash');
            const retrieved = await cache.getEntry(projectPath, 'com.example.Test');
            expect(retrieved).toBeDefined();
            expect(retrieved!.jarPath).toBe('/home/user/.m2/repository/org/example/lib/1.0/lib-1.0.jar');
        });

        it('should handle backslashes in JAR paths', async () => {
            const cache = new ProjectCache();
            const entry = {
                className: 'com.example.Test',
                packageName: 'com.example',
                simpleName: 'Test',
                jarPath: 'C:\\Users\\user\\.m2\\repository\\org\\example\\lib\\1.0\\lib-1.0.jar',
                jarIndex: 0,
            };
            await cache.appendToClassIndex(projectPath, [entry], undefined, undefined, 'pomhash', 'cphash');
            const retrieved = await cache.getEntry(projectPath, 'com.example.Test');
            expect(retrieved).toBeDefined();
            expect(retrieved!.jarPath).toBe('C:\\Users\\user\\.m2\\repository\\org\\example\\lib\\1.0\\lib-1.0.jar');
        });

        it('should extract JAR filename from mixed separators', async () => {
            const cache = new ProjectCache();
            const entries = [
                {
                    className: 'com.example.Test',
                    packageName: 'com.example',
                    simpleName: 'Test',
                    jarPath: 'C:/Users/user/.m2\\repository/org/example/lib/1.0/lib-1.0.jar',
                    jarIndex: 0,
                },
            ];
            await cache.appendToClassIndex(projectPath, entries, undefined, undefined, 'pomhash', 'cphash');
            const index = await cache.getClassIndex(projectPath);
            const formatted = index!.classIndex.map((e: any) => `${e.className} -> ${e.jarPath.split(/[/\\]/).pop()}`);
            expect(formatted[0]).toBe('com.example.Test -> lib-1.0.jar');
        });
    });

    describe('methodExtractor with Windows line endings', () => {
        const windowsSource = 'public class Test {\r\n    public void hello() {\r\n        System.out.println("hi");\r\n    }\r\n    public int foo() {\r\n        return 1;\r\n    }\r\n}';
        const unixSource = 'public class Test {\n    public void hello() {\n        System.out.println("hi");\n    }\n    public int foo() {\n        return 1;\n    }\n}';

        it('should extract method with Windows \\r\\n line endings', () => {
            const method = extractMethod(windowsSource, 'hello');
            expect(method).toBeDefined();
            expect(method).toContain('System.out.println');
        });

        it('should extract method with Unix \\n line endings', () => {
            const method = extractMethod(unixSource, 'hello');
            expect(method).toBeDefined();
            expect(method).toContain('System.out.println');
        });

        it('should build method map with Windows line endings', () => {
            const methods = extractMethodMap(windowsSource);
            expect(methods.length).toBe(2);
            expect(methods[0].name).toBe('hello');
            expect(methods[1].name).toBe('foo');
        });

        it('should build method map with Unix line endings', () => {
            const methods = extractMethodMap(unixSource);
            expect(methods.length).toBe(2);
            expect(methods[0].name).toBe('hello');
            expect(methods[1].name).toBe('foo');
        });
    });

    describe('cachePaths platform handling', () => {
        let projectPath: string;

        beforeEach(() => {
            projectPath = createTestProject();
        });

        afterEach(async () => {
            await cleanupTestProject(projectPath);
        });

        it('should produce platform-native paths for cache directories', () => {
            const cacheDir = getProjectCacheDir(projectPath);
            expect(cacheDir).toContain(path.sep);
            expect(cacheDir).toContain('java-inspector');
        });

        it('should handle absolute paths on all platforms', () => {
            const absPath = path.isAbsolute(projectPath);
            expect(absPath).toBe(true);
            const cacheDir = getProjectCacheDir(projectPath);
            expect(path.isAbsolute(cacheDir)).toBe(true);
        });
    });

    describe('Logger file writing', () => {
        let projectPath: string;

        beforeEach(() => {
            projectPath = createTestProject();
        });

        afterEach(async () => {
            await cleanupTestProject(projectPath);
        });

        it('should create log files with platform-native paths', () => {
            const logger = Logger.get(projectPath);
            logger.info('test message');
            const logFile = (logger as any).logFile;
            expect(fs.existsSync(logFile)).toBe(true);
            expect(logFile).toContain(path.sep);
        });
    });

    describe('DependencyScanner execFile shell option', () => {
        let projectPath: string;
        let scanner: DependencyScanner;

        beforeEach(() => {
            projectPath = createTestProject();
            (DependencyScanner as any).instance = undefined;
            scanner = new DependencyScanner();
            (scanner as any).mavenCommand = null;
        });

        afterEach(async () => {
            await cleanupTestProject(projectPath);
        });

        it('should configure shell=true on Windows', async () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            process.env.MAVEN_CMD = 'mvn';

            const logger = Logger.get(projectPath);
            const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});

            try {
                await (scanner as any).getBuildClasspath(projectPath, undefined);
            } catch {
                // Maven will fail, but we only care about the logged config
            }

            const shellLog = debugSpy.mock.calls.find((call: any) =>
                call[0].includes('shell=true')
            );
            expect(shellLog).toBeDefined();
            debugSpy.mockRestore();
        }, 15000);

        it('should configure shell=false on Linux', async () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            process.env.MAVEN_CMD = 'mvn';

            const logger = Logger.get(projectPath);
            const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});

            try {
                await (scanner as any).getBuildClasspath(projectPath, undefined);
            } catch {
                // Maven will fail, but we only care about the logged config
            }

            const shellLog = debugSpy.mock.calls.find((call: any) =>
                call[0].includes('shell=false')
            );
            expect(shellLog).toBeDefined();
            debugSpy.mockRestore();
        });
    });
});
