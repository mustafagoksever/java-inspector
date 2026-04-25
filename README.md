# Java Inspector

**Java source code for AI agents. Instantly. Anywhere.**

[![npm](https://img.shields.io/npm/v/@mustafagoksever/java-inspector)](https://www.npmjs.com/package/@mustafagoksever/java-inspector)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   AI Agent      │────▶│  java-inspector  │────▶│      Maven      │
│ (Claude/Cursor) │     │    MCP Server    │     │    + .m2 Repo   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │ CFR 0.152    │
                        │ Decompiler   │
                        └──────────────┘
```

**Problem:** AI editors can't read compiled `.class` files. How does `JpaRepository` work? The agent guesses.

**Solution:** Open your project's dependency source code to your AI with a single command.

---

## Quick Start

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

Restart your AI editor and try: *"Show me the source code of JpaRepository"*

**No setup. No configuration. CFR decompiler included.**

---

## How It Works

> **Important:** java-inspector **only scans classes inside your project's Maven dependencies**. It does **not** work on your own project's source code under `src/main/java`. Its purpose is to expose the internals of external libraries (Spring, Hibernate, Jackson, etc.) to your AI.

| Feature | Description |
|---------|-------------|
| `scan_dependencies` | Starts a background scan of Maven dependencies. Call again to check progress or `forceRefresh` to rebuild. |
| `decompile_class` | Decompiles and returns the **full Java source code** (method bodies included) of a dependency class using CFR |
| `analyze_class` | Returns the **structural signature** (fields, methods, constructors, superclass, interfaces) of a dependency class using `javap` — no method bodies |
| `search_class` | Fuzzy search for classes in dependencies by partial name (e.g. `"JpaRepository"`) |
| `get_inheritance_tree` | Returns the superclass hierarchy of a dependency class |


**Workflow:**
1. Agent calls any tool (e.g. `decompile_class`)
2. Server auto-starts a background dependency scan if needed
3. Class is found via lazy on-demand resolution or from the completed index
4. Decompiled/analyzed and returned to the agent

| Metric | Before | After |
|--------|--------|-------|
| First response | 5–10 minutes | **< 10 seconds** |
| Subsequent lookups | Slow | **< 50 ms** (in-memory) |
| AI response accuracy | ~60% (guessing) | **100%** (real source) |
| Agent timeout risk | High | **None** |

---

## Platform Support

### Windows
```powershell
npx -y @mustafagoksever/java-inspector
```

### Linux
```bash
npx -y @mustafagoksever/java-inspector
```

### macOS
```bash
npx -y @mustafagoksever/java-inspector
```

---

## Cache System

java-inspector uses a high-performance append-only JSON Lines cache with an in-memory `Map` index.

### Cache Directory

```
~/.cache/java-inspector/<project_hash>/
├── classpath.json           # pomHash + JAR list + classpathHash
├── class-index.jsonl        # Append-only ClassIndexEntry batches
├── scan-state.json          # Metadata: jarCount, processedJars, isComplete
└── decompile-cache/         # Cached decompiled .java sources
```

**Why JSON Lines?**
- **Append-only writes**: No O(n²) JSON rewrite overhead
- **Crash-safe**: Each line is independent; corrupted last line is skipped on load
- **Fast recovery**: Server restart replays JSONL into memory Map

**Cache behavior:**
- **First tool call:** ~5-10 seconds (Maven `dependency:build-classpath`)
- **Background scan:** Continues in the background (25 JARs/sec, 20-parallel)
- **Lookup (cached):** **< 1 ms** (in-memory `Map.get()`)
- **Search (cached):** **< 50 ms** (in-memory `Map` iteration)

**Cache invalidation:**
- Module `pom.xml` changes → auto-invalidate
- Parent POM / dependency management changes → auto-invalidate (`classpathHash`)
- Manual: call `scan_dependencies` with `forceRefresh: true`

**Clearing the cache:**
```bash
# Linux / macOS
rm -rf ~/.cache/java-inspector

# Windows PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\java-inspector"
```

---

## Installation Options

### Zero-Setup (Recommended)

```bash
npx @mustafagoksever/java-inspector
```

### Global Installation

```bash
npm install -g @mustafagoksever/java-inspector
java-inspector start
```

### Build from Source

```bash
git clone https://github.com/mustafagoksever/java-inspector.git
cd java-inspector
npm install
npm run build
```

---

## Technical Details

```
java-inspector
├── Language:     TypeScript 5.7
├── Runtime:      Node.js 16+
├── Protocol:     Model Context Protocol (MCP)
├── Decompiler:   CFR 0.152 (bundled, 2.2MB)
├── Build:        tsc
├── Package:      npm (zero-setup via npx)
├── Platforms:    Windows, Linux, macOS
└── License:      Apache-2.0
```

**Key Features:**
- **Non-blocking startup**: MCP server responds immediately; background scan runs asynchronously
- **Lazy class resolution**: On-demand JAR scanning when a class is not yet indexed
- **Parallel batch processing**: 20 JARs processed simultaneously
- **Smart invalidation**: Detects changes in module POM, parent POM, and effective classpath
- **Zero external dependencies** — CFR decompiler bundled
- **Cross-platform** — full support on Windows, Linux, and macOS

---

## Performance

| Operation | First Call | Background Scan | Cached |
|-----------|-----------|-----------------|--------|
| Maven classpath resolve | ~5-10s | — | — |
| Background JAR scan | — | ~20-30s (144 JARs) | — |
| Class lookup (cache miss) | ~2-5s | — | — |
| Class lookup (cache hit) | — | — | **< 1 ms** |
| Fuzzy search | — | — | **< 50 ms** |
| Decompile (first) | ~2s | — | **< 100 ms** |
| Decompile (cached) | — | — | **< 100 ms** |

**Real world:** Spring Boot + Vaadin project with 144 dependencies, 17,405 classes
- First tool call: ~10 seconds (classpath resolve + background scan start)
- Per class (cached): instant
- Search: ~30 ms

---

## Usage Examples

### View source code
```
User: "Show me the source code of JpaRepository"

Agent:
1. Calls decompile_class(className: "org.springframework.data.jpa.repository.JpaRepository")
2. Server resolves class on-demand or from index
3. Returns the real decompiled source code
```

### Search classes (no need for the full name)
```
User: "Find classes related to JPA repository"

Agent:
1. Calls search_class(query: "jpa repository")
2. Results: JpaRepository, SimpleJpaRepository, QuerydslJpaRepository...
3. Shows the list to the user, decompiles the one they pick
```

### Inheritance tree
```
User: "Show me the superclasses of JpaRepository"

Agent:
1. Calls get_inheritance_tree(className: "org.springframework.data.jpa.repository.JpaRepository")
2. Result: JpaRepository → Repository → ...
```

---

## License

Apache-2.0
