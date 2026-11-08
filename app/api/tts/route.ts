// POST /api/tts {text} (1 to 4000 characters, JSON) -> audio/mpeg bytes from ElevenLabs Flash v2.5; optional
// read-aloud, not used by the Care flow. same gates as /api/stt: owner, same origin, 503 speech_not_configured
// with no key (no quota used), then the shared voice quota. nothing is stored except the llm_call quota row.
import "server-only";
import { speechRoute } from "../_lib/speech.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return speechRoute(request, "tts");
}
