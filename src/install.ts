import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { success, skip, error, info, heading, warn, multiSelect } from "./cli-utils.js";

export type InstallTarget = "opencode" | "claudecode" | "antigravity";

interface TargetConfig {
  label: string;
  description: string;
  steps: Array<{ name: string; run: () => Promise<void> | void }>;
}

interface StepResult {
  target: InstallTarget;
  targetLabel: string;
  name: string;
  ok: boolean;
  error?: string;
}

interface CommandRuntime {
  opencodeCommand: string[];
  stdioCommand: string;
  stdioArgs: string[];
}

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

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CLAUDE_MD_PATH = path.join(CLAUDE_DIR, "CLAUDE.md");
const CLAUDE_COMMANDS_DIR = path.join(CLAUDE_DIR, "commands");

const ANTIGRAVITY_CONFIG_PATH = path.join(process.cwd(), "mcp_config.json");

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveServerEntryPoint(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  const fromDist = path.resolve(thisDir, "index.js");
  if (fs.existsSync(fromDist)) return fromDist;

  const fromSrc = path.resolve(thisDir, "..", "dist", "index.js");
  if (fs.existsSync(fromSrc)) return fromSrc;

  const fromRoot = path.resolve(thisDir, "..", "dist", "index.js");
  return fromRoot;
}

function resolvePluginSource(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "plugin", "megamemory.ts");
}

function resolveCommandFile(filename: string): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "commands", filename);
}

async function detectGlobalCommand(): Promise<CommandRuntime> {
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

  if (isGlobal) {
    return {
      opencodeCommand: ["megamemory"],
      stdioCommand: "megamemory",
      stdioArgs: [],
    };
  }

  const entry = resolveServerEntryPoint();
  return {
    opencodeCommand: ["node", entry],
    stdioCommand: "node",
    stdioArgs: [entry],
  };
}

function setupInstructionFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes(AGENTS_MD_MARKER)) {
      skip(`Already contains knowledge graph instructions`);
      return;
    }
    fs.appendFileSync(filePath, "\n" + AGENTS_MD_SNIPPET.trimStart());
    success(`Appended knowledge graph instructions to ${pc.dim(filePath)}`);
    return;
  }

  fs.writeFileSync(filePath, AGENTS_MD_SNIPPET.trimStart());
  success(`Created ${pc.dim(filePath)}`);
}

function setupToolPlugin(): void {
  const source = resolvePluginSource();
  const dest = path.join(OPENCODE_TOOL_DIR, "megamemory.ts");

  if (!fs.existsSync(source)) {
    skip(`Plugin source not found at ${pc.dim(source)}`);
    return;
  }

  fs.mkdirSync(OPENCODE_TOOL_DIR, { recursive: true });

  const sourceContent = fs.readFileSync(source, "utf-8");

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf-8");
    if (existing === sourceContent) {
      skip(`Tool plugin already up to date`);
      return;
    }
    fs.writeFileSync(dest, sourceContent);
    success(`Updated tool plugin at ${pc.dim(dest)}`);
    return;
  }

  fs.writeFileSync(dest, sourceContent);
  success(`Installed tool plugin at ${pc.dim(dest)}`);
}

function setupCommand(destinationDir: string, filename: string, label: string): void {
  const source = resolveCommandFile(filename);
  const dest = path.join(destinationDir, filename);

  if (!fs.existsSync(source)) {
    skip(`Command source not found at ${pc.dim(source)}`);
    return;
  }

  fs.mkdirSync(destinationDir, { recursive: true });

  const sourceContent = fs.readFileSync(source, "utf-8");

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf-8");
    if (existing === sourceContent) {
      skip(`${label} already up to date`);
      return;
    }
    fs.writeFileSync(dest, sourceContent);
    success(`Updated ${label} at ${pc.dim(dest)}`);
    return;
  }

  fs.writeFileSync(dest, sourceContent);
  success(`Installed ${label} at ${pc.dim(dest)}`);
}

async function setupOpencodeMcpConfig(runtime: CommandRuntime): Promise<void> {
  fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });

  let config: Record<string, unknown> = {};
  if (fs.existsSync(OPENCODE_CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(OPENCODE_CONFIG_PATH, "utf-8"));
      config = isObject(parsed) ? parsed : {};
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

  const mcp = isObject(config["mcp"]) ? config["mcp"] : {};
  const existed = "megamemory" in mcp;

  mcp["megamemory"] = {
    type: "local",
    command: runtime.opencodeCommand,
    enabled: true,
  };
  config["mcp"] = mcp;

  fs.writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  success(
    existed
      ? `Updated megamemory MCP in ${pc.dim(OPENCODE_CONFIG_PATH)}`
      : `Added megamemory MCP to ${pc.dim(OPENCODE_CONFIG_PATH)}`
  );
  info(`Command: ${pc.cyan(JSON.stringify(runtime.opencodeCommand))}`);
}

async function setupClaudeConfig(runtime: CommandRuntime): Promise<void> {
  let config: Record<string, unknown> = {};

  if (fs.existsSync(CLAUDE_CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8"));
      if (!isObject(parsed)) {
        throw new Error("Top-level JSON value is not an object");
      }
      config = parsed;
    } catch (err) {
      const backup = `${CLAUDE_CONFIG_PATH}.bak`;
      fs.copyFileSync(CLAUDE_CONFIG_PATH, backup);
      warn(`Malformed ${pc.dim(CLAUDE_CONFIG_PATH)} detected; backed it up to ${pc.dim(backup)}`);
      throw new Error(
        err instanceof Error
          ? `Could not parse ${CLAUDE_CONFIG_PATH}: ${err.message}`
          : `Could not parse ${CLAUDE_CONFIG_PATH}`
      );
    }
  }

  const mcpServers = isObject(config["mcpServers"]) ? config["mcpServers"] : {};
  const existed = "megamemory" in mcpServers;

  mcpServers["megamemory"] = {
    type: "stdio",
    command: runtime.stdioCommand,
    args: runtime.stdioArgs,
  };
  config["mcpServers"] = mcpServers;

  fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  success(
    existed
      ? `Updated megamemory MCP in ${pc.dim(CLAUDE_CONFIG_PATH)}`
      : `Added megamemory MCP to ${pc.dim(CLAUDE_CONFIG_PATH)}`
  );
  info(`Command: ${pc.cyan(JSON.stringify([runtime.stdioCommand, ...runtime.stdioArgs]))}`);
}

async function setupAntigravityConfig(runtime: CommandRuntime): Promise<void> {
  let config: Record<string, unknown> = {};

  if (fs.existsSync(ANTIGRAVITY_CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ANTIGRAVITY_CONFIG_PATH, "utf-8"));
      config = isObject(parsed) ? parsed : {};
    } catch {
      const backup = `${ANTIGRAVITY_CONFIG_PATH}.bak`;
      fs.copyFileSync(ANTIGRAVITY_CONFIG_PATH, backup);
      warn(`Malformed ${pc.dim(ANTIGRAVITY_CONFIG_PATH)} detected; backed it up to ${pc.dim(backup)}`);
      config = {};
    }
  }

  const mcpServers = isObject(config["mcpServers"]) ? config["mcpServers"] : {};
  const existed = "megamemory" in mcpServers;

  mcpServers["megamemory"] = {
    command: runtime.stdioCommand,
    args: runtime.stdioArgs,
  };
  config["mcpServers"] = mcpServers;

  fs.writeFileSync(ANTIGRAVITY_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  success(
    existed
      ? `Updated megamemory MCP in ${pc.dim(ANTIGRAVITY_CONFIG_PATH)}`
      : `Added megamemory MCP to ${pc.dim(ANTIGRAVITY_CONFIG_PATH)}`
  );
  info(`Command: ${pc.cyan(JSON.stringify([runtime.stdioCommand, ...runtime.stdioArgs]))}`);
}

function createTargetConfigs(runtime: CommandRuntime): Record<InstallTarget, TargetConfig> {
  return {
    opencode: {
      label: "opencode",
      description: "MCP server, AGENTS.md, skill plugin, commands",
      steps: [
        { name: "MCP server config", run: () => setupOpencodeMcpConfig(runtime) },
        { name: "Global AGENTS.md", run: () => setupInstructionFile(OPENCODE_AGENTS_MD_PATH) },
        { name: "Skill tool plugin", run: () => setupToolPlugin() },
        {
          name: "Bootstrap command",
          run: () => setupCommand(OPENCODE_COMMANDS_DIR, "bootstrap-memory.md", "bootstrap command"),
        },
        {
          name: "Save memory command",
          run: () => setupCommand(OPENCODE_COMMANDS_DIR, "save-memory.md", "save memory command"),
        },
      ],
    },
    claudecode: {
      label: "Claude Code",
      description: "MCP server, CLAUDE.md, commands",
      steps: [
        { name: "MCP server config", run: () => setupClaudeConfig(runtime) },
        { name: "Global CLAUDE.md", run: () => setupInstructionFile(CLAUDE_MD_PATH) },
        {
          name: "Bootstrap command",
          run: () => setupCommand(CLAUDE_COMMANDS_DIR, "bootstrap-memory.md", "bootstrap command"),
        },
        {
          name: "Save memory command",
          run: () => setupCommand(CLAUDE_COMMANDS_DIR, "save-memory.md", "save memory command"),
        },
      ],
    },
    antigravity: {
      label: "Antigravity",
      description: "MCP server config (workspace-level)",
      steps: [
        { name: "MCP server config", run: () => setupAntigravityConfig(runtime) },
      ],
    },
  };
}

const VALID_TARGETS: InstallTarget[] = ["opencode", "claudecode", "antigravity"];

function parseTargets(args: string[]): InstallTarget[] {
  const selected = new Set<InstallTarget>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target") {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`Missing value for --target. Use one of: ${VALID_TARGETS.join(", ")}`);
      }
      i += 1;
      for (const item of value.split(",")) {
        const candidate = item.trim().toLowerCase();
        if (!candidate) continue;
        if (!VALID_TARGETS.includes(candidate as InstallTarget)) {
          throw new Error(`Unknown target '${candidate}'. Use one of: ${VALID_TARGETS.join(", ")}`);
        }
        selected.add(candidate as InstallTarget);
      }
      continue;
    }

    if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      for (const item of value.split(",")) {
        const candidate = item.trim().toLowerCase();
        if (!candidate) continue;
        if (!VALID_TARGETS.includes(candidate as InstallTarget)) {
          throw new Error(`Unknown target '${candidate}'. Use one of: ${VALID_TARGETS.join(", ")}`);
        }
        selected.add(candidate as InstallTarget);
      }
      continue;
    }

    throw new Error(`Unknown install option '${arg}'. Supported: --target <name>`);
  }

  return [...selected];
}

async function chooseTargetsInteractively(): Promise<InstallTarget[]> {
  const selected = await multiSelect("Which editors would you like to configure?", [
    {
      label: "opencode",
      value: "opencode",
      description: "MCP server, AGENTS.md, skill plugin, commands",
    },
    {
      label: "Claude Code",
      value: "claudecode",
      description: "MCP server, CLAUDE.md, commands",
    },
    {
      label: "Antigravity",
      value: "antigravity",
      description: "MCP server config (workspace-level)",
    },
  ]);

  return selected.filter((value): value is InstallTarget =>
    VALID_TARGETS.includes(value as InstallTarget)
  );
}

export async function runInstall(args: string[]): Promise<void> {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("megamemory"))} ${pc.dim("install")}`);
  console.log();

  const runtime = await detectGlobalCommand();
  const targetConfigs = createTargetConfigs(runtime);

  let targets: InstallTarget[];
  try {
    targets = parseTargets(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    console.log(pc.dim(`  Example: ${pc.cyan("megamemory install --target claudecode")}`));
    console.log();
    process.exit(1);
    return;
  }

  if (targets.length === 0) {
    targets = await chooseTargetsInteractively();
  }

  if (targets.length === 0) {
    warn("No targets selected. Nothing to do.");
    console.log();
    return;
  }

  const steps: StepResult[] = [];

  for (const target of targets) {
    const targetConfig = targetConfigs[target];
    heading(`  ${pc.cyan(targetConfig.label)} ${pc.dim(`(${targetConfig.description})`)}`);

    for (let i = 0; i < targetConfig.steps.length; i += 1) {
      const step = targetConfig.steps[i];
      heading(`    ${i + 1}. ${step.name}`);
      try {
        await step.run();
        steps.push({
          target,
          targetLabel: targetConfig.label,
          name: step.name,
          ok: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`${step.name} failed: ${msg}`);
        steps.push({
          target,
          targetLabel: targetConfig.label,
          name: step.name,
          ok: false,
          error: msg,
        });
      }
      console.log();
    }
  }

  const failed = steps.filter((s) => !s.ok);
  if (failed.length === 0) {
    console.log(`  ${pc.green(pc.bold("Done."))}`);
    if (targets.includes("opencode")) {
      console.log(
        pc.dim(`  Restart opencode, then run ${pc.cyan("/user:bootstrap-memory")} in your project.`)
      );
      console.log(
        pc.dim(`  Use ${pc.cyan("/user:save-memory")} after each session to persist learnings.`)
      );
    }
    if (targets.includes("claudecode")) {
      console.log(
        pc.dim(`  Restart Claude Code so it reloads ${pc.cyan("~/.claude.json")} and commands.`)
      );
    }
  } else {
    console.log(
      `  ${pc.yellow(pc.bold("Done with issues."))} ${pc.yellow(`${failed.length} step(s) failed:`)}`
    );
    for (const f of failed) {
      console.log(
        `    ${pc.red("✗")} ${f.targetLabel} — ${f.name}: ${pc.dim(f.error ?? "unknown error")}`
      );
    }
    console.log();
    console.log(pc.dim(`  Steps that succeeded will still work. Fix the issues above and re-run.`));
  }
  console.log();
}
