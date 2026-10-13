/**
 * Calendar arithmetic on plain dates (YYYY-MM-DD) and London wall-clock formatting for instants.
 * Plain dates are handled as whole days in UTC so a clock change can never shift a Saturday.
 */
import type { GamesEvent } from './types.js';

const dayMs = 86_400_000;
const timeZone = 'Europe/London';

export function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`not a date: ${date}`);
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / dayMs);
}

export function fromDayNumber(day: number): string {
  return new Date(day * dayMs).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** 0 Sunday to 6 Saturday. */
export function weekday(date: string): number {
  return new Date(dayNumber(date) * dayMs).getUTCDay();
}

export function isWeekday(date: string): boolean {
  const d = weekday(date);
  return d >= 1 && d <= 5;
}

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface LondonParts {
  date: string;
  hour: number;
  minute: number;
}

export function londonParts(instant: Date | string): LondonParts {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(at.getTime())) throw new Error(`not a time: ${String(instant)}`);
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(at)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function londonDate(instant: Date | string): string {
  return londonParts(instant).date;
}

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sat 26 Jun" */
export function formatDay(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${weekdayNames[weekday(date)]} ${day} ${monthNames[(month ?? 1) - 1]}`;
}

/** "Tue 8 Jun 11:02", in London time. */
export function formatWhen(instant: Date | string): string {
  const parts = londonParts(instant);
  const hh = String(parts.hour).padStart(2, '0');
  const mm = String(parts.minute).padStart(2, '0');
  return `${formatDay(parts.date)} ${hh}:${mm}`;
}

/**
 * The London offset for a plain date and wall-clock time, as an ISO instant. Used to build tick times such as
 * 13:00 on a given weekday without hard-coding summer time.
 */
export function londonInstant(date: string, time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  const guess = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hour ?? 0,
    minute ?? 0,
  );
  // London is UTC or UTC+1: try both and keep the one that reads back as the wall-clock time asked for.
  for (const offsetHours of [1, 0]) {
    const candidate = new Date(guess - offsetHours * 3_600_000);
    const parts = londonParts(candidate);
    if (parts.date === date && parts.hour === hour && parts.minute === minute) {
      return `${date}T${time}:00${offsetHours === 1 ? '+01:00' : '+00:00'}`;
    }
  }
  throw new Error(`no London instant for ${date} ${time}`);
}

/** The days an event costs a volunteer: Friday setup, Saturday games, Sunday pack-down. A setup day is one day. */
export function footprint(event: Pick<GamesEvent, 'type' | 'date'>): { start: string; end: string } {
  if (event.type === 'Setup day') return { start: event.date, end: event.date };
  return { start: addDays(event.date, -1), end: addDays(event.date, 1) };
}

/** Whole weeks from today to the date, rounded down. */
export function weeksAway(date: string, today: string): number {
  return Math.floor(daysBetween(today, date) / 7);
}

export function compareInstants(a: string, b: string): number {
  return new Date(a).getTime() - new Date(b).getTime();
}

export function isValidInstant(value: string): boolean {
  // An instant must carry its offset, or "when it was said" is ambiguous.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function minusMinutes(instant: string, minutes: number): string {
  return new Date(new Date(instant).getTime() - minutes * 60_000).toISOString();
}
