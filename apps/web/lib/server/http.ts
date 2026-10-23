/** Small helpers the API routes share. */
import type { NextRequest } from 'next/server';
import { cookieName, unlocked } from './auth';
import type { Visitor } from './runs';

export const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export const visitor = (req: NextRequest): Visitor => ({ unlocked: unlocked(req.cookies.get(cookieName)?.value) });

/** The actions take a few bytes of JSON. Anything larger, or not JSON, is refused. */
export async function smallJson(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get('content-length') ?? 0) > 4096) return null;
  const text = await req.text();
  if (text.length > 4096) return null;
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Run ids are UUIDs: anything else is not looked up. */
export const runIdOk = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
