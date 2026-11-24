import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import archiver from 'archiver';
import { jest } from '@jest/globals';
import { ArtifactService } from './ArtifactService.js';
import { projectCache } from '../cache/ProjectCache.js';

describe('ArtifactService', () => {
    const service = new ArtifactService();
    // Private copy of the bundled JAR: the cache directory is keyed by the JAR's folder, and
    // invalidating the shared lib/ cache would delete temp files of suites running in parallel.
    const libDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-artifact-lib-'));
    const jarPath = path.join(libDirectory, 'vineflower-1.12.0.jar');
    fs.copyFileSync(path.resolve('lib', 'vineflower-1.12.0.jar'), jarPath);

    afterAll(async () => {
        await projectCache.invalidate(libDirectory).catch(() => {});
        fs.rmSync(libDirectory, { recursive: true, force: true });
    });

    it('finds a local JAR by prefix without requiring Maven', async () => {
        const result = await service.findJars({ jarDirectory: libDirectory, jarNamePrefix: 'vineflower' });
        expect(result.results).toHaveLength(1);
        expect(result.results[0].jarPath).toBe(jarPath);
    });

    it('searches classes and resources from an exact JAR', async () => {
        const classes = await service.searchClasses('ConsoleDecompiler', { jarPath }, 20, 5);
        expect(classes.results[0]).toMatchObject({
            className: 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler',
            jarPath,
        });
        const resources = await service.searchResources({ jarPath }, 'MANIFEST.MF');
        expect(resources.results[0].resourcePath).toBe('META-INF/MANIFEST.MF');
        const resource = await service.readResource({ jarPath }, 'META-INF/MANIFEST.MF');
        expect(resource.text).toContain('Manifest-Version');
    });

    it('surfaces exact JAR scan failures instead of returning a complete miss', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-corrupt-'));
        const corruptJar = path.join(root, 'corrupt.jar');
        fs.writeFileSync(corruptJar, 'not a zip');
        try {
            await expect(service.searchClasses('Missing', { jarPath: corruptJar }, 20, 1))
                .rejects.toThrow(`Unable to scan ${corruptJar}`);
            await expect(service.searchCode('missing', 'method', { jarPath: corruptJar }, 20, 1))
                .rejects.toThrow(`Unable to deep-scan ${corruptJar}`);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('marks results partial while Maven classpath resolution is still running', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-pending-'));
        fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>');
        const pendingScanner = {
            isResolvingClasspath: jest.fn(() => true),
            scanProject: jest.fn(),
        };
        const pendingService = new ArtifactService(pendingScanner as any);
        try {
            const result = await pendingService.searchClasses('Missing', { workspacePath: root }, 20, 1);
            expect(result.results).toEqual([]);
            expect(result.complete).toBe(false);
            expect(pendingScanner.scanProject).not.toHaveBeenCalled();
        } finally {
            await projectCache.invalidate(root).catch(() => {});
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('waits for a cold-start Maven classpath when classpathWaitMs is set', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-wait-'));
        fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>');
        const waitingScanner = {
            isResolvingClasspath: jest.fn(() => true),
            scanProject: jest.fn(),
            waitForClasspath: jest.fn(async () => [jarPath]),
        };
        const waitingService = new ArtifactService(waitingScanner as any);
        const messages: string[] = [];
        try {
            const result = await waitingService.resolveClass('org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler', {
                workspacePath: root,
                classpathWaitMs: 1_000,
                onWait: async message => { messages.push(message); },
            });
            expect(waitingScanner.waitForClasspath).toHaveBeenCalled();
            expect(messages[0]).toMatch(/Waiting for Maven classpath/);
            expect(result.results[0]).toMatchObject({ className: 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler', jarPath, origin: 'maven' });
        } finally {
            await projectCache.invalidate(root).catch(() => {});
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('ranks JARs whose Maven path matches the class package first', () => {
        const relevance = (service as any).packageRelevance('org.apache.commons.lang3.StringUtils');
        const repo = '/home/u/.m2/repository';
        const lang = `${repo}/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar`;
        const io = `${repo}/commons-io/commons-io/2.16.1/commons-io-2.16.1.jar`;
        const slf4j = `${repo}/org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13.jar`;
        expect(relevance(lang)).toBeGreaterThan(relevance(io));
        expect(relevance(io)).toBeGreaterThan(relevance(slf4j));
        expect((service as any).packageRelevance('StringUtils')(lang)).toBe(0);
    });

    it('resolves nested classes through the outer class and suggests siblings on a miss', async () => {
        const nested = await service.resolveClass('org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler$SaveType', { jarPath });
        expect(nested.results[0]).toMatchObject({
            className: 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler$SaveType',
            entryPath: 'org/jetbrains/java/decompiler/main/decompiler/ConsoleDecompiler$SaveType.class',
            jarPath,
        });
        const simple = await service.searchClasses('ConsoleDecompiler$SaveType', { jarPath }, 20, 5);
        expect(simple.results[0].className).toBe('org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler$SaveType');
        const miss = await service.resolveClass('org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler$Missing', { jarPath });
        expect(miss.results.map(item => item.className)).toContain('org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler$SaveType');
    });

    it('orders deep-search JARs: deep-indexed first, then by package relevance', async () => {
        const repo = '/home/u/.m2/repository';
        const jars = [
            `${repo}/org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13.jar`,
            `${repo}/org/springframework/spring-core/6.1.0/spring-core-6.1.0.jar`,
            `${repo}/org/springframework/spring-context/6.1.0/spring-context-6.1.0.jar`,
        ].map(jar => ({ jarPath: jar, jarName: path.basename(jar), origin: 'maven' as const, contextPath: '/w' }));
        const { jarIndexer } = await import('./JarIndexer.js');
        const deep = jest.spyOn(jarIndexer, 'hasDeepIndex').mockImplementation(async jar => jar.includes('slf4j'));
        try {
            const ordered = await (service as any).orderForDeepSearch(jars, { workspacePath: '/w' }, 'org.springframework.context.ApplicationListener');
            expect(ordered.map((item: any) => path.basename(item.candidate.jarPath))).toEqual([
                'slf4j-api-2.0.13.jar',
                'spring-context-6.1.0.jar',
                'spring-core-6.1.0.jar',
            ]);
        } finally {
            deep.mockRestore();
        }
    });

    it('finds classes duplicated across JARs and groups them by artifact', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-dups-'));
        const makeJar = async (target: string, names: string[]) => {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const output = fs.createWriteStream(target);
            const archive = archiver('zip');
            const done = new Promise<void>((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); });
            archive.pipe(output);
            for (const name of names) archive.append(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), { name });
            archive.finalize();
            await done;
        };
        try {
            const repo = path.join(root, 'repository');
            await makeJar(path.join(repo, 'org/demo/demo-lib/1.0/demo-lib-1.0.jar'), ['org/demo/Api.class', 'org/demo/Api$Inner.class', 'org/demo/Old.class']);
            await makeJar(path.join(repo, 'org/demo/demo-lib/2.0/demo-lib-2.0.jar'), ['org/demo/Api.class', 'org/demo/Api$Inner.class', 'org/demo/New.class']);
            await makeJar(path.join(repo, 'com/other/shaded/1.0/shaded-1.0.jar'), ['org/demo/Api.class', 'com/other/Own.class']);
            const result = await service.findDuplicateClasses({ jarDirectory: repo });
            expect(result.complete).toBe(true);
            expect(result.totalDuplicateClasses).toBe(1);
            expect(result.groups).toHaveLength(1);
            expect(result.groups[0]).toMatchObject({ kind: 'different-artifacts', classCount: 1, sampleClasses: ['org.demo.Api'] });
            expect(result.groups[0].jars.map(jar => `${jar.groupId}:${jar.artifactId}:${jar.version}`)).toEqual([
                'com.other:shaded:1.0', 'org.demo:demo-lib:1.0', 'org.demo:demo-lib:2.0',
            ]);
            const filtered = await service.findDuplicateClasses({ jarDirectory: repo }, { query: 'com.other' });
            expect(filtered.groups).toEqual([]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not append foreground scans to the project JSONL index', async () => {
        const append = jest.spyOn(projectCache, 'appendToClassIndex');
        try {
            await service.searchClasses('ConsoleDecompiler', { jarPath }, 20, 5);
            await service.inspectJar({ jarPath });
            expect(append).not.toHaveBeenCalled();
        } finally {
            append.mockRestore();
        }
    });

    it('supports lazy deep code and implementation searches', async () => {
        const strings = await service.searchCode('Must specify a file', 'string', { jarPath });
        expect(strings.matches[0]).toMatchObject({
            className: 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler',
            kind: 'string',
        });
        const methods = await service.searchCode('decompileContext', 'method', { jarPath });
        expect(methods.matches[0]).toMatchObject({ member: 'decompileContext' });
        const implementations = await service.findImplementations('java.lang.AutoCloseable', { jarPath });
        expect(implementations.implementations.some(item => item.className === 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler')).toBe(true);
    });

    it('opens nested Spring Boot libraries only when a class query needs them', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-nested-'));
        const makeJar = async (target: string, entries: Array<{ name: string; data?: Buffer; file?: string }>) => {
            const output = fs.createWriteStream(target);
            const archive = archiver('zip');
            const done = new Promise<void>((resolve, reject) => {
                output.on('close', resolve);
                archive.on('error', reject);
            });
            archive.pipe(output);
            for (const entry of entries) {
                if (entry.file) archive.file(entry.file, { name: entry.name });
                else archive.append(entry.data!, { name: entry.name });
            }
            archive.finalize();
            await done;
        };
        try {
            const nested = path.join(root, 'nested.jar');
            await makeJar(nested, [{ name: 'org/nested/Hidden.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }]);
            const outer = path.join(root, 'app.jar');
            await makeJar(outer, [{ name: 'BOOT-INF/lib/nested.jar', file: nested }]);
            const result = await service.searchClasses('org.nested.Hidden', { jarPath: outer }, 20, 5);
            expect(result.results[0]).toMatchObject({ className: 'org.nested.Hidden', origin: 'nested' });
        } finally {
            await projectCache.invalidate(root).catch(() => {});
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('resolves classes from a source-only JAR without decompilation', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-sources-'));
        const sourceJar = path.join(root, 'demo-1.0-sources.jar');
        const output = fs.createWriteStream(sourceJar);
        const archive = archiver('zip');
        const done = new Promise<void>((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
        });
        archive.pipe(output);
        archive.append('package com.example; public class SourceOnly {}\n', { name: 'com/example/SourceOnly.java' });
        archive.finalize();
        await done;
        try {
            const result = await service.searchClasses('SourceOnly', { jarPath: sourceJar }, 20, 5);
            expect(result.results[0]).toMatchObject({ className: 'com.example.SourceOnly', jarPath: sourceJar });
        } finally {
            await projectCache.invalidate(root).catch(() => {});
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('ArtifactService coordinates', () => {
    it('reads the groupId relative to MAVEN_REPO, even without a "repository" directory or with one in the groupId', () => {
        const service = new ArtifactService();
        const previous = process.env.MAVEN_REPO;
        process.env.MAVEN_REPO = path.join(os.tmpdir(), 'm2');
        try {
            expect(service.coordinatesFromJarPath(path.join(os.tmpdir(), 'm2', 'com', 'acme', 'repository', 'store', '1.0', 'store-1.0.jar')))
                .toEqual({ groupId: 'com.acme.repository', artifactId: 'store', version: '1.0' });
        } finally {
            if (previous === undefined) delete process.env.MAVEN_REPO; else process.env.MAVEN_REPO = previous;
        }
    });
});

describe('ArtifactService Gradle cache layout', () => {
    it('reads coordinates and finds the sources JAR in a sibling hash directory', async () => {
        const service = new ArtifactService();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ji-gradle-cache-'));
        try {
            const versionDir = path.join(root, 'caches', 'modules-2', 'files-2.1', 'org.apache.commons', 'commons-lang3', '3.14.0');
            fs.mkdirSync(path.join(versionDir, 'aaa'), { recursive: true });
            fs.mkdirSync(path.join(versionDir, 'bbb'), { recursive: true });
            const jar = path.join(versionDir, 'aaa', 'commons-lang3-3.14.0.jar');
            fs.writeFileSync(jar, '');
            expect(service.coordinatesFromJarPath(jar)).toEqual({ groupId: 'org.apache.commons', artifactId: 'commons-lang3', version: '3.14.0' });
            expect(await service.findSourcesJar(jar)).toBeNull();
            fs.writeFileSync(path.join(versionDir, 'bbb', 'commons-lang3-3.14.0-sources.jar'), '');
            expect(await service.findSourcesJar(jar)).toBe(path.join(versionDir, 'bbb', 'commons-lang3-3.14.0-sources.jar'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
