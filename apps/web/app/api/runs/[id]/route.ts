import type { NextRequest } from 'next/server';
import { json, runIdOk, visitor } from '@/lib/server/http';
import { runState } from '@/lib/server/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const state = runIdOk(id) ? await runState(id, visitor(req)) : null;
  return state ? json(state) : json({ error: 'no such run' }, 404);
}
