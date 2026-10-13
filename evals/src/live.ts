#!/usr/bin/env node
/**
 * npm run eval:live -- --impl messages --model claude-sonnet-5-5 [--repeats 3] [--cases id,id] [--out path]
 *
 * Runs the Phase 1a cases against one build, live, under the ledger. Writes
 * evals/results/<impl>-<model>-<date>.json with every repeat and the summary, and prints the summary and the
 * ledger total. Cases the stand-in skips are run too: a model may manage them, and they are never counted as flips.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { config } from '@ghillie/engine';
import { pricedModels, Ledger } from '@ghillie/ledger';
import { hasCredentials } from '@ghillie/agent-messages';
import { loadCases } from './cases.js';
import { grade, type Grade } from './grade.js';
import { runCase, runCaseWith } from './harness.js';
import { caseAgent, impls, type Impl } from './impls.js';
import { renderLive, repeatOf, summariseLive, type CaseResult, type RepeatResult } from './results.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** The stand-in's verdict on each case: the baseline for flips. Free: no model. */
export async function standInBaseline(): Promise<Map<string, Grade['status']>> {
  const out = new Map<string, Grade['status']>();
  for (const c of loadCases()) out.set(c.id, c.skip ? 'skipped' : grade(c, await runCase(c)).status);
  return out;
}

/** The stand-in, measured the same way, so the builds have a baseline on file. No model, no spend. */
async function writeBaseline(): Promise<void> {
  const grades: Grade[] = [];
  const results: CaseResult[] = [];
  for (const c of loadCases()) {
    const started = performance.now();
    const output = c.skip ? null : await runCase(c);
    const g = grade(c, output);
    grades.push(g);
    results.push({ id: c.id, status: g.status, reasons: g.reasons, usd: 0, ms: performance.now() - started, outcome: c.skip ? 'skipped' : 'completed', turns: 0, toolCalls: output?.run.toolCalls ?? 0 });
  }
  const date = new Date().toISOString().slice(0, 10);
  const summary = summariseLive({ impl: 'stand-in', model: 'none', date, note: 'The rule-based stand-in: no model, no spend. The baseline the builds are compared with.' }, [repeatOf(1, grades, results)], new Map());
  const out = `evals/results/stand-in-none-${date}.json`;
  mkdirSync('evals/results', { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${renderLive(summary)}\nWrote ${out}\n`);
}

async function main(): Promise<void> {
  const impl = arg('impl') as Impl | 'stand-in' | undefined;
  const repeats = Number(arg('repeats', '1'));
  const only = arg('cases')?.split(',');
  if (impl === 'stand-in') return writeBaseline();
  const defaults: Record<Impl, string> = { messages: config.models.messagesLoop, sdk: config.models.agentSdk, managed: config.models.managedAgents };
  const model = arg('model') ?? (impl && impl in defaults ? defaults[impl] : config.models.messagesLoop);
  if (!impl || !impls.includes(impl)) throw new Error(`--impl must be stand-in or one of ${impls.join(', ')}`);
  if (!pricedModels.includes(model)) throw new Error(`no list price for ${model}: the ledger would refuse it`);
  if (!hasCredentials()) throw new Error('no API key in the environment (the variable .env.example names): nothing was called');
  const ledger = new Ledger();
  ledger.assertUnderCap();
  const cases = loadCases().filter((c) => !only || only.includes(c.id));
  const baseline = await standInBaseline();
  const agent = caseAgent(impl, { model, ledger });
  const runs: RepeatResult[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const grades: Grade[] = [];
    const results: CaseResult[] = [];
    for (const c of cases) {
      const before = ledger.total;
      const started = performance.now();
      process.stdout.write(`[${repeat}/${repeats}] ${c.id}\n`);
      let g: Grade;
      let outcome = 'error';
      let turns = 0;
      let toolCalls = 0;
      try {
        const { output, result } = await runCaseWith(c, agent);
        g = grade({ ...c, skip: undefined }, output);
        outcome = result.outcome;
        turns = result.turns.length;
        toolCalls = result.run.toolCalls;
      } catch (error) {
        g = { id: c.id, status: 'fail', reasons: [`the run threw: ${error instanceof Error ? error.message : String(error)}`] };
      }
      grades.push(g);
      results.push({ id: c.id, status: g.status, reasons: g.reasons, usd: ledger.total - before, ms: performance.now() - started, outcome, turns, toolCalls });
      process.stdout.write(`    ${g.status} $${(ledger.total - before).toFixed(4)} (running $${ledger.total.toFixed(4)})${g.reasons.length ? `: ${g.reasons.join('; ')}` : ''}\n`);
    }
    runs.push(repeatOf(repeat, grades, results));
  }
  const date = new Date().toISOString().slice(0, 10);
  const summary = summariseLive({ impl, model, date, note: 'Cases the stand-in skips are run and graded for the builds; they never count as flips.' }, runs, baseline);
  const out = arg('out', `evals/results/${impl}-${model}-${date}.json`) ?? '';
  mkdirSync('evals/results', { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`\n${renderLive(summary)}\nWrote ${out}\n${ledger.summary()}\n`);
}

if (process.argv[1] && /live\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`eval:live: ${error instanceof Error ? error.message : String(error)}\n${new Ledger().summary()}\n`);
    process.exit(1);
  });
}
