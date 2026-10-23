/**
 * A visitor's run: their own fortnight, from a fresh rota. Between ticks it is two things in Turso: the saved show
 * (how far it has got, what each tick did) and the rota's SQLite file, whole. A tick copies the file to the function's
 * disk, carries the show on with the engine exactly as it runs locally, and puts the file back.
 *
 * One tick at a time per run: a tick takes a lease on its run, and a second request while it is held is refused.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasCredentials } from '@ghillie/agent-messages';
import { fortnightTicks } from '@ghillie/demo';
import { config } from '@ghillie/engine';
import { recordingFile, sceneAt, Show, type SavedShow } from '@ghillie/live';
import { isBookkeeping } from '@ghillie/stand-in';
import type { Message, Row, RunMode, State } from '../messages';
import { db, text } from './db';
import { committedRecordings, idsPath, scratch } from './paths';
import { keepRecording, layOutRecordings } from './recordings';
import { capUsd, TickLedger, totalSpent } from './spend';

export const model = config.models.managedAgents;
const ticks = fortnightTicks();
/** Longer than a tick can run (the function's limit is 300 s), so a lease outlives its holder only if it died. */
const leaseMs = 330_000;

/** What the page needs that only an open show knows, kept beside the run so reading its state opens nothing. */
interface View {
  index: number;
  finished: boolean;
  plan: State['plan'];
  previousPlan: State['previousPlan'];
  grid: State['grid'];
  previousCells: State['previousCells'];
  spent: number;
  done: (RunMode | 'skipped')[];
}

interface RunRow {
  id: string;
  saved: SavedShow;
  view: View;
  snapshot: Uint8Array;
  busyUntil: number;
}

function viewOf(show: Show): View {
  return {
    index: show.index,
    finished: show.finished,
    plan: show.plan(),
    previousPlan: show.previousPlan,
    grid: show.grid(),
    previousCells: show.previousCells,
    spent: show.results.reduce((s, r) => s + r.usd, 0),
    done: show.results.map((r) => r.mode),
  };
}

/** Closes the show (which folds SQLite's write-ahead log into the file) and returns the file. */
async function closeAndRead(show: Show, path: string): Promise<Uint8Array> {
  await show.close();
  return new Uint8Array(readFileSync(path));
}

export async function createRun(): Promise<string> {
  const id = randomUUID();
  const dir = scratch(`work/${id}`);
  const path = join(dir, 'rota.db');
  try {
    const show = await Show.open({ dbPath: path, model });
    const saved = show.save();
    const view = viewOf(show);
    const snapshot = await closeAndRead(show, path);
    const now = new Date().toISOString();
    await (await db()).execute({
      sql: 'insert into runs (id, created_at, updated_at, saved, view, snapshot, busy_until) values (?, ?, ?, ?, ?, ?, 0)',
      args: [id, now, now, JSON.stringify(saved), JSON.stringify(view), snapshot],
    });
    return id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function getRun(id: string): Promise<RunRow | null> {
  const result = await (await db()).execute({ sql: 'select id, saved, view, snapshot, busy_until from runs where id = ?', args: [id] });
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: text(row.id),
    saved: JSON.parse(text(row.saved)) as SavedShow,
    view: JSON.parse(text(row.view)) as View,
    snapshot: new Uint8Array(row.snapshot as ArrayBuffer),
    busyUntil: Number(row.busy_until),
  };
}

async function recordedTicks(): Promise<Set<string>> {
  const names = new Set(existsSync(committedRecordings) ? readdirSync(committedRecordings) : []);
  const rows = await (await db()).execute('select at from recordings');
  for (const row of rows.rows) names.add(recordingFile(text(row.at)));
  return names;
}

export interface Visitor {
  unlocked: boolean;
}

async function liveFor(visitor: Visitor): Promise<State['live']> {
  const configured = hasCredentials();
  const total = await totalSpent();
  return { configured, unlocked: visitor.unlocked, total, cap: capUsd, open: configured && visitor.unlocked && total < capUsd };
}

function stateOf(run: { id: string; view: View; busyUntil: number }, recorded: Set<string>, live: State['live']): State {
  const v = run.view;
  const rows: Row[] = ticks.map((t, i) => ({
    at: t.at,
    ...(t.skipped ? { skipped: t.skipped } : {}),
    scene: sceneAt(t.at),
    recorded: recorded.has(recordingFile(t.at)),
    done: v.done[i] ?? null,
  }));
  return {
    type: 'state',
    runId: run.id,
    model,
    busy: run.busyUntil > Date.now(),
    index: v.index,
    finished: v.finished,
    rows,
    plan: v.plan,
    previousPlan: v.previousPlan,
    grid: v.grid,
    previousCells: v.previousCells,
    spent: v.spent,
    live,
  };
}

export async function runState(id: string, visitor: Visitor): Promise<State | null> {
  const run = await getRun(id);
  if (!run) return null;
  return stateOf(run, await recordedTicks(), await liveFor(visitor));
}

async function claim(id: string): Promise<boolean> {
  const now = Date.now();
  const result = await (await db()).execute({ sql: 'update runs set busy_until = ? where id = ? and busy_until < ?', args: [now + leaseMs, id, now] });
  return result.rowsAffected === 1;
}

async function release(id: string, saved?: SavedShow, view?: View, snapshot?: Uint8Array): Promise<void> {
  const client = await db();
  if (saved && view && snapshot) {
    await client.execute({
      sql: 'update runs set saved = ?, view = ?, snapshot = ?, updated_at = ?, busy_until = 0 where id = ?',
      args: [JSON.stringify(saved), JSON.stringify(view), snapshot, new Date().toISOString(), id],
    });
  } else {
    await client.execute({ sql: 'update runs set busy_until = 0 where id = ?', args: [id] });
  }
}

export type Action = { kind: 'step'; mode: RunMode; speed: number } | { kind: 'skip' };

export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Checks an action can run on a run and takes the run's lease, throwing Refused if not. Returns the work: it tells
 * `emit` everything as it happens and saves the run when it ends. Once started, a failed tick is reported to the page
 * and not counted, as in the local demo.
 */
export async function begin(id: string, action: Action, visitor: Visitor): Promise<(emit: (m: Message) => void) => Promise<void>> {
  const run = await getRun(id);
  if (!run) throw new Refused(404, 'no such run: start a new one');
  if (run.view.finished) throw new Refused(400, 'the fortnight is over');
  const isLive = action.kind === 'step' && action.mode === 'live';
  // One live tick at a time across every visitor, and the cap read only once it is held: the ledger file each tick
  // carries is seeded from the Turso total, so two at once would each see room under the cap that only one has.
  // Who may run one is checked first, so a visitor without the password never holds the lease, even briefly.
  if (isLive && !hasCredentials()) throw new Refused(403, 'live ticks are not set up on this server');
  if (isLive && !visitor.unlocked) throw new Refused(403, 'live ticks need the password');
  if (isLive && !(await claimLease('live'))) throw new Refused(409, 'someone else is running a live tick: replay this one, or try again in a minute');
  try {
    const live = await liveFor(visitor);
    if (isLive && !live.open) throw new Refused(403, `live ticks are closed: $${live.total.toFixed(2)} of the $${live.cap} cap is spent`);
    if (!(await claim(id))) throw new Refused(409, 'a tick is already running on this run');
    return (emit) => work(run, action, visitor, live, emit).finally(() => (isLive ? releaseLease('live') : undefined));
  } catch (error) {
    if (isLive) await releaseLease('live');
    throw error;
  }
}

/** A deployment-wide lease, held at most leaseMs, so one that outlives a dead function frees itself. */
async function claimLease(name: string): Promise<boolean> {
  const client = await db();
  const now = Date.now();
  await client.execute({ sql: 'insert into leases (name, busy_until) values (?, 0) on conflict(name) do nothing', args: [name] });
  const result = await client.execute({ sql: 'update leases set busy_until = ? where name = ? and busy_until < ?', args: [now + leaseMs, name, now] });
  return result.rowsAffected === 1;
}

async function releaseLease(name: string): Promise<void> {
  await (await db()).execute({ sql: 'update leases set busy_until = 0 where name = ?', args: [name] });
}

async function work(run: RunRow, action: Action, visitor: Visitor, live: State['live'], emit: (m: Message) => void): Promise<void> {
  const id = run.id;
  const dir = scratch(`work/${randomUUID()}`);
  const path = join(dir, 'rota.db');
  let released = false;
  let show: Show | null = null;
  try {
    writeFileSync(path, run.snapshot);
    const recordingDir = await layOutRecordings();
    const at = ticks[run.view.index]?.at ?? '';
    const ledger = action.kind === 'step' && action.mode === 'live' ? await TickLedger.open(id, at) : null;
    show = await Show.resume({ dbPath: path, model, recordingDir, idsPath, inProcess: true, ...(ledger ? { meter: ledger.ledger } : {}) }, run.saved);
    const recorded = await recordedTicks();
    emit(stateOf({ id, view: viewOf(show), busyUntil: Date.now() + leaseMs }, recorded, live));

    const current = show;
    const one = async (mode: RunMode, speed: number): Promise<void> => {
      const summary = await current.step(mode, {
        speed,
        onStart: ({ at: tickAt, console, tick }) => emit({ type: 'tick-start', at: tickAt, mode, console, items: tick?.items ?? [], sources: tick?.sources ?? {} }),
        onStep: (step) => emit({ type: 'step', ...step }),
      });
      // The evidence went out with tick-start; it is not sent twice.
      const { items, ...rest } = summary;
      void items;
      emit({
        type: 'tick-end',
        ...rest,
        mainWrites: summary.run ? summary.run.writes.filter((w) => (w.outcome === 'changed' || w.outcome === 'note') && !isBookkeeping(w)) : [],
      });
    };

    try {
      if (action.kind === 'step') await one(action.mode, action.speed);
      else {
        do await one('stand-in', 1);
        while (!current.finished && !sceneAt(current.ticks[current.index]?.at ?? ''));
      }
    } finally {
      if (ledger) await ledger.flush();
    }
    if (ledger) await keepRecording(recordingDir, at, id);

    // A tick that failed before it counted is not saved: Isla's console actions for it were applied to this copy,
    // and the next try starts again from the file as it was, so they are applied once.
    let view = run.view;
    if (current.index > run.view.index) {
      const saved = current.save();
      view = viewOf(current);
      const snapshot = await closeAndRead(current, path);
      show = null;
      await release(id, saved, view, snapshot);
    } else await release(id);
    released = true;
    emit(stateOf({ id, view, busyUntil: 0 }, await recordedTicks(), await liveFor(visitor)));
  } finally {
    if (show) await show.close().catch(() => undefined);
    if (!released) await release(id);
    rmSync(dir, { recursive: true, force: true });
  }
}
