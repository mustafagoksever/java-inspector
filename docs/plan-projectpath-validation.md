# Plan: Validate `projectPath` in All Tools

## Problem
All MCP tools accept a `projectPath` parameter but do not validate it before attempting Maven operations or file I/O. Invalid paths lead to cryptic downstream errors (e.g., Maven timeout, ENOENT) instead of clear, immediate feedback.

## Solution
Add an early `validateProjectPath` helper and call it at the start of every tool handler.

## Affected File
`src/index.ts` — `JavaClassAnalyzerMCPServer` class.

## Validation Rules
1. **Required**: `projectPath` must be provided (non-empty string).
2. **Absolute path**: Must be an absolute path (Windows: `C:\...`, Unix: `/...`). Relative paths (`./`, `../`) are rejected.
3. **Exists & is directory**: Path must exist on disk and be a directory.
4. **Maven project root**: Directory must contain a `pom.xml` file.

## Implementation Details

### 1. Add imports
Add `fs-extra` and switch `path` to namespace import:
```typescript
import * as path from 'path';
import fs from 'fs-extra';
```
Update existing `resolve` / `dirname` usage to `path.resolve` / `path.dirname`.

### 2. Add helper method
```typescript
private async validateProjectPath(projectPath: string): Promise<void> {
    if (!projectPath || typeof projectPath !== 'string') {
        throw new Error('projectPath is required and must be a string.');
    }
    if (!path.isAbsolute(projectPath)) {
        throw new Error(`projectPath must be an absolute path. Received: ${projectPath}`);
    }
    if (!(await fs.pathExists(projectPath))) {
        throw new Error(`projectPath does not exist: ${projectPath}`);
    }
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) {
        throw new Error(`projectPath is not a directory: ${projectPath}`);
    }
    const pomPath = path.join(projectPath, 'pom.xml');
    if (!(await fs.pathExists(pomPath))) {
        throw new Error(`No pom.xml found in ${projectPath}. Ensure this is a Maven project root.`);
    }
}
```

### 3. Invoke validation in every tool
Call `await this.validateProjectPath(args.projectPath);` inside each `case` before delegating to the handler:
- `scan_dependencies`
- `decompile_class`
- `analyze_class`
- `search_class`
- `get_inheritance_tree`
- `find_implementations`

## Notes
- This validation runs **before** `ensureScanStarted`, so invalid paths fail immediately without starting a background scan.
- `decompilerPath` (used by `decompile_class`) is not validated here; it is handled separately inside `DecompilerService`.
