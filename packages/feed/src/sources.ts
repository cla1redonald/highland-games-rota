/**
 * Adapters that read the seeded fortnight as if from the real sources: a chat workspace, a mailbox, a folder of call
 * notes and the circuit calendar. Each returns only what the source would show at a given time, including its
 * flaws: the mailbox search lists threads without their newest replies, call notes are filed under the wrong title
 * with names misheard, and any source can be made to hang so the caller's timeout has to catch it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { compareInstants } from '@ghillie/engine';

export const fixturesDir = new URL('../fixtures/', import.meta.url);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, fixturesDir), 'utf8')) as T;
}

export interface Window {
  /** Exclusive. */
  from: string;
  /** Inclusive. */
  to: string;
}

function inWindow(at: string, window: Window): boolean {
  return compareInstants(at, window.from) > 0 && compareInstants(at, window.to) <= 0;
}

// ---------- chat ----------

export interface ChatUser {
  id: string;
  real_name: string;
}

export interface ChatChannel {
  id: string;
  name: string;
  is_im: boolean;
  members: string[];
}

export interface ChatMessage {
  channel: string;
  ts: string;
  user: string;
  text: string;
  subtype?: string;
  thread_ts?: string;
}

export interface ChatExport {
  users: ChatUser[];
  channels: ChatChannel[];
  messages: ChatMessage[];
}

export function tsToIso(ts: string): string {
  return new Date(Math.round(Number(ts) * 1000)).toISOString();
}

export class ChatSource {
  readonly name = 'chat';
  constructor(private readonly data: ChatExport = readJson<ChatExport>('chat.json')) {}

  user(id: string): ChatUser | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  channel(id: string): ChatChannel | undefined {
    return this.data.channels.find((c) => c.id === id);
  }

  /** Messages posted in the window, oldest first. Huddle notices are left out: see huddlesAround. */
  messages(window: Window): Promise<ChatMessage[]> {
    return Promise.resolve(
      this.data.messages
        .filter((m) => m.subtype !== 'huddle_started' && inWindow(tsToIso(m.ts), window))
        .sort((a, b) => Number(a.ts) - Number(b.ts)),
    );
  }

  /** Huddles (calls) that started within the given minutes of a time, with who was in them. */
  huddlesAround(at: string, minutes: number): { at: string; members: string[] }[] {
    const target = new Date(at).getTime();
    return this.data.messages
      .filter((m) => m.subtype === 'huddle_started' && Math.abs(Number(m.ts) * 1000 - target) <= minutes * 60_000)
      .map((m) => ({ at: tsToIso(m.ts), members: this.channel(m.channel)?.members ?? [] }));
  }
}

// ---------- mail ----------

export interface MailMessage {
  id: string;
  from: string;
  to: string[];
  date: string;
  body: string;
  /** The search listing has not caught up with this message: only opening the thread shows it. */
  staleInListing?: boolean;
}

export interface MailThread {
  id: string;
  subject: string;
  messages: MailMessage[];
}

export interface MailListing {
  threadId: string;
  subject: string;
  /** What the search result shows. Can stop before the newest message: open the thread before concluding. */
  messages: MailMessage[];
}

export class MailSource {
  readonly name = 'mail';
  constructor(private readonly data: { threads: MailThread[] } = readJson<{ threads: MailThread[] }>('mail.json')) {}

  /** Threads with any message in the window, as the search lists them: possibly without their newest replies. */
  search(window: Window): Promise<MailListing[]> {
    return Promise.resolve(
      this.data.threads
        .filter((t) => t.messages.some((m) => inWindow(m.date, window)))
        .map((t) => ({
          threadId: t.id,
          subject: t.subject,
          messages: t.messages.filter((m) => !m.staleInListing && compareInstants(m.date, window.to) <= 0),
        })),
    );
  }

  /** The whole thread as it stood at a time. */
  getThread(id: string, asOf: string): Promise<MailThread | undefined> {
    const thread = this.data.threads.find((t) => t.id === id);
    if (!thread) return Promise.resolve(undefined);
    return Promise.resolve({ ...thread, messages: thread.messages.filter((m) => compareInstants(m.date, asOf) <= 0) });
  }
}

// ---------- call notes ----------

export interface CallNotes {
  file: string;
  /** Filed under whatever calendar slot the call fell in, which may have nothing to do with the call. */
  title: string;
  callAt: string;
  filedAt: string;
  /** As transcribed: names can be misheard. */
  attendees: string[];
  text: string;
}

export class MinutesSource {
  readonly name = 'minutes';
  private readonly notes: CallNotes[];

  constructor(notes?: CallNotes[]) {
    this.notes =
      notes ??
      readdirSync(new URL('minutes/', fixturesDir))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((file) => ({ file, ...readJson<Omit<CallNotes, 'file'>>(`minutes/${file}`) }));
  }

  /** Notes filed in the window. */
  filed(window: Window): Promise<CallNotes[]> {
    return Promise.resolve(this.notes.filter((n) => inWindow(n.filedAt, window)));
  }
}

// ---------- calendar ----------

export interface CalendarEntry {
  uid: string;
  summary: string;
  date: string;
  updated: string;
  by: string;
  note?: string;
}

export class CalendarSource {
  readonly name = 'calendar';
  constructor(private readonly data: { entries: CalendarEntry[] } = readJson<{ entries: CalendarEntry[] }>('calendar.json')) {}

  /** Entries created or changed in the window. */
  updates(window: Window): Promise<CalendarEntry[]> {
    return Promise.resolve(this.data.entries.filter((e) => inWindow(e.updated, window)));
  }
}

// ---------- the organiser's console and the schedule ----------

export type ConsoleAction =
  | { at: string; action: 'pencil'; person: string; event: string; asLead?: boolean }
  | { at: string; action: 'approve'; name: string }
  | { at: string; action: 'decline'; name: string }
  | { at: string; action: 'edit'; person: string; event: string; value: string; note?: string }
  | { at: string; action: 'approve_decision'; person: string; event: string; value: string }
  | { at: string; action: 'approve_event'; event: string; fields: Record<string, string | number | boolean | null> };

export function consoleActions(): ConsoleAction[] {
  return readJson<{ actions: ConsoleAction[] }>('console.json').actions;
}

export interface Schedule {
  firstDay: string;
  lastDay: string;
  skip: { at: string; why: string }[];
  faults: { source: string; at: string; kind: 'timeout' }[];
}

export function schedule(): Schedule {
  return readJson<Schedule>('schedule.json');
}

// ---------- fault injection ----------

/**
 * Makes a source hang at chosen times. The call returns a promise that never settles, as a real connector does when
 * it hangs, so only the caller's timeout can stop the run waiting on it.
 */
export class FaultPlan {
  private now = '';
  constructor(private readonly faults: { source: string; at: string }[] = []) {}

  setNow(now: string): void {
    this.now = now;
  }

  shouldHang(source: string): boolean {
    return this.faults.some((f) => f.source === source && compareInstants(f.at, this.now) === 0);
  }

  wrap<T>(source: string, call: () => Promise<T>): Promise<T> {
    if (this.shouldHang(source)) return new Promise<T>(() => undefined);
    return call();
  }
}

export interface FeedSources {
  chat: ChatSource;
  mail: MailSource;
  minutes: MinutesSource;
  calendar: CalendarSource;
  faults: FaultPlan;
}

export function feedSources(faults: FaultPlan = new FaultPlan(schedule().faults)): FeedSources {
  return { chat: new ChatSource(), mail: new MailSource(), minutes: new MinutesSource(), calendar: new CalendarSource(), faults };
}
