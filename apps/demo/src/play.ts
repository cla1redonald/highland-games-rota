/**
 * Plays the seeded fortnight against a fresh store: half-day ticks at 13:00 and 18:00 on weekdays, the organiser's
 * own console actions at the times she made them, a source that hangs on one tick, and a tick the host slept through.
 */
import { existsSync, rmSync } from 'node:fs';
import {
  OrganiserConsole,
  RotaService,
  Store,
  addDays,
  compareInstants,
  isWeekday,
  londonInstant,
  watchdogProblems,
  type CellValue,
  type Decision,
} from '@ghillie/engine';
import { consoleActions, feedSources, logSeedRun, schedule, seedRun, seedWorld, type ConsoleAction, type FeedSources, type Window } from '@ghillie/feed';
import { connectInMemory, type RotaClient } from '@ghillie/mcp-server';
import { runTick, type DryRun } from '@ghillie/stand-in';

export interface DemoWorld {
  /** The store file (or ":memory:"), so a build can start the MCP server over it. */
  dbPath: string;
  store: Store;
  service: RotaService;
  console: OrganiserConsole;
  client: RotaClient;
  feed: FeedSources;
  setNow: (iso: string) => void;
  close: () => Promise<void>;
}

export async function createDemoWorld(dbPath = ':memory:'): Promise<DemoWorld> {
  const changeLogPath = dbPath === ':memory:' ? undefined : `${dbPath}.changes.ndjson`;
  if (dbPath !== ':memory:') {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, changeLogPath ?? '']) if (path && existsSync(path)) rmSync(path);
  }
  const store = new Store({ path: dbPath, ...(changeLogPath ? { changeLogPath } : {}) });
  let now = seedRun.loggedAt;
  const clock = (): Date => new Date(now);
  const { service, console: organiser } = seedWorld(store, clock);
  logSeedRun(service);
  return connectWorld(dbPath, store, service, organiser, (iso) => {
    now = iso;
  });
}

/**
 * Opens a store a fresh world was already seeded into, as it was left: nothing is wiped and nothing is seeded again.
 * The hosted demo keeps each visitor's store between ticks this way. The clock starts at `now`.
 */
export async function openDemoWorld(dbPath: string, now: string): Promise<DemoWorld> {
  const store = new Store({ path: dbPath });
  let current = now;
  const clock = (): Date => new Date(current);
  return connectWorld(dbPath, store, new RotaService({ store, clock }), new OrganiserConsole(store, clock), (iso) => {
    current = iso;
  });
}

async function connectWorld(dbPath: string, store: Store, service: RotaService, organiser: OrganiserConsole, setNow: (iso: string) => void): Promise<DemoWorld> {
  const client = await connectInMemory(service);
  return {
    dbPath,
    store,
    service,
    console: organiser,
    client,
    feed: feedSources(),
    setNow,
    close: async () => {
      await client.close();
      store.close();
    },
  };
}

export interface Tick {
  at: string;
  /** Why the run never happened, for a skipped tick. */
  skipped?: string;
}

export function fortnightTicks(): Tick[] {
  const plan = schedule();
  const ticks: Tick[] = [];
  for (let day = plan.firstDay; day <= plan.lastDay; day = addDays(day, 1)) {
    if (!isWeekday(day)) continue;
    for (const time of ['13:00', '18:00']) {
      const at = londonInstant(day, time);
      const skip = plan.skip.find((s) => compareInstants(s.at, at) === 0);
      ticks.push(skip ? { at, skipped: skip.why } : { at });
    }
  }
  return ticks;
}

export interface TickResult {
  tick: Tick;
  run?: DryRun;
  console: string[];
  watchdog: string[];
}

export function applyConsole(world: DemoWorld, action: ConsoleAction): string {
  world.setNow(action.at);
  switch (action.action) {
    case 'pencil':
      world.console.pencil(action.person, action.event, action.asLead ?? false);
      return `Isla pencils ${action.person} at ${action.event}`;
    case 'edit':
      world.console.editCell(action.person, action.event, action.value as CellValue, action.note);
      return `Isla edits ${action.person} to ${action.value} at ${action.event} by hand`;
    case 'approve_decision':
      return world.console.approveDecision(action.person, action.event, action.value as Decision).detail;
    case 'approve_event':
      return world.console.approveEventChange(action.event, action.fields).detail;
    case 'approve':
    case 'decline': {
      const proposal = world.service.proposalViews().find((p) => p.name === action.name && p.status === 'pending');
      if (!proposal) return `Isla tries to ${action.action} ${action.name}, but there is no pending proposal`;
      const result = action.action === 'approve' ? world.console.approve(proposal.id) : world.console.decline(proposal.id);
      return result.detail;
    }
  }
}

/** Runs one tick. The stand-in by default; the Messages API build (live or replayed) for the recorded demo. */
export type TickAgent = (args: { world: DemoWorld; now: string; window?: Window; timeoutMs: number }) => Promise<DryRun>;

export const standInAgent: TickAgent = ({ world, now, window, timeoutMs }) => runTick({ client: world.client.client, now, feed: world.feed, timeoutMs, ...(window ? { window } : {}) });

export interface PlayOptions {
  agent?: TickAgent;
  timeoutMs?: number;
  /** Replays: read each tick over a fixed window instead of anchoring on the previous run. */
  windows?: Map<string, Window>;
  applyConsole?: boolean;
  watchdog?: boolean;
  onTick?: (result: TickResult) => void;
}

/** Plays the ticks in order. Returns one result per tick. */
export async function playTicks(world: DemoWorld, ticks: Tick[], options: PlayOptions = {}): Promise<TickResult[]> {
  const pending = options.applyConsole === false ? [] : [...consoleActions()].sort((a, b) => compareInstants(a.at, b.at));
  const results: TickResult[] = [];
  for (const tick of ticks) {
    const consoleLines: string[] = [];
    while (pending[0] && compareInstants(pending[0].at, tick.at) <= 0) {
      const action = pending.shift();
      if (action) consoleLines.push(applyConsole(world, action));
    }
    world.setNow(tick.at);
    const result: TickResult = { tick, console: consoleLines, watchdog: [] };
    if (!tick.skipped) {
      const window = options.windows?.get(tick.at);
      result.run = await (options.agent ?? standInAgent)({ world, now: tick.at, timeoutMs: options.timeoutMs ?? 50, ...(window ? { window } : {}) });
    }
    // The watchdog checks at 20:00 on weekday evenings, after the 18:00 slot.
    if (options.watchdog !== false && tick.at.slice(11, 16) === '18:00') {
      const checkAt = londonInstant(tick.at.slice(0, 10), '20:00');
      world.setNow(checkAt);
      result.watchdog = watchdogProblems(checkAt, world.store.runs());
    }
    results.push(result);
    options.onTick?.(result);
  }
  return results;
}
