import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { NodeRow, EdgeRow } from "./types.js";

const SCHEMA_VERSION = 1;

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
    const version = this.db.pragma("user_version", { simple: true }) as number;

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
          FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          description TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
        CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
        CREATE INDEX IF NOT EXISTS idx_nodes_removed ON nodes(removed_at);
        CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
        CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
      `);
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
    return this.db
      .prepare(
        "SELECT id, name, kind, summary, embedding FROM nodes WHERE removed_at IS NULL AND embedding IS NOT NULL"
      )
      .all() as Array<
      Pick<NodeRow, "id" | "name" | "kind" | "summary" | "embedding">
    >;
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

  close(): void {
    this.db.close();
  }
}
