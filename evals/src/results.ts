/**
 * What a live eval run records, and how it is summarised. Every repeat is kept; the summary gives the mean and the
 * spread across repeats, never the best run. Pass rates come with n and a 95% Wilson interval. Costs are what the
 * ledger recorded for each case, as a distribution; latency is wall-clock per case, as percentiles.
 */
import { distribution, mean, percentile, sd, type Distribution } from '@ghillie/agent-kit';
import type { Grade } from './grade.js';
import { summarise, wilson, type Summary } from './report.js';

export interface CaseResult {
  id: string;
  status: Grade['status'];
  reasons: string[];
  /** Ledger spend for the case, in US dollars. */
  usd: number;
  /** Wall-clock for the case, in milliseconds. */
  ms: number;
  /** How the build's run ended: completed, turn_limit, refusal, budget, error, interrupted. */
  outcome: string;
  turns: number;
  toolCalls: number;
}

export interface RepeatResult {
  repeat: number;
  summary: Summary;
  cases: CaseResult[];
}

export interface Flip {
  id: string;
  /** "fails" when the stand-in passes and the build fails; "passes" the other way round. */
  direction: 'fails' | 'passes';
  /** How many of the repeats flipped. */
  repeats: number;
}

export interface LiveResults {
  impl: string;
  model: string;
  date: string;
  /** Cases skipped for the stand-in are run for the builds too, and counted, since a model may manage them. */
  note: string;
  repeats: RepeatResult[];
  aggregate: {
    n: number;
    passRate: { mean: number; sd: number; min: number; max: number; perRepeat: number[] };
    /** All repeats pooled: total passes over total cases, with its Wilson interval. */
    pooled: { passed: number; n: number; rate: number; interval: { low: number; high: number } };
    flips: Flip[];
    costPerCaseUsd: Distribution;
    latencyMs: { p50: number; p90: number; p95: number; max: number };
    outcomes: Record<string, number>;
    totalUsd: number;
  };
}

export function summariseLive(meta: { impl: string; model: string; date: string; note: string }, repeats: RepeatResult[], baseline: Map<string, Grade['status']>): LiveResults {
  const rates = repeats.map((r) => r.summary.rate);
  const all = repeats.flatMap((r) => r.cases);
  const judged = all.filter((c) => c.status !== 'skipped');
  const passed = judged.filter((c) => c.status === 'pass').length;
  const flips = new Map<string, Flip>();
  for (const c of all) {
    const before = baseline.get(c.id);
    if (!before || before === 'skipped' || c.status === 'skipped' || before === c.status) continue;
    const direction = before === 'pass' ? 'fails' : 'passes';
    const key = `${c.id}:${direction}`;
    flips.set(key, { id: c.id, direction, repeats: (flips.get(key)?.repeats ?? 0) + 1 });
  }
  const ms = all.map((c) => c.ms);
  const outcomes: Record<string, number> = {};
  for (const c of all) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
  return {
    ...meta,
    repeats,
    aggregate: {
      n: repeats[0]?.summary.n ?? 0,
      passRate: { mean: mean(rates), sd: sd(rates), min: rates.length ? Math.min(...rates) : 0, max: rates.length ? Math.max(...rates) : 0, perRepeat: rates },
      pooled: { passed, n: judged.length, rate: judged.length ? passed / judged.length : 0, interval: wilson(passed, judged.length) },
      flips: [...flips.values()].sort((a, b) => a.id.localeCompare(b.id)),
      costPerCaseUsd: distribution(all.map((c) => c.usd)),
      latencyMs: { p50: percentile(ms, 50), p90: percentile(ms, 90), p95: percentile(ms, 95), max: ms.length ? Math.max(...ms) : 0 },
      outcomes,
      totalUsd: all.reduce((s, c) => s + c.usd, 0),
    },
  };
}

export function repeatOf(repeat: number, grades: Grade[], cases: CaseResult[]): RepeatResult {
  return { repeat, summary: summarise(grades), cases };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function renderLive(r: LiveResults): string {
  const a = r.aggregate;
  const lines = [
    `${r.impl} on ${r.model}, ${r.date}: ${r.repeats.length} repeat${r.repeats.length === 1 ? '' : 's'} of n = ${a.n}`,
    `Pass rate per repeat: ${a.passRate.perRepeat.map(pct).join(', ')}. Mean ${pct(a.passRate.mean)}, spread ${pct(a.passRate.min)} to ${pct(a.passRate.max)} (sd ${pct(a.passRate.sd)}).`,
    `Pooled: ${a.pooled.passed} of ${a.pooled.n}, ${pct(a.pooled.rate)}, 95% Wilson interval ${pct(a.pooled.interval.low)} to ${pct(a.pooled.interval.high)}.`,
    `Cost per case: median $${a.costPerCaseUsd.median.toFixed(4)}, p95 $${a.costPerCaseUsd.p95.toFixed(4)}, max $${a.costPerCaseUsd.max.toFixed(4)}, mean $${a.costPerCaseUsd.mean.toFixed(4)}. Total $${a.totalUsd.toFixed(4)}.`,
    `Latency per case: p50 ${Math.round(a.latencyMs.p50)} ms, p90 ${Math.round(a.latencyMs.p90)} ms, p95 ${Math.round(a.latencyMs.p95)} ms, max ${Math.round(a.latencyMs.max)} ms.`,
    `How runs ended: ${Object.entries(a.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    a.flips.length ? `Flipped against the stand-in: ${a.flips.map((f) => `${f.id} ${f.direction} (${f.repeats}/${r.repeats.length})`).join('; ')}.` : 'No case flipped against the stand-in.',
  ];
  return lines.join('\n');
}
