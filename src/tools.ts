import { KnowledgeDB } from "./db.js";
import { embed, embeddingText, findTopK } from "./embeddings.js";
import type {
  UnderstandInput,
  CreateConceptInput,
  UpdateConceptInput,
  LinkInput,
  RemoveConceptInput,
  NodeWithContext,
  UnderstandOutput,
  ListRootsOutput,
  NodeRow,
  RelationType,
} from "./types.js";

/**
 * Generate a slug ID from a name, optionally prefixed with parent ID.
 * Converts underscores and spaces to hyphens, lowercases, strips non-alphanumeric.
 */
function makeId(name: string, parentId?: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[_\s]+/g, "-")          // underscores/spaces → hyphens
    .replace(/[^a-z0-9-]/g, "")       // strip everything else
    .replace(/-+/g, "-")              // collapse multiple hyphens
    .replace(/^-|-$/g, "");           // trim leading/trailing hyphens
  return parentId ? `${parentId}/${normalized}` : normalized;
}

/**
 * Parse file_refs from JSON string to array.
 */
function parseFileRefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build a NodeWithContext from a node row and DB lookups.
 */
export function buildNodeWithContext(
  db: KnowledgeDB,
  node: NodeRow,
  similarity?: number
): NodeWithContext {
  const children = db.getChildren(node.id).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind as NodeWithContext["kind"],
    summary: c.summary,
  }));

  const outgoing = db.getOutgoingEdges(node.id).map((e) => ({
    to: e.to_id,
    to_name: e.to_name,
    relation: e.relation as RelationType,
    description: e.description,
  }));

  const incoming = db.getIncomingEdges(node.id).map((e) => ({
    from: e.from_id,
    from_name: e.from_name,
    relation: e.relation as RelationType,
    description: e.description,
  }));

  let parent: { id: string; name: string } | null = null;
  if (node.parent_id) {
    const p = db.getParent(node.parent_id);
    if (p) {
      parent = { id: p.id, name: p.name };
    }
  }

  return {
    id: node.id,
    name: node.name,
    kind: node.kind as NodeWithContext["kind"],
    summary: node.summary,
    why: node.why,
    file_refs: parseFileRefs(node.file_refs),
    children,
    edges: outgoing,
    incoming_edges: incoming,
    parent,
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

// ---- Tool handlers ----

export async function understand(
  db: KnowledgeDB,
  input: UnderstandInput
): Promise<UnderstandOutput> {
  const topK = input.top_k ?? 10;

  // Embed the query
  const queryEmbedding = await embed(input.query);

  // Get all active nodes with embeddings
  const candidates = db.getAllActiveNodesWithEmbeddings();

  if (candidates.length === 0) {
    return { matches: [] };
  }

  // Find top-K by cosine similarity
  const topMatches = findTopK(queryEmbedding, candidates, topK);

  // Build full context for each match
  const matches: NodeWithContext[] = [];
  for (const match of topMatches) {
    const node = db.getNode(match.id);
    if (!node) continue;
    matches.push(buildNodeWithContext(db, node, match.similarity));
  }

  return { matches };
}

export async function createConcept(
  db: KnowledgeDB,
  input: CreateConceptInput
): Promise<{ id: string; message: string }> {
  const id = makeId(input.name, input.parent_id);

  // Check if node already exists
  if (db.nodeExists(id)) {
    throw new Error(`Concept "${id}" already exists. Use update_concept to modify it.`);
  }

  // Validate parent exists if specified
  if (input.parent_id && !db.nodeExists(input.parent_id)) {
    throw new Error(`Parent concept "${input.parent_id}" does not exist.`);
  }

  // Generate embedding
  const text = embeddingText(input.name, input.kind, input.summary);
  const embedding = await embed(text);

  // Insert node
  db.insertNode({
    id,
    name: input.name,
    kind: input.kind,
    summary: input.summary,
    why: input.why,
    file_refs: input.file_refs,
    parent_id: input.parent_id,
    created_by_task: input.created_by_task,
    embedding,
  });

  // Create edges if specified
  if (input.edges) {
    for (const edge of input.edges) {
      // Only create edge if target exists
      if (db.nodeExists(edge.to)) {
        db.insertEdge({
          from_id: id,
          to_id: edge.to,
          relation: edge.relation,
          description: edge.description,
        });
      }
    }
  }

  return { id, message: `Created concept "${id}"` };
}

export async function updateConcept(
  db: KnowledgeDB,
  input: UpdateConceptInput
): Promise<{ message: string }> {
  // Verify node exists
  const existing = db.getNode(input.id);
  if (!existing) {
    throw new Error(`Concept "${input.id}" not found.`);
  }

  // If summary or name changed, regenerate embedding
  let embedding: Buffer | undefined;
  if (input.changes.summary !== undefined || input.changes.name !== undefined) {
    const name = input.changes.name ?? existing.name;
    const kind = input.changes.kind ?? existing.kind;
    const summary = input.changes.summary ?? existing.summary;
    const text = embeddingText(name, kind, summary);
    embedding = await embed(text);
  }

  const updated = db.updateNode(input.id, {
    ...input.changes,
    embedding,
  });

  if (!updated) {
    return { message: `No changes applied to "${input.id}"` };
  }

  return { message: `Updated concept "${input.id}"` };
}

export function link(
  db: KnowledgeDB,
  input: LinkInput
): { message: string } {
  // Validate both nodes exist
  if (!db.nodeExists(input.from)) {
    throw new Error(`Source concept "${input.from}" not found.`);
  }
  if (!db.nodeExists(input.to)) {
    throw new Error(`Target concept "${input.to}" not found.`);
  }

  const edgeId = db.insertEdge({
    from_id: input.from,
    to_id: input.to,
    relation: input.relation,
    description: input.description,
  });

  return {
    message: `Created ${input.relation} link from "${input.from}" to "${input.to}" (edge #${edgeId})`,
  };
}

export function removeConcept(
  db: KnowledgeDB,
  input: RemoveConceptInput
): { message: string } {
  const existing = db.getNodeIncludingRemoved(input.id);
  if (!existing) {
    throw new Error(`Concept "${input.id}" not found.`);
  }
  if (existing.removed_at) {
    throw new Error(`Concept "${input.id}" was already removed.`);
  }

  const removed = db.softDeleteNode(input.id, input.reason);
  if (!removed) {
    throw new Error(`Failed to remove concept "${input.id}".`);
  }

  return {
    message: `Removed concept "${input.id}". Reason: ${input.reason}`,
  };
}

export function listRoots(db: KnowledgeDB): ListRootsOutput & { hint?: string } {
  const rootRows = db.getRootNodes();

  const roots = rootRows.map((root) => {
    const children = db.getChildren(root.id).map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind as NodeWithContext["kind"],
      summary: c.summary,
    }));

    return {
      id: root.id,
      name: root.name,
      kind: root.kind as NodeWithContext["kind"],
      summary: root.summary,
      children,
    };
  });

  const stats = db.getStats();
  const hint =
    stats.nodes === 0
      ? "Graph is empty. Run /user:bootstrap-memory to populate, or create concepts as you work."
      : undefined;

  return { roots, ...(hint ? { hint } : {}) };
}
