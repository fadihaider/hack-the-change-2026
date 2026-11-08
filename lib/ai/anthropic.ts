// first-party Claude API caller for RR_AI=anthropic. new Anthropic() reads ANTHROPIC_API_KEY from the environment.
// callStructured (model.ts) sets max_tokens, output_config.effort and output_config.format, and checks stop_reason
// (refusal or max_tokens become NeedsReviewError) before it parses anything.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { toModelCallError, type ModelCaller, type StepDeps } from "./model.ts";

export const ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * server-side refusal fallback: on a policy decline the API reruns the same request on the model Anthropic
 * recommends for that decline category, inside the same call. A request the whole chain declines still comes back as
 * stop_reason "refusal". Rate limits, overloads and server errors are never retried this way.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | undefined;

// opus 5.5 always uses adaptive thinking (disabling it is a 400), so no thinking field is sent; effort is the lever
export const anthropicCaller: ModelCaller = async (params) => {
  try {
    client ??= new Anthropic();
    const response = await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
    // non-streaming responses leave out a declined partial, so the text block is the answer of the model that served it
    const iterations = response.usage.iterations ?? [];
    if (iterations.length > 0) {
      // count every attempt, so the spend log never undercounts a call that fell back
      response.usage.input_tokens = iterations.reduce((sum, entry) => sum + entry.input_tokens, 0);
      response.usage.output_tokens = iterations.reduce((sum, entry) => sum + entry.output_tokens, 0);
    }
    // the beta message is a superset of Message; callStructured reads only stop_reason, stop_details, usage and the
    // text block, and treats every stop reason other than end_turn as needs review
    return response as unknown as Message;
  } catch (error) {
    // SDK errors carry the response body and headers, so only status and code leave this module
    throw toModelCallError(error);
  }
};

export function anthropicDeps(onUsage?: StepDeps["onUsage"]): StepDeps {
  return { caller: anthropicCaller, model: ANTHROPIC_MODEL, onUsage };
}
