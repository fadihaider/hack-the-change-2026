import type { Metadata } from "next";
import { UrgentFlow } from "@/components/app/urgent/UrgentFlow.tsx";

export const metadata: Metadata = {
  title: "Urgent | ReliefReady",
  description: "Decide what happens to each thing in your care week, and approve every message before it goes.",
};

type Props = { searchParams: Promise<{ request?: string | string[] }> };

// urgent: one commitment at a time, then who you asked and help nearby; /urgent?request=<id> opens that message
export default async function UrgentPage({ searchParams }: Props) {
  const { request } = await searchParams;
  const value = Array.isArray(request) ? request[0] : request;
  const requestId = value && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;
  return <UrgentFlow requestId={requestId} />;
}
