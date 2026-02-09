#!/usr/bin/env node

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { errorBold, validatePort } from "./cli-utils.js";

// ---- CLI routing ----

const VERSION = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version;

const HELP = `
${pc.bold(pc.cyan("megamemory"))} ${pc.green(`v${VERSION}`)} ${pc.dim("— persistent project knowledge graph for coding agents")}

${pc.bold("Commands:")}
  ${pc.cyan("(no command)")}    Start the MCP stdio server ${pc.dim("(invoked by your editor)")}
  ${pc.cyan("init")}            Configure opencode integration
  ${pc.cyan("serve")}           Start the web graph explorer
  ${pc.cyan("merge")}           Merge two knowledge.db files
  ${pc.cyan("conflicts")}       List unresolved merge conflicts
  ${pc.cyan("resolve")}         Resolve a merge conflict

${pc.bold("Options:")}
  ${pc.cyan("--port")} ${pc.dim("PORT")}     Port for the web explorer ${pc.dim("(default: 4321)")}
  ${pc.cyan("--into")} ${pc.dim("FILE")}     Output path for merge ${pc.dim("(default: overwrites file1)")}
  ${pc.cyan("--left-label")}    Label for left side in merge ${pc.dim("(default: left)")}
  ${pc.cyan("--right-label")}   Label for right side in merge ${pc.dim("(default: right)")}
  ${pc.cyan("--keep")}          Resolution strategy: left, right, or both
  ${pc.cyan("--json")}          Machine-readable output for conflicts
  ${pc.cyan("--db")} ${pc.dim("PATH")}       Database path for conflicts/resolve
  ${pc.cyan("--help, -h")}      Show this help
  ${pc.cyan("--version, -v")}   Show version

${pc.bold("Examples:")}
  ${pc.dim("$")} megamemory init                                      ${pc.dim("Setup opencode config, plugins, and commands")}
  ${pc.dim("$")} megamemory serve                                     ${pc.dim(`Open graph explorer at ${pc.underline("http://localhost:4321")}`)}
  ${pc.dim("$")} megamemory serve --port 8080                         ${pc.dim("Custom port")}
  ${pc.dim("$")} megamemory merge main.db feature.db --into merged.db ${pc.dim("Merge two knowledge DBs")}
  ${pc.dim("$")} megamemory conflicts                                 ${pc.dim("View unresolved conflicts")}
  ${pc.dim("$")} megamemory resolve <group-id> --keep left            ${pc.dim("Resolve a conflict")}
`.trim();

const KNOWN_COMMANDS = new Set(["init", "serve", "merge", "conflicts", "resolve", "--help", "-h", "--version", "-v"]);

function parseFlags(args: string[]): { port?: number; rawPort?: string } {
  const portIdx = args.indexOf("--port");
  const rawPort = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : undefined;
  const port = rawPort ? parseInt(rawPort, 10) : undefined;
  return { port, rawPort };
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
    const port = flags.port ?? 4321;

    const portError = validatePort(port, flags.rawPort);
    if (portError) {
      errorBold(portError);
      process.exit(1);
    }

    const { runServe } = await import("./web.js");
    await runServe(port);
    break;
  }

  case "merge": {
    const { runMerge } = await import("./merge-cli.js");
    await runMerge(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "conflicts": {
    const { runConflicts } = await import("./merge-cli.js");
    await runConflicts(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "resolve": {
    const { runResolve } = await import("./merge-cli.js");
    await runResolve(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "--help":
  case "-h":
    console.log(HELP);
    process.exit(0);
    break;

  case "--version":
  case "-v":
    console.log(`${pc.bold("megamemory")} ${pc.green(`v${VERSION}`)}`);
    process.exit(0);
    break;

  default:
    if (cmd && !KNOWN_COMMANDS.has(cmd)) {
      // User typed an unknown command — don't silently start MCP
      errorBold(`Unknown command '${cmd}'.`);
      console.log(pc.dim(`  Run ${pc.cyan("megamemory --help")} for usage.\n`));
      process.exit(1);
    }
    // No command → start MCP server (normal invocation by editor)
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
  const { understand, createConcept, updateConcept, link, removeConcept, listRoots, listConflicts, resolveConflict } =
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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_conflicts",
    "List all unresolved merge conflicts in the knowledge graph, grouped by merge_group. Each group contains competing versions with full data. Call this when the user runs /merge to begin AI-assisted conflict resolution.",
    {},
    async () => {
      try {
        const result = listConflicts(db);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
      }
    }
  );

  server.tool(
    "resolve_conflict",
    "Resolve a merge conflict by providing the correct resolved content. Read both conflict versions, verify against the current codebase, then provide the accurate resolved summary. Do NOT just pick a side — write the truth.",
    {
      merge_group: z.string().describe("The merge_group UUID of the conflict to resolve"),
      resolved: z.object({
        summary: z.string().describe("The correct, resolved summary for this concept — verified against the current codebase"),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
      }).describe("The resolved content to write — must reflect current codebase truth"),
      reason: z.string().describe("Explanation of what you verified and why this resolution is correct"),
    },
    async (params) => {
      try {
        const result = await resolveConflict(db, {
          merge_group: params.merge_group,
          resolved: params.resolved,
          reason: params.reason,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }], isError: true };
      }
    }
  );

  // ---- Start ----
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`megamemory MCP server started (db: ${DB_PATH})`);
}
