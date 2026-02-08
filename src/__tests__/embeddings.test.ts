import { describe, it, expect } from "vitest";
import {
  embed,
  embeddingText,
  cosineSimilarity,
  findTopK,
  EMBEDDING_DIM,
} from "../embeddings.js";

/**
 * Create a mock embedding buffer from a Float32Array of values.
 */
function mockEmbedding(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

describe("EMBEDDING_DIM", () => {
  it("is 384", () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});

describe("embed", () => {
  it("rejects empty string", async () => {
    await expect(embed("")).rejects.toThrow("Cannot embed empty text");
  });

  it("rejects whitespace-only string", async () => {
    await expect(embed("   ")).rejects.toThrow("Cannot embed empty text");
  });

  it("rejects newline/tab-only string", async () => {
    await expect(embed("\n\t  \n")).rejects.toThrow("Cannot embed empty text");
  });
});

describe("embeddingText", () => {
  it("formats kind, name, and summary into a template string", () => {
    const result = embeddingText("Auth Module", "module", "Handles JWT validation");
    expect(result).toBe("module: Auth Module — Handles JWT validation");
  });

  it("works with empty summary", () => {
    const result = embeddingText("Config", "config", "");
    expect(result).toBe("config: Config — ");
  });
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const vec = mockEmbedding([1, 2, 3, 4]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = mockEmbedding([1, 0, 0, 0]);
    const b = mockEmbedding([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = mockEmbedding([1, 0, 0]);
    const b = mockEmbedding([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0.0 when one vector is all zeros", () => {
    const a = mockEmbedding([1, 2, 3]);
    const b = mockEmbedding([0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    const a = mockEmbedding([1, 2, 3]);
    const b = mockEmbedding([1, 2]);
    expect(() => cosineSimilarity(a, b)).toThrow("Embedding dimension mismatch");
  });

  it("computes correct similarity for known vectors", () => {
    // cos([1,1], [1,0]) = 1/sqrt(2) ≈ 0.7071
    const a = mockEmbedding([1, 1]);
    const b = mockEmbedding([1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 4);
  });
});

describe("findTopK", () => {
  const queryEmbedding = mockEmbedding([1, 0, 0]);

  const candidates = [
    { id: "exact", name: "Exact", kind: "feature", summary: "", embedding: mockEmbedding([1, 0, 0]) },
    { id: "similar", name: "Similar", kind: "feature", summary: "", embedding: mockEmbedding([0.9, 0.1, 0]) },
    { id: "orthogonal", name: "Orthogonal", kind: "feature", summary: "", embedding: mockEmbedding([0, 1, 0]) },
    { id: "opposite", name: "Opposite", kind: "feature", summary: "", embedding: mockEmbedding([-1, 0, 0]) },
    { id: "no-embedding", name: "None", kind: "feature", summary: "", embedding: null },
  ];

  it("returns results sorted by similarity descending", () => {
    const results = findTopK(queryEmbedding, candidates, 10);
    expect(results[0].id).toBe("exact");
    expect(results[0].similarity).toBeCloseTo(1.0, 4);
    expect(results[1].id).toBe("similar");
    expect(results[results.length - 1].id).toBe("opposite");
  });

  it("respects the topK limit", () => {
    const results = findTopK(queryEmbedding, candidates, 2);
    expect(results).toHaveLength(2);
  });

  it("filters out candidates with null embeddings", () => {
    const results = findTopK(queryEmbedding, candidates, 10);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("no-embedding");
  });

  it("returns empty array for empty candidates", () => {
    const results = findTopK(queryEmbedding, [], 5);
    expect(results).toEqual([]);
  });

  it("filters out candidates with zero-length embedding buffers", () => {
    const candidatesWithEmpty = [
      { id: "valid", name: "Valid", kind: "feature", summary: "", embedding: mockEmbedding([1, 0, 0]) },
      { id: "empty-buf", name: "Empty", kind: "feature", summary: "", embedding: Buffer.alloc(0) },
      { id: "null-emb", name: "Null", kind: "feature", summary: "", embedding: null },
    ];
    const results = findTopK(queryEmbedding, candidatesWithEmpty, 10);
    const ids = results.map((r) => r.id);
    expect(ids).toEqual(["valid"]);
    expect(ids).not.toContain("empty-buf");
    expect(ids).not.toContain("null-emb");
  });
});
