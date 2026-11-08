import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '@/lib/server';

/*
 * Session endpoints (backend-for-frontend).
 * The API returns { accessToken, refreshToken }. We keep the refresh token in an
 * httpOnly cookie and hand only the short-lived access token to the browser.
 */

const PASS_THROUGH: Record<string, string> = {
  login: '/v1/auth/login',
  signup: '/v1/auth/signup',
  accept: '/v1/auth/accept-invitation',
};

async function callApi(path: string, body: unknown, accessToken?: string) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: accessToken } : {}) },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

function strip(data: any) {
  if (data && typeof data === 'object') {
    const { refreshToken: _rt, ...rest } = data;
    return rest;
  }
  return data;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const body = await req.json().catch(() => ({}));

  if (PASS_THROUGH[action]) {
    const { status, data } = await callApi(PASS_THROUGH[action]!, body);
    if (status < 300 && data?.refreshToken) await setRefreshCookie(data.refreshToken);
    return NextResponse.json(strip(data), { status });
  }

  if (action === 'refresh') {
    const rt = await readRefreshCookie();
    if (!rt) return NextResponse.json({ statusCode: 401, message: 'No session' }, { status: 401 });
    const { status, data } = await callApi('/v1/auth/refresh', { refreshToken: rt, orgId: body.orgId || undefined });
    if (status < 300 && data?.refreshToken) await setRefreshCookie(data.refreshToken);
    else if (status === 401) await clearRefreshCookie();
    return NextResponse.json(strip(data), { status });
  }

  if (action === 'switch-org') {
    const { status, data } = await callApi('/v1/auth/switch-org', { orgId: body.orgId }, req.headers.get('authorization') ?? undefined);
    if (status < 300 && data?.refreshToken) {
      // Retire the previous session's token family before replacing the cookie.
      const old = await readRefreshCookie();
      if (old) await callApi('/v1/auth/logout', { refreshToken: old });
      await setRefreshCookie(data.refreshToken);
    }
    return NextResponse.json(strip(data), { status });
  }

  if (action === 'logout') {
    const rt = await readRefreshCookie();
    if (rt) await callApi('/v1/auth/logout', { refreshToken: rt });
    await clearRefreshCookie();
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json({ statusCode: 404, message: 'Unknown action' }, { status: 404 });
}
