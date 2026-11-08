// optional Gemini API caller for RR_AI=gemini, so the app can run on a Gemini key if Claude is unavailable.
// it translates the Messages API shape our steps use into a generateContent request and back, so callStructured
// keeps every code guard: stop_reason check, JSON parse and zod validation of the returned text.
// unverified against the live API: no Gemini key existed when this was written; tests use an injected fake fetch.
// no "server-only" import so node tests can load it; provider.ts (server-only) is the only app entry point, and
// GEMINI_API_KEY has no NEXT_PUBLIC_ prefix, so Next never inlines it into a browser bundle.
import { z } from "zod";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { ModelCallError, type ModelCaller, type StepDeps } from "./model.ts";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** the embedding width the care_fact and resource vector(1024) columns expect */
export const GEMINI_EMBED_DIMS = 1024;

/** batchEmbedContents accepts at most 100 requests per call */
const EMBED_BATCH_SIZE = 100;

const DEFAULT_TIMEOUT_MS = 120_000;

/** model ids go into the URL path, so only plain ids are accepted (an optional "models/" prefix is dropped) */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiOptions {
  /** GEMINI_API_KEY; sent only in the x-goog-api-key header, never in the URL */
  apiKey: string;
  /** test seam; defaults to the global fetch */
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** RR_AI=gemini without GEMINI_API_KEY or GEMINI_MODEL; a ModelCallError so callStructured passes it on unchanged */
export class GeminiNotConfiguredError extends ModelCallError {
  constructor(readonly missing: "GEMINI_API_KEY" | "GEMINI_MODEL" | "GEMINI_EMBED_MODEL") {
    super(null, "not_configured");
    this.name = "GeminiNotConfiguredError";
  }
}

/** the model id from env or a request, or null when it is missing or not a plain id */
export function geminiModelId(value: string | undefined): string | null {
  const id = (value ?? "").trim().replace(/^models\//, "");
  return MODEL_ID.test(id) ? id : null;
}

/** process.env or a plain object in tests */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface GeminiEnv {
  apiKey: string | null;
  model: string | null;
  embedModel: string | null;
}

/** GEMINI_MODEL and GEMINI_EMBED_MODEL are required; there is no guessed default model name */
export function readGeminiEnv(env: EnvSource = process.env): GeminiEnv {
  const apiKey = env.GEMINI_API_KEY?.trim() || null;
  return { apiKey, model: geminiModelId(env.GEMINI_MODEL), embedModel: geminiModelId(env.GEMINI_EMBED_MODEL) };
}

export function geminiConfigured(env: EnvSource = process.env): boolean {
  const config = readGeminiEnv(env);
  return config.apiKey !== null && config.model !== null;
}

// error classes match what the Anthropic SDK reports, so every adapter fails the same way (503 model_unavailable)
const STATUS_CODES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  503: "overloaded_error",
  504: "timeout_error",
};

/** status and a fixed code only; the provider's response body can echo the request, so it is never read */
function httpError(status: number): ModelCallError {
  return new ModelCallError(status, STATUS_CODES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error"));
}

function connectionError(error: unknown): ModelCallError {
  // the same codes the Anthropic SDK reports; the error message can hold host names, so it is dropped
  const name = error instanceof Error ? error.name : "";
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return new ModelCallError(null, timedOut ? "APIConnectionTimeoutError" : "APIConnectionError");
}

/** one POST with the key in a header; network failures and non-2xx answers become ModelCallError */
async function postJson(url: string, body: unknown, options: GeminiOptions): Promise<unknown> {
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw connectionError(error);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw httpError(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new ModelCallError(response.status, "invalid_response");
  }
}

type Params = MessageCreateParamsNonStreaming;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function toSystemText(system: Params["system"]): string | undefined {
  if (system === undefined) {
    return undefined;
  }
  return typeof system === "string" ? system : system.map((block) => block.text).join("\n");
}

function toParts(content: Params["messages"][number]["content"]): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  const parts: GeminiPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    } else if (block.type === "document" && block.source.type === "base64" && block.source.media_type === "application/pdf") {
      parts.push({ inlineData: { mimeType: "application/pdf", data: block.source.data } });
    } else {
      throw new ModelCallError(null, "unsupported_content_block");
    }
  }
  return parts;
}

// JSON Schema keywords Gemini's responseJsonSchema documents; anything else is dropped from the hint only.
// the full zod schema still validates the answer in callStructured, so a dropped keyword never weakens a guard
const SCHEMA_KEYWORDS = new Set([
  "$ref", "$defs", "type", "format", "title", "description", "enum", "items", "prefixItems", "minItems", "maxItems",
  "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering",
]);

/** the step's JSON schema, reduced to keywords Gemini accepts; property and $defs names are kept as they are */
export function toGeminiSchema(schema: unknown, keepAllKeys = false): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => toGeminiSchema(item));
  }
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (keepAllKeys) {
      out[key] = toGeminiSchema(value);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = toGeminiSchema(value, key === "properties" || key === "$defs");
    }
  }
  return out;
}

const GenerateResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      toolUsePromptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
    })
    .optional(),
  responseId: z.string().optional(),
});

type GenerateResponse = z.infer<typeof GenerateResponse>;

const REFUSAL_REASONS = new Set(["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

function toStopReason(response: GenerateResponse): Message["stop_reason"] {
  const candidate = response.candidates?.[0];
  if (candidate === undefined) {
    // a blocked prompt comes back with promptFeedback.blockReason and no candidates
    return response.promptFeedback?.blockReason ? "refusal" : "pause_turn";
  }
  const reason = candidate.finishReason ?? "";
  if (reason === "STOP") {
    return "end_turn";
  }
  if (reason === "MAX_TOKENS") {
    return "max_tokens";
  }
  // anything else (tool calls, OTHER, an unknown reason) is not a clean structured answer, so it needs review
  return REFUSAL_REASONS.has(reason) ? "refusal" : "pause_turn";
}

/**
 * builds the generateContent request for one structured step. effort is not sent: Gemini's thinking controls differ
 * by model generation (thinkingBudget or thinkingLevel), and a field the chosen model doesn't support is a 400.
 */
export function toGenerateRequest(params: Params): Record<string, unknown> {
  const format = params.output_config?.format;
  const system = toSystemText(params.system);
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: params.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: toParts(message.content),
    })),
    generationConfig: {
      maxOutputTokens: params.max_tokens,
      ...(format ? { responseMimeType: "application/json", responseJsonSchema: toGeminiSchema(format.schema) } : {}),
    },
  };
}

/** ModelCaller over the Gemini REST API; params.model is the Gemini model id (GEMINI_MODEL) */
export function geminiCaller(options: GeminiOptions): ModelCaller {
  return async (params) => {
    const model = geminiModelId(params.model);
    if (model === null) {
      throw new GeminiNotConfiguredError("GEMINI_MODEL");
    }
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const raw = await postJson(url, toGenerateRequest(params), options);
    const parsed = GenerateResponse.safeParse(raw);
    if (!parsed.success) {
      throw new ModelCallError(200, "invalid_response");
    }
    const response = parsed.data;
    // thought summaries only come back when asked for, but are skipped anyway so only the answer is parsed
    const text = (response.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? "")
      .join("");
    const usage = response.usageMetadata ?? {};
    const message = {
      id: response.responseId ?? "gemini",
      type: "message",
      role: "assistant",
      model: params.model,
      content: text.length > 0 ? [{ type: "text", text, citations: null }] : [],
      stop_reason: toStopReason(response),
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
        // thinking tokens are billed as output, so the spend log counts them too
        output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      },
    };
    return message as unknown as Message;
  };
}

/**
 * StepDeps for RR_AI=gemini. a missing GEMINI_API_KEY or GEMINI_MODEL is reported when a step runs (like a missing
 * ANTHROPIC_API_KEY), as GeminiNotConfiguredError: never a silent fallback to the demo rules
 */
export function geminiDeps(
  onUsage?: StepDeps["onUsage"],
  env: EnvSource = process.env,
  fetchImpl?: FetchLike,
): StepDeps {
  const { apiKey, model } = readGeminiEnv(env);
  if (apiKey === null || model === null) {
    const missing = apiKey === null ? "GEMINI_API_KEY" : "GEMINI_MODEL";
    const caller: ModelCaller = async () => {
      throw new GeminiNotConfiguredError(missing);
    };
    // the placeholder only labels the quota row; this caller never sends a request
    return { caller, model: "gemini-not-configured", onUsage };
  }
  return { caller: geminiCaller({ apiKey, fetch: fetchImpl }), model, onUsage };
}

export type GeminiEmbedTask = "document" | "query";

/** same shape as the other embedders: a model id, a fixed width and a batch embed */
export interface GeminiEmbedder {
  model: string;
  dims: typeof GEMINI_EMBED_DIMS;
  /** one vector per text, in order; task defaults to "document" (stored facts), use "query" for questions */
  embed(texts: string[], task?: GeminiEmbedTask): Promise<number[][]>;
}

export interface GeminiEmbedderOptions {
  env?: EnvSource;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const EmbedResponse = z.object({ embeddings: z.array(z.object({ values: z.array(z.number()) })) });

/** unit length, so cosine and inner-product search agree; Gemini only normalizes its full-width output */
function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? values.map((value) => value / norm) : values;
}

/**
 * Gemini embeddings at 1,024 dimensions through batchEmbedContents (GEMINI_EMBED_MODEL, outputDimensionality 1024).
 * UNVERIFIED: written without a key; check one real call returns 1,024 numbers before switching retrieval to it.
 * throws GeminiNotConfiguredError when GEMINI_API_KEY or GEMINI_EMBED_MODEL is missing
 */
export function createGeminiEmbedder(options: GeminiEmbedderOptions = {}): GeminiEmbedder {
  const config = readGeminiEnv(options.env ?? process.env);
  if (config.apiKey === null) {
    throw new GeminiNotConfiguredError("GEMINI_API_KEY");
  }
  if (config.embedModel === null) {
    throw new GeminiNotConfiguredError("GEMINI_EMBED_MODEL");
  }
  const model = config.embedModel;
  const request: GeminiOptions = { apiKey: config.apiKey, fetch: options.fetch, timeoutMs: options.timeoutMs };
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`;
  return {
    model,
    dims: GEMINI_EMBED_DIMS,
    async embed(texts, task = "document") {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
        const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
        const raw = await postJson(
          url,
          {
            requests: batch.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              taskType: task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
              outputDimensionality: GEMINI_EMBED_DIMS,
            })),
          },
          request,
        );
        const parsed = EmbedResponse.safeParse(raw);
        if (!parsed.success || parsed.data.embeddings.length !== batch.length) {
          throw new ModelCallError(200, "invalid_response");
        }
        for (const { values } of parsed.data.embeddings) {
          if (values.length !== GEMINI_EMBED_DIMS || !values.every(Number.isFinite)) {
            throw new ModelCallError(200, "invalid_embedding");
          }
          vectors.push(normalize(values));
        }
      }
      return vectors;
    },
  };
}
