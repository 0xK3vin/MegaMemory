import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";

const TEST_TIMEOUT_MS = 30000;
const FRESH_OPEN_WORKERS = [1, 2, 3, 4];
const CONCURRENT_WRITERS = [1, 2, 3, 4];
const repoRoot = path.resolve(import.meta.dirname, "../..");
const workerScriptPath = path.resolve(
  import.meta.dirname,
  "helpers",
  "db-worker.ts"
);

interface WorkerPayload {
  mode: "fresh-open" | "writer" | "reader";
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

interface WorkerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown>;
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const tmpDir of tmpDirs.splice(0)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeTempDbPath(testName: string): string {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `megamemory-${testName}-`)
  );
  tmpDirs.push(tmpDir);
  return path.join(tmpDir, "knowledge.db");
}

async function waitUntil(timestamp: number): Promise<void> {
  const delay = timestamp - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function runWorkersWithSharedStart(
  dbPath: string,
  workers: WorkerPayload[],
  startAt: number
): Promise<WorkerResult[]> {
  const startSignalPath = path.join(path.dirname(dbPath), "start.signal");
  const readerReadyPath = path.join(path.dirname(dbPath), "reader.ready");
  const workerPromises = workers.map((worker) =>
    runWorker({
      ...worker,
      startAt,
      startSignalPath,
      readerReadyPath,
    })
  );

  await waitUntil(startAt);
  fs.writeFileSync(startSignalPath, `${startAt}\n`);

  return Promise.all(workerPromises);
}

function runWorker(payload: WorkerPayload): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerScriptPath, JSON.stringify(payload)],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            [
              `Worker failed for payload ${JSON.stringify(payload)}`,
              `exit code: ${code}, signal: ${signal}`,
              `stdout:\n${stdout || "<empty>"}`,
              `stderr:\n${stderr || "<empty>"}`,
            ].join("\n\n")
          )
        );
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `Worker produced no stdout for payload ${JSON.stringify(payload)}`
          )
        );
        return;
      }

      const lastLine = trimmed.split(/\r?\n/).at(-1);
      if (!lastLine) {
        reject(
          new Error(
            `Worker stdout missing result line for payload ${JSON.stringify(payload)}`
          )
        );
        return;
      }

      try {
        resolve({
          code,
          signal,
          stdout,
          stderr,
          parsed: JSON.parse(lastLine) as Record<string, unknown>,
        });
      } catch (error: unknown) {
        reject(
          new Error(
            [
              `Failed to parse worker stdout for payload ${JSON.stringify(payload)}`,
              `stdout:\n${stdout}`,
              `stderr:\n${stderr}`,
              error instanceof Error ? error.message : String(error),
            ].join("\n\n")
          )
        );
      }
    });
  });
}

function runIntegrityCheck(dbPath: string): string {
  const rawDb = new Database(dbPath);

  try {
    const row = rawDb
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check?: string } | undefined;
    return row?.integrity_check ?? "";
  } finally {
    rawDb.close();
  }
}

describe.sequential("KnowledgeDB multi-process concurrency", () => {
  it(
    "smokes concurrent fresh open and migration on a shared WAL database",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const dbPath = makeTempDbPath("fresh-open");
      const startAt = Date.now() + 250;

      const workerResults = await runWorkersWithSharedStart(
        dbPath,
        FRESH_OPEN_WORKERS.map((workerId) => ({
          mode: "fresh-open",
          dbPath,
          workerId,
        })),
        startAt
      );

      expect(workerResults).toHaveLength(FRESH_OPEN_WORKERS.length);

      const db = new KnowledgeDB(dbPath);
      try {
        const stats = db.getStats();
        const nodeIds = db.getAllActiveNodes().map((node) => node.id).sort();

        expect(stats).toEqual({
          nodes: FRESH_OPEN_WORKERS.length,
          edges: 0,
          removed: 0,
        });
        expect(nodeIds).toEqual(
          FRESH_OPEN_WORKERS.map((workerId) => `fresh-worker-${workerId}`).sort()
        );
      } finally {
        db.close();
      }

      const reopened = new KnowledgeDB(dbPath);
      try {
        expect(reopened.getStats().nodes).toBe(FRESH_OPEN_WORKERS.length);
      } finally {
        reopened.close();
      }

      expect(runIntegrityCheck(dbPath)).toBe("ok");
    }
  );

  it(
    "smokes concurrent writers and a reader on a shared WAL database",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const dbPath = makeTempDbPath("writers-reader");
      const anchorId = "anchor-node";
      const seedDb = new KnowledgeDB(dbPath);

      try {
        seedDb.insertNode({
          id: anchorId,
          name: "Anchor Node",
          kind: "module",
          summary: "Anchor for concurrent edge creation",
          why: null,
          file_refs: null,
          parent_id: null,
          created_by_task: "db-concurrency-seed",
          embedding: null,
        });
      } finally {
        seedDb.close();
      }

      const startAt = Date.now() + 250;
      const [readerResult, ...writerResults] = await runWorkersWithSharedStart(
        dbPath,
        [
          {
            mode: "reader",
            dbPath,
            workerId: 99,
            anchorId,
            iterations: 60,
            sleepMs: 20,
          },
          ...CONCURRENT_WRITERS.map((workerId) => ({
            mode: "writer",
            dbPath,
            workerId,
            anchorId,
            preWriteSleepMs: workerId * 60,
          })),
        ],
        startAt
      );

      expect(readerResult.parsed.iterations).toBe(60);
      expect(readerResult.parsed.firstNodes).toBe(1);
      expect(readerResult.parsed.firstEdges).toBe(0);
      expect(readerResult.parsed.lastNodes).toBe(1 + CONCURRENT_WRITERS.length);
      expect(readerResult.parsed.lastEdges).toBe(CONCURRENT_WRITERS.length);
      expect(readerResult.parsed.maxNodes).toBe(1 + CONCURRENT_WRITERS.length);
      expect(readerResult.parsed.maxEdges).toBe(CONCURRENT_WRITERS.length);
      expect(readerResult.parsed.growthSamples).toBeGreaterThan(0);
      expect(readerResult.parsed.distinctStateCount).toBeGreaterThan(1);
      expect(writerResults).toHaveLength(CONCURRENT_WRITERS.length);

      const writerNodeIds = writerResults
        .map((result) => result.parsed.nodeId)
        .sort() as string[];
      expect(writerNodeIds).toEqual(
        CONCURRENT_WRITERS.map((workerId) => `writer-node-${workerId}`).sort()
      );
      for (const writerResult of writerResults) {
        expect(writerResult.parsed.outgoingEdges).toBe(1);
      }

      const db = new KnowledgeDB(dbPath);
      try {
        const stats = db.getStats();
        const incomingAnchorEdges = db.getIncomingEdges(anchorId);
        const activeNodeIds = db.getAllActiveNodes().map((node) => node.id).sort();

        expect(stats).toEqual({
          nodes: 1 + CONCURRENT_WRITERS.length,
          edges: CONCURRENT_WRITERS.length,
          removed: 0,
        });
        expect(incomingAnchorEdges).toHaveLength(CONCURRENT_WRITERS.length);
        expect(activeNodeIds).toEqual(
          [anchorId, ...CONCURRENT_WRITERS.map((workerId) => `writer-node-${workerId}`)].sort()
        );
      } finally {
        db.close();
      }

      expect(runIntegrityCheck(dbPath)).toBe("ok");
    }
  );
});
