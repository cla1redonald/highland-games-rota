/**
 * The room demo's server: one page, one event stream, and three actions (run the next tick, fast-forward to the next
 * scene, start the fortnight again). It listens on the loopback address only. One tick runs at a time.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HARD_CAP_USD, Ledger } from '@ghillie/ledger';
import { isBookkeeping } from '@ghillie/stand-in';
import type { Step } from './managed.js';
import type { RunMode, Show, TickSummary } from './show.js';

const page = (): string => readFileSync(new URL('./page.html', import.meta.url), 'utf8');

export interface LiveServerOptions {
  show: Show;
  /** The ledger, when live is possible: its running total goes on the page. */
  ledger?: Ledger;
  model: string;
}

type Message = Record<string, unknown> & { type: string };

export function createLiveServer(o: LiveServerOptions): Server {
  const clients = new Set<ServerResponse>();
  let busy = false;
  let lastStart: Message | null = null;
  let steps: Message[] = [];
  let lastEnd: Message | null = null;

  const send = (res: ServerResponse, message: Message): void => {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };
  const broadcast = (message: Message): void => {
    for (const res of clients) send(res, message);
  };
  const state = (): Message => ({
    type: 'state',
    model: o.model,
    busy,
    live: o.show.liveAvailable,
    index: o.show.index,
    finished: o.show.finished,
    rows: o.show.rows(),
    plan: o.show.plan(),
    previousPlan: o.show.previousPlan,
    spent: o.show.results.reduce((s, r) => s + r.usd, 0),
    ledger: o.ledger ? { total: o.ledger.total, cap: HARD_CAP_USD } : null,
  });

  const endOf = (summary: TickSummary): Message => ({
    type: 'tick-end',
    ...summary,
    items: undefined,
    mainWrites: summary.run ? summary.run.writes.filter((w) => (w.outcome === 'changed' || w.outcome === 'note') && !isBookkeeping(w)) : [],
  });

  const runOne = async (mode: RunMode, speed: number): Promise<TickSummary> => {
    steps = [];
    lastEnd = null;
    const summary = await o.show.step(mode, {
      speed,
      onStart: ({ at, console, tick }) => {
        lastStart = { type: 'tick-start', at, mode, console, items: tick?.items ?? [], sources: tick?.sources ?? {} };
        broadcast(lastStart);
      },
      onStep: (step: Step) => {
        const message = { type: 'step', ...step };
        steps.push(message);
        broadcast(message);
      },
    });
    lastEnd = endOf(summary);
    broadcast(lastEnd);
    broadcast(state());
    return summary;
  };

  const action = async (name: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    if (busy) return { status: 409, body: { error: 'a tick is running' } };
    busy = true;
    broadcast(state());
    try {
      if (name === 'step') {
        const mode = body.mode === 'live' || body.mode === 'replay' ? body.mode : 'stand-in';
        if (o.show.finished) return { status: 400, body: { error: 'the fortnight is over' } };
        const summary = await runOne(mode, typeof body.speed === 'number' && body.speed > 0 ? body.speed : 1);
        return { status: summary.error && !summary.run ? 502 : 200, body: { ok: !summary.error, error: summary.error ?? null } };
      }
      if (name === 'skip') {
        // Stand-in ticks until the next scene is the next tick to run.
        let ran = 0;
        do {
          if (o.show.finished) break;
          await runOne('stand-in', 1);
          ran++;
        } while (!o.show.finished && !o.show.rows()[o.show.index]?.scene);
        return { status: 200, body: { ran } };
      }
      if (name === 'reset') {
        await o.show.reset();
        lastStart = null;
        lastEnd = null;
        steps = [];
        return { status: 200, body: { ok: true } };
      }
      return { status: 404, body: { error: 'no such action' } };
    } catch (error) {
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
    } finally {
      busy = false;
      broadcast(state());
    }
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      // A page that reconnects mid-tick catches up on what it missed.
      send(res, state());
      if (lastStart) send(res, lastStart);
      for (const s of steps) send(res, s);
      if (lastEnd) send(res, lastEnd);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      void readBody(req).then(async (body) => {
        const result = await action(url.pathname.slice(5), body);
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
