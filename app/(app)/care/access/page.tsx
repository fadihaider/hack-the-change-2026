import type { Metadata } from "next";
import { AccessMap } from "@/components/app/access/AccessMap.tsx";

export const metadata: Metadata = { title: "Compare communities | ReliefReady" };

// care access: compare which care places are within reach across calgary communities, from the public snapshot
export default function CareAccessPage() {
  return <AccessMap />;
}
