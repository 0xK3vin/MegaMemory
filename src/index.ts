#!/usr/bin/env node

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// ---- CLI routing ----

const VERSION = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version;

const HELP = `
megamemory v${VERSION} — persistent project knowledge graph for coding agents

Commands:
  (no command)    Start the MCP stdio server (invoked by opencode)
  init            Configure opencode integration
  serve           Start the web graph explorer

Options:
  --port PORT     Port for the web explorer (default: 4321)
  --help, -h      Show this help
  --version, -v   Show version

Examples:
  megamemory init                Setup opencode config, plugins, and commands
  megamemory serve               Open graph explorer at http://localhost:4321
  megamemory serve --port 8080   Custom port
`.trim();

function parseFlags(args: string[]): { port?: number } {
  const portIdx = args.indexOf("--port");
  const port =
    portIdx !== -1 && args[portIdx + 1]
      ? parseInt(args[portIdx + 1], 10)
      : undefined;
  return { port };
}

const cmd = process.argv[2];

switch (cmd) {
  case "init": {
    const { runInit } = await import("./init.js");
    await runInit();
    process.exit(0);
    break;
  }

  case "serve": {
    const flags = parseFlags(process.argv.slice(3));
    const { runServe } = await import("./web.js");
    runServe(flags.port ?? 4321);
    break;
  }

  case "--help":
  case "-h":
    console.log(HELP);
    process.exit(0);
    break;

  case "--version":
  case "-v":
    console.log(VERSION);
    process.exit(0);
    break;

  default:
    // No command or unknown → start MCP server
    await startMcpServer();
    break;
}

// ---- MCP Server ----

async function startMcpServer() {
  const { McpServer } = await import(
    "@modelcontextprotocol/sdk/server/mcp.js"
  );
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { z } = await import("zod");
  const path = await import("path");
  const { KnowledgeDB } = await import("./db.js");
  const { understand, createConcept, updateConcept, link, removeConcept, listRoots } =
    await import("./tools.js");

  type NodeKind = import("./types.js").NodeKind;
  type RelationType = import("./types.js").RelationType;

  // ---- Configuration ----
  const DB_PATH =
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db");

  const db = new KnowledgeDB(DB_PATH);

  const server = new McpServer({
    name: "megamemory",
    version: VERSION,
  });

  // ---- Zod schemas ----
  const NodeKindEnum = z.enum([
    "feature", "module", "pattern", "config", "decision", "component",
  ]);
  const RelationEnum = z.enum([
    "connects_to", "depends_on", "implements", "calls", "configured_by",
  ]);

  // ---- Register tools ----

  server.tool(
    "understand",
    "Query the project knowledge graph. Call this before starting any task to load relevant context about concepts, features, and architecture. Returns matched concepts with their children, edges, and parent context.",
    {
      query: z.string().describe("Natural language query describing what you want to understand about the project"),
      top_k: z.number().int().min(1).max(50).optional().describe("Number of top results to return (default: 10)"),
    },
    async (params) => {
      try {
        const result = await understand(db, { query: params.query, top_k: params.top_k });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_concept",
    "Add a new concept to the knowledge graph. Call this after completing a task to record new features, components, patterns, or decisions you built. Include specific details: parameter names, defaults, file locations, and rationale.",
    {
      name: z.string().describe("Human-readable name for the concept"),
      kind: NodeKindEnum.describe("Type of concept: feature, module, pattern, config, decision, component"),
      summary: z.string().describe("What this concept is. Be specific: include parameter names, defaults, file paths, behavior details."),
      why: z.string().optional().describe("Why this exists or was built this way"),
      parent_id: z.string().optional().describe("Parent concept ID for nesting"),
      file_refs: z.array(z.string()).optional().describe("Relevant file paths + optional line ranges"),
      edges: z.array(z.object({
        to: z.string().describe("Target concept ID"),
        relation: RelationEnum.describe("Relationship type"),
        description: z.string().optional().describe("Why this relationship exists"),
      })).optional().describe("Relationships to other existing concepts"),
      created_by_task: z.string().optional().describe("Description of the task that created this concept"),
    },
    async (params) => {
      try {
        const result = await createConcept(db, {
          name: params.name,
          kind: params.kind as NodeKind,
          summary: params.summary,
          why: params.why,
          parent_id: params.parent_id,
          file_refs: params.file_refs,
          edges: params.edges?.map((e) => ({ ...e, relation: e.relation as RelationType })),
          created_by_task: params.created_by_task,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_concept",
    "Update an existing concept in the knowledge graph. Call this after completing a task that changed existing features or components. Only include fields that changed.",
    {
      id: z.string().describe("The concept ID to update"),
      changes: z.object({
        name: z.string().optional().describe("New name"),
        kind: NodeKindEnum.optional().describe("New kind"),
        summary: z.string().optional().describe("Updated summary"),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
      }),
    },
    async (params) => {
      try {
        const result = await updateConcept(db, {
          id: params.id,
          changes: { ...params.changes, kind: params.changes.kind as NodeKind | undefined },
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "link",
    "Create a relationship between two existing concepts.",
    {
      from: z.string().describe("Source concept ID"),
      to: z.string().describe("Target concept ID"),
      relation: RelationEnum.describe("Relationship type"),
      description: z.string().optional().describe("Why this relationship exists"),
    },
    async (params) => {
      try {
        const result = link(db, {
          from: params.from, to: params.to,
          relation: params.relation as RelationType,
          description: params.description,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "remove_concept",
    "Soft-delete a concept from the knowledge graph. The concept and its removal reason are preserved in history.",
    {
      id: z.string().describe("The concept ID to remove"),
      reason: z.string().describe("Why this concept is being removed"),
    },
    async (params) => {
      try {
        const result = removeConcept(db, { id: params.id, reason: params.reason });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_roots",
    "List all top-level concepts in the knowledge graph with their direct children. Call this at the start of a session to get a high-level project overview.",
    {},
    async () => {
      try {
        const result = listRoots(db);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, stats: db.getStats() }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // ---- Start ----
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`megamemory MCP server started (db: ${DB_PATH})`);
}
