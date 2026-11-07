import "server-only";
import { createHash } from "node:crypto";
import { WorkflowError } from "./workflow.ts";
import type { RequestRecord, RequestTransaction, WorkflowStore } from "./workflow.ts";

export class ApprovalPreconditionError extends Error {
  readonly code: "precondition_required" | "stale_request";
  readonly status: 428 | 412;

  constructor(code: ApprovalPreconditionError["code"]) {
    super(code);
    this.code = code;
    this.status = code === "precondition_required" ? 428 : 412;
  }
}

/** Preview precondition only; approval evidence still uses state.approvalHash. */
export function approvalRevision(request: RequestRecord): string {
  // Canonical field boundaries prevent a newline in one field from being
  // confused with a newline in another. Never hash client-supplied content.
  return createHash("sha256").update(JSON.stringify([
    "approval-preview-v1", request.id, request.userId, request.state,
    request.recipientEmail, request.subject, request.body, request.disclosureTier,
    request.respondBy?.toISOString() ?? null, request.healthOverride,
  ])).digest("hex");
}

/** Require exactly one strong quoted validator from the rendered RequestView. */
export function requireApprovalRevision(request: RequestRecord, ifMatch: string | null): void {
  if (ifMatch === null || !ifMatch.trim()) throw new ApprovalPreconditionError("precondition_required");
  if (ifMatch.trim() !== `"${approvalRevision(request)}"`) {
    throw new ApprovalPreconditionError("stale_request");
  }
}

/**
 * Run the approval health checks, override audit and transition in this callback.
 * Do not release the transaction/row lock between checking and writing approval.
 * The durable adapter must also serialize recipient/group edits that affect the
 * loaded content. This helper supplies no authorization bypass or live store.
 */
export async function withCurrentApproval<T>(input: {
  userId: string;
  requestId: string;
  ifMatch: string | null;
  store: WorkflowStore;
}, approve: (tx: RequestTransaction) => Promise<T>): Promise<T> {
  return input.store.withOwnedRequest(input.userId, input.requestId, async (tx) => {
    if (tx.request.userId !== input.userId || tx.request.id !== input.requestId) {
      throw new WorkflowError("not_found");
    }
    requireApprovalRevision(tx.request, input.ifMatch);
    if (tx.request.state !== "awaiting_approval") throw new WorkflowError("state_conflict");
    return approve(tx);
  });
}
