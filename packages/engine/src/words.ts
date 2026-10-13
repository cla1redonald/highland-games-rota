/**
 * Structured inputs and the text the service composes from them.
 *
 * Nothing a source said is ever stored, logged or sent as free text. A caller gives structured fields (an answer, a
 * basis, the date words, an action from a fixed list) and the service writes the words itself. Date words are checked
 * against an allow-list grammar: a phrase passes only if every word in it is a date word or the name of an event, so a
 * reason ("my gall bladder op") cannot pass whatever it says. The keyword filter in privacy.ts is a second line, not
 * the first.
 */
import { z } from 'zod';
import { formatDay, londonDate } from './dates.js';
import type { GamesEvent } from './types.js';

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthByName: Record<string, number> = {};
monthNames.forEach((m, i) => {
  monthByName[m.toLowerCase()] = i + 1;
  if (m !== 'May') monthByName[m.slice(0, 3).toLowerCase()] = i + 1;
});
monthByName.sept = 9;
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthPattern = Object.keys(monthByName).sort((a, b) => b.length - a.length).join('|');
const weekdayPattern = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
const ordinalSuffix = '(?:st|nd|rd|th)';

export const maxDateWordPhrases = 8;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function ordinalOf(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "Tuesday 29 June": the weekday comes from the date, never from the source. */
export function dateWords(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  const weekdayIndex = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `${dayNames[weekdayIndex] ?? ''} ${day ?? ''} ${monthNames[(month ?? 1) - 1] ?? ''}`;
}

function durationWords(days: number): string {
  if (days === 14) return 'a fortnight';
  if (days === 7) return 'a week';
  if (days % 7 === 0) return `${['', 'one', 'two', 'three', 'four'][days / 7] ?? days / 7} weeks`;
  return days === 1 ? 'a day' : `${days} days`;
}

/** The next date on or after `today` that falls on day `n` of a month. */
function nextDayOfMonth(n: number, today: string): string {
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  if (n < Number(today.slice(8, 10))) month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return `${year}-${pad(month)}-${pad(n)}`;
}

export type DatePart =
  | { kind: 'range'; start: string; end: string; words: string; index: number }
  | { kind: 'date'; start: string; end: string; words: string; index: number }
  | { kind: 'until'; untilDay: string; event?: string; words: string; index: number }
  | { kind: 'from'; start: string; words: string; index: number }
  | { kind: 'vague'; start: string; end: string; words: string; index: number }
  | { kind: 'duration'; days: number; words: string; index: number }
  | { kind: 'day'; day: number; words: string; index: number }
  | { kind: 'others' | 'all'; words: string; index: number };

function eventAliases(event: GamesEvent): string[] {
  if (event.type === 'Setup day') return ['setup day'];
  const village = event.village.toLowerCase();
  const names = new Set([event.label.toLowerCase(), village]);
  const first = village.split(/[\s-]/)[0] ?? '';
  if (first.length >= 5) names.add(first);
  return [...names].sort((a, b) => b.length - a.length);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The date parser: a closed grammar of dates, day names, month names, "until", "from", "the week of", durations and
 * numbers. It returns what it understood, each with words it writes itself. Anything it does not understand is
 * dropped: "free until the 19th, gall bladder op" yields exactly "until the 19th".
 */
export function parseDateParts(text: string, events: GamesEvent[], today: string): DatePart[] {
  const year = today.slice(0, 4);
  // URLs and email addresses are never date words, whatever they contain.
  let rest = ` ${text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, (m) => ' '.repeat(m.length)).replace(/\S+@\S+/g, (m) => ' '.repeat(m.length))} `;
  const parts: DatePart[] = [];
  const take = (re: RegExp, build: (m: RegExpExecArray) => DatePart | null): void => {
    for (const m of [...rest.matchAll(re)]) {
      const part = build(m);
      if (!part) continue;
      parts.push({ ...part, index: m.index });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  };
  const iso = (day: number, monthWord: string): string | null => {
    const month = monthByName[monthWord.toLowerCase()];
    if (!month || day < 1 || day > 31) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  };
  const single = `(?:${weekdayPattern}\\s+)?(\\d{1,2})${ordinalSuffix}?\\s+(${monthPattern})\\b`;

  take(new RegExp(`\\b(\\d{1,2})${ordinalSuffix}?\\s+(?:to|until|-)\\s+(\\d{1,2})${ordinalSuffix}?\\s+(${monthPattern})\\b`, 'gi'), (m) => {
    const start = iso(Number(m[1]), m[3] ?? '');
    const end = iso(Number(m[2]), m[3] ?? '');
    if (!start || !end) return null;
    return { kind: 'range', start, end, words: `${Number(m[1])} to ${Number(m[2])} ${monthNames[Number(start.slice(5, 7)) - 1] ?? ''}`, index: 0 };
  });

  const aliasPattern = events.flatMap((e) => eventAliases(e).map((a) => escape(a))).join('|');
  take(new RegExp(`\\b(?:until|till|up to)\\s+(?:the\\s+)?(?:(${aliasPattern})(?:\\s+games)?|${single}|week of (?:the\\s+)?(\\d{1,2})${ordinalSuffix}|(\\d{1,2})${ordinalSuffix})`, 'gi'), (m) => {
    if (m[1]) {
      const alias = m[1].toLowerCase();
      const event = events.find((e) => eventAliases(e).includes(alias));
      if (!event) return null;
      const start = event.type === 'Setup day' ? event.date : shiftDays(event.date, -1);
      return { kind: 'until', untilDay: start, event: event.id, words: `until the ${event.label}`, index: 0 };
    }
    if (m[2] && m[3]) {
      const date = iso(Number(m[2]), m[3]);
      return date ? { kind: 'until', untilDay: date, words: `until ${dateWords(date)}`, index: 0 } : null;
    }
    if (m[4]) {
      const date = nextDayOfMonth(Number(m[4]), today);
      // "Until the week of the 13th": not free that week, so the span ends on the Monday of it.
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const monday = shiftDays(date, -((weekday + 6) % 7));
      return { kind: 'until', untilDay: monday, words: `until the week of the ${ordinalOf(Number(m[4]))}`, index: 0 };
    }
    if (m[5]) {
      const date = nextDayOfMonth(Number(m[5]), today);
      return { kind: 'until', untilDay: date, words: `until the ${ordinalOf(Number(m[5]))}`, index: 0 };
    }
    return null;
  });

  take(new RegExp(`\\bfrom\\s+(?:the\\s+)?(?:${single}|(\\d{1,2})${ordinalSuffix})`, 'gi'), (m) => {
    if (m[1] && m[2]) {
      const date = iso(Number(m[1]), m[2]);
      return date ? { kind: 'from', start: date, words: `from ${dateWords(date)}`, index: 0 } : null;
    }
    if (m[3]) return { kind: 'from', start: nextDayOfMonth(Number(m[3]), today), words: `from the ${ordinalOf(Number(m[3]))}`, index: 0 };
    return null;
  });

  take(new RegExp(`\\b${single}`, 'gi'), (m) => {
    const date = iso(Number(m[1]), m[2] ?? '');
    return date ? { kind: 'date', start: date, end: date, words: dateWords(date), index: 0 } : null;
  });

  take(new RegExp(`\\b(early|mid|late|end of|start of|beginning of)[-\\s]?(${monthPattern})\\b`, 'gi'), (m) => {
    const month = monthByName[(m[2] ?? '').toLowerCase()];
    if (!month) return null;
    const part = (m[1] ?? '').toLowerCase();
    const [from, to] = part === 'mid' ? [8, 22] : part === 'early' || part === 'start of' || part === 'beginning of' ? [1, 10] : [20, 31];
    const last = new Date(Date.UTC(Number(year), month, 0)).getUTCDate();
    const name = monthNames[month - 1] ?? '';
    const words = part === 'mid' ? `mid-${name}` : `${part === 'beginning of' ? 'start of' : part} ${name}`;
    return { kind: 'vague', start: `${year}-${pad(month)}-${pad(from)}`, end: `${year}-${pad(month)}-${pad(Math.min(to, last))}`, words, index: 0 };
  });

  take(/\b(a|one|two|three|four|\d{1,2})\s+(fortnight|weeks?|days?)\b/gi, (m) => {
    const word = (m[1] ?? 'a').toLowerCase();
    const count = ({ a: 1, one: 1, two: 2, three: 3, four: 4 } as Record<string, number>)[word] ?? Number(word);
    const unit = (m[2] ?? '').toLowerCase();
    const days = unit === 'fortnight' ? 14 * count : unit.startsWith('week') ? 7 * count : count;
    return { kind: 'duration', days, words: durationWords(days), index: 0 };
  });

  take(new RegExp(`\\bthe\\s+(\\d{1,2})${ordinalSuffix}\\b`, 'gi'), (m) => ({ kind: 'day', day: Number(m[1]), words: `the ${ordinalOf(Number(m[1]))}`, index: 0 }));
  take(/\b(every other one|all the others|the rest of them)\b/gi, () => ({ kind: 'others', words: 'every other one', index: 0 }));
  take(/\b(all of them|every one of them|all the games)\b/gi, () => ({ kind: 'all', words: 'all of them', index: 0 }));

  return parts.sort((a, b) => a.index - b.index);
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The date words in a text, as the parser writes them. Everything else is dropped. */
export function extractDateWords(text: string, events: GamesEvent[], today: string): string[] {
  return [...new Set(parseDateParts(text, events, today).map((p) => p.words))];
}

/** The name an event is quoted by: its village, or "Setup day". */
export function eventWords(event: GamesEvent): string {
  return event.type === 'Setup day' ? 'Setup day' : event.village;
}

/**
 * Every phrase must be exactly what the parser would write for it, or the quoted name of an event. A phrase cut from a
 * source, a reason, a URL or an instruction cannot pass.
 */
export function checkDateWords(phrases: string[], events: GamesEvent[], today: string): { ok: true } | { ok: false; phrase: string } {
  if (phrases.length > maxDateWordPhrases) return { ok: false, phrase: `${phrases.length} phrases` };
  const names = new Set(events.map(eventWords));
  for (const phrase of phrases) {
    if (names.has(phrase)) continue;
    const parts = parseDateParts(phrase, events, today);
    if (parts.length !== 1 || parts[0]?.words !== phrase) return { ok: false, phrase };
  }
  return { ok: true };
}

/** Where a statement came from. Labels only; the service adds the time from the evidence time. */
export const sourceLabelPattern = /^(chat|chat #[a-z0-9-]{1,30}|chat DM|mail|call notes|circuit calendar|organiser approval|run)$/;

/** A source label is a fixed word, or a chat channel the configuration knows. Never a free-text description. */
export function isKnownSourceLabel(label: string, knownChannels: string[]): boolean {
  if (!sourceLabelPattern.test(label)) return false;
  const channel = /^chat #(.+)$/.exec(label)?.[1];
  return channel === undefined || knownChannels.includes(channel);
}

export function sourceKind(label: string): string {
  if (label.startsWith('chat')) return 'chat';
  return label;
}

/** A person's name as a recruit is proposed: two or three capitalised words. */
export const recruitNamePattern = /^[A-Z][a-z'-]{1,20}( [A-Z][a-z'-]{1,20}){1,2}$/;

export const bases = ['answer', 'vague', 'condition', 'soft_clash', 'request'] as const;
export type Basis = (typeof bases)[number];

/** The cell note for an answer, written by the service from the basis and the date words. */
export function cellNote(basis: Basis, words: string[], source: string): string {
  const quoted = words.map((w) => `"${w}"`).join(', ');
  switch (basis) {
    case 'answer':
      return '';
    case 'vague':
      return `${quoted}: not pinned to days`;
    case 'condition':
      return `condition, see ${sourceKind(source)}`;
    case 'soft_clash':
      return 'soft clash, could be moved';
    case 'request':
      return `${quoted || 'a request'}: asked to be put down, not a confirmed answer`;
  }
}

export const verdictSchema = z.object({ event: z.string().min(1), value: z.enum(['Yes', 'Maybe', 'No', 'Unknown']) }).strict();

/** A statement of someone's dates, for the history in their note. */
export const statementSchema = z
  .object({
    verdicts: z.array(verdictSchema).min(1).max(12),
    dateWords: z.array(z.string()).max(maxDateWordPhrases),
  })
  .strict();
export type Statement = z.infer<typeof statementSchema>;

export function statementLine(statement: Statement, evidenceAt: string, source: string, names: Map<string, string>): string {
  const groups = new Map<string, string[]>();
  for (const v of statement.verdicts) groups.set(v.value, [...(groups.get(v.value) ?? []), names.get(v.event) ?? v.event]);
  const summary = [...groups].map(([value, list]) => `${value} ${list.join(', ')}`).join('; ');
  const quoted = statement.dateWords.length ? ` (${statement.dateWords.map((w) => `"${w}"`).join(', ')})` : '';
  return `${formatDay(londonDate(evidenceAt))} (${sourceKind(source)}): ${summary}${quoted}`;
}

export const nextStepActions = ['ask_dates', 'confirm', 'settle_condition', 'find_cover', 'decide_joining', 'ask_dates_if_joining', 'clear'] as const;

/** The next action, who does it and by when. The service writes the words. */
export const nextStepSchema = z
  .object({
    action: z.enum(nextStepActions),
    /** Who the step is about. */
    about: z.string().min(1),
    events: z.array(z.string()).max(6).optional(),
    by: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
export type NextStep = z.infer<typeof nextStepSchema>;

export function nextStepText(step: NextStep, organiser: string, names: Map<string, string>): string {
  const by = step.by ? ` by ${formatDay(step.by)}` : '';
  const events = (step.events ?? []).map((e) => names.get(e) ?? e).join(', ');
  switch (step.action) {
    case 'ask_dates':
      return `${organiser} to ask ${step.about} for exact dates${by}`;
    case 'confirm':
      return `${step.about} to confirm ${events || 'their dates'}${by}`;
    case 'settle_condition':
      return `${organiser} to settle ${step.about}'s condition${by}`;
    case 'find_cover':
      return `${organiser} to find cover for ${step.about}${by}`;
    case 'decide_joining':
      return `${organiser} to decide whether ${step.about} joins the bench`;
    case 'ask_dates_if_joining':
      return `${organiser} to ask ${step.about} for dates if joining`;
    case 'clear':
      return '';
  }
}

export function recruitWhy(suggestedBy: string, arena: string | undefined): string {
  return `${suggestedBy} suggested them${arena ? ` for the ${arena.toLowerCase()}` : ''}`;
}

/** Person fields that are bookkeeping: the history in the note, the next step, last checked. */
export function isBookkeepingField(field: string): boolean {
  return field === 'statement' || field === 'nextStep' || field === 'lastChecked';
}
