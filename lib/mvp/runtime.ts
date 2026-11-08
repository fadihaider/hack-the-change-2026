// everything a route needs, picked by env (docs/MVP.md "Adapters"); routes call getRuntime() and nothing else
import "server-only";
import { aiMode, getModelDeps, type AiMode } from "../ai/provider.ts";
import type { StepDeps } from "../ai/model.ts";
import { findHealthTerms } from "../healthTerms.ts";
import { appStores, type AppStores } from "../store/index.ts";
import { createAccountStore } from "../store/accountStore.ts";
import { readClock } from "../store/clock.ts";
import { createRequestQueue, type RequestQueue } from "../store/requestQueue.ts";
import { createWorkflowStore } from "../store/workflowStore.ts";
import { createAuthAdapter, type AuthAdapter, type AuthMode } from "./auth.ts";
import { createCalendarSource, type CalendarMode, type CalendarSource } from "./calendar.ts";
import { getMvpDatabase } from "./database.ts";
import { createMailSender, NotConfiguredError, type MailMode, type MailSender } from "./mail.ts";

export { NotConfiguredError } from "./mail.ts";

export interface RuntimeMode {
  db: "pglite" | "aurora";
  ai: AiMode;
  mail: MailMode;
  calendar: CalendarMode;
  auth: AuthMode;
}

export interface Runtime {
  /** lib/store/index.ts shape: database, workflow, accounts, appNow */
  stores: AppStores;
  queue: RequestQueue;
  /** lib/ai/model.ts; the caller is picked by RR_AI */
  ai: StepDeps;
  mail: MailSender;
  calendar: CalendarSource;
  auth: AuthAdapter;
  baseUrl: string;
  /** for GET /api/session */
  mode: RuntimeMode;
  /** the one health-term check for approve and send, so both agree */
  findHealthTerms(subject: string, body: string): Promise<string[]>;
}

function pick<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T {
  const chosen = (value || allowed[0]) as T;
  if (!allowed.includes(chosen)) throw new NotConfiguredError(name);
  return chosen;
}

export function runtimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return {
    db: pick("RR_DB", env.RR_DB, ["pglite", "aurora"] as const),
    ai: aiMode(),
    mail: pick("RR_MAIL", env.RR_MAIL, ["outbox", "gmail"] as const),
    calendar: pick("RR_CALENDAR", env.RR_CALENDAR, ["seed", "google"] as const),
    auth: pick("RR_AUTH", env.RR_AUTH, ["demo", "google"] as const),
  };
}

async function buildStores(mode: RuntimeMode): Promise<AppStores> {
  if (mode.db === "aurora") return appStores();
  const database = await getMvpDatabase();
  return {
    database,
    workflow: createWorkflowStore(database),
    accounts: createAccountStore(database),
    appNow: async () => (await readClock(database)).appNow,
  };
}

async function buildRuntime(): Promise<Runtime> {
  const mode = runtimeMode();
  const stores = await buildStores(mode);
  const checkHealthTerms = async (subject: string, body: string) => findHealthTerms(subject, body);
  return {
    stores,
    queue: createRequestQueue(stores.database, { findHealthTerms: checkHealthTerms }),
    ai: getModelDeps(),
    mail: createMailSender(mode.mail, { sql: stores.database, accounts: stores.accounts }),
    calendar: createCalendarSource(mode.calendar, { accounts: stores.accounts }),
    auth: createAuthAdapter(mode.auth, { sql: stores.database }),
    baseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
    mode,
    findHealthTerms: checkHealthTerms,
  };
}

// module scope on purpose: a Next dev reload rebuilds the adapters with fresh code, while the PGlite instance itself
// stays on globalThis in database.ts
let shared: Promise<Runtime> | undefined;

/** built once per module load; a failed build is retried on the next call */
export function getRuntime(): Promise<Runtime> {
  if (!shared) {
    shared = buildRuntime().catch((error: unknown) => {
      shared = undefined;
      throw error;
    });
  }
  return shared;
}
