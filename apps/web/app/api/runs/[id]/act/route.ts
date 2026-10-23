/**
 * Runs the next tick, or fast-forwards to the next scene, and streams what happens as newline-delimited JSON. The work
 * is kept alive past a dropped connection, so a visitor who reloads mid-tick finds it finished and saved.
 */
import type { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { fromThisPage } from '@/lib/server/auth';
import { json, runIdOk, smallJson, visitor } from '@/lib/server/http';
import { begin, Refused, type Action } from '@/lib/server/runs';
import type { Message } from '@/lib/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function actionOf(body: Record<string, unknown>): Action | null {
  if (body.action === 'skip') return { kind: 'skip' };
  if (body.action !== 'step') return null;
  const mode = body.mode === 'live' || body.mode === 'replay' || body.mode === 'stand-in' ? body.mode : null;
  if (!mode) return null;
  const speed = body.speed === 2 || body.speed === 4 ? body.speed : 1;
  return { kind: 'step', mode, speed };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!fromThisPage(req)) return json({ error: 'forbidden' }, 403);
  const { id } = await ctx.params;
  if (!runIdOk(id)) return json({ error: 'no such run' }, 404);
  const body = await smallJson(req);
  const action = body ? actionOf(body) : null;
  if (!action) return json({ error: 'not an action' }, 400);

  let run: Awaited<ReturnType<typeof begin>>;
  try {
    run = await begin(id, action, visitor(req));
  } catch (error) {
    if (error instanceof Refused) return json({ error: error.message }, error.status);
    throw error;
  }

  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (m: Message): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(m)}\n`));
        } catch {
          open = false;
        }
      };
      const done = run(emit)
        .catch((error: unknown) => emit({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          if (open) controller.close();
          open = false;
        });
      waitUntil(done);
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
