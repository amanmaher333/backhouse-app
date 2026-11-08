'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface Org {
  id: string;
  name: string;
  nameAr?: string | null;
  type: 'restaurant_group' | 'supplier' | 'platform';
}
export interface Membership {
  roleKey: string;
  roleName: string;
  scope: 'org' | 'site';
  permissions: string[];
  siteIds: string[] | null;
}
export interface Me {
  user: { id: string; email: string; fullName: string; locale: string };
  organizations: Org[];
  currentOrgId: string | null;
  memberships: Membership[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(body?.message ?? `Request failed (${status})`);
  }
  /** Field → first message, from the API's zod issues. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of this.body?.issues ?? []) {
      const k = (i.path ?? []).join('.');
      if (k && !out[k]) out[k] = i.message;
    }
    return out;
  }
}

type Status = 'loading' | 'anonymous' | 'authenticated';

interface Session {
  status: Status;
  me: Me | null;
  /** raw: return the response text (e.g. CSV) instead of parsed JSON. */
  api: <T = any>(path: string, init?: { method?: string; body?: unknown; raw?: boolean }) => Promise<T>;
  /** Called with the JSON from /api/session/{login,signup,accept}. */
  begin: (data: { accessToken: string; orgId: string | null }) => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (perm: string) => boolean;
  reload: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);
const ORG_KEY = 'boh.org';

function matches(granted: string, required: string) {
  return granted === '*' || granted === required || (granted.endsWith(':*') && required.startsWith(granted.slice(0, -1)));
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const token = useRef<string | null>(null);
  const refreshing = useRef<Promise<boolean> | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (refreshing.current) return refreshing.current;
    refreshing.current = (async () => {
      let orgId: string | null = null;
      try {
        orgId = localStorage.getItem(ORG_KEY);
      } catch {}
      const attempt = (org: string | null) =>
        fetch('/api/session/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orgId: org }),
        });
      let res = await attempt(orgId);
      if (res.status === 403 && orgId) {
        // Stored org is no longer valid (the API rolled back, so the token is still usable).
        try {
          localStorage.removeItem(ORG_KEY);
        } catch {}
        res = await attempt(null);
      }
      if (!res.ok) {
        token.current = null;
        return false;
      }
      const data = await res.json();
      token.current = data.accessToken;
      return true;
    })().finally(() => {
      refreshing.current = null;
    });
    return refreshing.current;
  }, []);

  const api = useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> => {
      const run = () =>
        fetch(`/api/v1${path}`, {
          method: init.method ?? 'GET',
          headers: {
            ...(token.current ? { authorization: `Bearer ${token.current}` } : {}),
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      let res = await run();
      if (res.status === 401 && (await refresh())) res = await run();
      if (res.status === 401) {
        setStatus('anonymous');
        setMe(null);
      }
      const text = res.status === 204 ? '' : await res.text();
      if (init.raw && res.ok) return text as T;
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { message: text };
      }
      if (!res.ok) throw new ApiError(res.status, data);
      return data as T;
    },
    [refresh],
  );

  const loadMe = useCallback(async () => {
    const data = await api<Me>('/auth/me');
    setMe(data);
    setStatus('authenticated');
    try {
      if (data.currentOrgId) localStorage.setItem(ORG_KEY, data.currentOrgId);
    } catch {}
  }, [api]);

  useEffect(() => {
    (async () => {
      if (await refresh()) await loadMe().catch(() => setStatus('anonymous'));
      else setStatus('anonymous');
    })();
  }, [refresh, loadMe]);

  const begin = useCallback(
    async (data: { accessToken: string; orgId: string | null }) => {
      token.current = data.accessToken;
      try {
        if (data.orgId) localStorage.setItem(ORG_KEY, data.orgId);
      } catch {}
      await loadMe();
    },
    [loadMe],
  );

  const switchOrg = useCallback(
    async (orgId: string) => {
      const res = await fetch('/api/session/switch-org', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token.current}` },
        body: JSON.stringify({ orgId }),
      });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      await begin(await res.json());
    },
    [begin],
  );

  const signOut = useCallback(async () => {
    await fetch('/api/session/logout', { method: 'POST' });
    token.current = null;
    try {
      localStorage.removeItem(ORG_KEY);
    } catch {}
    setMe(null);
    setStatus('anonymous');
  }, []);

  const can = useCallback(
    (perm: string) => !!me?.memberships.some((m) => m.permissions.some((p) => matches(p, perm))),
    [me],
  );

  return (
    <Ctx.Provider value={{ status, me, api, begin, switchOrg, signOut, can, reload: loadMe }}>{children}</Ctx.Provider>
  );
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Tiny data hook: load once, with reload. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const { api } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, path, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}
