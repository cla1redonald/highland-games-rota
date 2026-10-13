/**
 * What the harness works out before the model sees anything: the windows, the evidence, and the facts about each
 * item that are the harness's to know and not the model's to guess.
 *
 *   - Which items came from the organiser's own channel (`trusted`): decided by the feed adapters from her configured
 *     sender id and channel, never from a name in the text.
 *   - Which items an earlier run already read (`alreadyRead`), from the digests the store keeps.
 *   - The date words in each item that the engine's closed grammar accepts, written as the engine writes them, so the
 *     model can quote them exactly and a reason never passes as a date.
 *   - The run log's window, sources and evidence digests, ready for log_run.
 *
 * The same tick input goes to all three builds.
 */
import {
  compareInstants,
  config as defaultConfig,
  digest,
  footprint,
  londonDate,
  minusMinutes,
  parseDateParts,
  type GhillieConfig,
  type RotaView,
} from '@ghillie/engine';
import type { FeedSources, Window } from '@ghillie/feed';
import { gather, sourceNames, type EvidenceItem, type Gathered, type SourceName } from '@ghillie/stand-in';

export interface TickItem {
  /** A short reference for this tick only: e1, e2... */
  ref: string;
  source: EvidenceItem['source'];
  label: string;
  who: string;
  trusted: boolean;
  at: string;
  alreadyRead: boolean;
  dateWords: string[];
  text: string;
  aliases?: Record<string, string>;
  calendar?: EvidenceItem['calendar'];
}

export interface LogRunDraft {
  window: [string, string];
  sources: Record<string, string>;
  sourceWindows: Record<string, [string, string]>;
  read: string[];
}

export interface TickInput {
  now: string;
  today: string;
  organiser: string;
  windowStart: string;
  items: TickItem[];
  sources: Record<string, string>;
  logRun: LogRunDraft;
}

/** Each source starts an hour before where it was last read, so a source that failed is read again in full. */
export function tickWindows(view: RotaView, now: string, override?: Window, settings: GhillieConfig = defaultConfig): Record<SourceName, Window> {
  const previous = view.lastRun?.summary ?? null;
  const windows = {} as Record<SourceName, Window>;
  const lookback = new Date(new Date(now).getTime() - settings.rules.firstRunLookbackDays * 86_400_000).toISOString();
  for (const name of sourceNames) {
    const lastEnd = previous?.sourceWindows[name]?.[1];
    const from = override?.from ?? (lastEnd ? minusMinutes(lastEnd, settings.rules.windowOverlapMinutes) : lookback);
    windows[name] = { from, to: override?.to ?? now };
  }
  return windows;
}

/** Reads every source through the feed adapters, as the stand-in does. */
export async function gatherTick(feed: FeedSources, view: RotaView, now: string, options: { window?: Window; timeoutMs?: number; settings?: GhillieConfig } = {}): Promise<Gathered> {
  const settings = options.settings ?? defaultConfig;
  feed.faults.setNow(now);
  const windows = tickWindows(view, now, options.window, settings);
  return gather(feed, windows, { people: view.people, organiser: view.organiser, timeoutMs: options.timeoutMs ?? 2000, trust: settings.trust });
}

export function prepareTick(view: RotaView, gathered: Gathered, now: string, options: { window?: Window; settings?: GhillieConfig } = {}): TickInput {
  const settings = options.settings ?? defaultConfig;
  const windows = tickWindows(view, now, options.window, settings);
  const previous = view.lastRun?.summary ?? null;
  const sourceWindows: Record<string, [string, string]> = {};
  for (const name of Object.keys(gathered.sources)) {
    const window = windows[name as SourceName] ?? { from: now, to: now };
    const lastEnd = previous?.sourceWindows[name]?.[1] ?? window.from;
    sourceWindows[name] = gathered.sources[name] === 'ok' ? [window.from, window.to] : [window.from, lastEnd];
  }
  const windowStart = Object.values(windows).reduce((min, w) => (compareInstants(w.from, min) < 0 ? w.from : min), now);
  const seen = new Set(view.seenEvidence);
  const today = londonDate(now);
  const liveEvents = view.events.filter((e) => e.type !== 'Superseded' && footprint(e).end >= today);

  const items = gathered.items.map((item, i): TickItem => {
    const words = item.source === 'calendar' ? [] : [...new Set(parseDateParts(item.text, liveEvents, londonDate(item.at)).map((p) => p.words))];
    return {
      ref: `e${i + 1}`,
      source: item.source,
      label: item.label,
      who: item.who,
      trusted: item.trusted,
      at: item.at,
      alreadyRead: seen.has(digest(item.id)),
      dateWords: words,
      text: item.text,
      ...(item.aliases && Object.keys(item.aliases).length ? { aliases: item.aliases } : {}),
      ...(item.calendar ? { calendar: item.calendar } : {}),
    };
  });

  return {
    now,
    today,
    organiser: view.organiser,
    windowStart,
    items,
    sources: gathered.sources,
    logRun: { window: [windowStart, now], sources: gathered.sources, sourceWindows, read: gathered.items.map((i) => digest(i.id)) },
  };
}

/** When the organiser's trusted items were said: for anything that needs to know which evidence carries her word. */
export function trustedTimes(tick: TickInput): string[] {
  return tick.items.filter((i) => i.trusted).map((i) => i.at);
}
