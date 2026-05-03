import fs from "fs";
import { KnowledgeDB } from "../../db.js";

type WorkerMode = "fresh-open" | "writer" | "reader";

interface WorkerPayload {
  mode: WorkerMode;
  dbPath: string;
  workerId: number;
  startAt?: number;
  startSignalPath?: string;
  readerReadyPath?: string;
  anchorId?: string;
  iterations?: number;
  sleepMs?: number;
  preWriteSleepMs?: number;
}

const START_SIGNAL_TIMEOUT_MS = 5000;
const OPEN_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(timestamp?: number): Promise<void> {
  if (!timestamp) return;
  const delay = timestamp - Date.now();
  if (delay > 0) {
    await sleep(delay);
  }
}

async function waitForStart(payload: WorkerPayload): Promise<void> {
  await waitUntil(payload.startAt);

  if (!payload.startSignalPath) {
    return;
  }

  const deadline = Date.now() + START_SIGNAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      if (fs.existsSync(payload.startSignalPath)) {
        return;
      }
    } catch {
      // Ignore transient filesystem errors while polling.
    }

    await sleep(10);
  }

  throw new Error(
    `timed out waiting for start signal ${payload.startSignalPath}`
  );
}

async function waitForSignalFile(
  filePath: string | undefined,
  label: string
): Promise<void> {
  if (!filePath) {
    return;
  }

  const deadline = Date.now() + START_SIGNAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      if (fs.existsSync(filePath)) {
        return;
      }
    } catch {
      // Ignore transient filesystem errors while polling.
    }

    await sleep(10);
  }

  throw new Error(`timed out waiting for ${label} signal ${filePath}`);
}

function isLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("SQLITE_BUSY") ||
    message.includes("database is locked") ||
    message.includes("database schema is locked")
  );
}

async function openDbWithRetry(dbPath: string): Promise<KnowledgeDB> {
  let lastError: unknown;

  for (const delayMs of [0, ...OPEN_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return new KnowledgeDB(dbPath);
    } catch (error: unknown) {
      if (!isLockedError(error)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function run(payload: WorkerPayload): Promise<Record<string, unknown>> {
  await waitForStart(payload);
  const db = await openDbWithRetry(payload.dbPath);

  try {
    if (payload.mode === "fresh-open") {
      const nodeId = `fresh-worker-${payload.workerId}`;
      db.insertNode({
        id: nodeId,
        name: `Fresh Worker ${payload.workerId}`,
        kind: "feature",
        summary: `Fresh open worker ${payload.workerId}`,
        why: null,
        file_refs: null,
        parent_id: null,
        created_by_task: "db-concurrency-fresh-open",
        embedding: null,
      });

      return { mode: payload.mode, workerId: payload.workerId, nodeId };
    }

    if (payload.mode === "writer") {
      if (!payload.anchorId) {
        throw new Error("writer mode requires anchorId");
      }

      await waitForSignalFile(payload.readerReadyPath, "reader-ready");

      if ((payload.preWriteSleepMs ?? 0) > 0) {
        await sleep(payload.preWriteSleepMs ?? 0);
      }

      const nodeId = `writer-node-${payload.workerId}`;
      db.insertNodeAndEdges(
        {
          id: nodeId,
          name: `Writer Node ${payload.workerId}`,
          kind: "feature",
          summary: `Concurrent writer ${payload.workerId}`,
          why: null,
          file_refs: JSON.stringify([
            `src/__tests__/db.concurrency.test.ts#writer-${payload.workerId}`,
          ]),
          parent_id: null,
          created_by_task: "db-concurrency-writer",
          embedding: null,
        },
        [
          {
            to_id: payload.anchorId,
            relation: "depends_on",
            description: `writer ${payload.workerId} links to anchor`,
          },
        ]
      );

      return {
        mode: payload.mode,
        workerId: payload.workerId,
        nodeId,
        outgoingEdges: db.getOutgoingEdges(nodeId).length,
      };
    }

    if (!payload.anchorId) {
      throw new Error("reader mode requires anchorId");
    }

    const iterations = payload.iterations ?? 40;
    const sleepMs = payload.sleepMs ?? 20;
    let maxNodes = 0;
    let maxEdges = 0;
    let firstNodes: number | null = null;
    let firstEdges: number | null = null;
    let lastNodes = 0;
    let lastEdges = 0;
    let growthSamples = 0;
    const observedStates = new Set<string>();

    const recordSnapshot = (): void => {
      const anchor = db.getNode(payload.anchorId!);
      if (!anchor) {
        throw new Error(`anchor node ${payload.anchorId} missing during read`);
      }

      const stats = db.getStats();
      const nodes = db.getAllActiveNodes();
      const edges = db.getAllEdges();
      const incoming = db.getIncomingEdges(payload.anchorId!);
      const outgoing = db.getOutgoingEdges(payload.anchorId!);

      if (stats.nodes < 1) {
        throw new Error("reader observed invalid empty active graph");
      }

      const nodeCount = Math.max(nodes.length, stats.nodes);
      const edgeCount = Math.max(edges.length, incoming.length, outgoing.length);

      if (firstNodes === null) {
        firstNodes = nodeCount;
        firstEdges = edgeCount;
      } else if (nodeCount > lastNodes || edgeCount > lastEdges) {
        growthSamples += 1;
      }

      lastNodes = nodeCount;
      lastEdges = edgeCount;
      maxNodes = Math.max(maxNodes, nodeCount);
      maxEdges = Math.max(maxEdges, edgeCount);
      observedStates.add(`${nodeCount}:${edgeCount}`);
    };

    recordSnapshot();

    if (payload.readerReadyPath) {
      fs.writeFileSync(payload.readerReadyPath, `${payload.workerId}\n`);
    }

    for (let i = 1; i < iterations; i++) {
      await sleep(sleepMs);
      recordSnapshot();
    }

    return {
      mode: payload.mode,
      workerId: payload.workerId,
      iterations,
      firstNodes,
      firstEdges,
      lastNodes,
      lastEdges,
      maxNodes,
      maxEdges,
      growthSamples,
      distinctStateCount: observedStates.size,
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const rawPayload = process.argv[2];
  if (!rawPayload) {
    throw new Error("missing worker payload");
  }

  const payload = JSON.parse(rawPayload) as WorkerPayload;
  const result = await run(payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
