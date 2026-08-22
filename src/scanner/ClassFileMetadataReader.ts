export interface ClassMemberMetadata {
    name: string;
    descriptor: string;
    accessFlags: number;
}

export interface ClassReferenceMetadata {
    kind: 'field' | 'method' | 'interface_method';
    owner: string;
    name: string;
    descriptor: string;
}

export interface ClassFileMetadata {
    className: string;
    superClass?: string;
    interfaces: string[];
    accessFlags: number;
    fields: ClassMemberMetadata[];
    methods: ClassMemberMetadata[];
    stringConstants: string[];
    references: ClassReferenceMetadata[];
    annotationCandidates: string[];
}

type CpEntry =
    | { tag: 1; value: string }
    | { tag: 7; nameIndex: number }
    | { tag: 8; stringIndex: number }
    | { tag: 9 | 10 | 11; classIndex: number; nameAndTypeIndex: number }
    | { tag: 12; nameIndex: number; descriptorIndex: number }
    | { tag: number };

/**
 * Small, dependency-free Java class-file reader used for on-demand deep indexes.
 * It intentionally reads metadata and the constant pool only; it never interprets
 * or executes bytecode.
 */
export class ClassFileMetadataReader {
    static read(buffer: Buffer): ClassFileMetadata {
        let offset = 0;
        const ensure = (length: number) => {
            if (offset + length > buffer.length) throw new Error('Truncated Java class file');
        };
        const u1 = () => { ensure(1); return buffer.readUInt8(offset++); };
        const u2 = () => { ensure(2); const value = buffer.readUInt16BE(offset); offset += 2; return value; };
        const u4 = () => { ensure(4); const value = buffer.readUInt32BE(offset); offset += 4; return value; };
        const skip = (length: number) => { ensure(length); offset += length; };

        if (u4() !== 0xcafebabe) throw new Error('Invalid Java class magic');
        u2(); // minor
        u2(); // major

        const cpCount = u2();
        const cp: Array<CpEntry | undefined> = new Array(cpCount);
        for (let i = 1; i < cpCount; i++) {
            const tag = u1();
            switch (tag) {
                case 1: {
                    const length = u2();
                    ensure(length);
                    cp[i] = { tag: 1, value: buffer.toString('utf8', offset, offset + length) };
                    offset += length;
                    break;
                }
                case 3:
                case 4:
                    skip(4); cp[i] = { tag }; break;
                case 5:
                case 6:
                    skip(8); cp[i] = { tag }; i++; break;
                case 7:
                    cp[i] = { tag: 7, nameIndex: u2() }; break;
                case 8:
                    cp[i] = { tag: 8, stringIndex: u2() }; break;
                case 9:
                case 10:
                case 11:
                    cp[i] = { tag, classIndex: u2(), nameAndTypeIndex: u2() } as CpEntry; break;
                case 12:
                    cp[i] = { tag: 12, nameIndex: u2(), descriptorIndex: u2() }; break;
                case 15:
                    skip(3); cp[i] = { tag }; break;
                case 16:
                case 19:
                case 20:
                    skip(2); cp[i] = { tag }; break;
                case 17:
                case 18:
                    skip(4); cp[i] = { tag }; break;
                default:
                    throw new Error(`Unsupported Java constant-pool tag: ${tag}`);
            }
        }

        const utf8 = (index: number): string => {
            const entry = cp[index];
            return entry?.tag === 1 ? (entry as { tag: 1; value: string }).value : '';
        };
        const className = (index: number): string => {
            const entry = cp[index];
            if (entry?.tag !== 7) return '';
            return utf8((entry as { tag: 7; nameIndex: number }).nameIndex).replace(/\//g, '.');
        };

        const accessFlags = u2();
        const thisClass = u2();
        const superClassIndex = u2();
        const interfaceCount = u2();
        const interfaces: string[] = [];
        for (let i = 0; i < interfaceCount; i++) interfaces.push(className(u2()));

        const annotationCandidates = new Set<string>();
        const readElementValue = (): void => {
            const tag = String.fromCharCode(u1());
            switch (tag) {
                case 'B': case 'C': case 'D': case 'F': case 'I': case 'J': case 'S': case 'Z': case 's': case 'c':
                    u2();
                    break;
                case 'e':
                    u2();
                    u2();
                    break;
                case '@':
                    readAnnotation();
                    break;
                case '[': {
                    const count = u2();
                    for (let i = 0; i < count; i++) readElementValue();
                    break;
                }
                default:
                    throw new Error(`Unsupported annotation element tag: ${tag}`);
            }
        };
        const readAnnotation = (): void => {
            const descriptor = utf8(u2());
            if (/^L[\w$/]+;$/.test(descriptor)) {
                annotationCandidates.add(descriptor.slice(1, -1).replace(/\//g, '.'));
            }
            const pairCount = u2();
            for (let i = 0; i < pairCount; i++) {
                u2(); // element_name_index
                readElementValue();
            }
        };
        const readAnnotationList = (): void => {
            const count = u2();
            for (let i = 0; i < count; i++) readAnnotation();
        };
        const readAttributes = (): void => {
            const count = u2();
            for (let i = 0; i < count; i++) {
                const attributeName = utf8(u2());
                const length = u4();
                ensure(length);
                const attributeEnd = offset + length;
                if (attributeName === 'RuntimeVisibleAnnotations' || attributeName === 'RuntimeInvisibleAnnotations') {
                    readAnnotationList();
                } else if (attributeName === 'RuntimeVisibleParameterAnnotations' || attributeName === 'RuntimeInvisibleParameterAnnotations') {
                    const parameterCount = u1();
                    for (let parameter = 0; parameter < parameterCount; parameter++) readAnnotationList();
                }
                if (offset > attributeEnd) throw new Error(`Malformed Java class attribute: ${attributeName}`);
                offset = attributeEnd;
            }
        };

        const readMembers = (): ClassMemberMetadata[] => {
            const count = u2();
            const members: ClassMemberMetadata[] = [];
            for (let i = 0; i < count; i++) {
                const memberAccess = u2();
                const name = utf8(u2());
                const descriptor = utf8(u2());
                readAttributes();
                members.push({ name, descriptor, accessFlags: memberAccess });
            }
            return members;
        };

        const fields = readMembers();
        const methods = readMembers();
        readAttributes(); // class-level attributes

        const strings = new Set<string>();
        const references: ClassReferenceMetadata[] = [];
        for (const entry of cp) {
            if (!entry) continue;
            if (entry.tag === 8) {
                const value = utf8((entry as { tag: 8; stringIndex: number }).stringIndex);
                if (value) strings.add(value);
            } else if (entry.tag === 9 || entry.tag === 10 || entry.tag === 11) {
                const ref = entry as { tag: 9 | 10 | 11; classIndex: number; nameAndTypeIndex: number };
                const nt = cp[ref.nameAndTypeIndex];
                if (nt?.tag === 12) {
                    const pair = nt as { tag: 12; nameIndex: number; descriptorIndex: number };
                    references.push({
                        kind: ref.tag === 9 ? 'field' : ref.tag === 10 ? 'method' : 'interface_method',
                        owner: className(ref.classIndex),
                        name: utf8(pair.nameIndex),
                        descriptor: utf8(pair.descriptorIndex),
                    });
                }
            }
        }

        return {
            className: className(thisClass),
            superClass: superClassIndex === 0 ? undefined : className(superClassIndex),
            interfaces: interfaces.filter(Boolean),
            accessFlags,
            fields,
            methods,
            stringConstants: [...strings],
            references,
            annotationCandidates: [...annotationCandidates],
        };
    }
}
