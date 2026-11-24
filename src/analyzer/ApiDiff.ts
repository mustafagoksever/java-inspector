import { ClassFileMetadata, ClassMemberMetadata } from '../scanner/ClassFileMetadataReader.js';

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_BRIDGE = 0x0040;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;

export interface MemberChange {
    member: string;
    change: string;
    breaking: boolean;
}

export interface ClassApiDiff {
    className: string;
    status: 'added' | 'removed' | 'changed';
    /** Breaking for callers or subclasses compiled against the old version. */
    breaking: boolean;
    classChanges: string[];
    added: string[];
    removed: string[];
    changed: MemberChange[];
}

export interface ApiDiffResult {
    addedClasses: string[];
    removedClasses: string[];
    changedClasses: ClassApiDiff[];
    unchangedClassCount: number;
    breakingChangeCount: number;
}

const PRIMITIVES: Record<string, string> = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' };

/** Decode a field/method descriptor into Java type names (java.lang. prefix dropped). */
export function decodeDescriptor(descriptor: string): { params: string[]; returnType?: string } {
    let index = 0;
    const readType = (): string => {
        let dims = 0;
        while (descriptor[index] === '[') { dims++; index++; }
        let type: string;
        const char = descriptor[index++];
        if (char === 'L') {
            const end = descriptor.indexOf(';', index);
            type = descriptor.substring(index, end).replace(/\//g, '.').replace(/^java\.lang\.(?=[A-Z][\w$]*$)/, '');
            index = end + 1;
        } else {
            type = PRIMITIVES[char] ?? char;
        }
        return type + '[]'.repeat(dims);
    };
    if (descriptor[0] !== '(') return { params: [], returnType: readType() };
    index = 1;
    const params: string[] = [];
    while (index < descriptor.length && descriptor[index] !== ')') params.push(readType());
    index++;
    return { params, returnType: readType() };
}

const simpleName = (className: string) => className.substring(className.lastIndexOf('.') + 1);

function modifiers(flags: number, isMethod: boolean): string {
    const parts: string[] = [];
    if (flags & ACC_PUBLIC) parts.push('public');
    else if (flags & ACC_PROTECTED) parts.push('protected');
    if (flags & ACC_STATIC) parts.push('static');
    if (flags & ACC_FINAL) parts.push('final');
    if (isMethod && flags & ACC_ABSTRACT) parts.push('abstract');
    return parts.join(' ');
}

const ACC_VARARGS = 0x0080;
const OBJECT_METHODS = new Set(['M:toString:()Ljava/lang/String;', 'M:hashCode:()I', 'M:equals:(Ljava/lang/Object;)Z']);
/** Simple type name for compact output: java.util.Map$Entry[] -> Map.Entry[]. */
const shortType = (type: string) => type.replace(/^(?:[a-z_][\w]*\.)+/, '').replace(/\$/g, '.');

export function memberSignature(owner: string, member: ClassMemberMetadata, isMethod: boolean): string {
    const raw = decodeDescriptor(member.descriptor);
    const params = raw.params.map(shortType);
    if (isMethod && member.accessFlags & ACC_VARARGS && params.length) params[params.length - 1] = params[params.length - 1].replace(/\[\]$/, '...');
    const decoded = { params, returnType: raw.returnType && shortType(raw.returnType) };
    const mods = modifiers(member.accessFlags, isMethod);
    const prefix = mods ? `${mods} ` : '';
    if (!isMethod) return `${prefix}${decoded.returnType} ${member.name}`;
    if (member.name === '<init>') return `${prefix}${simpleName(owner).replace(/^.*\$/, '')}(${decoded.params.join(', ')})`;
    return `${prefix}${decoded.returnType} ${member.name}(${decoded.params.join(', ')})`;
}

const isVisible = (flags: number) => (flags & (ACC_PUBLIC | ACC_PROTECTED)) !== 0 && (flags & ACC_SYNTHETIC) === 0;
const visibilityRank = (flags: number) => (flags & ACC_PUBLIC ? 3 : flags & ACC_PROTECTED ? 2 : flags & ACC_PRIVATE ? 0 : 1);

function classKind(flags: number): string {
    if (flags & ACC_ANNOTATION) return '@interface';
    if (flags & ACC_INTERFACE) return 'interface';
    if (flags & ACC_ENUM) return 'enum';
    return 'class';
}

/** Public API of a class: public/protected, non-synthetic, non-bridge members keyed by name+descriptor. */
function apiMembers(cls: ClassFileMetadata): Map<string, { member: ClassMemberMetadata; isMethod: boolean }> {
    const members = new Map<string, { member: ClassMemberMetadata; isMethod: boolean }>();
    for (const field of cls.fields) if (isVisible(field.accessFlags)) members.set(`F:${field.name}:${field.descriptor}`, { member: field, isMethod: false });
    for (const method of cls.methods) {
        if (!isVisible(method.accessFlags) || method.accessFlags & ACC_BRIDGE || method.name === '<clinit>') continue;
        members.set(`M:${method.name}:${method.descriptor}`, { member: method, isMethod: true });
    }
    return members;
}

/**
 * Compare the public/protected API of two sets of class files (binary compatibility view:
 * removed or narrowed members, changed static/final/abstract, changed supertypes).
 */
export function diffApi(fromClasses: ClassFileMetadata[], toClasses: ClassFileMetadata[]): ApiDiffResult {
    const visible = (classes: ClassFileMetadata[]) => new Map(classes.filter(cls => isVisible(cls.accessFlags) && !/\$\d/.test(cls.className) && cls.className !== 'module-info').map(cls => [cls.className, cls]));
    const before = visible(fromClasses);
    const after = visible(toClasses);
    const addedClasses = [...after.keys()].filter(name => !before.has(name)).sort();
    const removedClasses = [...before.keys()].filter(name => !after.has(name)).sort();
    const changedClasses: ClassApiDiff[] = [];
    let unchangedClassCount = 0;

    for (const [className, oldClass] of before) {
        const newClass = after.get(className);
        if (!newClass) continue;
        const classChanges: string[] = [];
        let breaking = false;
        const note = (text: string, isBreaking: boolean) => { classChanges.push(text); breaking ||= isBreaking; };
        if (classKind(oldClass.accessFlags) !== classKind(newClass.accessFlags)) note(`kind: ${classKind(oldClass.accessFlags)} -> ${classKind(newClass.accessFlags)}`, true);
        if (!(oldClass.accessFlags & ACC_FINAL) && newClass.accessFlags & ACC_FINAL) note('class became final', true);
        if (oldClass.accessFlags & ACC_FINAL && !(newClass.accessFlags & ACC_FINAL)) note('class is no longer final', false);
        if (!(oldClass.accessFlags & ACC_ABSTRACT) && newClass.accessFlags & ACC_ABSTRACT && !(newClass.accessFlags & ACC_INTERFACE)) note('class became abstract', true);
        if ((oldClass.superClass ?? '') !== (newClass.superClass ?? '')) note(`superclass: ${oldClass.superClass ?? 'none'} -> ${newClass.superClass ?? 'none'}`, true);
        const removedInterfaces = oldClass.interfaces.filter(name => !newClass.interfaces.includes(name));
        const addedInterfaces = newClass.interfaces.filter(name => !oldClass.interfaces.includes(name));
        if (removedInterfaces.length) note(`no longer implements ${removedInterfaces.join(', ')}`, true);
        if (addedInterfaces.length) note(`now implements ${addedInterfaces.join(', ')}`, false);

        const oldMembers = apiMembers(oldClass);
        const newMembers = apiMembers(newClass);
        const added: string[] = [];
        const removed: string[] = [];
        const changed: MemberChange[] = [];
        for (const [key, { member, isMethod }] of oldMembers) {
            const current = newMembers.get(key);
            const oldSignature = memberSignature(className, member, isMethod);
            if (!current) {
                // Narrowed to package-private/private counts as removed from the API.
                const hidden = (isMethod ? newClass.methods : newClass.fields).find(item => item.name === member.name && item.descriptor === member.descriptor);
                if (hidden) changed.push({ member: oldSignature, change: `visibility narrowed to ${hidden.accessFlags & ACC_PRIVATE ? 'private' : 'package-private'}`, breaking: true });
                else if (isMethod && OBJECT_METHODS.has(key)) changed.push({ member: oldSignature, change: 'override removed (inherited from a superclass)', breaking: false });
                else removed.push(oldSignature);
                continue;
            }
            const diffs: string[] = [];
            let memberBreaking = false;
            const flag = (mask: number, label: string, breakingWhenAdded: boolean, breakingWhenRemoved: boolean) => {
                const had = (member.accessFlags & mask) !== 0;
                const has = (current.member.accessFlags & mask) !== 0;
                if (had === has) return;
                diffs.push(has ? `became ${label}` : `no longer ${label}`);
                memberBreaking ||= has ? breakingWhenAdded : breakingWhenRemoved;
            };
            if (visibilityRank(current.member.accessFlags) < visibilityRank(member.accessFlags)) { diffs.push('public -> protected'); memberBreaking = true; }
            if (visibilityRank(current.member.accessFlags) > visibilityRank(member.accessFlags)) diffs.push('protected -> public');
            flag(ACC_STATIC, 'static', true, true);
            flag(ACC_FINAL, 'final', true, !isMethod);
            if (isMethod) flag(ACC_ABSTRACT, 'abstract', true, false);
            if (diffs.length) changed.push({ member: oldSignature, change: diffs.join(', '), breaking: memberBreaking });
        }
        for (const [key, { member, isMethod }] of newMembers) {
            if (oldMembers.has(key)) continue;
            const signature = memberSignature(className, member, isMethod);
            added.push(signature);
            // A new abstract method in an interface/abstract class breaks implementors (unless it has a default body).
            if (isMethod && member.accessFlags & ACC_ABSTRACT) breaking = true;
        }
        if (removed.length || changed.some(item => item.breaking)) breaking = true;
        if (classChanges.length || added.length || removed.length || changed.length) {
            changedClasses.push({ className, status: 'changed', breaking, classChanges, added, removed, changed });
        } else {
            unchangedClassCount++;
        }
    }
    changedClasses.sort((a, b) => Number(b.breaking) - Number(a.breaking) || a.className.localeCompare(b.className));
    const breakingChangeCount = removedClasses.length + changedClasses.reduce((sum, cls) =>
        sum + cls.removed.length + cls.changed.filter(item => item.breaking).length + (cls.breaking && !cls.removed.length && !cls.changed.some(item => item.breaking) ? 1 : 0), 0);
    return { addedClasses, removedClasses, changedClasses, unchangedClassCount, breakingChangeCount };
}
