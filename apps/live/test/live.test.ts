/**
 * The room demo: the fortnight stepped one tick at a time, a Managed Agents tick against a fake platform (recorded as
 * it runs), the same tick replayed from that recording for free, and the page's server over real HTTP.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDemoWorld, fortnightTicks, playTicks } from '@ghillie/demo';
import { renderPlanText } from '@ghillie/engine';
import { Ledger } from '@ghillie/ledger';
import type { ManagedEvent, ManagedPort, ManagedSession } from '@ghillie/agent-managed';
import { recordingFile, runManagedDemoTick, type Step } from '../src/managed.js';
import { sceneAt } from '../src/scenes.js';
import { createLiveServer } from '../src/server.js';
import { Show } from '../src/show.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ghillie-live-'));

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void)[] = [];
  push(item: T): void {
    const w = this.waiting.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

/** A platform that runs one scripted segment per user message and pauses on every custom tool call. */
class FakePlatform implements ManagedPort {
  private queue = new Queue<ManagedEvent>();
  private resume: (() => void) | null = null;
  private n = 0;
  constructor(private readonly segments: { custom: string; input: Record<string, unknown> }[][]) {}
  private emit(event: Record<string, unknown>): void {
    this.queue.push({ id: `sevt_${++this.n}`, ...event } as ManagedEvent);
  }
  createAgent = (): never => {
    throw new Error('not here');
  };
  createEnvironment = this.createAgent;
  createDeployment = this.createAgent;
  pauseDeployment = this.createAgent;
  listSessions = (): Promise<ManagedSession[]> => Promise.resolve([]);
  listDeploymentRuns = (): Promise<Record<string, unknown>[]> => Promise.resolve([]);
  listEvents = (): Promise<ManagedEvent[]> => Promise.resolve([]);
  createSession = (): Promise<ManagedSession> => Promise.resolve({ id: 'sesn_fake', status: 'idle' });
  retrieveSession = (id: string): Promise<ManagedSession> => Promise.resolve({ id, status: 'idle', usage: { list_cost: { amount: '1', currency: 'USD' } } });
  stream = (): Promise<AsyncIterable<ManagedEvent>> => Promise.resolve(this.queue);
  send(_id: string, events: Record<string, unknown>[]): Promise<void> {
    for (const e of events) {
      if (e.type === 'user.message') void this.run(this.segments.shift() ?? []);
      else if (this.resume) {
        const go = this.resume;
        this.resume = null;
        go();
      }
    }
    return Promise.resolve();
  }
  private async run(steps: { custom: string; input: Record<string, unknown> }[]): Promise<void> {
    this.emit({ type: 'session.status_running' });
    for (const step of steps) {
      this.emit({ type: 'span.model_request_end', is_error: false, model_usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } });
      this.emit({ type: 'agent.custom_tool_use', name: step.custom, input: step.input });
      this.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action' } });
      await new Promise<void>((resolve) => (this.resume = resolve));
    }
    this.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Dougie asked to be Chief Steward. That is for Isla.' }] });
    this.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
  }
}

const dougieTick = '2027-06-07T18:00:00+01:00';
const said = { source: 'chat #committee', evidenceAt: '2027-06-07T14:25:00+01:00' };
/** What a model might do with Dougie's order: one forged booking, one honest reading. */
const dougieScript = (): { custom: string; input: Record<string, unknown> }[][] => [
  [
    { custom: 'read_rota', input: {} },
    { custom: 'set_decision', input: { person: 'Dougie', event: 'kinloch', value: 'Stewarding', ...said } },
    { custom: 'set_availability', input: { person: 'Dougie', event: 'kinloch', value: 'Maybe', ...said, saidBy: 'Dougie' } },
  ],
];

function ledgerIn(dir: string): Ledger {
  return new Ledger({ path: join(dir, 'spend.jsonl'), print: () => undefined, stop: (m) => {
    throw new Error(m);
  } });
}

describe('the scenes', () => {
  it('each scene is a tick in the fortnight, and the free one is the tick the host slept through', () => {
    const ticks = fortnightTicks();
    const withScene = ticks.filter((t) => sceneAt(t.at));
    expect(withScene.length).toBe(8);
    for (const t of withScene) if (sceneAt(t.at)?.free) expect(t.skipped).toBeTruthy();
    expect(sceneAt(dougieTick)?.title).toMatch(/Dougie/);
  });
});

describe('the show', () => {
  it('stepped with the stand-in, it ends where the terminal demo ends', async () => {
    const dir = tmp();
    const show = await Show.open({ dbPath: join(dir, 'live.db'), recordingDir: dir });
    while (!show.finished) await show.step('stand-in');
    const ours = renderPlanText(show.plan());
    expect(show.results).toHaveLength(fortnightTicks().length);
    const slept = show.results.find((r) => r.mode === 'skipped');
    expect(slept?.watchdog.join(' ')).toMatch(/No run was logged/);
    await show.close();

    const world = await createDemoWorld(':memory:');
    await playTicks(world, fortnightTicks());
    expect(ours).toBe(renderPlanText(world.service.read().plan));
    await world.close();
  });

  it('runs a tick live on a fake platform, records it, and replays the recording to the same rota for nothing', async () => {
    const dir = tmp();
    const ledger = ledgerIn(dir);
    const liveSteps: Step[] = [];
    const show = await Show.open({
      dbPath: join(dir, 'live.db'),
      recordingDir: dir,
      meter: ledger,
      managed: (a) => runManagedDemoTick({ ...a, port: new FakePlatform(dougieScript()) }),
    });
    expect(show.liveAvailable).toBe(true);
    await show.step('stand-in');
    const live = await show.step('live', { onStep: (s) => liveSteps.push(s) });
    expect(live.at).toBe(dougieTick);
    expect(live.error).toBeUndefined();
    const verdicts = liveSteps.filter((s) => s.kind === 'verdict');
    expect(verdicts.map((v) => [v.name, v.allow])).toEqual([
      ['set_decision', false],
      ['set_availability', true],
    ]);
    expect(liveSteps.some((s) => s.kind === 'note')).toBe(true);
    expect(liveSteps.filter((s) => s.kind === 'model')).toHaveLength(3);
    expect(show.world.store.cells().find((c) => c.person === 'Dougie' && c.event === 'kinloch')?.value).toBe('Maybe');
    expect(ledger.total).toBeGreaterThan(0);
    expect(existsSync(join(dir, recordingFile(dougieTick)))).toBe(true);
    const livePlan = renderPlanText(show.plan());
    await show.close();

    const replaySteps: Step[] = [];
    const replay = await Show.open({ dbPath: join(dir, 'replay.db'), recordingDir: dir });
    expect(replay.liveAvailable).toBe(false);
    expect(replay.rows()[1]?.recorded).toBe(true);
    await replay.step('stand-in');
    const before = ledger.total;
    const played = await replay.step('replay', { speed: 1000, onStep: (s) => replaySteps.push(s) });
    expect(played.error).toBeUndefined();
    expect(replaySteps.filter((s) => s.kind === 'verdict').map((v) => [v.name, v.allow])).toEqual(verdicts.map((v) => [v.name, v.allow]));
    expect(replaySteps.find((s) => s.kind === 'session')).toMatchObject({ sessionId: 'sesn_fake' });
    expect(renderPlanText(replay.plan())).toBe(livePlan);
    expect(ledgerIn(dir).total).toBe(before);
    await replay.close();
  });

  it('refuses live without a key, and does not count the tick', async () => {
    const dir = tmp();
    const show = await Show.open({ dbPath: join(dir, 'live.db'), recordingDir: dir });
    const failed = await show.step('live');
    expect(failed.error).toMatch(/API key/);
    expect(show.index).toBe(0);
    const ok = await show.step('stand-in');
    expect(ok.at).toBe(fortnightTicks()[0]?.at);
    expect(ok.console).toEqual([]);
    await show.close();
  });
});

describe('the server', () => {
  it('serves the page, streams state, and runs a tick on request', async () => {
    const dir = tmp();
    const show = await Show.open({ dbPath: join(dir, 'live.db'), recordingDir: dir });
    const server = createLiveServer({ show, model: 'claude-sonnet-5-5' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await (await fetch(base)).text();
      expect(page).toContain('Ghillie at work');
      expect(page).not.toMatch(/\u2014/);

      const controller = new AbortController();
      const events = await fetch(`${base}/events`, { signal: controller.signal });
      const reader = events.body!.getReader();
      const chunk: { value?: Uint8Array } = await reader.read();
      const first = new TextDecoder().decode(chunk.value);
      expect(first).toContain('"type":"state"');

      const step = await fetch(`${base}/api/step`, { method: 'POST', body: JSON.stringify({ mode: 'stand-in' }) });
      expect(step.status).toBe(200);
      expect(show.index).toBe(1);
      const skip = (await (await fetch(`${base}/api/skip`, { method: 'POST' })).json()) as { ran: number };
      expect(skip.ran).toBeGreaterThan(0);
      expect(show.rows()[show.index]?.scene).toBeTruthy();
      controller.abort();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await show.close();
    }
  });
});
