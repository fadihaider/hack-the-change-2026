// picks the model caller for every step from RR_AI (docs/MVP.md adapters)
// demo (default): offline keyword rules, no network; anthropic: Claude API; bedrock: Claude on Amazon Bedrock
import "server-only";
import { anthropicDeps } from "./anthropic.ts";
import { bedrockDeps } from "./bedrock.ts";
import { DEMO_MODEL, demoCaller } from "./demoCaller.ts";
import type { StepDeps } from "./model.ts";

export const AI_MODES = ["demo", "anthropic", "bedrock"] as const;
export type AiMode = (typeof AI_MODES)[number];

/** RR_AI, defaulting to demo; an unknown value throws so a typo never silently runs the wrong provider */
export function aiMode(): AiMode {
  const value = (process.env.RR_AI ?? "demo").trim().toLowerCase() || "demo";
  if (!(AI_MODES as readonly string[]).includes(value)) {
    throw new Error(`RR_AI must be one of ${AI_MODES.join(", ")}`);
  }
  return value as AiMode;
}

/** StepDeps for runIntake, runImpact, runDrafter, runCareCompiler, runProfileQa and runResources */
export function getModelDeps(onUsage?: StepDeps["onUsage"]): StepDeps {
  const mode = aiMode();
  switch (mode) {
    case "anthropic":
      return anthropicDeps(onUsage);
    case "bedrock":
      return bedrockDeps(onUsage);
    case "demo":
      return { caller: demoCaller, model: DEMO_MODEL, onUsage };
    default: {
      // aiMode() only returns the three modes above
      const unreachable: never = mode;
      throw new Error(`unknown RR_AI mode ${String(unreachable)}`);
    }
  }
}
