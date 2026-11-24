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
                'find_duplicates',
                'inspect_class',
                'explain_dependency',
                'compare_versions',
                'list_dependencies',
                'search_resources',
                'read_resource',
            ]);
            const inspectClass = result.tools.find((tool: any) => tool.name === 'inspect_class');
            expect(inspectClass.inputSchema.properties).not.toHaveProperty('decompilerPath');
            for (const tool of result.tools) {
                expect(tool.annotations).toEqual(expect.objectContaining({ readOnlyHint: true, destructiveHint: false }));
                expect(tool.description.length).toBeGreaterThan(80);
            }
            expect(inspectClass.description).toMatch(/javap/);
        });

        it('advertises usage instructions so agents prefer the tools over shell javap', () => {
            expect((server as any).mcp.server._instructions).toMatch(/Instead of `javap`/);
        });
    });

    describe('tool call error handling', () => {
        const callTool = async (name: string, args: Record<string, unknown>) => {
            const handler = (server as any).server._requestHandlers.get('tools/call');
            return handler({ method: 'tools/call', params: { name, arguments: args } }, { signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => ({}) });
        };

        it('returns handler failures as isError results instead of protocol errors', async () => {
            const result = await callTool('inspect_class', { className: 'a.B', jarPath: path.join(os.tmpdir(), 'does-not-exist.jar') });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/Tool call failed/);
        });

        it('does not silently resolve a misspelled class to a fuzzy match', async () => {
            const jarPath = path.resolve('lib', 'vineflower-1.12.0.jar');
            const result = await callTool('inspect_class', { className: 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompile', jarPath, view: 'hierarchy' });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/Class not found/);
            expect(result.content[0].text).toMatch(/ConsoleDecompiler/);
        });
        it('inspects nested classes by binary or source-style name', async () => {
            const jarPath = path.resolve('lib', 'vineflower-1.12.0.jar');
            const binary = await callTool('inspect_class', { className: 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler$SaveType', jarPath, view: 'all' });
            expect(binary.isError).toBeFalsy();
            const text = binary.content[0].text;
            expect(text).toMatch(/Enclosing class: org\.jetbrains\.java\.decompiler\.main\.decompiler\.ConsoleDecompiler/);
            expect(text).toMatch(/enum SaveType/);
            expect(text).not.toMatch(/class ConsoleDecompiler/);
            expect(text).toMatch(/API \(javap -p\)/);
            const dotted = await callTool('inspect_class', { className: 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler.SaveType', jarPath, view: 'api' });
            expect(dotted.isError).toBeFalsy();
            expect(dotted.content[0].text).toMatch(/ConsoleDecompiler\$SaveType/);
        }, 60_000);
    });

    describe('context-efficient class views', () => {
        const callTool = async (name: string, args: Record<string, unknown>) => {
            const handler = (server as any).server._requestHandlers.get('tools/call');
            return handler({ method: 'tools/call', params: { name, arguments: args } }, { signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => ({}) });
        };
        const jarPath = path.resolve('lib', 'vineflower-1.12.0.jar');
        const consoleDecompiler = 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler';

        it('returns an outline with line ranges', async () => {
            const result = await callTool('inspect_class', { className: consoleDecompiler, jarPath, view: 'outline' });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toMatch(/Outline/);
            expect(result.content[0].text).toMatch(/L\d+-\d+ +public static void main\(String\[\] args\)/);
        }, 60_000);

        it('finds the method containing a stack-trace line via the class line table', async () => {
            const result = await callTool('inspect_class', { className: consoleDecompiler, jarPath, line: 286 });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toMatch(/Original line 286 is in public void saveFolder\(java\.lang\.String\)/);
            expect(result.content[0].text).toMatch(/public void saveFolder\(String path\)/);
        }, 60_000);

        it('returns one method of bytecode and lists members instead of dumping large bytecode', async () => {
            const one = await callTool('inspect_class', { className: consoleDecompiler, jarPath, view: 'bytecode', methodName: 'saveFolder' });
            expect(one.content[0].text).toMatch(/public void saveFolder\(java\.lang\.String\);/);
            expect(one.content[0].text).not.toMatch(/public static void main/);
            const all = await callTool('inspect_class', { className: consoleDecompiler, jarPath, view: 'bytecode' });
            expect(all.content[0].text).toMatch(/only member signatures are listed/);
            expect(all.content[0].text.length).toBeLessThan(20_000);
        }, 60_000);

        it('looks up inherited methods in superclasses and interfaces', async () => {
            const result = await callTool('inspect_class', { className: 'org.jetbrains.java.decompiler.main.decompiler.DirectoryResultSaver', jarPath, methodName: 'getCodeLineData' });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toMatch(/Declared in: org\.jetbrains\.java\.decompiler\.main\.extern\.IResultSaver/);
            expect(result.content[0].text).toMatch(/default byte\[\] getCodeLineData/);
        }, 60_000);

        it('groups search results under their JAR', async () => {
            const result = await callTool('search_class', { query: 'ResultSaver', jarPath });
            const text = result.content[0].text;
            expect(text.split(jarPath).length - 1).toBe(1);
            expect(text).toMatch(/\n  - org\.jetbrains\.java\.decompiler\.main\.decompiler\.DirectoryResultSaver/);
        }, 60_000);
    });

    describe('sliceSource', () => {
        const source = ['a', 'b', 'c', 'd', 'e'].join('\n');

        it('returns the full source without a range by default', () => {
            expect((server as any).sliceSource(source, {})).toEqual({ source });
        });

        it('returns the first lines plus an outline for large files instead of everything', () => {
            const big = ['public class Big {', ...Array.from({ length: 500 }, (_, index) => `    public int m${index}() { return ${index}; }`), '}'].join('\n');
            const slice = (server as any).sliceSource(big, {});
            expect(slice.source.split('\n')).toHaveLength(120);
            expect(slice.sourceRange).toEqual({ startLine: 1, endLine: 120, totalLines: 502 });
            expect(slice.outline).toMatch(/L401 +public int m399\(\)/);
            expect((server as any).sliceSource(big, { limit: 600 }).source).toBe(big);
        });

        it('shrinks oversized json results into valid json instead of cutting the text', async () => {
            const structured = { items: Array.from({ length: 3000 }, (_, index) => ({ name: `item-${index}`, value: 'v'.repeat(20) })), source: 'x'.repeat(30_000) };
            const response = (server as any).formatResponse('text', structured, 'json');
            const text = response.content[0].text;
            expect(text.length).toBeLessThanOrEqual(40_000);
            const parsed = JSON.parse(text);
            expect(parsed.truncated).toMatchObject({ maxChars: 40_000 });
            expect(parsed.items.length).toBeGreaterThan(0);
            expect(parsed.items.length).toBeLessThan(3000);
        });

        it('caps oversized responses with a hint', () => {
            const capped = (server as any).capResponse('x'.repeat(10) + '\n' + 'y'.repeat(50_000));
            expect(capped.length).toBeLessThan(41_000);
            expect(capped).toMatch(/Response truncated/);
        });

        it('reports the returned range and total lines when paging', () => {
            expect((server as any).sliceSource(source, { offset: 2, limit: 2 })).toEqual({ source: 'b\nc', sourceRange: { startLine: 2, endLine: 3, totalLines: 5 } });
        });

        it('rejects an offset past the end instead of returning nothing', () => {
            expect(() => (server as any).sliceSource(source, { offset: 99 })).toThrow(/past the end/);
        });
    });

    describe('v3 selector and extracted class cache', () => {
        it('defaults an omitted artifact selector to the current workspace', async () => {
            const selector = await (server as any).selectorFromArgs({}, true);
            expect(selector.workspacePath).toBe(path.resolve(process.cwd()));
        });

        it('uses collision-safe paths for equal simple class names in one JAR', async () => {
            const projectPath = createTestProject();
            const jarPath = path.resolve('lib', 'vineflower-1.12.0.jar');
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
            const jarPath = path.resolve('lib', 'vineflower-1.12.0.jar');
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

});
