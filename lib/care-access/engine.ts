export type AccessMode = "driving" | "proximity" | "transit";
export interface AccessResource {
  id: string; name: string; category: string; modelCategory?: string; lat: number; lon: number;
  address: string; sourceUrl: string; source: string; wheelchair: boolean | null; hours: string | null;
}
export interface AccessArea {
  id: string; name: string; lat: number; lon: number; sector: string;
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}
export interface AccessSnapshot {
  areas: AccessArea[]; resources: AccessResource[]; distanceKm: number[][];
  drivingMinutes: Array<Array<number | null>>; drivingCoverage: number[];
  clusters: Array<number | null>; clusterBasis: string;
  scoreFormula: string;
  provenance: { fetchedAt: string; limitations: string[]; routingProvider: string | null; sources: Record<string, string> };
  benchmark: {
    classification: { selected_model: string; elapsed_seconds: number; results: Array<{ model: string; heldout_accuracy: number; heldout_macro_f1: number; prediction_p50_ms?: number }> };
    clustering: { selected: { algorithm: string; silhouette: number; perturbation_ari: number; clusters: number }; profiles: Array<{ cluster: number; areas: number; mean_counts: Record<string, number> }>; accuracy_reason: string };
  };
}
export const SERVICE_CATEGORIES = ["Pharmacy", "Health Centre", "Hospital", "PHS Clinic", "Social Dev Ctr", "Community Centre", "Library"] as const;
export const SERVICE_NAMES: Record<string, string> = { Pharmacy: "Pharmacies", "Health Centre": "Health centres", Hospital: "Hospitals", "PHS Clinic": "Public-health clinics", "Social Dev Ctr": "Social support centres", "Community Centre": "Community centres", Library: "Libraries" };
export interface AccessOptions { mode: AccessMode; categories: string[]; threshold: number; stepFree: boolean }

/** No network, routing, model fitting or inference on the interaction path. */
export function compareAreas(snapshot: AccessSnapshot, options: AccessOptions) {
  return snapshot.areas.map((area, index) => {
    const available = options.mode === "proximity" || (options.mode === "driving" && snapshot.drivingCoverage[index] === 1);
    if (!available) return { area, index, score: null, counts: {} as Record<string, number>, resources: [] as Array<{ resource: AccessResource; cost: number }>, unknownStepFree: 0 };
    const costs = options.mode === "driving" ? snapshot.drivingMinutes[index] : snapshot.distanceKm[index];
    const nearby = snapshot.resources.flatMap((resource, i) => {
      const cost = costs[i];
      return cost !== null && Number.isFinite(cost) && cost <= options.threshold && options.categories.includes(resource.category) ? [{ resource, cost }] : [];
    });
    const unknownStepFree = nearby.filter(({ resource }) => resource.wheelchair === null).length;
    const resources = nearby.filter(({ resource }) => !options.stepFree || resource.wheelchair === true).sort((a, b) => a.cost - b.cost);
    const counts = Object.fromEntries(options.categories.map((category) => [category, resources.filter(({ resource }) => resource.category === category).length]));
    const score = options.categories.length ? Math.round(100 * Object.values(counts).reduce((sum, count) => sum + Math.min(count / 5, 1), 0) / options.categories.length) : null;
    return { area, index, score, counts, resources, unknownStepFree };
  });
}
