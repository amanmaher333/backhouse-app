import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/server';

/**
 * Same-origin MCP endpoint: forwards MCP JSON-RPC requests to the API's /mcp,
 * so assistants can be pointed at the web address. Authentication is the
 * caller's own bearer token (a boh_pat_ access token).
 */
export async function POST(req: NextRequest) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: req.headers.get('accept') ?? 'application/json, text/event-stream',
  };
  const auth = req.headers.get('authorization');
  if (auth) headers.authorization = auth;
  const protocol = req.headers.get('mcp-protocol-version');
  if (protocol) headers['mcp-protocol-version'] = protocol;
  const res = await fetch(`${API_URL}/mcp`, { method: 'POST', headers, body: await req.text(), cache: 'no-store' });
  return new NextResponse(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export function GET() {
  return NextResponse.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { status: 405, headers: { Allow: 'POST' } });
}
