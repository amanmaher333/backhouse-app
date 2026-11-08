import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/server';

/** Same-origin proxy to the BOH API, so the browser needs no CORS and the API URL stays private. */
async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = `${API_URL}/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const auth = req.headers.get('authorization');
  if (auth) headers.authorization = auth;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  if (hasBody) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? await req.text() : undefined,
    cache: 'no-store',
  });
  const body = res.status === 204 ? null : await res.text();
  return new NextResponse(body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
