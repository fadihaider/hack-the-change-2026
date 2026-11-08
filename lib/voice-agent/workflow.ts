import "server-only";
import { z } from "zod";
import { MAX_AUDIO_BYTES, MAX_SPEECH_CHARACTERS, SpeechIntegrationError } from "../elevenlabs.ts";

const categories = ["routine", "preference", "communication", "mobility", "contacts", "logistics", "medical_instruction"] as const;
const boundedText = z.string().min(1).max(20_000).refine((value) => value.trim().length > 0);
const identifier = z.string().min(1).max(200).refine((value) => value.trim().length > 0);
const source = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: boundedText }).strict(),
  z.object({ type: z.literal("audio"), audio: z.custom<Blob>((value) => value instanceof Blob && value.size > 0 && value.size <= MAX_AUDIO_BYTES) }).strict(),
]);
const requestSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("intake"), source, speak: z.boolean().optional() }).strict(),
  z.object({ intent: z.literal("care_note"), careRecipientId: identifier, source, speak: z.boolean().optional() }).strict(),
  z.object({ intent: z.literal("profile_question"), careRecipientId: identifier, source, speak: z.boolean().optional() }).strict(),
  z.object({ intent: z.literal("read_aloud"), careRecipientId: identifier, factIds: z.array(identifier).min(1).max(20) }).strict(),
]);
const intakeSchema = z.object({
  startDate: z.string().nullable(), endDate: z.string().nullable(),
  recipientAlias: z.string().max(200).nullable(), reasonText: z.string().max(20_000).nullable(),
  helpRequested: z.array(z.string().max(1000)).max(20),
  clarifyingQuestions: z.array(z.string().trim().min(1).max(1000)).max(10),
}).strict();
const factSchema = z.object({
  id: identifier, ownerId: identifier, careRecipientId: identifier,
  category: z.enum(categories), textExact: boundedText, status: z.literal("approved"),
}).strict();
const proposalsSchema = z.array(z.object({ category: z.enum(categories), textExact: boundedText }).strict()).max(100);
const transcriptionSchema = z.object({ transcript: boundedText, cleanup: z.enum(["deleted", "id_not_returned"]) }).strict();
const answerSchema = z.object({ answer: z.string().max(20_000), citedFactIds: z.array(identifier).max(200), notFound: z.boolean() }).strict();

export type VoiceIntent = z.infer<typeof requestSchema>["intent"];
export type ApprovedVoiceFact = z.infer<typeof factSchema>;
export type VoiceIntake = z.infer<typeof intakeSchema>;
export type VoiceCallStep = "stt" | "tts" | "a1" | "a4" | "a5";
export type VoiceErrorCode = "unauthenticated" | "consent_required" | "forbidden" | "invalid_input" | "rate_limited" | "unavailable" | "provider_failed" | "cleanup_failed" | "invalid_model_output" | "invalid_fact" | "workflow_failed";
export class VoiceWorkflowError extends Error {
  constructor(public readonly code: VoiceErrorCode) { super(code); }
}

/** Supplied by the authenticated server boundary, never by tool/model parameters. */
export interface VoiceContext {
  principal: { userId: string } | null;
  today: string;
  timezone: string;
  consent: { processing: boolean; fictionalData: boolean; sendAudioToElevenLabs: boolean; sendTextToElevenLabs: boolean };
}
export interface VoiceCallMetadata {
  userId: string;
  step: VoiceCallStep;
  outcome: "started" | "succeeded" | "failed";
  errorCode?: VoiceErrorCode;
}
export interface SuggestedVoiceFact {
  category: typeof categories[number];
  textExact: string;
  status: "suggested";
  spanStart: number;
  spanEnd: number;
}
export interface VoiceWorkflowDependencies {
  /** Must re-check owner/recipient access on every invocation. Substitute grants are not supported here. */
  authorize(input: { userId: string; intent: VoiceIntent; careRecipientId?: string }): Promise<{ ownerId: string; careRecipientId?: string }>;
  /** Durable, atomic per-user quota reservation; throw VoiceWorkflowError("rate_limited") on denial. */
  rateLimit(input: { userId: string; step: VoiceCallStep }): Promise<void>;
  /** Metadata only. A failed initial write prevents provider/model calls. */
  recordCall(metadata: VoiceCallMetadata): Promise<void>;
  speech: {
    transcribe(audio: Blob): Promise<{ transcript: string; cleanup: "deleted" | "id_not_returned" }>;
    synthesize(text: string): Promise<Uint8Array>;
  };
  /** Adapters must call the existing validated A1/A4/A5 services; no new LLM provider is selected. */
  intake(input: { userId: string; transcript: string; today: string; timezone: string }): Promise<unknown>;
  compileCareNote(input: { userId: string; careRecipientId: string; transcript: string }): Promise<unknown>;
  /** Atomically persist source + suggestions and reconcile conflicts with existing facts.
   * Re-check ownership under the transaction; never create approved facts/events.
   * loadApprovedFacts/read-aloud adapters must also re-check current approval/access. */
  saveSuggestedVoiceNote(input: { userId: string; careRecipientId: string; kind: "voice" | "note"; s3Key: null; fullText: string; facts: SuggestedVoiceFact[] }): Promise<{ sourceId: string }>;
  loadApprovedFacts(input: { userId: string; careRecipientId: string }): Promise<unknown>;
  answerQuestion(input: { userId: string; careRecipientId: string; question: string; facts: ApprovedVoiceFact[] }): Promise<unknown>;
  createOpenQuestion(input: { userId: string; careRecipientId: string; question: string }): Promise<void>;
}
export interface VoiceReply {
  intent: VoiceIntent;
  text: string;
  transcript?: string;
  cleanup?: "deleted" | "id_not_returned";
  status?: "needs_clarification" | "ready_for_review" | "suggested" | "answered" | "not_found";
  intake?: VoiceIntake;
  sourceId?: string;
  suggestedFacts?: SuggestedVoiceFact[];
  citations?: Array<{ factId: string; textExact: string; category: typeof categories[number] }>;
  audio?: Uint8Array;
  speechError?: VoiceErrorCode | "text_too_long";
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: VoiceErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new VoiceWorkflowError(code);
  return result.data;
}
function safeError(error: unknown): VoiceWorkflowError {
  if (error instanceof VoiceWorkflowError) return error;
  if (error instanceof SpeechIntegrationError) {
    if (error.code === "speech_cleanup_failed") return new VoiceWorkflowError("cleanup_failed");
    if (error.code === "speech_rate_limited") return new VoiceWorkflowError("rate_limited");
    if (error.code === "speech_not_configured") return new VoiceWorkflowError("unavailable");
    if (["invalid_audio", "audio_too_large", "invalid_text"].includes(error.code)) return new VoiceWorkflowError("invalid_input");
    return new VoiceWorkflowError("provider_failed");
  }
  return new VoiceWorkflowError("workflow_failed");
}
function validDate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** One explicit task per call. No model-selected routing, loops, retries, approval or send capabilities. */
export function createVoiceWorkflow(dependencies: VoiceWorkflowDependencies) {
  return {
    async execute(rawInput: unknown, context: VoiceContext): Promise<VoiceReply> {
      try {
        const userId = context.principal?.userId;
        if (!userId || !identifier.safeParse(userId).success) throw new VoiceWorkflowError("unauthenticated");
        if (!context.consent?.processing || !context.consent.fictionalData) throw new VoiceWorkflowError("consent_required");
        const input = parse(requestSchema, rawInput, "invalid_input");
        const careRecipientId = "careRecipientId" in input ? input.careRecipientId : undefined;
        const access = await dependencies.authorize({ userId, intent: input.intent, careRecipientId });
        if (access.ownerId !== userId || access.careRecipientId !== careRecipientId) throw new VoiceWorkflowError("forbidden");
        if (input.intent === "intake" && (!validDate(context.today) || !["America/Edmonton", "Etc/GMT+6"].includes(context.timezone))) throw new VoiceWorkflowError("invalid_input");
        const wantsSpeech = input.intent === "read_aloud" || input.speak === true;
        if (wantsSpeech && !context.consent.sendTextToElevenLabs) throw new VoiceWorkflowError("consent_required");
        if ("source" in input && input.source.type === "audio" && !context.consent.sendAudioToElevenLabs) throw new VoiceWorkflowError("consent_required");

        async function call<T>(step: VoiceCallStep, work: () => Promise<T>): Promise<T> {
          await dependencies.rateLimit({ userId: userId!, step });
          await dependencies.recordCall({ userId: userId!, step, outcome: "started" });
          try {
            const value = await work();
            await dependencies.recordCall({ userId: userId!, step, outcome: "succeeded" });
            return value;
          } catch (error) {
            const safe = safeError(error);
            await dependencies.recordCall({ userId: userId!, step, outcome: "failed", errorCode: safe.code });
            throw safe;
          }
        }
        let transcript: string | undefined;
        let cleanup: "deleted" | "id_not_returned" | undefined;
        if ("source" in input) {
          if (input.source.type === "text") transcript = input.source.text;
          else {
            const audio = input.source.audio;
            const result = await call("stt", async () => parse(transcriptionSchema, await dependencies.speech.transcribe(audio), "provider_failed"));
            transcript = result.transcript;
            cleanup = result.cleanup;
          }
        }
        let reply: VoiceReply;
        if (input.intent === "intake") {
          const intake = await call("a1", async () => {
            const result = parse(intakeSchema, await dependencies.intake({ userId, transcript: transcript!, today: context.today, timezone: context.timezone }), "invalid_model_output");
            if (result.reasonText !== null && !transcript!.includes(result.reasonText)) throw new VoiceWorkflowError("invalid_model_output");
            return result;
          });
          const completeDates = validDate(intake.startDate) && validDate(intake.endDate) && intake.startDate <= intake.endDate;
          const needsClarification = !completeDates || intake.clarifyingQuestions.length > 0;
          reply = {
            intent: input.intent, status: needsClarification ? "needs_clarification" : "ready_for_review", intake,
            text: needsClarification ? (intake.clarifyingQuestions.join(" ") || "What start and end dates should I use?") : `Please review the intake for ${intake.startDate} through ${intake.endDate}. Nothing has been sent.`,
          };
        } else if (input.intent === "care_note") {
          const facts = await call("a4", async () => {
            const proposals = parse(proposalsSchema, await dependencies.compileCareNote({ userId, careRecipientId: input.careRecipientId, transcript: transcript! }), "invalid_model_output");
            return proposals.map((fact): SuggestedVoiceFact => {
              const spanStart = transcript!.indexOf(fact.textExact);
              if (spanStart < 0) throw new VoiceWorkflowError("invalid_model_output");
              return { ...fact, status: "suggested", spanStart, spanEnd: spanStart + fact.textExact.length };
            });
          });
          const saved = await dependencies.saveSuggestedVoiceNote({ userId, careRecipientId: input.careRecipientId, kind: input.source.type === "audio" ? "voice" : "note", s3Key: null, fullText: transcript!, facts });
          const sourceId = parse(identifier, saved.sourceId, "workflow_failed");
          reply = { intent: input.intent, status: "suggested", sourceId, suggestedFacts: facts, text: "Care note saved for review. Suggested facts require your approval before they join the care timeline." };
        } else {
          const facts = parse(z.array(factSchema).max(200), await dependencies.loadApprovedFacts({ userId, careRecipientId: input.careRecipientId }), "invalid_fact");
          if (facts.some((fact) => fact.ownerId !== userId || fact.careRecipientId !== input.careRecipientId) || new Set(facts.map((fact) => fact.id)).size !== facts.length) throw new VoiceWorkflowError("invalid_fact");
          let selected: ApprovedVoiceFact[];
          let answer: string;
          if (input.intent === "read_aloud") {
            const ids = new Set(input.factIds);
            selected = input.factIds.map((id) => facts.find((fact) => fact.id === id)!);
            if (ids.size !== input.factIds.length || selected.some((fact) => !fact)) throw new VoiceWorkflowError("invalid_fact");
            answer = selected.map((fact) => fact.textExact).join("\n");
          } else {
            const result = facts.length === 0 ? { answer: "", citedFactIds: [], notFound: true } : await call("a5", async () => {
              const answer = parse(answerSchema, await dependencies.answerQuestion({ userId, careRecipientId: input.careRecipientId, question: transcript!, facts }), "invalid_model_output");
              if (answer.citedFactIds.some((id) => !facts.some((fact) => fact.id === id))) throw new VoiceWorkflowError("invalid_model_output");
              const medical = facts.some((fact) => answer.citedFactIds.includes(fact.id) && fact.category === "medical_instruction");
              if (!answer.notFound && answer.citedFactIds.length > 0 && !medical && !answer.answer.trim()) throw new VoiceWorkflowError("invalid_model_output");
              return answer;
            });
            if (result.notFound || result.citedFactIds.length === 0) {
              await dependencies.createOpenQuestion({ userId, careRecipientId: input.careRecipientId, question: transcript! });
              reply = { intent: input.intent, status: "not_found", text: "Not in profile", citations: [] };
              return await finish(reply);
            }
            selected = [...new Set(result.citedFactIds)].map((id) => facts.find((fact) => fact.id === id)!);
            answer = result.answer;
          }
          if (selected.some((fact) => fact.category === "medical_instruction")) answer = `${selected.map((fact) => fact.textExact).join("\n")}\nFor health questions call 811. Emergencies: 911.`;
          reply = { intent: input.intent, status: "answered", text: answer, citations: selected.map((fact) => ({ factId: fact.id, textExact: fact.textExact, category: fact.category })) };
        }
        return await finish(reply);

        async function finish(result: VoiceReply): Promise<VoiceReply> {
          result = { ...result, ...(transcript === undefined ? {} : { transcript }), ...(cleanup === undefined ? {} : { cleanup }) };
          if (!wantsSpeech) return result;
          if ([...result.text].length > MAX_SPEECH_CHARACTERS) return { ...result, speechError: "text_too_long" };
          try {
            const audio = await call("tts", async () => {
              const generated = await dependencies.speech.synthesize(result.text);
              if (!(generated instanceof Uint8Array) || generated.length === 0) throw new VoiceWorkflowError("provider_failed");
              return generated;
            });
            return { ...result, audio };
          }
          catch (error) { return { ...result, speechError: safeError(error).code }; }
        }
      } catch (error) { throw safeError(error); }
    },
  };
}
