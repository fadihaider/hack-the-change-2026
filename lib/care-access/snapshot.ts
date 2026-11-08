import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccessSnapshot } from "./engine";

let snapshot: Promise<AccessSnapshot> | undefined;
/** Load once per server process. Browser interactions use the same static artifact. */
export function loadAccessSnapshot(): Promise<AccessSnapshot> {
  if (!snapshot) snapshot = readFile(join(process.cwd(), "public/care-access/snapshot.json"), "utf8")
    .then((text) => JSON.parse(text) as AccessSnapshot)
    .catch((error) => { snapshot = undefined; throw error; });
  return snapshot;
}
