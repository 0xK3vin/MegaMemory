import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { buildNodeWithContext, understand } from "./tools.js";
import { errorBold, askPort } from "./cli-utils.js";
import { initializeEmbeddings } from "./embeddings.js";
import type { NodeRow } from "./types.js";

const VERSION = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version;

function resolveHtmlPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
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

function printBanner(port: number, dbPath: string): void {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("megamemory"))} ${pc.green(`v${VERSION}`)} ${pc.dim("explorer")}`);
  console.log();
  console.log(`  ${pc.dim("➜")}  ${pc.bold("Local:")}   ${pc.cyan(pc.underline(`http://localhost:${port}`))}`);
  console.log(`  ${pc.dim("➜")}  ${pc.bold("DB:")}      ${pc.dim(dbPath)}`);
  console.log();
  console.log("  Press Ctrl+C to stop.");
  console.log();
}

/**
 * Attempt to listen on the given port. If EADDRINUSE, prompt the user
 * for an alternative port and retry. Returns a promise that resolves
 * once the server is listening.
 */
function listenWithRetry(
  server: http.Server,
  port: number,
  dbPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        try {
          const newPort = await askPort(port);
          if (newPort === null) {
            console.log(pc.dim("  Cancelled.\n"));
            process.exit(0);
          }
          // Retry with the new port
          resolve(listenWithRetry(server, newPort, dbPath));
        } catch (promptErr) {
          reject(promptErr);
        }
      } else if (err.code === "EACCES") {
        errorBold(`Permission denied for port ${port}. Try a port above 1024.`);
        process.exit(1);
      } else {
        reject(err);
      }
    };

    server.once("error", onError);

    server.listen(port, () => {
      server.removeListener("error", onError);
      printBanner(port, dbPath);
      resolve();
    });
  });
}

export async function runServe(port: number): Promise<void> {
  const dbPath =
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db");

  if (!fs.existsSync(dbPath)) {
    console.log();
    errorBold(`No database found at ${pc.dim(dbPath)}`);
    console.log(
      pc.dim(`  Run megamemory in a project that has been used with the MCP server,\n`) +
      pc.dim(`  or set ${pc.cyan("MEGAMEMORY_DB_PATH")} environment variable.\n`)
    );
    process.exit(1);
  }

  const db = new KnowledgeDB(dbPath);
  let sseClients: http.ServerResponse[] = [];
  let lastKnownNodeIds = new Set<string>();
  let lastKnownNodeUpdates = new Map<string, string>(); // id → updated_at
  let lastKnownEdgeKeys = new Set<string>(); // "from|to|relation"

  function buildGraphPayload(): {
    nodes: Array<{
      id: string;
      name: string;
      kind: NodeRow["kind"];
      summary: string;
      parent_id: string | null;
      edge_count: number;
    }>;
    edges: Array<{
      from: string;
      to: string;
      relation: string;
      description: string | null;
    }>;
  } {
    const nodes = db.getAllActiveNodes().map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      summary: n.summary,
      parent_id: n.parent_id,
      edge_count: 0,
    }));

    const edges = db.getAllEdges().map((e) => ({
      from: e.from_id,
      to: e.to_id,
      relation: e.relation,
      description: e.description,
    }));

    const edgeCounts = new Map<string, number>();
    for (const e of edges) {
      edgeCounts.set(e.from, (edgeCounts.get(e.from) ?? 0) + 1);
      edgeCounts.set(e.to, (edgeCounts.get(e.to) ?? 0) + 1);
    }
    for (const n of nodes) {
      n.edge_count = edgeCounts.get(n.id) ?? 0;
    }

    return { nodes, edges };
  }

  function initializeSseSnapshot(): void {
    const nodes = db.getAllActiveNodes();
    const edges = db.getAllEdges();

    lastKnownNodeIds = new Set(nodes.map((n) => n.id));
    lastKnownNodeUpdates = new Map(nodes.map((n) => [n.id, n.updated_at]));
    lastKnownEdgeKeys = new Set(edges.map((e) => `${e.from_id}|${e.to_id}|${e.relation}`));
  }

  function broadcast(event: { type: string; data: unknown }): void {
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    sseClients = sseClients.filter((client) => {
      try {
        client.write(msg);
        return true;
      } catch {
        return false;
      }
    });
  }

  function detectChanges(): void {
    try {
      const nodes = db.getAllActiveNodes();
      const edges = db.getAllEdges();

      const currentNodeIds = new Set(nodes.map((n) => n.id));
      const currentNodeUpdates = new Map(nodes.map((n) => [n.id, n.updated_at]));
      const currentEdgeKeys = new Set(edges.map((e) => `${e.from_id}|${e.to_id}|${e.relation}`));

      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const edgeByKey = new Map(edges.map((e) => [`${e.from_id}|${e.to_id}|${e.relation}`, e]));

      const edgeCounts = new Map<string, number>();
      for (const e of edges) {
        edgeCounts.set(e.from_id, (edgeCounts.get(e.from_id) ?? 0) + 1);
        edgeCounts.set(e.to_id, (edgeCounts.get(e.to_id) ?? 0) + 1);
      }

      let hasChanges = false;

      for (const id of currentNodeIds) {
        if (!lastKnownNodeIds.has(id)) {
          const node = nodeById.get(id);
          if (!node) continue;
          broadcast({
            type: "node_added",
            data: {
              id: node.id,
              name: node.name,
              kind: node.kind,
              summary: node.summary,
              parent_id: node.parent_id,
              edge_count: edgeCounts.get(node.id) ?? 0,
            },
          });
          hasChanges = true;
        }
      }

      for (const [id, updatedAt] of currentNodeUpdates) {
        if (!lastKnownNodeIds.has(id)) continue;
        if ((lastKnownNodeUpdates.get(id) ?? "") !== updatedAt) {
          const node = nodeById.get(id);
          if (!node) continue;
          broadcast({
            type: "node_updated",
            data: {
              id: node.id,
              name: node.name,
              kind: node.kind,
              summary: node.summary,
            },
          });
          hasChanges = true;
        }
      }

      for (const id of lastKnownNodeIds) {
        if (!currentNodeIds.has(id)) {
          broadcast({ type: "node_removed", data: { id } });
          hasChanges = true;
        }
      }

      for (const key of currentEdgeKeys) {
        if (!lastKnownEdgeKeys.has(key)) {
          const edge = edgeByKey.get(key);
          if (!edge) continue;
          broadcast({
            type: "edge_added",
            data: {
              from: edge.from_id,
              to: edge.to_id,
              relation: edge.relation,
              description: edge.description,
            },
          });
          hasChanges = true;
        }
      }

      for (const key of lastKnownEdgeKeys) {
        if (!currentEdgeKeys.has(key)) {
          const [from, to, relation] = key.split("|");
          broadcast({
            type: "edge_removed",
            data: { from, to, relation },
          });
          hasChanges = true;
        }
      }

      lastKnownNodeIds = currentNodeIds;
      lastKnownNodeUpdates = currentNodeUpdates;
      lastKnownEdgeKeys = currentEdgeKeys;

      if (hasChanges) {
        const stats = db.getStats();
        const kinds = db.getKindsBreakdown();
        broadcast({
          type: "stats",
          data: {
            nodes: stats.nodes,
            edges: stats.edges,
            removed: stats.removed,
            kinds,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(pc.red(`  SSE change detection failed: ${message}`));
    }
  }

  const htmlPath = resolveHtmlPath();

  if (!fs.existsSync(htmlPath)) {
    console.log();
    errorBold(`HTML file not found at ${pc.dim(htmlPath)}`);
    console.log(pc.dim(`  This may indicate an incomplete installation. Try reinstalling megamemory.\n`));
    process.exit(1);
  }

  const htmlContent = fs.readFileSync(htmlPath, "utf-8").replaceAll("{{VERSION}}", VERSION);

  let embeddingsReady = false;
  let embeddingInitError: string | null = null;

  console.log(pc.dim("  Loading embedding model..."));
  try {
    await initializeEmbeddings();
    embeddingsReady = true;
    console.log(pc.dim("  Embedding model ready."));
  } catch (err) {
    embeddingInitError = err instanceof Error ? err.message : String(err);
    console.log(pc.yellow("  Warning: Embedding model failed to preload."));
    console.log(pc.dim("  Semantic search will retry on demand."));
  }

  const server = http.createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    // ---- Routes ----

    if (pathname === "/" && req.method === "GET") {
      html(res, htmlContent);
      return;
    }

    if (pathname === "/api/graph" && req.method === "GET") {
      const { nodes, edges } = buildGraphPayload();
      json(res, { nodes, edges });
      return;
    }

    if (pathname === "/api/search" && req.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      const rawTopK = Number.parseInt(url.searchParams.get("top_k") ?? "10", 10);
      const topK = Number.isFinite(rawTopK) ? Math.min(50, Math.max(1, rawTopK)) : 10;

      if (query.length === 0) {
        json(res, { matches: [] });
        return;
      }

      if (!embeddingsReady) {
        try {
          await initializeEmbeddings();
          embeddingsReady = true;
          embeddingInitError = null;
        } catch (err) {
          embeddingInitError = err instanceof Error ? err.message : String(err);
          json(
            res,
            {
              error: "Semantic search is temporarily unavailable",
              detail: embeddingInitError,
            },
            503,
          );
          return;
        }
      }

      const results = await understand(db, { query, top_k: topK });
      json(res, results);
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

    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const { nodes, edges } = buildGraphPayload();
      const stats = db.getStats();
      const kinds = db.getKindsBreakdown();
      const initPayload = {
        nodes,
        edges,
        stats: {
          nodes: stats.nodes,
          edges: stats.edges,
          removed: stats.removed,
        },
        kinds,
      };
      res.write(`data: ${JSON.stringify({ type: "init", data: initPayload })}\n\n`);

      sseClients.push(res);

      req.on("close", () => {
        sseClients = sseClients.filter((client) => client !== res);
      });
      return;
    }

    notFound(res);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(pc.red(`  Web request failed: ${message}`));
      json(res, { error: "Internal server error" }, 500);
    });
  });

  initializeSseSnapshot();
  const pollInterval = setInterval(detectChanges, 1500);
  const heartbeatInterval = setInterval(() => {
    sseClients = sseClients.filter((client) => {
      try {
        client.write(": heartbeat\n\n");
        return true;
      } catch {
        return false;
      }
    });
  }, 30000);

  await listenWithRetry(server, port, dbPath);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log(pc.dim("\n  Shutting down...\n"));
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // noop
      }
    }
    server.close();
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // noop
      }
    }
    server.close();
    db.close();
    process.exit(0);
  });
}
