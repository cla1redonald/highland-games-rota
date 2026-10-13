/**
 * Runs one case: a fresh store seeded with the world, the case's setup applied on the organiser's own path at the
 * times it gives, a previous run logged, then one run over the case's evidence through the MCP tools. Nothing is
 * shared between cases.
 *
 * The stand-in runs in memory. A model-driven build runs against a store file, so the Phase 1a MCP server can open
 * it as a stdio subprocess, exactly as it does outside the evals; the harness keeps its own connection open to read
 * the outcome.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, planRota, type CellValue, type OutboxMessage, type RotaService } from '@ghillie/engine';
import { seedWorld, sourceNames } from '@ghillie/feed';
import { connectInMemory } from '@ghillie/mcp-server';
import { runTick, type DryRun, type EvidenceItem } from '@ghillie/stand-in';
import type { EvalCase } from './cases.js';

export interface EvalOutput {
  run: DryRun;
  outbox: OutboxMessage[];
  /** Everything the store holds as text, for the privacy and forbidden-text checks. */
  storeText: string;
  cells: { person: string; event: string; value: CellValue }[];
  events: { id: string; date: string }[];
  people: { name: string; status: string; role: string }[];
  leads: Record<string, string | null>;
}

function shift(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export interface PreparedCase {
  store: Store;
  service: RotaService;
  /** The store file, or ":memory:". */
  dbPath: string;
  items: EvidenceItem[];
  sources: Record<string, string>;
}

/** Seeds the world, applies the case's setup and logs the previous run. The store is left open at the case's now. */
export function prepareCase(c: EvalCase, dbPath = ':memory:'): PreparedCase {
  const store = new Store({ path: dbPath });
  let now = shift(c.setup.previousRunAt, -60);
  const clock = (): Date => new Date(now);
  const { service, console: organiser } = seedWorld(store, clock, { mode: c.mode });

  const apply = (step: NonNullable<EvalCase['setup']['before']>): void => {
    for (const edit of step.edits ?? []) organiser.editCell(edit.person, edit.event, edit.value as CellValue);
    for (const pencil of step.pencils ?? []) organiser.pencil(pencil.person, pencil.event, pencil.asLead ?? false);
    for (const move of step.moves ?? []) {
      organiser.approveEventChange(move.event, { date: move.date });
      const moved = service.updateEvent({ event: move.event, fields: { date: move.date }, source: 'organiser approval', evidenceAt: new Date(now).toISOString() });
      if (!moved.ok) throw new Error(`${c.id}: setup move refused: ${moved.refusal}`);
    }
    for (const proposal of step.proposals ?? []) {
      const result = service.proposeRecruit({
        name: proposal.name,
        suggestedBy: proposal.suggestedBy,
        ...(proposal.arena ? { arena: proposal.arena } : {}),
        evidenceFrom: 'other',
        source: 'chat #stewards',
        evidenceAt: new Date(now).toISOString(),
        saidBy: proposal.suggestedBy,
      });
      if (!result.ok) throw new Error(`${c.id}: setup proposal refused: ${result.refusal}`);
    }
    for (const approval of step.approvals ?? []) {
      if (approval.decision) organiser.approveDecision(approval.decision.person, approval.decision.event, approval.decision.value);
      if (approval.event) organiser.approveEventChange(approval.event.id, approval.event.fields);
      if (approval.status) organiser.approveStatus(approval.status.person, approval.status.status);
      if (approval.recruit) {
        const proposal = service.proposalViews().find((p) => p.name === approval.recruit);
        if (!proposal) throw new Error(`${c.id}: no proposal for ${approval.recruit}`);
        organiser.approve(proposal.id);
      }
    }
  };

  if (c.setup.before) apply(c.setup.before);
  now = c.setup.previousRunAt;
  const window: [string, string] = [shift(now, -300), now];
  const logged = service.logRun({
    window,
    sources: Object.fromEntries(sourceNames.map((s) => [s, 'ok'])),
    sourceWindows: Object.fromEntries(sourceNames.map((s) => [s, window])),
    exceptions: 0,
    read: [],
    toolCalls: 0,
  });
  if (!logged.ok) throw new Error(`${c.id}: previous run refused: ${logged.refusal}`);
  for (const step of c.setup.after ?? []) {
    now = step.at ?? shift(c.setup.previousRunAt, 30);
    apply(step);
  }
  now = c.now;
  const items: EvidenceItem[] = c.evidence.items.map((item) => ({ ...item, id: `case:${c.id}:${item.id}`, trusted: item.trusted ?? false }));
  return { store, service, dbPath, items, sources: c.evidence.sources };
}

/** What the graders read: the run, and everything the store now holds. */
export function collectOutput(c: EvalCase, store: Store, run: DryRun): EvalOutput {
  const people = store.people();
  const events = store.events();
  const cells = store.cells();
  const plan = planRota(people, events, cells, c.now.slice(0, 10));
  return {
    run,
    outbox: store.outbox(),
    storeText: [JSON.stringify(store.log()), JSON.stringify(cells), JSON.stringify(people), JSON.stringify(store.runs()), JSON.stringify(store.proposals())].join('\n'),
    cells: cells.map((cell) => ({ person: cell.person, event: cell.event, value: cell.value })),
    events: events.map((e) => ({ id: e.id, date: e.date })),
    people: people.map((p) => ({ name: p.name, status: p.status, role: p.role })),
    leads: Object.fromEntries(plan.games.map((g) => [g.id, g.lead])),
  };
}

/** The rule-based stand-in, in memory. */
export async function runCase(c: EvalCase): Promise<EvalOutput> {
  const prepared = prepareCase(c);
  const { client, close } = await connectInMemory(prepared.service);
  const run = await runTick({ client, now: c.now, gathered: { items: prepared.items, sources: prepared.sources, windows: {} } });
  await close();
  const output = collectOutput(c, prepared.store, run);
  prepared.store.close();
  return output;
}

/** A build that runs one case against a prepared store file and returns its run. */
export type CaseAgent<T extends { run: DryRun }> = (c: EvalCase, prepared: PreparedCase) => Promise<T>;

/** Runs a case through any build, on a fresh store file of its own. */
export async function runCaseWith<T extends { run: DryRun }>(c: EvalCase, agent: CaseAgent<T>): Promise<{ output: EvalOutput; result: T }> {
  const dir = mkdtempSync(join(tmpdir(), `ghillie-eval-${c.id}-`));
  const prepared = prepareCase(c, join(dir, 'rota.db'));
  try {
    const result = await agent(c, prepared);
    return { output: collectOutput(c, prepared.store, result.run), result };
  } finally {
    prepared.store.close();
  }
}
