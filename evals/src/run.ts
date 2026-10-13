#!/usr/bin/env node
/**
 * npm run eval: runs every case against the stand-in, grades it, prints the report and writes out/eval-report.json.
 * Exits non-zero if any case fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadCases } from './cases.js';
import { grade, type Grade } from './grade.js';
import { runCase, type EvalOutput } from './harness.js';
import { renderReport, summarise } from './report.js';

async function main(): Promise<void> {
  const cases = loadCases();
  const grades: Grade[] = [];
  for (const c of cases) {
    let out: EvalOutput | null = null;
    if (!c.skip) {
      try {
        out = await runCase(c);
      } catch (error) {
        grades.push({ id: c.id, status: 'fail', reasons: [`the run threw: ${error instanceof Error ? error.message : String(error)}`] });
        continue;
      }
    }
    grades.push(grade(c, out));
  }
  process.stdout.write(`${renderReport(cases, grades)}\n`);
  mkdirSync('out', { recursive: true });
  writeFileSync('out/eval-report.json', JSON.stringify({ summary: summarise(grades), grades }, null, 2));
  if (grades.some((g) => g.status === 'fail')) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`eval failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
