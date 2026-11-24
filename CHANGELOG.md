# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Gradle support: Gradle builds are discovered and their classpath (compile, runtime, test, every project) is resolved with an init script; the Gradle cache layout is understood for coordinates and `-sources.jar` lookup. `list_dependencies`, `explain_dependency` and `downloadSources` stay Maven-only.
- `compare_versions` tool: binary API diff between two versions of an artifact (fromVersion defaults to the classpath version; `download` fetches a missing one) or two JARs, with breaking changes flagged.
- `list_dependencies` tool: resolved GAV, scope, direct/transitive with the pulling path, per Maven module; cached until `pom.xml` changes.
- `inspect_class` `view: "outline"` (members with line ranges), `line` (method at a stack-trace line, also for decompiled code), inherited `methodName` lookup through superclasses and interfaces, `methodName`/`line` for `view: "bytecode"`, and `downloadSources` (opt-in `mvn dependency:get` of the `-sources.jar`).
- `find_duplicates` tool: classes that exist in more than one classpath JAR, grouped by JAR set with Maven coordinates, flagged as `same-artifact-multiple-versions` or `different-artifacts` (split packages, shaded copies). Helps with NoSuchMethodError / ClassCastException investigations.
- `inspect_class` and `search_class` accept nested classes (`com.acme.Outer$Inner`, or source-style `com.acme.Outer.Inner`). `view: "source"` returns just the nested declaration from the outer class source; api/bytecode/hierarchy use the nested class file.
- `search_code` and `find_implementations` open already deep-indexed JARs first and then JARs whose Maven path matches the target package, so large projects need fewer calls.

### Changed

- Responses are sized for agent contexts: large sources return 120 lines plus an outline, large bytecode returns member signatures, `view: "all"` and every other response are capped at 40,000 characters. Measured on `StringUtils`: default source 26K -> 7.5K tokens, bytecode 107K -> 5.8K, `view: "all"` 139K -> 11K.
- Search results (`search_class`, `search_code`, `find_implementations`) are grouped by JAR in text output; `view: "api"` JSON no longer repeats the members as separate arrays.
- Methods Vineflower cannot decompile keep its bytecode listing but not the decompiler's stack trace; the response names them.
- Shorter shared parameter descriptions in `tools/list`.

- Bundled Vineflower updated from 1.11.2 to 1.12.0 (`lib/vineflower-1.12.0.jar`, requires Java 17+ like before). The decompile cache key now includes the decompiler version and extraction scheme, so cached output from older runs is not reused.
- Migrated to `@modelcontextprotocol/sdk` 1.32 (`McpServer.registerTool`, protocol 2025-11-25). Tool input schemas are now zod-validated and every parameter has a description.
- The server now sends `instructions` in the initialize response and every tool has `title` and read-only `annotations`. Tool descriptions say explicitly which shell commands they replace (`javap`, `unzip -l`, `jar tf`, `find ~/.m2`, `mvn dependency:tree`), so agents pick them without being told to.
- `inspect_class` `view: "api"` now returns compact `javap -p` signatures (all visibilities, generic signatures) instead of a large JSON dump that omitted fields and non-public members.
- `inspect_class` source responses report `Source origin` (sources JAR vs decompiled) and, when paging, `Lines: x-y of N`.
- `engines.node` is now `>=20` (already required in practice by `commander@14`).
- `view: "hierarchy"` lists the interfaces implemented at every level.

### Fixed

- Multi-module Maven checkouts whose modules depend on each other failed classpath resolution until the modules were installed; the classpath is now recovered with `--fail-at-end` plus `dependency:tree`.
- The message for a missing JDK `src.zip` says which package to install.

- On a cold start `inspect_class` answered "Class not found" while Maven was still resolving the classpath, which pushed agents to locate JARs in `~/.m2` and pass `jarPath`. Class lookups now wait (bounded) for the classpath, open the JAR matching the package first, and tool descriptions state that `className` alone is enough for Maven dependencies.

- Tool failures were returned as JSON-RPC protocol errors (`-32603`) because handler promises were returned without `await` inside `try`; they are now `isError` tool results the model can read.
- `inspect_class` silently fell back to a fuzzy match (e.g. a typo resolved to a different class). It now fails with "Class not found" and lists similar classes.
- Decompiled source was missing nested/inner class bodies because only `Outer.class` was given to Vineflower. All `Outer$*.class` entries are now passed, plus the JAR as a library (`-e=`) for better type resolution. Temp directories are unique per call.
- Multi-module Maven projects only indexed the last module's dependencies (every module overwrote the same `-Dmdep.outputFile`). Each module now writes its own file and the results are merged. Maven runs with `-B`.
- javap parsing ignored `abstract`/`final` class declarations and kept generic arguments, which broke JDK hierarchies (e.g. `AbstractList` had no superclass, `List` reported `java.lang.Object`).
- `search_resources` only ever searched the first 20 classpath JARs.
- Workspace POM discovery had no depth limit; started from `/` or `~` it walked the entire disk on every tool call. It is now bounded (depth 4, 5,000 directories) and cached for 30 s.
- User-facing messages referred to the removed `scan_dependencies` tool.
- An `offset` past the end of the source returned an empty body; it is now an explicit error.

## [2.2.1] - 2025-04-25

### Fixed

- **MCP protocol compliance for `json` format** — All tools (`decompile_class`, `search_class`, `analyze_class`, `scan_dependencies`, `get_inheritance_tree`) now return valid MCP `content` array when `format: 'json'` is requested. Previously, the server returned a non-standard `structuredContent` property, which caused clients to receive empty or broken responses for JSON-formatted tool calls.

## [2.2.0] - 2025-04-25

### Added

- `toon` output format support across all tools — compact, LLM-friendly Token-Oriented Object Notation powered by `@toon-format/toon`.
- `json` output format option for structured, machine-readable responses.
- `methodName` parameter on `decompile_class` for extracting single method bodies.
- `offset` / `limit` pagination on `decompile_class`.
- `filter` parameter on `analyze_class` (`all`, `public`, `private`, `protected`, `fields`, `methods`).
- Auto-scan on startup when `pom.xml` is detected in `cwd`.
- `get_inheritance_tree` tool for class hierarchy inspection.

### Changed

- `search_class` now returns scored fuzzy matches with package/JAR metadata.
- Background JAR scanning processes 20 JARs per batch with incremental JSONL persistence.
- Maven command resolution now prefers `mvnd` (Maven Daemon) when available.
- Cache lives under `~/.cache/java-inspector/<project>_<hash>/` with append-only `class-index.jsonl`.

## [2.1.1] - 2025-04-25

### Fixed

- CLI `cli.ts` shebang line added for Windows `npx` compatibility.

## [2.1.0] - 2025-04-25

### Added

- Initial public release with 5 MCP tools: `scan_dependencies`, `decompile_class`, `analyze_class`, `search_class`, `get_inheritance_tree`.
- Vineflower decompiler integration with bundled `lib/vineflower-1.11.2.jar`.
- Background dependency scanning with lazy on-demand class resolution.
- File-level cache locking and pom/classpath hash validation.
- Per-project append-only logging to `~/.cache/java-inspector/<project>_<hash>/server.log`.

[Unreleased]: https://github.com/mustafagoksever/java-inspector/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/mustafagoksever/java-inspector/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/mustafagoksever/java-inspector/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/mustafagoksever/java-inspector/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/mustafagoksever/java-inspector/releases/tag/v2.1.0
