# Java Inspector

Java Inspector is an MCP server that gives AI agents fast, read-only access to code and metadata inside Maven and Gradle dependencies, local JARs, executable JARs, WARs, and the JDK.

The server starts accepting MCP calls immediately. Dependency scanning continues in the background, while an interactive query can promote the JAR it needs to a foreground queue and return without waiting for the complete project index.

## Requirements

- Node.js 20 or newer
- Java 17 or newer (`java` and `javap`); required by bundled Vineflower 1.12.0
- Maven for Maven projects; Gradle (or the project's `gradlew`) for Gradle projects

Vineflower 1.12.0 is bundled in `lib/`.

## Install and configure

```bash
npm install -g @mustafagoksever/java-inspector
```

```json
{
  "mcpServers": {
    "java-inspector": {
      "command": "java-inspector",
      "args": ["start"]
    }
  }
}
```

For local development:

```bash
npm ci
npm run build
node dist/cli.js start
```

## Startup discovery

After the MCP transport connects, Java Inspector performs non-blocking discovery:

1. If `cwd` has a `pom.xml` (or a Gradle `settings.gradle[.kts]` / `build.gradle[.kts]`), that build is used. Maven wins when both exist.
2. Otherwise directories are searched breadth-first.
3. Every build root at the first matching depth is selected.
4. Deeper builds are not independently scanned.
5. Classpaths are resolved (`mvn dependency:build-classpath`, or a Gradle init script that prints the compile/runtime/test classpath of every project) and their JARs enter the background light-scan queue.

In a multi-module Maven checkout whose modules depend on each other but were never installed, Maven 3 fails `dependency:build-classpath`. Java Inspector then retries with `--fail-at-end` and adds the external dependencies of `dependency:tree` that are in the local repository.

Directories such as `.git`, `node_modules`, `.gradle`, `target`, `build`, and `out` are excluded from POM discovery.

Local, non-Maven JARs are not scanned at startup. They are found and indexed only when a tool call supplies a path, directory, or filename prefix.

## Tools

| Tool | Purpose |
|---|---|
| `scan_project` | Start, refresh, or poll the non-blocking dependency scan. |
| `find_jar` | Find an artifact by path, filename, prefix, substring, or Maven coordinates without opening it. |
| `inspect_jar` | Inspect manifest, Maven metadata, packages, classes, resources, and nested artifacts. |
| `search_class` | Search the live partial index and foreground-scan relevant JARs on a miss. |
| `search_code` | Search methods, fields, annotations, references, or string constants without mass decompilation. |
| `find_implementations` | Find direct or transitive implementations/subtypes from lazy deep indexes. |
| `find_duplicates` | List classes present in more than one classpath JAR (two versions of one artifact, split packages, shaded copies). |
| `inspect_class` | Return source, outline, API, hierarchy, bytecode, or all views for a class. One method with `methodName`, or the method at a stack-trace `line`. Nested classes: `Outer$Inner`. |
| `explain_dependency` | Run a filtered Maven dependency tree for a selected artifact. |
| `compare_versions` | Public/protected API diff between two versions of an artifact (or two JARs) with breaking changes flagged. |
| `list_dependencies` | Resolved dependencies per Maven module: GAV, scope, direct or transitive (with the path). |
| `search_resources` | Search resource paths or bounded text content. |
| `read_resource` | Read an exact text resource with line pagination. |

Every tool supports `text`, `json`, and `toon` output where applicable.

## Artifact selectors

Class, JAR, and resource tools share the same selection model:

- `jarPath`: exact absolute JAR path; fastest and unambiguous.
- `jarDirectory` + `jarNamePrefix`: useful for Maven-free projects with `lib/` directories.
- `workspacePath` + `jarNamePrefix`: search the Maven classpath and workspace.
- `workspacePath`: use the live partial index and bounded lazy fallback.
- `coordinates`: `groupId:artifactId[:version[:classifier]]`.

When no selector is supplied, tools use the server's current working directory. If Maven classpath resolution is still running, searches return `complete: false` instead of reporting a definitive miss. Per-JAR scan failures are returned in `errors`; an unreadable exact `jarPath` fails the tool call.

If multiple JARs or classes match, the server returns candidates instead of silently choosing one.

### Inspect a class from a local JAR

```json
{
  "className": "com.vendor.Client",
  "jarPath": "C:\\project\\lib\\vendor-client-2.1.jar",
  "view": "source"
}
```

### Find an exception message

```json
{
  "query": "Connection refused",
  "kind": "string",
  "workspacePath": "C:\\project",
  "mode": "balanced"
}
```

### Find implementations

```json
{
  "className": "com.vendor.Transport",
  "workspacePath": "C:\\project",
  "transitive": true
}
```

### Inspect a JDK class

```json
{
  "className": "java.util.ArrayList",
  "view": "all"
}
```

JDK source is read from `src.zip` when available. API and bytecode views use `javap`.

## Foreground and background scheduling

All JAR reads pass through a shared coordinator:

- Up to eight JAR reads run concurrently.
- Background scanning may occupy at most six slots.
- Two slots remain available for interactive foreground work.
- A foreground request promotes a queued background JAR.
- Concurrent requests for the same JAR share one Promise and one cache write.
- Light scans time out after 30 seconds; deep scans time out after 60 seconds.

The background scan builds a light index from ZIP entries. More expensive class-file metadata is generated only when `search_code` or `find_implementations` needs it.

Context-wide deep searches are intentionally bounded. A partial response includes `complete`, `scannedJarCount`, and `remainingJarCount`. Calling the tool again continues using the already cached deep indexes.

## Class inspection

`inspect_class` supports:

- `source`: local `*-sources.jar`, embedded `.java`, or Vineflower decompilation. With `downloadSources: true` (Maven), a missing `-sources.jar` is fetched with `mvn dependency:get` first.
- `outline`: every member with its line range; the cheapest view of a large class.
- `api`: `javap -p` signatures.
- `hierarchy`: resolved superclass chain with interfaces.
- `bytecode`: `javap -c -l -p -s` output; with `methodName` or `line` only that member.
- `all`: all available views.

Source responses support `methodName` (searched in superclasses and interfaces when the class does not declare it), `paramTypes`, `line` (stack-trace line number: returns the containing method, also for decompiled code via the line table), `offset`, and `limit`.

Responses are kept small for agent contexts: sources over 400 lines return the first 120 lines plus an outline, bytecode over 400 lines returns member signatures, and every response is capped at 40,000 characters with a note saying how to narrow the request. Methods that Vineflower cannot decompile keep its bytecode listing without the decompiler's stack trace, and the response names them.

The decompiler executable cannot be overridden by a tool argument. Java Inspector uses the bundled Vineflower JAR or the operator-controlled `DECOMPILER_PATH` environment variable.

## JAR layouts

Light indexing understands:

- Ordinary and shaded JARs
- Multi-release entries under `META-INF/versions/`
- Spring Boot classes under `BOOT-INF/classes`
- WAR classes under `WEB-INF/classes`
- JMOD class paths under `classes/`
- Nested artifact metadata under `BOOT-INF/lib`, `WEB-INF/lib`, and `lib`
- Maven `pom.properties`, manifests, source JARs, and text resources

Nested JAR contents are extracted and scanned only when explicitly needed.

## Cache

Cache data is stored under:

```text
~/.cache/java-inspector/<context>_<hash>/
```

Important entries include:

```text
classpath.json
class-index.jsonl
scan-state.json
jar-indexes-v3/
results-v3/
server-<pid>.log
```

Per-JAR caches use resolved path, size, and modification time as their fingerprint. Nested artifacts additionally use their parent fingerprint and ZIP entry identity. JSONL project indexes remain append-only and crash-safe, with cross-process locks protecting writes.

## Environment variables

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Enables additional development logging. |
| `JAVA_HOME` | Locates `java`, `javap`, and JDK `src.zip`. |
| `MAVEN_HOME` | Locates Maven. |
| `MAVEN_CMD` | Overrides the Maven executable. |
| `MAVEN_REPO` | Overrides the local Maven repository path. |
| `GRADLE_CMD` | Overrides the Gradle executable (default: the project's `gradlew`, then `GRADLE_HOME/bin/gradle`, then `gradle`). |
| `GRADLE_HOME` | Locates Gradle. |
| `JAVA_INSPECTOR_DOWNLOAD_SOURCES` | `true` makes `inspect_class` download missing `-sources.jar` files by default. |
| `DECOMPILER_PATH` | Overrides the bundled Vineflower JAR. |

Maven command resolution order is `MAVEN_CMD`, `mvnd`, `MAVEN_HOME/bin/mvn`, then `mvn` from `PATH`.

## Development

```bash
npm run build
npm test
npm run dev
```

The project is ES modules and emits JavaScript, declarations, and source maps to `dist/`.

## License

Apache-2.0
