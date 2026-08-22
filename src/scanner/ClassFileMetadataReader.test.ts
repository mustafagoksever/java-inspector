import * as path from 'path';
import { ClassFileMetadataReader } from './ClassFileMetadataReader.js';
import { JarIndexer } from './JarIndexer.js';

describe('ClassFileMetadataReader', () => {
    const indexer = new JarIndexer();
    const vineflower = path.resolve('lib', 'vineflower-1.11.2.jar');

    it('reads hierarchy, members, references, and real string constants', async () => {
        const entry = 'org/jetbrains/java/decompiler/main/decompiler/ConsoleDecompiler.class';
        const bytes = await indexer.readEntry(vineflower, entry, 20 * 1024 * 1024);
        const metadata = ClassFileMetadataReader.read(bytes);
        expect(metadata.className).toBe('org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler');
        expect(metadata.superClass).toBe('java.lang.Object');
        expect(metadata.interfaces).toEqual(expect.arrayContaining([
            'org.jetbrains.java.decompiler.main.extern.IResultSaver',
            'java.lang.AutoCloseable',
        ]));
        expect(metadata.methods.map(method => method.name)).toEqual(expect.arrayContaining(['main', 'decompileContext', 'saveClassEntry']));
        expect(metadata.stringConstants).toContain('Must specify a file when using -cfg argument.');
        expect(metadata.references.some(reference => reference.owner === 'java.lang.System')).toBe(true);
    });

    it('reads real annotation attributes without treating field descriptors as annotations', () => {
        const u1 = (value: number) => Buffer.from([value]);
        const u2 = (value: number) => { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; };
        const u4 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
        const utf8 = (value: string) => {
            const bytes = Buffer.from(value, 'utf8');
            return Buffer.concat([u1(1), u2(bytes.length), bytes]);
        };
        const clazz = (nameIndex: number) => Buffer.concat([u1(7), u2(nameIndex)]);
        const bytes = Buffer.concat([
            u4(0xcafebabe), u2(0), u2(52), u2(9),
            utf8('com/example/Test'), clazz(1),
            utf8('java/lang/Object'), clazz(3),
            utf8('value'), utf8('Lcom/example/NotAnnotation;'),
            utf8('RuntimeVisibleAnnotations'), utf8('Lcom/example/RealAnnotation;'),
            u2(0x0021), u2(2), u2(4), u2(0),
            u2(1), u2(0x0002), u2(5), u2(6), u2(0),
            u2(0),
            u2(1), u2(7), u4(6), u2(1), u2(8), u2(0),
        ]);

        const metadata = ClassFileMetadataReader.read(bytes);
        expect(metadata.annotationCandidates).toEqual(['com.example.RealAnnotation']);
        expect(metadata.annotationCandidates).not.toContain('com.example.NotAnnotation');
    });
});
