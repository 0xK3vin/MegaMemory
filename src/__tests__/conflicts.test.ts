import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { MergeEngine } from "../merge.js";
import { listConflicts, resolveConflict } from "../tools.js";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;

function createTmpDb(name: string): { db: KnowledgeDB; path: string } {
  const dbPath = path.join(tmpDir, name);
  const db = new KnowledgeDB(dbPath);
  return { db, path: dbPath };
}

function insertTestNode(
  db: KnowledgeDB,
  id: string,
  overrides: Partial<{
    name: string;
    kind: string;
    summary: string;
    why: string | null;
    file_refs: string[] | null;
    parent_id: string | null;
  }> = {}
): void {
  db.insertNode({
    id,
    name: overrides.name ?? id,
    kind: overrides.kind ?? "feature",
    summary: overrides.summary ?? `Summary for ${id}`,
    why: overrides.why ?? null,
    file_refs: overrides.file_refs ?? null,
    parent_id: overrides.parent_id ?? null,
    created_by_task: null,
    embedding: null,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-conflicts-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("listConflicts tool", () => {
  it("returns empty array when no conflicts exist", () => {
    const { db } = createTmpDb("clean.db");
    insertTestNode(db, "normal-node");

    const result = listConflicts(db);
    expect(result.conflicts).toEqual([]);

    db.close();
  });

  it("groups conflicts by merge_group", () => {
    const left = createTmpDb("left.db");
    const right = createTmpDb("right.db");
    const outputPath = path.join(tmpDir, "output.db");

    // Create two separate conflicts
    insertTestNode(left.db, "concept-a", { summary: "Left A" });
    insertTestNode(right.db, "concept-a", { summary: "Right A" });

    insertTestNode(left.db, "concept-b", { summary: "Left B" });
    insertTestNode(right.db, "concept-b", { summary: "Right B" });

    left.db.close();
    right.db.close();

    const engine = new MergeEngine();
    engine.merge(left.path, right.path, outputPath, {
      leftLabel: "main",
      rightLabel: "feature",
    });

    const output = new KnowledgeDB(outputPath);
    const result = listConflicts(output);

    expect(result.conflicts).toHaveLength(2);

    for (const conflict of result.conflicts) {
      expect(conflict.merge_group).toBeDefined();
      expect(conflict.versions).toHaveLength(2);

      const branches = conflict.versions.map(v => v.source_branch).sort();
      expect(branches).toEqual(["feature", "main"]);
    }

    output.close();
  });

  it("includes full version data in conflict groups", () => {
    const left = createTmpDb("left.db");
    const right = createTmpDb("right.db");
    const outputPath = path.join(tmpDir, "output.db");

    insertTestNode(left.db, "my-feature", {
      name: "My Feature",
      summary: "Left implementation",
      why: "Left reason",
      file_refs: ["src/left.ts"],
    });

    insertTestNode(right.db, "my-feature", {
      name: "My Feature",
      summary: "Right implementation",
      why: "Right reason",
      file_refs: ["src/right.ts"],
    });

    left.db.close();
    right.db.close();

    const engine = new MergeEngine();
    engine.merge(left.path, right.path, outputPath);

    const output = new KnowledgeDB(outputPath);
    const result = listConflicts(output);

    expect(result.conflicts).toHaveLength(1);
    const group = result.conflicts[0];

    const leftVersion = group.versions.find(v => v.source_branch === "left")!;
    const rightVersion = group.versions.find(v => v.source_branch === "right")!;

    expect(leftVersion.summary).toBe("Left implementation");
    expect(leftVersion.why).toBe("Left reason");
    expect(leftVersion.file_refs).toEqual(["src/left.ts"]);
    expect(leftVersion.original_id).toBe("my-feature");

    expect(rightVersion.summary).toBe("Right implementation");
    expect(rightVersion.why).toBe("Right reason");
    expect(rightVersion.file_refs).toEqual(["src/right.ts"]);
    expect(rightVersion.original_id).toBe("my-feature");

    output.close();
  });

  it("returns empty after all conflicts are resolved", () => {
    const left = createTmpDb("left.db");
    const right = createTmpDb("right.db");
    const outputPath = path.join(tmpDir, "output.db");

    insertTestNode(left.db, "feature", { summary: "Left" });
    insertTestNode(right.db, "feature", { summary: "Right" });

    left.db.close();
    right.db.close();

    const engine = new MergeEngine();
    const mergeResult = engine.merge(left.path, right.path, outputPath);
    const mergeGroup = mergeResult.mergeGroups[0];

    const output = new KnowledgeDB(outputPath);

    // Verify conflict exists
    expect(listConflicts(output).conflicts).toHaveLength(1);

    // Resolve: keep left
    output.hardDeleteNode("feature::right");
    output.renameNodeId("feature::left", "feature");
    output.clearNodeMergeFlags("feature");
    output.clearEdgeMergeFlagsByGroup(mergeGroup);

    // Verify no more conflicts
    expect(listConflicts(output).conflicts).toHaveLength(0);

    output.close();
  });

  it("resolveConflict prefers active version for removal conflicts", async () => {
    const left = createTmpDb("left.db");
    const right = createTmpDb("right.db");
    const outputPath = path.join(tmpDir, "output.db");

    insertTestNode(left.db, "feature", { summary: "Legacy behavior" });
    left.db.softDeleteNode("feature", "Removed on left");

    insertTestNode(right.db, "feature", { summary: "Current behavior" });

    left.db.close();
    right.db.close();

    const engine = new MergeEngine();
    const mergeResult = engine.merge(left.path, right.path, outputPath);
    const mergeGroup = mergeResult.mergeGroups[0];

    const output = new KnowledgeDB(outputPath);
    expect(listConflicts(output).conflicts).toHaveLength(1);

    await resolveConflict(output, {
      merge_group: mergeGroup,
      resolved: {
        summary: "Resolved behavior from current code",
        file_refs: ["src/feature.ts"],
      },
      reason: "Verified source implementation and kept active version",
    });

    const resolved = output.getNode("feature");
    expect(resolved).toBeDefined();
    expect(resolved!.removed_at).toBeNull();
    expect(resolved!.summary).toBe("Resolved behavior from current code");
    expect(listConflicts(output).conflicts).toHaveLength(0);

    output.close();
  });
});
