# Java Inspector MCP — Prompt

> Feed this file to Claude Code as follows:
> ```bash
> claude < java-decompiler-mcp-prompt.md
> ```
> Or copy the contents and paste it into the Claude Code chat.

---

## TASK

Write a production-ready MCP (Model Context Protocol) server that meets all the requirements below.
Project name: `java-decompiler-mcp`
Language: TypeScript (Node.js)
Platform: Must work on both Windows and Linux, no hardcoded paths anywhere.

---

## PROJECT STRUCTURE

Create the following file structure:

```
java-decompiler-mcp/
├── src/
│   ├── index.ts          # MCP server entry point
│   ├── scanner.ts        # JAR scanner and class index builder
│   ├── decompiler.ts     # Java decompiler wrapper
│   ├── cache.ts          # In-memory index and decompile cache
│   └── logger.ts         # Singleton logger (stderr only)
├── decompilers/
│   └── .gitkeep          # cfr.jar or fernflower.jar goes here
├── package.json
├── tsconfig.json
└── README.md
```

---

## DEPENDENCIES (package.json)

```json
{
  "name": "java-decompiler-mcp",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "adm-zip": "^0.5.10",
    "p-limit": "^5.0.0"
  },
  "devDependencies": {
    "@types/adm-zip": "^0.5.5",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

---

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## MODULE 1: src/logger.ts

Write a Singleton Logger class. Rules:

- NEVER use `console.log()`. All logs must go through `process.stderr`.
- `process.stdout` is only used for MCP SDK's JSON-RPC messages.
- Using `console.log()` breaks the protocol and disconnects Claude Code — STRICTLY PROHIBITED.
- Log format: `[ISO_TIMESTAMP] [LEVEL] message\n`
- Keep the last 500 log entries in a circular buffer (array).
- Log levels: DEBUG, INFO, WARN, ERROR
- If `DEBUG=true` environment variable is set, write DEBUG level logs to stderr as well; otherwise only INFO and above.

```typescript
// Usage example:
// logger.info("Scanning started");
// logger.error("JAR read failed: " + err.message);
// logger.debug("Found class: com.example.Foo");

// getLogs() method: returns the last N entries (default 100)
```

---

## MODULE 2: src/cache.ts

In-memory cache module. Maintain two separate Maps:

1. **Class Index**: `Map<string, string[]>`
   - Key: fully-qualified class name (e.g. `com.example.MyClass`)
   - Value: list of absolute paths to JAR files containing this class

2. **Decompile Cache**: `Map<string, string>`
   - Key: fully-qualified class name
   - Value: decompiled Java source code (string)

Also store:
- `lastScanPath: string`
- `lastScanTime: Date`
- `jarCount: number`
- `classCount: number`
- `isIndexed: boolean`

Exported functions:
- `setIndex(map, jarCount, classCount, scanPath)`
- `getIndex(): Map<string, string[]>`
- `isIndexReady(): boolean`
- `getStats(): object`
- `getCachedSource(className): string | undefined`
- `setCachedSource(className, source): void`
- `clearCache(): void`

---

## MODULE 3: src/scanner.ts

JAR scanner module. Implement the following functions:

### `findJavaBinary(): string`

Find the Java binary. Try in order:
1. `JAVA_HOME` environment variable + `/bin/java` (Linux) or `\bin\java.exe` (Windows)
2. Find `java` command in `PATH` using `which` (Linux) / `where` (Windows)
3. Check common paths:
   - Linux: `/usr/bin/java`, `/usr/local/bin/java`
   - Windows: `C:\Program Files\Java\*\bin\java.exe` (using glob)
4. If none found: throw error `"JAVA_HOME environment variable not set. Add JAVA_HOME to MCP config."`

Use `process.platform === 'win32'` for platform detection.
Always use `path.join()` for path concatenation.

### `scanProject(projectPath: string): Promise<ScanResult>`

1. Recursively scan all directories under `projectPath`.
2. Find all files with `.jar` extension (case-insensitive).
3. For each JAR, use `adm-zip` — only read entry names, do NOT extract content.
4. Find entries ending with `.class`, convert path to class name:
   - `com/example/MyClass.class` → `com.example.MyClass`
   - Include inner classes: `com/example/Outer$Inner.class` → `com.example.Outer$Inner`
5. Update the class index Map.
6. **Parallel scanning**: Process all JARs in parallel with `p-limit` at concurrency 20.
7. Send MCP notification every 50 JARs (progress notification).
8. Save result to cache and return:
   ```typescript
   { jarCount: number, classCount: number, scanDurationMs: number }
   ```

**Performance criteria:**
- 500 JARs must be scanned in under 10 seconds.
- Large JARs (100MB+) must not be loaded into memory — only the entry list should be read.

---

## MODULE 4: src/decompiler.ts

### `findDecompilerJar(): string`

Check the `decompilers/` folder relative to the MCP server's directory.
Search in this order: `cfr.jar`, `cfr-*.jar`, `fernflower.jar`
If not found, throw an error and explain how to download it from the README.

### `extractClassFromJar(jarPath, className, tempDir): Promise<string>`

1. Open the JAR with `adm-zip`.
2. Find the entry for `com/example/MyClass.class`.
3. Extract it to a unique temp directory under `os.tmpdir()`.
4. Return the path of the extracted `.class` file.

### `decompileClass(className: string): Promise<DecompileResult>`

1. Check cache — return immediately if found.
2. Find JAR path using `getIndex()`.
3. Create a unique temp directory under `os.tmpdir()`.
4. Extract the class file.
5. Run the decompiler command:

**For CFR:**
```
java -jar /path/to/cfr.jar <extracted_class_file> --outputdir <output_dir>
```

**For Fernflower:**
```
java -jar /path/to/fernflower.jar <input_dir> <output_dir>
```

6. Use `child_process.execFile()` — NEVER use `exec()`.
7. Timeout: **30000ms** (30 seconds). Return a descriptive error on timeout.
8. Capture stdout and stderr, log both.
9. If exit code is not 0: include stderr content in the error message.
10. Read the `.java` file from the output directory and return it.
11. Clean up the temp directory (`fs.rm(tempDir, { recursive: true })`).
12. Save result to decompile cache.
13. Return:
    ```typescript
    {
      className: string,
      jarPath: string,
      allJarPaths: string[],
      source: string,
      fromCache: boolean,
      durationMs: number
    }
    ```

---

## MODULE 5: src/index.ts — MCP Server

Create an MCP server using `@modelcontextprotocol/sdk`.
Transport: `StdioServerTransport`

### CRITICAL STDOUT RULE

```
stdout = ONLY JSON-RPC (SDK handles it)
stderr = ALL LOGS (via logger.ts)
console.log() = STRICTLY PROHIBITED — breaks the protocol
```

### MCP Progress Notifications

Use the SDK's notification system for progress notifications inside tool handlers:

```typescript
await server.notification({
  method: "notifications/message",
  params: {
    level: "info",           // "debug" | "info" | "warning" | "error"
    logger: "java-decompiler",
    data: "Message content..."
  }
});
```

Notification points:
- `scan_project`: Every 50 JARs send `"Scanned X/Y JARs..."`
- `decompile_class`: `"Extracting class..."`, `"Running decompiler..."`, `"Done."`
- On any error, send a detailed error notification

### Tool 1: `scan_project`

```
Input:  { projectPath: string }
Output: { jarCount, classCount, scanDurationMs }
```

- Check if projectPath exists; if not, return a descriptive error.
- Call `scanner.scanProject()`.
- Send notification every 50 JARs.
- Log start/end with logger.

### Tool 2: `decompile_class`

```
Input:  { className: string }
Output: { className, jarPath, allJarPaths, source, fromCache, durationMs }
```

- If index is not ready: return error `"Run scan_project first"`
- Call `decompiler.decompileClass()`.
- Notify decompile steps via notification.
- On error, return stderr + exit code information.

### Tool 3: `search_class`

```
Input:  { query: string }
Output: { matches: [{ className, jarPaths }] }
```

- Perform three-stage search on the index:
  1. Exact match: `com.example.MyClass`
  2. Suffix match: all classes ending with `.MyClass`
  3. Substring match: all classes containing the query string
- Sort results in order: exact → suffix → substring.
- Return maximum 50 results.
- If index is not ready, return a descriptive error.

### Tool 4: `get_index_stats`

```
Input:  (none)
Output: { indexed, jarCount, classCount, lastScanPath, lastScanTime, memoryUsageMB }
```

- Call `cache.getStats()`.
- Add memory usage in MB using `process.memoryUsage().heapUsed`.

### Tool 5: `debug_class`

```
Input:  { className: string, verbose?: boolean }
Output: { steps: string[], success: boolean, source?: string, error?: string }
```

Proceed by adding each step to the `steps` array:

1. `"[1/7] Index status: X JARs, Y classes"`
2. `"[2/7] Searching for exact match: <className>"`
3. `"[3/7] Found JARs: [path1, path2, ...]"`
4. `"[4/7] Selected JAR: <path> (first match)"`
5. `"[5/7] Temp directory: <os.tmpdir()>"`
6. `"[6/7] Decompiler command: java -jar <decompiler.jar> <args>"`
7. `"[7/7] Exit code: 0, Duration: Xms"`

If `verbose: true`, also add stdout and stderr to steps.
On error, return the full error message and possible solution suggestions.

### Tool 6: `get_logs`

```
Input:  (none)
Output: { logs: [{ time, level, message }], totalCount }
```

- Call `logger.getLogs(100)`.
- Return the last 100 log entries.

---

## ERROR HANDLING

Wrap all tool handlers in try/catch. The MCP server must NEVER crash.

| Situation | Message to Return |
|---|---|
| No index | "Run scan_project first. Example: scan_project({ projectPath: '/project/directory' })" |
| Class not found | "Class not found. Search for similar names with search_class." |
| java not found | "java binary not found. Add JAVA_HOME environment variable to MCP config." |
| Decompiler JAR missing | "Place cfr.jar in the decompilers/ folder. Download: https://www.benf.org/other/cfr/" |
| Timeout | "Decompiler did not complete in 30 seconds. This may be normal for large class files." |
| Child process error | "Decompiler exit code: X. Stderr: <stderr content>" |

---

## README.md

Write a comprehensive README with the following sections:

### 1. Installation
```bash
git clone <repo>
cd java-decompiler-mcp
npm install
npm run build
```

### 2. Download Decompiler JAR
CFR (recommended):
- Download `cfr.jar` from https://www.benf.org/other/cfr/
- Save as `decompilers/cfr.jar`

Fernflower (alternative):
- Can be extracted from IntelliJ IDEA Community Edition
- Save as `decompilers/fernflower.jar`

### 3. Claude Code Integration

Add to `~/.claude.json` or Claude Code MCP settings:

```json
{
  "mcpServers": {
    "java-decompiler": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/java-decompiler-mcp/dist/index.js"],
      "env": {
        "JAVA_HOME": "/path/to/jdk",
        "DEBUG": "false"
      }
    }
  }
}
```

**Windows example:**
```json
{
  "mcpServers": {
    "java-decompiler": {
      "command": "node",
      "args": ["C:\\tools\\java-decompiler-mcp\\dist\\index.js"],
      "env": {
        "JAVA_HOME": "C:\\Program Files\\Java\\jdk-21",
        "DEBUG": "false"
      }
    }
  }
}
```

### 4. Usage Examples

```
# Scan project
scan_project({ projectPath: "/my/java/project" })

# Search class
search_class({ query: "UserService" })

# Decompile class
decompile_class({ className: "com.example.service.UserService" })

# View stats
get_index_stats()

# Debug
debug_class({ className: "com.example.Foo", verbose: true })

# View logs
get_logs()
```

### 5. Debug Guide (Step by Step)

**Issue: Class not found**
1. Run `get_index_stats` → is indexed: true?
2. Run `search_class({ query: "MyClass" })` → is the class in the index?
3. If not, run `scan_project` again with the correct `projectPath`
4. Verify the JAR exists at the specified path

**Issue: Decompile failed**
1. Run `debug_class({ className: "...", verbose: true })`
2. Copy the decompiler command from the `steps` array
3. Run it manually in the terminal → see the actual error
4. Inspect the full log history with `get_logs()`

**Issue: Java not found**
1. Run `java -version` in the terminal
2. If it works: find the path with `which java` (Linux) or `where java` (Windows)
3. Set the parent directory of the found path as `JAVA_HOME`

**Issue: MCP connection dropping**
- Using `console.log()` breaks the protocol
- Set `DEBUG=true` and inspect stderr output:
  ```bash
  node dist/index.js 2>debug.log
  ```

### 6. Troubleshooting Table

| Symptom | Possible Cause | Solution |
|---|---|---|
| "index empty" | scan_project not run | Call scan_project |
| "java not found" | JAVA_HOME missing | Add JAVA_HOME to MCP env |
| "decompiler JAR not found" | JAR missing | Place cfr.jar under decompilers/ |
| "class not in index" | JAR not scanned | Expand projectPath |
| Timeout (30s) | Large class file | Normal, retry |
| MCP connection dropping | console.log usage | Never use console.log |
| Exit code 1 | Wrong decompiler args | Check with debug_class verbose |

---

## FINAL CHECKLIST

After completing the code, verify the following:

- [ ] `npx tsc` compiles without errors
- [ ] `console.log()` does NOT exist in any file (verify with grep)
- [ ] All path concatenations use `path.join()`
- [ ] `child_process.execFile()` is used (not `exec()`)
- [ ] All async functions are wrapped in try/catch
- [ ] MCP server waits for stdio when started without arguments
- [ ] Windows `process.platform === 'win32'` check exists
- [ ] Temp files are cleaned up after processing
- [ ] README is complete and includes examples for both platforms
- [ ] `decompilers/.gitkeep` file exists

---

*Write all modules from scratch according to the specification above. Do not modify existing code. Create each file in full and working state.*