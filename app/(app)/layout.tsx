import type { ReactNode } from "react";
import { SessionProvider } from "@/components/app/session.tsx";
import { Shell } from "@/components/app/Shell.tsx";
import { LiveRegion } from "@/components/app/ui.tsx";

// the shared frame for Urgent, Care and Recover: one session, one top bar, one polite live region
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <LiveRegion>
        <Shell>{children}</Shell>
      </LiveRegion>
    </SessionProvider>
  );
}
