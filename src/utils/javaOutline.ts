import { extractParamTypes, matchParamTypes } from './methodExtractor.js';

/**
 * Lightweight structural parsing of Java source (no full parser): a brace-depth-aware scanner that
 * skips strings, char literals, text blocks and comments, and records declarations that appear
 * directly inside type bodies. Used for the outline view, member extraction and line lookups.
 */

export type OutlineKind = 'type' | 'method' | 'constructor' | 'field' | 'initializer' | 'enum-constants';

export interface OutlineMember {
    kind: OutlineKind;
    name: string;
    /** Declaration without body/initializer, whitespace collapsed, leading annotations removed. */
    signature: string;
    /** 1-based, first line of the declaration (annotations included, Javadoc excluded). */
    startLine: number;
    endLine: number;
    /** 0 = top-level type, 1 = its members, 2 = members of a nested type ... */
    depth: number;
    /** Enclosing type path, e.g. ["Outer", "Builder"]. */
    owner: string[];
}

type Frame = { kind: 'type' | 'body' | 'init'; typeName?: string; member?: OutlineMember; enumStart?: boolean };

const TYPE_DECL = /(?:^|[\s(@])(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;
const CONTROL = /^(if|for|while|switch|catch|synchronized|try|do|else|return|new|throw|case|yield)\b/;

/** Last comma-separated item outside parentheses/braces: `A(1, 2) {...}, B("x", 3)` -> `B("x", 3)`. */
function lastTopLevelItem(text: string): string {
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const ch = text[index];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) start = index + 1;
    }
    return text.substring(start).trim();
}

export function buildOutline(source: string): OutlineMember[] {
    const members: OutlineMember[] = [];
    const stack: Frame[] = [];
    let text = '';
    let textStartLine = -1;
    let parenDepth = 0;
    let line = 1;
    let i = 0;
    const n = source.length;

    const typeOwners = () => stack.filter(frame => frame.kind === 'type').map(frame => frame.typeName!);
    const inTypeBody = () => stack.length === 0 || stack[stack.length - 1].kind === 'type';
    const append = (chunk: string) => {
        if (!inTypeBody()) return;
        if (textStartLine < 0 && chunk.trim()) textStartLine = line;
        text += chunk;
    };
    const reset = () => { text = ''; textStartLine = -1; parenDepth = 0; };
    const flushEnumConstants = (frame: Frame | undefined) => {
        const decl = text.trim();
        if (frame?.enumStart && decl) {
            members.push({ kind: 'enum-constants', name: '(enum constants)', signature: collapse(decl), startLine: textStartLine, endLine: line, depth: stack.length, owner: typeOwners() });
        }
        if (frame) frame.enumStart = false;
    };

    while (i < n) {
        const ch = source[i];
        const next = source[i + 1];
        if (ch === '\n') { line++; if (text) text += ' '; i++; continue; }
        if (ch === '/' && next === '/') { while (i < n && source[i] !== '\n') i++; continue; }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line++; i++; }
            i += 2;
            continue;
        }
        if (ch === '"' && next === '"' && source[i + 2] === '"') {
            append('""');
            i += 3;
            while (i < n && !(source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"')) {
                if (source[i] === '\\') i++; // the escaped character may be a newline (line continuation)
                if (source[i] === '\n') line++;
                i++;
            }
            i += 3;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            append(ch + ch);
            i++;
            while (i < n && source[i] !== ch && source[i] !== '\n') { if (source[i] === '\\') i++; i++; }
            i++;
            continue;
        }
        if (inTypeBody() && parenDepth > 0 && (ch === '{' || ch === '}' || ch === ';')) {
            append(ch);
            i++;
            continue;
        }
        if (ch === '(' ) parenDepth += inTypeBody() ? 1 : 0;
        if (ch === ')' ) parenDepth = Math.max(0, parenDepth - (inTypeBody() ? 1 : 0));
        if (ch === '{') {
            const top = stack[stack.length - 1];
            if (!inTypeBody()) {
                stack.push({ kind: top.kind === 'init' ? 'init' : 'body' });
            } else {
                const decl = text.trim();
                const enumConstantBody = Boolean(top?.enumStart) && /^[A-Z_$][\w$]*\s*(\(.*\))?$/.test(lastTopLevelItem(stripAnnotations(decl)));
                if (enumConstantBody || inFieldInitializer(decl)) {
                    // Body of an enum constant, or array initializer / lambda / anonymous class of a field.
                    stack.push({ kind: 'init' });
                } else {
                    flushEnumConstants(top);
                    const member = classify(decl, textStartLine, stack.length, typeOwners(), true);
                    if (member?.kind === 'type') {
                        members.push(member);
                        stack.push({ kind: 'type', typeName: member.name, member, enumStart: /\benum\b/.test(member.signature.split('(')[0]) });
                    } else {
                        if (member) members.push(member);
                        stack.push({ kind: 'body', member: member ?? undefined });
                    }
                    reset();
                }
            }
            i++;
            continue;
        }
        if (ch === '}') {
            const frame = stack.pop();
            if (frame?.member) frame.member.endLine = line;
            if (frame?.kind === 'type') {
                flushEnumConstants(frame);
                reset();
            } else if (frame?.kind === 'body' && inTypeBody()) {
                reset();
            } else if (frame?.kind === 'init' && inTypeBody()) {
                text += '{...}';
            }
            i++;
            continue;
        }
        if (ch === ';' && inTypeBody()) {
            const top = stack[stack.length - 1];
            const decl = text.trim();
            if (top?.enumStart) {
                flushEnumConstants(top);
            } else if (decl) {
                const member = classify(decl, textStartLine, stack.length, typeOwners(), false);
                if (member) { member.endLine = line; members.push(member); }
            }
            reset();
            i++;
            continue;
        }
        append(ch);
        i++;
    }
    return members.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth);
}

function inFieldInitializer(text: string): boolean {
    return topLevelIndexOf(text, '=') >= 0;
}

function topLevelIndexOf(text: string, needle: string): number {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '<' || ch === '[') depth++;
        else if (ch === ')' || ch === '>' || ch === ']') depth = Math.max(0, depth - 1);
        else if (ch === needle && depth === 0) {
            if (needle === '=' && (text[i + 1] === '=' || text[i - 1] === '!' || text[i - 1] === '<' || text[i - 1] === '>')) continue;
            return i;
        }
    }
    return -1;
}

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function stripAnnotations(text: string): string {
    let result = collapse(text);
    // Leading annotations, including ones with (possibly nested) arguments.
    for (;;) {
        const match = result.match(/^@[\w$.]+\s*/);
        if (!match || /^@interface\b/.test(result)) break;
        let rest = result.substring(match[0].length);
        if (rest.startsWith('(')) {
            let depth = 0, end = 0;
            for (; end < rest.length; end++) {
                if (rest[end] === '(') depth++;
                else if (rest[end] === ')' && --depth === 0) break;
            }
            rest = rest.substring(end + 1);
        }
        result = rest.trim();
    }
    return result;
}

function classify(decl: string, startLine: number, depth: number, owner: string[], hasBody: boolean): OutlineMember | null {
    if (!decl) return null;
    const signature = stripAnnotations(decl);
    if (!signature) return null;
    const base = { startLine: startLine < 0 ? 1 : startLine, endLine: startLine < 0 ? 1 : startLine, depth, owner };
    if (/^static$/.test(signature)) return { kind: 'initializer', name: 'static {}', signature: 'static { ... }', ...base };
    const beforeParen = signature.split('(')[0];
    const typeMatch = beforeParen.match(TYPE_DECL);
    if (typeMatch && !/=/.test(beforeParen)) {
        return { kind: 'type', name: typeMatch[2], signature: signature.replace(/\s*\{$/, ''), ...base };
    }
    if (/^package\b|^import\b/.test(signature)) return null;
    const equalsAt = topLevelIndexOf(signature, '=');
    const head = equalsAt >= 0 ? signature.substring(0, equalsAt).trim() : signature;
    const paren = head.indexOf('(');
    if (paren > 0 && equalsAt < 0) {
        const nameMatch = head.substring(0, paren).trim().match(/([A-Za-z_$][\w$]*)$/);
        if (!nameMatch || CONTROL.test(head)) return null;
        const name = nameMatch[1];
        const words = head.substring(0, paren).trim().split(/\s+/);
        const isConstructor = owner.length > 0 && name === owner[owner.length - 1] && words.filter(w => !/^(public|protected|private)$/.test(w) && !w.startsWith('<')).length === 1;
        return { kind: isConstructor ? 'constructor' : 'method', name, signature, ...base };
    }
    // Compact record constructor: `public Point {`
    if (hasBody && owner.length > 0 && new RegExp(`^(?:(?:public|protected|private)\\s+)?${escapeRegExp(owner[owner.length - 1])}$`).test(head)) {
        return { kind: 'constructor', name: owner[owner.length - 1], signature: head, ...base };
    }
    if (!hasBody || equalsAt >= 0) {
        const names = splitTopLevel(head).map(part => part.trim().match(/([A-Za-z_$][\w$]*)\s*(\[\s*\])*$/)?.[1]).filter(Boolean) as string[];
        if (!names.length || !/\s/.test(head.trim())) return null;
        return { kind: 'field', name: names.join(', '), signature: head, ...base };
    }
    return null;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compact one-member-per-line rendering: `L120-145  public static boolean isBlank(CharSequence cs)`. */
export function formatOutline(members: OutlineMember[], options: { maxSignature?: number } = {}): string {
    const max = options.maxSignature ?? 160;
    return members.map(member => {
        const range = member.endLine > member.startLine ? `L${member.startLine}-${member.endLine}` : `L${member.startLine}`;
        let signature = member.kind === 'enum-constants' ? `enum constants: ${member.signature}` : member.signature;
        if (signature.length > max) signature = `${signature.substring(0, max - 3)}...`;
        return `${'  '.repeat(Math.max(0, member.depth))}${range.padEnd(12)} ${signature}`;
    }).join('\n');
}

/** Line range of a member including the Javadoc/comment block directly above it. */
export function memberRangeWithDoc(lines: string[], member: OutlineMember): { start: number; end: number } {
    let start = member.startLine;
    let index = start - 2;
    if (index >= 0 && /\*\/\s*$/.test(lines[index])) {
        while (index >= 0 && !/^\s*\/\*/.test(lines[index])) index--;
        if (index >= 0) start = index + 1;
    } else {
        while (index >= 0 && /^\s*\/\//.test(lines[index])) { start = index + 1; index--; }
    }
    return { start, end: member.endLine };
}

/**
 * Members (methods/constructors, all overloads unless paramTypes is given) named `name`.
 * Returns the source text of each including its Javadoc.
 */
export function extractMembers(source: string, name: string, paramTypes?: string[], outline: OutlineMember[] = buildOutline(source)): Array<{ member: OutlineMember; text: string; start: number; end: number }> {
    const lines = source.split('\n');
    const simpleOwnerName = name.includes('.') ? name.substring(name.lastIndexOf('.') + 1) : name;
    return outline
        .filter(member => (member.kind === 'method' || member.kind === 'constructor') && member.name === simpleOwnerName)
        .filter(member => !paramTypes?.length || matchParamTypes(extractParamTypes(member.signature), paramTypes))
        .map(member => {
            const { start, end } = memberRangeWithDoc(lines, member);
            return { member, text: lines.slice(start - 1, end).join('\n'), start, end };
        });
}

/** Innermost method/constructor/initializer containing the given 1-based line of this source. */
export function memberAtLine(outline: OutlineMember[], line: number): OutlineMember | undefined {
    return outline
        .filter(member => member.kind !== 'type' && member.startLine <= line && member.endLine >= line)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

export interface JavapMember {
    /** Signature line as printed by javap, e.g. `public static boolean isBlank(java.lang.CharSequence);` */
    signature: string;
    name: string;
    paramTypes: string[];
    isMethod: boolean;
    text: string;
    /** Source line numbers from the LineNumberTable (empty without -l or debug info). */
    lines: number[];
}

/** Split `javap -c -l -p -s` output into the class header and one block per member. */
export function parseJavapMembers(output: string, className?: string): { header: string; members: JavapMember[] } {
    const rawLines = output.split('\n');
    const headerLines: string[] = [];
    const members: JavapMember[] = [];
    let current: string[] | null = null;
    const simpleName = className ? className.substring(className.lastIndexOf('.') + 1) : undefined;
    const flush = () => {
        if (!current?.length) return;
        const signature = current[0].trim();
        const isMethod = signature.includes('(') || signature.startsWith('static {}');
        let name = signature;
        let paramTypes: string[] = [];
        if (signature.startsWith('static {}')) name = '<clinit>';
        else if (isMethod) {
            const head = signature.substring(0, signature.indexOf('(')).trim();
            name = head.substring(head.lastIndexOf(' ') + 1);
            if (name.includes('.')) name = name.substring(name.lastIndexOf('.') + 1);
            if (simpleName && (name === simpleName || name === simpleName.substring(simpleName.lastIndexOf('$') + 1))) name = '<init>';
            const params = signature.substring(signature.indexOf('(') + 1, signature.lastIndexOf(')')).trim();
            paramTypes = params ? splitTopLevel(params) : [];
        } else {
            name = signature.replace(/;$/, '').split(/\s+/).pop() ?? signature;
        }
        const text = current.join('\n').replace(/\s+$/, '');
        const lineNumbers = [...text.matchAll(/^\s+line (\d+): \d+/gm)].map(match => Number(match[1]));
        members.push({ signature, name, paramTypes, isMethod, text, lines: lineNumbers });
        current = null;
    };
    let inBody = false;
    for (const line of rawLines) {
        if (!inBody) {
            headerLines.push(line);
            if (/\{\s*$/.test(line) && !line.startsWith(' ')) inBody = true;
            continue;
        }
        if (/^\}\s*$/.test(line)) { flush(); break; }
        if (/^  \S/.test(line)) { flush(); current = [line]; continue; }
        if (current && line.trim()) current.push(line);
    }
    flush();
    return { header: headerLines.join('\n'), members };
}

function splitTopLevel(params: string): string[] {
    const result: string[] = [];
    let depth = 0, current = '';
    for (const ch of params) {
        if (ch === '<') depth++;
        if (ch === '>') depth--;
        if (ch === ',' && depth === 0) { result.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) result.push(current.trim());
    return result;
}

/** javap members named `name` (constructors: the simple class name or "<init>"), optionally one overload. */
export function selectJavapMembers(members: JavapMember[], name: string, paramTypes?: string[], className?: string): JavapMember[] {
    const simple = className ? className.substring(className.lastIndexOf('.') + 1).split('$').pop() : undefined;
    const wanted = name === simple ? '<init>' : name;
    return members
        .filter(member => member.isMethod && member.name === wanted)
        .filter(member => !paramTypes?.length || matchParamTypes(member.paramTypes.map(type => normalizeJavapType(type)), paramTypes));
}

function normalizeJavapType(type: string): string {
    return type.replace(/<.*>/g, '').replace(/^.*\./, '').toLowerCase();
}

/** javap member whose LineNumberTable spans the given original source line (smallest span wins). */
export function javapMemberAtLine(members: JavapMember[], line: number): JavapMember | undefined {
    return members
        .filter(member => member.lines.length > 0 && Math.min(...member.lines) <= line && Math.max(...member.lines) >= line)
        .sort((a, b) => (Math.max(...a.lines) - Math.min(...a.lines)) - (Math.max(...b.lines) - Math.min(...b.lines)))[0];
}

/**
 * Vineflower writes "$VF: Couldn't be decompiled" plus the decompiler's own Java stack trace into the
 * method body. Keep its bytecode listing (useful) but replace the trace with one line, and report
 * which methods failed so the response can point to view=bytecode.
 */
export function cleanDecompilerFailures(source: string): { source: string; failedMethods: string[] } {
    if (!source.includes("$VF: Couldn't be decompiled")) return { source, failedMethods: [] };
    const lines = source.split('\n');
    const output: string[] = [];
    const failedMethods: string[] = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const marker = line.match(/^(\s*)\/\/ \$VF: Couldn't be decompiled/);
        if (!marker) { output.push(line); continue; }
        const signature = [...output].reverse().find(previous => previous.trim() && !previous.trim().startsWith('//'))?.trim().replace(/\s*\{$/, '') ?? 'unknown method';
        failedMethods.push(signature);
        let reason = '';
        let next = index + 1;
        while (next < lines.length) {
            const text = lines[next].trim();
            if (/^\/\/ Please report/.test(text) || /^\/\/\s+at /.test(text) || text === '//' || /^\/\/\s+\.\.\. \d+ more/.test(text)) { next++; continue; }
            const exception = text.match(/^\/\/ ((?:[\w$]+\.)+[\w$]*(?:Exception|Error)(?::.*)?)$/);
            if (exception && !reason) { reason = exception[1].replace(/^(?:[a-z]\w*\.)+/, ''); next++; continue; }
            break;
        }
        output.push(`${marker[1]}// $VF: Couldn't be decompiled${reason ? ` (${reason})` : ''}. Vineflower's bytecode listing follows; inspect_class view=bytecode with methodName gives javap output.`);
        index = next - 1;
    }
    return { source: output.join('\n'), failedMethods };
}
