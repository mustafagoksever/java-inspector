import { jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { JavaClassAnalyzerMCPServer } from './index.js';
import { Logger } from './utils/Logger.js';
import { CrossProcessLock } from './utils/CrossProcessLock.js';
import { getProjectCacheDir } from './utils/cachePaths.js';
import { jarIndexer } from './scanner/JarIndexer.js';

function createTestProject(): string {
    const dir = path.join(os.tmpdir(), `java-inspector-server-test-${process.pid}-${Date.now()}`);
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

describe('JavaClassAnalyzerMCPServer', () => {
    let server: JavaClassAnalyzerMCPServer;

    beforeEach(() => {
        server = new JavaClassAnalyzerMCPServer();
    });

    afterEach(async () => {
        delete process.env.NODE_ENV;
    });

    describe('tool registry', () => {
        it('exposes the v3 lazy artifact tool set', async () => {
            const handler = (server as any).server._requestHandlers.get('tools/list');
            const result = await handler({ method: 'tools/list', params: {} }, {});
            expect(result.tools.map((tool: any) => tool.name)).toEqual([
                'scan_project',
                'find_jar',
                'inspect_jar',
                'search_class',
                'search_code',
                'find_implementations',
                'inspect_class',
                'explain_dependency',
                'search_resources',
                'read_resource',
            ]);
            const inspectClass = result.tools.find((tool: any) => tool.name === 'inspect_class');
            expect(inspectClass.inputSchema.properties).not.toHaveProperty('decompilerPath');
        });
    });

    describe('v3 selector and extracted class cache', () => {
        it('defaults an omitted artifact selector to the current workspace', async () => {
            const selector = await (server as any).selectorFromArgs({}, true);
            expect(selector.workspacePath).toBe(path.resolve(process.cwd()));
        });

        it('uses collision-safe paths for equal simple class names in one JAR', async () => {
            const projectPath = createTestProject();
            const jarPath = path.resolve('lib', 'vineflower-1.11.2.jar');
            try {
                const first = await (server as any).getInspectionClassFile({
                    className: 'com.first.User', jarPath, packageName: 'com.first', simpleName: 'User', score: 1, origin: 'direct', contextPath: projectPath,
                }, 'BOOT-INF/classes/com/first/User.class', projectPath, Buffer.from([1]));
                const second = await (server as any).getInspectionClassFile({
                    className: 'com.second.User', jarPath, packageName: 'com.second', simpleName: 'User', score: 1, origin: 'direct', contextPath: projectPath,
                }, 'BOOT-INF/classes/com/second/User.class', projectPath, Buffer.from([2]));
                expect(first).not.toBe(second);
                expect(fs.readFileSync(first)).toEqual(Buffer.from([1]));
                expect(fs.readFileSync(second)).toEqual(Buffer.from([2]));
            } finally {
                await cleanupTestProject(projectPath);
            }
        });

        it('resolves a superclass located in the same directly selected JAR', async () => {
            const projectPath = createTestProject();
            const jarPath = path.resolve('lib', 'vineflower-1.11.2.jar');
            try {
                const deep = await jarIndexer.getDeepIndex(jarPath, projectPath);
                const names = new Set(deep.classes.map(clazz => clazz.className));
                const child = deep.classes.find(clazz => clazz.superClass && names.has(clazz.superClass));
                expect(child?.superClass).toBeDefined();
                const hierarchy = await (server as any).resolveHierarchy({
                    className: child!.className,
                    jarPath,
                    packageName: child!.className.substring(0, child!.className.lastIndexOf('.')),
                    simpleName: child!.className.substring(child!.className.lastIndexOf('.') + 1),
                    score: 1,
                    origin: 'direct',
                    contextPath: projectPath,
                }, { jarPath }, projectPath, child!.entryPath);
                expect(hierarchy).toEqual(expect.arrayContaining([
                    expect.objectContaining({ className: child!.superClass, resolved: true }),
                    expect.objectContaining({ className: child!.className, resolved: true }),
                ]));
            } finally {
                await cleanupTestProject(projectPath);
            }
        });
    });

    describe('applyFilter', () => {
        const analysis = {
            fields: [
                { name: 'publicField', modifiers: ['public'] },
                { name: 'privateField', modifiers: ['private'] },
                { name: 'protectedField', modifiers: ['protected'] },
            ],
            methods: [
                { name: 'publicMethod', modifiers: ['public'] },
                { name: 'privateMethod', modifiers: ['private'] },
                { name: 'protectedMethod', modifiers: ['protected'] },
            ],
        };

        it('should return everything for filter=all', () => {
            const result = (server as any).applyFilter(analysis, 'all');
            expect(result.fields).toHaveLength(3);
            expect(result.methods).toHaveLength(3);
        });

        it('should return only fields for filter=fields', () => {
            const result = (server as any).applyFilter(analysis, 'fields');
            expect(result.fields).toHaveLength(3);
            expect(result.methods).toHaveLength(0);
        });

        it('should return only methods for filter=methods', () => {
            const result = (server as any).applyFilter(analysis, 'methods');
            expect(result.fields).toHaveLength(0);
            expect(result.methods).toHaveLength(3);
        });

        it('should filter by public modifier', () => {
            const result = (server as any).applyFilter(analysis, 'public');
            expect(result.fields).toHaveLength(1);
            expect(result.methods).toHaveLength(1);
            expect(result.fields[0].name).toBe('publicField');
            expect(result.methods[0].name).toBe('publicMethod');
        });

        it('should filter by private modifier', () => {
            const result = (server as any).applyFilter(analysis, 'private');
            expect(result.fields).toHaveLength(1);
            expect(result.methods).toHaveLength(1);
            expect(result.fields[0].name).toBe('privateField');
            expect(result.methods[0].name).toBe('privateMethod');
        });

        it('should filter by protected modifier', () => {
            const result = (server as any).applyFilter(analysis, 'protected');
            expect(result.fields).toHaveLength(1);
            expect(result.methods).toHaveLength(1);
            expect(result.fields[0].name).toBe('protectedField');
            expect(result.methods[0].name).toBe('protectedMethod');
        });
    });

    describe('formatResponse', () => {
        const text = 'hello world';
        const structured = { key: 'value' };

        it('should return text format by default', () => {
            const result = (server as any).formatResponse(text, structured, 'text');
            expect(result.content[0].text).toBe(text);
        });

        it('should return JSON for json format', () => {
            const result = (server as any).formatResponse(text, structured, 'json');
            expect(result.content[0].text).toBe(JSON.stringify(structured, null, 2));
        });

        it('should return toon for toon format', () => {
            const result = (server as any).formatResponse(text, structured, 'toon');
            expect(typeof result.content[0].text).toBe('string');
            expect(result.content[0].text.length).toBeGreaterThan(0);
        });

        it('should fallback to text when toon encoding fails', () => {
            const circular: any = {};
            circular.self = circular;
            const result = (server as any).formatResponse(text, circular, 'toon');
            expect(result.content[0].text).toBe(text);
        });
    });

    describe('validateProjectPath', () => {
        let projectPath: string;

        beforeEach(() => {
            projectPath = createTestProject();
        });

        afterEach(async () => {
            await cleanupTestProject(projectPath);
        });

        it('should throw when projectPath is missing', async () => {
            await expect((server as any).validateProjectPath('')).rejects.toThrow('projectPath is required');
            await expect((server as any).validateProjectPath(undefined)).rejects.toThrow('projectPath is required');
        });

        it('should throw when projectPath is not absolute', async () => {
            await expect((server as any).validateProjectPath('relative/path')).rejects.toThrow('must be an absolute path');
        });

        it('should throw when projectPath does not exist', async () => {
            const nonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
            await expect((server as any).validateProjectPath(nonExistent)).rejects.toThrow('does not exist');
        });

        it('should throw when projectPath is not a directory', async () => {
            const filePath = path.join(projectPath, 'file.txt');
            fs.writeFileSync(filePath, 'test');
            await expect((server as any).validateProjectPath(filePath)).rejects.toThrow('not a directory');
        });

        it('should throw when pom.xml is missing', async () => {
            const noPomDir = path.join(os.tmpdir(), `no-pom-${process.pid}-${Date.now()}`);
            fs.mkdirSync(noPomDir, { recursive: true });
            await expect((server as any).validateProjectPath(noPomDir)).rejects.toThrow('No pom.xml found');
            fs.rmSync(noPomDir, { recursive: true, force: true });
        });

        it('should not throw for valid Maven project', async () => {
            await expect((server as any).validateProjectPath(projectPath)).resolves.toBeUndefined();
        });
    });

    describe('getDebugEnv', () => {
        it('should return relevant environment variables', () => {
            const env = (server as any).getDebugEnv();
            expect(env).toHaveProperty('NODE_ENV');
            expect(env).toHaveProperty('JAVA_HOME');
            expect(env).toHaveProperty('MAVEN_HOME');
            expect(env).toHaveProperty('MAVEN_CMD');
            expect(env).toHaveProperty('MAVEN_REPO');
            expect(env).toHaveProperty('DECOMPILER_PATH');
        });
    });

    describe('logToolDebug', () => {
        it('should not log in production mode', () => {
            process.env.NODE_ENV = 'production';
            const projectPath = createTestProject();
            const logger = Logger.get(projectPath);
            const spy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
            (server as any).logToolDebug(logger, 'test_tool', '/tmp/project', { extra: true });
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
            Logger.clearLog(projectPath);
        });

        it('should log in development mode', () => {
            process.env.NODE_ENV = 'development';
            const projectPath = createTestProject();
            const logger = Logger.get(projectPath);
            const spy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
            (server as any).logToolDebug(logger, 'test_tool', '/tmp/project', { extra: true });
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
            Logger.clearLog(projectPath);
        });
    });

    describe('ensureScanStarted', () => {
        let projectPath: string;

        beforeEach(() => {
            projectPath = createTestProject();
        });

        afterEach(async () => {
            await cleanupTestProject(projectPath);
        });

        it('should return immediately when index is complete', async () => {
            const mockScanner = {
                isIndexComplete: jest.fn<any>().mockResolvedValue(true),
                getClasspath: jest.fn<any>(),
                scanProject: jest.fn<any>(),
            };
            (server as any).scanner = mockScanner;

            await (server as any).ensureScanStarted(projectPath);
            expect(mockScanner.isIndexComplete).toHaveBeenCalledWith(projectPath);
            expect(mockScanner.getClasspath).not.toHaveBeenCalled();
            expect(mockScanner.scanProject).not.toHaveBeenCalled();
        });

        it('should return when classpath exists but index is incomplete', async () => {
            const mockScanner = {
                isIndexComplete: jest.fn<any>().mockResolvedValue(false),
                getClasspath: jest.fn<any>().mockResolvedValue(['some.jar']),
                scanProject: jest.fn<any>(),
            };
            (server as any).scanner = mockScanner;

            await (server as any).ensureScanStarted(projectPath);
            expect(mockScanner.getClasspath).toHaveBeenCalledWith(projectPath);
            expect(mockScanner.scanProject).not.toHaveBeenCalled();
        });

        it('should start scan when no index or classpath exists', async () => {
            const mockScanner = {
                isIndexComplete: jest.fn<any>().mockResolvedValue(false),
                getClasspath: jest.fn<any>().mockResolvedValue(null),
                scanProject: jest.fn<any>().mockResolvedValue(undefined),
            };
            (server as any).scanner = mockScanner;

            await (server as any).ensureScanStarted(projectPath);
            expect(mockScanner.scanProject).toHaveBeenCalledWith(projectPath, false, undefined);
        });

        it('should propagate scan errors', async () => {
            const mockScanner = {
                isIndexComplete: jest.fn<any>().mockResolvedValue(false),
                getClasspath: jest.fn<any>().mockResolvedValue(null),
                scanProject: jest.fn<any>().mockRejectedValue(new Error('scan failed')),
            };
            (server as any).scanner = mockScanner;

            await expect((server as any).ensureScanStarted(projectPath)).rejects.toThrow('Unable to start dependency scan');
        });
    });
});
