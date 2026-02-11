// ---- Data model types ----

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  parent_id: string | null;
  created_by_task: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  merge_group: string | null;
  needs_merge: boolean;
  source_branch: string | null;
  merge_timestamp: string | null;
}

export type NodeKind =
  | "feature"
  | "module"
  | "pattern"
  | "config"
  | "decision"
  | "component";

export interface Edge {
  id: number;
  from_id: string;
  to_id: string;
  relation: RelationType;
  description: string | null;
  created_at: string;
  merge_group: string | null;
  needs_merge: boolean;
  source_branch: string | null;
  merge_timestamp: string | null;
}

export type RelationType =
  | "connects_to"
  | "depends_on"
  | "implements"
  | "calls"
  | "configured_by";

// ---- Tool input types ----

export interface UnderstandInput {
  query: string;
  top_k?: number; // default 10
}

export interface CreateConceptInput {
  name: string;
  kind: NodeKind;
  summary: string;
  why?: string;
  parent_id?: string;
  file_refs?: string[];
  edges?: Array<{
    to: string;
    relation: RelationType;
    description?: string;
  }>;
  created_by_task?: string;
}

export interface UpdateConceptInput {
  id: string;
  changes: {
    name?: string;
    kind?: NodeKind;
    summary?: string;
    why?: string;
    file_refs?: string[];
  };
}

export interface LinkInput {
  from: string;
  to: string;
  relation: RelationType;
  description?: string;
}

export interface RemoveConceptInput {
  id: string;
  reason: string;
}

// ---- Tool output types ----

export interface NodeWithContext {
  id: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  children: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    summary: string;
  }>;
  edges: Array<{
    to: string;
    to_name: string;
    relation: RelationType;
    description: string | null;
  }>;
  incoming_edges: Array<{
    from: string;
    from_name: string;
    relation: RelationType;
    description: string | null;
  }>;
  parent: { id: string; name: string } | null;
  similarity?: number;
}

export interface UnderstandOutput {
  matches: NodeWithContext[];
}

export interface ListRootsOutput {
  roots: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    summary: string;
    children: string[];
  }>;
}

// ---- DB row types (raw from SQLite) ----

export interface NodeRow {
  id: string;
  name: string;
  kind: string;
  summary: string;
  why: string | null;
  file_refs: string | null; // JSON string
  parent_id: string | null;
  created_by_task: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  embedding: Buffer | null;
  merge_group: string | null;
  needs_merge: number; // SQLite stores boolean as 0/1
  source_branch: string | null;
  merge_timestamp: string | null;
}

export interface EdgeRow {
  id: number;
  from_id: string;
  to_id: string;
  relation: string;
  description: string | null;
  created_at: string;
  merge_group: string | null;
  needs_merge: number; // SQLite stores boolean as 0/1
  source_branch: string | null;
  merge_timestamp: string | null;
}

// ---- Merge types ----

export interface ConflictVersion {
  id: string;
  original_id: string;
  source_branch: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  edges: Array<{ to: string; relation: RelationType; description: string | null }>;
  removed_at: string | null;
  removed_reason: string | null;
}

export interface ConflictGroup {
  merge_group: string;
  merge_timestamp: string | null;
  versions: ConflictVersion[];
}

export interface ListConflictsOutput {
  conflicts: ConflictGroup[];
}

export interface ResolveConflictInput {
  merge_group: string;
  resolved: {
    summary: string;
    why?: string;
    file_refs?: string[];
  };
  reason: string;
}

export interface MergeResult {
  clean: number;
  conceptConflicts: number;
  edgeConflicts: number;
  removedClean: number;
  mergeGroups: string[];
}
