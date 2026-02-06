# Save Session Knowledge

You are saving what you learned this session into the megamemory knowledge graph.
This is YOUR memory — record anything valuable for future sessions: what you
understood about the project, what you built, decisions that were made, patterns
you noticed, or intent the user shared.

## Step 1: Load existing graph

Call `megamemory:list_roots` to see what's already recorded. Understanding the
current state prevents duplicates and helps you decide what to update vs create.

## Step 2: Reflect on this session

Think about what happened this session. Consider:
- What did you learn about the project's purpose or intent?
- What features, modules, or components did you build or change?
- What design decisions were made and why?
- What patterns or conventions did you discover?
- What architectural understanding do you have now that isn't in the graph?
- Did anything get removed, replaced, or deprecated?

## Step 3: Search for overlap

Before creating anything new, call `megamemory:understand` with queries based on
what you worked on this session. For each area you touched, search to see if
concepts already exist that should be updated rather than duplicated.

For example, if you worked on authentication, call:
  megamemory:understand — query="authentication"

Do this for each distinct area. Existing concepts that are stale or incomplete
should be updated — don't create a new node when an update will do.

## Step 4: Write to the knowledge graph

For each thing worth remembering:

**New understanding** → `megamemory:create_concept`
  - name: human-readable name
  - kind: use `decision` for intent/rationale, `feature` for capabilities,
    `module` for subsystems, `pattern` for conventions, `config` for setup,
    `component` for distinct pieces of a system
  - summary: be specific — include parameter names, defaults, file paths,
    behavior details, and the WHY behind things
  - why: the rationale — this is often the most valuable part
  - file_refs: relevant files if applicable
  - edges: connect to existing concepts where relationships exist
    [{to: "concept-id", relation: "depends_on|implements|calls|connects_to|configured_by", description: "why"}]
  - created_by_task: brief description of what you were doing this session

**Updated understanding** → `megamemory:update_concept`
  - id: the concept slug
  - changes: {summary?, why?, file_refs?, name?, kind?}
  If an existing concept is now stale or incomplete based on what you learned,
  update it. This is often more valuable than creating new nodes.

**New connections** → `megamemory:link`
  - from, to: concept IDs
  - relation: depends_on | implements | calls | connects_to | configured_by
  - description: why this relationship exists
  If you discovered how existing concepts relate to each other.

**Removed/replaced things** → `megamemory:remove_concept`
  - id: concept to remove
  - reason: why it was removed
  If something in the graph is no longer true.

## Step 5: Verify

Call `megamemory:list_roots` again. Confirm the graph reflects your current
understanding. Report what you saved.

## Guidelines

- Record what a future you (with no memory of this session) would need to know.
- Intent and rationale ("why") are more valuable than implementation details.
- Update existing concepts before creating new ones — keep the graph lean.
- Don't record trivial things. If it's obvious from the code, skip it.
- Max 2 levels of nesting. Flat is better than deep.
- Connect concepts — isolated nodes are less useful than a connected graph.
- Be specific. "Handles auth" is useless. "JWT auth with RS256, validated in
  middleware at src/middleware/auth.ts, refresh tokens in Redis with 7d TTL" is useful.
