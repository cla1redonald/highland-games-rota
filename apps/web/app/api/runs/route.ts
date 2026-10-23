import type { NextRequest } from 'next/server';
import { fromThisPage } from '@/lib/server/auth';
import { json, visitor } from '@/lib/server/http';
import { createRun, runState } from '@/lib/server/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Starts a fresh fortnight for this visitor. */
export async function POST(req: NextRequest): Promise<Response> {
  if (!fromThisPage(req)) return json({ error: 'forbidden' }, 403);
  const id = await createRun();
  return json(await runState(id, visitor(req)));
}
