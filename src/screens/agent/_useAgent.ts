/**
 * useAgentMe — single source of truth for the Agent Portal screens.
 *
 * Calls `GET /agents/me` on mount, caches the result in state, exposes
 * `refresh()` to re-fetch after a mutation. Auto-creates the agent row
 * the first time it's called (via `agentApi.create('cpo')`) so every
 * screen in the 9-screen flow can rely on `/agents/me` returning 200.
 */
import {useCallback, useEffect, useState} from 'react';
import {agentApi, type AgentPortalState, type AgentPortalType} from '@services/api';
import {useAuthStore} from '@store/authStore';

interface UseAgentMe {
  data: AgentPortalState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAgentMe(opts?: {autoCreate?: boolean; type?: AgentPortalType}): UseAgentMe {
  const [data, setData]       = useState<AgentPortalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await agentApi.getMe();
      setData(res.data);
    } catch (e: unknown) {
      const status = (e as {response?: {status?: number}})?.response?.status;
      // First-time agent → create row, then retry.
      if (status === 404 && opts?.autoCreate) {
        try {
          // B-90 T-10 — seed display_name from the signed-in user so the
          // dashboard shows a real name/initials instead of "AGENT"/"AG".
          const fullName = useAuthStore.getState().user?.full_name?.trim();
          await agentApi.create(opts.type ?? 'cpo', fullName || undefined);
          const retry = await agentApi.getMe();
          setData(retry.data);
          setError(null);
        } catch (e2: unknown) {
          setError((e2 as Error).message ?? 'Failed to create agent profile');
        }
      } else {
        setError((e as Error).message ?? 'Failed to load agent');
      }
    } finally {
      setLoading(false);
    }
  }, [opts?.autoCreate, opts?.type]);

  useEffect(() => { void load(); }, [load]);

  return {data, loading, error, refresh: load};
}
