import * as Sentry from '@sentry/node';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

/**
 * Error reporting to Sentry. Off unless SENTRY_DSN is set; every call is then a no-op.
 *
 * Only errors are sent (no tracing, no request bodies, no headers, no cookies, no IP addresses).
 * Events carry ids (user, organisation, request) so a report can be traced in the audit log,
 * but never names, emails, phone numbers or what someone typed.
 */
export interface MonitoringConfig {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  NODE_ENV: string;
}

let enabled = false;

export function monitoringEnabled(): boolean {
  return enabled;
}

/** `extra` is for tests (e.g. a capturing transport). */
export function initMonitoring(config: MonitoringConfig, service: 'api' | 'worker', extra: Partial<NodeOptions> = {}): boolean {
  if (!config.SENTRY_DSN || enabled) return enabled;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.SENTRY_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA,
    serverName: service,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, genAI: { inputs: false, outputs: false } },
    tracesSampleRate: 0,
    // No automatic instrumentation: it would record outgoing URLs (Foodics, WhatsApp, Moyasar) as breadcrumbs.
    defaultIntegrations: false,
    enableRuntimeChannelInjection: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
    ],
    beforeSend: scrubEvent,
    initialScope: { tags: { service } },
    ...extra,
  });
  enabled = true;
  return true;
}

/** Strips anything that could hold personal data or secrets before an event leaves the server. */
export function scrubEvent<T extends Pick<ErrorEvent, 'request' | 'user' | 'breadcrumbs' | 'extra'>>(event: T): T {
  if (event.request) {
    const url = event.request.url ? event.request.url.split('?')[0] : undefined;
    event.request = { method: event.request.method, url };
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  delete event.breadcrumbs;
  return event;
}

export interface ErrorContext {
  /** Where it happened, e.g. "http" or "worker". */
  source: string;
  method?: string;
  /** Route pattern ("/v1/orders/:id"), never the full URL. */
  route?: string;
  requestId?: string;
  userId?: string;
  orgId?: string | null;
  tags?: Record<string, string>;
}

export function reportError(err: unknown, ctx: ErrorContext): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setTag('source', ctx.source);
    if (ctx.method) scope.setTag('method', ctx.method);
    if (ctx.route) scope.setTag('route', ctx.route);
    if (ctx.requestId) scope.setTag('request_id', ctx.requestId);
    if (ctx.orgId) scope.setTag('org_id', ctx.orgId);
    if (ctx.userId) scope.setUser({ id: ctx.userId });
    for (const [k, v] of Object.entries(ctx.tags ?? {})) scope.setTag(k, v);
    Sentry.captureException(err);
  });
}

export interface ClientErrorReport {
  message: string;
  stack?: string;
  /** Page path without query string. */
  path?: string;
  kind: 'error' | 'unhandledrejection' | 'render';
  digest?: string;
  userAgent?: string;
  release?: string;
}

/** A browser error forwarded by the web app. */
export function reportClientError(r: ClientErrorReport, ctx: { userId?: string; orgId?: string | null }): void {
  if (!enabled) return;
  const err = new Error(r.message);
  err.name = 'BrowserError';
  if (r.stack) err.stack = r.stack;
  Sentry.withScope((scope) => {
    scope.setTag('source', 'web');
    scope.setTag('kind', r.kind);
    if (r.path) scope.setTag('page', r.path.split('?')[0]!);
    if (r.release) scope.setTag('web_release', r.release);
    if (r.digest) scope.setTag('digest', r.digest);
    if (ctx.orgId) scope.setTag('org_id', ctx.orgId);
    if (ctx.userId) scope.setUser({ id: ctx.userId });
    if (r.userAgent) scope.setContext('browser', { userAgent: r.userAgent });
    scope.setFingerprint(['web', r.message, r.path?.split('?')[0] ?? '']);
    Sentry.captureException(err);
  });
}

/** Turns reporting off again (tests). */
export async function stopMonitoring(): Promise<void> {
  if (!enabled) return;
  enabled = false;
  await Sentry.close(2000);
}

/** Sends anything queued; call before the process exits. */
export async function flushMonitoring(ms = 2000): Promise<void> {
  if (enabled) await Sentry.flush(ms);
}
