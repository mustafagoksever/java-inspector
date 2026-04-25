# Java Inspector — 1-Page Brief

## What it is

An MCP server that lets your AI agent **read compiled Java dependencies as if they were source code**.

No more hallucinations when you ask *"How does `JpaRepository` work?"*. The server decompiles `.class` files from Maven JARs on-demand and feeds clean Java source back to your agent.

---

## Why it exists

| Problem | Before | After |
|---------|--------|-------|
| AI can't read `.class` files | Agent guesses / hallucinates | Agent sees real decompiled source |
| Manual decompilation is slow | Download JAR, run JD-GUI, copy-paste | One tool call, ~2 seconds |
| Dependency internals are invisible | "It probably works like this..." | "Here is the actual `ObservationRegistry` source" |

---

## How it works (3 steps)

1. **Scan** — `scan_dependencies` resolves the Maven classpath and indexes every class in the background.
2. **Find** — `search_class` or direct `decompile_class` / `analyze_class` call locates the class.
3. **Return** — Vineflower decompiles the `.class` file to `.java` source and returns it.

All caching, JAR extraction, and classpath resolution is automatic.

---

## Tools at a glance

| Tool | Returns | Use when you want... |
|------|---------|---------------------|
| `scan_dependencies` | Scan status & progress | To build or refresh the class index |
| `decompile_class` | Full Java source with method bodies | To read actual implementation |
| `analyze_class` | Fields, methods, signatures (no bodies) | A lightweight structural overview |
| `search_class` | Matching class names | To find a class by partial name |
| `get_inheritance_tree` | Superclass hierarchy | To trace inheritance |

---

## Response formats

| Format | Output | Ideal for |
|--------|--------|-----------|
| `text` (default) | Markdown tables, code blocks, tree views | Human/LLM reading |
| `json` | Raw `structuredContent` only | Tool chaining, scripts |
| `toon` | [TOON](https://github.com/toon-format/toon) — compact, schema-aware | Token-constrained LLM contexts |

---

## Performance

- **First call**: ~10s (Maven resolve + background scan kickoff)
- **Subsequent calls**: **< 1 ms** lookup, **< 100 ms** decompile (cached)
- **Memory**: ~35 MB RAM for 100K classes
- **Cache**: Auto-invalidated when `pom.xml` or classpath changes

---

## One-line setup

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

Add to Claude Desktop, Cursor, Codex, Opencode, or any MCP client. Restart. Ask:

> *"Show me how `ObservationRegistry.createNotStarted` is implemented."*

Done.

---

## Stack

TypeScript 5.7 · MCP · Vineflower 1.11.2 · Node.js 16+ · Maven/mvnd

Apache-2.0 · https://github.com/mustafagoksever/java-inspector
