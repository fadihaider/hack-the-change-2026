// one structured model call with the checks every step needs (IMPLEMENTATION section 2 and 6)
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { AutoParseableOutputFormat } from "@anthropic-ai/sdk/lib/parser";

export const DEFAULT_MODEL = "anthropic.claude-opus-5-5";

/** sends one non-streaming Messages API request; the Bedrock caller lives in bedrock.ts, tests inject a fake */
export type ModelCaller = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

export type StepName = "intake" | "impact" | "drafter" | "care_compiler" | "profile_qa" | "resource_composer";

/** usage record for the llm_call table; ids and counts only, never prompt or output text */
export interface UsageRecord {
  step: StepName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface StepDeps {
  caller: ModelCaller;
  model?: string;
  onUsage?: (usage: UsageRecord) => void | Promise<void>;
}

/** the model output can't be trusted for this request; the UI shows "needs review" and nothing changes state */
export class NeedsReviewError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NeedsReviewError";
    this.code = code;
  }
}

/**
 * the model call itself failed (network, auth, throttling, a 4xx or 5xx). Carries only the HTTP status and an
 * error code, because SDK errors hold the provider's response body and headers (IMPLEMENTATION section 6, logging rules)
 */
export class ModelCallError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(status: number | null, code: string) {
    super(`model call failed: ${status ?? "no status"} ${code}`);
    this.name = "ModelCallError";
    this.status = status;
    this.code = code;
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** reduces any caller error to status and code; never keeps the message, body, headers or cause */
export function toModelCallError(error: unknown): ModelCallError {
  if (error instanceof ModelCallError) {
    return error;
  }
  const fields = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const status = typeof fields.status === "number" ? fields.status : null;
  const code = [fields.errorCode, fields.type, fields.name].find(
    (value): value is string => typeof value === "string" && SAFE_CODE.test(value),
  );
  return new ModelCallError(status, code ?? "unknown");
}

export interface StructuredCall<T> {
  step: StepName;
  system: string;
  content: MessageCreateParamsNonStreaming["messages"][number]["content"];
  format: AutoParseableOutputFormat<T>;
  effort: "low" | "medium";
  maxTokens: number;
}

/** non-streaming calls above this make the TypeScript SDK demand streaming (IMPLEMENTATION section 2) */
const MAX_NON_STREAMING_TOKENS = 21_000;

export async function callStructured<T>(call: StructuredCall<T>, deps: StepDeps): Promise<T> {
  if (call.maxTokens > MAX_NON_STREAMING_TOKENS) {
    throw new Error(`max_tokens ${call.maxTokens} exceeds the non-streaming limit ${MAX_NON_STREAMING_TOKENS}`);
  }
  const model = deps.model ?? DEFAULT_MODEL;
  let response: Message;
  try {
    response = await deps.caller({
      model,
      max_tokens: call.maxTokens,
      output_config: { effort: call.effort, format: call.format },
      system: call.system,
      messages: [{ role: "user", content: call.content }],
    });
  } catch (error) {
    throw toModelCallError(error);
  }

  if (deps.onUsage) {
    await deps.onUsage({
      step: call.step,
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      stopReason: response.stop_reason ?? null,
    });
  }

  // a refusal or max_tokens cut-off can leave partial, non-JSON text, so check before parsing
  if (response.stop_reason !== "end_turn") {
    const category = response.stop_details?.category ?? "";
    throw new NeedsReviewError(`stop_${response.stop_reason ?? "unknown"}`, `model stopped: ${response.stop_reason} ${category}`.trim());
  }
  const text = response.content.find((block) => block.type === "text")?.text;
  if (text === undefined) {
    throw new NeedsReviewError("no_text", "model returned no text block");
  }
  try {
    return call.format.parse(text);
  } catch {
    // JSON or schema failure; the message may echo model output, so it is not passed on
    throw new NeedsReviewError("invalid_output", "model output failed schema validation");
  }
}
