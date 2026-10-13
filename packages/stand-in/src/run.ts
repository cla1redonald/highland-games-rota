/**
 * One run of the stand-in agent: read the rota, gather evidence since the last run, write what the rules allow
 * through the MCP tools, find what needs the organiser, message her if anything does, and log the run.
 *
 * It only ever touches the rota through the MCP client, exactly as a model-driven agent would, so the service layer's
 * guards apply to it in full. It never sends free text: writes, exceptions and readings are structured, and the
 * service composes every word that is stored or sent.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  addDays,
  compareInstants,
  config as defaultConfig,
  detectChanges,
  footprint,
  formatWhen,
  londonDate,
  minusMinutes,
  onSiteDecisions,
  renderException,
  snapshotOf,
  type Answer,
  type GamesEvent,
  type GhillieConfig,
  type NextStep,
  type Person,
  type Reading,
  type RotaException,
  type RotaView,
  type RunSummary,
  digest,
} from '@ghillie/engine';
import type { FeedSources, Window } from '@ghillie/feed';
import { callTool } from '@ghillie/mcp-server';
import { gather, sourceNames, type EvidenceItem, type Gathered, type SourceName } from './gather.js';
import { readMessage, type Finding } from './reader.js';

export interface WriteRecord {
  action: string;
  person?: string;
  event?: string;
  value?: string;
  fields?: Record<string, unknown>;
  source: string;
  evidenceAt: string;
  saidBy?: string;
  outcome: string;
  detail?: string;
}

export interface ProposalRecord {
  person: string;
  event: string;
  value: string;
  why: string;
}

export type DescribedException = RotaException & { detail: string };

/** The dry-run output: what the run wrote, proposed, raised and skipped, its readings and the exact message. */
export interface DryRun {
  now: string;
  mode: string;
  window: [string, string];
  writes: WriteRecord[];
  refused: WriteRecord[];
  proposals: ProposalRecord[];
  exceptions: DescribedException[];
  skipped: { what: string; why: string }[];
  readings: Reading[];
  message: string;
  messaged: boolean;
  sources: Record<string, string>;
  summary: RunSummary | null;
  toolCalls: number;
}

export interface TickOptions {
  client: Client;
  now: string;
  /** Evidence already gathered (evals). Otherwise it is gathered from the feed. */
  gathered?: Gathered;
  feed?: FeedSources;
  /** Replays: read every source over this window instead of anchoring on the previous run. */
  window?: Window;
  timeoutMs?: number;
  config?: GhillieConfig;
}

const bookkeepingFields = new Set(['lastChecked', 'statement', 'nextStep']);

const exceptionOrder: RotaException['type'][] = [
  'source_unreadable',
  'write_limit',
  'event_change',
  'booked_dropout',
  'lost_lead',
  'red_or_delta_drop',
  'double_booked',
  'over_used',
  'no_spare',
  'unresolved',
  'proposed_decision',
  'pipeline_suggestion',
  'tuning_write',
];

function outcomeOf(result: Record<string, unknown>): string {
  if (result.ok === false) return typeof result.refusal === 'string' ? result.refusal : 'refused';
  if (result.added === true) return 'changed';
  if (Array.isArray(result.changed)) return result.changed.length || (Array.isArray(result.reset) && result.reset.length) ? 'changed' : 'unchanged';
  if (result.changed === true) return 'changed';
  return result.noteUpdated ? 'note' : 'unchanged';
}

export function isBookkeeping(write: WriteRecord): boolean {
  return write.action === 'update_person' && Object.keys(write.fields ?? {}).every((f) => bookkeepingFields.has(f));
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

const personName = /^[A-Z][a-z'-]{1,20}$/;

export async function runTick(options: TickOptions): Promise<DryRun> {
  const settings = options.config ?? defaultConfig;
  const { client, now } = options;
  let toolCalls = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    toolCalls++;
    return callTool(client, name, args);
  };
  const readRota = async (): Promise<RotaView> => (await call('read_rota', {})).view as RotaView;

  const first = await readRota();
  const organiser = first.organiser;
  const today = londonDate(now);
  const previous = first.lastRun?.summary ?? null;

  // Each source starts an hour before where it was last read, so a source that failed is read again in full.
  const windows = {} as Record<SourceName, Window>;
  for (const name of sourceNames) {
    const lastEnd = previous?.sourceWindows[name]?.[1];
    const lookback = new Date(new Date(now).getTime() - settings.rules.firstRunLookbackDays * 86_400_000).toISOString();
    const from = options.window?.from ?? (lastEnd ? minusMinutes(lastEnd, settings.rules.windowOverlapMinutes) : lookback);
    windows[name] = { from, to: options.window?.to ?? now };
  }

  let gathered: Gathered;
  if (options.gathered) gathered = options.gathered;
  else if (options.feed) {
    options.feed.faults.setNow(now);
    gathered = await gather(options.feed, windows, { people: first.people, organiser, timeoutMs: options.timeoutMs ?? 2000, trust: settings.trust });
  } else throw new Error('runTick needs evidence: pass gathered or feed');

  const sourceWindows: Record<string, [string, string]> = {};
  for (const name of Object.keys(gathered.sources)) {
    const window = windows[name as SourceName] ?? { from: now, to: now };
    const lastEnd = previous?.sourceWindows[name]?.[1] ?? window.from;
    sourceWindows[name] = gathered.sources[name] === 'ok' ? [window.from, window.to] : [window.from, lastEnd];
  }
  const windowStart = Object.values(windows).reduce((min, w) => (compareInstants(w.from, min) < 0 ? w.from : min), now);
  const isNewSince = (at: string): boolean => compareInstants(at, windowStart) > 0;

  // Evidence ids are stored only as digests: an id carries source text (a channel, a file name) that never goes in the log.
  const seen = new Set(first.seenEvidence);
  const isSeen = (item: EvidenceItem): boolean => seen.has(digest(item.id));
  const speakerLabel = (item: EvidenceItem): string => (people.has(item.who) ? item.who : 'someone not on the rota');
  const people = new Map<string, Person>(first.people.map((p) => [p.name, p]));
  const events: GamesEvent[] = first.events.map((e) => ({ ...e }));
  const liveEvents = (): GamesEvent[] => events.filter((e) => e.type !== 'Superseded' && footprint(e).end >= today);

  const writes: WriteRecord[] = [];
  const refused: WriteRecord[] = [];
  const proposals: ProposalRecord[] = [];
  const raised: RotaException[] = [];
  const skipped: DryRun['skipped'] = [];
  const readings: Reading[] = [];
  const touched = new Set<string>();
  const nextSteps = new Map<string, { step: NextStep; at: string; source: string; saidBy: string }>();
  let stopped = false;

  const write = async (action: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const record: WriteRecord = {
      action,
      ...(typeof args.person === 'string' ? { person: args.person } : {}),
      ...(typeof args.event === 'string' ? { event: args.event } : {}),
      ...(typeof args.value === 'string' ? { value: args.value } : {}),
      ...(args.fields ? { fields: args.fields as Record<string, unknown> } : {}),
      ...(args.create ? { fields: { create: args.create } } : {}),
      source: String(args.source),
      evidenceAt: String(args.evidenceAt),
      ...(typeof args.saidBy === 'string' ? { saidBy: args.saidBy } : {}),
      outcome: 'not sent',
    };
    if (stopped) {
      skipped.push({ what: `${action} ${record.person ?? record.event ?? ''}`.trim(), why: 'the run stopped at the write limit' });
      return null;
    }
    const result = await call(action, args);
    record.outcome = outcomeOf(result);
    if (result.ok === false) {
      record.detail = textOf(result.detail);
      refused.push(record);
      if (result.refusal === 'write_limit') {
        stopped = true;
        raised.push({ type: 'write_limit', limit: settings.rules.maxWritesPerRun });
      }
      return result;
    }
    writes.push(record);
    return result;
  };

  const raise = (item: EvidenceItem | null, exception: RotaException): void => {
    if (item && isSeen(item)) return; // already reported when that window was first read
    raised.push(exception);
  };
  // 1. Carry out what the organiser approved on her own path since the last run: each approval once.
  // Only approvals granted since this run's window began: one that was refused (a double booking, say) has been raised
  // once and stays with the organiser, rather than being retried every run.
  for (const grant of first.grants.filter((g) => g.status === 'ready' && isNewSince(g.at))) {
    const action = grant.action;
    const evidence = { source: 'organiser approval', evidenceAt: grant.at };
    if (action.kind === 'add_person') {
      const proposal = first.proposals.find((p) => p.status === 'approved' && p.approvedAt === grant.at);
      if (!proposal) continue;
      const [firstName = proposal.name, ...rest] = proposal.name.split(' ');
      const result = await write('update_person', { person: firstName, create: { surname: rest.join(' '), status: 'Pipeline' }, ...evidence, saidBy: organiser });
      if (result?.ok) people.set(firstName, { ...emptyPerson(firstName), surname: rest.join(' ') });
    } else if (action.kind === 'set_decision') {
      const person = textOf(action.person);
      const event = textOf(action.event);
      const value = textOf(action.value) as 'Stewarding';
      const result = await write('set_decision', { person, event, value, ...evidence });
      if (result?.ok === false && result.refusal === 'double_booked') {
        const date = events.find((e) => e.id === event)?.date ?? '';
        raised.push({ type: 'double_booked', person, saturday: date, events: [textOf(result.clashesWith), event], refused: true });
      }
      if (result?.ok === false && result.refusal === 'decision_needs_full_mode') {
        raised.push({ type: 'proposed_decision', person, event, value, reason: 'tuning' });
      }
      touched.add(person);
    } else if (action.kind === 'update_event') {
      const fields = action.fields as Record<string, unknown>;
      const result = await write('update_event', { event: textOf(action.event), fields, ...evidence });
      const local = events.find((e) => e.id === action.event);
      if (result?.ok && local && typeof fields.date === 'string') local.date = fields.date;
    } else if (action.kind === 'set_status') {
      await write('update_person', { person: textOf(action.person), fields: { status: textOf(action.status) }, ...evidence, saidBy: organiser });
    }
  }

  // 2. Read every item, then look for statements that cannot be ordered in time before writing any of them.
  const read: { item: EvidenceItem; findings: Finding[] }[] = [];
  for (const item of gathered.items) {
    if (item.source === 'calendar') {
      read.push({ item, findings: [] });
      continue;
    }
    const findings = readMessage(item.text, item.who, {
      events: liveEvents(),
      people: [...people.values()],
      organiser,
      speakerIsOrganiser: item.trusted,
      saidOn: londonDate(item.at),
      ...(item.aliases ? { aliases: item.aliases } : {}),
    });
    read.push({ item, findings });
  }
  const verdictAt = new Map<string, { at: string; value: string; id: string }[]>();
  for (const { item, findings } of read) {
    for (const finding of findings) {
      if (finding.kind !== 'availability') continue;
      for (const verdict of finding.verdicts) {
        const key = `${finding.subject}::${verdict.event}`;
        verdictAt.set(key, [...(verdictAt.get(key) ?? []), { at: item.at, value: verdict.value, id: item.id }]);
      }
    }
  }
  const unordered = new Set<string>();
  const raisedUnordered = new Set<string>();
  for (const [key, list] of verdictAt) {
    for (const a of list) if (list.some((b) => b.id !== a.id && compareInstants(a.at, b.at) === 0 && a.value !== b.value)) unordered.add(key);
  }

  async function applyCalendar(item: EvidenceItem): Promise<void> {
    const entry = item.calendar;
    if (!entry) return;
    const event = events.find((e) => e.id === entry.eventId);
    if (!event) {
      raise(item, { type: 'event_change', change: 'unlisted', to: entry.date, source: item.label, at: item.at });
      return;
    }
    if (event.date === entry.date) return;
    // An event moves only with the organiser's approval: the service refuses it otherwise, and the move is raised.
    const result = await write('update_event', { event: event.id, fields: { date: entry.date }, source: item.label, evidenceAt: item.at });
    if (result?.ok) event.date = entry.date;
    else raise(item, { type: 'event_change', change: 'proposed_move', event: event.id, to: entry.date, source: item.label, at: item.at });
  }

  async function applyAvailability(item: EvidenceItem, finding: Extract<Finding, { kind: 'availability' }>): Promise<void> {
    const person = people.get(finding.subject);
    // Her word counts as hers only from her trusted channel; anyone else using her name is a member at most.
    const saidBy = item.trusted ? organiser : finding.subject;
    if (!person) {
      // The name itself is source text and is not repeated: the organiser has the source and the time.
      raise(item, { type: 'unresolved', reason: 'unmatched', source: item.label, at: item.at });
      return;
    }
    if (person.status === 'Leadership' || person.status === 'Out') {
      skipped.push({ what: `${finding.subject}'s dates (${item.label})`, why: `${person.status}: not on the bench, never chased or listed` });
      return;
    }
    touched.add(person.name);
    const evidence = { source: item.label, evidenceAt: item.at, saidBy };
    const plain = finding.verdicts.map(({ event, value }) => ({ event, value }));

    if (person.status === 'Pipeline') {
      // No availability row: the dates go in their note, and the organiser decides whether they join.
      if (isSeen(item)) return;
      await write('update_person', { person: person.name, fields: { statement: { verdicts: plain, dateWords: finding.words } }, ...evidence });
      raise(item, { type: 'pipeline_suggestion', name: person.name, verdicts: plain, source: item.label, at: item.at });
      return;
    }

    const accepted: { event: string; value: Answer }[] = [];
    const shown: Reading['verdicts'] = [];
    for (const verdict of finding.verdicts) {
      const key = `${finding.subject}::${verdict.event}`;
      if (unordered.has(key)) {
        if (!raisedUnordered.has(key)) raise(item, { type: 'unresolved', reason: 'unordered', person: person.name, events: [verdict.event], source: item.label, at: item.at });
        raisedUnordered.add(key);
        shown.push({ event: verdict.event, value: verdict.value, qualifier: 'not_written_unordered' });
        continue;
      }
      const result = await write('set_availability', {
        person: person.name,
        event: verdict.event,
        value: verdict.value,
        basis: verdict.basis,
        ...(verdict.words?.length ? { dateWords: verdict.words } : {}),
        ...evidence,
      });
      const qualifier = verdict.basis === 'answer' || verdict.basis === 'vague' ? undefined : verdict.basis;
      if (result?.ok === false) {
        if (result.refusal === 'newer_entry') {
          skipped.push({ what: `${person.name} ${verdict.value} for ${verdict.event} (${item.label})`, why: `older than the log: ${textOf(result.detail)}` });
          shown.push({ event: verdict.event, value: verdict.value, qualifier: 'not_written_newer' });
          continue;
        }
        raise(item, { type: 'unresolved', reason: 'write_failed', person: person.name, events: [verdict.event], refusal: textOf(result.refusal), source: item.label, at: item.at });
        continue;
      }
      accepted.push({ event: verdict.event, value: verdict.value });
      shown.push({ event: verdict.event, value: verdict.value, ...(qualifier ? { qualifier } : {}) });
    }

    // The note is the history of what was said. Evidence an earlier run already read is already in it.
    if (accepted.length && !isSeen(item)) {
      await write('update_person', { person: person.name, fields: { statement: { verdicts: accepted, dateWords: finding.words } }, ...evidence });
    }
    // Readings: date words only. Not for the organiser's own word, and not again for evidence already reported.
    if (saidBy !== organiser && !isSeen(item) && shown.length) {
      readings.push({ person: person.name, source: item.label, at: item.at, dateWords: finding.words, verdicts: shown });
    }

    const by = addDays(today, 2);
    const maybes = finding.verdicts.filter((v) => v.value === 'Maybe').map((v) => v.event);
    const step = (s: NextStep): void => {
      nextSteps.set(person.name, { step: s, at: item.at, source: item.label, saidBy });
    };
    if (finding.vague.length) {
      raise(item, { type: 'unresolved', reason: 'vague', person: person.name, events: maybes, dateWords: finding.vague, source: item.label, at: item.at });
      step({ action: 'ask_dates', about: person.name, by });
    } else if (finding.verdicts.some((v) => v.basis === 'condition')) {
      step({ action: 'settle_condition', about: person.name, by });
    } else if (maybes.length) {
      step({ action: 'confirm', about: person.name, events: maybes, by: addDays(today, 7) });
    } else if (person.nextStep && new RegExp(`\\b(ask|settle) ${person.name}\\b|^${person.name} to confirm`).test(person.nextStep)) {
      step({ action: 'clear', about: person.name }); // answered: the old next step is done
    }
    const droppedBooking = finding.verdicts.some(
      (v) => v.value !== 'Yes' && (onSiteDecisions as readonly string[]).includes(first.cells.find((c) => c.person === person.name && c.event === v.event)?.value ?? ''),
    );
    if (droppedBooking) step({ action: 'find_cover', about: person.name, by });
  }

  async function apply(item: EvidenceItem, finding: Finding): Promise<void> {
    switch (finding.kind) {
      case 'availability':
        await applyAvailability(item, finding);
        return;
      case 'decision': {
        if (first.mode !== 'full') {
          if (isSeen(item)) return;
          proposals.push({ person: finding.person, event: finding.event, value: finding.value, why: `${organiser}'s word` });
          raise(item, { type: 'proposed_decision', person: finding.person, event: finding.event, value: finding.value, reason: 'tuning', source: item.label, at: item.at });
          return;
        }
        // Her word in chat is not an approval. If she approved it in the console it is already recorded; if not, ask.
        const result = await write('set_decision', { person: finding.person, event: finding.event, value: finding.value, source: item.label, evidenceAt: item.at });
        if (result?.ok === false && result.refusal === 'approval_missing') {
          if (isSeen(item)) return;
          proposals.push({ person: finding.person, event: finding.event, value: finding.value, why: `${organiser}'s word, awaiting approval` });
          raise(item, { type: 'proposed_decision', person: finding.person, event: finding.event, value: finding.value, reason: 'needs_approval', source: item.label, at: item.at });
        } else if (result?.ok === false && result.refusal === 'double_booked') {
          const date = events.find((e) => e.id === finding.event)?.date ?? '';
          raise(item, { type: 'double_booked', person: finding.person, saturday: date, events: [textOf(result.clashesWith), finding.event], refused: true });
        }
        touched.add(finding.person);
        return;
      }
      case 'booking_request': {
        if (isSeen(item) || !people.has(item.who)) return;
        proposals.push({ person: finding.person, event: finding.event, value: finding.value, why: `${item.who} asked` });
        raise(item, { type: 'proposed_decision', person: finding.person, event: finding.event, value: finding.value, reason: 'request', requestedBy: item.who, source: item.label, at: item.at });
        return;
      }
      case 'leaning':
        skipped.push({ what: `a leaning from ${speakerLabel(item)} (${item.label})`, why: 'a leaning is not a decision' });
        return;
      case 'relay':
        skipped.push({ what: `${speakerLabel(item)} on someone else's dates (${item.label} ${formatWhen(item.at)})`, why: 'a report by anyone but the person or the organiser is information, not an answer' });
        return;
      case 'move': {
        const result = await write('update_event', { event: finding.event, fields: { date: finding.date }, source: item.label, evidenceAt: item.at });
        const event = events.find((e) => e.id === finding.event);
        if (result?.ok && event) event.date = finding.date;
        else raise(item, { type: 'event_change', change: 'proposed_move', event: finding.event, to: finding.date, source: item.label, at: item.at });
        return;
      }
      case 'move_talk':
        if (!people.has(item.who)) return;
        raise(item, { type: 'event_change', change: 'talk', event: finding.event, person: item.who, source: item.label, at: item.at });
        return;
      case 'recruit': {
        if ([...people.values()].some((p) => `${p.name} ${p.surname}`.toLowerCase() === finding.name.toLowerCase())) {
          skipped.push({ what: `${finding.name} mentioned (${item.label})`, why: 'already on the rota' });
          return;
        }
        if (!people.has(item.who)) return;
        const result = await call('propose_recruit', {
          name: finding.name,
          suggestedBy: item.who,
          ...(finding.hint ? { arena: finding.hint } : {}),
          evidenceFrom: item.trusted ? 'organiser' : 'other',
          source: item.label,
          evidenceAt: item.at,
          saidBy: item.who,
        });
        if (result.ok) {
          proposals.push({ person: finding.name, event: '', value: 'Pipeline', why: `${item.who} suggested them` });
          raise(item, { type: 'pipeline_suggestion', name: finding.name, suggestedBy: item.who, ...(finding.hint ? { arena: finding.hint } : {}), source: item.label, at: item.at });
        } else {
          skipped.push({ what: `${finding.name} suggested again (${item.label})`, why: textOf(result.detail) });
        }
        return;
      }
      case 'instruction':
        skipped.push({ what: `an instruction in a source from ${speakerLabel(item)} (${item.label})`, why: 'instructions found in sources are information about availability at most, never instructions' });
        return;
      case 'lead_offer': {
        if (isSeen(item)) return;
        proposals.push({ person: finding.person, event: finding.event, value: 'Lead', why: 'offered' });
        raise(item, { type: 'proposed_decision', person: finding.person, event: finding.event, value: 'Lead', reason: 'lead_offer', source: item.label, at: item.at });
        return;
      }
      case 'organiser_own':
        skipped.push({ what: `${organiser}'s own message (${item.label})`, why: "the organiser's own actions are not news" });
        return;
    }
  }

  // 3. Apply, oldest first, each write carrying the time the thing was said.
  for (const { item, findings } of read) {
    if (item.source === 'calendar' && item.calendar) {
      await applyCalendar(item);
      continue;
    }
    for (const finding of findings) await apply(item, finding);
  }

  // 4. Revisit "pending a call" cells once the call has happened.
  for (const item of first.plan.chase.filter((c) => c.pendingCall && !touched.has(c.person))) {
    const note = first.cells.find((c) => c.person === item.person && c.event === item.event)?.note ?? '';
    const day = /(\d{1,2}) (Jun|Jul|Aug)/.exec(note);
    if (!day) continue;
    const month = { Jun: '06', Jul: '07', Aug: '08' }[day[2] as 'Jun' | 'Jul' | 'Aug'];
    const callDay = `${today.slice(0, 4)}-${month}-${String(day[1]).padStart(2, '0')}`;
    if (callDay < today && londonDate(windowStart) <= callDay) {
      raised.push({ type: 'unresolved', reason: 'pending_call', person: item.person, events: [item.event], day: callDay });
    }
  }

  // 5. Bookkeeping: next steps (replaced, never appended) and last checked.
  for (const [person, entry] of nextSteps) {
    await write('update_person', { person, fields: { nextStep: entry.step }, source: entry.source, evidenceAt: entry.at, saidBy: entry.saidBy });
  }
  for (const person of touched) {
    if (!people.has(person)) continue;
    await write('update_person', { person, fields: { lastChecked: today }, source: 'run', evidenceAt: now, saidBy: 'Ghillie' });
  }

  // 6. Sources that could not be read: never reported as all clear.
  for (const [name, status] of Object.entries(gathered.sources)) {
    if (status === 'ok') continue;
    raised.push({ type: 'source_unreadable', source: name as SourceName, status: status.startsWith('timed out') ? 'timed out' : 'error' });
  }

  // 7. Read again and compare with the previous run.
  const after = await readRota();
  const snapshot = snapshotOf(after.plan, after.events, after.cells, settings.rules.lookaheadWeeks);
  const detected = detectChanges(previous?.snapshot ?? null, snapshot, {
    plan: after.plan,
    events: after.events,
    cells: after.cells,
    log: after.logSinceLastRun,
    organiser,
    lookaheadWeeks: settings.rules.lookaheadWeeks,
  });

  if (after.mode === 'tuning') {
    const real = writes.filter((w) => w.outcome === 'changed' && !isBookkeeping(w));
    if (real.length) {
      raised.push({
        type: 'tuning_write',
        count: real.length,
        writes: real.slice(0, 4).map((w) => ({
          ...(w.person && personName.test(w.person) ? { person: w.person } : {}),
          ...(w.event ? { event: w.event } : {}),
          ...(w.value ? { value: w.value as Answer } : {}),
        })),
      });
    }
  }

  const exceptions = dedupe([...raised, ...detected]).sort((a, b) => exceptionOrder.indexOf(a.type) - exceptionOrder.indexOf(b.type));
  const context = { events: after.events, organiser };
  const described = exceptions.map((e) => ({ ...e, detail: renderException(e, context) }));

  let message = '';
  let messaged = false;
  if (exceptions.length || readings.length) {
    const sent = await call('message_organiser', { exceptions, readings });
    messaged = sent.ok === true;
    if (messaged) message = textOf(sent.text);
    else skipped.push({ what: 'the message to the organiser', why: `refused: ${textOf(sent.refusal)}` });
  }

  const logged = await call('log_run', {
    window: [windowStart, now],
    sources: gathered.sources,
    sourceWindows,
    exceptions: exceptions.length,
    read: gathered.items.map((i) => digest(i.id)),
    toolCalls: toolCalls + 1,
  });

  return {
    now,
    mode: after.mode,
    window: [windowStart, now],
    writes,
    refused,
    proposals,
    exceptions: described,
    skipped,
    readings,
    message,
    messaged,
    sources: gathered.sources,
    summary: logged.ok ? (logged.summary as RunSummary) : null,
    toolCalls,
  };
}

function dedupe(exceptions: RotaException[]): RotaException[] {
  const seen = new Set<string>();
  return exceptions.filter((e) => {
    const key = JSON.stringify(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyPerson(name: string): Person {
  return { name, surname: '', status: 'Pipeline', role: '', email: '', note: '', risk: '', nextStep: '', lastChecked: '', stewardedBefore: false, pronouns: '' };
}
