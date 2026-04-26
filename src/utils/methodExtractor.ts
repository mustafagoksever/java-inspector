export interface MethodLineRange {
    name: string;
    startLine: number;
    endLine: number;
    signature: string;
}

/**
 * Extract method body/bodies from Java source code.
 * If paramTypes is provided, returns the specific overload.
 * If paramTypes is NOT provided and multiple overloads exist, returns ALL of them separated by a delimiter.
 * Handles nested braces, strings, and both line/block comments.
 */
export function extractMethod(sourceCode: string, methodName: string, paramTypes?: string[]): string | null {
    const lines = sourceCode.split('\n');
    const methodRegexStr = "\\b" + escapeRegex(methodName) + "\\s*\\(";
    const methodRegex = new RegExp(methodRegexStr);
    const modifierRegex = /\b(public|private|protected|static|final|abstract|default|synchronized|native|strictfp)\s/;

    const results: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (methodRegex.test(line) && modifierRegex.test(line)) {
            if (paramTypes && paramTypes.length > 0) {
                const sigParams = extractParamTypes(line);
                if (!matchParamTypes(sigParams, paramTypes)) {
                    continue;
                }
            }

            const body = extractSingleMethodBody(lines, i);
            if (body !== null) {
                results.push(body);
                // Advance past this method so we don't match inner calls
                const bodyLineCount = body.split('\n').length;
                i += bodyLineCount - 1;
            }

            if (paramTypes && paramTypes.length > 0) {
                break; // Specific overload requested
            }
        }
    }

    if (results.length === 0) {
        return null;
    }

    if (results.length === 1) {
        return results[0];
    }

    return results.join('\n\n// ===== Method Overload =====\n\n');
}

function extractSingleMethodBody(lines: string[], startIdx: number): string | null {
    let braceIdx = -1;
    for (let i = startIdx; i < lines.length; i++) {
        if (lines[i].includes('{')) {
            braceIdx = i;
            break;
        }
    }

    if (braceIdx === -1) {
        const result: string[] = [];
        for (let i = startIdx; i < lines.length; i++) {
            result.push(lines[i]);
            if (lines[i].includes(';')) {
                break;
            }
        }
        return result.join('\n');
    }

    let depth = 0;
    let inString = false;
    let stringChar: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;
    let endIdx = -1;

    for (let i = braceIdx; i < lines.length; i++) {
        const line = lines[i];
        for (let j = 0; j < line.length; j++) {
            const ch = line[j];

            if (inLineComment) {
                if (ch === '\n') {
                    inLineComment = false;
                }
                continue;
            }

            if (inBlockComment) {
                if (ch === '/' && j > 0 && line[j - 1] === '*') {
                    inBlockComment = false;
                }
                continue;
            }

            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === '\\') {
                    escaped = true;
                    continue;
                }
                if (ch === stringChar) {
                    inString = false;
                    stringChar = null;
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                inString = true;
                stringChar = ch;
                continue;
            }

            if (ch === '/' && j < line.length - 1) {
                const next = line[j + 1];
                if (next === '/') {
                    inLineComment = true;
                    continue;
                }
                if (next === '*') {
                    inBlockComment = true;
                    continue;
                }
            }

            if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    endIdx = i;
                    break;
                }
            }
        }

        inLineComment = false;

        if (endIdx !== -1) {
            break;
        }
    }

    if (endIdx === -1) {
        return null;
    }

    return lines.slice(startIdx, endIdx + 1).join('\n');
}

export function extractMethodMap(sourceCode: string): MethodLineRange[] {
    const lines = sourceCode.split('\n');
    const methods: MethodLineRange[] = [];
    const modifierRegex = /\b(public|private|protected|static|final|abstract|default|synchronized|native|strictfp)\s/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!modifierRegex.test(trimmed)) continue;
        const parenOpen = trimmed.indexOf('(');
        if (parenOpen === -1) continue;
        const parenClose = trimmed.indexOf(')', parenOpen);
        if (parenClose === -1) continue;

        const beforeParen = trimmed.substring(0, parenOpen).trim();
        const lastSpace = beforeParen.lastIndexOf(' ');
        const name = lastSpace === -1 ? beforeParen : beforeParen.substring(lastSpace + 1).trim();
        if (!name) continue;

        const startLine = i + 1;

        let braceIdx = -1;
        for (let k = i; k < lines.length; k++) {
            if (lines[k].includes('{')) {
                braceIdx = k;
                break;
            }
            if (lines[k].includes(';')) {
                braceIdx = -1;
                break;
            }
        }

        let endLine = startLine;

        if (braceIdx === -1) {
            for (let k = i; k < lines.length; k++) {
                if (lines[k].includes(';')) {
                    endLine = k + 1;
                    break;
                }
            }
        } else {
            let depth = 0;
            let inString = false;
            let stringChar: string | null = null;
            let inLineComment = false;
            let inBlockComment = false;
            let escaped = false;
            let foundEnd = false;

            for (let k = braceIdx; k < lines.length; k++) {
                const l = lines[k];
                for (let j = 0; j < l.length; j++) {
                    const ch = l[j];

                    if (inLineComment) {
                        if (ch === '\n') inLineComment = false;
                        continue;
                    }
                    if (inBlockComment) {
                        if (ch === '/' && j > 0 && l[j - 1] === '*') inBlockComment = false;
                        continue;
                    }
                    if (inString) {
                        if (escaped) { escaped = false; continue; }
                        if (ch === '\\') { escaped = true; continue; }
                        if (ch === stringChar) { inString = false; stringChar = null; }
                        continue;
                    }
                    if (ch === '"' || ch === "'") {
                        inString = true;
                        stringChar = ch;
                        continue;
                    }
                    if (ch === '/' && j < l.length - 1) {
                        const next = l[j + 1];
                        if (next === '/') { inLineComment = true; continue; }
                        if (next === '*') { inBlockComment = true; continue; }
                    }
                    if (ch === '{') {
                        depth++;
                    } else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            endLine = k + 1;
                            foundEnd = true;
                            break;
                        }
                    }
                }
                inLineComment = false;
                if (foundEnd) break;
            }
            if (!foundEnd) {
                endLine = lines.length;
            }
        }

        methods.push({ name, startLine, endLine, signature: trimmed });
    }

    return methods;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractParamTypes(signature: string): string[] {
    const parenOpen = signature.indexOf('(');
    const parenClose = signature.lastIndexOf(')');
    if (parenOpen === -1 || parenClose === -1 || parenClose <= parenOpen) {
        return [];
    }
    const paramsStr = signature.substring(parenOpen + 1, parenClose).trim();
    if (!paramsStr) {
        return [];
    }
    const types: string[] = [];
    let depth = 0;
    let current = '';
    let inString = false;
    let stringChar: string | null = null;

    for (let i = 0; i < paramsStr.length; i++) {
        const ch = paramsStr[i];
        if (inString) {
            if (ch === stringChar) {
                inString = false;
                stringChar = null;
            }
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
            current += ch;
            continue;
        }
        if (ch === '<' || ch === '(' || ch === '[') {
            depth++;
            current += ch;
            continue;
        }
        if (ch === '>' || ch === ')' || ch === ']') {
            depth--;
            current += ch;
            continue;
        }
        if (ch === ',' && depth === 0) {
            types.push(normalizeType(extractParamType(current.trim())));
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) {
        types.push(normalizeType(extractParamType(current.trim())));
    }
    return types;
}

function extractParamType(decl: string): string {
    const trimmed = decl.trim();
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace === -1) return trimmed;
    let typePart = trimmed.substring(0, lastSpace).trim();
    typePart = typePart.replace(/\bfinal\b/g, '').trim();
    typePart = typePart.replace(/@[A-Za-z0-9_]+(\([^)]*\))?/g, '').trim();
    return typePart;
}

function normalizeType(type: string): string {
    return type
        .replace(/\s+/g, '')
        .replace(/[<>]/g, '')
        .replace(/\[\]/g, '[]')
        .replace(/^.*\./g, '')
        .toLowerCase();
}

export function matchParamTypes(sigParams: string[], filterTypes: string[]): boolean {
    if (sigParams.length !== filterTypes.length) {
        return false;
    }
    const normFilters = filterTypes.map(t => normalizeType(t));
    for (let i = 0; i < sigParams.length; i++) {
        const sigType = sigParams[i].toLowerCase();
        const filterType = normFilters[i];
        if (sigType === filterType) continue;
        if (filterType === 'object') continue;
        if (sigType.endsWith(filterType)) continue;
        if (!sigType.includes(filterType)) {
            return false;
        }
    }
    return true;
}