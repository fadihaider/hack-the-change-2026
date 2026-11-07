import "server-only";
import { z } from "zod";
import {
  confirmResponse, hashResponseToken, requireSameOrigin, sendApprovedRequest, WorkflowError,
} from "./workflow.ts";
import type { WorkflowStore } from "./workflow.ts";

const MAX_JSON_BYTES = 4096;
const sendSchema = z.strictObject({
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
});
const responseSchema = z.strictObject({
  proposal: z.strictObject({
    at: z.iso.datetime({ offset: true }),
    note: z.string().refine((value) => [...value].length <= 300).optional(),
  }).optional(),
});

export interface RequestHttpDependencies {
  baseUrl: string;
  // Resolve a verified server session. Never derive this identity from the body.
  authenticate(request: Request): Promise<{ userId: string } | null>;
  store: WorkflowStore;
  appNow(userId: string): Promise<Date>;
  realNow?: () => Date;
  findHealthTerms: Parameters<typeof sendApprovedRequest>[0]["findHealthTerms"];
  send: Parameters<typeof sendApprovedRequest>[0]["send"];
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly allow?: string) {
    super(code);
  }
}

function json(value: unknown, status = 200, allow?: string): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...(allow ? { Allow: allow } : {}),
    },
  });
}

async function guarded(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code } }, error.status, error.allow);
    if (error instanceof WorkflowError) {
      const status = {
        not_found: 404, state_conflict: 409, invalid_response: 400, invalid_origin: 403,
      }[error.code];
      return json({ error: { code: error.code } }, status);
    }
    // Provider, storage and session errors can contain credentials or message text.
    // Do not serialize or log their messages, causes or response bodies.
    return json({ error: { code: "temporarily_unavailable" } }, 503);
  }
}

function method(request: Request, expected: "GET" | "POST"): void {
  if (request.method !== expected) throw new HttpError(405, "method_not_allowed", expected);
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type");
  }
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, "invalid_input");
  if (length !== null && Number(length) > MAX_JSON_BYTES) throw new HttpError(413, "payload_too_large");
  if (!request.body) throw new HttpError(400, "invalid_input");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "payload_too_large");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_input");
  } finally {
    reader.releaseLock();
  }
}

/**
 * HTTP boundary only; compose with the durable store and verified auth at runtime.
 * No fixture adapter or provider fallback is supplied. These functions do not
 * register Next.js endpoints by themselves.
 */
export function createRequestHttpHandlers(deps: RequestHttpDependencies) {
  const realNow = deps.realNow ?? (() => new Date());
  return {
    send(request: Request): Promise<Response> {
      return guarded(async () => {
        method(request, "POST");
        const identity = await deps.authenticate(request);
        if (!identity?.userId) throw new HttpError(401, "unauthenticated");
        requireSameOrigin(request.headers.get("Origin"), deps.baseUrl);
        const parsed = sendSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new HttpError(400, "invalid_input");
        const result = await sendApprovedRequest({
          userId: identity.userId, requestId: parsed.data.requestId,
          store: deps.store, baseUrl: deps.baseUrl,
          findHealthTerms: deps.findHealthTerms, send: deps.send,
          appTime: await deps.appNow(identity.userId),
        });
        return json(result);
      });
    },

    // A landing-page GET may render only these fields as plain text. In
    // particular, calling this reader never records a response or consumes tokens.
    preview(request: Request, token: string): Promise<Response> {
      return guarded(async () => {
        method(request, "GET");
        const hash = hashResponseToken(token);
        const now = realNow();
        const preview = await deps.store.withResponseToken(hash, now, async (tx) => {
          if (tx.token.expiresAt <= now) throw new WorkflowError("not_found");
          return {
            subject: tx.request.subject, body: tx.request.body, state: tx.request.state,
            choice: tx.token.choice, respondBy: tx.request.respondBy?.toISOString() ?? null,
          };
        });
        return json({ request: preview });
      });
    },

    confirm(request: Request, token: string): Promise<Response> {
      return guarded(async () => {
        method(request, "POST");
        requireSameOrigin(request.headers.get("Origin"), deps.baseUrl);
        const parsed = responseSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new HttpError(400, "invalid_input");
        return json(await confirmResponse({
          token, proposal: parsed.data.proposal, store: deps.store, realNow: realNow(),
        }));
      });
    },
  };
}
