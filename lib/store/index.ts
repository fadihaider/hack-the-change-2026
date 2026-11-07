// one place to build the durable stores from env (DB_CLUSTER_ARN, DB_SECRET_ARN, APP_AWS_REGION)
import "server-only";
import { db, type Database } from "../db.ts";
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

let stores: AppStores | undefined;

/** throws DatabaseError("not_configured") until the DB env vars are set; routes map that to HTTP 503 */
export function appStores(): AppStores {
  if (!stores) {
    const database = db();
    stores = {
      database,
      workflow: createWorkflowStore(database),
      accounts: createAccountStore(database),
      appNow: async () => (await readClock(database)).appNow,
    };
  }
  return stores;
}

export { jumpClock, readClock, resetClock, sweepExpired } from "./clock.ts";
