import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { getConcept } from "../tools.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-get-concept-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getConcept tool", () => {
  it("returns full NodeWithContext for an existing node", () => {
    const { db } = createTmpDb("basic.db");
    insertTestNode(db, "test-node", {
      name: "Test Node",
      kind: "module",
      summary: "A test node summary",
      why: "For testing purposes",
      file_refs: ["src/test.ts"],
    });

    const result = getConcept(db, { id: "test-node" });

    expect(result.id).toBe("test-node");
    expect(result.name).toBe("Test Node");
    expect(result.kind).toBe("module");
    expect(result.summary).toBe("A test node summary");
    expect(result.why).toBe("For testing purposes");
    expect(result.file_refs).toEqual(["src/test.ts"]);

    db.close();
  });

  it("throws when concept ID does not exist", () => {
    const { db } = createTmpDb("missing.db");

    expect(() => getConcept(db, { id: "non-existent" })).toThrow(
      /not found/
    );

    db.close();
  });

  it("throws for empty string ID", () => {
    const { db } = createTmpDb("empty-id.db");

    expect(() => getConcept(db, { id: "" })).toThrow(/not found/);

    db.close();
  });

  it("throws for soft-deleted nodes", () => {
    const { db } = createTmpDb("deleted.db");
    insertTestNode(db, "doomed-node");
    db.softDeleteNode("doomed-node", "no longer needed");

    expect(() => getConcept(db, { id: "doomed-node" })).toThrow(/not found/);

    db.close();
  });

  it("includes children when child nodes exist", () => {
    const { db } = createTmpDb("children.db");
    insertTestNode(db, "parent-node", { name: "Parent" });
    insertTestNode(db, "child-a", {
      name: "Child A",
      parent_id: "parent-node",
    });
    insertTestNode(db, "child-b", {
      name: "Child B",
      kind: "pattern",
      parent_id: "parent-node",
    });

    const result = getConcept(db, { id: "parent-node" });

    expect(result.children).toHaveLength(2);
    expect(result.children.map((c) => c.id).sort()).toEqual([
      "child-a",
      "child-b",
    ]);
    const childA = result.children.find((c) => c.id === "child-a")!;
    expect(childA.name).toBe("Child A");
    expect(childA.kind).toBe("feature");

    db.close();
  });

  it("includes outgoing edges", () => {
    const { db } = createTmpDb("edges-out.db");
    insertTestNode(db, "node-a");
    insertTestNode(db, "node-b");
    db.insertEdge({
      from_id: "node-a",
      to_id: "node-b",
      relation: "depends_on",
      description: "A depends on B",
    });

    const result = getConcept(db, { id: "node-a" });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to).toBe("node-b");
    expect(result.edges[0].relation).toBe("depends_on");
    expect(result.edges[0].description).toBe("A depends on B");

    db.close();
  });

  it("includes incoming edges", () => {
    const { db } = createTmpDb("edges-in.db");
    insertTestNode(db, "node-a");
    insertTestNode(db, "node-b");
    db.insertEdge({
      from_id: "node-a",
      to_id: "node-b",
      relation: "connects_to",
      description: "A connects to B",
    });

    const result = getConcept(db, { id: "node-b" });

    expect(result.incoming_edges).toHaveLength(1);
    expect(result.incoming_edges[0].from).toBe("node-a");
    expect(result.incoming_edges[0].relation).toBe("connects_to");

    db.close();
  });

  it("includes parent when parent_id is set", () => {
    const { db } = createTmpDb("parent.db");
    insertTestNode(db, "parent-node", { name: "Parent" });
    insertTestNode(db, "child-node", {
      name: "Child",
      parent_id: "parent-node",
    });

    const result = getConcept(db, { id: "child-node" });

    expect(result.parent).not.toBeNull();
    expect(result.parent!.id).toBe("parent-node");
    expect(result.parent!.name).toBe("Parent");

    db.close();
  });

  it("parent is null when parent_id is null", () => {
    const { db } = createTmpDb("no-parent.db");
    insertTestNode(db, "orphan-node");

    const result = getConcept(db, { id: "orphan-node" });

    expect(result.parent).toBeNull();

    db.close();
  });

  it("does not include similarity field", () => {
    const { db } = createTmpDb("no-similarity.db");
    insertTestNode(db, "plain-node");

    const result = getConcept(db, { id: "plain-node" });

    expect("similarity" in result).toBe(false);

    db.close();
  });

  it("file_refs is parsed from JSON to array", () => {
    const { db } = createTmpDb("filerefs.db");
    insertTestNode(db, "refs-node", {
      file_refs: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });

    const result = getConcept(db, { id: "refs-node" });

    expect(result.file_refs).toHaveLength(3);
    expect(result.file_refs).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

    db.close();
  });
});
