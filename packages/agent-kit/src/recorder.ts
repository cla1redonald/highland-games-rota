/**
 * Turns the tool calls a model made into the stand-in's DryRun, so the Phase 1a graders judge every build the same
 * way. Every build feeds it the same thing: each call's name, arguments and result, in order.
 */
import { renderException, type GamesEvent, type Reading, type RotaException, type RunSummary } from '@ghillie/engine';
import type { DryRun, ProposalRecord, WriteRecord } from '@ghillie/stand-in';
import type { TickInput } from './tick.js';

export interface CallOutcome {
  /** The MCP error flag: a malformed call, or a call the harness refused before it ran. */
  isError: boolean;
  /** The structured result, when there is one. */
  result: Record<string, unknown> | null;
  /** The text content, for errors. */
  text: string;
}

const writeTools = new Set(['set_availability', 'set_decision', 'update_person', 'update_event']);

function outcomeOf(result: Record<string, unknown>): string {
  if (result.ok === false) return typeof result.refusal === 'string' ? result.refusal : 'refused';
  if (result.added === true) return 'changed';
  if (Array.isArray(result.changed)) return result.changed.length || (Array.isArray(result.reset) && result.reset.length) ? 'changed' : 'unchanged';
  if (result.changed === true) return 'changed';
  return result.noteUpdated ? 'note' : 'unchanged';
}

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));

export class RunRecorder {
  private readonly writes: WriteRecord[] = [];
  private readonly refused: WriteRecord[] = [];
  private readonly proposals: ProposalRecord[] = [];
  private readonly skipped: DryRun['skipped'] = [];
  private exceptions: RotaException[] = [];
  private readings: Reading[] = [];
  private message = '';
  private messaged = false;
  private summary: RunSummary | null = null;
  private mode = 'unknown';
  private calls = 0;
  readonly names: string[] = [];

  constructor(private readonly tick: TickInput) {}

  get toolCalls(): number {
    return this.calls;
  }

  record(name: string, args: Record<string, unknown>, outcome: CallOutcome): void {
    this.calls++;
    this.names.push(name);
    const result = outcome.result;
    if (name === 'read_rota' && result?.view && typeof result.view === 'object') {
      const mode = (result.view as { mode?: unknown }).mode;
      if (typeof mode === 'string') this.mode = mode;
    }
    if (writeTools.has(name)) this.recordWrite(name, args, outcome);
    if (name === 'propose_recruit' && result?.ok === true) {
      this.proposals.push({ person: text(args.name), event: '', value: 'Pipeline', why: `${text(args.suggestedBy)} suggested them` });
    }
    if (name === 'message_organiser') {
      if (result?.ok === true) {
        this.messaged = true;
        this.message = text(result.text);
        this.exceptions = (args.exceptions as RotaException[] | undefined) ?? [];
        this.readings = (args.readings as Reading[] | undefined) ?? [];
      } else {
        this.skipped.push({ what: 'the message to the organiser', why: `refused: ${outcome.isError ? outcome.text : text(result?.refusal)}` });
      }
    }
    if (name === 'log_run' && result?.ok === true) this.summary = (result.summary as RunSummary | undefined) ?? null;
  }

  private recordWrite(action: string, args: Record<string, unknown>, outcome: CallOutcome): void {
    const record: WriteRecord = {
      action,
      ...(typeof args.person === 'string' ? { person: args.person } : {}),
      ...(typeof args.event === 'string' ? { event: args.event } : {}),
      ...(typeof args.value === 'string' ? { value: args.value } : {}),
      ...(args.fields && typeof args.fields === 'object' ? { fields: args.fields as Record<string, unknown> } : {}),
      ...(args.create ? { fields: { create: args.create } } : {}),
      source: text(args.source),
      evidenceAt: text(args.evidenceAt),
      ...(typeof args.saidBy === 'string' ? { saidBy: args.saidBy } : {}),
      outcome: 'not sent',
    };
    if (outcome.isError || !outcome.result) {
      record.outcome = 'error';
      record.detail = outcome.text;
      this.refused.push(record);
      return;
    }
    record.outcome = outcomeOf(outcome.result);
    if (outcome.result.ok === false) {
      record.detail = text(outcome.result.detail);
      this.refused.push(record);
      return;
    }
    this.writes.push(record);
  }

  /** The DryRun, once the run is over. Exception details are rendered by the engine against the final events. */
  finish(events: GamesEvent[], organiser: string): DryRun {
    const context = { events, organiser };
    const proposals = [...this.proposals];
    for (const e of this.exceptions) {
      if (e.type === 'proposed_decision') proposals.push({ person: e.person, event: e.event, value: e.value, why: e.reason });
      if (e.type === 'pipeline_suggestion' && !proposals.some((p) => p.person === e.name)) proposals.push({ person: e.name, event: '', value: 'Pipeline', why: 'suggested' });
    }
    return {
      now: this.tick.now,
      mode: this.mode,
      window: this.tick.logRun.window,
      writes: this.writes,
      refused: this.refused,
      proposals,
      exceptions: this.exceptions.map((e) => ({ ...e, detail: safeRender(e, context) })),
      skipped: this.skipped,
      readings: this.readings,
      message: this.message,
      messaged: this.messaged,
      sources: this.tick.sources,
      summary: this.summary,
      toolCalls: this.calls,
    };
  }
}

function safeRender(e: RotaException, context: { events: GamesEvent[]; organiser: string }): string {
  try {
    return renderException(e, context);
  } catch {
    return e.type;
  }
}
