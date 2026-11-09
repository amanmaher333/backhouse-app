/**
 * Sends browser errors to the API (/v1/client-errors), which forwards them to Sentry when it's on.
 * Only the message, stack, page path (no query string) and browser are sent: never page content or form values.
 */
let token: string | null = null;
const seen = new Set<string>();
const MAX_PER_PAGE_LOAD = 10;

/** Kept in step with the session so reports carry the person's ids (not their name or email). */
export function setReportToken(t: string | null) {
  token = t;
}

// Noise that isn't ours to fix: browser quirks, extensions, cross-origin scripts.
const IGNORE = [/ResizeObserver loop/i, /^Script error\.?$/i, /Non-Error promise rejection captured/i, /AbortError/i, /Load failed$/i];

export function reportError(err: unknown, kind: 'error' | 'unhandledrejection' | 'render' = 'error', digest?: string) {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err) ?? 'Unknown error');
    const message = (e.message || e.name || 'Unknown error').slice(0, 1000);
    if (IGNORE.some((r) => r.test(message))) return;
    if (e.stack && /(chrome|moz|safari(-web)?)-extension:\/\//.test(e.stack)) return;
    const key = `${kind}:${message}`;
    if (seen.has(key) || seen.size >= MAX_PER_PAGE_LOAD) return;
    seen.add(key);
    void fetch('/api/v1/client-errors', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        message,
        stack: e.stack?.slice(0, 8000),
        path: location.pathname.slice(0, 300),
        kind,
        digest,
        userAgent: navigator.userAgent.slice(0, 300),
        release: process.env.NEXT_PUBLIC_RELEASE || undefined,
      }),
    }).catch(() => {});
  } catch {
    // Reporting must never break the page.
  }
}

/** Window-level listeners for errors nothing else caught. Returns a cleanup function. */
export function listenForErrors(): () => void {
  const onError = (ev: ErrorEvent) => reportError(ev.error ?? ev.message, 'error');
  const onRejection = (ev: PromiseRejectionEvent) => reportError(ev.reason, 'unhandledrejection');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
