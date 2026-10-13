/**
 * Gathers a run's evidence from every source, each over its own window, and normalises it.
 *
 *   - Mail: the search listing can stop before a thread's newest reply, so every thread it returns is opened before
 *     anything is concluded from it.
 *   - Call notes: filed under whatever calendar slot the call fell in, with names misheard. They are matched to calls
 *     by time (a huddle that started within fifteen minutes), never by title.
 *   - A source that errors or hangs is recorded as unreadable and the run carries on with the others.
 */
import type { FeedSources, Window } from '@ghillie/feed';
import { compareInstants, type Person, type TrustConfig } from '@ghillie/engine';

export const sourceNames = ['chat', 'mail', 'minutes', 'calendar'] as const;
export type SourceName = (typeof sourceNames)[number];

export interface EvidenceItem {
  /** Stable across runs, so an overlapping window never reports the same thing twice. */
  id: string;
  source: SourceName;
  /** "chat #stewards", "mail", "call notes", "circuit calendar". */
  label: string;
  /** The person (by first name) if known, otherwise the name as the source gives it. Never an authority on its own. */
  who: string;
  /**
   * True only for a message from the organiser's configured sender id on her configured direct-message channel.
   * A display name, an email address or a name in the text never makes an item trusted.
   */
  trusted: boolean;
  /** When it was said. */
  at: string;
  text: string;
  /** Call notes: misheard names mapped to the person the call was with. */
  aliases?: Record<string, string>;
  calendar?: { eventId: string; date: string; by: string; note?: string };
}

export interface Gathered {
  items: EvidenceItem[];
  /** "ok" or the problem in a few words. */
  sources: Record<string, string>;
  /** For each source, the window asked for and how far it has now been read. */
  windows: Record<string, [string, string]>;
}

export class SourceTimeout extends Error {}

export function withTimeout<T>(work: Promise<T>, ms: number, source: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SourceTimeout(`${source} timed out after ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function personByFullName(people: Person[], name: string): Person | undefined {
  return people.find((p) => `${p.name} ${p.surname}`.toLowerCase() === name.trim().toLowerCase());
}

function personByEmail(people: Person[], email: string): Person | undefined {
  return people.find((p) => p.email && p.email.toLowerCase() === email.toLowerCase());
}

export interface GatherOptions {
  people: Person[];
  organiser: string;
  timeoutMs: number;
  trust: TrustConfig;
}

async function readChat(feed: FeedSources, window: Window, options: GatherOptions): Promise<EvidenceItem[]> {
  const messages = await feed.faults.wrap('chat', () => feed.chat.messages(window));
  const items: EvidenceItem[] = [];
  for (const message of messages) {
    const user = feed.chat.user(message.user);
    if (!user || user.real_name === 'Ghillie') continue; // its own messages are not evidence
    const channel = feed.chat.channel(message.channel);
    const trusted = message.user === options.trust.organiserChatUserId && message.channel === options.trust.organiserChannel;
    const person = personByFullName(options.people, user.real_name);
    const label = channel?.is_im ? 'chat DM' : options.trust.knownChannels.includes(message.channel) ? `chat #${message.channel}` : 'chat';
    items.push({
      id: `chat:${message.channel}:${message.ts}`,
      source: 'chat',
      label,
      who: trusted ? options.organiser : (person?.name ?? user.real_name),
      trusted,
      at: new Date(Math.round(Number(message.ts) * 1000)).toISOString(),
      text: message.text,
    });
  }
  return items;
}

async function readMail(feed: FeedSources, window: Window, options: GatherOptions): Promise<EvidenceItem[]> {
  const listings = await feed.faults.wrap('mail', () => feed.mail.search(window));
  const items: EvidenceItem[] = [];
  for (const listing of listings) {
    // Never trust the listing: open the thread, or a reply in an old thread looks absent.
    const thread = await feed.faults.wrap('mail', () => feed.mail.getThread(listing.threadId, window.to));
    if (!thread) continue;
    for (const message of thread.messages) {
      if (!(compareInstants(message.date, window.from) > 0 && compareInstants(message.date, window.to) <= 0)) continue;
      const person = personByEmail(options.people, message.from);
      items.push({
        id: `mail:${message.id}`,
        source: 'mail',
        label: 'mail',
        // A From address can be forged: mail is never the organiser's own channel.
        who: person?.name ?? message.from,
        trusted: false,
        at: message.date,
        text: message.body,
      });
    }
  }
  return items;
}

async function readMinutes(feed: FeedSources, window: Window, options: GatherOptions): Promise<EvidenceItem[]> {
  const notes = await feed.faults.wrap('minutes', () => feed.minutes.filed(window));
  const items: EvidenceItem[] = [];
  for (const note of notes) {
    const aliases: Record<string, string> = {};
    const attendees: string[] = [];
    const unknown: string[] = [];
    for (const name of note.attendees) {
      const person = personByFullName(options.people, name);
      if (person) attendees.push(person.name);
      else unknown.push(name);
    }
    if (unknown.length) {
      // Match the call by time, not title: who was in a huddle that started within fifteen minutes of it?
      for (const huddle of feed.chat.huddlesAround(note.callAt, 15)) {
        for (const member of huddle.members) {
          const user = feed.chat.user(member);
          const person = user ? personByFullName(options.people, user.real_name) : undefined;
          if (!person || attendees.includes(person.name)) continue;
          const misheard = unknown.shift();
          if (!misheard) break;
          aliases[misheard.split(' ')[0] ?? misheard] = person.name;
          attendees.push(person.name);
        }
      }
    }
    const other = attendees.find((name) => name !== options.organiser);
    items.push({
      id: `minutes:${note.file}`,
      source: 'minutes',
      label: 'call notes',
      // Attendee names are transcriptions: call notes never carry the organiser's authority.
      who: other ?? (unknown.length ? unknown.join(', ') : options.organiser),
      trusted: false,
      at: note.callAt,
      text: note.text,
      aliases,
    });
  }
  return items;
}

async function readCalendar(feed: FeedSources, window: Window): Promise<EvidenceItem[]> {
  const entries = await feed.faults.wrap('calendar', () => feed.calendar.updates(window));
  return entries.map((entry) => ({
    id: `calendar:${entry.uid}:${entry.updated}`,
    source: 'calendar' as const,
    label: 'circuit calendar',
    who: entry.by,
    trusted: false,
    at: entry.updated,
    text: `${entry.summary} on ${entry.date}${entry.note ? `. ${entry.note}` : ''}`,
    calendar: { eventId: entry.uid, date: entry.date, by: entry.by, ...(entry.note ? { note: entry.note } : {}) },
  }));
}

export async function gather(feed: FeedSources, windows: Record<SourceName, Window>, options: GatherOptions): Promise<Gathered> {
  const readers: Record<SourceName, () => Promise<EvidenceItem[]>> = {
    chat: () => readChat(feed, windows.chat, options),
    mail: () => readMail(feed, windows.mail, options),
    minutes: () => readMinutes(feed, windows.minutes, options),
    calendar: () => readCalendar(feed, windows.calendar),
  };
  const items: EvidenceItem[] = [];
  const sources: Record<string, string> = {};
  const read: Record<string, [string, string]> = {};
  for (const name of sourceNames) {
    try {
      items.push(...(await withTimeout(readers[name](), options.timeoutMs, name)));
      sources[name] = 'ok';
      read[name] = [windows[name].from, windows[name].to];
    } catch (error) {
      sources[name] = error instanceof SourceTimeout ? `timed out after ${options.timeoutMs} ms` : `error: ${error instanceof Error ? error.message : String(error)}`;
      // Not read: the next run starts this source from where it last worked.
      read[name] = [windows[name].from, windows[name].from];
    }
  }
  items.sort((a, b) => compareInstants(a.at, b.at) || a.id.localeCompare(b.id));
  return { items, sources, windows: read };
}
