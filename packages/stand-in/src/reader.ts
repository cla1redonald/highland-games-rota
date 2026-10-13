/**
 * A small, deterministic reader for the phrasings in the seeded world. It turns words into calendar days before
 * mapping them to events, and follows the reading rules:
 *
 *   - "until X" means up to X, not including it;
 *   - a phrase that does not pin down days ("mid-July") is never Yes: it is Maybe, with the words quoted;
 *   - a stated span with named exceptions is Yes outside the exceptions and No inside them;
 *   - a yes that depends on something not agreed is Maybe on a condition, and the condition is not kept;
 *   - a hard clash anywhere in the footprint (Friday setup to Sunday pack-down) is No; a soft clash is Maybe;
 *   - someone else's report of a person's dates is information, not an answer;
 *   - an instruction found in a source is data: at most a Maybe on request for the speaker's own availability.
 *
 * Every date word it quotes comes from the engine's closed-grammar parser, which writes the words itself; nothing is
 * cut from the source. Whether the speaker is the organiser is decided by the caller from a trusted channel and
 * sender id, never from a name in the text.
 *
 * It is not a general reader of English. It exists so the demo and the evals run with no model; the Phase 1b agents
 * replace it.
 */
import {
  eventWords,
  footprint,
  parseDateParts,
  type Answer,
  type Basis,
  type DatePart,
  type Decision,
  type GamesEvent,
  type Person,
} from '@ghillie/engine';

export interface ReaderContext {
  /** Events that can be answered: games and setup days, not superseded, not finished. */
  events: GamesEvent[];
  people: Person[];
  /** The organiser's name, for relays she makes. */
  organiser: string;
  /** True only when the item came from the organiser's own sender id on her trusted channel. */
  speakerIsOrganiser: boolean;
  /** The London date the statement was made: an "until" span starts here. */
  saidOn: string;
  /** For call notes: misheard names mapped to the person the call was with. */
  aliases?: Record<string, string>;
}

export interface Verdict {
  event: string;
  value: Answer;
  /** Why it is this value: a plain answer, a vague phrase, a condition, a soft clash, or a request in a source. */
  basis: Basis;
  /** For vague and request: the words quoted, as the parser wrote them. */
  words?: string[];
}

export type Finding =
  | { kind: 'availability'; subject: string; verdicts: Verdict[]; words: string[]; vague: string[] }
  | { kind: 'decision'; person: string; event: string; value: Decision }
  | { kind: 'booking_request'; person: string; event: string; value: Decision }
  | { kind: 'leaning' }
  | { kind: 'relay'; subject: string }
  | { kind: 'move'; event: string; date: string }
  | { kind: 'move_talk'; event: string }
  | { kind: 'recruit'; name: string; hint: string }
  | { kind: 'instruction' }
  | { kind: 'lead_offer'; person: string; event: string }
  | { kind: 'organiser_own' };

const reportVerbs = ['says', 'said', 'reckons', 'told', 'tells', 'thinks'];
const subjectVerbs = ['can', "can't", 'cannot', 'could', 'is', "isn't", 'not', 'will', "won't", 'might', 'has', 'would', ...reportVerbs];

const cues = {
  tentative: /\b(might|maybe|probably|not sure|hopefully|should be able|possibly)\b/i,
  conditional: /\b(if|as long as|provided|depending on|depends on)\b/i,
  soft: /\b(could skip|could miss|can skip|could move it)\b/i,
  negative:
    /\b(can't|cannot|can not|won't|unable|not able|no to|count me out|pull(?:ing)? out|drop(?:ping)? out|not available|away|busy|working|no way round it)\b/i,
  positive:
    /\b(can do|can make|count me in|yes|i'm in|fine for|is fine|still fine|free|available|happy to|will be there|is a yes|put me down|could help|back in time for|back for|as usual|i'll be at)\b/i,
};

const recruitCue = /\b(would be great|'d be great|'d be good|could help out|might be up for|worth asking|fancies asking|ask (?:her|him|them)|anyone (?:ever )?ask|keen|recruit)\b/i;
const instructionCue = /\b(update the rota|put (?:me|that) (?:down |in )|ghillie,|add me as|make me)\b/i;
const moveCue = /\b(shift|shifts|move|moves|moved|moving|postponed|cancelled|brought forward)\b/i;
const moveDateCue = /(a week|a fortnight|to the \d|to (?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(?:st|nd|rd|th)? (?:june|july|august)|postponed|cancelled)/i;
const firstPerson = /\b(i|i'm|i'll|i've|me|my)\b/i;
const arenaHints: [RegExp, string][] = [
  [/children's races/i, "Children's races"],
  [/tug-of-war/i, 'Tug-of-war pitch'],
  [/piping|dancing/i, 'Piping and dancing platform'],
  [/heavy events|heavies/i, 'Heavy events field'],
  [/track/i, 'Track and field'],
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function shortName(event: GamesEvent): string {
  return eventWords(event);
}

function aliasesOf(event: GamesEvent): string[] {
  if (event.type === 'Setup day') return ['setup day'];
  const village = event.village.toLowerCase();
  const names = new Set([event.label.toLowerCase(), village]);
  const first = village.split(/[\s-]/)[0] ?? '';
  if (first.length >= 5) names.add(first);
  return [...names].sort((a, b) => b.length - a.length);
}

function eventRefs(clause: string, events: GamesEvent[]): string[] {
  const lower = clause.toLowerCase();
  const refs: { event: string; index: number }[] = [];
  for (const event of events) {
    for (const alias of aliasesOf(event)) {
      const match = new RegExp(`\\b${escapeRegex(alias)}\\b`).exec(lower);
      if (match) {
        refs.push({ event: event.id, index: match.index });
        break;
      }
    }
  }
  return refs.sort((a, b) => a.index - b.index).map((r) => r.event);
}

function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clausesOf(sentence: string): string[] {
  return sentence
    .split(/,\s+(?:and\s+)?|;\s+|\s+but\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function personByName(name: string, ctx: ReaderContext): string | null {
  const mapped = ctx.aliases?.[name] ?? name;
  return ctx.people.find((p) => p.name === mapped)?.name ?? null;
}

function polarity(clause: string, vague: boolean, sentenceConditional: boolean): { value: Answer; basis: Basis } | null {
  if (vague) return { value: 'Maybe', basis: 'vague' };
  const tentative = cues.tentative.test(clause);
  // "I can do Kinloch but only if there's a lift": the condition sits in another clause of the same sentence.
  const conditional = cues.conditional.test(clause) || sentenceConditional;
  const soft = cues.soft.test(clause);
  const negative = cues.negative.test(clause);
  const positive = cues.positive.test(clause);
  if (soft) return { value: 'Maybe', basis: 'soft_clash' };
  if (tentative) return { value: 'Maybe', basis: 'answer' };
  if (conditional && positive) return { value: 'Maybe', basis: 'condition' };
  if (negative) return { value: 'No', basis: 'answer' };
  if (positive) return { value: 'Yes', basis: 'answer' };
  return null;
}

interface Scored extends Verdict {
  priority: number;
  order: number;
}

/** The events a date part points at, by footprint. */
function eventsFor(part: DatePart, events: GamesEvent[]): string[] {
  if (part.kind === 'date' || part.kind === 'range' || part.kind === 'vague') return events.filter((e) => overlaps(part, footprint(e))).map((e) => e.id);
  if (part.kind === 'day') return events.filter((e) => e.type === 'Games' && Number(e.date.slice(8, 10)) === part.day).map((e) => e.id);
  return [];
}

/** Reads one sentence that states a span: "free until X apart from Y". */
function readSpan(sentence: string, parts: DatePart[], ctx: ReaderContext): { verdicts: Scored[]; words: string[] } | null {
  if (!/\b(?:free|available|about|around)\b/i.test(sentence)) return null;
  const until = parts.find((p) => p.kind === 'until');
  if (!until || until.kind !== 'until') return null;
  const words = [until.words];
  const exceptions: { start: string; end: string }[] = [];
  const exceptAt = /\b(?:apart from|except|other than|bar)\b/i.exec(sentence)?.index;
  if (exceptAt !== undefined) {
    const later = parts.filter((p) => p.index >= exceptAt);
    const duration = later.find((p) => p.kind === 'duration');
    for (const part of later) {
      if (part.kind !== 'date' && part.kind !== 'range') continue;
      words.push(part.words);
      const end = duration && duration.kind === 'duration' ? addDays(part.start, duration.days - 1) : part.end;
      exceptions.push({ start: part.start, end });
    }
    if (duration && exceptions.length) words.push(duration.words);
  }
  const verdicts: Scored[] = [];
  ctx.events.forEach((event, order) => {
    const fp = footprint(event);
    if (fp.end < ctx.saidOn) return;
    if (event.id === until.event || (fp.start <= until.untilDay && until.untilDay <= fp.end)) {
      verdicts.push({ event: event.id, value: 'No', basis: 'answer', priority: 1, order });
      return;
    }
    if (fp.start > until.untilDay) return; // after the span: nothing was said about it
    const clash = exceptions.some((range) => overlaps(range, fp));
    verdicts.push({ event: event.id, value: clash ? 'No' : 'Yes', basis: 'answer', priority: 1, order });
  });
  return { verdicts, words };
}

function recruitFindings(text: string, ctx: ReaderContext): Finding[] {
  if (!recruitCue.test(text)) return [];
  const known = new Set(ctx.people.flatMap((p) => [p.name, p.surname]));
  const placeWords = new Set(ctx.events.flatMap((e) => [...e.label.split(/[\s-]+/), ...e.village.split(/[\s-]+/)]));
  const stop = new Set(['Chief', 'Steward', 'Games', 'Did', 'My', 'Have', 'Morning', 'Sorry', 'The', 'Turns', 'Ghillie']);
  const found = new Map<string, string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g)) {
    const first = m[1] ?? '';
    const last = m[2] ?? '';
    if ([first, last].some((w) => known.has(w) || placeWords.has(w) || stop.has(w))) continue;
    if (/\bthe\s+$/i.test(text.slice(0, m.index))) continue; // "the Young Farmers" is a body, not a person
    const hint = arenaHints.find(([re]) => re.test(text))?.[1] ?? '';
    found.set(`${first} ${last}`, hint);
  }
  return [...found].map(([name, hint]) => ({ kind: 'recruit', name, hint }));
}

const decisionPatterns: { re: RegExp; value: Decision }[] = [
  { re: /\b(?:[Pp]ut|[Pp]utting|[Bb]ook|[Bb]ooked|[Bb]ooking)\s+([A-Z][a-z]+)\s+(?:down\s+)?(?:to steward|as (?:a )?steward|on|for|at)\b/, value: 'Stewarding' },
  { re: /^([A-Z][a-z]+),\s+you're\s+(?:on|stewarding|down|booked)\b/, value: 'Stewarding' },
  { re: /\b([A-Z][a-z]+)\s+is\s+stewarding\b/, value: 'Stewarding' },
  { re: /\b([A-Z][a-z]+)\s+is\s+supporting\b/, value: 'Supporting' },
  { re: /\b([A-Z][a-z]+)\s+(?:can|may)\s+(?:come and\s+)?watch\b/, value: 'Watching' },
  { re: /\b([A-Z][a-z]+)(?:'s|\s+is)\s+not\s+(?:going|ready)\b/, value: 'Not going' },
];

function readDecisions(clause: string, sentence: string, ctx: ReaderContext, speaker: string): Finding[] {
  for (const { re, value } of decisionPatterns) {
    const m = re.exec(clause);
    if (!m) continue;
    const person = personByName(m[1] ?? '', ctx);
    if (!person || person === speaker) continue;
    let refs = eventRefs(clause, ctx.events);
    if (!refs.length) refs = eventRefs(sentence, ctx.events);
    if (!refs.length) continue;
    if (/\b(thinking of|probably|might|i'll talk to|considering|leaning)\b/i.test(clause)) return [{ kind: 'leaning' }];
    return refs.map((event): Finding => ({ kind: ctx.speakerIsOrganiser ? 'decision' : 'booking_request', person, event, value }));
  }
  return [];
}

/** Reads one message. `speaker` is who wrote or said it; `ctx.speakerIsOrganiser` says whether that was her. */
export function readMessage(text: string, speaker: string, ctx: ReaderContext): Finding[] {
  const findings: Finding[] = [];
  const byOrganiser = ctx.speakerIsOrganiser;
  const allRefs = eventRefs(text, ctx.events);

  findings.push(...recruitFindings(text, ctx));
  if (!byOrganiser && instructionCue.test(text)) findings.push({ kind: 'instruction' });

  const bySubject = new Map<string, { verdicts: Scored[]; words: string[]; vague: string[] }>();
  const bucket = (subject: string): { verdicts: Scored[]; words: string[]; vague: string[] } => {
    let entry = bySubject.get(subject);
    if (!entry) {
      entry = { verdicts: [], words: [], vague: [] };
      bySubject.set(subject, entry);
    }
    return entry;
  };
  let order = 0;

  for (const sentence of sentencesOf(text)) {
    if (sentence.endsWith('?')) continue; // a question asks; it does not state

    // Who is this sentence about?
    let subject = speaker;
    const lead = new RegExp(`^([A-Z][a-z]+)(?:'s)?\\s+(${subjectVerbs.map(escapeRegex).join('|')})\\b`).exec(sentence);
    if (lead) {
      const named = personByName(lead[1] ?? '', ctx);
      const verb = lead[2] ?? '';
      const isPlace = ctx.events.some((e) => `${e.label} ${e.village}`.split(/[\s-]+/).includes(lead[1] ?? ''));
      if (!named && !isPlace && lead[1] !== 'Somebody') {
        // About someone not on the rota: never read as the speaker's own dates.
        findings.push({ kind: 'relay', subject: lead[1] ?? '' });
        continue;
      }
      if (named && named !== speaker) {
        if (reportVerbs.includes(verb) || !byOrganiser) {
          findings.push({ kind: 'relay', subject: named });
          continue;
        }
        subject = named; // the organiser can relay an answer
      } else if (named) {
        subject = named;
      }
    }

    const parts = parseDateParts(sentence, ctx.events, ctx.saidOn);

    if (byOrganiser) {
      if (/\bpencil/i.test(sentence) && subject === speaker) {
        // The organiser's own pencilling: her action, recorded by her hand, not news.
        for (const clause of clausesOf(sentence).filter((c) => !/\bpencil/i.test(c))) findings.push(...readDecisions(clause, clause, ctx, speaker));
        findings.push({ kind: 'organiser_own' });
        continue;
      }
      const decided: Finding[] = [];
      // "Dougie, you're on..." is one clause: the name before the comma is who it is about.
      const pieces = /^[A-Z][a-z]+,\s+you're\b/.test(sentence) ? [sentence] : clausesOf(sentence);
      for (const clause of pieces) decided.push(...readDecisions(clause, sentence, ctx, speaker));
      if (decided.length) {
        findings.push(...decided);
        continue;
      }
      const refs = eventRefs(sentence, ctx.events);
      const moveTo = parts.find((p) => p.kind === 'date');
      if (refs[0] && moveCue.test(sentence) && moveTo && moveTo.kind === 'date') {
        findings.push({ kind: 'move', event: refs[0], date: moveTo.start });
        continue;
      }
      if (subject === speaker) {
        findings.push({ kind: 'organiser_own' });
        continue;
      }
    } else {
      for (const clause of clausesOf(sentence)) findings.push(...readDecisions(clause, sentence, ctx, speaker));
    }

    const refsHere = eventRefs(sentence, ctx.events);
    if (/\b(?:can|could|happy to|will)\s+lead\b/i.test(sentence) && refsHere[0]) {
      findings.push({ kind: 'lead_offer', person: subject, event: refsHere[0] });
      continue;
    }
    // A sentence about the speaker's own availability ("Can't do Strathcorrie now it's moved") is not talk of a move.
    const ownCue = (subject === speaker || firstPerson.test(sentence)) && (cues.positive.test(sentence) || cues.negative.test(sentence));
    if (!ownCue && refsHere[0] && moveCue.test(sentence) && moveDateCue.test(sentence)) {
      findings.push({ kind: 'move_talk', event: refsHere[0] });
      continue;
    }

    // A soft clash with a date ("the club open day is Sunday 11 July, but I could skip it") is Maybe.
    if (cues.soft.test(sentence)) {
      const dated = parts.filter((p) => p.kind === 'date' || p.kind === 'range');
      const entry = bucket(subject);
      for (const part of dated) {
        entry.words.push(part.words);
        for (const event of eventsFor(part, ctx.events)) entry.verdicts.push({ event, value: 'Maybe', basis: 'soft_clash', priority: 2, order: order++ });
      }
      if (dated.length) continue;
    }

    const span = readSpan(sentence, parts, ctx);
    if (span) {
      const entry = bucket(subject);
      entry.verdicts.push(...span.verdicts.map((v) => ({ ...v, order: order++ })));
      entry.words.push(...span.words);
      continue;
    }

    // A request found in a source is at most a Maybe for the speaker's own availability, quoted by event name.
    const request = !byOrganiser && instructionCue.test(sentence);
    for (const clause of clausesOf(sentence)) {
      const entry = bucket(subject);
      const clauseParts = parseDateParts(clause, ctx.events, ctx.saidOn);
      let refs = eventRefs(clause, ctx.events);
      const clauseWords: string[] = [];
      let priority = 2;
      if (!refs.length) {
        for (const part of clauseParts.filter((p) => p.kind === 'day')) {
          refs.push(...eventsFor(part, ctx.events));
          clauseWords.push(part.words);
        }
      }
      for (const part of clauseParts.filter((p) => p.kind === 'date' || p.kind === 'range')) {
        clauseWords.push(part.words);
        refs.push(...eventsFor(part, ctx.events));
      }
      const vague = clauseParts.filter((p) => p.kind === 'vague');
      for (const part of vague) {
        clauseWords.push(part.words);
        entry.vague.push(part.words);
        refs.push(...eventsFor(part, ctx.events));
      }
      const group = clauseParts.find((p) => p.kind === 'others' || p.kind === 'all');
      if (!refs.length && group) {
        priority = 0;
        clauseWords.push(group.words);
        for (const event of ctx.events) {
          if (event.type !== 'Games') continue;
          if (group.kind === 'others' && allRefs.includes(event.id)) continue;
          refs.push(event.id);
        }
      }
      refs = [...new Set(refs)];
      if (!refs.length) continue;
      const read = polarity(clause, vague.length > 0, cues.conditional.test(sentence));
      if (!read) continue;
      for (const event of refs) {
        const named = ctx.events.find((e) => e.id === event);
        entry.verdicts.push({
          event,
          value: request ? 'Maybe' : read.value,
          basis: request ? 'request' : read.basis,
          ...(request && named ? { words: [eventWords(named)] } : vague.length ? { words: vague.map((v) => v.words) } : {}),
          priority,
          order: order++,
        });
      }
      entry.words.push(...clauseWords);
    }
  }

  for (const [subject, entry] of bySubject) {
    if (!entry.verdicts.length) continue;
    // Explicit mentions beat "every other one"; among equals, the later statement in the message wins.
    const best = new Map<string, Scored>();
    for (const verdict of entry.verdicts) {
      const current = best.get(verdict.event);
      if (!current || verdict.priority > current.priority || (verdict.priority === current.priority && verdict.order > current.order)) best.set(verdict.event, verdict);
    }
    const eventOrder = new Map(ctx.events.map((e, i) => [e.id, i]));
    const verdicts = [...best.values()]
      .sort((a, b) => (eventOrder.get(a.event) ?? 0) - (eventOrder.get(b.event) ?? 0))
      .map(({ event, value, basis, words }) => ({ event, value, basis, ...(words ? { words } : {}) }));
    findings.push({ kind: 'availability', subject, verdicts, words: [...new Set(entry.words.filter(Boolean))], vague: entry.vague });
  }
  return findings;
}
