import fs from "fs";
import path from "path";

// ---- Paths ----

const OPENCODE_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "~", ".config"),
  "opencode"
);
const OPENCODE_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, "opencode.json");
const OPENCODE_AGENTS_MD_PATH = path.join(OPENCODE_CONFIG_DIR, "AGENTS.md");
const OPENCODE_TOOL_DIR = path.join(OPENCODE_CONFIG_DIR, "tool");
const OPENCODE_COMMANDS_DIR = path.join(OPENCODE_CONFIG_DIR, "commands");

// ---- AGENTS.md snippet ----

const AGENTS_MD_MARKER = "## Project Knowledge Graph";

const AGENTS_MD_SNIPPET = `
## Project Knowledge Graph

You have access to a project knowledge graph via the \`megamemory\` MCP server and skill tool. This is your persistent memory of the codebase — concepts, architecture, decisions, and how things connect. You write it. You read it. The graph is your memory across sessions.

**Workflow: understand → work → update**

1. **Session start:** Call \`megamemory\` tool with action \`overview\` (or \`megamemory:list_roots\` directly) to orient yourself.
2. **Before each task:** Call \`megamemory\` tool with action \`query\` (or \`megamemory:understand\` directly) to load relevant context.
3. **After each task:** Call \`megamemory\` tool with action \`record\` to create/update/link concepts for what you built.

Be specific in summaries: include parameter names, defaults, file locations, and rationale. Keep concepts max 3 levels deep.
`;

// ---- Helpers ----

function log(msg: string): void {
  console.log(`  ${msg}`);
}

/**
 * Resolve absolute path to the MCP server entry point (dist/index.js).
 */
function resolveServerEntryPoint(): string {
  const thisDir = path.dirname(new URL(import.meta.url).pathname);

  // Running from dist/ → sibling index.js
  const fromDist = path.resolve(thisDir, "index.js");
  if (fs.existsSync(fromDist)) return fromDist;

  // Running from src/ via tsx → look in ../dist/
  const fromSrc = path.resolve(thisDir, "..", "dist", "index.js");
  if (fs.existsSync(fromSrc)) return fromSrc;

  // Fallback: assume dist/ relative to package root
  const fromRoot = path.resolve(thisDir, "..", "dist", "index.js");
  return fromRoot;
}

/**
 * Resolve absolute path to the plugin/megamemory.ts skill file.
 */
function resolvePluginSource(): string {
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(thisDir, "..", "plugin", "megamemory.ts");
}

/**
 * Resolve absolute path to the commands/bootstrap-memory.md file.
 */
function resolveCommandSource(): string {
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(thisDir, "..", "commands", "bootstrap-memory.md");
}

// ---- Setup steps ----

async function setupMcpConfig(): Promise<void> {
  if (!fs.existsSync(OPENCODE_CONFIG_DIR)) {
    fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  }

  // Read existing config or start fresh
  let config: Record<string, unknown> = {};
  if (fs.existsSync(OPENCODE_CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(OPENCODE_CONFIG_PATH, "utf-8"));
    } catch {
      const backup = `${OPENCODE_CONFIG_PATH}.bak`;
      fs.copyFileSync(OPENCODE_CONFIG_PATH, backup);
      log(`Backed up malformed config to ${backup}`);
      config = {};
    }
  }

  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }

  // Detect if `megamemory` is globally available (npm link / npm install -g)
  // If so, use the short command. Otherwise fall back to absolute path.
  const { execSync } = await import("child_process");
  let isGlobal = false;
  try {
    execSync("which megamemory", { stdio: "ignore" });
    isGlobal = true;
  } catch {
    isGlobal = false;
  }

  const command: string[] = isGlobal
    ? ["megamemory"]
    : ["node", resolveServerEntryPoint()];

  // Merge megamemory into mcp key — preserve everything else
  const mcp = (config["mcp"] as Record<string, unknown>) ?? {};
  const existed = "megamemory" in mcp;

  mcp["megamemory"] = {
    type: "local",
    command,
    enabled: true,
  };
  config["mcp"] = mcp;

  fs.writeFileSync(
    OPENCODE_CONFIG_PATH,
    JSON.stringify(config, null, 2) + "\n"
  );

  log(
    existed
      ? `Updated megamemory MCP in ${OPENCODE_CONFIG_PATH}`
      : `Added megamemory MCP to ${OPENCODE_CONFIG_PATH}`
  );
  log(`  Command: ${JSON.stringify(command)}`);
}

function setupAgentsMd(): void {
  // Check if snippet already exists
  if (fs.existsSync(OPENCODE_AGENTS_MD_PATH)) {
    const content = fs.readFileSync(OPENCODE_AGENTS_MD_PATH, "utf-8");
    if (content.includes(AGENTS_MD_MARKER)) {
      log(`Already contains knowledge graph instructions — skipped`);
      return;
    }
    // Append to existing
    fs.appendFileSync(OPENCODE_AGENTS_MD_PATH, "\n" + AGENTS_MD_SNIPPET.trimStart());
    log(`Appended knowledge graph instructions to ${OPENCODE_AGENTS_MD_PATH}`);
  } else {
    fs.writeFileSync(OPENCODE_AGENTS_MD_PATH, AGENTS_MD_SNIPPET.trimStart());
    log(`Created ${OPENCODE_AGENTS_MD_PATH}`);
  }
}

function setupToolPlugin(): void {
  const source = resolvePluginSource();
  const dest = path.join(OPENCODE_TOOL_DIR, "megamemory.ts");

  if (!fs.existsSync(source)) {
    log(`Plugin source not found at ${source} — skipped`);
    return;
  }

  if (!fs.existsSync(OPENCODE_TOOL_DIR)) {
    fs.mkdirSync(OPENCODE_TOOL_DIR, { recursive: true });
  }

  const sourceContent = fs.readFileSync(source, "utf-8");

  // Check if already installed and identical
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf-8");
    if (existing === sourceContent) {
      log(`Tool plugin already up to date — skipped`);
      return;
    }
    // Update
    fs.writeFileSync(dest, sourceContent);
    log(`Updated tool plugin at ${dest}`);
  } else {
    fs.writeFileSync(dest, sourceContent);
    log(`Installed tool plugin at ${dest}`);
  }
}

function setupBootstrapCommand(): void {
  const source = resolveCommandSource();
  const dest = path.join(OPENCODE_COMMANDS_DIR, "bootstrap-memory.md");

  if (!fs.existsSync(source)) {
    log(`Command source not found at ${source} — skipped`);
    return;
  }

  if (!fs.existsSync(OPENCODE_COMMANDS_DIR)) {
    fs.mkdirSync(OPENCODE_COMMANDS_DIR, { recursive: true });
  }

  const sourceContent = fs.readFileSync(source, "utf-8");

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf-8");
    if (existing === sourceContent) {
      log(`Bootstrap command already up to date — skipped`);
      return;
    }
    fs.writeFileSync(dest, sourceContent);
    log(`Updated bootstrap command at ${dest}`);
  } else {
    fs.writeFileSync(dest, sourceContent);
    log(`Installed bootstrap command at ${dest}`);
  }
}

// ---- Entry point ----

export async function runInit(): Promise<void> {
  console.log("\nmegamemory init\n");

  console.log("1. MCP server config:");
  await setupMcpConfig();

  console.log("\n2. Global AGENTS.md:");
  setupAgentsMd();

  console.log("\n3. Skill tool plugin:");
  setupToolPlugin();

  console.log("\n4. Bootstrap command:");
  setupBootstrapCommand();

  console.log(
    "\nDone. Restart opencode to pick up changes." +
    "\nRun /user:bootstrap-memory in any project to populate its knowledge graph.\n"
  );
}
