import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KnowledgeDB } from "../db.js";
import { createConcept } from "../tools.js";
import fs from "fs";
import path from "path";
import os from "os";

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async () => {
    const embedding = new Float32Array([1, 0, 0]);
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }),
  embeddingText: vi.fn((name: string, kind: string, summary: string) =>
    `${kind}: ${name} — ${summary}`
  ),
  findTopK: vi.fn(),
}));

let db: KnowledgeDB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-create-concept-test-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createConcept tool", () => {
  it("creates a root concept when parent_id is omitted", async () => {
    const result = await createConcept(db, {
      name: "Root Concept",
      kind: "module",
      summary: "A root concept",
    });

    expect(result.id).toBe("root-concept");
    expect(db.getNode("root-concept")!.parent_id).toBeNull();
    expect(db.getRootNodes().map((node) => node.id)).toContain("root-concept");
  });

  it("treats empty string parent_id as omitted and stores null", async () => {
    const result = await createConcept(db, {
      name: "Empty Parent Root",
      kind: "feature",
      summary: "A root concept created with an empty parent_id",
      parent_id: "",
    });

    const node = db.getNode("empty-parent-root")!;
    expect(result.id).toBe("empty-parent-root");
    expect(node.parent_id).toBeNull();
    expect(db.getRootNodes().map((root) => root.id)).toContain("empty-parent-root");
  });

  it("creates a child concept for a valid non-empty parent_id", async () => {
    const parent = await createConcept(db, {
      name: "Parent Concept",
      kind: "module",
      summary: "A parent concept",
    });

    const child = await createConcept(db, {
      name: "Child Concept",
      kind: "feature",
      summary: "A child concept",
      parent_id: parent.id,
    });

    const childNode = db.getNode("parent-concept/child-concept")!;
    expect(child.id).toBe("parent-concept/child-concept");
    expect(childNode.parent_id).toBe("parent-concept");
    expect(db.getChildren("parent-concept").map((node) => node.id)).toContain(
      "parent-concept/child-concept"
    );
  });

  it("rejects invalid non-empty parent_id without normalizing it", async () => {
    await expect(
      createConcept(db, {
        name: "Orphan Concept",
        kind: "feature",
        summary: "Should not be created",
        parent_id: "null",
      })
    ).rejects.toThrow('Parent concept "null" does not exist.');

    expect(db.getNode("null/orphan-concept")).toBeUndefined();
    expect(db.getNode("orphan-concept")).toBeUndefined();
  });
});
