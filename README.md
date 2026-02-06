# megamemory

[![npm version](https://img.shields.io/npm/v/megamemory)](https://www.npmjs.com/package/megamemory)
[![license](https://img.shields.io/npm/l/megamemory)](./LICENSE)
[![node](https://img.shields.io/node/v/megamemory)](https://nodejs.org)

Persistent project knowledge graph for coding agents. An MCP server that lets your agent build and query a graph of concepts, architecture, and decisions — so it remembers across sessions.

## How it works

The LLM is the indexer. There's no AST parsing or static analysis. Your agent reads code, writes concepts in its own words, and queries them before future tasks. The graph stores **concepts** (features, modules, patterns, decisions), not code symbols.

**The loop: understand → work → update**

1. **Session start** — agent calls `list_roots` to orient itself
2. **Before a task** — agent calls `understand` with a natural language query to load relevant context
3. **After a task** — agent calls `create_concept` or `update_concept` to record what it built

Everything persists in a per-project SQLite database at `.megamemory/knowledge.db`.

## Install

```bash
npm install -g megamemory
```

Requires Node.js >= 18. The embedding model (~23MB) downloads on first use.

## Setup

### With opencode

```bash
megamemory init
```

This configures everything in one command:
- Adds the MCP server to `~/.config/opencode/opencode.json`
- Appends workflow instructions to `~/.config/opencode/AGENTS.md`
- Installs a skill tool plugin at `~/.config/opencode/tool/megamemory.ts`
- Installs a `/user:bootstrap-memory` command for initial graph population

Restart opencode after running init.

### With other MCP clients

Add megamemory as a stdio MCP server. The command is just `megamemory` (no arguments). It reads/writes `.megamemory/knowledge.db` relative to the working directory, or set `MEGAMEMORY_DB_PATH` to override.

## MCP Tools

| Tool | Description |
|------|-------------|
| `understand` | Semantic search over the knowledge graph. Returns matched concepts with children, edges, and parent context. |
| `create_concept` | Add a new concept (feature, module, pattern, config, decision, component) with optional edges and file references. |
| `update_concept` | Update fields on an existing concept. Automatically regenerates the embedding if name or summary changes. |
| `link` | Create a typed relationship between two concepts (connects_to, depends_on, implements, calls, configured_by). |
| `remove_concept` | Soft-delete a concept with a reason. Preserved in history. |
| `list_roots` | List all top-level concepts with their direct children. Good for session-start orientation. |

## Web Explorer

Visualize the knowledge graph in a browser:

```bash
cd your-project/
megamemory serve
```

Opens a Cytoscape.js graph at `http://localhost:4321` with:
- Nodes colored by kind (feature, module, pattern, config, decision, component)
- Dashed edges for parent-child, solid edges for relationships
- Click-to-inspect detail panel with summary, files, edges, and children
- Search bar with highlight/dim filtering

Use `--port` to change the port:

```bash
megamemory serve --port 8080
```

## Commands

| Command | Description |
|---------|-------------|
| `megamemory` | Start the MCP stdio server (invoked by your agent framework) |
| `megamemory init` | Configure opencode integration |
| `megamemory serve` | Start the web graph explorer |
| `megamemory --help` | Show help |
| `megamemory --version` | Show version |

## Architecture

```
src/
  index.ts       CLI entry point + MCP server registration
  tools.ts       Tool handlers (understand, createConcept, etc.)
  db.ts          SQLite via better-sqlite3 (nodes + edges tables)
  embeddings.ts  In-process embeddings (all-MiniLM-L6-v2, 384 dims)
  types.ts       TypeScript types
  init.ts        `megamemory init` command
  web.ts         HTTP server for the graph explorer
plugin/
  megamemory.ts  Opencode skill tool plugin
commands/
  bootstrap-memory.md  Opencode /user command for initial population
web/
  index.html     Single-file graph visualization (Cytoscape.js)
```

## License

MIT
