import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_MODEL, demoCaller } from "../demoCaller.ts";
import { createEmbedder, EmbeddingError, embeddingMode, resolveEmbedder, titanEmbedder, toVectorLiteral } from "../embeddings.ts";
import { classifyQuestion, EMERGENCY_REDIRECT, MEDICAL_REDIRECT } from "../medicalGuard.ts";
import { runProfileQa, type ApprovedFact } from "../profileQa.ts";
import { keywordMatches, rankFacts, selectContext, tokenize } from "../retrieval.ts";

// the PRD 5.2 voice note, approved
const passport: ApprovedFact[] = [
  { id: "f-breakfast", category: "routine", textExact: "Rosa usually has breakfast at eight." },
  { id: "f-written", category: "communication", textExact: "She prefers instructions written down." },
  { id: "f-glasses", category: "logistics", textExact: "Her spare glasses are in the bedroom drawer." },
  { id: "f-radio", category: "preference", textExact: "She likes the radio on in the morning." },
];

test("tokenize drops stopwords and names, stems plurals and maps number words", () => {
  assert.deepEqual(tokenize("Where are Rosa's spare glasses?", new Set(["rosa"])), ["spare", "glasses"]);
  assert.deepEqual(tokenize("Breakfast at eight"), ["breakfast", "8"]);
  assert.deepEqual(tokenize("Breakfast at 8:30"), ["breakfast", "8:30", "8"]);
});

test("the glasses question ranks the glasses fact first, synonyms included", () => {
  assert.equal(rankFacts("Where are her spare glasses?", passport)[0].fact.id, "f-glasses");
  assert.equal(rankFacts("Where are her spectacles?", passport)[0].fact.id, "f-glasses");
  assert.equal(rankFacts("What music does she like?", passport)[0].fact.id, "f-radio");
  assert.equal(rankFacts("What time does she eat?", passport)[0].fact.id, "f-breakfast");
  assert.deepEqual(keywordMatches("Where are her spare glasses?", passport), [passport[2]]);
  assert.deepEqual(keywordMatches("What is her doctor's name?", passport), []);
});

test("a small passport sends every approved fact, best first", () => {
  const selection = selectContext({ question: "Where are her spare glasses?", facts: passport });
  assert.equal(selection.scope, "full");
  assert.equal(selection.method, "keyword");
  assert.equal(selection.facts.length, passport.length);
  assert.equal(selection.facts[0].id, "f-glasses");
});

test("a large passport sends the top K, padded, and vector hits outside the set are ignored", () => {
  const many: ApprovedFact[] = Array.from({ length: 70 }, (_, index) => ({
    id: `f-${index}`,
    category: "routine",
    textExact: `Note number ${index} about the garden hose.`,
  }));
  many.push({ id: "f-glasses", category: "logistics", textExact: "Her spare glasses are in the bedroom drawer." });
  many.push({ id: "f-vector-only", category: "routine", textExact: "Lenses live by the sink." });
  const selection = selectContext({
    question: "Where are her spare glasses?",
    facts: many,
    vectorHits: [
      { id: "f-vector-only", similarity: 0.9 },
      { id: "someone-elses-fact", similarity: 0.99 },
    ],
    limits: { topK: 5, minContext: 8 },
  });
  assert.equal(selection.scope, "top_k");
  assert.equal(selection.method, "keyword+vector");
  assert.ok(selection.facts.length <= 8);
  const ids = selection.facts.map((fact) => fact.id);
  assert.ok(ids.includes("f-glasses"));
  assert.ok(ids.includes("f-vector-only"));
  assert.ok(!ids.includes("someone-elses-fact"));
  // deterministic across runs
  assert.deepEqual(selectContext({ question: "Where are her spare glasses?", facts: many, limits: { topK: 5 } }).facts,
    selectContext({ question: "Where are her spare glasses?", facts: many, limits: { topK: 5 } }).facts);
});

test("demo A5 cites the exact glasses fact and says it is a keyword match, not AI", async () => {
  const result = await runProfileQa({ question: "Where are her spare glasses?", facts: passport }, { caller: demoCaller, model: DEMO_MODEL });
  assert.equal(result.notFound, false);
  assert.deepEqual(result.citedFacts.map((fact) => fact.textExact), ["Her spare glasses are in the bedroom drawer."]);
  assert.match(result.answer ?? "", /^Demo keyword match, not AI/);
  const missing = await runProfileQa({ question: "What is her doctor's name?", facts: passport }, { caller: demoCaller, model: DEMO_MODEL });
  assert.equal(missing.notFound, true);
  assert.equal(missing.createOpenQuestion, true);
});

test("the medical guard flags judgment and emergencies, and leaves lookups alone", () => {
  for (const question of [
    "She has chest pain and cannot breathe",
    "Mom fell and can’t get up",
    "She is unconscious",
    "I think she took too many pills",
  ]) {
    assert.equal(classifyQuestion(question), "emergency", question);
  }
  for (const question of [
    "Should I give her more pain medicine?",
    "Is it normal that her incision is swollen?",
    "Can I skip her evening dose?",
    "Should I worry about her fever?",
    "Her wound looks red, is that okay?",
    "What are the symptoms of an infection?",
  ]) {
    assert.equal(classifyQuestion(question), "medical", question);
  }
  for (const question of [
    "Where are her spare glasses?",
    "When does she take her medication?",
    "What time is breakfast?",
    "Who is her doctor?",
    "What temperature does she like her tea?",
  ]) {
    assert.equal(classifyQuestion(question), "profile", question);
  }
  assert.ok(MEDICAL_REDIRECT.includes("811") && MEDICAL_REDIRECT.includes("911"));
  assert.ok(EMERGENCY_REDIRECT.startsWith("If this is an emergency, call 911 now."));
});

test("embedding mode defaults to off and vectors must be 1024 finite numbers", () => {
  assert.equal(embeddingMode({}), "off");
  assert.equal(embeddingMode({ RR_EMBED: "bedrock" }), "bedrock");
  assert.equal(embeddingMode({ RR_EMBED: "typo" }), "off");
  assert.equal(JSON.parse(toVectorLiteral(new Array(1024).fill(0.5))).length, 1024);
  assert.throws(() => toVectorLiteral(new Array(1023).fill(0.5)), EmbeddingError);
  assert.throws(() => toVectorLiteral([...new Array(1023).fill(0.5), Number.NaN]), EmbeddingError);
});

test("the Titan embedder sends dimensions 1024 and normalize, and reduces SDK errors to a code", async () => {
  const sent: unknown[] = [];
  const ok = titanEmbedder({
    region: "us-east-2",
    client: {
      async send(command: unknown) {
        sent.push(JSON.parse((command as { input: { body: string } }).input.body));
        return { body: new TextEncoder().encode(JSON.stringify({ embedding: new Array(1024).fill(0.1), inputTextTokenCount: 3 })) };
      },
    },
  });
  const vectors = await ok.embed(["Her spare glasses are in the bedroom drawer."]);
  assert.equal(vectors[0].length, 1024);
  assert.deepEqual(sent[0], { inputText: "Her spare glasses are in the bedroom drawer.", dimensions: 1024, normalize: true });
  assert.equal(ok.model, "amazon.titan-embed-text-v2:0:1024");

  const short = titanEmbedder({
    region: "us-east-2",
    client: { send: async () => ({ body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2] })) }) },
  });
  await assert.rejects(short.embed(["x"]), (error: unknown) => error instanceof EmbeddingError && error.code === "bad_vector");

  const denied = titanEmbedder({
    region: "us-east-2",
    client: {
      send: async () => {
        throw Object.assign(new Error("secret provider text"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } });
      },
    },
  });
  await assert.rejects(denied.embed(["x"]), (error: unknown) => {
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.code, "AccessDeniedException");
    assert.equal(error.status, 403);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
});

test("a generic liking word alone never anchors a demo exact-fact answer", () => {
  const facts = [
    { id: "a", category: "preference", textExact: "She likes the radio on in the morning." },
    { id: "b", category: "communication", textExact: "She prefers instructions written down." },
    { id: "c", category: "practical", textExact: "Her spare glasses are in the bedroom drawer." },
  ];
  assert.deepEqual(keywordMatches("What is her favourite TV show?", facts, 3, ["Rosa", "Mom"]), []);
  // "music" only loosely matches "radio": it still ranks the radio fact first, but the demo lookup needs a shared word
  assert.deepEqual(keywordMatches("Does she like music?", facts, 3, ["Rosa", "Mom"]), []);
  assert.equal(rankFacts("Does she like music?", facts, ["Rosa", "Mom"])[0].fact.id, "a");
  assert.deepEqual(keywordMatches("Does she like the radio?", facts, 3, ["Rosa", "Mom"]).map((fact) => fact.id), ["a"]);
  assert.deepEqual(keywordMatches("Where are her spectacles?", facts, 3, ["Rosa", "Mom"]).map((fact) => fact.id), ["c"]);
});

test("the recipient's name, a generic word or a loose synonym alone never anchors a demo answer", () => {
  const facts: ApprovedFact[] = [
    ...passport,
    { id: "f-tea", category: "preference", textExact: "Rosa drinks her tea with milk." },
  ];
  const names = ["Rosa", "Mom"];
  for (const question of [
    // shares only the recipient's name
    "What is Rosa's doctor's name?",
    "Does Rosa have a cat?",
    // "glass" is not "glasses"
    "Can she have a glass of wine?",
    // one meal is not another, and eating words are generic
    "When does she have lunch?",
    "What food does she eat?",
    "What does she have for dinner?",
    // shares only a generic word
    "What is her doctor's phone number?",
  ]) {
    assert.deepEqual(keywordMatches(question, facts, 3, names), [], question);
  }
  assert.deepEqual(keywordMatches("Where are her spare glasses?", facts, 3, names).map((fact) => fact.id), ["f-glasses"]);
  assert.deepEqual(keywordMatches("Where are Rosa's eyeglasses?", facts, 3, names).map((fact) => fact.id), ["f-glasses"]);
  assert.deepEqual(keywordMatches("What time is breakfast?", facts, 3, names).map((fact) => fact.id), ["f-breakfast"]);
  assert.deepEqual(keywordMatches("How does Rosa take her tea?", facts, 3, names).map((fact) => fact.id), ["f-tea"]);
  // loose synonyms still rank: a lunch question puts the breakfast fact above the unrelated ones
  assert.equal(rankFacts("What does she eat?", facts, names)[0].fact.id, "f-breakfast");
});

test("demo A5 ignores the recipient's name: a question that only names her is Not in profile", async () => {
  const deps = { caller: demoCaller, model: DEMO_MODEL };
  const names = ["Rosa", "Mom"];
  const missing = await runProfileQa({ question: "What is Rosa's doctor's name?", facts: passport, names }, deps);
  assert.equal(missing.notFound, true);
  assert.equal(missing.createOpenQuestion, true);
  assert.deepEqual(missing.citedFacts, []);
  const lunch = await runProfileQa({ question: "When does Mom have lunch?", facts: passport, names }, deps);
  assert.equal(lunch.notFound, true);
  const glasses = await runProfileQa({ question: "Where are Rosa's spare glasses?", facts: passport, names }, deps);
  assert.deepEqual(glasses.citedFacts.map((fact) => fact.id), ["f-glasses"]);
  const breakfast = await runProfileQa({ question: "What time is Rosa's breakfast?", facts: passport, names }, deps);
  assert.deepEqual(breakfast.citedFacts.map((fact) => fact.id), ["f-breakfast"]);
});

test("the medical guard catches emergencies and judgment calls it used to miss", () => {
  for (const question of [
    "She hit her head on the table",
    "Is this a heart attack?",
    "I think she is having an allergic reaction",
    "Her arm is bleeding a lot",
    "Should I call an ambulance?",
    "Should I take her to the ER?",
    "Do we need the emergency room?",
  ]) {
    assert.equal(classifyQuestion(question), "emergency", question);
  }
  for (const question of [
    "How many pills can she take at once?",
    "What should her blood sugar be?",
    "Her blood pressure seems high",
    "She has a headache again",
    "Does she need to see a doctor?",
    "Should she go to the hospital?",
    "Is her dementia getting worse?",
    "Is she allergic to penicillin?",
    "Can she have a glass of wine with her medication?",
  ]) {
    assert.equal(classifyQuestion(question), "medical", question);
  }
  for (const question of ["Where are her spare glasses?", "Who is her doctor?", "What time is breakfast?", "Where does her daughter live?"]) {
    assert.equal(classifyQuestion(question), "profile", question);
  }
});

test("Gemini embeddings tell the provider a question from a stored fact", async () => {
  const tasks: unknown[] = [];
  const fetchFake = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { requests: { taskType: string }[] };
    tasks.push(...body.requests.map((request) => request.taskType));
    return new Response(JSON.stringify({ embeddings: body.requests.map(() => ({ values: new Array(1024).fill(0.1) })) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFake as typeof fetch;
  try {
    const embedder = createEmbedder("gemini", { GEMINI_API_KEY: "test-key", GEMINI_EMBED_MODEL: "gemini-embedding-001" });
    assert.ok(embedder);
    await embedder.embed(["Her spare glasses are in the bedroom drawer."]);
    await embedder.embed(["Where are her glasses?"], "query");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(tasks, ["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]);
});

test("an unconfigured Gemini embedder resolves to null instead of throwing", () => {
  const saved = { mode: process.env.RR_EMBED, key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_EMBED_MODEL };
  process.env.RR_EMBED = "gemini";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_EMBED_MODEL;
  try {
    assert.throws(() => createEmbedder("gemini", process.env));
    assert.equal(resolveEmbedder(), null);
  } finally {
    for (const [name, value] of [["RR_EMBED", saved.mode], ["GEMINI_API_KEY", saved.key], ["GEMINI_EMBED_MODEL", saved.model]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
