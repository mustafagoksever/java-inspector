import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import archiver from 'archiver';
import { JarIndexer } from './JarIndexer.js';

async function createJar(jarPath: string): Promise<void> {
    const output = fs.createWriteStream(jarPath);
    const archive = archiver('zip');
    const done = new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
    });
    archive.pipe(output);
    archive.append(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), { name: 'com/example/Foo.class' });
    archive.append(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), { name: 'com/example/Foo$Inner.class' });
    archive.append(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), { name: 'META-INF/versions/17/com/example/Foo.class' });
    archive.append('package com.example; public class Foo {}\n', { name: 'com/example/Foo.java' });
    archive.append('Manifest-Version: 1.0\nMain-Class: com.example.Foo\nMulti-Release: true\n', { name: 'META-INF/MANIFEST.MF' });
    archive.append('groupId=com.example\nartifactId=demo\nversion=1.2.3\n', { name: 'META-INF/maven/com.example/demo/pom.properties' });
    archive.append('enabled=true\n', { name: 'application.properties' });
    archive.append('nested', { name: 'BOOT-INF/lib/nested.jar' });
    archive.finalize();
    await done;
}

describe('JarIndexer', () => {
    let root: string;
    let jarPath: string;
    const indexer = new JarIndexer();

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-inspector-indexer-'));
        jarPath = path.join(root, 'demo-1.2.3.jar');
        await createJar(jarPath);
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('creates a normalized light index with metadata and resources', async () => {
        const index = await indexer.getLightIndex(jarPath, root);
        const foo = index.classes.find(entry => entry.className === 'com.example.Foo');
        expect(foo?.release).toBe(17);
        expect(index.classes.some(entry => entry.className === 'com.example.Foo' && entry.isSource)).toBe(true);
        expect(index.classes.some(entry => entry.isInner)).toBe(true);
        expect(index.resources.find(entry => entry.path === 'application.properties')?.isText).toBe(true);
        expect(index.manifest['Main-Class']).toBe('com.example.Foo');
        expect(index.mavenCoordinates[0]).toMatchObject({ groupId: 'com.example', artifactId: 'demo', version: '1.2.3' });
        expect(index.nestedJars).toEqual(['BOOT-INF/lib/nested.jar']);
        expect(index.layout).toBe('spring-boot');
    });

    it('reads an exact resource and reuses a valid cached index', async () => {
        const first = await indexer.getLightIndex(jarPath, root);
        const second = await indexer.getLightIndex(jarPath, root);
        expect(second.fingerprint.key).toBe(first.fingerprint.key);
        await expect(indexer.readEntry(jarPath, 'application.properties')).resolves.toEqual(Buffer.from('enabled=true\n'));
    });
});
