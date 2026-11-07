import "server-only";
import { buildVoiceAgentConfig } from "./config.ts";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** SDK responses add defaults. Compare every requested field while tolerating those defaults. */
function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => value === undefined || matches(object(actual)[key], value));
  }
  return actual === expected;
}

function containsTrue(value: unknown): boolean {
  return value === true || (value !== null && typeof value === "object" && Object.values(value).some(containsTrue));
}

/** Configuration verification only. This does not prove conversational behavior or app readiness. */
export function assertProvisionedVoiceFoundation(actual: unknown, expected = buildVoiceAgentConfig()): void {
  const root = object(actual);
  const graph = object(root.workflow);
  const actualNodes = object(graph.nodes);
  const actualEdges = object(graph.edges);
  const settings = object(root.platformSettings);
  const prompt = object(object(object(root.conversationConfig).agent).prompt);
  const enabledBuiltIns = Object.entries(object(prompt.builtInTools)).filter(([, value]) => value != null).map(([key]) => key);
  const keysEqual = (left: object, right: object) => Object.keys(left).sort().join() === Object.keys(right).sort().join();
  const invalidNode = Object.values(actualNodes).some((rawNode) => {
    const node = object(rawNode);
    return !["start", "end", "override_agent"].includes(String(node.type))
      || (node.conversationConfig != null && Object.keys(object(node.conversationConfig)).length > 0)
      || (Array.isArray(node.additionalKnowledgeBase) && node.additionalKnowledgeBase.length > 0);
  });
  const backwards = Object.values(actualEdges).some((edge) => object(edge).backwardCondition != null);
  if (!matches(root, expected)
    || !keysEqual(actualNodes, expected.workflow?.nodes ?? {}) || !keysEqual(actualEdges, expected.workflow?.edges ?? {})
    || invalidNode || backwards || enabledBuiltIns.some((key) => key !== "endCall")
    || containsTrue(settings.overrides)) {
    throw new Error("agent_configuration_mismatch");
  }
}
