/**
 * The trace of a tick: one entry per model turn, with its usage, duration, cost and the tools it asked for. Every
 * build writes the same shape, so the comparison reads them the same way.
 */
import type { DryRun } from '@ghillie/stand-in';

export interface TurnTrace {
  turn: number;
  stopReason: string;
  model: string;
  durationMs: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  usd: number;
  tools: { name: string; ok: boolean; refusal?: string; durationMs: number }[];
}

export type TickOutcome = 'completed' | 'turn_limit' | 'refusal' | 'max_tokens' | 'budget' | 'error' | 'interrupted';

export interface AgentTick {
  impl: 'messages' | 'sdk' | 'managed';
  model: string;
  outcome: TickOutcome;
  detail?: string;
  run: DryRun;
  turns: TurnTrace[];
  usd: number;
  durationMs: number;
}

export function formatTurn(t: TurnTrace): string {
  const tools = t.tools.length ? ` tools: ${t.tools.map((x) => `${x.name}${x.ok ? '' : `(${x.refusal ?? 'refused'})`}`).join(', ')}` : '';
  return `turn ${t.turn} ${t.stopReason} ${Math.round(t.durationMs)} ms in ${t.usage.input} out ${t.usage.output} cache read ${t.usage.cacheRead} write ${t.usage.cacheWrite} $${t.usd.toFixed(4)}${tools}`;
}

/** The tick's spend and the tools it called, for the end-of-run line. */
export function tickLine(tick: AgentTick): string {
  return `${tick.impl} ${tick.model}: ${tick.outcome}${tick.detail ? ` (${tick.detail})` : ''}, ${tick.turns.length} turns, ${tick.run.toolCalls} tool calls, ${Math.round(tick.durationMs)} ms, $${tick.usd.toFixed(4)}`;
}
