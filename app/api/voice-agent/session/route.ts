// POST /api/voice-agent/session {consent:true, fictionalData:true} -> {signedUrl} for the private hosted ElevenLabs
// agent (docs/ELEVENLABS_AGENT.md). optional and outside PRD 6: off (404) unless RR_VOICE_AGENT=on, so the unlinked
// /voice page cannot spend credits by default.
import "server-only";
import { ApiError, errorResponse } from "../../_lib/http.ts";
import { speechRoute } from "../../_lib/speech.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (process.env.RR_VOICE_AGENT !== "on") return errorResponse(new ApiError(404, "not_found"));
  return speechRoute(request, "session");
}
