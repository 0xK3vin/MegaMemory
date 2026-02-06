# Bootstrap Project Knowledge Graph

RUN { git ls-files; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u | xargs wc -l 2>/dev/null | sort -rn | head -150
READ README.md

You are bootstrapping the megamemory knowledge graph for this project.

Your job is to understand the codebase and record its core concepts, architecture,
and patterns as knowledge graph nodes. The file listing above is sorted by line
count — the biggest files are where the core logic lives.

## Step 1: Check existing graph

Call `megamemory:list_roots` to see what's already recorded. If the graph has
good coverage, report what's there and ask if I want to fill in specific areas.

## Step 2: Identify major modules

From the file listing and README, identify the top-level systems in this project.
Think in terms of:
- What does this project DO? (features)
- What are the distinct subsystems? (modules)
- How is it structured? (patterns, decisions)

## Step 3: Read and create root concepts

For each major module, read its key files to understand what it does. Then call
`megamemory:create_concept` with a specific, detailed summary. Include parameter
names, defaults, file paths, and behavior details — not vague descriptions.

## Step 4: Create children for important sub-components

For substantial modules, create child concepts for key pieces. Stay max 2 levels
deep. Focus on things a developer would need to know when working in that area.

## Step 5: Link related concepts

Connect concepts that interact across boundaries using `megamemory:link`.
Focus on meaningful relationships: depends_on, calls, connects_to, implements,
configured_by.

## Guidelines

- Be specific. "Handles auth" is useless. "JWT auth with RS256, tokens from
  /auth/login, validated in middleware, refresh tokens in Redis with 7d TTL" is useful.
- Focus on the top 10-15 most important concepts first. The graph grows over time.
- Don't document trivial things. If it's obvious from the file name, skip it.
