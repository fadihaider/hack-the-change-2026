import "server-only";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/** Server/CLI only. Next.js loads .env.local; standalone Node uses --env-file. */
export function createElevenLabsSdkClient(): ElevenLabsClient {
  if (!process.env.ELEVENLABS_API_KEY?.trim()) {
    throw new Error("speech_not_configured");
  }
  // The SDK reads ELEVENLABS_API_KEY directly; never serialize this client.
  return new ElevenLabsClient();
}

/** Provisioning must not retry an ambiguous create and produce duplicate agents. */
export const PROVISION_REQUEST_OPTIONS = {
  maxRetries: 0,
  timeoutInSeconds: 30,
} as const;
