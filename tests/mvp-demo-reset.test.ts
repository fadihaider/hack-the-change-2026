// Demo menu "Reset the demo": one run is cleared over the real routes, and the persona stays usable afterwards.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-demo-reset-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};

before(async () => {
  for (const name of [
    "intake", "impact", "commitments/decide", "requests/approve", "requests/send", "outbox", "recover", "session",
    "demo/reset",
  ]) {
    routes[name] = (await import(`../app/api/${name}/route.ts`)) as { GET?: Handler; POST?: Handler };
  }
});

after(async () => {
  const holder = globalThis as { __reliefReadyPglite?: Promise<{ close(): Promise<void> }> };
  await (await holder.__reliefReadyPglite)?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: "GET" | "POST",
  route: string,
  options: { body?: unknown; headers?: Record<string, string>; origin?: string } = {},
): Promise<{ status: number; data: any }> {
  const handler = routes[route]?.[method];
  assert.ok(handler, `${method} ${route} is exported`);
  const headers: Record<string, string> = { Origin: options.origin ?? BASE, ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`${BASE}/api/${route}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve({}) });
  return { status: response.status, data: await response.json() };
}

async function sendOne(): Promise<void> {
  const intake = await call("POST", "intake", {
    body: { statement: "My mom Rosa has day surgery tomorrow and I'll be helping her at home for a week." },
  });
  assert.equal(intake.status, 200);
  const impact = await call("POST", "impact", { body: { episodeId: intake.data.episodeId } });
  const shift = impact.data.commitments.find((c: any) => /work shift/i.test(c.title));
  const decided = await call("POST", "commitments/decide", { body: { commitmentId: shift.id, decision: "coverage" } });
  const draft = decided.data.request;
  const approved = await call("POST", "requests/approve", {
    body: { requestId: draft.id }, headers: { "If-Match": `"${draft.revision}"` },
  });
  assert.equal(approved.status, 200);
  const sent = await call("POST", "requests/send", { body: { requestId: draft.id } });
  assert.equal(sent.data.state, "requested");
}

test("reset the demo clears the run and keeps the persona", async () => {
  const foreign = await call("POST", "demo/reset", { body: {}, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);

  await sendOne();
  const before = await call("GET", "session");
  assert.ok(before.data.episode, "a care week is active");
  assert.equal((await call("GET", "recover")).data.groups.waiting.length, 1);
  assert.equal((await call("GET", "outbox")).data.messages.length, 1);

  const reset = await call("POST", "demo/reset", { body: {} });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data, { reset: true });

  const afterReset = await call("GET", "session");
  assert.equal(afterReset.data.episode, null);
  assert.equal(afterReset.data.user.id, before.data.user.id, "the demo user keeps its id");
  assert.equal(afterReset.data.careRecipient.id, before.data.careRecipient.id, "Rosa stays");
  const groups = (await call("GET", "recover")).data.groups;
  assert.equal(Object.values(groups).flat().length, 0, "recover is empty");
  assert.equal((await call("GET", "outbox")).data.messages.length, 0, "the outbox is empty");

  // the persona still works for the next run
  await sendOne();
  assert.equal((await call("GET", "recover")).data.groups.waiting.length, 1);
});
