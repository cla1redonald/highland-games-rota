/**
 * The status model. These lists are the only values the store accepts; anything else is refused.
 */
export const personStatuses = ['In', 'Maybe', 'Leadership', 'Pipeline', 'Out'] as const;
export type PersonStatus = (typeof personStatuses)[number];

/** People who are counted, chased and given an availability row. Leadership, Pipeline and Out are not. */
export const onBenchStatuses: readonly PersonStatus[] = ['In', 'Maybe'];

export const answers = ['Yes', 'Maybe', 'No', 'Unknown'] as const;
export type Answer = (typeof answers)[number];

export const decisions = ['Stewarding', 'Supporting', 'Watching', 'Not going'] as const;
export type Decision = (typeof decisions)[number];

/** Decisions that put someone on the ground: nobody can hold two of these on one Saturday. */
export const onSiteDecisions: readonly Decision[] = ['Stewarding', 'Supporting'];

/** A blank cell means "not asked". */
export type CellValue = Answer | Decision | '';

export const eventTypes = ['Games', 'Setup day', 'Superseded'] as const;
export type EventType = (typeof eventTypes)[number];

export type Mode = 'tuning' | 'full';

export interface Person {
  /** First name, the key. */
  name: string;
  surname: string;
  status: PersonStatus;
  /** What they usually do on the day, for display only. */
  role: string;
  email: string;
  /** The history of what they said about their dates, appended, never replaced. */
  note: string;
  risk: string;
  /** The next action, who and by when, in about ten words. Replaced, never appended. */
  nextStep: string;
  lastChecked: string;
  /** Set by the organiser: never marked new. */
  stewardedBefore: boolean;
  pronouns: string;
}

export interface GamesEvent {
  /** Stable key. Never changes, even when the organiser renames the event. */
  id: string;
  label: string;
  type: EventType;
  village: string;
  /** The Saturday for games, the Friday for a setup day (YYYY-MM-DD). */
  date: string;
  arenas: string[];
  /** Overrides arenas x stewards per arena when set. */
  target: number | null;
  confirmed: boolean;
  /** Appended, never replaced. */
  notes: string;
}

export interface Cell {
  person: string;
  event: string;
  value: CellValue;
  note: string;
  /** The organiser's provisional rota: placed first in the plan, never a booking. */
  pencilled: boolean;
  pencilledAsLead: boolean;
  /** Worked out from what someone said about other dates. Not an answer and never reported as one. */
  inferred: boolean;
}

export type LogEntity = 'cell' | 'person' | 'event' | 'run' | 'settings';

export interface LogEntry {
  seq: number;
  /** When the write happened. */
  writtenAt: string;
  /** Who made the write: agent, organiser (by hand), seed. */
  who: string;
  /** Whose statement the write rests on. */
  saidBy: string;
  entity: LogEntity;
  key: string;
  field: string;
  old: string;
  new: string;
  source: string;
  /** When the thing was said, as distinct from when it was written. */
  evidenceAt: string;
}

export interface Proposal {
  id: string;
  kind: 'add_person';
  name: string;
  why: string;
  source: string;
  evidenceAt: string;
  /** Who the evidence came from: the recruit, the organiser or someone else. */
  evidenceFrom: 'self' | 'organiser' | 'other';
  fingerprint: string;
  proposedAt: string;
}

export interface ApprovalRecord {
  seq: number;
  kind: 'grant' | 'use' | 'decline';
  fingerprint: string;
  proposalId: string;
  /** For a use or a decline: the grant it closes. */
  ref: number;
  by: string;
  at: string;
  action: string;
}

export interface TraceRecord {
  seq: number;
  at: string;
  tool: string;
  ok: boolean;
  outcome: string;
  durationMs: number;
  argsDigest: string;
}

export interface OutboxMessage {
  seq: number;
  at: string;
  to: string;
  text: string;
}

export function isAnswer(value: string): value is Answer {
  return (answers as readonly string[]).includes(value);
}

export function isDecision(value: string): value is Decision {
  return (decisions as readonly string[]).includes(value);
}

export function isPersonStatus(value: string): value is PersonStatus {
  return (personStatuses as readonly string[]).includes(value);
}

export function isEventType(value: string): value is EventType {
  return (eventTypes as readonly string[]).includes(value);
}
