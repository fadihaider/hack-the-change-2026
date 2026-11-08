import { SessionProvider } from "@/components/app/session.tsx";
import { Shell } from "@/components/app/Shell.tsx";
import { StartScreen } from "@/components/app/start/StartScreen.tsx";
import { LiveRegion } from "@/components/app/ui.tsx";

// the start: welcome back to the current care week, or the intake question when there is none
export default function Home() {
  return (
    <SessionProvider>
      <LiveRegion>
        <Shell>
          <StartScreen />
        </Shell>
      </LiveRegion>
    </SessionProvider>
  );
}
