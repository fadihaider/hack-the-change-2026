"use client";
// the signed-in session and the two api clients, shared by every screen under one provider
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createLiveApi, liveErrorMessage, type LiveApi, type LiveSession } from "@/lib/frontend/live-api.ts";
import { createRequestApi, RequestApiError } from "@/lib/frontend/request-api.ts";

export type RequestApi = ReturnType<typeof createRequestApi>;
export type Apis = { live: LiveApi; requests: RequestApi };

export type SessionState = {
  /** null until the first load succeeds */
  session: LiveSession | null;
  /** true only until the first session arrives; reload() keeps the current session on screen */
  loading: boolean;
  /** plain-language text when the last load failed, otherwise null */
  error: string | null;
  /** fetches the session again; never throws */
  reload: () => Promise<void>;
};

// one client of each kind for the whole tab
const APIS: Apis = { live: createLiveApi(), requests: createRequestApi() };

// the newest session this tab has seen, so moving between layouts does not flash a loading screen
let lastSession: LiveSession | null = null;

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LiveSession | null>(lastSession);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(lastSession === null);
  const seq = useRef(0);
  const hasSession = useRef(lastSession !== null);

  const reload = useCallback(async () => {
    seq.current += 1;
    const mine = seq.current;
    // a retry after a failed first load shows the loading state again
    if (!hasSession.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await APIS.live.session();
      if (mine !== seq.current) return;
      lastSession = next;
      hasSession.current = true;
      setSession(next);
      setError(null);
    } catch (caught) {
      if (mine !== seq.current) return;
      setError(sessionErrorMessage(caught));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<SessionState>(() => ({ session, loading, error, reload }), [session, loading, error, reload]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider.");
  return value;
}

export function useApis(): Apis {
  return APIS;
}

function sessionErrorMessage(error: unknown): string {
  if (error instanceof RequestApiError && (error.status === 401 || error.status === 403)) return liveErrorMessage(error);
  return "ReliefReady couldn’t reach its server. Check your connection, then try again.";
}

/** the name to show for the person being cared for, e.g. "Rosa" */
export function recipientName(session: LiveSession | null): string {
  return session?.careRecipient?.displayName ?? session?.careRecipient?.alias ?? "your family member";
}
