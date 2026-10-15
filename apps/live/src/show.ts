/**
 * The fortnight, one tick at a time, for a room. The presenter picks how each tick runs:
 *
 *   live      a real Managed Agents session, under the ledger
 *   replay    a recorded Managed Agents session played back: free, and the fallback if the network fails
 *   stand-in  the rule-based stand-in: free and instant, for the ticks between the scenes
 *
 * Isla's console actions happen at the times she made them, a skipped tick is skipped, and the watchdog looks at 20:00
 * after each evening slot, exactly as in the terminal demo.
 */
import { gatherTick, prepareTick, type TickInput } from '@ghillie/agent-kit';
import { applyConsole, createDemoWorld, fortnightTicks, standInAgent, type DemoWorld, type Tick } from '@ghillie/demo';
import { compareInstants, config, londonInstant, watchdogProblems, type RotaPlan } from '@ghillie/engine';
import { consoleActions, type ConsoleAction } from '@ghillie/feed';
import type { ManagedMeter } from '@ghillie/agent-managed';
import type { DryRun } from '@ghillie/stand-in';
import { readRecording, runManagedDemoTick, type Step } from './managed.js';
import { sceneAt } from './scenes.js';

export type RunMode = 'live' | 'replay' | 'stand-in';

export interface TickSummary {
  at: string;
  mode: RunMode | 'skipped';
  console: string[];
  items: TickInput['items'];
  sources: Record<string, string>;
  run: DryRun | null;
  skipped?: string;
  watchdog: string[];
  usd: number;
  durationMs: number;
  sessionId?: string;
  outcome?: string;
  error?: string;
}

export interface TickRow {
  at: string;
  skipped?: string;
  scene: ReturnType<typeof sceneAt>;
  recorded: boolean;
  done: RunMode | 'skipped' | null;
}

export interface ShowOptions {
  dbPath?: string;
  /** Live ticks need it; without one, live is not offered. */
  meter?: ManagedMeter;
  model?: string;
  recordingDir?: string;
  /** Tests stand a stub agent in for Managed Agents. */
  managed?: typeof runManagedDemoTick;
}

export class Show {
  world!: DemoWorld;
  readonly ticks: Tick[] = fortnightTicks();
  index = 0;
  results: TickSummary[] = [];
  previousPlan: RotaPlan | null = null;
  private pending: ConsoleAction[] = [];
  private readonly model: string;

  private constructor(private readonly options: ShowOptions) {
    this.model = options.model ?? config.models.managedAgents;
  }

  static async open(options: ShowOptions = {}): Promise<Show> {
    const show = new Show(options);
    await show.reset();
    return show;
  }

  async reset(): Promise<void> {
    if (this.world) await this.world.close();
    this.world = await createDemoWorld(this.options.dbPath ?? 'data/live.db');
    this.index = 0;
    this.results = [];
    this.previousPlan = null;
    this.pending = [...consoleActions()].sort((a, b) => compareInstants(a.at, b.at));
  }

  get liveAvailable(): boolean {
    return Boolean(this.options.meter);
  }

  get finished(): boolean {
    return this.index >= this.ticks.length;
  }

  plan(): RotaPlan {
    return this.world.service.read().plan;
  }

  rows(): TickRow[] {
    return this.ticks.map((t, i) => ({
      at: t.at,
      ...(t.skipped ? { skipped: t.skipped } : {}),
      scene: sceneAt(t.at),
      recorded: Boolean(readRecording(t.at, this.options.recordingDir)),
      done: i < this.results.length ? (this.results[i]?.mode ?? null) : null,
    }));
  }

  /** Runs the next tick. `onStart` hears the console actions and the evidence before the agent starts. */
  async step(mode: RunMode, hooks: { onStart?: (s: { at: string; console: string[]; tick: TickInput | null }) => void; onStep?: (step: Step) => void; speed?: number } = {}): Promise<TickSummary> {
    const tick = this.ticks[this.index];
    if (!tick) throw new Error('the fortnight is over');
    this.previousPlan = this.plan();
    const consoleLines: string[] = [];
    while (this.pending[0] && compareInstants(this.pending[0].at, tick.at) <= 0) {
      const action = this.pending.shift();
      if (action) consoleLines.push(applyConsole(this.world, action));
    }
    this.world.setNow(tick.at);
    const started = performance.now();
    const summary: TickSummary = { at: tick.at, mode: tick.skipped ? 'skipped' : mode, console: consoleLines, items: [], sources: {}, run: null, watchdog: [], usd: 0, durationMs: 0 };
    if (tick.skipped) {
      summary.skipped = tick.skipped;
      hooks.onStart?.({ at: tick.at, console: consoleLines, tick: null });
    } else {
      const view = this.world.service.read();
      const input = prepareTick(view, await gatherTick(this.world.feed, view, tick.at, { timeoutMs: 50 }), tick.at);
      summary.items = input.items;
      summary.sources = input.sources;
      hooks.onStart?.({ at: tick.at, console: consoleLines, tick: input });
      try {
        if (mode === 'stand-in') {
          summary.run = await standInAgent({ world: this.world, now: tick.at, timeoutMs: 50 });
        } else {
          if (mode === 'live' && !this.options.meter) throw new Error('live needs an API key: set the variable in .env.example');
          const managed = this.options.managed ?? runManagedDemoTick;
          const result = await managed({
            mode,
            dbPath: this.world.dbPath,
            store: this.world.store,
            tick: input,
            model: this.model,
            onStep: hooks.onStep ?? ((): void => undefined),
            ...(this.options.meter ? { meter: this.options.meter } : {}),
            ...(hooks.speed ? { speed: hooks.speed } : {}),
            ...(this.options.recordingDir ? { dir: this.options.recordingDir } : {}),
          });
          summary.run = result.run;
          summary.usd = result.usd;
          summary.outcome = result.outcome;
          if (result.detail) summary.error = result.detail;
        }
      } catch (error) {
        summary.error = error instanceof Error ? error.message : String(error);
      }
    }
    // A tick whose agent failed before finishing is not counted: run it again, live or from a recording. Isla's
    // console actions are already applied and are not applied twice; repeated writes are no-ops in the service.
    if (summary.error && !summary.run) {
      summary.outcome = 'error';
      summary.durationMs = performance.now() - started;
      return summary;
    }
    if (tick.at.slice(11, 16) === '18:00') {
      const checkAt = londonInstant(tick.at.slice(0, 10), '20:00');
      this.world.setNow(checkAt);
      summary.watchdog = watchdogProblems(checkAt, this.world.store.runs());
    }
    summary.durationMs = performance.now() - started;
    this.results.push(summary);
    this.index++;
    return summary;
  }

  async close(): Promise<void> {
    await this.world.close();
  }
}
