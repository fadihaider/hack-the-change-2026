// optional embedding adapter for approved care facts (PRD 7.1); "off" means keyword retrieval only
// stub: the retrieval integration replaces the body with the real adapter selection
export type EmbeddingMode = "off" | "bedrock";

export function embeddingMode(_env: NodeJS.ProcessEnv = process.env): EmbeddingMode {
  return "off";
}
