import type { Metadata } from "next";
import { RecoverScreen } from "@/components/app/recover/RecoverScreen.tsx";

export const metadata: Metadata = { title: "Recover | ReliefReady" };

// recover: what is left before things are back to normal after the care week
export default function RecoverPage() {
  return <RecoverScreen />;
}
