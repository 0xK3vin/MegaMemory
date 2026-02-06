import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import fs from "fs";
import path from "path";
import os from "os";

let db: KnowledgeDB;
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-test-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  db = new KnowledgeDB(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("KnowledgeDB", () => {
  describe("schema", () => {
    it("creates the database file on construction", () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("runs migrations cleanly on a fresh database", () => {
      const stats = db.getStats();
      expect(stats.nodes).toBe(0);
      expect(stats.edges).toBe(0);
    });
  });

  describe("nodes", () => {
    it("inserts and retrieves a node", () => {
      db.insertNode({
        id: "test-node",
        name: "Test Node",
        kind: "feature",
        summary: "A test node",
        why: "For testing",
        file_refs: ["src/test.ts"],
        parent_id: null,
        created_by_task: "test",
        embedding: null,
      });

      const node = db.getNode("test-node");
      expect(node).not.toBeNull();
      expect(node!.name).toBe("Test Node");
      expect(node!.kind).toBe("feature");
      expect(node!.summary).toBe("A test node");
      expect(node!.why).toBe("For testing");
    });

    it("returns undefined for non-existent node", () => {
      expect(db.getNode("nonexistent")).toBeUndefined();
    });

    it("updates node fields", () => {
      db.insertNode({
        id: "update-me",
        name: "Original",
        kind: "feature",
        summary: "Original summary",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.updateNode("update-me", {
        name: "Updated",
        summary: "Updated summary",
      });

      const node = db.getNode("update-me");
      expect(node!.name).toBe("Updated");
      expect(node!.summary).toBe("Updated summary");
    });

    it("soft-deletes a node", () => {
      db.insertNode({
        id: "delete-me",
        name: "To Delete",
        kind: "module",
        summary: "Will be deleted",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.softDeleteNode("delete-me", "No longer needed");

      // Should not appear in active queries
      expect(db.getNode("delete-me")).toBeUndefined();

      // Should appear in including-removed query
      const removed = db.getNodeIncludingRemoved("delete-me");
      expect(removed).not.toBeNull();
      expect(removed!.removed_reason).toBe("No longer needed");
    });

    it("nodeExists returns true for existing, false for missing", () => {
      db.insertNode({
        id: "exists",
        name: "Exists",
        kind: "feature",
        summary: "I exist",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      expect(db.nodeExists("exists")).toBe(true);
      expect(db.nodeExists("nope")).toBe(false);
    });
  });

  describe("parent-child relationships", () => {
    it("getRootNodes returns only parentless nodes", () => {
      db.insertNode({
        id: "root",
        name: "Root",
        kind: "module",
        summary: "A root node",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.insertNode({
        id: "root/child",
        name: "Child",
        kind: "feature",
        summary: "A child node",
        why: null,
        file_refs: null,
        parent_id: "root",
        created_by_task: null,
        embedding: null,
      });

      const roots = db.getRootNodes();
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe("root");
    });

    it("getChildren returns children of a parent", () => {
      db.insertNode({
        id: "parent",
        name: "Parent",
        kind: "module",
        summary: "Parent",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      db.insertNode({
        id: "parent/child-a",
        name: "Child A",
        kind: "feature",
        summary: "First child",
        why: null,
        file_refs: null,
        parent_id: "parent",
        created_by_task: null,
        embedding: null,
      });

      db.insertNode({
        id: "parent/child-b",
        name: "Child B",
        kind: "feature",
        summary: "Second child",
        why: null,
        file_refs: null,
        parent_id: "parent",
        created_by_task: null,
        embedding: null,
      });

      const children = db.getChildren("parent");
      expect(children).toHaveLength(2);
      const names = children.map((c) => c.name).sort();
      expect(names).toEqual(["Child A", "Child B"]);
    });
  });

  describe("edges", () => {
    beforeEach(() => {
      db.insertNode({
        id: "node-a",
        name: "Node A",
        kind: "feature",
        summary: "Node A",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "node-b",
        name: "Node B",
        kind: "module",
        summary: "Node B",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
    });

    it("inserts and retrieves an edge", () => {
      db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "depends_on",
        description: "A depends on B",
      });

      const outgoing = db.getOutgoingEdges("node-a");
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].to_id).toBe("node-b");
      expect(outgoing[0].relation).toBe("depends_on");

      const incoming = db.getIncomingEdges("node-b");
      expect(incoming).toHaveLength(1);
      expect(incoming[0].from_id).toBe("node-a");
    });

    it("cascade-deletes edges when a node is soft-deleted", () => {
      db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "calls",
        description: null,
      });

      db.softDeleteNode("node-a", "Removed");

      // Edges involving node-a should be gone
      const outgoing = db.getOutgoingEdges("node-a");
      expect(outgoing).toHaveLength(0);
      const incoming = db.getIncomingEdges("node-a");
      expect(incoming).toHaveLength(0);
    });

    it("getAllEdges returns all edges", () => {
      db.insertEdge({
        from_id: "node-a",
        to_id: "node-b",
        relation: "depends_on",
        description: null,
      });

      const edges = db.getAllEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].from_id).toBe("node-a");
      expect(edges[0].to_id).toBe("node-b");
    });
  });

  describe("stats", () => {
    it("returns correct counts", () => {
      db.insertNode({
        id: "s1",
        name: "S1",
        kind: "feature",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "s2",
        name: "S2",
        kind: "module",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertEdge({
        from_id: "s1",
        to_id: "s2",
        relation: "calls",
        description: null,
      });

      const stats = db.getStats();
      expect(stats.nodes).toBe(2);
      expect(stats.edges).toBe(1);
    });

    it("getKindsBreakdown returns counts per kind", () => {
      db.insertNode({
        id: "k1",
        name: "K1",
        kind: "feature",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "k2",
        name: "K2",
        kind: "feature",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });
      db.insertNode({
        id: "k3",
        name: "K3",
        kind: "module",
        summary: "s",
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: null,
        embedding: null,
      });

      const kinds = db.getKindsBreakdown();
      expect(kinds.feature).toBe(2);
      expect(kinds.module).toBe(1);
    });
  });
});
