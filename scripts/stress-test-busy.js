#!/usr/bin/env node

/**
 * Focused stress test to trigger SQLITE_BUSY
 * Uses long-running transactions to hold write locks beyond busy_timeout
 */

import { fork } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const NUM_WORKERS = 10;
const ITERATIONS_PER_WORKER = 50;
const TEST_DIR = `/tmp/megamemory-busy-test-${Date.now()}`;
const DB_PATH = path.join(TEST_DIR, "knowledge.db");

async function main() {
  console.log("=".repeat(70));
  console.log("  SQLITE_BUSY TRIGGER TEST");
  console.log("=".repeat(70));
  console.log(`Workers: ${NUM_WORKERS}, Iterations: ${ITERATIONS_PER_WORKER}`);
  console.log(`DB: ${DB_PATH}`);
  console.log();

  mkdirSync(TEST_DIR, { recursive: true });
  
  const { KnowledgeDB } = await import(path.join(PROJECT_ROOT, "dist", "db.js"));
  const initDb = new KnowledgeDB(DB_PATH);
  for (let i = 0; i < 50; i++) {
    initDb.insertNode({
      id: `seed-${i}`,
      name: `Seed ${i}`,
      kind: "feature",
      summary: `Seed node ${i}`,
    });
  }
  for (let i = 0; i < 49; i++) {
    initDb.insertEdge({ from_id: `seed-${i}`, to_id: `seed-${i+1}`, relation: "depends_on" });
  }
  initDb.close();

  const barrierPath = path.join(TEST_DIR, "barrier");
  
  const workerPromises = [];
  for (let w = 0; w < NUM_WORKERS; w++) {
    workerPromises.push(new Promise((resolve) => {
      const child = fork(
        fileURLToPath(import.meta.url),
        ["--worker", String(w), DB_PATH, String(ITERATIONS_PER_WORKER), barrierPath],
        { cwd: PROJECT_ROOT, stdio: ["pipe", "pipe", "pipe", "ipc"] }
      );
      let result = null;
      child.on("message", (msg) => { result = msg; });
      child.on("exit", () => {
        resolve(result || { workerId: w, busyErrors: 0, otherErrors: 1, txnErrors: 0, ops: 0, errorDetails: [] });
      });
    }));
  }

  await new Promise(r => setTimeout(r, 600));
  writeFileSync(barrierPath, "GO");
  console.log("Barrier released!");

  const results = await Promise.all(workerPromises);

  let totalBusy = 0, totalOther = 0, totalTxn = 0, totalOps = 0;
  const allErrors = [];
  for (const r of results) {
    console.log(`  W${r.workerId}: ${r.ops} ops, ${r.busyErrors} BUSY, ${r.txnErrors} txn-errors, ${r.otherErrors} other`);
    totalBusy += r.busyErrors;
    totalOther += r.otherErrors;
    totalTxn += r.txnErrors || 0;
    totalOps += r.ops;
    allErrors.push(...(r.errorDetails || []));
  }

  console.log();
  console.log(`Total: ${totalOps} ops, ${totalBusy} BUSY, ${totalTxn} txn-errors, ${totalOther} other`);
  
  if (allErrors.length > 0) {
    const grouped = {};
    for (const e of allErrors) {
      const key = e.message.slice(0, 80);
      grouped[key] = (grouped[key] || 0) + 1;
    }
    console.log("\nError breakdown:");
    for (const [msg, count] of Object.entries(grouped).sort((a,b) => b[1] - a[1])) {
      console.log(`  [${count}x] ${msg}`);
    }
  }

  rmSync(TEST_DIR, { recursive: true, force: true });
}

async function workerMain() {
  const workerId = parseInt(process.argv[3]);
  const dbPath = process.argv[4];
  const iterations = parseInt(process.argv[5]);
  const barrierPath = process.argv[6];

  const { KnowledgeDB } = await import(path.join(PROJECT_ROOT, "dist", "db.js"));
  const db = new KnowledgeDB(dbPath);

  while (!existsSync(barrierPath)) {
    await new Promise(r => setTimeout(r, 5));
  }

  const stats = {
    workerId,
    ops: 0,
    busyErrors: 0,
    otherErrors: 0,
    txnErrors: 0,
    errorDetails: [],
  };

  const KINDS = ["feature", "module", "pattern", "config"];
  const RELATIONS = ["connects_to", "depends_on", "implements"];

  function trackError(op, err) {
    const msg = err.message || String(err);
    if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      stats.busyErrors++;
    } else if (msg.includes("cannot start a transaction within a transaction")) {
      stats.txnErrors++;
    } else {
      stats.otherErrors++;
    }
    stats.errorDetails.push({ worker: workerId, op, message: msg.slice(0, 200) });
  }

  for (let i = 0; i < iterations; i++) {
    const roll = Math.random();

    if (roll < 0.40) {
      // Heavy transactional operation — insertNodeAndEdges holds BEGIN IMMEDIATE
      // Each one creates node + 3-5 edges all in one transaction
      try {
        const nodeId = `w${workerId}-${i}-${Math.random().toString(36).slice(2,6)}`;
        const edges = [];
        for (let e = 0; e < 3 + Math.floor(Math.random() * 3); e++) {
          edges.push({
            to_id: `seed-${Math.floor(Math.random() * 50)}`,
            relation: RELATIONS[Math.floor(Math.random() * RELATIONS.length)],
            description: null,
          });
        }
        db.insertNodeAndEdges(
          { id: nodeId, name: `N${nodeId}`, kind: KINDS[i % 4], summary: `tx node`, why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null },
          edges
        );
        stats.ops++;
      } catch (err) {
        trackError("insertNodeAndEdges", err);
        stats.ops++;
      }
    } else if (roll < 0.65) {
      // softDeleteNode — non-atomic multi-statement
      try {
        db.softDeleteNode(`seed-${Math.floor(Math.random() * 50)}`, `w${workerId} delete`);
        stats.ops++;
      } catch (err) {
        trackError("softDeleteNode", err);
        stats.ops++;
      }
    } else if (roll < 0.80) {
      // Timeline write  
      try {
        db.insertTimelineEntry({
          tool: "stress",
          params: JSON.stringify({w: workerId}),
          result_summary: "x".repeat(200),
          is_write: true,
          is_error: false,
          affected_ids: Array.from({length: 5}, (_, j) => `seed-${j}`),
        });
        stats.ops++;
      } catch (err) {
        trackError("timeline", err);
        stats.ops++;
      }
    } else {
      // Read — getStats (multi-statement read)
      try {
        db.getStats();
        db.getAllActiveNodes();
        stats.ops++;
      } catch (err) {
        trackError("read", err);
        stats.ops++;
      }
    }
  }

  try { db.close(); } catch (_) {}
  process.send(stats);
  process.exit(0);
}

if (process.argv.includes("--worker")) {
  workerMain().catch(err => { console.error(err); process.exit(1); });
} else {
  main().catch(err => { console.error(err); process.exit(1); });
}
