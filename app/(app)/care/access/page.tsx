import type { Metadata } from "next";
import { AccessMap } from "@/components/app/access/AccessMap.tsx";

export const metadata: Metadata = { title: "Compare communities | ReliefReady" };

// care access: compare which care places are within reach across calgary communities. the explorer reads the slim
// GET /api/care-access/basemap once (which also says whether live classification is set up, never its url or token)
// and per-choice scores from GET /api/care-access?view=scores, not the 1 MB public snapshot.
export default function CareAccessPage() {
  return <AccessMap />;
}
