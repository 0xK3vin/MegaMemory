import { tool } from "@opencode-ai/plugin";

const SKILL = `
---
name: megamemory
description: Project knowledge graph — persistent memory across sessions. Use at session start, before tasks (to load context), and after tasks (to record what you built). The graph stores concepts, architecture, decisions, and relationships — written by you, for you.
allowed-tools: "megamemory:*"
---

# Megamemory — Project Knowledge Graph

Your persistent memory of the codebase. You write concepts as you work. You query them before starting new tasks. The graph survives across sessions.

## When to Use

- **Session start** → \`list_roots\` to orient yourself
- **Before any task** → \`understand\` to load relevant context
- **After any task** → \`create_concept\` / \`update_concept\` / \`link\` to record what you did
- **Refactoring or removing features** → \`remove_concept\` to mark things as gone (with reason)

## Core Principles

1. **Query before work, update after work.** Always.
2. **Concepts, not code.** Nodes are features, patterns, decisions — not files or symbols.
3. **Be specific.** Include parameter names, defaults, file paths, rationale.
4. **Keep it shallow.** Max 3 levels deep. Useful beats exhaustive.

## Concept Kinds

\`feature\` | \`module\` | \`pattern\` | \`config\` | \`decision\` | \`component\`

## Relationship Types

- \`depends_on\` — A requires B to function
- \`implements\` — A is the concrete implementation of B
- \`calls\` — A invokes B at runtime
- \`connects_to\` — A and B interact or share data
- \`configured_by\` — A's behavior is controlled by B

## MCP Tools Reference

| Tool | When | What it does |
|---|---|---|
| \`megamemory:understand\` | Before tasks | Semantic search — returns matching concepts with children, edges, parent |
| \`megamemory:create_concept\` | After tasks | Add new concept with summary, kind, edges, file refs |
| \`megamemory:update_concept\` | After tasks | Patch existing concept fields |
| \`megamemory:link\` | After tasks | Create relationship between two concepts |
| \`megamemory:remove_concept\` | On refactor/delete | Soft-delete with reason (history preserved) |
| \`megamemory:list_roots\` | Session start | All top-level concepts with children + stats |
| \`megamemory:list_conflicts\` | After merge | Lists unresolved merge conflicts grouped by merge_group |
| \`megamemory:resolve_conflict\` | During /merge | Resolve a conflict by providing verified, correct content |
`;

export default tool({
  description: SKILL,
  args: {
    action: tool.schema
      .enum(["query", "record", "overview", "merge"])
      .describe(
        "Workflow action: query (before task — understand context), record (after task — create/update/link), overview (session start — list roots), merge (resolve merge conflicts)",
      ),
    query: tool.schema
      .string()
      .optional()
      .describe("Natural language query for the 'query' action"),
    concepts: tool.schema
      .string()
      .optional()
      .describe(
        "For 'record' action: brief description of what concepts to create/update/link",
      ),
  },
  async execute({ action, query, concepts }) {
    switch (action) {
      case "overview":
        return `To get a project overview, call:

1. megamemory:list_roots — Returns all top-level concepts with their children and graph stats.

Use this at the start of every session to orient yourself. If the graph is empty, proceed normally and create concepts as you work.`;

      case "query":
        if (!query) {
          return "Error: query is required for the query action. Describe what you need to understand about the project.";
        }
        return `To load context for "${query}", call:

1. megamemory:understand — query="${query}"
   Returns: matched concepts ranked by relevance, each with:
   - summary, why, file_refs
   - children (1 level)
   - outgoing and incoming edges
   - parent context

Use the returned context instead of re-reading source files when possible. If no relevant results come back, proceed normally — the graph may not cover this area yet.`;

      case "record":
        return `After completing your task, update the knowledge graph:

1. **New concepts** → megamemory:create_concept
   - name: human-readable name
   - kind: feature | module | pattern | config | decision | component
   - summary: specific — include param names, defaults, file paths, behavior
   - why: rationale for this design
   - parent_id: parent concept slug (for nesting)
   - file_refs: relevant file paths + line ranges
   - edges: [{to: "concept-id", relation: "depends_on|implements|calls|connects_to|configured_by", description: "why"}]
   - created_by_task: what task/prompt created this

2. **Changed concepts** → megamemory:update_concept
   - id: the concept slug
   - changes: {summary?, why?, file_refs?, name?, kind?}

3. **New relationships** → megamemory:link
   - from, to: concept IDs
   - relation: depends_on | implements | calls | connects_to | configured_by
   - description: why this relationship exists

4. **Removed features** → megamemory:remove_concept
   - id: concept to remove
   - reason: why it was removed${concepts ? `\n\nContext about what to record: "${concepts}"` : ""}`;

      case "merge":
        return `To resolve merge conflicts in the knowledge graph:

1. **List conflicts** → megamemory:list_conflicts
   - Returns all unresolved conflicts grouped by merge_group
   - Each group has competing versions with summaries, file_refs, edges

2. **For each conflict:**
   a. Read both versions' summaries, file_refs, and edges
   b. Read the actual source files referenced in file_refs to determine what the code ACTUALLY does now
   c. Write the correct resolved content based on the current codebase — do NOT just pick a side

3. **Resolve** → megamemory:resolve_conflict
   - merge_group: the UUID of the conflict
   - resolved: {summary, why?, file_refs?} — the verified, correct content
   - reason: what you verified and why this resolution is correct

The goal is accuracy: the resolved concept should describe the code as it actually exists. If referenced files no longer exist, the concept may be outdated — update or remove accordingly.`;

      default:
        return `Unknown action: ${action}. Use: overview (session start), query (before task), record (after task), merge (resolve conflicts).`;
    }
  },
});
