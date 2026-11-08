// real model callers on Amazon Bedrock (IMPLEMENTATION section 2)
// the AWS project is locked to us-east-2, where bedrock-mantle has no Claude, so Claude goes through the Bedrock
// runtime with a US cross-region inference profile (us.anthropic.*), and other models go through Converse
import "server-only";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { converseCaller } from "./converse";
import { DEFAULT_MODEL, toModelCallError, type ModelCaller, type StepDeps } from "./model";

const REGION = process.env.BEDROCK_REGION ?? "us-east-2";

/** Nova Pro accepts at most 10,000 output tokens; Claude steps keep their own max_tokens */
const NOVA_MAX_OUTPUT_TOKENS = 10_000;

export function isAnthropicModel(model: string): boolean {
  return /(^|\.)anthropic\./.test(model);
}

let anthropicClient: AnthropicBedrock | undefined;
let converse: ModelCaller | undefined;

// credentials come from the default AWS chain (the aws login profile locally, the Amplify compute role when deployed)
function callerFor(model: string): ModelCaller {
  if (isAnthropicModel(model)) {
    anthropicClient ??= new AnthropicBedrock({ awsRegion: REGION });
    const client = anthropicClient;
    return (params) => client.messages.create(params);
  }
  converse ??= converseCaller({ region: REGION, maxOutputTokens: NOVA_MAX_OUTPUT_TOKENS });
  return converse;
}

// SDK errors carry the response body and headers, so only status and code leave this module
export const bedrockCaller: ModelCaller = async (params) => {
  try {
    return await callerFor(params.model)(params);
  } catch (error) {
    throw toModelCallError(error);
  }
};

/** BEDROCK_MODEL_ID picks the model: us.anthropic.claude-opus-5-5 (Claude) or us.amazon.nova-pro-v1:0 (fallback) */
export function bedrockDeps(onUsage?: StepDeps["onUsage"]): StepDeps {
  return { caller: bedrockCaller, model: process.env.BEDROCK_MODEL_ID ?? DEFAULT_MODEL, onUsage };
}
