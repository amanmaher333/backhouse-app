import { cookies } from 'next/headers';

export const API_URL = process.env.BOH_API_URL ?? 'http://localhost:3000';
export const RT_COOKIE = 'boh_rt';

/** Refresh token lives only in an httpOnly cookie; the browser never sees it. */
export async function setRefreshCookie(token: string) {
  const jar = await cookies();
  jar.set(RT_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/session',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearRefreshCookie() {
  const jar = await cookies();
  jar.delete({ name: RT_COOKIE, path: '/api/session' });
}

export async function readRefreshCookie(): Promise<string | undefined> {
  return (await cookies()).get(RT_COOKIE)?.value;
}
