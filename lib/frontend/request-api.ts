import { z } from "zod";

// Browser contract from docs/INTEGRATIONS.md. Never import the server state
// module here: it also imports Node crypto. Reads are validated before display.
const state = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "sending",
  "requested",
  "accepted",
  "completed",
  "cancelled",
  "failed",
  "rejected",
  "expired",
  "needs_review",
]);
const timestamp = z.string().datetime({ offset: true });
export const requestViewSchema = z.object({
  id: z.string().min(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  state,
  action: z.enum(["notify", "reschedule", "extension", "coverage"]),
  recipient: z.object({
    contactId: z.string().min(1),
    name: z.string(),
    email: z.string().email(),
  }),
  subject: z.string(),
  body: z.string(),
  disclosureTier: z.enum(["minimal", "general", "detailed"]),
  healthTermsFound: z.array(z.string()),
  healthOverride: z.boolean(),
  respondBy: timestamp.nullable(),
  proposedAt: timestamp.nullable(),
  proposedNote: z.string().nullable(),
  approval: z
    .object({ id: z.string(), hash: z.string(), at: timestamp })
    .nullable(),
  evidence: z.array(
    z.object({
      id: z.string(),
      fromState: state.nullable(),
      toState: state,
      evidenceKind: z.enum([
        "approval",
        "gmail_message_id",
        "link_click",
        "user_manual",
        "scheduler",
        "error",
      ]),
      evidenceRef: z.string().nullable(),
      actor: z.string(),
      at: timestamp,
    }),
  ),
});
export type RequestView = z.infer<typeof requestViewSchema>;
const listSchema = z.object({
  requests: z.array(requestViewSchema),
  appNow: timestamp,
});
const requestSchema = z.object({ request: requestViewSchema });
const refreshSchema = listSchema.extend({
  expiredRequestIds: z.array(z.string()),
});
const clockSchema = z.object({
  appNow: timestamp,
  realNow: timestamp,
  offsetMilliseconds: z.number().finite(),
});
const sendSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("requested"), messageId: z.string().min(1) }),
  z.object({ state: z.literal("failed"), errorCode: z.string() }),
  z.object({ state: z.literal("needs_review") }),
]);

export class RequestApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly terms: string[] = [],
    /** a fixed server message (for example the guide's address hints); plain text only */
    public readonly detail: string | null = null,
  ) {
    super(code);
  }
}

export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof RequestApiError))
    return "The live service could not be reached. Refresh before taking another action.";
  if (error.status === 401)
    return "A signed-in session is required. Live sign-in must be connected before you can continue.";
  if (error.status === 403)
    return "Your session does not have permission for this action.";
  if (error.status === 404 || error.status === 503)
    return "The live workspace is not available yet. The demo remains available.";
  if (error.status === 409)
    return "This request changed elsewhere. Refresh and review its recorded state.";
  if (error.status === 412 || error.status === 428)
    return "This approval preview is out of date. Review the refreshed message and approve it again.";
  if (error.code === "health_terms")
    return "Health terms need your review. Edit the message or explicitly allow the disclosure before approving.";
  if (error.code === "invalid_response")
    return "The live service returned an unexpected response. No success is assumed; refresh to reconcile.";
  return "The action could not be confirmed. Refresh the recorded state before trying again.";
}

export interface CallOptions {
  /** a json object, or FormData for a multipart upload; GET when absent */
  body?: object | FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** one validated same-origin call: errors become RequestApiError, success is parsed with the schema */
export function createCaller(transport: typeof fetch = fetch) {
  return async function call<T>(
    path: string,
    schema: z.ZodType<T>,
    options: CallOptions = {},
  ): Promise<T> {
    const { body, headers = {}, timeoutMs = 15000 } = options;
    let response: Response;
    try {
      response = await transport(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined
          ? {}
          : body instanceof FormData
            ? { headers, body }
            : {
                headers: { "Content-Type": "application/json", ...headers },
                body: JSON.stringify(body),
              }),
      });
    } catch {
      throw new RequestApiError("network_error", 0);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new RequestApiError(
        "invalid_response",
        response.ok ? 502 : response.status,
      );
    }
    if (!response.ok) {
      const error = z
        .object({
          error: z.object({
            code: z.string(),
            terms: z.array(z.string().max(80)).optional(),
            message: z.string().optional(),
          }),
        })
        .safeParse(data);
      throw new RequestApiError(
        error.success ? error.data.error.code : "request_failed",
        response.status,
        error.success ? error.data.error.terms : undefined,
        error.success ? (error.data.error.message?.slice(0, 400) ?? null) : null,
      );
    }
    const result = schema.safeParse(data);
    if (!result.success) throw new RequestApiError("invalid_response", 502);
    return result.data;
  };
}

export function createRequestApi(transport: typeof fetch = fetch) {
  const send = createCaller(transport);
  const call = <T>(
    path: string,
    schema: z.ZodType<T>,
    body?: object,
    headers: Record<string, string> = {},
  ) => send(path, schema, { body, headers });
  return {
    list: () => call("/api/requests", listSchema),
    refresh: () => call("/api/requests/refresh", refreshSchema, {}),
    edit: (
      requestId: string,
      changes: {
        subject?: string;
        body?: string;
        contactId?: string;
        respondBy?: string | null;
      },
    ) => call("/api/requests/edit", requestSchema, { requestId, ...changes }),
    approve: (requestId: string, revision: string, healthOverride = false) => {
      if (!/^[a-f0-9]{64}$/.test(revision))
        return Promise.reject(new RequestApiError("invalid_response", 502));
      return call(
        "/api/requests/approve",
        requestSchema,
        { requestId, healthOverride },
        { "If-Match": `"${revision}"` },
      );
    },
    cancel: (requestId: string) =>
      call("/api/requests/cancel", requestSchema, { requestId }),
    send: (requestId: string) =>
      call("/api/requests/send", sendSchema, { requestId }),
    clock: () => call("/api/clock", clockSchema),
    jump: (days: number) =>
      call(
        "/api/clock/jump",
        clockSchema.extend({ expiredRequestIds: z.array(z.string()) }),
        { days },
      ),
  };
}
