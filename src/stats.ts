import fs from "fs";
import path from "path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { errorBold } from "./cli-utils.js";
import { listRoots } from "./tools.js";

const KIND_ORDER = ["feature", "module", "component", "pattern", "config", "decision"];

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function getDefaultDbPath(): string {
  return process.env.MEGAMEMORY_DB_PATH ?? path.join(process.cwd(), ".megamemory", "knowledge.db");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }

  const formatted = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${units[idx]}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function printRow(label: string, value: string, detail?: string): void {
  const prefix = `    ${pc.cyan(`${label}:`.padEnd(16))}${pc.green(value)}`;
  if (detail) {
    console.log(`${prefix} ${pc.dim(detail)}`);
    return;
  }
  console.log(prefix);
}

function sortedKinds(kinds: Record<string, number>): Array<[string, number]> {
  const preferred = KIND_ORDER.filter((kind) => kinds[kind] !== undefined).map((kind) => [kind, kinds[kind]] as [string, number]);
  const extra = Object.entries(kinds)
    .filter(([kind]) => !KIND_ORDER.includes(kind))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...preferred, ...extra];
}

function estimateTokens(jsonText: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(jsonText.length / 4);
}

function getDatabaseFileSize(dbPath: string): number {
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}

export function runStats(args: string[]): void {
  let dbPath = getFlag(args, "--db");
  if (!dbPath) {
    dbPath = getDefaultDbPath();
  }

  if (!fs.existsSync(dbPath)) {
    errorBold(`Database not found at ${pc.dim(dbPath)}`);
    console.log(pc.dim("  Run megamemory in a project that has been used with the MCP server,"));
    console.log(pc.dim("  or use --db to specify the database path."));
    return;
  }

  const db = new KnowledgeDB(dbPath);
  const dbStats = db.getStats();
  const kindStats = db.getKindsBreakdown();
  const fileSize = getDatabaseFileSize(dbPath);

  console.log();
  console.log(`  ${pc.bold(pc.cyan("megamemory"))} ${pc.dim("database stats")}`);
  console.log();

  // Database file
  printRow("File size", formatBytes(fileSize), dbPath);
  printRow("Nodes", formatNumber(dbStats.nodes));
  printRow("Edges", formatNumber(dbStats.edges));
  printRow("Removed", formatNumber(dbStats.removed));
  console.log();

  // Kind breakdown
  if (Object.keys(kindStats).length > 0) {
    console.log(`    ${pc.cyan("Kind breakdown:")}`);
    for (const [kind, count] of sortedKinds(kindStats)) {
      const percentage = ((count / dbStats.nodes) * 100).toFixed(1);
      printRow(`  ${kind}`, formatNumber(count), `${percentage}%`);
    }
    console.log();
  }

  // list_roots token cost analysis
  try {
    const rootsOutput = listRoots(db);
    const rootsJson = JSON.stringify(rootsOutput, null, 2);
    const estimatedTokens = estimateTokens(rootsJson);

    console.log(`    ${pc.cyan("list_roots payload:")}`);
    printRow("JSON size", formatBytes(rootsJson.length));
    printRow("Est. tokens", formatNumber(estimatedTokens));

    // Calculate what the old format would have cost
    const oldFormatSize = rootsOutput.roots.reduce((total, root) => {
      // Estimate: each child as full object vs just name
      const childrenAsObjects = root.children.length * 200; // rough estimate per object
      const childrenAsStrings = root.children.reduce((sum, name) => sum + name.length + 2, 0); // +2 for quotes
      return total + childrenAsObjects - childrenAsStrings;
    }, rootsJson.length);
    
    const oldTokens = estimateTokens(JSON.stringify({ length: oldFormatSize }));
    const savings = Math.round(((oldTokens - estimatedTokens) / oldTokens) * 100);

    if (savings > 0) {
      printRow("Token savings", `~${savings}%`, "vs full children objects");
    }
  } catch (error) {
    console.log(`    ${pc.yellow("Warning:")} Could not analyze list_roots payload`);
    console.log(`    ${pc.dim(`Error: ${error instanceof Error ? error.message : error}`)}`);
  }

  console.log();
  db.close();
}