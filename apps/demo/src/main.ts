#!/usr/bin/env node
/**
 * npm run demo                 plays the fortnight and prints what Ghillie did, tick by tick: the recorded Messages API
 *                              run, replayed for free, if there is one; otherwise the rule-based stand-in
 * npm run demo -- --stand-in   the rule-based stand-in, whatever is recorded
 * npm run demo:live            the Messages API build, live, under the ledger; records the run for the replay
 * npm run demo:replay-twice    the stand-in plays it, then replays every window again: zero net writes
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config, diffPlans, formatWhen, renderPlanHtml, renderPlanText, shortPrint, type LogEntry, type RotaPlan } from '@ghillie/engine';
import type { Window } from '@ghillie/feed';
import { isBookkeeping, type DryRun, type WriteRecord } from '@ghillie/stand-in';
import { Ledger } from '@ghillie/ledger';
import { messagesDemo, readManifest, type MessagesDemo } from './messages.js';
import { createDemoWorld, fortnightTicks, playTicks, type TickAgent, type TickResult } from './play.js';

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
const rule = (title: string): void => {
  out('');
  out(`=== ${title} ${'='.repeat(Math.max(0, 70 - title.length))}`);
};

let eventLabel = (id: string): string => id;

function describeWrite(w: WriteRecord): string {
  const what =
    w.action === 'update_event'
      ? `${eventLabel(w.event ?? '')}: ${Object.entries(w.fields ?? {})
          .map(([k, v]) => `${k} ${String(v)}`)
          .join(', ')}`
      : w.action === 'update_person'
        ? `${w.person ?? ''}: ${Object.keys(w.fields ?? {}).join(', ')}`
        : `${w.person ?? ''} ${w.value ?? ''} at ${eventLabel(w.event ?? '')}`;
  return `${what}  [${w.source}, said ${formatWhen(w.evidenceAt)}${w.saidBy ? ` by ${w.saidBy}` : ''}]`;
}

function printRun(result: TickResult, verbose: boolean): void {
  const { tick, run } = result;
  rule(formatWhen(tick.at));
  for (const line of result.console) out(`Console: ${line}`);
  if (!run) {
    out(`No run: ${tick.skipped ?? 'skipped'}.`);
  } else {
    printDryRun(run, verbose);
  }
  for (const problem of result.watchdog) out(`WATCHDOG (20:00) alerts Isla: ${problem}`);
}

function printDryRun(run: DryRun, verbose: boolean): void {
  const sources = Object.entries(run.sources)
    .map(([name, status]) => `${name} ${status}`)
    .join(', ');
  out(`Window from ${formatWhen(run.window[0])}. Sources: ${sources}.`);
  const changed = run.writes.filter((w) => w.outcome === 'changed' || w.outcome === 'note');
  const main = changed.filter((w) => !isBookkeeping(w));
  const bookkeeping = changed.length - main.length;
  out(`Writes: ${main.length}${bookkeeping ? ` (plus ${bookkeeping} to notes, next steps and last checked)` : ''}`);
  for (const w of main) out(`  + ${describeWrite(w)}`);
  if (verbose) for (const w of changed.filter((x) => !main.includes(x))) out(`  . ${describeWrite(w)}`);
  if (run.refused.length) {
    out(`Refused by the service: ${run.refused.length}`);
    for (const w of run.refused) out(`  x ${describeWrite(w)}: ${w.outcome}`);
  }
  if (run.proposals.length) {
    out('Proposed to Isla (not written):');
    for (const p of run.proposals) out(`  ? ${p.person} ${p.value}${p.event ? ` at ${eventLabel(p.event)}` : ''}: ${p.why}`);
  }
  if (verbose && run.skipped.length) {
    out('Deliberately not written:');
    for (const s of run.skipped) out(`  - ${s.what}: ${s.why}`);
  }
  if (run.message) {
    out('Message to Isla:');
    for (const line of run.message.split('\n')) out(`  | ${line}`);
  } else {
    out('Message to Isla: none (nothing needs her)');
  }
  const s = run.summary;
  if (!s) {
    out('Run log: REFUSED by the service (the watchdog will see no run)');
    return;
  }
  out(
    `Run log: writes ${s.writes}, refused ${s.refused}, exceptions ${s.exceptions}, messaged ${s.messaged ? 'yes' : 'no'}, tool calls ${s.toolCalls}, evidence items ${s.read.length}`,
  );
}

function changeLogLines(path: string): LogEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

async function main(): Promise<void> {
  const replayTwice = process.argv.includes('--replay-twice');
  const verbose = process.argv.includes('--verbose');
  const live = process.argv.includes('--live');
  const manifest = readManifest();
  const mode: 'stand-in' | 'replay' | 'live' = live ? 'live' : replayTwice || process.argv.includes('--stand-in') || !manifest ? 'stand-in' : 'replay';
  const model = live ? config.models.messagesLoop : (manifest?.model ?? config.models.messagesLoop);
  const ledger = mode === 'live' ? new Ledger() : null;
  const build: MessagesDemo | null = mode === 'stand-in' ? null : messagesDemo({ mode, model, ...(ledger ? { meter: ledger } : {}), print: verbose ? (l: string): void => out(`    ${l}`) : (): void => undefined });
  const agent: TickAgent | undefined = build?.agent;
  mkdirSync('data', { recursive: true });
  mkdirSync('out', { recursive: true });
  const dbPath = 'data/demo.db';
  const world = await createDemoWorld(dbPath);
  const startPlan: RotaPlan = world.service.read().plan;
  const labels = new Map(world.store.events().map((e) => [e.id, e.label]));
  eventLabel = (id: string): string => labels.get(id) ?? id;

  if (mode === 'stand-in') {
    out(`Ghillie offline demo. No model is called: the agent is the rule-based stand-in.${!manifest && !replayTwice ? ' (No recorded Messages API run yet: npm run demo:live records one.)' : ''}`);
  } else if (mode === 'replay') {
    out(`Ghillie demo: the Messages API build on ${model}, replayed from recordings/ (recorded ${manifest?.recordedAt.slice(0, 10) ?? ''}). No API is called and nothing is spent; the tools run against the real server.`);
  } else {
    out(`Ghillie demo: the Messages API build on ${model}, live, under the ledger. ${ledger?.summary() ?? ''}`);
  }
  out('The circuit: six Saturday games and a setup day, summer 2027. Isla organises. Mode: full.');
  out('');
  out(renderPlanText(startPlan, 'Plan before the fortnight'));

  const ticks = fortnightTicks();
  const results = await playTicks(world, ticks, { ...(agent ? { agent } : {}), onTick: replayTwice ? undefined : (r) => printRun(r, verbose) });
  build?.finish();
  const endPlan = world.service.read().plan;

  if (replayTwice) {
    const windows = new Map<string, Window>();
    for (const r of results) if (r.run) windows.set(r.tick.at, { from: r.run.window[0], to: r.run.window[1] });
    const firstPass = summarise(results);
    rule('Replay: the same windows a second time');
    const replay = await playTicks(world, ticks, { windows, applyConsole: false, watchdog: false });
    const second = summarise(replay);
    out(`First pass:  ${firstPass.changed} writes changed the rota, ${firstPass.messages} messages to Isla.`);
    out(`Second pass: ${second.changed} writes changed the rota (${second.unchanged} repeated writes were no-ops, ${second.refused} refused as older than the log).`);
    out(`Second pass messages: ${second.messages}${second.messages ? ` (${second.messageReasons.join('; ')})` : ''}.`);
    out(diffPlans(endPlan, world.service.read().plan).length === 0 ? 'The plan is identical after the replay.' : 'The plan changed on replay: this is a bug.');
    await world.close();
    if (second.changed !== 0) process.exit(1);
    return;
  }

  rule('Plan after the fortnight');
  out(renderPlanText(endPlan, 'Plan after the fortnight'));
  out('');
  out('What changed:');
  for (const line of diffPlans(startPlan, endPlan)) out(`  ${line}`);

  rule('Change log (append-only, NDJSON beside the store)');
  const log = changeLogLines(`${dbPath}.changes.ndjson`).filter((e) => e.who !== 'seed' && e.entity !== 'run');
  const bookkeeping = log.filter((e) => e.entity === 'person' && ['note', 'nextStep', 'lastChecked'].includes(e.field));
  for (const entry of log.filter((e) => !bookkeeping.includes(e))) {
    const said = entry.evidenceAt ? `said ${formatWhen(entry.evidenceAt)}` : '';
    out(`  ${formatWhen(entry.writtenAt)}  ${entry.who.padEnd(9)} ${entry.key} ${entry.field}: ${entry.old || '(blank)'} -> ${entry.new}  [${entry.source}; ${said}; by ${entry.saidBy}]`);
  }
  out(`  ...and ${bookkeeping.length} bookkeeping entries (notes appended, next steps replaced, last checked).`);

  rule('Approval queue');
  for (const p of world.service.proposalViews()) {
    out(`  ${p.id}  ${p.name.padEnd(14)} ${p.status.padEnd(8)} fingerprint ${shortPrint(p.fingerprint)}  ${p.why}`);
  }
  const approvals = world.store.approvals();
  out(`  Approval records (append-only): ${approvals.map((a) => `${a.kind} by ${a.by} ${formatWhen(a.at)}`).join('; ')}`);

  rule('Cost ledger');
  const trace = world.store.trace();
  const ms = trace.reduce((sum, t) => sum + t.durationMs, 0);
  if (!build) out('  Model calls: 0   Input tokens: 0   Output tokens: 0   Cost: $0.00');
  else {
    const turns = build.ticks.flatMap((t) => t.turns);
    const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): number => turns.reduce((s, t) => s + t.usage[k], 0);
    const usd = build.ticks.reduce((s, t) => s + t.usd, 0);
    out(`  Model calls: ${turns.length}   Input tokens: ${sum('input')}   Output tokens: ${sum('output')}   Cache read: ${sum('cacheRead')}   Cache write: ${sum('cacheWrite')}`);
    out(mode === 'replay' ? `  Recorded cost: $${usd.toFixed(4)} (what the live run spent; this replay spent $0.00). Requests out of step with the recording: ${build.mismatches()}.` : `  This run: $${usd.toFixed(4)}`);
    out(`  Per tick: ${build.ticks.map((t) => `$${t.usd.toFixed(3)}`).join(' ')}`);
  }
  out(`  Tool calls traced: ${trace.length} (${trace.filter((t) => !t.ok).length} refused), total time in tools ${ms.toFixed(0)} ms`);

  rule('Watchdog');
  const alerts = results.flatMap((r) => r.watchdog.map((w) => `${formatWhen(r.tick.at).slice(0, 10)}: ${w}`));
  if (alerts.length) for (const a of alerts) out(`  ${a}`);
  else out('  No alerts.');

  const html = renderPlanHtml(endPlan, 'Ghillie plan, end of the fortnight');
  writeFileSync('out/plan.html', html);
  rule('Files');
  out(`  Store: ${dbPath}   Change log: ${dbPath}.changes.ndjson   Plan: out/plan.html`);
  out(`  Messages sent to Isla: ${world.store.outbox().length}. Messages sent to anyone else: 0 (there is no tool for it).`);
  await world.close();
  if (ledger) out(ledger.summary());
}

function summarise(results: TickResult[]): { changed: number; unchanged: number; refused: number; messages: number; messageReasons: string[] } {
  let changed = 0;
  let unchanged = 0;
  let refused = 0;
  let messages = 0;
  const messageReasons: string[] = [];
  for (const r of results) {
    if (!r.run) continue;
    changed += r.run.writes.filter((w) => w.outcome === 'changed' || w.outcome === 'note').length;
    unchanged += r.run.writes.filter((w) => w.outcome === 'unchanged').length;
    refused += r.run.refused.filter((w) => w.outcome === 'newer_entry').length;
    if (r.run.messaged) {
      messages++;
      messageReasons.push(...r.run.exceptions.map((e) => e.type));
    }
  }
  return { changed, unchanged, refused, messages, messageReasons: [...new Set(messageReasons)] };
}

main().catch((error: unknown) => {
  process.stderr.write(`demo failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
