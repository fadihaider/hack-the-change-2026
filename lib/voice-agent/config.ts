import "server-only";
import { Workflow, type ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { RELIEFREADY_VOICE_SYSTEM_PROMPT } from "./prompt.ts";

export const VOICE_AGENT_NAME = "ReliefReady — private voice workflow foundation";
export const VOICE_AGENT_TAG = "reliefready-issue-27";
/** Non-secret ID; the private agent still requires an authenticated signed session. */
export const HOSTED_VOICE_AGENT_ID = "agent_6401m6w6da4afmc8q86d9pa3s494";
// Stock voice from the official skill. No cloning or voice-library changes.
export const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
type AgentCreateRequest = Parameters<ElevenLabsClient["conversationalAi"]["agents"]["create"]>[0];

/** A finite navigation graph. LLM routing never grants access or executes actions. */
export function buildHostedVoiceWorkflow() {
  const workflow = new Workflow({ preventSubagentLoops: true });
  const route = workflow.converse("choose_path", "Ask which single app path the person wants. Do not collect personal care content; explain that app tools are not connected.", {
    label: "Choose one app path", toolIds: [], entryBehavior: "wait_for_user", position: { x: 0, y: 200 },
  });
  const paths = [
    ["urgent_intake", "The person explicitly wants help with an urgent caregiving disruption.", "Explain the Urgent intake path. The app uses Scribe v2 then validated A1 extraction. Exact dates must be clarified before proceeding. Do not save anything or start an impact scan.", -450],
    ["care_note", "The person explicitly wants to add a care note or routine.", "Explain the Care note path. Only the app's batch transcription/A4 flow can create suggested facts for review. Do not collect real records, invent instructions or approve facts.", -150],
    ["profile_question", "The person explicitly wants to ask an approved care-profile question.", "Profile access is not connected here. Direct to the app's approved-profile question flow. Do not answer from general knowledge or invent facts/citations. Medical answers use exact approved text through direct TTS outside this conversation.", 150],
    ["review_in_app", "The person wants read aloud, Recover, approval, sending, another action, or cannot choose a supported path.", "Explain the relevant app screen. Read aloud uses user-selected approved text and direct Flash v2.5; Recover uses recorded evidence. Do not claim any record, state, approval, send or playback occurred. Unsupported actions and missing integrations are unavailable here.", 450],
  ] as const;
  for (const [id, condition, prompt, x] of paths) {
    route.when(condition).converse(id, prompt, {
      label: id.replaceAll("_", " "), toolIds: [], entryBehavior: "generate_immediately", position: { x, y: 400 },
    }).when("The app path has been explained, the person is ready to continue in the app, or the person wants to stop.").end({ id: "end", position: { x: 0, y: 650 } });
  }
  return workflow.build();
}

/** Optional P1 configuration, disconnected from product data and not embedded publicly. */
export function buildVoiceAgentConfig(voiceId = DEFAULT_VOICE_ID): AgentCreateRequest {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(voiceId)) throw new Error("invalid_voice_id");
  return {
    name: VOICE_AGENT_NAME,
    tags: [VOICE_AGENT_TAG, "private", "fictional-data-only", "foundation"],
    conversationConfig: {
      agent: {
        firstMessage: "I'm ReliefReady's AI companion for a fictional demo. App actions are not connected here. Would you like the urgent intake, care note, profile question, or review path?",
        language: "en",
        prompt: {
          prompt: RELIEFREADY_VOICE_SYSTEM_PROMPT,
          // This optional navigation layer does not replace the project's Bedrock A1–A6 model.
          llm: "gpt-oss-120b", temperature: 0, maxTokens: 400,
          enableParallelToolCalls: false, tools: [], toolIds: [], knowledgeBase: [],
          mcpServerIds: [], nativeMcpServerIds: [],
          builtInTools: { endCall: { type: "system", name: "end_call", params: { systemToolType: "end_call" } } },
        },
      },
      asr: { provider: "scribe_realtime", quality: "high" },
      // Agents currently accepts v4 Turbo here; direct PRD read-aloud remains Flash v2.5.
      tts: { voiceId, modelId: "eleven_v4_turbo" },
      turn: { turnEagerness: "patient", silenceEndCallTimeout: 30 },
      conversation: {
        maxDurationSeconds: 180, monitoringEnabled: false,
        clientEvents: ["user_transcript", "agent_response", "audio"],
        fileInput: { enabled: false },
      },
    },
    platformSettings: {
      auth: { enableAuth: true },
      callLimits: { agentConcurrencyLimit: 1, dailyLimit: 10, burstingEnabled: false },
      queueingConfig: { enabled: false },
      privacy: {
        recordVoice: false, retentionDays: 0,
        deleteTranscriptAndPii: true, deleteAudio: true, zeroRetentionMode: false,
      },
      overrides: {
        conversationConfigOverride: { conversation: { textOnly: false } },
        enableStartingWorkflowNodeIdFromClient: false,
        enableProcedureIdsFromClient: false,
        enableConversationInitiationClientDataFromWebhook: false,
        customLlmExtraBody: false,
      },
      guardrails: {
        version: "1", focus: { isEnabled: true }, promptInjection: { isEnabled: true },
        custom: { config: { configs: [
          {
            name: "No clinical interpretation", isEnabled: true, executionMode: "blocking",
            model: "gemini-3.1-flash-lite", historyMessageCount: 1,
            prompt: "Block diagnoses, clinical advice, dose calculations, generated medication schedules, paraphrased medical instructions, or answers from an unconnected care profile. Allow directing health questions to 811 and emergencies to 911.",
            triggerAction: { type: "end_call" },
          },
          {
            name: "No unsupported action claims", isEnabled: true, executionMode: "blocking",
            model: "gemini-3.1-flash-lite", historyMessageCount: 1,
            prompt: "Block claims of saving, approving, sending, accepting, completing, recording a response, granting access, or modifying data. This foundation deployment has no business-data tools. Allow explaining app screens and saying an operation is unavailable.",
            triggerAction: { type: "end_call" },
          },
        ] } },
      },
    },
    workflow: buildHostedVoiceWorkflow(),
  };
}
