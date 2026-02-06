# Changelog

## 1.0.0 — Initial Release

### Features

- **MCP server** with 6 tools: `understand`, `create_concept`, `update_concept`, `link`, `remove_concept`, `list_roots`
- **Semantic search** via in-process embeddings (all-MiniLM-L6-v2, 384 dimensions) — no external API calls
- **SQLite persistence** with soft-delete, schema migrations, and WAL mode
- **Web explorer** — browser-based graph visualization with Cytoscape.js at `megamemory serve`
- **CLI** with colored output, graceful error handling, and interactive port conflict resolution
- **`megamemory init`** — one-command setup for opencode (MCP config, AGENTS.md, skill plugin, bootstrap command)
- **Concept kinds**: feature, module, pattern, config, decision, component
- **Relationship types**: connects_to, depends_on, implements, calls, configured_by
- **Knowledge graph** designed for LLM agents — concepts in natural language, not code symbols
