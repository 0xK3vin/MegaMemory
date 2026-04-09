#!/usr/bin/env node

/**
 * Stress test for megamemory SQLite concurrency issues (GitHub #8)
 * 
 * Spawns multiple child processes that all hammer the same database file
 * with concurrent reads and writes to reproduce:
 * 1. SQLITE_BUSY errors (1000ms busy_timeout too short)
 * 2. Inconsistent state from non-atomic softDeleteNode / hardDeleteNode
 * 3. PRAGMA integrity_check failures
 * 4. Orphaned edges pointing to deleted/soft-deleted nodes
 */

import { fork } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ============ Configuration ============
const NUM_WORKERS = 8;
const ITERATIONS_PER_WORKER = 200;
const TEST_DIR = `/tmp/megamemory-stress-test-${Date.now()}`;
const DB_PATH = path.join(TEST_DIR, "knowledge.db");

// ============ Main orchestrator ============

async function main() {
  console.log("=".repeat(70));
  console.log("  MEGAMEMORY CONCURRENCY STRESS TEST");
  console.log("=".repeat(70));
  console.log(`Workers:       ${NUM_WORKERS}`);
  console.log(`Iterations:    ${ITERATIONS_PER_WORKER} per worker`);
  console.log(`Database:      ${DB_PATH}`);
  console.log(`Test dir:      ${TEST_DIR}`);
  console.log();

  // Create test directory and initialize the database schema
  mkdirSync(TEST_DIR, { recursive: true });
  
  const { KnowledgeDB } = await import(path.join(PROJECT_ROOT, "dist", "db.js"));
  const initDb = new KnowledgeDB(DB_PATH);
  
  // Seed nodes so workers all contend on the same targets
  const SEED_COUNT = 30;
  for (let i = 0; i < SEED_COUNT; i++) {
    initDb.insertNode({
      id: `seed-${i}`,
      name: `Seed Node ${i}`,
      kind: "feature",
      summary: `Seed node #${i} for stress testing`,
    });
  }
  // Seed edges forming a chain + cross-links
  for (let i = 0; i < SEED_COUNT - 1; i++) {
    initDb.insertEdge({
      from_id: `seed-${i}`,
      to_id: `seed-${i + 1}`,
      relation: "depends_on",
      description: "seed chain edge",
    });
  }
  for (let i = 0; i < 15; i++) {
    const a = Math.floor(Math.random() * SEED_COUNT);
    let b = Math.floor(Math.random() * SEED_COUNT);
    if (b === a) b = (a + 1) % SEED_COUNT;
    try {
      initDb.insertEdge({
        from_id: `seed-${a}`,
        to_id: `seed-${b}`,
        relation: "connects_to",
        description: "seed cross edge",
      });
    } catch (_) {}
  }
  
  const seedStats = initDb.getStats();
  console.log(`Seeded: ${seedStats.nodes} nodes, ${seedStats.edges} edges`);
  initDb.close();
  console.log();

  // Use a barrier file so all workers start their hot loops simultaneously
  const barrierPath = path.join(TEST_DIR, "barrier");
  
  // Spawn workers
  console.log(`Spawning ${NUM_WORKERS} worker processes...`);
  const startTime = Date.now();
  
  const workerPromises = [];
  for (let w = 0; w < NUM_WORKERS; w++) {
    workerPromises.push(runWorker(w, barrierPath));
  }

  // Give workers 500ms to start up and open DB connections, then signal go
  await new Promise(r => setTimeout(r, 500));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(barrierPath, "GO");
  console.log(`Barrier released! All workers starting simultaneously...`);

  const results = await Promise.all(workerPromises);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  // Aggregate results
  console.log();
  console.log("=".repeat(70));
  console.log("  WORKER RESULTS");
  console.log("=".repeat(70));
  
  let totalBusyErrors = 0;
  let totalOtherErrors = 0;
  let totalOps = 0;
  let totalInserts = 0;
  let totalEdgeInserts = 0;
  let totalSoftDeletes = 0;
  let totalHardDeletes = 0;
  let totalReads = 0;
  let totalTimelineWrites = 0;
  let totalTransactionalOps = 0;
  const allErrors = [];

  for (const r of results) {
    console.log(`  Worker ${r.workerId}: ${r.ops} ops, ${r.busyErrors} BUSY, ${r.otherErrors} other errors (${r.softDeletes} soft-del, ${r.hardDeletes} hard-del)`);
    totalBusyErrors += r.busyErrors;
    totalOtherErrors += r.otherErrors;
    totalOps += r.ops;
    totalInserts += r.inserts;
    totalEdgeInserts += r.edgeInserts;
    totalSoftDeletes += r.softDeletes;
    totalHardDeletes += r.hardDeletes;
    totalReads += r.reads;
    totalTimelineWrites += r.timelineWrites;
    totalTransactionalOps += r.transactionalOps || 0;
    allErrors.push(...r.errorDetails);
  }

  console.log();
  console.log(`  Total operations:      ${totalOps}`);
  console.log(`  Node inserts:          ${totalInserts}`);
  console.log(`  Edge inserts:          ${totalEdgeInserts}`);
  console.log(`  Soft deletes:          ${totalSoftDeletes}`);
  console.log(`  Hard deletes:          ${totalHardDeletes}`);
  console.log(`  Transactional inserts: ${totalTransactionalOps}`);
  console.log(`  Reads:                 ${totalReads}`);
  console.log(`  Timeline writes:       ${totalTimelineWrites}`);
  console.log(`  SQLITE_BUSY errors:    ${totalBusyErrors}`);
  console.log(`  Other errors:          ${totalOtherErrors}`);
  console.log(`  Elapsed:               ${elapsed}s`);

  if (allErrors.length > 0) {
    console.log();
    console.log("  --- Error samples (up to 30) ---");
    // Group errors by type
    const errorCounts = {};
    for (const e of allErrors) {
      const key = `${e.op}: ${e.message}`;
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    const sorted = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]);
    for (const [msg, count] of sorted.slice(0, 30)) {
      console.log(`  [${count}x] ${msg}`);
    }
  }

  // ============ Post-mortem analysis ============
  console.log();
  console.log("=".repeat(70));
  console.log("  POST-MORTEM ANALYSIS");
  console.log("=".repeat(70));

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // 1. PRAGMA integrity_check
  console.log();
  const integrityResult = db.pragma("integrity_check");
  const integrityOk = Array.isArray(integrityResult)
    ? integrityResult.every(r => {
        const val = typeof r === "object" ? Object.values(r)[0] : r;
        return val === "ok";
      })
    : integrityResult === "ok";
  console.log(`  PRAGMA integrity_check: ${integrityOk ? "✅ PASS" : "❌ FAIL"}`);
  if (!integrityOk) {
    console.log(`  Details: ${JSON.stringify(integrityResult)}`);
  }

  // 2. Foreign key check
  const fkViolations = db.pragma("foreign_key_check");
  const fkClean = !fkViolations || (Array.isArray(fkViolations) && fkViolations.length === 0);
  console.log(`  PRAGMA foreign_key_check: ${fkClean ? "✅ PASS" : "❌ FAIL — " + (Array.isArray(fkViolations) ? fkViolations.length : "?") + " violations"}`);
  if (!fkClean && Array.isArray(fkViolations)) {
    const samples = fkViolations.slice(0, 10);
    for (const v of samples) {
      console.log(`    ${JSON.stringify(v)}`);
    }
    if (fkViolations.length > 10) {
      console.log(`    ... and ${fkViolations.length - 10} more`);
    }
  }

  // 3. Orphaned edges — edges pointing to non-existent node IDs (hard-delete race)
  const orphanedEdges = db.prepare(`
    SELECT e.* FROM edges e
    LEFT JOIN nodes n1 ON e.from_id = n1.id
    LEFT JOIN nodes n2 ON e.to_id = n2.id
    WHERE n1.id IS NULL OR n2.id IS NULL
  `).all();
  console.log(`  Orphaned edges (missing node): ${orphanedEdges.length === 0 ? "✅ 0" : "❌ " + orphanedEdges.length + " (hardDeleteNode race condition)"}`);
  if (orphanedEdges.length > 0) {
    const samples = orphanedEdges.slice(0, 10);
    for (const e of samples) {
      console.log(`    edge ${e.id}: ${e.from_id} → ${e.to_id} (${e.relation})`);
    }
    if (orphanedEdges.length > 10) {
      console.log(`    ... and ${orphanedEdges.length - 10} more`);
    }
  }

  // 4. Edges pointing to soft-deleted nodes (softDeleteNode race condition)
  const edgesToDeleted = db.prepare(`
    SELECT e.*, 
      n1.removed_at as from_removed, 
      n2.removed_at as to_removed
    FROM edges e
    JOIN nodes n1 ON e.from_id = n1.id
    JOIN nodes n2 ON e.to_id = n2.id
    WHERE n1.removed_at IS NOT NULL OR n2.removed_at IS NOT NULL
  `).all();
  console.log(`  Edges to/from soft-deleted nodes: ${edgesToDeleted.length === 0 ? "✅ 0" : "⚠️  " + edgesToDeleted.length + " (INCONSISTENT — softDeleteNode race)"}`);
  if (edgesToDeleted.length > 0) {
    const samples = edgesToDeleted.slice(0, 10);
    for (const e of samples) {
      const fromDel = e.from_removed ? `from_removed=${e.from_removed}` : "";
      const toDel = e.to_removed ? `to_removed=${e.to_removed}` : "";
      console.log(`    edge ${e.id}: ${e.from_id} → ${e.to_id} (${e.relation}) ${fromDel} ${toDel}`);
    }
    if (edgesToDeleted.length > 10) {
      console.log(`    ... and ${edgesToDeleted.length - 10} more`);
    }
  }

  // 5. Soft-deleted nodes that still have edges (THE SPECIFIC BUG)
  // This catches the case where UPDATE succeeded but DELETE edges didn't run
  const softDeletedWithEdges = db.prepare(`
    SELECT n.id, n.name, n.removed_at, COUNT(e.id) as edge_count
    FROM nodes n
    JOIN edges e ON (e.from_id = n.id OR e.to_id = n.id)
    WHERE n.removed_at IS NOT NULL
    GROUP BY n.id
  `).all();
  console.log(`  Soft-deleted nodes still having edges: ${softDeletedWithEdges.length === 0 ? "✅ 0" : "❌ " + softDeletedWithEdges.length + " (NON-ATOMIC softDeleteNode confirmed!)"}`);
  if (softDeletedWithEdges.length > 0) {
    for (const n of softDeletedWithEdges.slice(0, 10)) {
      console.log(`    ${n.id}: removed_at=${n.removed_at}, still has ${n.edge_count} edge(s)`);
    }
  }

  // 6. Final counts
  const finalNodes = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE removed_at IS NULL").get();
  const finalRemoved = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE removed_at IS NOT NULL").get();
  const finalEdges = db.prepare("SELECT COUNT(*) as c FROM edges").get();
  const finalTimeline = db.prepare("SELECT COUNT(*) as c FROM timeline").get();
  
  // Count edges that SHOULD have been deleted but weren't
  const edgesShouldBeDeleted = db.prepare(`
    SELECT COUNT(*) as c FROM edges e
    WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.from_id AND n.removed_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.to_id AND n.removed_at IS NOT NULL)
  `).get();

  console.log();
  console.log(`  Final state:`);
  console.log(`    Active nodes:        ${finalNodes.c}`);
  console.log(`    Removed nodes:       ${finalRemoved.c}`);
  console.log(`    Total edges:         ${finalEdges.c}`);
  console.log(`    Stale edges:         ${edgesShouldBeDeleted.c} (should have been cleaned up)`);
  console.log(`    Timeline rows:       ${finalTimeline.c}`);

  db.close();

  // Summary
  console.log();
  console.log("=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  
  const issues = [];
  if (totalBusyErrors > 0) issues.push(`${totalBusyErrors} SQLITE_BUSY errors (busy_timeout=1000ms too short)`);
  if (totalOtherErrors > 0) issues.push(`${totalOtherErrors} other errors`);
  if (!integrityOk) issues.push("PRAGMA integrity_check FAILED — database corruption");
  if (!fkClean) issues.push(`Foreign key violations: ${Array.isArray(fkViolations) ? fkViolations.length : "?"}`);
  if (orphanedEdges.length > 0) issues.push(`${orphanedEdges.length} orphaned edges (hardDeleteNode race)`);
  if (edgesToDeleted.length > 0) issues.push(`${edgesToDeleted.length} edges pointing to soft-deleted nodes`);
  if (softDeletedWithEdges.length > 0) issues.push(`${softDeletedWithEdges.length} soft-deleted nodes still have edges (non-atomic softDeleteNode BUG)`);

  if (issues.length === 0) {
    console.log("  ✅ No issues detected in this run");
    console.log("  (Run again — race conditions are non-deterministic)");
  } else {
    console.log("  ❌ Issues found:");
    for (const issue of issues) {
      console.log(`    • ${issue}`);
    }
  }
  console.log();

  // Cleanup
  if (process.env.KEEP_DB !== "1") {
    rmSync(TEST_DIR, { recursive: true, force: true });
    console.log(`  Cleaned up ${TEST_DIR}`);
  } else {
    console.log(`  Database preserved at ${DB_PATH}`);
  }
  console.log();
}


function runWorker(workerId, barrierPath) {
  return new Promise((resolve) => {
    const child = fork(
      fileURLToPath(import.meta.url),
      ["--worker", String(workerId), DB_PATH, String(ITERATIONS_PER_WORKER), String(NUM_WORKERS), barrierPath],
      {
        cwd: PROJECT_ROOT,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      }
    );

    let result = null;

    child.on("message", (msg) => {
      result = msg;
    });

    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("exit", (code) => {
      if (result) {
        resolve(result);
      } else {
        console.error(`  Worker ${workerId} exited with code ${code}`);
        if (stderr) console.error(`  stderr: ${stderr.slice(0, 500)}`);
        resolve({
          workerId,
          ops: 0,
          inserts: 0,
          edgeInserts: 0,
          softDeletes: 0,
          hardDeletes: 0,
          reads: 0,
          timelineWrites: 0,
          transactionalOps: 0,
          busyErrors: 0,
          otherErrors: 1,
          errorDetails: [{ worker: workerId, op: "spawn", message: `Worker crashed: code=${code}` }],
        });
      }
    });
  });
}

// ============ Worker process ============

async function workerMain() {
  const workerId = parseInt(process.argv[3]);
  const dbPath = process.argv[4];
  const iterations = parseInt(process.argv[5]);
  const barrierPath = process.argv[7];

  // Import KnowledgeDB from compiled dist
  const { KnowledgeDB } = await import(path.join(PROJECT_ROOT, "dist", "db.js"));
  const db = new KnowledgeDB(dbPath);

  // Wait for the barrier (spin-wait on file existence)
  const { existsSync } = await import("node:fs");
  while (!existsSync(barrierPath)) {
    await new Promise(r => setTimeout(r, 10));
  }

  const stats = {
    workerId,
    ops: 0,
    inserts: 0,
    edgeInserts: 0,
    softDeletes: 0,
    hardDeletes: 0,
    reads: 0,
    timelineWrites: 0,
    transactionalOps: 0,
    busyErrors: 0,
    otherErrors: 0,
    errorDetails: [],
  };

  const myNodes = [];
  const KINDS = ["feature", "module", "pattern", "config", "decision", "component"];
  const RELATIONS = ["connects_to", "depends_on", "implements", "calls", "configured_by"];
  const SEED_COUNT = 30;

  function randomId() {
    return `w${workerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function randomSeedId() {
    return `seed-${Math.floor(Math.random() * SEED_COUNT)}`;
  }

  function trackError(op, err) {
    const msg = err.message || String(err);
    if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      stats.busyErrors++;
    } else {
      stats.otherErrors++;
    }
    stats.errorDetails.push({
      worker: workerId,
      op,
      message: msg.slice(0, 200),
    });
  }

  for (let i = 0; i < iterations; i++) {
    const roll = Math.random();
    
    if (roll < 0.20) {
      // INSERT NODE
      try {
        const nodeId = randomId();
        db.insertNode({
          id: nodeId,
          name: `Node ${nodeId}`,
          kind: randomChoice(KINDS),
          summary: `Stress test node created by worker ${workerId} iteration ${i}`,
          why: "stress testing",
        });
        myNodes.push(nodeId);
        stats.inserts++;
        stats.ops++;
      } catch (err) {
        trackError("insertNode", err);
        stats.ops++;
      }
    } else if (roll < 0.35) {
      // INSERT EDGE — high contention on seed nodes
      try {
        const fromId = Math.random() < 0.6 ? randomSeedId() : (myNodes.length > 0 ? randomChoice(myNodes) : randomSeedId());
        const toId = Math.random() < 0.6 ? randomSeedId() : (myNodes.length > 0 ? randomChoice(myNodes) : randomSeedId());
        
        if (fromId !== toId) {
          db.insertEdge({
            from_id: fromId,
            to_id: toId,
            relation: randomChoice(RELATIONS),
            description: `stress edge from worker ${workerId}`,
          });
          stats.edgeInserts++;
        }
        stats.ops++;
      } catch (err) {
        trackError("insertEdge", err);
        stats.ops++;
      }
    } else if (roll < 0.52) {
      // SOFT DELETE — the non-atomic operation, HIGH rate to maximize race window
      try {
        // Heavily target seed nodes so multiple workers race on the same node
        const targetId = Math.random() < 0.7 ? randomSeedId() : (myNodes.length > 0 ? myNodes.shift() : randomSeedId());
        db.softDeleteNode(targetId, `stress delete by worker ${workerId}`);
        stats.softDeletes++;
        stats.ops++;
      } catch (err) {
        trackError("softDeleteNode", err);
        stats.ops++;
      }
    } else if (roll < 0.60) {
      // HARD DELETE — also non-atomic
      try {
        const targetId = myNodes.length > 0 ? myNodes.shift() : randomSeedId();
        db.hardDeleteNode(targetId);
        stats.hardDeletes++;
        stats.ops++;
      } catch (err) {
        trackError("hardDeleteNode", err);
        stats.ops++;
      }
    } else if (roll < 0.72) {
      // READ — getAllActiveNodes
      try {
        db.getAllActiveNodes();
        stats.reads++;
        stats.ops++;
      } catch (err) {
        trackError("getAllActiveNodes", err);
        stats.ops++;
      }
    } else if (roll < 0.82) {
      // TIMELINE WRITE — amplifies write contention
      try {
        db.insertTimelineEntry({
          tool: "stress_test",
          params: JSON.stringify({ worker: workerId, iter: i }),
          result_summary: "stress test timeline entry to amplify write contention",
          is_write: true,
          is_error: false,
          affected_ids: [`w${workerId}-${i}`],
        });
        stats.timelineWrites++;
        stats.ops++;
      } catch (err) {
        trackError("insertTimelineEntry", err);
        stats.ops++;
      }
    } else if (roll < 0.90) {
      // READ — getNode + edges (typical MCP usage pattern)
      try {
        const targetId = Math.random() < 0.5 ? randomSeedId() : (myNodes.length > 0 ? randomChoice(myNodes) : "seed-0");
        db.getNode(targetId);
        db.getOutgoingEdges(targetId);
        db.getIncomingEdges(targetId);
        stats.reads++;
        stats.ops++;
      } catch (err) {
        trackError("getNode+edges", err);
        stats.ops++;
      }
    } else {
      // INSERT NODE + EDGES in transaction (via insertNodeAndEdges)
      try {
        const nodeId = randomId();
        const edges = [];
        const edgeCount = 1 + Math.floor(Math.random() * 4);
        for (let e = 0; e < edgeCount; e++) {
          edges.push({
            to_id: randomSeedId(),
            relation: randomChoice(RELATIONS),
            description: `stress txn edge`,
          });
        }
        db.insertNodeAndEdges(
          {
            id: nodeId,
            name: `TxnNode ${nodeId}`,
            kind: randomChoice(KINDS),
            summary: `Transactional node from worker ${workerId}`,
            why: null,
            file_refs: null,
            parent_id: null,
            created_by_task: null,
            embedding: null,
          },
          edges
        );
        myNodes.push(nodeId);
        stats.inserts++;
        stats.edgeInserts += edgeCount;
        stats.transactionalOps++;
        stats.ops++;
      } catch (err) {
        trackError("insertNodeAndEdges", err);
        stats.ops++;
      }
    }
  }

  try { db.close(); } catch (_) {}
  process.send(stats);
  process.exit(0);
}

// ============ Entry point ============

if (process.argv.includes("--worker")) {
  workerMain().catch((err) => {
    console.error("Worker fatal:", err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
