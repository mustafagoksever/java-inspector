# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
