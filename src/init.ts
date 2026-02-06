import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { success, skip, error, info, heading } from "./cli-utils.js";

// ---- Paths ----

const OPENCODE_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ??
  path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
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

/**
 * Resolve absolute path to the MCP server entry point (dist/index.js).
 */
function resolveServerEntryPoint(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

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
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "plugin", "megamemory.ts");
}

/**
 * Resolve absolute path to a file in the commands/ directory.
 */
function resolveCommandFile(filename: string): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "commands", filename);
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
      info(`Backed up malformed config to ${pc.dim(backup)}`);
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
    execSync(
      process.platform === "win32" ? "where megamemory" : "which megamemory",
      { stdio: "ignore" }
    );
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

  success(
    existed
      ? `Updated megamemory MCP in ${pc.dim(OPENCODE_CONFIG_PATH)}`
      : `Added megamemory MCP to ${pc.dim(OPENCODE_CONFIG_PATH)}`
  );
  info(`Command: ${pc.cyan(JSON.stringify(command))}`);
}

function setupAgentsMd(): void {
  // Check if snippet already exists
  if (fs.existsSync(OPENCODE_AGENTS_MD_PATH)) {
    const content = fs.readFileSync(OPENCODE_AGENTS_MD_PATH, "utf-8");
    if (content.includes(AGENTS_MD_MARKER)) {
      skip(`Already contains knowledge graph instructions`);
      return;
    }
    // Append to existing
    fs.appendFileSync(OPENCODE_AGENTS_MD_PATH, "\n" + AGENTS_MD_SNIPPET.trimStart());
    success(`Appended knowledge graph instructions to ${pc.dim(OPENCODE_AGENTS_MD_PATH)}`);
  } else {
    fs.writeFileSync(OPENCODE_AGENTS_MD_PATH, AGENTS_MD_SNIPPET.trimStart());
    success(`Created ${pc.dim(OPENCODE_AGENTS_MD_PATH)}`);
  }
}

function setupToolPlugin(): void {
  const source = resolvePluginSource();
  const dest = path.join(OPENCODE_TOOL_DIR, "megamemory.ts");

  if (!fs.existsSync(source)) {
    skip(`Plugin source not found at ${pc.dim(source)}`);
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
      skip(`Tool plugin already up to date`);
      return;
    }
    // Update
    fs.writeFileSync(dest, sourceContent);
    success(`Updated tool plugin at ${pc.dim(dest)}`);
  } else {
    fs.writeFileSync(dest, sourceContent);
    success(`Installed tool plugin at ${pc.dim(dest)}`);
  }
}

function setupCommand(filename: string, label: string): void {
  const source = resolveCommandFile(filename);
  const dest = path.join(OPENCODE_COMMANDS_DIR, filename);

  if (!fs.existsSync(source)) {
    skip(`Command source not found at ${pc.dim(source)}`);
    return;
  }

  if (!fs.existsSync(OPENCODE_COMMANDS_DIR)) {
    fs.mkdirSync(OPENCODE_COMMANDS_DIR, { recursive: true });
  }

  const sourceContent = fs.readFileSync(source, "utf-8");

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf-8");
    if (existing === sourceContent) {
      skip(`${label} already up to date`);
      return;
    }
    fs.writeFileSync(dest, sourceContent);
    success(`Updated ${label} at ${pc.dim(dest)}`);
  } else {
    fs.writeFileSync(dest, sourceContent);
    success(`Installed ${label} at ${pc.dim(dest)}`);
  }
}

// ---- Entry point ----

interface StepResult {
  name: string;
  ok: boolean;
  error?: string;
}

export async function runInit(): Promise<void> {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("megamemory"))} ${pc.dim("init")}`);
  console.log();

  const steps: StepResult[] = [];

  // Step 1: MCP server config
  heading(`  1. MCP server config`);
  try {
    await setupMcpConfig();
    steps.push({ name: "MCP server config", ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`MCP config failed: ${msg}`);
    steps.push({ name: "MCP server config", ok: false, error: msg });
  }

  console.log();

  // Step 2: Global AGENTS.md
  heading(`  2. Global AGENTS.md`);
  try {
    setupAgentsMd();
    steps.push({ name: "Global AGENTS.md", ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`AGENTS.md setup failed: ${msg}`);
    steps.push({ name: "Global AGENTS.md", ok: false, error: msg });
  }

  console.log();

  // Step 3: Skill tool plugin
  heading(`  3. Skill tool plugin`);
  try {
    setupToolPlugin();
    steps.push({ name: "Skill tool plugin", ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Plugin setup failed: ${msg}`);
    steps.push({ name: "Skill tool plugin", ok: false, error: msg });
  }

  console.log();

  // Step 4: Bootstrap command
  heading(`  4. Bootstrap command`);
  try {
    setupCommand("bootstrap-memory.md", "bootstrap command");
    steps.push({ name: "Bootstrap command", ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Bootstrap command setup failed: ${msg}`);
    steps.push({ name: "Bootstrap command", ok: false, error: msg });
  }

  console.log();

  // Step 5: Save memory command
  heading(`  5. Save memory command`);
  try {
    setupCommand("save-memory.md", "save memory command");
    steps.push({ name: "Save memory command", ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Save memory command setup failed: ${msg}`);
    steps.push({ name: "Save memory command", ok: false, error: msg });
  }

  console.log();

  // Summary
  const failed = steps.filter((s) => !s.ok);
  if (failed.length === 0) {
    console.log(`  ${pc.green(pc.bold("Done."))} Restart opencode to pick up changes.`);
    console.log(
      pc.dim(`  Run ${pc.cyan("/user:bootstrap-memory")} to populate a project's knowledge graph.`)
    );
    console.log(
      pc.dim(`  Run ${pc.cyan("/user:save-memory")} after a session to save what you learned.`)
    );
  } else {
    console.log(
      `  ${pc.yellow(pc.bold("Done with issues."))} ${pc.yellow(`${failed.length} step(s) failed:`)}`
    );
    for (const f of failed) {
      console.log(`    ${pc.red("✗")} ${f.name}: ${pc.dim(f.error ?? "unknown error")}`);
    }
    console.log();
    console.log(pc.dim(`  Steps that succeeded will still work. Fix the issues above and re-run.`));
  }
  console.log();
}
