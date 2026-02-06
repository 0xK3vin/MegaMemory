import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

let extractor: FeatureExtractionPipeline | null = null;

/**
 * Initialize the embedding model. Called lazily on first use.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_NAME, {
      quantized: true,
    });
  }
  return extractor;
}

/**
 * Generate an embedding vector for the given text.
 * Returns a Buffer containing float32 values.
 */
export async function embed(text: string): Promise<Buffer> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: "mean", normalize: true });
  const data = output.data as Float32Array;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Generate embedding text from node fields.
 * Combines name, kind, and summary for richer semantic representation.
 */
export function embeddingText(
  name: string,
  kind: string,
  summary: string
): string {
  return `${kind}: ${name} — ${summary}`;
}

/**
 * Compute cosine similarity between two embedding buffers.
 * Both buffers must contain float32 arrays of the same length.
 */
export function cosineSimilarity(a: Buffer, b: Buffer): number {
  const vecA = new Float32Array(
    a.buffer,
    a.byteOffset,
    a.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  const vecB = new Float32Array(
    b.buffer,
    b.byteOffset,
    b.byteLength / Float32Array.BYTES_PER_ELEMENT
  );

  if (vecA.length !== vecB.length) {
    throw new Error(
      `Embedding dimension mismatch: ${vecA.length} vs ${vecB.length}`
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Find the top-K most similar nodes from a list of candidates.
 */
export function findTopK(
  queryEmbedding: Buffer,
  candidates: Array<{
    id: string;
    name: string;
    kind: string;
    summary: string;
    embedding: Buffer | null;
  }>,
  topK: number
): Array<{ id: string; similarity: number }> {
  const scored = candidates
    .filter((c) => c.embedding !== null)
    .map((c) => ({
      id: c.id,
      similarity: cosineSimilarity(queryEmbedding, c.embedding!),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}

export { EMBEDDING_DIM };
