import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn((command: string) => {
    if (
      command === "which megamemory" ||
      command === "where megamemory" ||
      command === "which codex" ||
      command === "where codex"
    ) {
      throw new Error("not found");
    }

    return Buffer.from("");
  }),
}));

vi.mock("child_process", () => ({
  execSync: execSyncMock,
}));

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_SOURCE_PATH = path.join(PROJECT_ROOT, "plugin", "megamemory.ts");
const BOOTSTRAP_SOURCE_PATH = path.join(PROJECT_ROOT, "commands", "bootstrap-memory.md");
const SAVE_SOURCE_PATH = path.join(PROJECT_ROOT, "commands", "save-memory.md");
const EXPECTED_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

interface Sandbox {
  root: string;
  homeDir: string;
  workspaceDir: string;
  opencodeDir: string;
}

const originalEnv = {
  HOME: process.env.HOME,
  OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
};
const originalCwd = process.cwd();

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-install-test-"));
  const homeDir = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  const opencodeDir = path.join(root, "opencode-config");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(opencodeDir, { recursive: true });

  return { root, homeDir, workspaceDir, opencodeDir };
}

async function loadInstallModule(sandbox: Sandbox) {
  process.env.HOME = sandbox.homeDir;
  process.env.OPENCODE_CONFIG_DIR = sandbox.opencodeDir;
  process.chdir(sandbox.workspaceDir);
  vi.resetModules();
  return import("../install.js");
}

beforeEach(() => {
  execSyncMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);

  if (originalEnv.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalEnv.HOME;
  }

  if (originalEnv.OPENCODE_CONFIG_DIR === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = originalEnv.OPENCODE_CONFIG_DIR;
  }
});

describe("runInstall", () => {
  it("merges a valid opencode config without removing unrelated keys", async () => {
    const sandbox = makeSandbox();
    const opencodeConfigPath = path.join(sandbox.opencodeDir, "opencode.json");

    fs.writeFileSync(
      opencodeConfigPath,
      `${JSON.stringify(
        {
          theme: "dark",
          mcp: {
            existing: { type: "remote", url: "https://example.test" },
          },
        },
        null,
        2
      )}\n`
    );

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    const updated = JSON.parse(fs.readFileSync(opencodeConfigPath, "utf-8"));

    expect(updated.theme).toBe("dark");
    expect(updated.$schema).toBe("https://opencode.ai/config.json");
    expect(updated.mcp.existing).toEqual({ type: "remote", url: "https://example.test" });
    expect(updated.mcp.megamemory).toEqual({
      type: "local",
      command: ["node", EXPECTED_ENTRY],
      enabled: true,
    });
  });

  it("leaves malformed antigravity config untouched", async () => {
    const sandbox = makeSandbox();
    const antigravityConfigPath = path.join(sandbox.workspaceDir, "mcp_config.json");
    const malformed = '{"mcpServers": '; 

    fs.writeFileSync(antigravityConfigPath, malformed);

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "antigravity"]);

    expect(fs.readFileSync(antigravityConfigPath, "utf-8")).toBe(malformed);
    expect(fs.existsSync(`${antigravityConfigPath}.bak`)).toBe(false);
  });

  it("leaves claude config untouched when mcpServers has an unsupported shape", async () => {
    const sandbox = makeSandbox();
    const claudeConfigPath = path.join(sandbox.homeDir, ".claude.json");
    const original = `${JSON.stringify({ mcpServers: [] }, null, 2)}\n`;

    fs.writeFileSync(claudeConfigPath, original);

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "claudecode"]);

    expect(fs.readFileSync(claudeConfigPath, "utf-8")).toBe(original);
  });

  it("skips later opencode steps when the MCP config step fails", async () => {
    const sandbox = makeSandbox();
    const opencodeConfigPath = path.join(sandbox.opencodeDir, "opencode.json");

    fs.writeFileSync(opencodeConfigPath, '{"mcp": ');

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    expect(fs.readFileSync(opencodeConfigPath, "utf-8")).toBe('{"mcp": ');
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "tool", "megamemory.ts"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "commands", "save-memory.md"))).toBe(false);
  });

  it("updates managed files and skips conflicting unmarked files", async () => {
    const sandbox = makeSandbox();
    const opencodeConfigPath = path.join(sandbox.opencodeDir, "opencode.json");
    const pluginPath = path.join(sandbox.opencodeDir, "tool", "megamemory.ts");
    const bootstrapPath = path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md");
    const savePath = path.join(sandbox.opencodeDir, "commands", "save-memory.md");

    fs.writeFileSync(opencodeConfigPath, `${JSON.stringify({}, null, 2)}\n`);
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(
      pluginPath,
      "// MegaMemory-managed file. Safe for megamemory install to update.\nexport default 'old';\n"
    );
    fs.writeFileSync(bootstrapPath, "# My custom command\n");

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    expect(fs.readFileSync(pluginPath, "utf-8")).toBe(fs.readFileSync(PLUGIN_SOURCE_PATH, "utf-8"));
    expect(fs.readFileSync(bootstrapPath, "utf-8")).toBe("# My custom command\n");
    expect(fs.readFileSync(savePath, "utf-8")).toBe(fs.readFileSync(SAVE_SOURCE_PATH, "utf-8"));
  });

  it("is idempotent on repeated opencode installs", async () => {
    const sandbox = makeSandbox();
    const { runInstall } = await loadInstallModule(sandbox);

    await runInstall(["--target", "opencode"]);

    const firstConfig = fs.readFileSync(path.join(sandbox.opencodeDir, "opencode.json"), "utf-8");
    const firstAgents = fs.readFileSync(path.join(sandbox.opencodeDir, "AGENTS.md"), "utf-8");
    const firstPlugin = fs.readFileSync(path.join(sandbox.opencodeDir, "tool", "megamemory.ts"), "utf-8");
    const firstBootstrap = fs.readFileSync(
      path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md"),
      "utf-8"
    );
    const firstSave = fs.readFileSync(
      path.join(sandbox.opencodeDir, "commands", "save-memory.md"),
      "utf-8"
    );

    await runInstall(["--target", "opencode"]);

    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "opencode.json"), "utf-8")).toBe(firstConfig);
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "AGENTS.md"), "utf-8")).toBe(firstAgents);
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "tool", "megamemory.ts"), "utf-8")).toBe(firstPlugin);
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md"), "utf-8")).toBe(
      firstBootstrap
    );
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "commands", "save-memory.md"), "utf-8")).toBe(firstSave);
    expect(firstPlugin).toBe(fs.readFileSync(PLUGIN_SOURCE_PATH, "utf-8"));
    expect(firstBootstrap).toBe(fs.readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8"));
    expect(firstSave).toBe(fs.readFileSync(SAVE_SOURCE_PATH, "utf-8"));
  });
});
