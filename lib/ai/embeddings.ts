// optional embedding adapter for approved care facts (PRD 7.1). RR_EMBED=off (default) means keyword retrieval only;
// RR_EMBED=bedrock uses Amazon Titan Text Embeddings V2 (1024 dimensions, normalized) through InvokeModel.
// kept free of server-only so pure tests can load it; the AWS SDK is imported lazily, only when bedrock is picked.
// care-fact text leaves the app only when bedrock is switched on; no data-residency claim is made either way.

import { createGeminiEmbedder } from "./gemini.ts";

export type EmbeddingMode = "off" | "bedrock" | "gemini";
type Env = Readonly<Record<string, string | undefined>>;

export const EMBEDDING_DIMENSIONS = 1024;
export const TITAN_EMBED_V2 = "amazon.titan-embed-text-v2:0";

/** one model, fixed 1024 dimensions; vectors come back in input order */
export interface Embedder {
  /** stored next to each vector, so a model change makes old vectors unusable */
  readonly model: string;
  readonly dims: 1024;
  /** task defaults to "document" (stored facts); pass "query" for a question. models without task types ignore it */
  embed(texts: string[], task?: EmbedTask): Promise<number[][]>;
}

export type EmbedTask = "document" | "query";

/** RR_EMBED, defaulting to off; an unknown value also means off, so a typo never sends care text anywhere */
export function embeddingMode(env: Env = process.env): EmbeddingMode {
  const value = (env.RR_EMBED ?? "").trim().toLowerCase();
  return value === "bedrock" || value === "gemini" ? value : "off";
}

/** an error safe to log: status and code only, never the provider message or the text sent */
export class EmbeddingError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(`embedding error: ${code}`);
    this.name = "EmbeddingError";
    this.code = code;
    this.status = status;
  }
}

/** throws unless the vector has 1024 finite numbers; returns the pgvector literal for CAST(:v AS vector) */
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new EmbeddingError("bad_vector");
  }
  return JSON.stringify(vector);
}

/** minimal client surface, so tests can pass a fake */
export interface InvokeClient {
  send(command: unknown): Promise<{ body?: Uint8Array }>;
}

/** Titan Text Embeddings V2: one text per call, body {inputText, dimensions, normalize}, response {embedding} */
export function titanEmbedder(options: { region: string; modelId?: string; client?: InvokeClient; timeoutMs?: number }): Embedder {
  const modelId = options.modelId ?? TITAN_EMBED_V2;
  let client: InvokeClient | undefined = options.client;
  let Command: (new (input: { modelId: string; contentType: string; accept: string; body: string }) => unknown) | undefined;

  async function ready(): Promise<{ client: InvokeClient; Command: NonNullable<typeof Command> }> {
    const sdk = await import("@aws-sdk/client-bedrock-runtime");
    Command ??= sdk.InvokeModelCommand as unknown as NonNullable<typeof Command>;
    // credentials come from the default AWS chain, like lib/ai/bedrock.ts
    client ??= new sdk.BedrockRuntimeClient({
      region: options.region,
      requestHandler: { requestTimeout: options.timeoutMs ?? 8000 },
    }) as unknown as InvokeClient;
    return { client, Command };
  }

  return {
    model: `${modelId}:${EMBEDDING_DIMENSIONS}`,
    dims: EMBEDDING_DIMENSIONS,
    async embed(texts: string[]): Promise<number[][]> {
      const { client: runtime, Command: Invoke } = await ready();
      const vectors: number[][] = [];
      for (const text of texts) {
        let body: Uint8Array | undefined;
        try {
          const response = await runtime.send(
            new Invoke({
              modelId,
              contentType: "application/json",
              accept: "application/json",
              body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
            }),
          );
          body = response.body;
        } catch (error) {
          const meta = (error as { $metadata?: { httpStatusCode?: number }; name?: string }) ?? {};
          throw new EmbeddingError(typeof meta.name === "string" ? meta.name : "invoke_failed", meta.$metadata?.httpStatusCode ?? null);
        }
        let parsed: { embedding?: unknown };
        try {
          parsed = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as { embedding?: unknown };
        } catch {
          throw new EmbeddingError("bad_response");
        }
        const vector = Array.isArray(parsed.embedding) ? (parsed.embedding as number[]) : [];
        toVectorLiteral(vector);
        vectors.push(vector);
      }
      return vectors;
    },
  };
}

/** the embedder for a mode, or null when embeddings are off */
export function createEmbedder(mode: EmbeddingMode, env: Env = process.env): Embedder | null {
  if (mode === "gemini") {
    // unverified until a real key is tried; GEMINI_API_KEY and GEMINI_EMBED_MODEL are required (lib/ai/gemini.ts)
    const gemini = createGeminiEmbedder({ env });
    return { model: gemini.model, dims: EMBEDDING_DIMENSIONS, embed: (texts, task) => gemini.embed(texts, task) };
  }
  if (mode === "bedrock") {
    return titanEmbedder({
      region: env.EMBED_REGION || env.BEDROCK_REGION || "us-east-2",
      modelId: env.EMBED_MODEL_ID || TITAN_EMBED_V2,
    });
  }
  return null;
}

let injected: Embedder | null | undefined;
let cached: { mode: EmbeddingMode; embedder: Embedder | null } | undefined;

/** tests (and later a gemini adapter) can set the embedder; undefined restores the env choice */
export function setEmbedder(embedder: Embedder | null | undefined): void {
  injected = embedder;
}

/** the embedder in use: an injected one, else the RR_EMBED choice (built once per mode) */
export function currentEmbedder(): Embedder | null {
  if (injected !== undefined) return injected;
  const mode = embeddingMode();
  if (!cached || cached.mode !== mode) cached = { mode, embedder: createEmbedder(mode) };
  return cached.embedder;
}

/**
 * currentEmbedder without throwing: null when embeddings are off or the chosen provider is not configured (for
 * example RR_EMBED=gemini without GEMINI_API_KEY or GEMINI_EMBED_MODEL), so Ask falls back to keyword ranking
 */
export function resolveEmbedder(): Embedder | null {
  try {
    return currentEmbedder();
  } catch {
    return null;
  }
}
