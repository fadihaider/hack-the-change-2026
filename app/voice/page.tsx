import { notFound } from "next/navigation";
import VoicePanel from "../../components/relief-ready/VoicePanel";
import { speechMode } from "../../lib/speech/status.ts";

// read on every request, so the env below decides at run time and not once at build
export const dynamic = "force-dynamic";

// the unlinked live voice page claims ElevenLabs speech and a companion, so it exists only when both are really on:
// the voice agent switched on (RR_VOICE_AGENT=on) and a speech provider this runtime may use
export default function VoicePage() {
  if (process.env.RR_VOICE_AGENT !== "on" || speechMode() === "off") notFound();
  return <main style={{ maxWidth: 860, margin: "0 auto", padding: "36px 20px" }}><VoicePanel /></main>;
}
