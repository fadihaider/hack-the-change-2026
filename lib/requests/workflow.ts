import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { approvalHash, responseState } from "../state.ts";
import type { ApprovedContent, EvidenceKind, RequestState, ResponseChoice } from "../state.ts";

export interface RequestRecord extends ApprovedContent {
  id: string;
  userId: string;
  state: RequestState;
  healthOverride: boolean;
  respondBy: Date | null;
}
export interface Approval { id: string; hash: string }
export interface Transition {
  from: RequestState;
  to: RequestState;
  evidenceKind: EvidenceKind;
  evidenceRef: string;
  actor: "user" | "system" | "recipient";
  respondBy?: Date;
}
export interface StoredToken {
  hash: string;
  choice: ResponseChoice;
  expiresAt: Date;
}
export interface RequestTransaction {
  request: RequestRecord;
  latestApproval: Approval | null;
  transition(change: Transition): Promise<boolean>;
  saveTokens(tokens: StoredToken[]): Promise<void>;
}
export interface ResponseTransaction extends RequestTransaction {
  token: StoredToken;
  consumeAllTokens(): Promise<void>;
  // Must update proposed_at/proposed_note and insert the response commitment atomically.
  saveProposal(proposal: { at: Date; note: string }): Promise<void>;
}

/**
 * The real adapter must use a database transaction + request row lock for both
 * methods. All writes, events and token consumption commit or roll back together.
 * withOwnedRequest scopes request AND contact to the signed-in owner in SQL.
 * withResponseToken locks the same request row and checks token real-time expiry,
 * including used tokens so repeat submissions can show the first recorded answer.
 * Do not ship an in-memory adapter as a live-send store.
 */
export interface WorkflowStore {
  withOwnedRequest<T>(userId: string, requestId: string, work: (tx: RequestTransaction) => Promise<T>): Promise<T>;
  withResponseToken<T>(hash: string, realNow: Date, work: (tx: ResponseTransaction) => Promise<T>): Promise<T>;
}

export class WorkflowError extends Error {
  code: "not_found" | "state_conflict" | "invalid_response" | "invalid_origin";
  constructor(code: WorkflowError["code"]) {
    super(code);
    this.code = code;
  }
}

export function requireSameOrigin(origin: string | null, baseUrl: string): void {
  const expected = new URL(baseUrl).origin;
  if (!origin || origin !== expected) throw new WorkflowError("invalid_origin");
}

export function hashResponseToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new WorkflowError("not_found");
  return createHash("sha256").update(token).digest("hex");
}

export type SendResult =
  | { state: "requested"; messageId: string }
  | { state: "failed"; errorCode: string }
  | { state: "needs_review" };

export async function sendApprovedRequest(input: {
  userId: string;
  requestId: string;
  store: WorkflowStore;
  baseUrl: string;
  appTime: Date;
  findHealthTerms: (subject: string, body: string) => Promise<string[]>;
  send: (message: { userId: string; to: string; subject: string; text: string }) => Promise<{ id: string }>;
}): Promise<SendResult> {
  const base = new URL(input.baseUrl);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) || base.username || base.password) {
    throw new Error("APP_BASE_URL must use HTTPS (localhost HTTP is allowed)");
  }
  if (!Number.isFinite(input.appTime.getTime())) throw new Error("Invalid app clock");

  const prepared = await input.store.withOwnedRequest(input.userId, input.requestId, async (tx) => {
    const request = tx.request;
    if (request.userId !== input.userId) throw new WorkflowError("not_found");
    if (request.state !== "approved") throw new WorkflowError("state_conflict");
    const hits = await input.findHealthTerms(request.subject, request.body);
    const approval = tx.latestApproval;
    const hashMatches = approval && approval.hash === approvalHash(request);
    if (!hashMatches || (request.disclosureTier !== "detailed" && hits.length > 0 && !request.healthOverride)) {
      const changed = await tx.transition({
        from: "approved", to: "needs_review", evidenceKind: "error",
        evidenceRef: hashMatches ? "health term at send" : "approval hash mismatch", actor: "system",
      });
      if (!changed) throw new WorkflowError("state_conflict");
      return null;
    }
    const deadline = request.respondBy ?? new Date(input.appTime.getTime() + 48 * 60 * 60 * 1000);
    if (!Number.isFinite(deadline.getTime())) throw new Error("Invalid response deadline");
    const choices: ResponseChoice[] = ["accept", "decline", "propose"];
    const links = choices.map((choice) => {
      const token = randomBytes(32).toString("base64url");
      return {
        hash: hashResponseToken(token), choice,
        expiresAt: new Date(deadline.getTime() + 7 * 24 * 60 * 60 * 1000),
        url: new URL(`/r/${token}`, base.origin).toString(),
      };
    });
    const changed = await tx.transition({
      from: "approved", to: "sending", evidenceKind: "approval", evidenceRef: approval!.id, actor: "system",
    });
    if (!changed) throw new WorkflowError("state_conflict");
    // Raw tokens exist only in the outgoing message; the store sees hashes.
    await tx.saveTokens(links.map(({ hash, choice, expiresAt }) => ({ hash, choice, expiresAt })));
    return {
      deadline,
      message: {
        userId: request.userId, to: request.recipientEmail, subject: request.subject,
        text: `${request.body}\n\nRespond (each link asks you to confirm):\nAccept: ${links[0].url}\nDecline: ${links[1].url}\nPropose another time: ${links[2].url}\n`,
      },
    };
  });
  if (!prepared) return { state: "needs_review" };

  let sent: { id: string };
  try {
    // Never retry a Gmail send automatically: an ambiguous failure may have sent.
    sent = await input.send(prepared.message);
    if (!sent.id) throw new Error("missing_message_id");
  } catch {
    // Never store provider error bodies: they can include addresses or OAuth data.
    const errorCode = "gmail_send_failed";
    await input.store.withOwnedRequest(input.userId, input.requestId, async (tx) => {
      if (!await tx.transition({ from: "sending", to: "failed", evidenceKind: "error", evidenceRef: errorCode, actor: "system" })) {
        throw new WorkflowError("state_conflict");
      }
    });
    return { state: "failed", errorCode };
  }
  await input.store.withOwnedRequest(input.userId, input.requestId, async (tx) => {
    if (!await tx.transition({
      from: "sending", to: "requested", evidenceKind: "gmail_message_id", evidenceRef: sent.id,
      actor: "system", respondBy: prepared.deadline,
    })) throw new WorkflowError("state_conflict");
  });
  // A post-send database failure propagates, leaving sending for reconciliation.
  return { state: "requested", messageId: sent.id };
}

/** POST-only service. A landing-page GET must only read its token/request. */
export async function confirmResponse(input: {
  token: string;
  proposal?: { at: string; note?: string };
  store: WorkflowStore;
  realNow: Date;
}): Promise<{ state: RequestState; recorded: boolean }> {
  const hash = hashResponseToken(input.token);
  return input.store.withResponseToken(hash, input.realNow, async (tx) => {
    if (tx.token.expiresAt <= input.realNow) throw new WorkflowError("not_found");
    if (tx.request.state !== "requested") return { state: tx.request.state, recorded: false };
    if (tx.token.choice !== "propose" && input.proposal !== undefined) throw new WorkflowError("invalid_response");
    let proposal: { at: Date; note: string } | undefined;
    if (tx.token.choice === "propose") {
      // Require an explicit offset so browser/server time zones cannot disagree.
      const at = input.proposal?.at ?? "";
      const note = input.proposal?.note ?? "";
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at)) || [...note].length > 300) {
        throw new WorkflowError("invalid_response");
      }
      proposal = { at: new Date(at), note };
    }
    const next = responseState(tx.token.choice);
    if (!await tx.transition({ from: "requested", to: next, evidenceKind: "link_click", evidenceRef: hash, actor: "recipient" })) {
      throw new WorkflowError("state_conflict");
    }
    if (proposal) await tx.saveProposal(proposal);
    await tx.consumeAllTokens();
    return { state: next, recorded: true };
  });
}
