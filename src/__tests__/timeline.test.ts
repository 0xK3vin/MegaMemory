import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import fs from "fs";
import path from "path";
import os from "os";

let db: KnowledgeDB;
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-timeline-test-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  db = new KnowledgeDB(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setTimelineTimestamp(seq: number, timestamp: string): void {
  const rawDb = new Database(dbPath);
  rawDb.prepare("UPDATE timeline SET timestamp = ? WHERE seq = ?").run(timestamp, seq);
  rawDb.close();
}

function setNodeRemovedAt(nodeId: string, removedAt: string): void {
  const rawDb = new Database(dbPath);
  rawDb.prepare("UPDATE nodes SET removed_at = ? WHERE id = ?").run(removedAt, nodeId);
  rawDb.close();
}

describe("KnowledgeDB timeline", () => {
  describe("timeline entry CRUD", () => {
    it("insertTimelineEntry creates an entry and returns a seq number", () => {
      const seq = db.insertTimelineEntry({
        tool: "create_concept",
        params: JSON.stringify({ name: "Timeline Test" }),
        result_summary: "Created concept",
        is_write: true,
        is_error: false,
        affected_ids: ["timeline-test"],
      });

      expect(seq).toBe(1);
    });

    it("insertTimelineEntry stores correct fields", () => {
      const seq = db.insertTimelineEntry({
        tool: "update_concept",
        params: JSON.stringify({ id: "a", changes: { summary: "s" } }),
        result_summary: "Updated concept a",
        is_write: true,
        is_error: true,
        affected_ids: ["a", "a/child"],
      });

      const entries = db.getTimelineEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].seq).toBe(seq);
      expect(entries[0].tool).toBe("update_concept");
      expect(entries[0].params).toBe(
        JSON.stringify({ id: "a", changes: { summary: "s" } })
      );
      expect(entries[0].result_summary).toBe("Updated concept a");
      expect(entries[0].is_write).toBe(1);
      expect(entries[0].is_error).toBe(1);
      expect(entries[0].affected_ids).toBe(JSON.stringify(["a", "a/child"]));
    });

    it("multiple entries get incrementing seq numbers", () => {
      const seq1 = db.insertTimelineEntry({
        tool: "list_roots",
        params: "{}",
        result_summary: "Listed roots",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      const seq2 = db.insertTimelineEntry({
        tool: "understand",
        params: JSON.stringify({ query: "x" }),
        result_summary: "Returned matches",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      const seq3 = db.insertTimelineEntry({
        tool: "create_concept",
        params: JSON.stringify({ name: "New" }),
        result_summary: "Created",
        is_write: true,
        is_error: false,
        affected_ids: ["new"],
      });

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });
  });

  describe("timeline queries", () => {
    it("getTimelineBounds returns null first/last and count 0 for empty timeline", () => {
      const bounds = db.getTimelineBounds();

      expect(bounds.first).toBeNull();
      expect(bounds.last).toBeNull();
      expect(bounds.count).toBe(0);
    });

    it("getTimelineBounds returns correct first, last, and count after inserting entries", () => {
      const seq1 = db.insertTimelineEntry({
        tool: "t1",
        params: "{}",
        result_summary: "r1",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      const seq2 = db.insertTimelineEntry({
        tool: "t2",
        params: "{}",
        result_summary: "r2",
        is_write: true,
        is_error: false,
        affected_ids: ["x"],
      });

      setTimelineTimestamp(seq1, "2026-02-10T10:00:00.000Z");
      setTimelineTimestamp(seq2, "2026-02-10T11:00:00.000Z");

      const bounds = db.getTimelineBounds();
      expect(bounds.first).toBe("2026-02-10T10:00:00.000Z");
      expect(bounds.last).toBe("2026-02-10T11:00:00.000Z");
      expect(bounds.count).toBe(2);
    });

    it("getTimelineEntries returns all entries in seq order", () => {
      db.insertTimelineEntry({
        tool: "a",
        params: "{}",
        result_summary: "ra",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      db.insertTimelineEntry({
        tool: "b",
        params: "{}",
        result_summary: "rb",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      db.insertTimelineEntry({
        tool: "c",
        params: "{}",
        result_summary: "rc",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });

      const entries = db.getTimelineEntries();
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("getTimelineEntries with limit works", () => {
      db.insertTimelineEntry({
        tool: "a",
        params: "{}",
        result_summary: "ra",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      db.insertTimelineEntry({
        tool: "b",
        params: "{}",
        result_summary: "rb",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      db.insertTimelineEntry({
        tool: "c",
        params: "{}",
        result_summary: "rc",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });

      const entries = db.getTimelineEntries({ limit: 2 });
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("getTimelineEntries with tool filter works", () => {
      db.insertTimelineEntry({
        tool: "understand",
        params: "{}",
        result_summary: "r1",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      db.insertTimelineEntry({
        tool: "create_concept",
        params: "{}",
        result_summary: "r2",
        is_write: true,
        is_error: false,
        affected_ids: ["x"],
      });
      db.insertTimelineEntry({
        tool: "understand",
        params: "{}",
        result_summary: "r3",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });

      const entries = db.getTimelineEntries({ tool: "understand" });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.tool === "understand")).toBe(true);
      expect(entries.map((e) => e.seq)).toEqual([1, 3]);
    });

    it("getTimelineEntries with writesOnly filter works", () => {
      db.insertTimelineEntry({
        tool: "understand",
        params: "{}",
        result_summary: "read",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      db.insertTimelineEntry({
        tool: "create_concept",
        params: "{}",
        result_summary: "write1",
        is_write: true,
        is_error: false,
        affected_ids: ["a"],
      });
      db.insertTimelineEntry({
        tool: "link",
        params: "{}",
        result_summary: "write2",
        is_write: true,
        is_error: false,
        affected_ids: ["a", "b"],
      });

      const entries = db.getTimelineEntries({ writesOnly: true });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.is_write === 1)).toBe(true);
      expect(entries.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("getTimelineEntries with since/until time range works", () => {
      const seq1 = db.insertTimelineEntry({
        tool: "t1",
        params: "{}",
        result_summary: "r1",
        is_write: false,
        is_error: false,
        affected_ids: [],
      });
      const seq2 = db.insertTimelineEntry({
        tool: "t2",
        params: "{}",
        result_summary: "r2",
        is_write: true,
        is_error: false,
        affected_ids: ["x"],
      });
      const seq3 = db.insertTimelineEntry({
        tool: "t3",
        params: "{}",
        result_summary: "r3",
        is_write: true,
        is_error: false,
        affected_ids: ["y"],
      });

      setTimelineTimestamp(seq1, "2026-02-10T09:00:00.000Z");
      setTimelineTimestamp(seq2, "2026-02-10T10:00:00.000Z");
      setTimelineTimestamp(seq3, "2026-02-10T11:00:00.000Z");

      const entries = db.getTimelineEntries({
        since: "2026-02-10T09:30:00.000Z",
        until: "2026-02-10T10:30:00.000Z",
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].seq).toBe(seq2);
      expect(entries[0].tool).toBe("t2");
    });
  });

  describe("timeline ticks", () => {
    it("getTimelineTicks(n) returns sampled entries", () => {
      for (let i = 0; i < 10; i += 1) {
        db.insertTimelineEntry({
          tool: `tool-${i}`,
          params: "{}",
          result_summary: `result-${i}`,
          is_write: i % 2 === 0,
          is_error: false,
          affected_ids: [],
        });
      }

      const ticks = db.getTimelineTicks(3);
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(4);
      expect(ticks[0].seq).toBe(1);
      for (let i = 1; i < ticks.length; i += 1) {
        expect(ticks[i].seq).toBeGreaterThan(ticks[i - 1].seq);
      }
    });

    it("getTimelineTicks returns all entries when n >= total count", () => {
      for (let i = 0; i < 4; i += 1) {
        db.insertTimelineEntry({
          tool: `tool-${i}`,
          params: "{}",
          result_summary: "result",
          is_write: false,
          is_error: false,
          affected_ids: [],
        });
      }

      const ticks = db.getTimelineTicks(10);
      expect(ticks).toHaveLength(4);
      expect(ticks.map((t) => t.seq)).toEqual([1, 2, 3, 4]);
    });
  });

  describe("graph at time", () => {
    beforeEach(() => {
      db.insertNodeRaw({
        id: "node-a",
        name: "Node A",
        kind: "feature",
        summary: "A",
        created_at: "2026-02-10 10:00:00",
        updated_at: "2026-02-10 10:00:00",
      });
      db.insertNodeRaw({
        id: "node-b",
        name: "Node B",
        kind: "feature",
        summary: "B",
        created_at: "2026-02-10 11:00:00",
        updated_at: "2026-02-10 11:00:00",
      });
      db.insertNodeRaw({
        id: "node-c",
        name: "Node C",
        kind: "feature",
        summary: "C",
        created_at: "2026-02-10 12:00:00",
        updated_at: "2026-02-10 12:00:00",
      });
      db.insertNodeRaw({
        id: "node-d",
        name: "Node D",
        kind: "feature",
        summary: "D",
        created_at: "2026-02-10 13:00:00",
        updated_at: "2026-02-10 13:00:00",
      });

      db.softDeleteNode("node-b", "Removed before snapshot");
      db.softDeleteNode("node-c", "Removed after snapshot");
      setNodeRemovedAt("node-b", "2026-02-10 11:30:00");
      setNodeRemovedAt("node-c", "2026-02-10 12:30:00");

      db.insertEdgeRaw({
        from_id: "node-a",
        to_id: "node-c",
        relation: "calls",
        created_at: "2026-02-10 12:00:00",
      });
      db.insertEdgeRaw({
        from_id: "node-a",
        to_id: "node-d",
        relation: "calls",
        created_at: "2026-02-10 12:00:00",
      });
      db.insertEdgeRaw({
        from_id: "node-a",
        to_id: "node-b",
        relation: "calls",
        created_at: "2026-02-10 11:00:00",
      });
    });

    it("getNodesAtTime returns nodes created before the timestamp", () => {
      const nodes = db.getNodesAtTime("2026-02-10 11:15:00");
      const ids = nodes.map((n) => n.id);

      expect(ids).toContain("node-a");
      expect(ids).toContain("node-b");
    });

    it("getNodesAtTime excludes nodes created after the timestamp", () => {
      const nodes = db.getNodesAtTime("2026-02-10 11:15:00");
      const ids = nodes.map((n) => n.id);

      expect(ids).not.toContain("node-c");
      expect(ids).not.toContain("node-d");
    });

    it("getNodesAtTime excludes nodes removed before the timestamp", () => {
      const nodes = db.getNodesAtTime("2026-02-10 12:00:00");
      const ids = nodes.map((n) => n.id);

      expect(ids).not.toContain("node-b");
    });

    it("getNodesAtTime includes nodes removed after the timestamp", () => {
      const nodes = db.getNodesAtTime("2026-02-10 12:00:00");
      const ids = nodes.map((n) => n.id);

      expect(ids).toContain("node-c");
    });

    it("getEdgesAtTime returns edges where both endpoints existed at the timestamp", () => {
      const edges = db.getEdgesAtTime("2026-02-10 12:00:00");
      const pairs = edges.map((e) => `${e.from_id}->${e.to_id}`);

      expect(pairs).toContain("node-a->node-c");
    });

    it("getEdgesAtTime excludes edges where one endpoint was created after the timestamp", () => {
      const edges = db.getEdgesAtTime("2026-02-10 12:00:00");
      const pairs = edges.map((e) => `${e.from_id}->${e.to_id}`);

      expect(pairs).not.toContain("node-a->node-d");
    });

    it("getEdgesAtTime excludes edges where one endpoint was removed before the timestamp", () => {
      const edges = db.getEdgesAtTime("2026-02-10 12:00:00");
      const pairs = edges.map((e) => `${e.from_id}->${e.to_id}`);

      expect(pairs).not.toContain("node-a->node-b");
    });
  });

  describe("schema migration", () => {
    it("verifies schema version is 3", () => {
      const rawDb = new Database(dbPath);
      const pragmaResult = rawDb.pragma("user_version", { simple: true }) as
        | number
        | { user_version: number };
      rawDb.close();

      const version =
        typeof pragmaResult === "object"
          ? pragmaResult.user_version
          : pragmaResult;
      expect(version).toBe(3);
    });

    it("verifies timeline table exists with correct columns", () => {
      const rawDb = new Database(dbPath);
      const columns = rawDb
        .prepare("PRAGMA table_info(timeline)")
        .all() as Array<{ name: string }>;
      rawDb.close();

      const names = columns.map((c) => c.name);
      expect(names).toEqual([
        "seq",
        "timestamp",
        "tool",
        "params",
        "result_summary",
        "is_write",
        "is_error",
        "affected_ids",
      ]);
    });
  });
});
