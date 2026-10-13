/**
 * What needs the organiser. A run compares its read of the rota with the previous run's snapshot; anything on this
 * list goes in the message, anything else does not. No exceptions and no readings means no message.
 *
 * Exceptions are structured data, never prose: the service validates every field (people and events must exist, date
 * words must pass the grammar, sources must be known labels) and writes the sentence itself. A caller cannot put
 * a source's own words in front of the organiser.
 */
import { z } from 'zod';
import type { RotaPlan } from './coverage.js';
import { formatDay, formatWhen } from './dates.js';
import { cellKey } from './store.js';
import type { Snapshot } from './summary.js';
import { onSiteDecisions, type Cell, type GamesEvent, type LogEntry } from './types.js';
import { recruitNamePattern, sourceLabelPattern } from './words.js';

export const exceptionTypes = [
  'event_change',
  'red_or_delta_drop',
  'booked_dropout',
  'over_used',
  'no_spare',
  'double_booked',
  'lost_lead',
  'unresolved',
  'source_unreadable',
  'pipeline_suggestion',
  'tuning_write',
  'proposed_decision',
  'write_limit',
] as const;

export type ExceptionType = (typeof exceptionTypes)[number];

export function isExceptionType(value: string): value is ExceptionType {
  return (exceptionTypes as readonly string[]).includes(value);
}

/** Sources the log itself uses, besides those a caller may give. */
export const logSourceLabels = ['hand edit', 'committee meeting', 'event moved', 'organiser approval'];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().regex(/^[A-Z][a-z'-]{1,20}$/);
const recruitName = z.string().regex(recruitNamePattern);
const eventId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const source = z.string().refine((s) => sourceLabelPattern.test(s) || logSourceLabels.includes(s), 'not a known source label');
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/);
const answer = z.enum(['Yes', 'Maybe', 'No', 'Unknown']);
const anyValue = z.enum(['', 'Yes', 'Maybe', 'No', 'Unknown', 'Stewarding', 'Supporting', 'Watching', 'Not going']);

export const exceptionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('event_change'),
      change: z.enum(['moved', 'added', 'renamed', 'confirmed', 'cancelled', 'talk', 'proposed_move', 'unlisted']),
      event: eventId.optional(),
      from: day.optional(),
      to: day.optional(),
      previous: z.array(z.object({ person: name, value: anyValue }).strict()).max(30).optional(),
      person: name.optional(),
      source: source.optional(),
      at: instant.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('red_or_delta_drop'),
      saturday: day,
      events: z.array(eventId).min(1).max(4),
      delta: z.number().int(),
      rag: z.enum(['Green', 'Amber', 'Red']),
      causes: z.array(z.object({ person: name, event: eventId, value: answer, source, at: instant }).strict()).max(10),
      open: z.array(z.object({ person: name, value: anyValue }).strict()).max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal('booked_dropout'),
      person: name,
      event: eventId,
      kind: z.enum(['Stewarding', 'Supporting', 'pencilled']),
      value: z.enum(['No', 'Maybe', 'Unknown']),
      source: source.optional(),
      at: instant.optional(),
    })
    .strict(),
  z.object({ type: z.literal('over_used'), person: name, event: eventId, weeks: z.number().int().min(2).max(20) }).strict(),
  z.object({ type: z.literal('no_spare'), saturday: day, events: z.array(eventId).min(1).max(4) }).strict(),
  z
    .object({ type: z.literal('double_booked'), person: name, saturday: day, events: z.array(eventId).length(2), refused: z.boolean() })
    .strict(),
  z.object({ type: z.literal('lost_lead'), event: eventId, person: name, value: anyValue }).strict(),
  z
    .object({
      type: z.literal('unresolved'),
      reason: z.enum(['vague', 'unordered', 'unmatched', 'write_failed', 'pending_call']),
      person: z.union([name, recruitName]).optional(),
      events: z.array(eventId).max(8).optional(),
      dateWords: z.array(z.string()).max(8).optional(),
      refusal: z.string().regex(/^[a-z_]{1,40}$/).optional(),
      source: source.optional(),
      at: instant.optional(),
      day: day.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('source_unreadable'),
      source: z.enum(['chat', 'mail', 'minutes', 'calendar']),
      status: z.enum(['timed out', 'error', 'needs re-authorising']),
    })
    .strict(),
  z
    .object({
      type: z.literal('pipeline_suggestion'),
      name: z.union([recruitName, name]),
      suggestedBy: name.optional(),
      arena: z.string().max(40).optional(),
      verdicts: z.array(z.object({ event: eventId, value: answer }).strict()).max(8).optional(),
      source,
      at: instant,
    })
    .strict(),
  z
    .object({
      type: z.literal('tuning_write'),
      count: z.number().int().min(1),
      writes: z.array(z.object({ person: name.optional(), event: eventId.optional(), value: anyValue.optional() }).strict()).max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal('proposed_decision'),
      person: name,
      event: eventId,
      value: z.enum(['Stewarding', 'Supporting', 'Watching', 'Not going', 'Lead']),
      reason: z.enum(['tuning', 'request', 'lead_offer', 'needs_approval']),
      requestedBy: name.optional(),
      source: source.optional(),
      at: instant.optional(),
    })
    .strict(),
  z.object({ type: z.literal('write_limit'), limit: z.number().int().min(1) }).strict(),
]);

export type RotaException = z.infer<typeof exceptionSchema>;

export interface RenderContext {
  events: GamesEvent[];
  organiser: string;
}

function labelOf(ctx: RenderContext, id: string | undefined): string {
  return ctx.events.find((e) => e.id === id)?.label ?? id ?? 'an event';
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function cite(sourceLabel: string | undefined, at: string | undefined): string {
  if (!sourceLabel) return '';
  return at ? `${sourceLabel} ${formatWhen(at)}` : sourceLabel;
}

function ordinalWord(n: number): string {
  return ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n] ?? `${n}th`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** The sentence for one exception. Every word is the service's; the data only fills slots. */
export function renderException(e: RotaException, ctx: RenderContext): string {
  switch (e.type) {
    case 'event_change': {
      const label = labelOf(ctx, e.event);
      const where = cite(e.source, e.at);
      switch (e.change) {
        case 'moved': {
          const previous = (e.previous ?? []).map((p) => `${p.person} (was ${p.value || 'blank'})`).join(', ');
          return `${label} moved from ${formatDay(e.from ?? '')} to ${formatDay(e.to ?? '')}. Every answer reset to Unknown, so ask again: ${previous || 'nobody had answered'}.`;
        }
        case 'proposed_move':
          return `The ${where || 'calendar'} moves ${label} to ${formatDay(e.to ?? '')}. Approve the move in the console and every answer resets to Unknown; until then nothing changes.`;
        case 'talk':
          return `${e.person ?? 'Someone'} has heard ${label} might move (${where}). Nothing changed: only you or the circuit can move it.`;
        case 'added':
          return `New event: ${label} on ${formatDay(e.to ?? '')}.`;
        case 'renamed':
          return `${label} has been renamed.`;
        case 'confirmed':
          return `${label} is confirmed for ${formatDay(e.to ?? '')}.`;
        case 'cancelled':
          return `${label} is cancelled.`;
        case 'unlisted':
          return `The ${where || 'calendar'} lists an event on ${formatDay(e.to ?? '')} that is not on the rota.`;
      }
      return label;
    }
    case 'red_or_delta_drop': {
      const causes = e.causes.map((c) => `${c.person} ${c.value === 'Unknown' ? 'is now Unknown' : `said ${c.value}`} for ${labelOf(ctx, c.event)} (${cite(c.source, c.at)})`);
      const open = e.open.map((o) => `${o.person} (${o.value ? o.value.toLowerCase() : 'not asked'})`);
      return (
        `${formatDay(e.saturday)} (${list(e.events.map((id) => labelOf(ctx, id)))}) now ${signed(e.delta)}, ${e.rag}` +
        (causes.length ? `: ${causes.join('; ')}` : '') +
        (open.length ? `. Still open: ${open.join(', ')}` : '')
      );
    }
    case 'booked_dropout':
      return `${e.person}, ${e.kind === 'pencilled' ? 'pencilled' : e.kind.toLowerCase()} at ${labelOf(ctx, e.event)}, now ${e.value === 'Unknown' ? 'Unknown' : `says ${e.value}`}${e.source ? ` (${cite(e.source, e.at)})` : ''}.`;
    case 'over_used':
      return `${e.person} would be on a ${ordinalWord(e.weeks)} Saturday running at ${labelOf(ctx, e.event)}. That is the rota's limit (two in a row), not ${e.person}'s.`;
    case 'no_spare':
      return `${formatDay(e.saturday)} (${list(e.events.map((id) => labelOf(ctx, id)))}) has no spare: anyone dropping out makes it short.`;
    case 'double_booked': {
      const [first, second] = e.events.map((id) => labelOf(ctx, id));
      return e.refused
        ? `${e.person} cannot be on the ground at both ${first ?? ''} and ${second ?? ''} on ${formatDay(e.saturday)}. One place at a time, so ${second ?? ''} was not written: which do you want?`
        : `${e.person} is on the ground at two games on ${formatDay(e.saturday)}: ${first ?? ''} and ${second ?? ''}.`;
    }
    case 'lost_lead':
      return `${labelOf(ctx, e.event)} has lost its lead: ${e.person} ${e.value ? `now says ${e.value}` : 'is no longer there'}. No other Chief Steward is booked or pencilled there.`;
    case 'unresolved': {
      const events = list((e.events ?? []).map((id) => labelOf(ctx, id)));
      const where = cite(e.source, e.at);
      switch (e.reason) {
        case 'vague':
          return `${e.person ?? 'Someone'}'s ${(e.dateWords ?? []).map((w) => `"${w}"`).join(', ')} does not pin down days, so ${events || 'those games'} ${(e.events ?? []).length === 1 ? 'is' : 'are'} Maybe (${where}).`;
        case 'unordered':
          return `${e.person ?? 'Someone'} gave different answers for ${events} at the same time (${where}). Not written: which stands?`;
        case 'unmatched':
          return `Could not match a name to anyone on the rota (${where}).`;
        case 'write_failed':
          return `Could not record ${e.person ?? 'a change'}${events ? ` for ${events}` : ''}: refused as ${e.refusal ?? 'invalid'}${where ? ` (${where})` : ''}.`;
        case 'pending_call':
          return `${e.person ?? 'Someone'}'s ${events} answer was pending a call on ${formatDay(e.day ?? '')}. No notes from that call were found: what was agreed?`;
      }
      return 'Something could not be resolved.';
    }
    case 'source_unreadable':
      return `Could not read ${e.source} this run (${e.status}). It is read again next run; until then this is not an all clear.`;
    case 'pipeline_suggestion': {
      const where = cite(e.source, e.at);
      if (e.verdicts) {
        const dates = e.verdicts.map((v) => `${v.value} ${labelOf(ctx, v.event)}`).join(', ');
        return `${e.name} (Pipeline) gave dates: ${dates} (${where}). ${e.name} joins the bench only on your word.`;
      }
      const why = `${e.suggestedBy ?? 'Someone'} suggested them${e.arena ? ` for the ${e.arena.toLowerCase()}` : ''}`;
      return `Pipeline? ${e.name}: ${why} (${where}). Approve in the console to add.`;
    }
    case 'tuning_write': {
      const writes = e.writes.map((w) => `${w.person ?? ''} ${w.value ?? ''}${w.event ? ` for ${labelOf(ctx, w.event)}` : ''}`.trim()).join('; ');
      return `Tuning: I wrote ${e.count} change${e.count === 1 ? '' : 's'}: ${writes}${e.count > e.writes.length ? '; and more in the log' : ''}.`;
    }
    case 'proposed_decision': {
      const label = labelOf(ctx, e.event);
      const where = cite(e.source, e.at);
      switch (e.reason) {
        case 'tuning':
          return `Proposed: ${e.person} ${e.value} at ${label} (your word${where ? `, ${where}` : ''}). Tuning mode, not written.`;
        case 'needs_approval':
          return `You said ${e.person} ${e.value} at ${label}${where ? ` (${where})` : ''}. Approve it in the console and it is recorded.`;
        case 'request':
          return `${e.requestedBy ?? 'Someone'} asked for ${e.person} ${e.value} at ${label}${where ? ` (${where})` : ''}. Only you book.`;
        case 'lead_offer':
          return `${e.person} offered to lead at ${label}${where ? ` (${where})` : ''}. Who leads is your call.`;
      }
      return label;
    }
    case 'write_limit':
      return `Stopped after ${e.limit} write attempts in one run. Something is probably wrong; nothing more was written.`;
  }
}

export function snapshotOf(plan: RotaPlan, events: GamesEvent[], cells: Cell[], lookaheadWeeks: number): Snapshot {
  const soon = (weeks: number): boolean => weeks <= lookaheadWeeks;
  const activeIds = new Set(plan.games.map((g) => g.id));
  const snapshot: Snapshot = { saturdays: {}, games: {}, leads: {}, overUsed: [], noSpare: [], booked: [], doubleBooked: [], events: {} };
  for (const saturday of plan.saturdays) {
    snapshot.saturdays[saturday.date] = [saturday.deltaNow, saturday.rag];
    if (soon(saturday.weeksAway) && saturday.noSpare) snapshot.noSpare.push(saturday.date);
    for (const person of saturday.doubleBooked) snapshot.doubleBooked.push(`${person}@${saturday.date}`);
  }
  for (const game of plan.games) {
    snapshot.games[game.id] = [game.deltaNow, game.rag];
    if (soon(game.weeksAway)) {
      snapshot.leads[game.id] = game.lead;
      for (const over of game.overUsed) snapshot.overUsed.push(`${over.person}@${game.date}`);
    }
  }
  for (const cell of cells) {
    if (!activeIds.has(cell.event)) continue;
    if ((onSiteDecisions as readonly string[]).includes(cell.value)) snapshot.booked.push(`${cell.person}@${cell.event}=${cell.value}`);
    else if (cell.pencilled && cell.value === 'Yes') snapshot.booked.push(`${cell.person}@${cell.event}=pencilled`);
  }
  for (const event of events) {
    snapshot.events[event.id] = { label: event.label, date: event.date, type: event.type, confirmed: event.confirmed };
  }
  snapshot.overUsed = [...new Set(snapshot.overUsed)].sort();
  snapshot.booked.sort();
  return snapshot;
}

export interface DetectContext {
  plan: RotaPlan;
  events: GamesEvent[];
  cells: Cell[];
  /** Log entries written since the previous run: used to name causes and to leave out the organiser's own actions. */
  log: LogEntry[];
  organiser: string;
  lookaheadWeeks: number;
}

function latestCellEntry(log: LogEntry[], person: string, event: string): LogEntry | undefined {
  const key = cellKey(person, event);
  return log.filter((entry) => entry.entity === 'cell' && entry.key === key && entry.field === 'value').at(-1);
}

const answerValues = ['Yes', 'Maybe', 'No', 'Unknown'] as const;
type AnswerValue = (typeof answerValues)[number];
const isAnswerValue = (v: string): v is AnswerValue => (answerValues as readonly string[]).includes(v);
type AnyValue = '' | AnswerValue | 'Stewarding' | 'Supporting' | 'Watching' | 'Not going';

/** Compares this run's read with the previous run's snapshot. Item-level exceptions (sources, proposals) come from the run. */
export function detectChanges(previous: Snapshot | null, current: Snapshot, context: DetectContext): RotaException[] {
  const out: RotaException[] = [];
  const gameById = new Map(context.plan.games.map((g) => [g.id, g]));
  // The organiser's own hand edits are not news. Changes she approved and the agent carried out are reported, so she
  // hears the consequences (who to ask again after a move).
  const byOrganiserHand = (entity: string, key: string, field: string): boolean =>
    context.log.some((entry) => entry.entity === entity && entry.key === key && entry.field === field && entry.who === 'organiser');
  const soon = (weeks: number): boolean => weeks <= context.lookaheadWeeks;

  // 1. Event changes.
  if (previous) {
    for (const [id, now] of Object.entries(current.events)) {
      const before = previous.events[id];
      if (!before) {
        out.push({ type: 'event_change', change: 'added', event: id, to: now.date });
        continue;
      }
      if (before.date !== now.date && !byOrganiserHand('event', id, 'date')) {
        const previousValues = context.log
          .filter((entry) => entry.entity === 'cell' && entry.key.endsWith(`::${id}`) && entry.source === 'event moved')
          .map((entry) => ({ person: entry.key.split('::')[0] ?? '', value: entry.old as AnyValue }));
        out.push({ type: 'event_change', change: 'moved', event: id, from: before.date, to: now.date, previous: previousValues });
      }
      if (before.label !== now.label && !byOrganiserHand('event', id, 'label')) out.push({ type: 'event_change', change: 'renamed', event: id });
      if (!before.confirmed && now.confirmed && !byOrganiserHand('event', id, 'confirmed')) {
        out.push({ type: 'event_change', change: 'confirmed', event: id, to: now.date });
      }
      if (before.type !== 'Superseded' && now.type === 'Superseded' && !byOrganiserHand('event', id, 'type')) {
        out.push({ type: 'event_change', change: 'cancelled', event: id });
      }
    }
  }

  // 2. A Saturday that is newly Red, worse than before, or whose delta fell below zero.
  for (const saturday of context.plan.saturdays) {
    if (!soon(saturday.weeksAway)) continue;
    const before = previous?.saturdays[saturday.date];
    const newlyRed = saturday.rag === 'Red' && (!before || before[1] !== 'Red' || saturday.deltaNow < before[0]);
    const fellBelow = saturday.deltaNow < 0 && (!before || before[0] >= 0);
    if (!newlyRed && !fellBelow) continue;
    const causes: Extract<RotaException, { type: 'red_or_delta_drop' }>['causes'] = [];
    for (const entry of context.log) {
      if (entry.entity !== 'cell' || entry.field !== 'value' || entry.source === 'event moved') continue;
      const [person = '', event = ''] = entry.key.split('::');
      if (!saturday.games.includes(event) || !isAnswerValue(entry.new) || entry.new === 'Yes') continue;
      causes.push({ person, event, value: entry.new, source: entry.source, at: entry.evidenceAt || entry.writtenAt });
    }
    const seenOpen = new Set<string>();
    const open: { person: string; value: AnyValue }[] = [];
    for (const item of context.plan.chase.filter((c) => saturday.games.includes(c.event))) {
      if (seenOpen.has(item.person) || open.length >= 4) continue;
      seenOpen.add(item.person);
      open.push({ person: item.person, value: item.value });
    }
    out.push({ type: 'red_or_delta_drop', saturday: saturday.date, events: saturday.games, delta: saturday.deltaNow, rag: saturday.rag, causes: causes.slice(0, 10), open });
  }

  // 3. Someone booked or pencilled who now says No, Maybe or Unknown.
  if (previous) {
    for (const entry of previous.booked) {
      const match = /^(.+)@(.+)=(.+)$/.exec(entry);
      if (!match) continue;
      const [, person = '', eventId = '', kind = ''] = match;
      const value = context.cells.find((c) => c.person === person && c.event === eventId)?.value ?? '';
      if (value !== 'No' && value !== 'Maybe' && value !== 'Unknown') continue;
      const logEntry = latestCellEntry(context.log, person, eventId);
      if (logEntry?.source === 'event moved') continue; // covered by the event change, with everyone's previous value
      const kindValue = kind === 'Stewarding' || kind === 'Supporting' ? kind : 'pencilled';
      out.push({
        type: 'booked_dropout',
        person,
        event: eventId,
        kind: kindValue,
        value,
        ...(logEntry ? { source: logEntry.source, at: logEntry.evidenceAt || logEntry.writtenAt } : {}),
      });
    }
  }

  // 4. Newly over-used. The renderer says whose limit it is: the rota's, not the person's.
  const previousOver = new Set(previous?.overUsed ?? []);
  for (const game of context.plan.games) {
    if (!soon(game.weeksAway)) continue;
    for (const over of game.overUsed) {
      if (previousOver.has(`${over.person}@${game.date}`)) continue;
      out.push({ type: 'over_used', person: over.person, event: game.id, weeks: over.weeks });
      previousOver.add(`${over.person}@${game.date}`);
    }
  }

  // 5. Newly no spare.
  const previousNoSpare = new Set(previous?.noSpare ?? []);
  for (const date of current.noSpare) {
    if (previousNoSpare.has(date)) continue;
    out.push({ type: 'no_spare', saturday: date, events: context.plan.saturdays.find((s) => s.date === date)?.games ?? [] });
  }

  // 6. Double bookings that were not there before.
  const previousDouble = new Set(previous?.doubleBooked ?? []);
  for (const entry of current.doubleBooked) {
    if (previousDouble.has(entry)) continue;
    const [person = '', date = ''] = entry.split('@');
    const where = context.plan.games.filter((g) => g.date === date && (g.booked.includes(person) || g.supporting.includes(person))).map((g) => g.id);
    if (where.length === 2) out.push({ type: 'double_booked', person, saturday: date, events: where, refused: false });
  }

  // 7. A ground that had a Chief Steward booked or pencilled at the last run and now has none.
  if (previous) {
    for (const [id, lead] of Object.entries(current.leads)) {
      const before = previous.leads[id];
      if (!before || lead || !gameById.has(id)) continue;
      const value = context.cells.find((c) => c.person === before && c.event === id)?.value ?? '';
      out.push({ type: 'lost_lead', event: id, person: before, value });
    }
  }

  return out;
}
