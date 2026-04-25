# Java Inspector

> **Decompile Maven dependencies into readable Java source — directly inside your AI agent.**

[![npm](https://img.shields.io/npm/v/@mustafagoksever/java-inspector)](https://www.npmjs.com/package/@mustafagoksever/java-inspector)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

---

## What is this?

AI editors can't read compiled `.class` files. Ask *"How does `JpaRepository` work?"* and the agent hallucinates.

**Java Inspector** is an MCP server that exposes the internals of your project's Maven dependencies (Spring, Hibernate, Jackson, Micrometer, etc.) as decompiled Java source code. Zero configuration — just point your agent at it.

### Supported operations

| Tool | What it does |
|------|--------------|
| `scan_dependencies` | Kicks off a background scan of every JAR on the Maven classpath. Call again to poll progress. |
| `decompile_class` | Returns the **full Java source** (method bodies and all) via CFR 0.152. Optionally extract a single method by `methodName`, or paginate with `offset`/`limit`. |
| `analyze_class` | Returns the **structural signature** — fields, methods, constructors, inheritance — via `javap`. No method bodies. |
| `search_class` | Fuzzy-find classes by partial name (e.g. `"ObservationRegistry"`). |
| `get_inheritance_tree` | Walks the superclass chain up to `java.lang.Object`. |

---

## Architecture

```mermaid
graph LR
    A[AI Agent<br/>Claude / Cursor] -->|MCP| B[java-inspector<br/>TypeScript Server]
    B -->|auto-detect| C{Maven Resolver}
    C -->|priority 1| D[MAVEN_CMD env]
    C -->|priority 2| E[mvnd daemon<br/>~2x faster]
    C -->|priority 3| F[MAVEN_HOME/bin/mvn]
    C -->|priority 4| G[mvn from PATH]
    B -->|dependency:build-classpath| H[~/.m2/repository]
    H -->|JAR streams| I[yauzl extractor]
    I -->|class names| J[JSON Lines Cache]
    B -->|cache hit| J
    B -->|cache miss| I
    B -->|java -jar cfr.jar| K[CFR 0.152<br/>Decompiler]
    K -->|*.java source| A
```

### Why JSON Lines?

Traditional JSON caches rewrite the entire file on every batch — O(n²) overhead for large projects. We use **append-only JSON Lines**:

- **Crash-safe**: each line is independent; a truncated final line is skipped on reload.
- **Fast startup**: the server replays the JSONL into an in-memory `Map<string, ClassIndexEntry>` on launch.
- **Low memory**: ~35 MB RAM for 100,000 classes.

### Cache layout

```
~/.cache/java-inspector/<project>_<hash>/
├── classpath.json      # pomHash + jarPaths[] + classpathHash + timestamp
├── class-index.jsonl   # Append-only ClassIndexEntry batches
├── scan-state.json     # jarCount, processedJars[], isComplete
├── decompile-cache/    # Cached .java sources
└── server.log          # Append-only structured logs
```

---

## Quick Start

Add to your MCP client config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "java-inspector": {
      "command": "npx",
      "args": ["-y", "@mustafagoksever/java-inspector"]
    }
  }
}
```

Restart your editor and ask: *"Show me the source of `ObservationRegistry`"*

That's it. No `JAVA_HOME` tweaks. No manual CFR download. The server ships the 2.2 MB decompiler inside the package.

---

## Workflow

```mermaid
sequenceDiagram
    participant U as User
    participant A as AI Agent
    participant S as java-inspector
    participant M as Maven / mvnd
    participant C as Cache

    U->>A: "Show me JpaRepository source"
    A->>S: decompile_class("org.springframework.data.jpa.repository.JpaRepository")
    alt Index not built yet
        S->>M: dependency:build-classpath
        M-->>S: JAR list
        S->>S: Background scan (20 JARs in parallel)
        S-->>A: Class found via lazy JAR search
    else Cache hit
        S->>C: Map.get(className) — O(1)
        C-->>S: ClassIndexEntry
    end
    S->>S: Extract .class from JAR (yauzl)
    S->>S: java -jar cfr.jar ...
    S-->>A: Decompiled .java source
    A-->>U: Formatted response
```

---

## Performance

Real numbers from a **Spring Boot + Vaadin** project (144 dependencies, 17,405 classes):

| Phase | Cold start | Warm cache |
|-------|-----------|------------|
| Maven classpath resolve | 5–10 s | — |
| Background JAR index | 20–30 s | — |
| Per-class lookup | 2–5 s | **< 1 ms** |
| Fuzzy search | — | **~30 ms** |
| CFR decompile (first) | ~2 s | — |
| CFR decompile (cached) | — | **< 100 ms** |

**First tool call** lands in ~10 seconds (classpath resolve + scan kickoff). **Everything after that** is effectively instant.

---

## Cache invalidation

```mermaid
flowchart TD
    A[scan_dependencies called] --> B{isIndexComplete?}
    B -->|pomHash mismatch| C[Invalidate disk + memory]
    B -->|classpathHash mismatch| C
    B -->|both match| D[Return existing index]
    C --> E[Delete ~/.cache/java-inspector/<hash>/*]
    E --> F[Re-run Maven dependency:build-classpath]
    F --> G[Start background scan]
    D --> H[Return Map of classes]
```

Invalidation triggers:

1. **Module `pom.xml` changes** — `pomHash` mismatch.
2. **Parent POM / dependency-management changes** — `classpathHash` mismatch.
3. **Manual** — call `scan_dependencies` with `forceRefresh: true`.

---

## Platform Support

| OS | Command |
|----|---------|
| Windows | `npx -y @mustafagoksever/java-inspector` |
| Linux | `npx -y @mustafagoksever/java-inspector` |
| macOS | `npx -y @mustafagoksever/java-inspector` |

**Requirements:** Node.js ≥ 16, Java runtime, Maven (or `mvnd` for faster resolves).

---

## Environment variables

| Variable | Effect |
|----------|--------|
| `JAVA_HOME` | Locates `java` and `javap`. |
| `MAVEN_HOME` | Locates `mvn` / `mvn.cmd`. |
| `MAVEN_CMD` | Override executable entirely — e.g. `mvnd`, `mvnw`, or a full path. |
| `MAVEN_REPO` | Overrides `~/.m2/repository`. |
| `CFR_PATH` | Use a custom CFR JAR instead of the bundled one. |
| `NODE_ENV=development` | Enables verbose `server.log` output. |

---

## Installation alternatives

**Zero-setup (recommended)**
```bash
npx @mustafagoksever/java-inspector
```

**Global install**
```bash
npm install -g @mustafagoksever/java-inspector
java-inspector start
```

**Build from source**
```bash
git clone https://github.com/mustafagoksever/java-inspector.git
cd java-inspector
npm install
npm run build
```

---

## Technical stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript 5.7 |
| Runtime | Node.js 16+ |
| Protocol | Model Context Protocol (MCP) |
| Decompiler | CFR 0.152 (bundled) |
| JAR reader | yauzl (streaming, lazy entries) |
| Build tool | tsc |
| Package manager | npm |
| License | Apache-2.0 |

---

## License

Apache-2.0
