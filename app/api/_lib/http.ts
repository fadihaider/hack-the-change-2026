// shared http plumbing for the mvp routes: json responses, error mapping, body limits, session and origin checks
import "server-only";
import { z } from "zod";
import { DatabaseError } from "../../../lib/db.ts";
import { ModelCallError, NeedsReviewError } from "../../../lib/ai/model.ts";
import { getRuntime, NotConfiguredError, type Runtime } from "../../../lib/mvp/runtime.ts";
import type { SessionUser } from "../../../lib/mvp/auth.ts";
import { tooManyRequests, type LimitResult } from "../../../lib/rateLimit.ts";
import { ApprovalPreconditionError } from "../../../lib/requests/approval-revision.ts";
import { requireSameOrigin, WorkflowError } from "../../../lib/requests/workflow.ts";
import { HealthTermsError } from "../../../lib/store/requestQueue.ts";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/** a known failure with a fixed code; never carries provider or database text */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ApiError";
  }
}

/** the model quota said no; answered as 429 with Retry-After */
export class RateLimitedError extends Error {
  constructor(readonly limit: LimitResult) {
    super("rate_limited");
    this.name = "RateLimitedError";
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: SECURITY_HEADERS });
}

export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

function errorJson(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code, ...extra } }, status);
}

const WORKFLOW_STATUS: Record<WorkflowError["code"], number> = {
  not_found: 404,
  state_conflict: 409,
  invalid_response: 400,
  invalid_origin: 403,
};

/** maps every error to {error:{code}}; provider and database messages are never returned or logged */
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return errorJson(error.status, error.code, error.extra);
  if (error instanceof RateLimitedError) return withSecurityHeaders(tooManyRequests(error.limit));
  if (error instanceof HealthTermsError) return errorJson(422, "health_terms", { terms: error.terms });
  if (error instanceof ApprovalPreconditionError) return errorJson(error.status, error.code);
  if (error instanceof WorkflowError) return errorJson(WORKFLOW_STATUS[error.code], error.code);
  if (error instanceof NotConfiguredError) return errorJson(503, "not_configured");
  if (error instanceof DatabaseError && error.code === "not_configured") return errorJson(503, "not_configured");
  if (error instanceof NeedsReviewError) return errorJson(422, "model_needs_review");
  if (error instanceof ModelCallError) return errorJson(503, "model_unavailable");
  // names and safe codes only (IMPLEMENTATION section 6 logging rules)
  const name = error instanceof Error ? error.name : typeof error;
  const code = error instanceof DatabaseError ? error.code : "";
  console.error("[api] unexpected error", name, code);
  return errorJson(503, "temporarily_unavailable");
}

export async function handle(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return errorResponse(error);
  }
}

/** reads a json body with a byte limit on the actual stream, like lib/requests/http.ts */
export async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const type = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new ApiError(415, "unsupported_media_type");
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^\d+$/.test(length)) throw new ApiError(400, "invalid_input");
  if (length !== null && Number(length) > maxBytes) throw new ApiError(413, "payload_too_large");
  if (!request.body) throw new ApiError(400, "invalid_input");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, "payload_too_large");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_input");
  } finally {
    reader.releaseLock();
  }
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_input");
  return parsed.data;
}

export async function requireUser(rt: Runtime, request: Request): Promise<SessionUser> {
  const user = await rt.auth.currentUser(request);
  if (!user) throw new ApiError(401, "unauthenticated");
  return user;
}

/**
 * same-Origin check for every POST. APP_BASE_URL is the only origin when it is set; in local dev without it, the
 * request's own origin (and its localhost or 127.0.0.1 twin) also counts. Returns the matched base url.
 */
export function checkOrigin(request: Request, rt: Runtime): string {
  const origin = request.headers.get("Origin");
  const allowed = [new URL(rt.baseUrl).origin];
  if (!process.env.APP_BASE_URL && process.env.NODE_ENV !== "production") {
    const own = new URL(request.url);
    const port = own.port ? `:${own.port}` : "";
    allowed.push(own.origin, `${own.protocol}//localhost${port}`, `${own.protocol}//127.0.0.1${port}`);
  }
  for (const base of allowed) {
    try {
      requireSameOrigin(origin, base);
      return base;
    } catch {
      // try the next allowed origin
    }
  }
  throw new WorkflowError("invalid_origin");
}

/** runtime and signed-in owner for a GET */
export async function readContext(request: Request): Promise<{ rt: Runtime; user: SessionUser }> {
  const rt = await getRuntime();
  return { rt, user: await requireUser(rt, request) };
}

/** runtime, owner and the matched origin for a POST; call before reading the body */
export async function writeContext(request: Request): Promise<{ rt: Runtime; user: SessionUser; base: string }> {
  const rt = await getRuntime();
  const user = await requireUser(rt, request);
  return { rt, user, base: checkOrigin(request, rt) };
}

/** ADMIN_EMAILS (comma separated) when set; with demo auth and no list, the demo user is the admin */
export function isAdmin(rt: Runtime, user: SessionUser): boolean {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return rt.mode.auth === "demo";
  return list.includes(user.email.toLowerCase());
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** a bad or foreign id is a 404, never a 400, so ids cannot be probed */
export function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new ApiError(404, "not_found");
  return value.toLowerCase();
}
