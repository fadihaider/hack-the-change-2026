// model caller for non-Anthropic Bedrock models (Amazon Nova): translates the Messages API shape our steps use
// into the Bedrock Converse API and back, so callStructured and every code guard stay the same
import "server-only";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type Message as ConverseMessage,
} from "@aws-sdk/client-bedrock-runtime";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { ModelCaller } from "./model";

export interface ConverseOptions {
  region: string;
  /** model output cap; requests above it are clamped (Nova Pro accepts at most 10,000 output tokens) */
  maxOutputTokens?: number;
  /** test seam */
  client?: { send(command: ConverseCommand): Promise<ConverseCommandOutput> };
}

type Params = MessageCreateParamsNonStreaming;

function toSystem(system: Params["system"]): { text: string }[] | undefined {
  if (system === undefined) {
    return undefined;
  }
  if (typeof system === "string") {
    return [{ text: system }];
  }
  return system.map((block) => ({ text: block.text }));
}

function toContent(content: Params["messages"][number]["content"]): ContentBlock[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ text: block.text });
    } else if (block.type === "document" && block.source.type === "base64" && block.source.media_type === "application/pdf") {
      // Converse document names allow letters, numbers, spaces, hyphens, parentheses and brackets only
      blocks.push({ document: { format: "pdf", name: "source document", source: { bytes: Buffer.from(block.source.data, "base64") } } });
    } else {
      throw new Error(`converse caller does not support content block type ${block.type}`);
    }
  }
  return blocks;
}

function toStopReason(reason: ConverseCommandOutput["stopReason"]): Message["stop_reason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "content_filtered":
    case "guardrail_intervened":
      return "refusal";
    default:
      // tool_use or an unknown reason: not a clean structured answer, so callStructured treats it as needs-review
      return "pause_turn";
  }
}

export function converseCaller(options: ConverseOptions): ModelCaller {
  const client = options.client ?? new BedrockRuntimeClient({ region: options.region });
  return async (params) => {
    const format = params.output_config?.format;
    const maxTokens = Math.min(params.max_tokens, options.maxOutputTokens ?? params.max_tokens);
    const response = await client.send(
      new ConverseCommand({
        modelId: params.model,
        system: toSystem(params.system),
        messages: params.messages.map((message): ConverseMessage => ({ role: message.role, content: toContent(message.content) })),
        inferenceConfig: { maxTokens },
        outputConfig: format
          ? {
              textFormat: {
                type: "json_schema",
                structure: { jsonSchema: { name: "step_output", schema: JSON.stringify(format.schema) } },
              },
            }
          : undefined,
      }),
    );
    const text = (response.output?.message?.content ?? [])
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("");
    const message = {
      id: response.$metadata.requestId ?? "converse",
      type: "message",
      role: "assistant",
      model: params.model,
      content: text.length > 0 ? [{ type: "text", text, citations: null }] : [],
      stop_reason: toStopReason(response.stopReason),
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: response.usage?.inputTokens ?? 0, output_tokens: response.usage?.outputTokens ?? 0 },
    };
    return message as unknown as Message;
  };
}
