export interface MethodLineRange {
    name: string;
    startLine: number;
    endLine: number;
    signature: string;
}

/**
 * Extract a single method body from Java source code.
 * Handles nested braces, strings, and both line/block comments.
 */
export function extractMethod(sourceCode: string, methodName: string): string | null {
    const lines = sourceCode.split('\n');

    // 1. Find the method signature line
    let startIdx = -1;
    const methodRegex = new RegExp(`\\b${escapeRegex(methodName)}\\s*\\(`);
    const modifierRegex = /\b(public|private|protected|static|final|abstract|default|synchronized|native|strictfp)\s/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (methodRegex.test(line) && modifierRegex.test(line)) {
            startIdx = i;
            break;
        }
    }

    if (startIdx === -1) {
        return null;
    }

    // 2. Find opening brace `{`
    let braceIdx = -1;
    for (let i = startIdx; i < lines.length; i++) {
        if (lines[i].includes('{')) {
            braceIdx = i;
            break;
        }
    }

    // No brace found — might be an abstract method (ends with `;`)
    if (braceIdx === -1) {
        // Collect from signature until semicolon
        const result: string[] = [];
        for (let i = startIdx; i < lines.length; i++) {
            result.push(lines[i]);
            if (lines[i].includes(';')) {
                break;
            }
        }
        return result.join('\n');
    }

    // 3. Brace matching from braceIdx onward
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

            // Start of string
            if (ch === '"' || ch === "'") {
                inString = true;
                stringChar = ch;
                continue;
            }

            // Start of line comment
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

            // Brace counting
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

        if (endIdx !== -1) {
            break;
        }
    }

    if (endIdx === -1) {
        return null;
    }

    return lines.slice(startIdx, endIdx + 1).join('\n');
}

/**
 * Extract all method line ranges from Java source code.
 */
export function extractMethodMap(sourceCode: string): MethodLineRange[] {
    const lines = sourceCode.split('\n');
    const methods: MethodLineRange[] = [];
    const modifierRegex = /\b(public|private|protected|static|final|abstract|default|synchronized|native|strictfp)\s/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Match method/constructor signatures
        if (!modifierRegex.test(trimmed)) continue;
        const parenOpen = trimmed.indexOf('(');
        if (parenOpen === -1) continue;
        const parenClose = trimmed.indexOf(')', parenOpen);
        if (parenClose === -1) continue;

        // Exclude field initializers like `private static final String FOO = "bar";`
        const beforeParen = trimmed.substring(0, parenOpen).trim();
        const lastSpace = beforeParen.lastIndexOf(' ');
        const name = lastSpace === -1 ? beforeParen : beforeParen.substring(lastSpace + 1).trim();
        if (!name) continue;

        // Skip if it looks like a field (has `=` before `(` on the same line, or no parens pair)
        // Actually we already checked parens. Additional: if beforeParen has no type-like token, skip.
        // Simple heuristic: if name starts with lowercase or is a constructor (same as class), accept.
        // For now, accept all that pass modifier + ( ) test.

        const startLine = i + 1; // 1-based

        // Find opening brace `{` from startIdx onward
        let braceIdx = -1;
        for (let k = i; k < lines.length; k++) {
            if (lines[k].includes('{')) {
                braceIdx = k;
                break;
            }
        }

        let endLine = startLine;

        if (braceIdx === -1) {
            // Abstract method or interface method: collect until semicolon
            for (let k = i; k < lines.length; k++) {
                if (lines[k].includes(';')) {
                    endLine = k + 1;
                    break;
                }
            }
        } else {
            // Brace matching from braceIdx onward
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
                            endLine = k + 1; // 1-based
                            foundEnd = true;
                            break;
                        }
                    }
                }
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
