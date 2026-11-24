import { decodeDescriptor, diffApi, memberSignature } from './ApiDiff.js';
import { ClassFileMetadata } from '../scanner/ClassFileMetadataReader.js';

const cls = (className: string, accessFlags: number, methods: Array<[string, string, number]>, extra: Partial<ClassFileMetadata> = {}): ClassFileMetadata => ({
    className, accessFlags, interfaces: [], fields: [], stringConstants: [], references: [], annotationCandidates: [],
    superClass: 'java.lang.Object',
    methods: methods.map(([name, descriptor, flags]) => ({ name, descriptor, accessFlags: flags })),
    ...extra,
});

describe('ApiDiff', () => {
    it('decodes descriptors and renders compact signatures', () => {
        expect(decodeDescriptor('(I[Ljava/lang/String;Ljava/util/Map$Entry;)V')).toEqual({ params: ['int', 'String[]', 'java.util.Map$Entry'], returnType: 'void' });
        expect(memberSignature('a.B', { name: 'join', descriptor: '(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;', accessFlags: 0x0089 }, true))
            .toBe('public static String join(String, Object...)');
        expect(memberSignature('a.B$C', { name: '<init>', descriptor: '(Ljava/util/Map$Entry;)V', accessFlags: 1 }, true)).toBe('public C(Map.Entry)');
    });

    it('reports added, removed and changed members with breaking flags', () => {
        const before = [
            cls('a.Foo', 0x0001, [['keep', '()V', 1], ['gone', '(I)V', 1], ['narrow', '()V', 1], ['toString', '()Ljava/lang/String;', 1], ['nowStatic', '()V', 1]]),
            cls('a.Removed', 0x0001, []),
            cls('a.Hidden', 0x0000, []),
        ];
        const after = [
            cls('a.Foo', 0x0011, [['keep', '()V', 1], ['narrow', '()V', 0], ['nowStatic', '()V', 9], ['added', '()I', 1]]),
            cls('a.New', 0x0001, []),
        ];
        const diff = diffApi(before, after);
        expect(diff.addedClasses).toEqual(['a.New']);
        expect(diff.removedClasses).toEqual(['a.Removed']);
        const foo = diff.changedClasses[0];
        expect(foo).toMatchObject({ className: 'a.Foo', breaking: true, classChanges: ['class became final'], removed: ['public void gone(int)'], added: ['public int added()'] });
        expect(foo.changed).toEqual(expect.arrayContaining([
            { member: 'public void narrow()', change: 'visibility narrowed to package-private', breaking: true },
            { member: 'public String toString()', change: 'override removed (inherited from a superclass)', breaking: false },
            { member: 'public void nowStatic()', change: 'became static', breaking: true },
        ]));
    });

    it('treats identical APIs as unchanged', () => {
        const classes = [cls('a.Same', 1, [['m', '()V', 1], ['lambda$m$0', '()V', 0x1002]])];
        expect(diffApi(classes, classes)).toMatchObject({ changedClasses: [], unchangedClassCount: 1, breakingChangeCount: 0 });
    });
});
