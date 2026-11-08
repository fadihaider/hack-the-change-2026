// U8 start guide: loads the Calgary snapshot once per process, then builds the cards for an address or point
import "server-only";
import type { Database } from "../../../lib/db.ts";
import { buildGuide, loadResources, type GeoPoint, type GuideResult, type Tenure } from "../../../lib/mvp/resources.ts";

let loaded: Promise<unknown> | undefined;

/** loadResources is idempotent; this only avoids repeating its checks on every request. a failure is retried next time */
export function ensureResources(database: Database): Promise<unknown> {
  if (!loaded) {
    loaded = loadResources(database).catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
  }
  return loaded;
}

/** the existing UI says "unsure"; the resource module says "not_sure" */
export function parseTenure(value: string | null): Tenure | null {
  if (value === null || value === "") return "not_sure";
  if (value === "unsure") return "not_sure";
  return value === "yes" || value === "no" || value === "not_sure" ? value : null;
}

export async function guideFor(
  database: Database,
  input: { address?: string; point?: GeoPoint; now: Date; tenure: Tenure },
): Promise<GuideResult> {
  await ensureResources(database);
  return buildGuide(database, input);
}
