// speech routes (PRD 6): thin wiring of lib/speech/runtime.ts to getRuntime() and the shared origin check
import "server-only";
import { createSpeechRuntimeFromApp, speechRuntimeUnavailable } from "../../../lib/speech/runtime.ts";
import { speechConfigured } from "../../../lib/speech/status.ts";
import { ApiError, handle, writeContext } from "./http.ts";

export type SpeechStep = "stt" | "tts" | "session";

/**
 * owner and same origin first (401, 403), then a free 503 when no key is set, so an unconfigured server never
 * reserves voice quota or writes llm_call rows. the body is read only by the speech handler, after both checks.
 */
export function speechRoute(request: Request, step: SpeechStep): Promise<Response> {
  return handle(async () => {
    const { rt, base } = await writeContext(request);
    if (!speechConfigured()) throw new ApiError(503, "speech_not_configured");
    let speech: ReturnType<typeof createSpeechRuntimeFromApp>;
    try {
      // the origin checkOrigin matched, not rt.baseUrl: the speech handler compares Origin strictly, so passing the
      // default http://localhost:3000 would refuse a browser on http://127.0.0.1:3000 (what npm run dev binds)
      speech = createSpeechRuntimeFromApp({ ...rt, baseUrl: base });
    } catch {
      // invalid_app_base_url: plain http on a non-loopback host (lan dev, [::1]); paid speech stays off there
      return speechRuntimeUnavailable();
    }
    return speech[step](request);
  });
}
