/**
 * The report: pass rate with its sample size and a Wilson score interval, never a bare percentage. Skipped cases are
 * listed with their reason and are not counted in n.
 */
import type { EvalCase } from './cases.js';
import type { Grade } from './grade.js';

/** Wilson score interval for k successes out of n, at 95% by default. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface Summary {
  n: number;
  passed: number;
  failed: number;
  skipped: number;
  rate: number;
  interval: { low: number; high: number };
}

export function summarise(grades: Grade[]): Summary {
  const passed = grades.filter((g) => g.status === 'pass').length;
  const failed = grades.filter((g) => g.status === 'fail').length;
  const skipped = grades.filter((g) => g.status === 'skipped').length;
  const n = passed + failed;
  return { n, passed, failed, skipped, rate: n ? passed / n : 0, interval: wilson(passed, n) };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function renderReport(cases: EvalCase[], grades: Grade[]): string {
  const s = summarise(grades);
  const lines: string[] = [];
  lines.push(`Ghillie eval against the rule-based stand-in (no model)`);
  lines.push(`n = ${s.n}: ${s.passed} pass, ${s.failed} fail. Pass rate ${pct(s.rate)}, 95% Wilson interval ${pct(s.interval.low)} to ${pct(s.interval.high)}.`);
  if (s.skipped) lines.push(`${s.skipped} skipped, not counted in n.`);
  lines.push('');
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const g of grades) {
    const c = byId.get(g.id);
    lines.push(`${g.status.toUpperCase().padEnd(7)} ${g.id}  [${c?.rules.join(', ') ?? ''}]`);
    for (const reason of g.reasons) lines.push(`        ${g.status === 'skipped' ? 'why' : 'reason'}: ${reason}`);
  }
  const ruleCounts = new Map<string, number>();
  for (const c of cases) for (const r of c.rules) ruleCounts.set(r, (ruleCounts.get(r) ?? 0) + 1);
  lines.push('');
  lines.push(
    `Rules covered: ${[...ruleCounts]
      .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
      .map(([r, n]) => `${r} (${n})`)
      .join(', ')}`,
  );
  return lines.join('\n');
}
