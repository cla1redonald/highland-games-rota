import { describe, expect, it } from 'vitest';
import { connectInMemory } from '@ghillie/mcp-server';
import { runTick } from '@ghillie/stand-in';
import { collectOutput, grade, loadCases, prepareCase, runCase, runCaseWith, renderLive, repeatOf, summariseLive, type CaseResult, type Grade } from '@ghillie/evals';

const result = (id: string, status: Grade['status'], usd: number, ms: number, outcome = 'completed'): CaseResult => ({ id, status, reasons: [], usd, ms, outcome, turns: 3, toolCalls: 5 });
const g = (id: string, status: Grade['status']): Grade => ({ id, status, reasons: [] });

describe('live results', () => {
  const baseline = new Map<string, Grade['status']>([
    ['a', 'pass'],
    ['b', 'pass'],
    ['c', 'skipped'],
  ]);
  const repeats = [
    repeatOf(1, [g('a', 'pass'), g('b', 'fail'), g('c', 'pass')], [result('a', 'pass', 0.1, 1000), result('b', 'fail', 0.3, 3000), result('c', 'pass', 0.2, 2000)]),
    repeatOf(2, [g('a', 'pass'), g('b', 'pass'), g('c', 'pass')], [result('a', 'pass', 0.1, 1000), result('b', 'pass', 0.2, 2000), result('c', 'pass', 0.2, 2000)]),
    repeatOf(3, [g('a', 'fail'), g('b', 'fail'), g('c', 'pass')], [result('a', 'fail', 0.4, 4000, 'turn_limit'), result('b', 'fail', 0.3, 3000), result('c', 'pass', 0.2, 2000)]),
  ];
  const summary = summariseLive({ impl: 'messages', model: 'claude-sonnet-5-5', date: '2026-10-12', note: '' }, repeats, baseline);

  it('reports the mean and the spread across repeats, never the best run alone', () => {
    expect(summary.aggregate.passRate.perRepeat.map((r) => Number(r.toFixed(3)))).toEqual([0.667, 1, 0.333]);
    expect(summary.aggregate.passRate.mean).toBeCloseTo(2 / 3, 9);
    expect(summary.aggregate.passRate).toMatchObject({ min: 1 / 3, max: 1 });
    expect(summary.aggregate.passRate.sd).toBeGreaterThan(0);
    expect(summary.repeats).toHaveLength(3);
  });

  it('pools every repeat with n and a Wilson interval', () => {
    expect(summary.aggregate.pooled).toMatchObject({ passed: 6, n: 9 });
    expect(summary.aggregate.pooled.interval.low).toBeGreaterThan(0.3);
    expect(summary.aggregate.pooled.interval.high).toBeLessThan(0.95);
  });

  it('counts flips against the stand-in, and never a case the stand-in skips', () => {
    expect(summary.aggregate.flips).toEqual([
      { id: 'a', direction: 'fails', repeats: 1 },
      { id: 'b', direction: 'fails', repeats: 2 },
    ]);
  });

  it('gives cost per case as a distribution and latency as percentiles', () => {
    expect(summary.aggregate.costPerCaseUsd).toMatchObject({ n: 9, max: 0.4 });
    expect(summary.aggregate.costPerCaseUsd.median).toBeCloseTo(0.2, 9);
    expect(summary.aggregate.latencyMs.max).toBe(4000);
    expect(summary.aggregate.outcomes).toEqual({ completed: 8, turn_limit: 1 });
    expect(renderLive(summary)).toMatch(/Mean 66\.7%, spread 33\.3% to 100\.0%/);
  });
});

describe('the harness for any build', () => {
  it('prepares a case on a store file, so a stdio server can open it, and grades it the same way', async () => {
    const c = loadCases().find((x) => x.id === 'piper-drops-out')!;
    const viaMemory = grade(c, await runCase(c));
    const { output } = await runCaseWith(c, async (cc, prepared) => {
      expect(prepared.dbPath).toMatch(/rota\.db$/);
      const { client, close } = await connectInMemory(prepared.service);
      const run = await runTick({ client, now: cc.now, gathered: { items: prepared.items, sources: prepared.sources, windows: {} } });
      await close();
      return { run };
    });
    expect(grade(c, output)).toEqual(viaMemory);
  });

  it('collects the same output as before the harness was split', async () => {
    const c = loadCases().find((x) => x.id === 'quiet-window')!;
    const prepared = prepareCase(c);
    const { client, close } = await connectInMemory(prepared.service);
    const run = await runTick({ client, now: c.now, gathered: { items: prepared.items, sources: prepared.sources, windows: {} } });
    await close();
    expect(collectOutput(c, prepared.store, run)).toEqual(await runCase(c));
    prepared.store.close();
  });
});
