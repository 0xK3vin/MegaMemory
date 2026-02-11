import type { KnowledgeDB } from "./db.js";

export interface TimelineLogger {
  log(entry: {
    tool: string;
    params: Record<string, unknown>;
    result_summary: string;
    is_write: boolean;
    is_error: boolean;
    affected_ids: string[];
  }): void;
}

export function createTimelineLogger(db: KnowledgeDB): TimelineLogger {
  return {
    log(entry) {
      try {
        db.insertTimelineEntry({
          tool: entry.tool,
          params: JSON.stringify(entry.params),
          result_summary: entry.result_summary,
          is_write: entry.is_write,
          is_error: entry.is_error,
          affected_ids: entry.affected_ids,
        });
      } catch (err) {
        // Timeline logging must never break tool execution
        console.error("Timeline logging failed:", err instanceof Error ? err.message : String(err));
      }
    },
  };
}
