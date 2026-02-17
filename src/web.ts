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

  function parseBooleanParam(value: string | null): boolean {
    return value === "true" || value === "1";
  }

  function clampInt(value: string | null, defaultValue: number, min: number, max: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(max, Math.max(min, parsed));
  }

  function safeJsonParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  type TimelineEntryView = {
    seq: number;
    timestamp: string;
    tool: string;
    params?: unknown;
    result_summary: string;
    is_write: boolean;
    is_error: boolean;
    affected_ids: string[];
  };

  type TimelineQueryOptions = {
    writesOnly?: boolean;
    tool?: string;
    since?: string;
    until?: string;
    limit?: number;
  };

  function parseAffectedIds(raw: string): string[] {
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  }

  function buildNodeTimestampEntries(): TimelineEntryView[] {
    const staged: Array<{
      timestamp: string;
      tool: string;
      params?: unknown;
      result_summary: string;
      is_write: boolean;
      is_error: boolean;
      affected_ids: string[];
      order: number;
    }> = [];

    const nodes = db.getAllNodesRaw();
    for (const node of nodes) {
      if (node.created_at) {
        staged.push({
          timestamp: node.created_at,
          tool: "create_concept",
          params: { id: node.id, kind: node.kind, parent_id: node.parent_id },
          result_summary: `created ${node.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [node.id],
          order: 0,
        });
      }

      if (node.updated_at && node.updated_at !== node.created_at) {
        staged.push({
          timestamp: node.updated_at,
          tool: "update_concept",
          params: { id: node.id },
          result_summary: `updated ${node.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [node.id],
          order: 1,
        });
      }

      if (node.removed_at) {
        staged.push({
          timestamp: node.removed_at,
          tool: "remove_concept",
          params: { id: node.id },
          result_summary: `removed ${node.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [node.id],
          order: 2,
        });
      }
    }

    staged.sort((a, b) => {
      const timestampCmp = a.timestamp.localeCompare(b.timestamp);
      if (timestampCmp !== 0) return timestampCmp;
      const orderCmp = a.order - b.order;
      if (orderCmp !== 0) return orderCmp;
      return (a.affected_ids[0] ?? "").localeCompare(b.affected_ids[0] ?? "");
    });

    return staged.map((entry, index) => ({
      seq: index + 1,
      timestamp: entry.timestamp,
      tool: entry.tool,
      params: entry.params,
      result_summary: entry.result_summary,
      is_write: entry.is_write,
      is_error: entry.is_error,
      affected_ids: entry.affected_ids,
    }));
  }

  function buildMergedTimelineEntries(options: TimelineQueryOptions = {}): {
    entries: TimelineEntryView[];
    source: "merged" | "timeline" | "node_timestamps";
  } {
    const syntheticEntries = buildNodeTimestampEntries()
      .filter((entry) => !options.tool || entry.tool === options.tool)
      .filter((entry) => !options.since || entry.timestamp >= options.since)
      .filter((entry) => !options.until || entry.timestamp <= options.until);

    const bounds = db.getTimelineBounds();
    const realEntries = bounds.count > 0
      ? db.getTimelineEntries({
          writesOnly: options.writesOnly,
          tool: options.tool,
          since: options.since,
          until: options.until,
        }).map((row) => ({
          seq: row.seq,
          timestamp: row.timestamp,
          tool: row.tool,
          params: safeJsonParse(row.params),
          result_summary: row.result_summary,
          is_write: row.is_write === 1,
          is_error: row.is_error === 1,
          affected_ids: parseAffectedIds(row.affected_ids),
        }))
      : [];

    const realCreateIds = new Set<string>();
    const realUpdateIds = new Set<string>();
    const realRemoveIds = new Set<string>();
    for (const entry of realEntries) {
      if (entry.tool === "create_concept") {
        for (const id of entry.affected_ids) realCreateIds.add(id);
      } else if (entry.tool === "update_concept") {
        for (const id of entry.affected_ids) realUpdateIds.add(id);
      } else if (entry.tool === "remove_concept") {
        for (const id of entry.affected_ids) realRemoveIds.add(id);
      }
    }

    const dedupedSyntheticEntries = syntheticEntries
      .filter((entry) => !options.writesOnly || entry.is_write)
      .filter((entry) => {
        const id = entry.affected_ids[0];
        if (!id) return true;
        if (entry.tool === "create_concept") return !realCreateIds.has(id);
        if (entry.tool === "update_concept") return !realUpdateIds.has(id);
        if (entry.tool === "remove_concept") return !realRemoveIds.has(id);
        return true;
      });

    const merged = [...realEntries, ...dedupedSyntheticEntries]
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => {
        const timestampCmp = a.entry.timestamp.localeCompare(b.entry.timestamp);
        if (timestampCmp !== 0) return timestampCmp;
        return a.idx - b.idx;
      })
      .map(({ entry }, idx) => ({
        ...entry,
        seq: idx + 1,
      }));

    const limited = typeof options.limit === "number" ? merged.slice(0, options.limit) : merged;

    const source = realEntries.length > 0 && dedupedSyntheticEntries.length > 0
      ? "merged"
      : realEntries.length > 0
      ? "timeline"
      : "node_timestamps";

    return { entries: limited, source };
  }

  function sampleEntries<T>(entries: T[], n: number): T[] {
    if (entries.length <= n) return entries;
    if (n <= 1) return [entries[0]];

    const sampled: T[] = [];
    const maxIndex = entries.length - 1;
    const step = maxIndex / (n - 1);
    const seen = new Set<number>();

    for (let i = 0; i < n; i += 1) {
      const index = i === n - 1 ? maxIndex : Math.round(i * step);
      if (seen.has(index)) continue;
      seen.add(index);
      sampled.push(entries[index]);
    }

    return sampled;
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

    if (pathname === "/api/timeline/bounds" && req.method === "GET") {
      const merged = buildMergedTimelineEntries();
      if (merged.entries.length > 0) {
        json(res, {
          first: merged.entries[0].timestamp,
          last: merged.entries[merged.entries.length - 1].timestamp,
          count: merged.entries.length,
          source: merged.source,
        });
        return;
      }

      json(res, { first: null, last: null, count: 0, source: "none" as const });
      return;
    }

    if (pathname === "/api/timeline/ticks" && req.method === "GET") {
      const n = clampInt(url.searchParams.get("n"), 100, 1, 500);
      const merged = buildMergedTimelineEntries();
      const ticks = sampleEntries(merged.entries, n).map((row) => ({
        seq: row.seq,
        timestamp: row.timestamp,
        tool: row.tool,
        result_summary: row.result_summary,
      }));
      json(res, { ticks, source: merged.source });
      return;
    }

    if (pathname === "/api/timeline" && req.method === "GET") {
      const writesOnly = parseBooleanParam(url.searchParams.get("writes_only"));
      const tool = (url.searchParams.get("tool") ?? "").trim();
      const since = (url.searchParams.get("since") ?? "").trim();
      const until = (url.searchParams.get("until") ?? "").trim();
      const limit = clampInt(url.searchParams.get("limit"), 1000, 1, 50000);
      const { entries, source } = buildMergedTimelineEntries({
        writesOnly,
        tool: tool || undefined,
        since: since || undefined,
        until: until || undefined,
        limit,
      });

      json(res, { entries, source });
      return;
    }

    if (pathname === "/api/graph/at" && req.method === "GET") {
      const t = (url.searchParams.get("t") ?? "").trim();
      if (!t) {
        json(res, { error: "Missing required query parameter: t" }, 400);
        return;
      }

      const nodes = db.getNodesAtTime(t).map((n) => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
        summary: n.summary,
        parent_id: n.parent_id,
        edge_count: 0,
      }));

      const edges = db.getEdgesAtTime(t).map((e) => ({
        from: e.from_id,
        to: e.to_id,
        relation: e.relation,
        description: e.description,
      }));

      const edgeCounts = new Map<string, number>();
      for (const edge of edges) {
        edgeCounts.set(edge.from, (edgeCounts.get(edge.from) ?? 0) + 1);
        edgeCounts.set(edge.to, (edgeCounts.get(edge.to) ?? 0) + 1);
      }
      for (const node of nodes) {
        node.edge_count = edgeCounts.get(node.id) ?? 0;
      }

      json(res, { nodes, edges });
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
