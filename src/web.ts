import http from "http";
import fs from "fs";
import path from "path";
import { KnowledgeDB } from "./db.js";
import { buildNodeWithContext } from "./tools.js";
import type { NodeRow } from "./types.js";

function resolveHtmlPath(): string {
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  // From dist/ → ../web/index.html
  const fromDist = path.resolve(thisDir, "..", "web", "index.html");
  if (fs.existsSync(fromDist)) return fromDist;
  // From src/ → ../web/index.html
  return path.resolve(thisDir, "..", "web", "index.html");
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function html(res: http.ServerResponse, content: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function parseFileRefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function runServe(port: number): void {
  const dbPath =
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.error(
      `No database found at ${dbPath}\n` +
        `Run megamemory in a project that has been used with the MCP server, or set MEGAMEMORY_DB_PATH.`
    );
    process.exit(1);
  }

  const db = new KnowledgeDB(dbPath);
  const htmlPath = resolveHtmlPath();

  if (!fs.existsSync(htmlPath)) {
    console.error(`HTML file not found at ${htmlPath}`);
    process.exit(1);
  }

  const htmlContent = fs.readFileSync(htmlPath, "utf-8");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    // ---- Routes ----

    if (pathname === "/" && req.method === "GET") {
      html(res, htmlContent);
      return;
    }

    if (pathname === "/api/graph" && req.method === "GET") {
      const nodes = db.getAllActiveNodes().map((n) => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
        summary: n.summary,
        parent_id: n.parent_id,
        edge_count: 0, // filled below
      }));

      const edges = db.getAllEdges().map((e) => ({
        from: e.from_id,
        to: e.to_id,
        relation: e.relation,
        description: e.description,
      }));

      // Count edges per node
      const edgeCounts = new Map<string, number>();
      for (const e of edges) {
        edgeCounts.set(e.from, (edgeCounts.get(e.from) ?? 0) + 1);
        edgeCounts.set(e.to, (edgeCounts.get(e.to) ?? 0) + 1);
      }
      for (const n of nodes) {
        n.edge_count = edgeCounts.get(n.id) ?? 0;
      }

      json(res, { nodes, edges });
      return;
    }

    if (pathname.startsWith("/api/node/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/node/".length));
      const node = db.getNode(id);
      if (!node) {
        json(res, { error: `Concept "${id}" not found` }, 404);
        return;
      }
      const ctx = buildNodeWithContext(db, node);
      // Add timestamps
      const result = {
        ...ctx,
        created_at: node.created_at,
        updated_at: node.updated_at,
        created_by_task: node.created_by_task,
      };
      json(res, result);
      return;
    }

    if (pathname === "/api/stats" && req.method === "GET") {
      const stats = db.getStats();
      const kinds = db.getKindsBreakdown();
      json(res, { ...stats, kinds });
      return;
    }

    notFound(res);
  });

  server.listen(port, () => {
    console.log(`megamemory explorer running at http://localhost:${port}`);
    console.log(`Database: ${dbPath}`);
    console.log(`Press Ctrl+C to stop.\n`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    server.close();
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
