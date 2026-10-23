/**
 * What the server tells the page. A tick streams as newline-delimited JSON: tick-start, then a step for each thing
 * the agent does, then tick-end, then the run's new state. The shapes follow the local room demo's event stream.
 */
import type { TickInput } from '@ghillie/agent-kit';
import type { Grid, Scene, Step, TickSummary } from '@ghillie/live';
import type { RotaPlan } from '@ghillie/engine';

export type RunMode = 'live' | 'replay' | 'stand-in';

export interface Row {
  at: string;
  skipped?: string;
  scene: Scene | null;
  recorded: boolean;
  done: RunMode | 'skipped' | null;
}

export interface State {
  type: 'state';
  runId: string;
  model: string;
  busy: boolean;
  index: number;
  finished: boolean;
  rows: Row[];
  plan: RotaPlan;
  previousPlan: RotaPlan | null;
  grid: Grid;
  previousCells: Grid['cells'] | null;
  /** What this visitor's run has spent. */
  spent: number;
  /** Live ticks: whether a key is set on the server, whether this browser is unlocked, and the hosted total. */
  live: { configured: boolean; unlocked: boolean; total: number; cap: number; open: boolean };
}

export interface TickStart {
  type: 'tick-start';
  at: string;
  mode: RunMode;
  console: string[];
  items: TickInput['items'];
  sources: Record<string, string>;
}

export type StepMessage = { type: 'step' } & Step;

export type Write = NonNullable<TickSummary['run']>['writes'][number];

export type TickEnd = { type: 'tick-end'; mainWrites: Write[] } & Omit<TickSummary, 'items'>;

export interface Failure {
  type: 'error';
  error: string;
}

export type Message = State | TickStart | StepMessage | TickEnd | Failure;
