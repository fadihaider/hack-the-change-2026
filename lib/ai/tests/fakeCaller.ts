// fake model caller: returns a recorded response and keeps the request for assertions
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { ModelCaller } from "../model";

export interface FakeReply {
  text?: string;
  stopReason?: Message["stop_reason"];
  category?: string;
}

export function fakeCaller(reply: FakeReply): { caller: ModelCaller; requests: MessageCreateParamsNonStreaming[] } {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const caller: ModelCaller = async (params) => {
    requests.push(params);
    const message = {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: params.model,
      content: reply.text === undefined ? [] : [{ type: "text", text: reply.text, citations: null }],
      stop_reason: reply.stopReason ?? "end_turn",
      stop_sequence: null,
      stop_details: reply.category ? { type: "refusal", category: reply.category, explanation: null } : null,
      usage: { input_tokens: 120, output_tokens: 45 },
    };
    return message as unknown as Message;
  };
  return { caller, requests };
}
