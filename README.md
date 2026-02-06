<p align="center">
  <h1 align="center">MegaMemory</h1>
</p>
<p align="center">Persistent project knowledge graph for coding agents.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/megamemory"><img alt="npm" src="https://img.shields.io/npm/v/megamemory?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/megamemory?style=flat-square" /></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/node/v/megamemory?style=flat-square" /></a>
</p>

<p align="center">
  <img src="./assets/preview.png" alt="MegaMemory web explorer" width="800" />
</p>

---

An [MCP](https://modelcontextprotocol.io/) server that lets your coding agent build and query a graph of concepts, architecture, and decisions — so it **remembers across sessions**.

The LLM is the indexer. No AST parsing. No static analysis. Your agent reads code, writes concepts in its own words, and queries them before future tasks. The graph stores **concepts** — features, modules, patterns, decisions — not code symbols.

### The Loop

```
understand → work → update
```

1. **Session start** — agent calls `list_roots` to orient itself
2. **Before a task** — agent calls `understand` with a natural language query
3. **After a task** — agent calls `create_concept` or `update_concept` to record what it built

Everything persists in a per-project SQLite database at `.megamemory/knowledge.db`.

---

### Installation

```bash
npm install -g megamemory
```

> [!NOTE]
> Requires Node.js >= 18. The embedding model (~23MB) downloads automatically on first use.

### Quick Start

#### With [opencode](https://github.com/anomalyco/opencode)

```bash
megamemory init
```

One command configures everything:
- MCP server in `~/.config/opencode/opencode.json`
- Workflow instructions in `~/.config/opencode/AGENTS.md`
- Skill tool plugin at `~/.config/opencode/tool/megamemory.ts`
- Bootstrap command `/user:bootstrap-memory` for initial graph population
- Save command `/user:save-memory` to persist session knowledge

Restart opencode after running init.

#### With other MCP clients

Add megamemory as a stdio MCP server. The command is just `megamemory` (no arguments). It reads/writes `.megamemory/knowledge.db` relative to the working directory, or set `MEGAMEMORY_DB_PATH` to override.

```json
{
  "megamemory": {
    "type": "local",
    "command": ["megamemory"],
    "enabled": true
  }
}
```

---

### MCP Tools

| Tool | Description |
|------|-------------|
| `understand` | Semantic search over the knowledge graph. Returns matched concepts with children, edges, and parent context. |
| `create_concept` | Add a new concept with optional edges and file references. |
| `update_concept` | Update fields on an existing concept. Regenerates embeddings automatically. |
| `link` | Create a typed relationship between two concepts. |
| `remove_concept` | Soft-delete a concept with a reason. History preserved. |
| `list_roots` | List all top-level concepts with direct children. |

**Concept kinds:** `feature` · `module` · `pattern` · `config` · `decision` · `component`

**Relationship types:** `connects_to` · `depends_on` · `implements` · `calls` · `configured_by`

---

### Web Explorer

Visualize the knowledge graph in your browser:

```bash
megamemory serve
```

- Nodes colored by kind, sized by edge count
- Dashed edges for parent-child, solid for relationships
- Click-to-inspect detail panel with summary, files, and edges
- Search with highlight/dim filtering
- Interactive port selection if default (`4321`) is taken

```bash
megamemory serve --port 8080   # custom port
```

---

### CLI

| Command | Description |
|---------|-------------|
| `megamemory` | Start the MCP stdio server |
| `megamemory init` | Configure opencode integration |
| `megamemory serve` | Launch the web graph explorer |
| `megamemory --help` | Show help |
| `megamemory --version` | Show version |

---

### How It Works

```
src/
  index.ts       CLI entry + MCP server
  tools.ts       Tool handlers (understand, create, update, link, remove)
  db.ts          SQLite persistence (libsql, WAL mode)
  embeddings.ts  In-process embeddings (all-MiniLM-L6-v2, 384 dims)
  types.ts       TypeScript types
  cli-utils.ts   Colored output + interactive prompts
  init.ts        opencode setup wizard
  web.ts         HTTP server for graph explorer
plugin/
  megamemory.ts  Opencode skill tool plugin
commands/
  bootstrap-memory.md  /user command for initial population
  save-memory.md       /user command to save session knowledge
web/
  index.html     Single-file graph visualization (Cytoscape.js)
```

- **Embeddings** — In-process via [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (ONNX, quantized). No API keys. No network calls after first model download.
- **Storage** — SQLite with WAL mode, soft-delete with history, schema migrations.
- **Search** — Brute-force cosine similarity over all node embeddings. Fast enough for knowledge graphs with <10k nodes.

---

### License

[MIT](./LICENSE)
