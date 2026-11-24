# Agent Instructions — java-inspector

## What this is
TypeScript MCP server that decompiles Java classes from Maven and Gradle dependencies using Vineflower. Ships as an npm package with a bundled Vineflower JAR.

## Developer commands

| Task | Command |
|------|---------|
| Build (compile `src/` → `dist/`) | `npm run build` |
| Run dev (no build step) | `npm run dev` (uses `tsx`) |
| Start built server | `npm start` |
| Test | `npm test` (Jest + ts-jest, ESM) |
| Publish prep | `npm run prepublishOnly` (runs `tsc`) |

## Runtime requirements
- **Node.js ≥ 20** (required by commander 14 and the MCP SDK)
- **Java runtime** (for Vineflower decompiler and `javap`)
- **Maven** (for `dependency:build-classpath` scanning) or **Gradle** / the project's `gradlew` for Gradle builds

## Architecture & entry points

| File | Role |
|------|------|
| `src/index.ts` | MCP server (`JavaClassAnalyzerMCPServer`, built on `McpServer.registerTool`). Exposes 13 read-only tools: `scan_project`, `find_jar`, `inspect_jar`, `search_class`, `search_code`, `find_implementations`, `find_duplicates`, `inspect_class`, `explain_dependency`, `compare_versions`, `list_dependencies`, `search_resources`, `read_resource`. Response size limits: `SOURCE_AUTO_LIMIT`/`SOURCE_AUTO_PREVIEW`, `BYTECODE_AUTO_LIMIT`, `MAX_RESPONSE_CHARS` (`capResponse`). `SERVER_INSTRUCTIONS` is sent to clients on initialize. |
| `src/cli.ts` | Commander CLI. Default action (no args) starts the MCP server |
| `src/cache/ProjectCache.ts` | Cache I/O: JSONL append-only persistence, in-memory `Map` index, pom/classpath hash validation, **cross-process file locking** via `proper-lockfile` |
| `src/scanner/DependencyScanner.ts` | Runs `mvn -B dependency:build-classpath` with one output file per reactor module (`cp-${project.groupId}__${project.artifactId}.txt`), merges and de-duplicates JAR paths. Singleton. Integrates BackgroundScanner + LazyResolver |
| `src/scanner/ArtifactService.ts` | Selector resolution (workspace / jarPath / jarDirectory / prefix / coordinates), class, code and resource search |
| `src/scanner/ProjectDiscovery.ts` | Breadth-first top-level `pom.xml` discovery (depth ≤ 4, ≤ 5,000 dirs, 30 s cache) |
| `src/scanner/BackgroundScanner.ts` | Background batch parallel JAR scanning (20 JARs at a time). Writes to JSONL incrementally |
| `src/scanner/LazyResolver.ts` | On-demand class resolution: O(1) memory lookup, parallel JAR search on cache miss |
| `src/decompiler/DecompilerService.ts` | Extracts `Outer.class` **and all `Outer$*.class`** from the JAR (via `yauzl`), runs Vineflower (`java -jar vineflower.jar -e=<jar> <classes...> <outdir>`). Reads generated `.java` from output dir and cleans up temp files |
| `src/analyzer/JavaClassAnalyzer.ts` | Runs `javap` (`-p` signatures for the API view, `-c -l -p -s` for bytecode, `-v` parsing for hierarchy) |
| `src/utils/methodExtractor.ts` | Extracts a single method body from decompiled source via regex + brace matching. Handles strings, line/block comments, nested braces, and abstract methods. `extractTypeDeclaration` cuts a nested type (`Outer$Inner`) out of the outer class source. |
| `src/utils/javaOutline.ts` | Brace-aware member outline of Java source (`buildOutline`, `extractMembers`, `memberAtLine`), javap `-c -l` member parsing (`parseJavapMembers`, `javapMemberAtLine`), `cleanDecompilerFailures` |
| `src/analyzer/ApiDiff.ts` | Public/protected API diff of two sets of class-file metadata (`compare_versions`) |
| `src/utils/cachePaths.ts` | Cache lives under **`~/.cache/java-inspector/<project>_<hash>/`** |

## Build & module system
- ES modules (`"type": "module"` in `package.json`)
- `tsc` emits to `dist/` with `.js`, `.d.ts`, and source maps
- `tsconfig.json` excludes `**/*.test.ts`

## Bundled Vineflower JAR — do not break
- The repo ships `lib/vineflower-1.12.0.jar` (~1.6 MB)
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
| `GRADLE_CMD` / `GRADLE_HOME` | Gradle executable (default order: `GRADLE_CMD`, `<project>/gradlew`, `GRADLE_HOME/bin/gradle`, `gradle`) |
| `JAVA_INSPECTOR_DOWNLOAD_SOURCES` | Default for `inspect_class downloadSources` |
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
- Maven `dependency:build-classpath`: 300 s timeout; `dependency:tree` (explain_dependency): 120 s; `dependency:tree` (list_dependencies / recovery): 300 s; `dependency:get` (downloads): 120 s
- Gradle classpath init script: 300 s
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
├── server-<pid>.log         # Per-process append-only logs (PID-separated for multi-process safety)
├── write.lock               # Cross-process lock for JSONL / state writes
├── scan.lock                # Cross-process lock for scan lifecycle
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
| Manual force refresh | `scan_project` with `forceRefresh: true` |

`isIndexComplete()` checks **both** `pomHash` and `classpathHash`. If either changed, returns `false`, triggering a fresh scan.

### Locking
Two-tier locking prevents race conditions across multiple MCP server instances:

| Lock | Type | Protects | Duration |
|------|------|----------|----------|
| `write.lock` | Cross-process (`proper-lockfile`) | JSONL append, state writes, classpath save | Per operation (ms–s) |
| `scan.lock` | Cross-process (`proper-lockfile`) | Classpath resolution + background scan | Full scan lifecycle (minutes) |
| In-process Promise | Process-local | Memory Map updates, concurrent deduplication | Per operation |

- `ProjectCache.withInProcessLock()` serializes in-process write operations.
- `ProjectCache.appendToClassIndex()` acquires **both** `write.lock` (cross-process) and in-process lock.
- `DependencyScanner.scanProject()` acquires `scan.lock`; released automatically when scan completes or fails.
- `forceRefresh: true` force-releases both locks before invalidating cache.
- Reads (from memory Map) do **not** acquire locks.

#### Lock parameters
- `stale: 60000` (60s) — lock becomes stale if owner dies (SIGKILL)
- `update: 30000` (30s) — mtime refreshed while owner is alive
- Process alive → lock never goes stale. Process killed → stale after 60s, then another process can acquire.

## Tool behavior

All tools are registered with `readOnlyHint: true`. Handler errors are returned as `isError: true` results (never as JSON-RPC errors) — keep the `await` in the `register()` wrapper in `src/index.ts`.

Tool descriptions and `SERVER_INSTRUCTIONS` are what make agents choose these tools over shelling out to `javap`/`unzip`. When adding or changing a tool, say in its description which shell command it replaces and describe every parameter.

### `scan_project`
- **Non-blocking**: returns immediately with `complete` or `in_progress`. Normally not needed because of auto-scan.
- `forceRefresh`: invalidates disk + memory cache, force-releases locks, restarts scan.
- **Cross-process safety**: if another process holds `scan.lock`, returns `in_progress`.

### Auto-scan on startup
After the transport connects, top-level `pom.xml` directories under `cwd` are discovered (bounded BFS) and scanned in the background. Other tools work immediately on the partial index and report `complete: false`.

### `inspect_class`
- For Maven dependencies only `className` is needed; the JAR comes from the project classpath. On a cold start (classpath not resolved yet) the lookup waits up to 90 s for Maven (`DependencyScanner.waitForClasspath`, progress notifications sent) instead of failing; `search_class` waits up to 30 s in `balanced` mode. While the background index is incomplete, JARs whose Maven path matches the package (`ArtifactService.packageRelevance`) are opened first.
- Requires an **exact** class name match (FQN, or simple name if unique). Never falls back to fuzzy matches; on a miss it errors with similar class suggestions.
- `view=source`: embedded `.java` → `*-sources.jar` → Vineflower. Response states the source origin. `methodName`/`paramTypes` extract one method; `offset`/`limit` page lines and the response reports `Lines: x-y of N`.
- Nested classes: `Outer$Inner` (binary name) or `Outer.Inner` (source-style, retried as `Outer$Inner`). Resolution goes through the outer class (`ArtifactService.searchNestedClasses`), because the index skips inner classes. `view=source` loads the outer source and returns only the nested declaration (`Enclosing class:` in the response); anonymous classes (`Outer$1`) fall back to the full outer source with a note. api/bytecode/hierarchy run on the nested `.class` itself.
- `view=outline`: members with line ranges. Sources over `SOURCE_AUTO_LIMIT` lines without offset/limit return the first lines plus this outline.
- `line`: stack-trace line → containing member (real sources: numbered lines with `>>`; decompiled: located through the javap `LineNumberTable`, lambdas map to their enclosing method).
- `methodName` not declared in the class → BFS over superclasses/interfaces (`inheritedMemberSource`, ≤ 25 classes).
- `downloadSources` (Maven): `mvn dependency:get ...:jar:sources` once per GAV, then the sources JAR is used.
- Vineflower failures (`$VF: Couldn't be decompiled`) are cleaned by `cleanDecompilerFailures`; failed methods are listed in `sourceNote`.
- `view=api`: `javap -p` output (in `json` format too; the separate fields/methods arrays were dropped because they duplicated it).
- `view=hierarchy`: superclass chain with interfaces per level.
- `view=bytecode`: `javap -c -l -p -s`; with `methodName`/`line` only that member; over `BYTECODE_AUTO_LIMIT` lines only member signatures.

### `search_class` / `search_code` / `find_implementations` / `search_resources`
- Use the live in-memory index first, then open unindexed JARs on demand within a per-call budget; `complete: false` + `remainingJarCount` tell the agent to call again or narrow with `jarNamePrefix`/`jarPath`.
- `search_code` / `find_implementations` order JARs with `orderForDeepSearch`: already deep-indexed JARs first (free), then by `packageRelevance` of the target class / reference owner, so the new-JAR budget goes to the likeliest artifacts.

### `compare_versions`
- Inputs: `coordinates` + `toVersion` (`fromVersion` defaults to the classpath JAR of that artifact), or `fromJarPath` + `toJarPath`; `className` / `packagePrefix` narrow it; `download` runs `mvn dependency:get`.
- Diff is computed from the deep indexes (`ClassFileMetadataReader`) by `diffApi`: public/protected, non-synthetic, non-bridge members keyed by name+descriptor. Breaking: removed class/member, narrowed visibility, static/final/abstract changes, superclass change, removed interface, new abstract method. Removed `toString/hashCode/equals` overrides are not breaking.

### `list_dependencies`
- `mvn dependency:tree -DoutputFile=tree-${project.groupId}__${project.artifactId}.txt` (one file per module), parsed by `parseDependencyTree` (depth from the tree prefix, `via` = parent). Cached in `dependency-tree.json` keyed by pom hash + classpath hash. Maven only.

### Gradle
- `buildToolOf()` (ProjectDiscovery): `pom.xml` → maven (preferred), else `settings.gradle[.kts]`/`build.gradle[.kts]` → gradle. Discovery returns both kinds of roots.
- `getGradleClasspath`: writes `GRADLE_INIT_SCRIPT` (task `javaInspectorClasspath` on every project, lenient `artifactView` of compile/runtime/test classpaths) and runs it with `--no-configuration-cache`.
- `getPomHash` hashes root Gradle build files + `gradle/libs.versions.toml` when there is no pom.
- Gradle cache JARs (`files-2.1/<g>/<a>/<v>/<sha1>/`) are understood by `coordinatesFromJarPath` and `findSourcesJar`.

### Multi-module recovery
- If `dependency:build-classpath` fails with an unresolved (unbuilt sibling) module, `recoverReactorClasspath` reruns it with `-fae` and adds external dependencies from `dependency:tree` that exist in the local repo; reactor modules are skipped.

### `find_duplicates`
- Classes present in more than one classpath JAR, grouped by the JAR set that shares them, with coordinates parsed from the `~/.m2` layout. `kind` is `same-artifact-multiple-versions` or `different-artifacts` (split package / shaded copy); same-artifact groups sort first.
- Uses the background class index (`getAllEntriesWithDuplicates`) and light-scans JARs not processed yet (fast: 50 JARs / 5 s, balanced: 500 JARs / 25 s). Inner classes are ignored (they follow their outer class).

## Gotchas
- Jest config is `jest.config.js` (ts-jest ESM). Every module has a `*.test.ts` next to it.
- The scanner uses `mvn dependency:build-classpath`, not `dependency:tree` (the tree is only used by `list_dependencies` and multi-module recovery).
- `yauzl` is used for ZIP/JAR reading (streams, lazy entries). Be careful with resource leaks; the code already ignores close errors in catch blocks.
- Inner classes (`$` in filename) are intentionally skipped during index building; `Outer$Inner` lookups resolve the outer class and then read the JAR's light index.
- Gradle is supported for classpath resolution; Maven-only tools (`list_dependencies`, `explain_dependency`, `downloadSources`) return a clear error for Gradle builds.
- Brute-force fallback (`~/.m2/repository` recursive scan) has been **removed**. If Maven fails, the tool returns an error.
- Cross-process locking (`proper-lockfile`) uses `mkdir` strategy which works on all platforms including network filesystems.
- If a process is killed with SIGKILL while holding `scan.lock`, the lock becomes stale after 60s and another process can acquire it.

## Logging

Each project gets per-process append-only log files under the cache directory:
```
~/.cache/java-inspector/<project>_<hash>/server-<pid>.log
```

### Log format
```
[2025-01-15T09:23:45.123Z] [DEBUG] [PID:1234] [SERVER] java-inspector v2.0.6 MCP Server running on stdio (DEBUG MODE)
[2025-01-15T09:23:45.145Z] [INFO]  [PID:1234] [AUTO-SCAN] Maven project detected at /path/to/project
[2025-01-15T09:23:45.200Z] [INFO]  [PID:1234] [MAVEN] Resolving command... mvnd detected in 24ms. Selected: mvnd
[2025-01-15T09:23:45.211Z] [INFO]  [PID:1234] [MAVEN] Running: mvnd dependency:build-classpath...
[2025-01-15T09:24:09.405Z] [INFO]  [PID:1234] [MAVEN] Classpath resolved in 24.2s.
[2025-01-15T09:24:09.410Z] [INFO]  [PID:1234] [SCAN] Background scan started. Total JARs: 847
[2025-01-15T09:24:09.420Z] [DEBUG] [PID:1234] [SCAN] Processing batch 1/43 (20 JARs)...
...
[2025-01-15T09:25:10.234Z] [INFO]  [PID:1234] [TOOL:analyze_class] Request: className=io.micrometer.observation.ObservationRegistry, filter=all
[2025-01-15T09:25:10.235Z] [INFO]  [PID:1234] [TOOL:analyze_class] Complete in 0.8s. Fields: 12, Methods: 45
```

### Context tags
| Tag | Description |
|-----|-------------|
| `[SERVER]` | Server startup/shutdown |
| `[AUTO-SCAN]` | Automatic scan on startup |
| `[MAVEN]` | Maven command resolution & classpath building |
| `[GRADLE]` | Gradle classpath resolution |
| `[SCAN]` | Background JAR scanning |
| `[JAVAP]` | `javap` class analysis |
| `[DECOMPILE]` | Vineflower decompilation |
| `[TOOL:<name>]` | Tool call entry/exit with duration |
| `[CACHE]` | Cache invalidation & state |
| `[LOCK]` | Cross-process lock acquire/release/compromise |

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
