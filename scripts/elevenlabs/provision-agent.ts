import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createElevenLabsSdkClient, PROVISION_REQUEST_OPTIONS } from "../../lib/voice-agent/client.ts";
import { buildVoiceAgentConfig, VOICE_AGENT_NAME, VOICE_AGENT_TAG } from "../../lib/voice-agent/config.ts";
import { VOICE_PROMPT_VERSION } from "../../lib/voice-agent/prompt.ts";
import { assertProvisionedVoiceFoundation } from "../../lib/voice-agent/verify.ts";

// This file contains IDs/configuration only. Credentials remain in the environment.
const receiptPath = resolve(".board/elevenlabs-agent.json");
const mode = process.argv[2] ?? "--preview";
const desired = buildVoiceAgentConfig(process.env.ELEVENLABS_VOICE_ID || undefined);
type Receipt = { agentId: string; name: string; tag: string; promptVersion: string; verified: boolean };

async function readReceipt(): Promise<Receipt | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("agentId" in parsed)
      || typeof parsed.agentId !== "string" || !("tag" in parsed) || parsed.tag !== VOICE_AGENT_TAG) {
      throw new Error("invalid_agent_receipt");
    }
    return parsed as Receipt;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw new Error("invalid_agent_receipt");
  }
}

async function main() {
  if (mode === "--preview") {
    console.log(JSON.stringify({
      mode: "preview", name: desired.name, promptVersion: VOICE_PROMPT_VERSION,
      configurationSha256: createHash("sha256").update(JSON.stringify(desired)).digest("hex"),
      workflowNodes: Object.keys(desired.workflow?.nodes ?? {}),
      businessTools: 0, private: true, audioRecording: false, retentionDays: 0,
      note: "No API calls or conversations. --create provisions a private foundation; --verify checks its receipt.",
    }));
    return;
  }
  if (mode !== "--create" && mode !== "--verify") throw new Error("invalid_provision_mode");
  const client = createElevenLabsSdkClient();
  let receipt = await readReceipt();
  if (!receipt && mode === "--verify") throw new Error("agent_receipt_missing");
  if (!receipt) {
    // Establish mandatory privacy/auth/cost controls before adding optional graph/guardrails.
    // No session token is issued at either stage. A failed update leaves a private agent.
    const created = await client.conversationalAi.agents.create({
      name: desired.name, tags: desired.tags,
      conversationConfig: {
        agent: {
          firstMessage: "Setup is incomplete. Please continue in the app.", language: "en",
          prompt: {
            prompt: "This is a private configuration draft. Say setup is incomplete and direct the person to the app. Do not collect personal data, answer clinical questions, perform actions or claim success.",
            llm: "gpt-oss-120b", maxTokens: 100, temperature: 0,
            tools: [], toolIds: [], knowledgeBase: [], mcpServerIds: [], nativeMcpServerIds: [],
          },
        },
        conversation: { maxDurationSeconds: 60, monitoringEnabled: false, fileInput: { enabled: false } },
      },
      platformSettings: {
        auth: desired.platformSettings?.auth, privacy: desired.platformSettings?.privacy,
        callLimits: desired.platformSettings?.callLimits, queueingConfig: desired.platformSettings?.queueingConfig,
      },
    }, PROVISION_REQUEST_OPTIONS);
    receipt = { agentId: created.agentId, name: VOICE_AGENT_NAME, tag: VOICE_AGENT_TAG, promptVersion: VOICE_PROMPT_VERSION, verified: false };
    await mkdir(dirname(receiptPath), { recursive: true });
    // Record the new ID before verification. Never retry an ambiguous create automatically.
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  let actual = await client.conversationalAi.agents.get(receipt.agentId, {}, PROVISION_REQUEST_OPTIONS);
  if (actual.name !== VOICE_AGENT_NAME || !actual.tags?.includes(VOICE_AGENT_TAG)) throw new Error("agent_configuration_mismatch");
  if (mode === "--create" && !receipt.verified) {
    await client.conversationalAi.agents.update(receipt.agentId, desired, PROVISION_REQUEST_OPTIONS);
    actual = await client.conversationalAi.agents.get(receipt.agentId, {}, PROVISION_REQUEST_OPTIONS);
  }
  assertProvisionedVoiceFoundation(actual, desired);
  receipt.verified = true;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...receipt, businessTools: 0, audioRecording: false, retentionDays: 0, conversationsStarted: 0 }));
}

main().catch((error: unknown) => {
  // Provider bodies can contain sensitive data. Print only fixed local codes or HTTP status.
  const localCodes = new Set(["invalid_agent_receipt", "invalid_provision_mode", "speech_not_configured", "agent_receipt_missing", "agent_configuration_mismatch"]);
  const code = error instanceof Error && localCodes.has(error.message) ? error.message : "agent_provision_failed";
  const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
  const body = error && typeof error === "object" && "body" in error ? error.body : undefined;
  const detail = body && typeof body === "object" && "detail" in body ? body.detail : undefined;
  const providerCode = detail && typeof detail === "object" && "status" in detail && typeof detail.status === "string" && /^[a-z_]{1,80}$/.test(detail.status) ? detail.status : undefined;
  const validationCode = detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code) ? detail.code : undefined;
  const message = detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string" ? detail.message.toLowerCase() : "";
  const param = detail && typeof detail === "object" && "param" in detail && typeof detail.param === "string" ? detail.param.toLowerCase() : "";
  // Only fixed configuration labels, never provider prose or request data.
  const validationFields = ["guardrail", "model", "workflow", "voice", "retention", "privacy", "limit", "concurrency", "queue", "auth", "override", "tool", "transcript", "audio", "duration", "event", "name", "tag", "asr", "conversation_config", "platform_settings"].filter((field) => message.includes(field) || param.includes(field));
  console.error(JSON.stringify({ error: code, status, providerCode, validationCode, validationFields, instruction: "Do not repeat an ambiguous create. Inspect the local receipt or the named agent in the dashboard; never print credentials or provider bodies." }));
  process.exitCode = 1;
});
