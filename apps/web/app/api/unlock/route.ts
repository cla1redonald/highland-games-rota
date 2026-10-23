/** The password for live ticks: right, and this browser is unlocked for a week; DELETE locks it again. */
import type { NextRequest } from 'next/server';
import { checkPassword, cookieMaxAge, cookieName, fromThisPage, passwordSet, token } from '@/lib/server/auth';
import { json, smallJson } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

export async function POST(req: NextRequest): Promise<Response> {
  if (!fromThisPage(req)) return json({ error: 'forbidden' }, 403);
  if (!passwordSet()) return json({ error: 'live ticks are not set up on this server' }, 403);
  const body = await smallJson(req);
  const given = typeof body?.password === 'string' ? body.password : '';
  // A wrong guess costs a little time, so guessing in bulk is slow.
  if (!checkPassword(given)) {
    await slow();
    return json({ error: 'that is not the password' }, 401);
  }
  const res = json({ ok: true });
  res.headers.append('set-cookie', `${cookieName}=${token() ?? ''}; Path=/; Max-Age=${cookieMaxAge}; HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return res;
}

export function DELETE(req: NextRequest): Response {
  if (!fromThisPage(req)) return json({ error: 'forbidden' }, 403);
  const res = json({ ok: true });
  res.headers.append('set-cookie', `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  return res;
}
