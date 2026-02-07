import { randomUUID } from "crypto";
import { KnowledgeDB } from "./db.js";
import type { NodeRow, EdgeRow, MergeResult } from "./types.js";

export const MERGE_SUFFIX_LEFT = "::left";
export const MERGE_SUFFIX_RIGHT = "::right";

export interface MergeOptions {
  leftLabel?: string;
  rightLabel?: string;
}

/**
 * Strip the merge suffix (::left or ::right) from an ID.
 */
export function stripMergeSuffix(id: string): string {
  if (id.endsWith(MERGE_SUFFIX_LEFT)) return id.slice(0, -MERGE_SUFFIX_LEFT.length);
  if (id.endsWith(MERGE_SUFFIX_RIGHT)) return id.slice(0, -MERGE_SUFFIX_RIGHT.length);
  return id;
}

/**
 * Check if an ID has a merge suffix.
 */
export function hasMergeSuffix(id: string): boolean {
  return id.endsWith(MERGE_SUFFIX_LEFT) || id.endsWith(MERGE_SUFFIX_RIGHT);
}

/**
 * Deep comparison of two nodes' content fields (ignoring timestamps, embedding, merge metadata).
 */
export function nodesAreIdentical(left: NodeRow, right: NodeRow): boolean {
  if (left.name !== right.name) return false;
  if (left.kind !== right.kind) return false;
  if (left.summary !== right.summary) return false;
  if ((left.why ?? "") !== (right.why ?? "")) return false;
  if ((left.parent_id ?? "") !== (right.parent_id ?? "")) return false;

  // Deep-compare file_refs (stored as JSON strings)
  const leftRefs = left.file_refs ? JSON.parse(left.file_refs) : null;
  const rightRefs = right.file_refs ? JSON.parse(right.file_refs) : null;
  if (JSON.stringify(leftRefs) !== JSON.stringify(rightRefs)) return false;

  // Check removed state
  const leftRemoved = left.removed_at !== null;
  const rightRemoved = right.removed_at !== null;
  if (leftRemoved !== rightRemoved) return false;

  return true;
}

/**
 * Create a normalized edge key for comparison (ignoring IDs and timestamps).
 */
function edgeKey(e: EdgeRow): string {
  return `${e.from_id}|${e.to_id}|${e.relation}|${e.description ?? ""}`;
}

/**
 * Compare two sets of edges by their content (from_id, to_id, relation, description).
 */
export function edgeSetsAreIdentical(left: EdgeRow[], right: EdgeRow[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map(edgeKey));
  const rightKeys = new Set(right.map(edgeKey));
  if (leftKeys.size !== rightKeys.size) return false;
  for (const k of leftKeys) {
    if (!rightKeys.has(k)) return false;
  }
  return true;
}

/**
 * MergeEngine: Merges two knowledge.db files into an output file.
 *
 * Opens left and right DBs read-only, writes to a fresh output DB.
 * Detects conflicts, assigns merge_group UUIDs, and sets needs_merge flags.
 */
export class MergeEngine {
  merge(
    leftPath: string,
    rightPath: string,
    outputPath: string,
    options?: MergeOptions
  ): MergeResult {
    const leftLabel = options?.leftLabel ?? "left";
    const rightLabel = options?.rightLabel ?? "right";

    const leftDb = new KnowledgeDB(leftPath);
    const rightDb = new KnowledgeDB(rightPath);
    const outputDb = new KnowledgeDB(outputPath);

    try {
      return this.performMerge(leftDb, rightDb, outputDb, leftLabel, rightLabel);
    } finally {
      leftDb.close();
      rightDb.close();
      outputDb.close();
    }
  }

  private performMerge(
    leftDb: KnowledgeDB,
    rightDb: KnowledgeDB,
    outputDb: KnowledgeDB,
    leftLabel: string,
    rightLabel: string
  ): MergeResult {
    const leftNodes = leftDb.getAllNodesRaw();
    const rightNodes = rightDb.getAllNodesRaw();
    const leftEdges = leftDb.getAllEdgesRaw();
    const rightEdges = rightDb.getAllEdgesRaw();

    const leftNodeMap = new Map<string, NodeRow>();
    const rightNodeMap = new Map<string, NodeRow>();
    const leftVariantsByCanonical = new Map<string, NodeRow[]>();
    const rightVariantsByCanonical = new Map<string, NodeRow[]>();

    for (const n of leftNodes) {
      leftNodeMap.set(n.id, n);
      const canonical = stripMergeSuffix(n.id);
      if (!leftVariantsByCanonical.has(canonical)) leftVariantsByCanonical.set(canonical, []);
      leftVariantsByCanonical.get(canonical)!.push(n);
    }
    for (const n of rightNodes) {
      rightNodeMap.set(n.id, n);
      const canonical = stripMergeSuffix(n.id);
      if (!rightVariantsByCanonical.has(canonical)) rightVariantsByCanonical.set(canonical, []);
      rightVariantsByCanonical.get(canonical)!.push(n);
    }

    // Build edge maps keyed by node ID
    const leftEdgeMap = new Map<string, EdgeRow[]>();
    const rightEdgeMap = new Map<string, EdgeRow[]>();

    for (const e of leftEdges) {
      if (!leftEdgeMap.has(e.from_id)) leftEdgeMap.set(e.from_id, []);
      leftEdgeMap.get(e.from_id)!.push(e);
    }
    for (const e of rightEdges) {
      if (!rightEdgeMap.has(e.from_id)) rightEdgeMap.set(e.from_id, []);
      rightEdgeMap.get(e.from_id)!.push(e);
    }

    // Collect all unique IDs (strip any existing merge suffixes to get canonical IDs)
    const allIds = new Set<string>();
    for (const id of leftNodeMap.keys()) allIds.add(stripMergeSuffix(id));
    for (const id of rightNodeMap.keys()) allIds.add(stripMergeSuffix(id));

    const result: MergeResult = {
      clean: 0,
      conceptConflicts: 0,
      edgeConflicts: 0,
      removedClean: 0,
      mergeGroups: [],
    };

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    // Track which IDs were suffixed (for edge remapping)
    const idRemapping = new Map<string, string>(); // "side:originalId" → suffixedId

    // Deferred edge operations — we insert all nodes first, then edges,
    // to avoid FOREIGN KEY constraint failures when edges reference nodes
    // that haven't been inserted yet.
    type DeferredEdge = {
      from_id: string;
      to_id: string;
      relation: string;
      description: string | null;
      created_at: string | null;
      merge_group: string | null;
      needs_merge: number;
      source_branch: string | null;
      merge_timestamp: string | null;
      _originSide: "left" | "right"; // tracks which input DB this edge came from
    };
    const deferredEdges: DeferredEdge[] = [];
    const insertedNodeIds = new Set<string>();
    const seenPreexistingEdgeKeys = new Set<string>();

    const insertNodeOnce = (node: NodeRow): void => {
      if (insertedNodeIds.has(node.id)) return;
      this.insertNodeAsIs(outputDb, node);
      insertedNodeIds.add(node.id);
    };

    const deferPreexistingEdge = (
      e: EdgeRow,
      originSide: "left" | "right"
    ): void => {
      const key = `${e.from_id}|${e.to_id}|${e.relation}|${e.description ?? ""}|${e.merge_group ?? ""}|${e.needs_merge}|${e.source_branch ?? ""}|${e.merge_timestamp ?? ""}`;
      if (seenPreexistingEdgeKeys.has(key)) return;
      seenPreexistingEdgeKeys.add(key);

      deferredEdges.push({
        from_id: e.from_id,
        to_id: e.to_id,
        relation: e.relation,
        description: e.description,
        created_at: e.created_at,
        merge_group: e.merge_group,
        needs_merge: e.needs_merge,
        source_branch: e.source_branch,
        merge_timestamp: e.merge_timestamp,
        _originSide: originSide,
      });
    };

    // ---- PASS 1: Insert all nodes ----

    // Track which canonical IDs were processed as conflicts vs clean
    const conflictIds = new Set<string>();

    for (const id of allIds) {
      const leftVariants = leftVariantsByCanonical.get(id) ?? [];
      const rightVariants = rightVariantsByCanonical.get(id) ?? [];
      const leftNode = leftNodeMap.get(id);
      const rightNode = rightNodeMap.get(id);

      // Handle pre-existing conflicts (nodes already have ::left/::right IDs from prior merge).
      const preexistingLeft = leftVariants.filter(
        (n) => n.needs_merge === 1 && !!n.merge_group && hasMergeSuffix(n.id)
      );
      const preexistingRight = rightVariants.filter(
        (n) => n.needs_merge === 1 && !!n.merge_group && hasMergeSuffix(n.id)
      );

      if (preexistingLeft.length > 0 || preexistingRight.length > 0) {
        const preexistingAll = [...preexistingLeft, ...preexistingRight];

        // Carry forward all unresolved versions as-is.
        for (const node of preexistingAll) {
          insertNodeOnce(node);
        }

        // Ensure edges from clean nodes can still remap to a valid conflicted target.
        const leftTarget =
          preexistingAll.find((n) => n.id.endsWith(MERGE_SUFFIX_LEFT)) ??
          preexistingAll[0];
        const rightTarget =
          preexistingAll.find((n) => n.id.endsWith(MERGE_SUFFIX_RIGHT)) ??
          preexistingAll[preexistingAll.length - 1] ??
          preexistingAll[0];

        if (leftTarget) idRemapping.set(`left:${id}`, leftTarget.id);
        if (rightTarget) idRemapping.set(`right:${id}`, rightTarget.id);

        // Carry forward outgoing edges from conflicted source nodes.
        for (const node of preexistingLeft) {
          const edges = leftEdgeMap.get(node.id) ?? [];
          for (const e of edges) {
            deferPreexistingEdge(e, "left");
          }
        }
        for (const node of preexistingRight) {
          const edges = rightEdgeMap.get(node.id) ?? [];
          for (const e of edges) {
            deferPreexistingEdge(e, "right");
          }
        }

        conflictIds.add(id);
        continue;
      }

      if (!leftNode && rightNode) {
        // Only in right
        insertNodeOnce(rightNode);
        if (rightNode.removed_at) {
          result.removedClean++;
        } else {
          result.clean++;
        }
      } else if (leftNode && !rightNode) {
        // Only in left
        insertNodeOnce(leftNode);
        if (leftNode.removed_at) {
          result.removedClean++;
        } else {
          result.clean++;
        }
      } else if (leftNode && rightNode) {
        if (nodesAreIdentical(leftNode, rightNode)) {
          // Identical — keep left's copy
          insertNodeOnce(leftNode);
          if (leftNode.removed_at) {
            result.removedClean++;
          } else {
            result.clean++;
          }
        } else {
          // Conflict — insert both with suffixed IDs
          conflictIds.add(id);
          const mergeGroup = randomUUID();
          result.mergeGroups.push(mergeGroup);
          result.conceptConflicts++;

          const leftSuffixed = `${id}${MERGE_SUFFIX_LEFT}`;
          const rightSuffixed = `${id}${MERGE_SUFFIX_RIGHT}`;

          idRemapping.set(`left:${id}`, leftSuffixed);
          idRemapping.set(`right:${id}`, rightSuffixed);

          this.insertConflictNode(outputDb, leftNode, leftSuffixed, mergeGroup, leftLabel, now);
          this.insertConflictNode(outputDb, rightNode, rightSuffixed, mergeGroup, rightLabel, now);

          // Defer edge handling for conflicting nodes
          const leftNodeEdges = leftEdgeMap.get(id) ?? [];
          const rightNodeEdges = rightEdgeMap.get(id) ?? [];
          const edgesConflict = !edgeSetsAreIdentical(leftNodeEdges, rightNodeEdges);

          if (edgesConflict && (leftNodeEdges.length > 0 || rightNodeEdges.length > 0)) {
            result.edgeConflicts++;
          }

          for (const e of leftNodeEdges) {
            deferredEdges.push({
              from_id: leftSuffixed,
              to_id: e.to_id, // will be remapped in pass 2
              relation: e.relation,
              description: e.description,
              created_at: e.created_at,
              merge_group: edgesConflict ? mergeGroup : null,
              needs_merge: edgesConflict ? 1 : 0,
              source_branch: edgesConflict ? leftLabel : null,
              merge_timestamp: edgesConflict ? now : null,
              _originSide: "left",
            });
          }

          for (const e of rightNodeEdges) {
            deferredEdges.push({
              from_id: rightSuffixed,
              to_id: e.to_id, // will be remapped in pass 2
              relation: e.relation,
              description: e.description,
              created_at: e.created_at,
              merge_group: edgesConflict ? mergeGroup : null,
              needs_merge: edgesConflict ? 1 : 0,
              source_branch: edgesConflict ? rightLabel : null,
              merge_timestamp: edgesConflict ? now : null,
              _originSide: "right",
            });
          }
        }
      }
    }

    // ---- PASS 2: Insert all edges ----

    // First, collect non-conflict edges
    for (const id of allIds) {
      if (conflictIds.has(id)) continue; // handled via deferred edges

      const leftNode = leftNodeMap.get(id);
      const rightNode = rightNodeMap.get(id);

      // Skip pre-existing conflicts
      if (leftNode && leftNode.needs_merge && leftNode.merge_group) continue;

      if (!leftNode && rightNode) {
        this.deferEdgesForNode(deferredEdges, rightEdgeMap, rightNode.id, idRemapping, "right");
      } else if (leftNode && !rightNode) {
        this.deferEdgesForNode(deferredEdges, leftEdgeMap, leftNode.id, idRemapping, "left");
      } else if (leftNode && rightNode) {
        // Identical nodes — union of edges from both sides
        this.deferEdgesClean(deferredEdges, leftEdgeMap, rightEdgeMap, leftNode.id, idRemapping);
      }
    }

    // Now insert all deferred edges, remapping target IDs where needed
    for (const edge of deferredEdges) {
      // Remap to_id if the target was conflicted — use _originSide to determine
      // which suffixed version to point at (not from_id suffix, which may be absent
      // for edges from non-conflicted nodes)
      const remappedToId = idRemapping.get(`${edge._originSide}:${edge.to_id}`) ?? edge.to_id;

      outputDb.insertEdgeRaw({
        from_id: edge.from_id,
        to_id: remappedToId,
        relation: edge.relation,
        description: edge.description,
        created_at: edge.created_at,
        merge_group: edge.merge_group,
        needs_merge: edge.needs_merge,
        source_branch: edge.source_branch,
        merge_timestamp: edge.merge_timestamp,
      });
    }

    return result;
  }

  private insertNodeAsIs(db: KnowledgeDB, node: NodeRow): void {
    db.insertNodeRaw({
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why,
      file_refs: node.file_refs,
      parent_id: node.parent_id,
      created_by_task: node.created_by_task,
      created_at: node.created_at,
      updated_at: node.updated_at,
      removed_at: node.removed_at,
      removed_reason: node.removed_reason,
      embedding: node.embedding,
      merge_group: node.merge_group,
      needs_merge: node.needs_merge,
      source_branch: node.source_branch,
      merge_timestamp: node.merge_timestamp,
    });
  }

  private insertConflictNode(
    db: KnowledgeDB,
    node: NodeRow,
    suffixedId: string,
    mergeGroup: string,
    sourceLabel: string,
    timestamp: string
  ): void {
    db.insertNodeRaw({
      id: suffixedId,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why,
      file_refs: node.file_refs,
      parent_id: node.parent_id,
      created_by_task: node.created_by_task,
      created_at: node.created_at,
      updated_at: node.updated_at,
      removed_at: node.removed_at,
      removed_reason: node.removed_reason,
      embedding: node.embedding,
      merge_group: mergeGroup,
      needs_merge: 1,
      source_branch: sourceLabel,
      merge_timestamp: timestamp,
    });
  }

  /**
   * Defer edges for a non-conflicting node into the deferred list.
   */
  private deferEdgesForNode(
    deferred: Array<{
      from_id: string; to_id: string; relation: string;
      description: string | null; created_at: string | null;
      merge_group: string | null; needs_merge: number;
      source_branch: string | null; merge_timestamp: string | null;
      _originSide: "left" | "right";
    }>,
    edgeMap: Map<string, EdgeRow[]>,
    nodeId: string,
    _idRemapping: Map<string, string>,
    side: "left" | "right"
  ): void {
    const edges = edgeMap.get(nodeId) ?? [];
    for (const e of edges) {
      deferred.push({
        from_id: e.from_id,
        to_id: e.to_id,
        relation: e.relation,
        description: e.description,
        created_at: e.created_at,
        merge_group: null,
        needs_merge: 0,
        source_branch: null,
        merge_timestamp: null,
        _originSide: side,
      });
    }
  }

  /**
   * For identical nodes, defer the union of edges from both sides (deduplicated).
   */
  private deferEdgesClean(
    deferred: Array<{
      from_id: string; to_id: string; relation: string;
      description: string | null; created_at: string | null;
      merge_group: string | null; needs_merge: number;
      source_branch: string | null; merge_timestamp: string | null;
      _originSide: "left" | "right";
    }>,
    leftEdgeMap: Map<string, EdgeRow[]>,
    rightEdgeMap: Map<string, EdgeRow[]>,
    nodeId: string,
    _idRemapping: Map<string, string>
  ): void {
    const leftEdges = leftEdgeMap.get(nodeId) ?? [];
    const rightEdges = rightEdgeMap.get(nodeId) ?? [];

    const seen = new Set<string>();

    // Process left edges first, then right — deduplicate by content key
    for (const e of leftEdges) {
      const key = edgeKey(e);
      if (seen.has(key)) continue;
      seen.add(key);

      deferred.push({
        from_id: e.from_id,
        to_id: e.to_id,
        relation: e.relation,
        description: e.description,
        created_at: e.created_at,
        merge_group: null,
        needs_merge: 0,
        source_branch: null,
        merge_timestamp: null,
        _originSide: "left",
      });
    }

    for (const e of rightEdges) {
      const key = edgeKey(e);
      if (seen.has(key)) continue;
      seen.add(key);

      deferred.push({
        from_id: e.from_id,
        to_id: e.to_id,
        relation: e.relation,
        description: e.description,
        created_at: e.created_at,
        merge_group: null,
        needs_merge: 0,
        source_branch: null,
        merge_timestamp: null,
        _originSide: "right",
      });
    }
  }

}
