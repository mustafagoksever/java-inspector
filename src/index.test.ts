import { jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { JavaClassAnalyzerMCPServer } from './index.js';
import { Logger } from './utils/Logger.js';
import { CrossProcessLock } from './utils/CrossProcessLock.js';

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
            const logger = Logger.get(createTestProject());
            const spy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
            (server as any).logToolDebug(logger, 'test_tool', '/tmp/project', { extra: true });
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
            Logger.clearLog(logger as any);
        });

        it('should log in development mode', () => {
            process.env.NODE_ENV = 'development';
            const logger = Logger.get(createTestProject());
            const spy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
            (server as any).logToolDebug(logger, 'test_tool', '/tmp/project', { extra: true });
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
            Logger.clearLog(logger as any);
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
