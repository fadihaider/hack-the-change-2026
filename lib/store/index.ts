// one place to build the durable stores over a database (PGlite or Supabase, picked by RR_DB in lib/mvp/runtime.ts)
import "server-only";
import type { Database } from "../db.ts";
import type { AccountStore } from "../auth/google.ts";
import type { WorkflowStore } from "../requests/workflow.ts";
import { createAccountStore } from "./accountStore.ts";
import { readClock } from "./clock.ts";
import { createWorkflowStore } from "./workflowStore.ts";

export interface AppStores {
  database: Database;
  workflow: WorkflowStore;
  accounts: AccountStore;
  /** app time for deadlines (the demo clock is global, so the user id is not used) */
  appNow(userId?: string): Promise<Date>;
}

export function storesFor(database: Database): AppStores {
  return {
    database,
    workflow: createWorkflowStore(database),
    accounts: createAccountStore(database),
    appNow: async () => (await readClock(database)).appNow,
  };
}

export { jumpClock, readClock, resetClock, sweepExpired } from "./clock.ts";
