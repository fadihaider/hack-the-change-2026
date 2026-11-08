// live check of A1 and A4 against Bedrock using the fictional fixtures; run after the smoke test passes
// usage: AWS_PROFILE=reliefready BEDROCK_REGION=ca-central-1 npx tsx --conditions=react-server scripts/ai-live-fixtures.ts
import { bedrockDeps } from "../lib/ai/bedrock";
import { runCareCompiler } from "../lib/ai/careCompiler";
import { runIntake } from "../lib/ai/intake";
import { ModelCallError, NeedsReviewError, type UsageRecord } from "../lib/ai/model";
import {
  DISCHARGE_SHEET,
  EPISODE_START,
  EXISTING_FACTS,
  STATEMENT_WITH_DATES,
  STATEMENT_WITHOUT_DATES,
  TODAY,
  VOICE_NOTE,
} from "../lib/ai/fixtures/rosa";

const usage: UsageRecord[] = [];
const deps = bedrockDeps((record) => void usage.push(record));

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    console.log(`\n## ${name}\n${JSON.stringify(await run(), null, 2)}`);
  } catch (error) {
    // ModelCallError and NeedsReviewError carry codes only; any other error prints its name, never its message
    const code =
      error instanceof ModelCallError
        ? `${error.status ?? "no status"} ${error.code}`
        : error instanceof NeedsReviewError
          ? error.code
          : (error as Error).name;
    console.log(`\n## ${name}\nFAILED: ${code}`);
  }
}

await step("A1 with dates", () => runIntake({ statement: STATEMENT_WITH_DATES, today: TODAY }, deps));
await step("A1 without dates", () => runIntake({ statement: STATEMENT_WITHOUT_DATES, today: TODAY }, deps));
await step("A4 voice note", () => runCareCompiler({ fullText: VOICE_NOTE, existingFacts: [], episodeStart: EPISODE_START }, deps));
await step("A4 discharge sheet vs existing facts", () =>
  runCareCompiler({ fullText: DISCHARGE_SHEET, existingFacts: EXISTING_FACTS, episodeStart: EPISODE_START }, deps),
);

const input = usage.reduce((sum, record) => sum + record.inputTokens, 0);
const output = usage.reduce((sum, record) => sum + record.outputTokens, 0);
console.log(`\n${usage.length} calls, ${input} input tokens, ${output} output tokens`);
