import Database from "libsql";
import path from "path";
import fs from "fs";
import type { NodeRow, EdgeRow } from "./types.js";

const SCHEMA_VERSION = 2;

export class KnowledgeDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const pragmaResult = this.db.pragma("user_version", { simple: true });
    // libsql returns { user_version: N } instead of raw N like better-sqlite3
    const version = (
      typeof pragmaResult === "object" && pragmaResult !== null
        ? (pragmaResult as Record<string, unknown>).user_version
        : pragmaResult
    ) as number;

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          why TEXT,
          file_refs TEXT,
          parent_id TEXT,
          created_by_task TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          removed_at TEXT,
          removed_reason TEXT,
          embedding BLOB,
          merge_group TEXT,
          needs_merge INTEGER DEFAULT 0,
          source_branch TEXT,
          merge_timestamp TEXT,
          FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          description TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          merge_group TEXT,
          needs_merge INTEGER DEFAULT 0,
          source_branch TEXT,
          merge_timestamp TEXT,
          FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
        CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
        CREATE INDEX IF NOT EXISTS idx_nodes_removed ON nodes(removed_at);
        CREATE INDEX IF NOT EXISTS idx_nodes_merge_group ON nodes(merge_group);
        CREATE INDEX IF NOT EXISTS idx_nodes_needs_merge ON nodes(needs_merge);
        CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
        CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
        CREATE INDEX IF NOT EXISTS idx_edges_merge_group ON edges(merge_group);
        CREATE INDEX IF NOT EXISTS idx_edges_needs_merge ON edges(needs_merge);
      `);
    }

    if (version < 2) {
      // Add merge-related columns for existing v1 databases
      const nodeColumns = this.db
        .prepare("PRAGMA table_info(nodes)")
        .all() as Array<{ name: string }>;
      const nodeColNames = new Set(nodeColumns.map((c) => c.name));

      if (!nodeColNames.has("merge_group")) {
        this.db.exec(`
          ALTER TABLE nodes ADD COLUMN merge_group TEXT;
          ALTER TABLE nodes ADD COLUMN needs_merge INTEGER DEFAULT 0;
          ALTER TABLE nodes ADD COLUMN source_branch TEXT;
          ALTER TABLE nodes ADD COLUMN merge_timestamp TEXT;
          CREATE INDEX IF NOT EXISTS idx_nodes_merge_group ON nodes(merge_group);
          CREATE INDEX IF NOT EXISTS idx_nodes_needs_merge ON nodes(needs_merge);
        `);
      }

      const edgeColumns = this.db
        .prepare("PRAGMA table_info(edges)")
        .all() as Array<{ name: string }>;
      const edgeColNames = new Set(edgeColumns.map((c) => c.name));

      if (!edgeColNames.has("merge_group")) {
        this.db.exec(`
          ALTER TABLE edges ADD COLUMN merge_group TEXT;
          ALTER TABLE edges ADD COLUMN needs_merge INTEGER DEFAULT 0;
          ALTER TABLE edges ADD COLUMN source_branch TEXT;
          ALTER TABLE edges ADD COLUMN merge_timestamp TEXT;
          CREATE INDEX IF NOT EXISTS idx_edges_merge_group ON edges(merge_group);
          CREATE INDEX IF NOT EXISTS idx_edges_needs_merge ON edges(needs_merge);
        `);
      }
    }

    if (version < SCHEMA_VERSION) {
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  // ---- Node CRUD ----

  insertNode(node: {
    id: string;
    name: string;
    kind: string;
    summary: string;
    why?: string | null;
    file_refs?: string[] | null;
    parent_id?: string | null;
    created_by_task?: string | null;
    embedding?: Buffer | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task, embedding)
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task, @embedding)
    `);
    stmt.run({
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why ?? null,
      file_refs: node.file_refs ? JSON.stringify(node.file_refs) : null,
      parent_id: node.parent_id ?? null,
      created_by_task: node.created_by_task ?? null,
      embedding: node.embedding ?? null,
    });
  }

  getNode(id: string): NodeRow | undefined {
    return this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND removed_at IS NULL")
      .get(id) as NodeRow | undefined;
  }

  getNodeIncludingRemoved(id: string): NodeRow | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | NodeRow
      | undefined;
  }

  updateNode(
    id: string,
    changes: {
      name?: string;
      kind?: string;
      summary?: string;
      why?: string;
      file_refs?: string[];
      embedding?: Buffer;
    }
  ): boolean {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (changes.name !== undefined) {
      fields.push("name = @name");
      values.name = changes.name;
    }
    if (changes.kind !== undefined) {
      fields.push("kind = @kind");
      values.kind = changes.kind;
    }
    if (changes.summary !== undefined) {
      fields.push("summary = @summary");
      values.summary = changes.summary;
    }
    if (changes.why !== undefined) {
      fields.push("why = @why");
      values.why = changes.why;
    }
    if (changes.file_refs !== undefined) {
      fields.push("file_refs = @file_refs");
      values.file_refs = JSON.stringify(changes.file_refs);
    }
    if (changes.embedding !== undefined) {
      fields.push("embedding = @embedding");
      values.embedding = changes.embedding;
    }

    if (fields.length === 0) return false;

    fields.push("updated_at = datetime('now')");

    const stmt = this.db.prepare(
      `UPDATE nodes SET ${fields.join(", ")} WHERE id = @id AND removed_at IS NULL`
    );
    const result = stmt.run(values);
    return result.changes > 0;
  }

  softDeleteNode(id: string, reason: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE nodes SET removed_at = datetime('now'), removed_reason = @reason, updated_at = datetime('now')
      WHERE id = @id AND removed_at IS NULL
    `);
    const result = stmt.run({ id, reason });

    // Also remove edges involving this node
    if (result.changes > 0) {
      this.db
        .prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?")
        .run(id, id);
    }

    return result.changes > 0;
  }

  // ---- Edge CRUD ----

  insertEdge(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO edges (from_id, to_id, relation, description)
      VALUES (@from_id, @to_id, @relation, @description)
    `);
    const result = stmt.run({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  deleteEdge(fromId: string, toId: string, relation: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?"
      )
      .run(fromId, toId, relation);
    return result.changes > 0;
  }

  // ---- Query methods ----

  getChildren(parentId: string): NodeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM nodes WHERE parent_id = ? AND removed_at IS NULL"
      )
      .all(parentId) as NodeRow[];
  }

  getOutgoingEdges(
    nodeId: string
  ): Array<EdgeRow & { to_name: string; to_summary: string }> {
    return this.db
      .prepare(
        `
      SELECT e.*, n.name as to_name, n.summary as to_summary
      FROM edges e
      JOIN nodes n ON e.to_id = n.id
      WHERE e.from_id = ? AND n.removed_at IS NULL
    `
      )
      .all(nodeId) as Array<EdgeRow & { to_name: string; to_summary: string }>;
  }

  getIncomingEdges(
    nodeId: string
  ): Array<EdgeRow & { from_name: string; from_summary: string }> {
    return this.db
      .prepare(
        `
      SELECT e.*, n.name as from_name, n.summary as from_summary
      FROM edges e
      JOIN nodes n ON e.from_id = n.id
      WHERE e.to_id = ? AND n.removed_at IS NULL
    `
      )
      .all(nodeId) as Array<
      EdgeRow & { from_name: string; from_summary: string }
    >;
  }

  getParent(parentId: string): NodeRow | undefined {
    return this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND removed_at IS NULL")
      .get(parentId) as NodeRow | undefined;
  }

  getRootNodes(): NodeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM nodes WHERE parent_id IS NULL AND removed_at IS NULL ORDER BY name"
      )
      .all() as NodeRow[];
  }

  getAllActiveNodesWithEmbeddings(): Array<
    Pick<NodeRow, "id" | "name" | "kind" | "summary" | "embedding">
  > {
    const rows = this.db
      .prepare(
        "SELECT id, name, kind, summary, embedding FROM nodes WHERE removed_at IS NULL AND embedding IS NOT NULL"
      )
      .all() as Array<any>;
    
    return rows.map((row) => ({
      ...row,
      embedding: row.embedding ? Buffer.from(row.embedding) : null
    })) as Array<Pick<NodeRow, "id" | "name" | "kind" | "summary" | "embedding">>;
  }

  nodeExists(id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM nodes WHERE id = ? AND removed_at IS NULL"
      )
      .get(id);
    return row !== undefined;
  }

  // ---- Web API query methods ----

  getAllActiveNodes(): Array<Omit<NodeRow, "embedding">> {
    return this.db
      .prepare(
        `SELECT id, name, kind, summary, why, file_refs, parent_id,
                created_by_task, created_at, updated_at, removed_at, removed_reason
         FROM nodes WHERE removed_at IS NULL ORDER BY name`
      )
      .all() as Array<Omit<NodeRow, "embedding">>;
  }

  getAllEdges(): EdgeRow[] {
    return this.db
      .prepare(
        `SELECT e.*
         FROM edges e
         JOIN nodes n1 ON e.from_id = n1.id
         JOIN nodes n2 ON e.to_id = n2.id
         WHERE n1.removed_at IS NULL AND n2.removed_at IS NULL`
      )
      .all() as EdgeRow[];
  }

  getKindsBreakdown(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT kind, COUNT(*) as count FROM nodes WHERE removed_at IS NULL GROUP BY kind"
      )
      .all() as Array<{ kind: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.kind] = row.count;
    }
    return result;
  }

  getStats(): { nodes: number; edges: number; removed: number } {
    const nodes = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM nodes WHERE removed_at IS NULL")
        .get() as { count: number }
    ).count;
    const edges = (
      this.db.prepare("SELECT COUNT(*) as count FROM edges").get() as {
        count: number;
      }
    ).count;
    const removed = (
      this.db
        .prepare(
          "SELECT COUNT(*) as count FROM nodes WHERE removed_at IS NOT NULL"
        )
        .get() as { count: number }
    ).count;
    return { nodes, edges, removed };
  }

  // ---- Merge-related methods ----

  getConflictNodes(): NodeRow[] {
    // Don't filter by removed_at — removal conflicts are valid (one side removed, other didn't)
    return this.db
      .prepare("SELECT * FROM nodes WHERE needs_merge = 1")
      .all() as NodeRow[];
  }

  getConflictEdges(): EdgeRow[] {
    return this.db
      .prepare("SELECT * FROM edges WHERE needs_merge = 1")
      .all() as EdgeRow[];
  }

  getNodesByMergeGroup(mergeGroup: string): NodeRow[] {
    return this.db
      .prepare("SELECT * FROM nodes WHERE merge_group = ?")
      .all(mergeGroup) as NodeRow[];
  }

  getEdgesByMergeGroup(mergeGroup: string): EdgeRow[] {
    return this.db
      .prepare("SELECT * FROM edges WHERE merge_group = ?")
      .all(mergeGroup) as EdgeRow[];
  }

  clearNodeMergeFlags(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE nodes SET merge_group = NULL, needs_merge = 0, source_branch = NULL,
         merge_timestamp = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .run(id);
    return result.changes > 0;
  }

  clearEdgeMergeFlagsByGroup(mergeGroup: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE edges SET merge_group = NULL, needs_merge = 0, source_branch = NULL,
         merge_timestamp = NULL WHERE merge_group = ?`
      )
      .run(mergeGroup);
    return result.changes > 0;
  }

  renameNodeId(oldId: string, newId: string): boolean {
    // Temporarily disable foreign keys for the rename operation,
    // since self-referencing FKs (parent_id → id) would block the update.
    // Wrapped in a transaction so all 4 updates succeed or none do.
    this.db.pragma("foreign_keys = OFF");
    try {
      let changed = false;
      this.db.exec("BEGIN");
      try {
        const result = this.db
          .prepare("UPDATE nodes SET id = @newId, updated_at = datetime('now') WHERE id = @oldId")
          .run({ oldId, newId });

        if (result.changes > 0) {
          changed = true;
          // Update parent_id references in children
          this.db
            .prepare("UPDATE nodes SET parent_id = @newId WHERE parent_id = @oldId")
            .run({ oldId, newId });
          // Update edge references
          this.db
            .prepare("UPDATE edges SET from_id = @newId WHERE from_id = @oldId")
            .run({ oldId, newId });
          this.db
            .prepare("UPDATE edges SET to_id = @newId WHERE to_id = @oldId")
            .run({ oldId, newId });
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      return changed;
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  getAllNodesRaw(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes").all() as NodeRow[];
  }

  getAllEdgesRaw(): EdgeRow[] {
    return this.db.prepare("SELECT * FROM edges").all() as EdgeRow[];
  }

  deleteEdgesForNode(nodeId: string): void {
    this.db
      .prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?")
      .run(nodeId, nodeId);
  }

  hardDeleteNode(id: string): boolean {
    this.deleteEdgesForNode(id);
    const result = this.db
      .prepare("DELETE FROM nodes WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  insertNodeRaw(node: {
    id: string;
    name: string;
    kind: string;
    summary: string;
    why?: string | null;
    file_refs?: string | null;
    parent_id?: string | null;
    created_by_task?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    removed_at?: string | null;
    removed_reason?: string | null;
    embedding?: Buffer | null;
    merge_group?: string | null;
    needs_merge?: number;
    source_branch?: string | null;
    merge_timestamp?: string | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task,
        created_at, updated_at, removed_at, removed_reason, embedding,
        merge_group, needs_merge, source_branch, merge_timestamp)
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task,
        @created_at, @updated_at, @removed_at, @removed_reason, @embedding,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp)
    `);
    stmt.run({
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why ?? null,
      file_refs: node.file_refs ?? null,
      parent_id: node.parent_id ?? null,
      created_by_task: node.created_by_task ?? null,
      created_at: node.created_at ?? null,
      updated_at: node.updated_at ?? null,
      removed_at: node.removed_at ?? null,
      removed_reason: node.removed_reason ?? null,
      embedding: node.embedding ?? null,
      merge_group: node.merge_group ?? null,
      needs_merge: node.needs_merge ?? 0,
      source_branch: node.source_branch ?? null,
      merge_timestamp: node.merge_timestamp ?? null,
    });
  }

  insertEdgeRaw(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
    created_at?: string | null;
    merge_group?: string | null;
    needs_merge?: number;
    source_branch?: string | null;
    merge_timestamp?: string | null;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO edges (from_id, to_id, relation, description, created_at,
        merge_group, needs_merge, source_branch, merge_timestamp)
      VALUES (@from_id, @to_id, @relation, @description, @created_at,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp)
    `);
    const result = stmt.run({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description ?? null,
      created_at: edge.created_at ?? null,
      merge_group: edge.merge_group ?? null,
      needs_merge: edge.needs_merge ?? 0,
      source_branch: edge.source_branch ?? null,
      merge_timestamp: edge.merge_timestamp ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  close(): void {
    this.db.close();
  }
}
