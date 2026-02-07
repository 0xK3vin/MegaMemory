import fs from "fs";
import path from "path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { MergeEngine, stripMergeSuffix, MERGE_SUFFIX_LEFT, MERGE_SUFFIX_RIGHT } from "./merge.js";
import { errorBold, success, info, error } from "./cli-utils.js";
import type { NodeRow } from "./types.js";

// ---- Flag parsing helpers ----

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// Boolean flags that don't consume a following value
const BOOLEAN_FLAGS = new Set(["--json"]);

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      if (BOOLEAN_FLAGS.has(args[i])) {
        // Boolean flag — skip only the flag itself
        i += 1;
      } else {
        // Value flag — skip the flag and its value
        i += 2;
      }
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return positional;
}

// ---- merge command ----

export async function runMerge(args: string[]): Promise<void> {
  const positional = getPositionalArgs(args);

  if (positional.length < 2) {
    errorBold("Usage: megamemory merge <file1> <file2> [--into <output>] [--left-label <name>] [--right-label <name>]");
    process.exit(1);
  }

  const file1 = path.resolve(positional[0]);
  const file2 = path.resolve(positional[1]);
  const into = getFlag(args, "--into");
  const leftLabel = getFlag(args, "--left-label");
  const rightLabel = getFlag(args, "--right-label");

  // Default output: overwrite file1
  const outputPath = into ? path.resolve(into) : file1;

  if (!fs.existsSync(file1)) {
    errorBold(`File not found: ${file1}`);
    process.exit(1);
  }
  if (!fs.existsSync(file2)) {
    errorBold(`File not found: ${file2}`);
    process.exit(1);
  }

  // If overwriting file1, write to a temp file first then rename
  const isOverwrite = outputPath === file1;
  const actualOutput = isOverwrite
    ? `${outputPath}.merge-tmp-${Date.now()}`
    : outputPath;

  try {
    const engine = new MergeEngine();
    const result = engine.merge(file1, file2, actualOutput, { leftLabel, rightLabel });

    if (isOverwrite) {
      fs.renameSync(actualOutput, outputPath);
    }

    const totalConflicts = result.conceptConflicts + result.edgeConflicts;
    const conflictDetail = totalConflicts > 0
      ? ` (${result.conceptConflicts} concept${result.conceptConflicts !== 1 ? "s" : ""}, ${result.edgeConflicts} edge${result.edgeConflicts !== 1 ? "s" : ""})`
      : "";

    if (totalConflicts === 0) {
      success(
        `Merged: ${result.clean} clean, ${result.removedClean} removed, 0 conflicts`
      );
    } else {
      console.log(
        pc.yellow(`  ⚠ Merged: ${result.clean} clean, ${totalConflicts} conflicts${conflictDetail}`)
      );
      info(`Run ${pc.cyan("megamemory conflicts")} to view, or let your AI agent run ${pc.cyan("/merge")} to resolve.`);
    }
  } catch (err) {
    // Clean up temp file on error
    if (isOverwrite && fs.existsSync(actualOutput)) {
      fs.unlinkSync(actualOutput);
    }
    errorBold(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---- conflicts command ----

export async function runConflicts(args: string[]): Promise<void> {
  const dbPath = getFlag(args, "--db") ?? getDefaultDbPath();
  const json = hasFlag(args, "--json");

  if (!fs.existsSync(dbPath)) {
    errorBold(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new KnowledgeDB(dbPath);
  try {
    const conflictNodes = db.getConflictNodes();

    if (conflictNodes.length === 0) {
      if (json) {
        console.log(JSON.stringify({ conflicts: [] }, null, 2));
      } else {
        success("No unresolved conflicts.");
      }
      return;
    }

    // Group by merge_group
    const groups = new Map<string, NodeRow[]>();
    for (const node of conflictNodes) {
      const mg = node.merge_group!;
      if (!groups.has(mg)) groups.set(mg, []);
      groups.get(mg)!.push(node);
    }

    if (json) {
      const output = {
        conflicts: Array.from(groups.entries()).map(([mergeGroup, nodes]) => ({
          merge_group: mergeGroup,
          merge_timestamp: nodes[0].merge_timestamp,
          versions: nodes.map((n) => ({
            id: n.id,
            original_id: stripMergeSuffix(n.id),
            source_branch: n.source_branch,
            name: n.name,
            kind: n.kind,
            summary: n.summary,
            why: n.why,
            file_refs: n.file_refs ? JSON.parse(n.file_refs) : null,
            removed_at: n.removed_at,
          })),
        })),
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Human-readable output
    console.log(
      pc.bold(`\n  ${groups.size} unresolved conflict${groups.size !== 1 ? "s" : ""}:\n`)
    );

    for (const [mergeGroup, nodes] of groups) {
      const shortGroup = mergeGroup.slice(0, 8);
      const originalId = stripMergeSuffix(nodes[0].id);
      console.log(pc.yellow(`  ── ${pc.bold(originalId)} ${pc.dim(`[${shortGroup}...]`)}`));

      for (const node of nodes) {
        const branch = node.source_branch ?? "unknown";
        const truncSummary = node.summary.length > 80
          ? node.summary.slice(0, 77) + "..."
          : node.summary;
        const isRemoved = node.removed_at !== null;

        console.log(
          `     ${pc.cyan(branch)}${isRemoved ? pc.red(" [removed]") : ""}: ${pc.dim(truncSummary)}`
        );

        if (node.file_refs) {
          const refs = JSON.parse(node.file_refs) as string[];
          if (refs.length > 0) {
            console.log(`     ${pc.dim("files: " + refs.slice(0, 3).join(", ") + (refs.length > 3 ? ` +${refs.length - 3} more` : ""))}`);
          }
        }
      }
      console.log();
    }

    info(`Resolve with: ${pc.cyan("megamemory resolve <merge_group> --keep <left|right|both>")}`);
    console.log();
  } finally {
    db.close();
  }
}

// ---- resolve command ----

export async function runResolve(args: string[]): Promise<void> {
  const positional = getPositionalArgs(args);

  if (positional.length < 1) {
    errorBold("Usage: megamemory resolve <merge_group> --keep <left|right|both>");
    process.exit(1);
  }

  const mergeGroup = positional[0];
  const keep = getFlag(args, "--keep") as "left" | "right" | "both" | undefined;
  const dbPath = getFlag(args, "--db") ?? getDefaultDbPath();

  if (!keep || !["left", "right", "both"].includes(keep)) {
    errorBold("--keep is required and must be one of: left, right, both");
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    errorBold(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new KnowledgeDB(dbPath);
  try {
    const nodes = db.getNodesByMergeGroup(mergeGroup);
    if (nodes.length === 0) {
      errorBold(`No nodes found with merge_group: ${mergeGroup}`);
      process.exit(1);
    }

    const leftNode = nodes.find((n) => n.id.endsWith(MERGE_SUFFIX_LEFT));
    const rightNode = nodes.find((n) => n.id.endsWith(MERGE_SUFFIX_RIGHT));

    if (!leftNode && !rightNode) {
      errorBold("Could not identify left/right versions in this merge group.");
      process.exit(1);
    }

    const originalId = stripMergeSuffix(nodes[0].id);

    if (keep === "both") {
      // Keep both as separate concepts with new unique IDs
      if (leftNode) {
        const newId = `${originalId}-${leftNode.source_branch ?? "left"}`;
        db.renameNodeId(leftNode.id, newId);
        db.clearNodeMergeFlags(newId);
      }
      if (rightNode) {
        const newId = `${originalId}-${rightNode.source_branch ?? "right"}`;
        db.renameNodeId(rightNode.id, newId);
        db.clearNodeMergeFlags(newId);
      }
      db.clearEdgeMergeFlagsByGroup(mergeGroup);
      success(`Kept both versions of "${originalId}" as separate concepts.`);
    } else {
      // keep left or right
      const winner = keep === "left" ? leftNode : rightNode;
      const loser = keep === "left" ? rightNode : leftNode;

      if (!winner) {
        errorBold(`No ${keep} version found in this merge group.`);
        process.exit(1);
      }

      // Remove loser first (before renaming winner to avoid ID collision)
      if (loser) {
        db.hardDeleteNode(loser.id);
      }

      // Rename winner to original ID
      db.renameNodeId(winner.id, originalId);
      db.clearNodeMergeFlags(originalId);
      db.clearEdgeMergeFlagsByGroup(mergeGroup);

      const keptBranch = winner.source_branch ?? keep;
      success(`Resolved "${originalId}" — kept ${pc.cyan(keptBranch)} version.`);

      if (loser) {
        info(`Removed ${pc.dim(loser.source_branch ?? (keep === "left" ? "right" : "left"))} version.`);
      }
    }
  } finally {
    db.close();
  }
}

// ---- helpers ----

function getDefaultDbPath(): string {
  const envPath = process.env.MEGAMEMORY_DB_PATH;
  if (envPath) return envPath;
  return path.join(process.cwd(), ".megamemory", "knowledge.db");
}
