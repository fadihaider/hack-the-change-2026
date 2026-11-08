import { Suspense } from "react";
import type { Metadata } from "next";
import { CareScreen } from "@/components/app/care/CareScreen.tsx";

export const metadata: Metadata = { title: "Care | ReliefReady" };

// care: what anyone helping the person being cared for should know. the screen reads ?step=, so it needs a suspense boundary
export default function CarePage() {
  return (
    <Suspense fallback={null}>
      <CareScreen />
    </Suspense>
  );
}
