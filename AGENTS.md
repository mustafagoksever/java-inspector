# Agent Instructions — java-inspector

## What this is
TypeScript MCP server that decompiles Java classes from Maven dependencies using Vineflower. Ships as an npm package with a bundled Vineflower JAR.

## Developer commands

| Task | Command |
|------|---------|
| Build (compile `src/` → `dist/`) | `npm run build` |
| Run dev (no build step) | `npm run dev` (uses `tsx`) |
| Start built server | `npm start` |
| Test | `npm test` (Jest, currently no test files exist) |
| Publish prep | `npm run prepublishOnly` (runs `tsc`) |

## Runtime requirements
- **Node.js ≥ 16**
- **Java runtime** (for Vineflower decompiler and `javap`)
- **Maven** (for `dependency:build-classpath` scanning)

## Architecture & entry points

| File | Role |
|------|------|
| `src/index.ts` | MCP server (`JavaClassAnalyzerMCPServer`). Exposes 5 tools: `scan_dependencies`, `decompile_class`, `analyze_class`, `search_class`, `get_inheritance_tree` |
| `src/cli.ts` | Commander CLI. Default action (no args) starts the MCP server |
| `src/cache/ProjectCache.ts` | Cache I/O: JSONL append-only persistence, in-memory `Map` index, pom/classpath hash validation, file-level locking |
| `src/scanner/DependencyScanner.ts` | Runs `mvn dependency:build-classpath`, parses JAR paths. Singleton. Integrates BackgroundScanner + LazyResolver |
| `src/scanner/BackgroundScanner.ts` | Background batch parallel JAR scanning (20 JARs at a time). Writes to JSONL incrementally |
| `src/scanner/LazyResolver.ts` | On-demand class resolution: O(1) memory lookup, parallel JAR search on cache miss |
| `src/decompiler/DecompilerService.ts` | Extracts `.class` from JARs (via `yauzl`), runs Vineflower (`java -jar vineflower.jar <class> <outdir>`). Reads generated `.java` from output dir and cleans up temp files |
| `src/analyzer/JavaClassAnalyzer.ts` | Runs `javap -v -cp <jar> <class>` and parses the text output |
| `src/utils/methodExtractor.ts` | Extracts a single method body from decompiled source via regex + brace matching. Handles strings, line/block comments, nested braces, and abstract methods. |
| `src/utils/cachePaths.ts` | Cache lives under **`~/.cache/java-inspector/<project>_<hash>/`** |

## Build & module system
- ES modules (`"type": "module"` in `package.json`)
- `tsc` emits to `dist/` with `.js`, `.d.ts`, and source maps
- `tsconfig.json` excludes `**/*.test.ts`

## Bundled Vineflower JAR — do not break
- The repo ships `lib/vineflower-1.11.2.jar` (~1.8 MB)
- `.gitignore` has `lib/vineflower-*.jar` **and** `!lib/vineflower-*.jar` to allow tracking the shipped JAR
- `DecompilerService.findVineflowerJar()` resolution order:
  1. `DECOMPILER_PATH` env var
  2. `<packageRoot>/lib/` (for npx / global install)
  3. `<cwd>/lib/` (for local development)
- `getPackageRoot()` assumes built layout: `dist/decompiler/DecompilerService.js` → up 3 levels. If you move files, update this.

## Environment variables
| Var | Purpose |
|-----|---------|
| `NODE_ENV` | `development` enables extra `console.error` debug logging |
| `JAVA_HOME` | Locates `java`, `javap` |
| `MAVEN_HOME` | Locates `mvn` / `mvn.cmd` |
| `MAVEN_CMD` | Override Maven executable (e.g., `mvnd`, `mvnw`, full path) |
| `MAVEN_REPO` | Overrides local Maven repo path (default: `~/.m2/repository`) |
| `DECOMPILER_PATH` | Override Vineflower JAR location |

### Maven command resolution order
1. `MAVEN_CMD` env var (explicit override)
2. `mvnd` (Maven Daemon) — auto-detected via `mvnd --version`, ~2x faster on warm cache
3. `MAVEN_HOME/bin/mvn`
4. `mvn` (system PATH)

## Timeouts
- JAR class extraction (background scan): 30 s per JAR (`extractClassesFromJarWithTimeout`)
- Vineflower decompilation: 30 s (`decompileWithVineflower`)
- `javap` analysis: 10 s (`analyzeClassWithJavap`)
- Maven `dependency:build-classpath`: 120 s timeout
- Lazy JAR search (on-demand): 5 s per JAR (`findClassInJar`)
- `execFile` for Maven uses `shell: true` on Windows.

## Publishing
- CI (`.github/workflows/npm-publish-github-packages.yml`) runs `npm ci` + `npx jest --passWithNoTests` on release creation, then publishes to npm with `--access public`
- `prepublishOnly` and `prepack` both run `npm run build`
- Published files: `dist/**/*`, `lib/**/*`, `README.md`, `LICENSE` (see `files` in `package.json` and `.npmignore`)

## Cache behavior
Cache lives under the **user home** (`~/.cache/java-inspector/...`), not in the project directory.

### Cache file structure
```
~/.cache/java-inspector/<project>_<hash>/
├── classpath.json           # { pomHash, jarPaths[], classpathHash, timestamp }
├── class-index.jsonl        # Append-only JSON Lines. Each line = ClassIndexEntry[]
├── scan-state.json          # { jarCount, processedJars[], isComplete, pomHash, classpathHash }
└── decompile-cache/         # Cached decompiled .java sources
```

### Why JSON Lines?
- **Append-only**: No O(n²) rewrite overhead. Background scanner appends batch entries (~200 KB) instead of rewriting a 20-30 MB JSON file.
- **Crash-safe**: Each line is independent. Corrupted last line is skipped on load.
- **Fast recovery**: Server restart replays JSONL into an in-memory `Map<string, ClassIndexEntry>`.

### In-memory index
- `Map<className, ClassIndexEntry>` stored in `ProjectCache.indexes`
- O(1) exact lookups (`getEntry()`)
- O(n) iteration for fuzzy search (`getAllEntries()`)
- ~35 MB RAM for 100,000 classes
- Deduplicated concurrent loads via `loadPromises` map

### Cache invalidation
| Trigger | Mechanism |
|---------|-----------|
| Module `pom.xml` changes | `pomHash` mismatch in `isIndexComplete()` |
| Parent POM / dependency management changes | `classpathHash` mismatch in `isIndexComplete()` |
| Manual force refresh | `scan_dependencies` with `forceRefresh: true` |

`isIndexComplete()` checks **both** `pomHash` and `classpathHash`. If either changed, returns `false`, triggering a fresh scan.

### Locking
- `ProjectCache.withLock()` serializes write operations per project using a Promise chain.
- `appendToClassIndex()` acquires lock → appends to JSONL → updates memory Map → writes scan-state → releases lock.
- Reads (from memory Map) do **not** acquire locks.

## Tool behavior

### `scan_dependencies`
- **Non-blocking**: Returns immediately with status (`complete` or `in_progress`)
- On first call: resolves Maven classpath (~5-10 s), starts background scan
- On subsequent calls: returns current progress or cached complete index
- `forceRefresh`: invalidates disk + memory cache, restarts scan

### Auto-scan on startup
If the MCP server is launched from a directory containing `pom.xml`, it automatically
starts `scan_dependencies` in the background during server initialization. This is
non-blocking — the server accepts tool calls immediately. If `pom.xml` is not found
in `cwd`, the server starts normally and waits for manual `scan_dependencies` calls.

### `decompile_class`
- `ensureScanStarted()` checks if index exists. If not, starts background scan (non-blocking).
- `findJarForClass()` first checks in-memory `Map` (O(1)). If miss, searches JARs on-demand in parallel batches.
- Temp `.class` file is **always cleaned up** after decompilation (regardless of `useCache`).
- Vineflower writes output to a temporary directory; the generated `.java` file is read and the temp directory is cleaned up automatically.
- **Method extraction**: pass `methodName` to extract a single method body instead of the full class. Uses `methodExtractor.ts` (regex + brace matching).
- **Pagination**: pass `offset` (1-based) and `limit` to return a slice of lines. `limit=0` means all lines. Ignored when `methodName` is provided.

### `analyze_class`
- `ensureScanStarted()` checks if index exists. If not, starts background scan (non-blocking).
- `findJarForClass()` first checks in-memory `Map` (O(1)). If miss, searches JARs on-demand in parallel batches.

### `search_class`
- Iterates the live in-memory Map. Returns partial results if background scan is still running.
- Adds a note about scan completion percentage when incomplete.

## Gotchas
- No Jest config file exists; `npm test` relies on Jest defaults.
- No actual test files exist in the repo yet.
- The scanner uses `mvn dependency:build-classpath`, not `dependency:tree`. No regex parsing.
- `yauzl` is used for ZIP/JAR reading (streams, lazy entries). Be careful with resource leaks; the code already ignores close errors in catch blocks.
- Inner classes (`$` in filename) are intentionally skipped during index building.
- Gradle is **not** supported; only Maven.
- Brute-force fallback (`~/.m2/repository` recursive scan) has been **removed**. If Maven fails, the tool returns an error.

## Logging

Each project gets its own append-only log file under the cache directory:
```
~/.cache/java-inspector/<project>_<hash>/server.log
```

### Log format
```
[2025-01-15T09:23:45.123Z] [DEBUG] [SERVER] java-inspector v2.0.6 MCP Server running on stdio (DEBUG MODE)
[2025-01-15T09:23:45.145Z] [INFO]  [AUTO-SCAN] Maven project detected at /path/to/project
[2025-01-15T09:23:45.200Z] [INFO]  [MAVEN] Resolving command... mvnd detected in 24ms. Selected: mvnd
[2025-01-15T09:23:45.211Z] [INFO]  [MAVEN] Running: mvnd dependency:build-classpath...
[2025-01-15T09:24:09.405Z] [INFO]  [MAVEN] Classpath resolved in 24.2s.
[2025-01-15T09:24:09.410Z] [INFO]  [SCAN] Background scan started. Total JARs: 847
[2025-01-15T09:24:09.420Z] [DEBUG] [SCAN] Processing batch 1/43 (20 JARs)...
...
[2025-01-15T09:25:10.234Z] [INFO]  [TOOL:analyze_class] Request: className=io.micrometer.observation.ObservationRegistry, filter=all
[2025-01-15T09:25:10.235Z] [INFO]  [TOOL:analyze_class] Complete in 0.8s. Fields: 12, Methods: 45
```

### Context tags
| Tag | Description |
|-----|-------------|
| `[SERVER]` | Server startup/shutdown |
| `[AUTO-SCAN]` | Automatic scan on startup |
| `[MAVEN]` | Maven command resolution & classpath building |
| `[SCAN]` | Background JAR scanning |
| `[JAVAP]` | `javap` class analysis |
| `[DECOMPILE]` | Vineflower decompilation |
| `[TOOL:<name>]` | Tool call entry/exit with duration |
| `[CACHE]` | Cache invalidation & state |

### Viewing logs while Opencode is connected
```powershell
# PowerShell
Get-Content ~/.cache/java-inspector/<project>_<hash>/server.log -Wait -Tail 20

# Unix/macOS
tail -f ~/.cache/java-inspector/<project>_<hash>/server.log
```

Log files are **cleared when cache is invalidated** (`forceRefresh: true` or hash mismatch).

## MCP client config (for local testing)
```json
{
  "mcpServers": {
    "java-inspector": {
      "command": "node",
      "args": ["dist/cli.js"]
    }
  }
}
```
