import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import {
  MergeEngine,
  nodesAreIdentical,
  edgeSetsAreIdentical,
  stripMergeSuffix,
  hasMergeSuffix,
  MERGE_SUFFIX_LEFT,
  MERGE_SUFFIX_RIGHT,
} from "../merge.js";
import fs from "fs";
import path from "path";
import os from "os";
import type { NodeRow, EdgeRow } from "../types.js";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-merge-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("merge helpers", () => {
  describe("stripMergeSuffix", () => {
    it("strips ::left suffix", () => {
      expect(stripMergeSuffix("foo::left")).toBe("foo");
    });

    it("strips ::right suffix", () => {
      expect(stripMergeSuffix("foo::right")).toBe("foo");
    });

    it("returns unchanged if no suffix", () => {
      expect(stripMergeSuffix("foo")).toBe("foo");
    });

    it("handles nested IDs with suffix", () => {
      expect(stripMergeSuffix("parent/child::left")).toBe("parent/child");
    });
  });

  describe("hasMergeSuffix", () => {
    it("detects ::left", () => {
      expect(hasMergeSuffix("foo::left")).toBe(true);
    });

    it("detects ::right", () => {
      expect(hasMergeSuffix("foo::right")).toBe(true);
    });

    it("returns false for clean IDs", () => {
      expect(hasMergeSuffix("foo")).toBe(false);
    });
  });

  describe("nodesAreIdentical", () => {
    it("returns true for identical nodes", () => {
      const base: NodeRow = {
        id: "test",
        name: "Test",
        kind: "feature",
        summary: "A test",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
        removed_at: null,
        removed_reason: null,
        embedding: null,
        merge_group: null,
        needs_merge: 0,
        source_branch: null,
        merge_timestamp: null,
      };
      // Different timestamps shouldn't matter
      const other = { ...base, created_at: "2025-01-01", updated_at: "2025-01-01" };
      expect(nodesAreIdentical(base, other)).toBe(true);
    });

    it("returns false for different summaries", () => {
      const base: NodeRow = {
        id: "test", name: "Test", kind: "feature", summary: "A",
        why: null, file_refs: null, parent_id: null, created_by_task: null,
        created_at: "", updated_at: "", removed_at: null, removed_reason: null,
        embedding: null, merge_group: null, needs_merge: 0, source_branch: null, merge_timestamp: null,
      };
      const other = { ...base, summary: "B" };
      expect(nodesAreIdentical(base, other)).toBe(false);
    });

    it("returns false when one is removed and other is not", () => {
      const base: NodeRow = {
        id: "test", name: "Test", kind: "feature", summary: "A",
        why: null, file_refs: null, parent_id: null, created_by_task: null,
        created_at: "", updated_at: "", removed_at: null, removed_reason: null,
        embedding: null, merge_group: null, needs_merge: 0, source_branch: null, merge_timestamp: null,
      };
      const removed = { ...base, removed_at: "2024-01-01", removed_reason: "gone" };
      expect(nodesAreIdentical(base, removed)).toBe(false);
    });

    it("compares file_refs as parsed JSON", () => {
      const a: NodeRow = {
        id: "test", name: "Test", kind: "feature", summary: "A",
        why: null, file_refs: '["a.ts","b.ts"]', parent_id: null, created_by_task: null,
        created_at: "", updated_at: "", removed_at: null, removed_reason: null,
        embedding: null, merge_group: null, needs_merge: 0, source_branch: null, merge_timestamp: null,
      };
      const b = { ...a, file_refs: '["a.ts","b.ts"]' };
      expect(nodesAreIdentical(a, b)).toBe(true);

      const c = { ...a, file_refs: '["a.ts","c.ts"]' };
      expect(nodesAreIdentical(a, c)).toBe(false);
    });
  });

  describe("edgeSetsAreIdentical", () => {
    const makeEdge = (from: string, to: string, rel: string): EdgeRow => ({
      id: 0, from_id: from, to_id: to, relation: rel,
      description: null, created_at: "",
      merge_group: null, needs_merge: 0, source_branch: null, merge_timestamp: null,
    });

    it("returns true for identical sets", () => {
      const a = [makeEdge("x", "y", "calls")];
      const b = [makeEdge("x", "y", "calls")];
      expect(edgeSetsAreIdentical(a, b)).toBe(true);
    });

    it("returns false for different sets", () => {
      const a = [makeEdge("x", "y", "calls")];
      const b = [makeEdge("x", "z", "calls")];
      expect(edgeSetsAreIdentical(a, b)).toBe(false);
    });

    it("returns true for empty sets", () => {
      expect(edgeSetsAreIdentical([], [])).toBe(true);
    });

    it("returns false for different lengths", () => {
      const a = [makeEdge("x", "y", "calls"), makeEdge("x", "z", "depends_on")];
      const b = [makeEdge("x", "y", "calls")];
      expect(edgeSetsAreIdentical(a, b)).toBe(false);
    });
  });
});

describe("MergeEngine", () => {
  let engine: MergeEngine;

  beforeEach(() => {
    engine = new MergeEngine();
  });

  describe("clean merge (no conflicts)", () => {
    it("merges nodes that exist in only one side", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "node-a", { summary: "Node A" });
      insertTestNode(left.db, "node-b", { summary: "Node B" });
      insertTestNode(right.db, "node-c", { summary: "Node C" });
      insertTestNode(right.db, "node-d", { summary: "Node D" });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      expect(result.clean).toBe(4);
      expect(result.conceptConflicts).toBe(0);
      expect(result.edgeConflicts).toBe(0);

      const output = new KnowledgeDB(outputPath);
      expect(output.getNode("node-a")).toBeDefined();
      expect(output.getNode("node-b")).toBeDefined();
      expect(output.getNode("node-c")).toBeDefined();
      expect(output.getNode("node-d")).toBeDefined();
      expect(output.getStats().nodes).toBe(4);
      output.close();
    });

    it("deduplicates identical nodes from both sides", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "shared", { summary: "Same content" });
      insertTestNode(right.db, "shared", { summary: "Same content" });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      expect(result.clean).toBe(1);
      expect(result.conceptConflicts).toBe(0);

      const output = new KnowledgeDB(outputPath);
      expect(output.getStats().nodes).toBe(1);
      expect(output.getNode("shared")!.summary).toBe("Same content");
      output.close();
    });

    it("preserves Buffer embeddings through merge round-trip", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      const leftEmbedding = Buffer.alloc(1536, 0x1a);
      const rightEmbedding = Buffer.alloc(1536, 0x2b);

      left.db.insertNode({
        id: "left-emb",
        name: "Left Embedding",
        kind: "feature",
        summary: "Left with embedding",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: leftEmbedding,
      });
      right.db.insertNode({
        id: "right-emb",
        name: "Right Embedding",
        kind: "feature",
        summary: "Right with embedding",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: rightEmbedding,
      });

      left.db.close();
      right.db.close();

      engine.merge(left.path, right.path, outputPath);

      const output = new KnowledgeDB(outputPath);
      const outNodes = output.getAllActiveNodesWithEmbeddings();
      const leftNode = outNodes.find((node) => node.id === "left-emb");
      const rightNode = outNodes.find((node) => node.id === "right-emb");

      expect(leftNode).toBeDefined();
      const outputEmbedding = leftNode!.embedding;
      expect(Buffer.isBuffer(outputEmbedding)).toBe(true);
      if (!Buffer.isBuffer(outputEmbedding)) {
        throw new Error("Expected Buffer embedding");
      }
      expect(outputEmbedding).toHaveLength(1536);
      expect(outputEmbedding.equals(leftEmbedding)).toBe(true);

      expect(rightNode).toBeDefined();
      const rightOutputEmbedding = rightNode!.embedding;
      expect(Buffer.isBuffer(rightOutputEmbedding)).toBe(true);
      if (!Buffer.isBuffer(rightOutputEmbedding)) {
        throw new Error("Expected Buffer embedding");
      }
      expect(rightOutputEmbedding).toHaveLength(1536);
      expect(rightOutputEmbedding.equals(rightEmbedding)).toBe(true);

      output.close();
    });

    it("merges edges for non-conflicting nodes", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "node-a");
      insertTestNode(left.db, "node-b");
      left.db.insertEdge({ from_id: "node-a", to_id: "node-b", relation: "calls", description: null });

      insertTestNode(right.db, "node-c");

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      const output = new KnowledgeDB(outputPath);
      const edges = output.getAllEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].from_id).toBe("node-a");
      expect(edges[0].to_id).toBe("node-b");
      output.close();
    });
  });

  describe("concept conflicts", () => {
    it("creates conflict entries for different content at same ID", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "feature-x", { summary: "Left version" });
      insertTestNode(right.db, "feature-x", { summary: "Right version" });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      expect(result.conceptConflicts).toBe(1);
      expect(result.mergeGroups).toHaveLength(1);

      const output = new KnowledgeDB(outputPath);
      const leftVersion = output.getNode("feature-x::left");
      const rightVersion = output.getNode("feature-x::right");

      expect(leftVersion).toBeDefined();
      expect(rightVersion).toBeDefined();
      expect(leftVersion!.summary).toBe("Left version");
      expect(rightVersion!.summary).toBe("Right version");
      expect(leftVersion!.needs_merge).toBe(1);
      expect(rightVersion!.needs_merge).toBe(1);
      expect(leftVersion!.merge_group).toBe(rightVersion!.merge_group);
      expect(leftVersion!.source_branch).toBe("left");
      expect(rightVersion!.source_branch).toBe("right");
      output.close();
    });

    it("uses custom labels for source_branch", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "concept", { summary: "Main version" });
      insertTestNode(right.db, "concept", { summary: "Feature version" });

      left.db.close();
      right.db.close();

      engine.merge(left.path, right.path, outputPath, {
        leftLabel: "main",
        rightLabel: "feature-xyz",
      });

      const output = new KnowledgeDB(outputPath);
      expect(output.getNode("concept::left")!.source_branch).toBe("main");
      expect(output.getNode("concept::right")!.source_branch).toBe("feature-xyz");
      output.close();
    });
  });

  describe("removal conflicts", () => {
    it("creates conflict when one side removed and other didn't", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "to-remove", { summary: "Still active" });

      insertTestNode(right.db, "to-remove", { summary: "Still active" });
      right.db.softDeleteNode("to-remove", "No longer needed");

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      // The left has active, right has removed — different removed_at state = conflict
      expect(result.conceptConflicts).toBe(1);

      const output = new KnowledgeDB(outputPath);
      // The left version should be the active one (with suffix)
      const leftNode = output.getAllNodesRaw().find(n => n.id === "to-remove::left");
      const rightNode = output.getAllNodesRaw().find(n => n.id === "to-remove::right");
      expect(leftNode).toBeDefined();
      expect(rightNode).toBeDefined();
      expect(leftNode!.removed_at).toBeNull();
      expect(rightNode!.removed_at).not.toBeNull();
      output.close();
    });

    it("merges cleanly when both sides removed the same node", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "both-removed", { summary: "Gone" });
      left.db.softDeleteNode("both-removed", "Removed on left");

      insertTestNode(right.db, "both-removed", { summary: "Gone" });
      right.db.softDeleteNode("both-removed", "Removed on right");

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      // Both agree on removal, so it should be clean
      expect(result.conceptConflicts).toBe(0);
      expect(result.removedClean).toBe(1);
      output_check: {
        const output = new KnowledgeDB(outputPath);
        const all = output.getAllNodesRaw();
        expect(all).toHaveLength(1);
        expect(all[0].removed_at).not.toBeNull();
        output.close();
      }
    });
  });

  describe("edge conflicts", () => {
    it("marks edge conflicts when same node has different edges", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      // Both have the same node with different content (concept conflict)
      insertTestNode(left.db, "node-a", { summary: "Left" });
      insertTestNode(left.db, "node-b");
      left.db.insertEdge({ from_id: "node-a", to_id: "node-b", relation: "calls", description: null });

      insertTestNode(right.db, "node-a", { summary: "Right" });
      insertTestNode(right.db, "node-b");
      insertTestNode(right.db, "node-c");
      right.db.insertEdge({ from_id: "node-a", to_id: "node-c", relation: "depends_on", description: null });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      expect(result.conceptConflicts).toBe(1); // node-a conflicted
      expect(result.edgeConflicts).toBe(1); // different edge sets for node-a

      const output = new KnowledgeDB(outputPath);
      const edges = output.getAllEdgesRaw();
      const conflictEdges = edges.filter(e => e.needs_merge === 1);
      expect(conflictEdges.length).toBeGreaterThan(0);
      output.close();
    });
  });

  describe("idempotent re-merge", () => {
    it("produces same result when merging the same files twice", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const output1Path = path.join(tmpDir, "output1.db");
      const output2Path = path.join(tmpDir, "output2.db");

      insertTestNode(left.db, "clean-node", { summary: "Clean" });
      insertTestNode(left.db, "conflict-node", { summary: "Left version" });
      insertTestNode(right.db, "conflict-node", { summary: "Right version" });
      insertTestNode(right.db, "other-node", { summary: "Other" });

      left.db.close();
      right.db.close();

      const result1 = engine.merge(left.path, right.path, output1Path);
      const result2 = engine.merge(left.path, right.path, output2Path);

      expect(result1.clean).toBe(result2.clean);
      expect(result1.conceptConflicts).toBe(result2.conceptConflicts);
      expect(result1.edgeConflicts).toBe(result2.edgeConflicts);

      // Verify same node count
      const db1 = new KnowledgeDB(output1Path);
      const db2 = new KnowledgeDB(output2Path);
      expect(db1.getStats().nodes).toBe(db2.getStats().nodes);
      db1.close();
      db2.close();
    });

    it("preserves pre-existing unresolved conflicts", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      left.db.insertNodeRaw({
        id: "concept::left",
        name: "Concept",
        kind: "feature",
        summary: "Left unresolved",
        merge_group: "existing-group",
        needs_merge: 1,
        source_branch: "left",
      });
      left.db.insertNodeRaw({
        id: "concept::right",
        name: "Concept",
        kind: "feature",
        summary: "Right unresolved",
        merge_group: "existing-group",
        needs_merge: 1,
        source_branch: "right",
      });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      expect(result.clean).toBe(0);
      expect(result.conceptConflicts).toBe(0);

      const output = new KnowledgeDB(outputPath);
      const nodes = output.getAllNodesRaw();

      expect(nodes.map((n) => n.id).sort()).toEqual([
        "concept::left",
        "concept::right",
      ]);
      expect(nodes.every((n) => n.needs_merge === 1)).toBe(true);
      output.close();
    });
  });

  describe("resolution", () => {
    it("keeps left version and removes right on resolve --keep left", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "feature", { summary: "Left feature" });
      insertTestNode(right.db, "feature", { summary: "Right feature" });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);
      const mergeGroup = result.mergeGroups[0];

      // Now resolve
      const output = new KnowledgeDB(outputPath);
      const leftNode = output.getNode("feature::left")!;
      const rightNode = output.getNode("feature::right")!;
      expect(leftNode).toBeDefined();
      expect(rightNode).toBeDefined();

      // Simulate --keep left resolution
      output.hardDeleteNode("feature::right");
      output.renameNodeId("feature::left", "feature");
      output.clearNodeMergeFlags("feature");
      output.clearEdgeMergeFlagsByGroup(mergeGroup);

      const resolved = output.getNode("feature");
      expect(resolved).toBeDefined();
      expect(resolved!.summary).toBe("Left feature");
      expect(resolved!.needs_merge).toBe(0);
      expect(resolved!.merge_group).toBeNull();

      // Right should be gone
      expect(output.getNode("feature::right")).toBeUndefined();

      output.close();
    });

    it("keeps right version and removes left on resolve --keep right", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "feature", { summary: "Left feature" });
      insertTestNode(right.db, "feature", { summary: "Right feature" });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);
      const mergeGroup = result.mergeGroups[0];

      const output = new KnowledgeDB(outputPath);

      // Simulate --keep right resolution
      output.hardDeleteNode("feature::left");
      output.renameNodeId("feature::right", "feature");
      output.clearNodeMergeFlags("feature");
      output.clearEdgeMergeFlagsByGroup(mergeGroup);

      const resolved = output.getNode("feature");
      expect(resolved).toBeDefined();
      expect(resolved!.summary).toBe("Right feature");
      expect(resolved!.needs_merge).toBe(0);

      expect(output.getNode("feature::left")).toBeUndefined();

      output.close();
    });

    it("keeps both on resolve --keep both with new IDs", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "feature", { summary: "Left feature" });
      insertTestNode(right.db, "feature", { summary: "Right feature" });

      left.db.close();
      right.db.close();

      engine.merge(left.path, right.path, outputPath);

      const output = new KnowledgeDB(outputPath);

      // Simulate --keep both resolution
      output.renameNodeId("feature::left", "feature-left");
      output.clearNodeMergeFlags("feature-left");
      output.renameNodeId("feature::right", "feature-right");
      output.clearNodeMergeFlags("feature-right");

      expect(output.getNode("feature-left")).toBeDefined();
      expect(output.getNode("feature-right")).toBeDefined();
      expect(output.getNode("feature-left")!.summary).toBe("Left feature");
      expect(output.getNode("feature-right")!.summary).toBe("Right feature");
      expect(output.getStats().nodes).toBe(2);

      output.close();
    });

    it("cleans up edge references after resolution", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      insertTestNode(left.db, "node-a", { summary: "Left A" });
      insertTestNode(left.db, "node-b");
      left.db.insertEdge({ from_id: "node-a", to_id: "node-b", relation: "calls", description: null });

      insertTestNode(right.db, "node-a", { summary: "Right A" });
      insertTestNode(right.db, "node-b");

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);
      const mergeGroup = result.mergeGroups[0];

      const output = new KnowledgeDB(outputPath);

      // Resolve keeping left
      output.hardDeleteNode("node-a::right");
      output.renameNodeId("node-a::left", "node-a");
      output.clearNodeMergeFlags("node-a");
      output.clearEdgeMergeFlagsByGroup(mergeGroup);

      // Edges should now reference "node-a" (not "node-a::left")
      const edges = output.getOutgoingEdges("node-a");
      expect(edges).toHaveLength(1);
      expect(edges[0].to_id).toBe("node-b");

      output.close();
    });
  });

  describe("clean node edge to conflicted target", () => {
    it("remaps edges from clean nodes pointing at conflicted targets", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      // "caller" is the same on both sides (clean, no conflict)
      insertTestNode(left.db, "caller", { summary: "Calls target" });
      insertTestNode(right.db, "caller", { summary: "Calls target" });

      // "target" diverges between sides (conflict)
      insertTestNode(left.db, "target", { summary: "Left target" });
      insertTestNode(right.db, "target", { summary: "Right target" });

      // Edge from clean node to conflicted node — exists on left side
      left.db.insertEdge({ from_id: "caller", to_id: "target", relation: "calls", description: null });

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      expect(result.conceptConflicts).toBe(1); // target conflicted
      expect(result.clean).toBe(1); // caller is clean

      const output = new KnowledgeDB(outputPath);

      // "caller" should exist without suffix
      expect(output.getNode("caller")).toBeDefined();
      // "target" should be split into two suffixed versions
      expect(output.getNode("target::left")).toBeDefined();
      expect(output.getNode("target::right")).toBeDefined();

      // The edge from "caller" should point to "target::left" (since the edge came from the left DB)
      const edges = output.getOutgoingEdges("caller");
      expect(edges).toHaveLength(1);
      expect(edges[0].to_id).toBe("target::left");

      output.close();
    });
  });

  describe("mixed scenarios", () => {
    it("handles a mix of clean, conflict, and removed nodes", () => {
      const left = createTmpDb("left.db");
      const right = createTmpDb("right.db");
      const outputPath = path.join(tmpDir, "output.db");

      // Clean: only in left
      insertTestNode(left.db, "left-only");
      // Clean: only in right
      insertTestNode(right.db, "right-only");
      // Clean: identical in both
      insertTestNode(left.db, "identical", { summary: "Same" });
      insertTestNode(right.db, "identical", { summary: "Same" });
      // Conflict: different
      insertTestNode(left.db, "diverged", { summary: "Left diverged" });
      insertTestNode(right.db, "diverged", { summary: "Right diverged" });
      // Removed cleanly in one side
      insertTestNode(left.db, "removed-left", { summary: "Was here" });
      // (absent in right = clean merge)

      left.db.close();
      right.db.close();

      const result = engine.merge(left.path, right.path, outputPath);

      expect(result.clean).toBe(4); // left-only + right-only + identical + removed-left
      expect(result.conceptConflicts).toBe(1); // diverged
      expect(result.mergeGroups).toHaveLength(1);

      const output = new KnowledgeDB(outputPath);
      expect(output.getNode("left-only")).toBeDefined();
      expect(output.getNode("right-only")).toBeDefined();
      expect(output.getNode("identical")).toBeDefined();
      expect(output.getNode("diverged::left")).toBeDefined();
      expect(output.getNode("diverged::right")).toBeDefined();
      expect(output.getNode("removed-left")).toBeDefined();
      output.close();
    });
  });
});
