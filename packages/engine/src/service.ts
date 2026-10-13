/**
 * The service layer: the only way anything but the organiser writes to the rota.
 *
 * The service validates; the caller never decides. Every rule that must hold whatever the caller believes or claims
 * lives here, not in a prompt:
 *
 *   Authority
 *   - No caller-supplied name, flag or mode grants anything. Decisions, event changes, status changes and adding a
 *     person need an approval record created on the organiser's own path (the console), bound to a fingerprint of the
 *     exact action, used once, and marked used in the same transaction as the write.
 *   - Tuning mode comes from the store, never from the caller: decisions are refused in it.
 *   - The write cap counts every attempted write since the last run was logged, refused ones included.
 *
 *   Evidence
 *   - Every write carries a known source label and the time the thing was said, with its offset, not in the future.
 *   - Every write is refused when the log already holds a newer entry for that field, however late it arrives.
 *   - A repeated write is a no-op, so overlapping windows and replays are safe.
 *
 *   Text
 *   - No free text from a source is ever stored, logged or sent. Callers give structured fields; the service writes
 *     the words. Date words must pass an allow-list grammar. A keyword privacy filter backs this up.
 *   - One place at a time; a fixed allow-list of fields; no deletes; the only message goes to the organiser, who is
 *     fixed in configuration.
 *
 * `saidBy` on evidence is provenance only: whose statement an answer rests on, recorded in the log. It must be someone
 * the rota knows, and it authorises nothing.
 */
import { config as defaultConfig, type GhillieConfig } from './config.js';
import { planRota, type RotaPlan } from './coverage.js';
import { compareInstants, formatDay, isValidInstant, londonDate } from './dates.js';
import { detectChanges, exceptionSchema, logSourceLabels, renderException, snapshotOf, type RotaException } from './exceptions.js';
import { authorise } from './authority.js';
import { tuningWrites } from './grants.js';
import { addPersonAction, canonicalJson, fingerprint, normaliseName } from './fingerprint.js';
import { readingSchema, renderMessage, type Reading } from './message.js';
import { checkMessageText, checkRotaText, countBullets, emDash } from './privacy.js';
import { cellKey, type Store } from './store.js';
import { runInputSchema, runSummarySchema, type RunSummary } from './summary.js';
import {
  isAnswer,
  isDecision,
  isPersonStatus,
  onBenchStatuses,
  onSiteDecisions,
  type ApprovalRecord,
  type Cell,
  type CellValue,
  type GamesEvent,
  type LogEntity,
  type LogEntry,
  type Mode,
  type Person,
  type Proposal,
} from './types.js';
import {
  bases,
  cellNote,
  checkDateWords,
  nextStepSchema,
  nextStepText,
  recruitNamePattern,
  recruitWhy,
  isKnownSourceLabel,
  statementLine,
  statementSchema,
  type Basis,
  type NextStep,
  type Statement,
} from './words.js';

export type RefusalCode =
  | 'source_required'
  | 'evidence_time_required'
  | 'evidence_in_future'
  | 'said_by_unknown'
  | 'unknown_person'
  | 'unknown_event'
  | 'not_on_bench'
  | 'event_superseded'
  | 'invalid_value'
  | 'invalid_date_words'
  | 'newer_entry'
  | 'double_booked'
  | 'decision_needs_full_mode'
  | 'approval_missing'
  | 'field_not_allowed'
  | 'rename_not_allowed'
  | 'next_step_too_long'
  | 'private_detail'
  | 'secret_detected'
  | 'write_limit'
  | 'person_exists'
  | 'already_proposed'
  | 'organiser_declined'
  | 'em_dash'
  | 'too_many_bullets'
  | 'empty_message'
  | 'invalid_message'
  | 'invalid_summary';

export interface Refusal {
  ok: false;
  refusal: RefusalCode;
  detail: string;
  latest?: { evidenceAt: string; saidBy: string; value: string };
  clashesWith?: string;
}

export interface EvidenceInput {
  /** A known source label: "chat #stewards", "chat DM", "mail", "call notes", "circuit calendar". */
  source: string;
  /** When it was said, ISO 8601 with offset. */
  evidenceAt: string;
}

export interface Provenance extends EvidenceInput {
  /** Whose statement this rests on. Recorded, never used to authorise. Must be someone the rota knows. */
  saidBy: string;
}

export interface CellWriteOk {
  ok: true;
  changed: boolean;
  person: string;
  event: string;
  old: CellValue;
  value: CellValue;
  noteUpdated?: boolean;
}

export type CellWriteResult = CellWriteOk | Refusal;

export interface FieldChange {
  field: string;
  old: string;
  value: string;
}

export interface FieldSkip {
  field: string;
  refusal: RefusalCode;
  detail: string;
}

export interface PersonWriteOk {
  ok: true;
  person: string;
  added: boolean;
  changed: FieldChange[];
  skipped: FieldSkip[];
}

export type PersonWriteResult = PersonWriteOk | Refusal;

export interface EventWriteOk {
  ok: true;
  event: string;
  changed: FieldChange[];
  skipped: FieldSkip[];
  /** When the event moved: everyone's previous value, so the organiser knows who to ask again. */
  reset: { person: string; previous: CellValue }[];
}

export type EventWriteResult = EventWriteOk | Refusal;

export interface ProposalOk {
  ok: true;
  proposalId: string;
  fingerprint: string;
}

export type ProposalResult = ProposalOk | Refusal;

export type ProposalStatus = 'pending' | 'approved' | 'added' | 'declined';

export interface ProposalView extends Proposal {
  status: ProposalStatus;
  approvedAt: string | null;
}

export interface GrantView {
  seq: number;
  action: Record<string, unknown>;
  by: string;
  at: string;
  status: 'ready' | 'used' | 'declined';
}

export interface PersonFields {
  statement?: Statement;
  nextStep?: NextStep;
  lastChecked?: string;
  status?: string;
}

export interface EventFields {
  date?: string;
  confirmed?: boolean;
  target?: number | null;
  type?: string;
}

export interface RotaView {
  now: string;
  today: string;
  mode: Mode;
  organiser: string;
  chiefStewards: string[];
  partnerNominees: string[];
  people: Person[];
  events: GamesEvent[];
  cells: ReturnType<Store['cells']>;
  plan: RotaPlan;
  lastRun: { seq: number; loggedAt: string; summary: RunSummary } | null;
  proposals: ProposalView[];
  /** Approvals the organiser granted on her own path: what the agent may now do, once each. */
  grants: GrantView[];
  logSinceLastRun: LogEntry[];
  /** Evidence ids read by runs in the last fortnight, so an overlapping or repeated window is never reported twice. */
  seenEvidence: string[];
  attemptsThisRun: number;
  /** What changed since the last run, by the engine's own comparison. Pass these through to message_organiser. */
  changes: RotaException[];
}

const personFieldNames = ['statement', 'nextStep', 'lastChecked', 'status'] as const;
const eventFieldNames = ['date', 'confirmed', 'target', 'type'] as const;
const firstName = /^[A-Z][a-z'-]{1,20}$/;

function refuse(refusal: RefusalCode, detail: string, extra: Partial<Refusal> = {}): Refusal {
  return { ok: false, refusal, detail, ...extra };
}

function outcomeOf(result: { ok: boolean } & Record<string, unknown>): string {
  if (!result.ok) return typeof result.refusal === 'string' ? result.refusal : 'refused';
  if (result.added === true || result.changed === true) return 'changed';
  if (Array.isArray(result.changed)) return result.changed.length || (Array.isArray(result.reset) && result.reset.length) ? 'changed' : 'unchanged';
  if (typeof result.proposalId === 'string') return 'proposed';
  return result.noteUpdated ? 'changed' : 'unchanged';
}


export interface ServiceOptions {
  store: Store;
  clock: () => Date;
  config?: GhillieConfig;
}

export class RotaService {
  readonly store: Store;
  readonly config: GhillieConfig;
  private readonly clock: () => Date;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.config = options.config ?? defaultConfig;
  }

  now(): string {
    return this.clock().toISOString();
  }

  /** Fixed in configuration at startup. No tool can name anyone else. */
  get organiser(): string {
    return this.config.roles.organiser;
  }

  // ---------- reading ----------

  read(): RotaView {
    const now = this.now();
    const today = londonDate(now);
    const people = this.store.people();
    const events = this.store.events();
    const cells = this.store.cells();
    const plan = planRota(people, events, cells, today, { rules: this.config.rules, roles: this.config.roles });
    const runs = this.store.runs();
    const last = runs.at(-1);
    let lastRun: RotaView['lastRun'] = null;
    if (last) {
      const parsed = runSummarySchema.safeParse(JSON.parse(last.summary));
      if (parsed.success) lastRun = { seq: last.seq, loggedAt: last.loggedAt, summary: parsed.data };
    }
    const log = this.store.log(this.store.lastRunLogSeq());
    const fortnightAgo = new Date(this.clock().getTime() - 14 * 86_400_000).toISOString();
    const seen = new Set<string>();
    for (const run of runs) {
      const parsed = runSummarySchema.safeParse(JSON.parse(run.summary));
      if (parsed.success && compareInstants(parsed.data.window[1], fortnightAgo) >= 0) for (const id of parsed.data.read) seen.add(id);
    }
    return {
      now,
      today,
      mode: this.store.getMode(),
      organiser: this.organiser,
      chiefStewards: this.config.roles.chiefStewards,
      partnerNominees: this.config.roles.partnerNominees,
      people,
      events,
      cells,
      plan,
      lastRun,
      proposals: this.proposalViews(),
      grants: this.grantViews(),
      logSinceLastRun: log,
      seenEvidence: [...seen],
      attemptsThisRun: this.store.attemptsSinceLastRun(),
      changes: this.changesSinceLastRun(plan, events, cells, log, lastRun?.summary ?? null),
    };
  }

  /**
   * What changed since the last run, worked out by the engine: the same comparison the stand-in makes. It is in the
   * read so that no agent has to redo coverage arithmetic from the plan; an agent adds what only reading the evidence
   * can find (vague words, proposals, unmatched names) and passes these through.
   */
  private changesSinceLastRun(plan: RotaPlan, events: GamesEvent[], cells: Cell[], log: LogEntry[], previous: RunSummary | null): RotaException[] {
    const lookaheadWeeks = this.config.rules.lookaheadWeeks;
    const snapshot = snapshotOf(plan, events, cells, lookaheadWeeks);
    const changes = detectChanges(previous?.snapshot ?? null, snapshot, { plan, events, cells, log, organiser: this.organiser, lookaheadWeeks });
    if (this.store.getMode() === 'tuning') {
      const writes = tuningWrites(log);
      if (writes.count) changes.push({ type: 'tuning_write', count: writes.count, writes: writes.examples });
    }
    return changes;
  }

  proposalViews(): ProposalView[] {
    const approvals = this.store.approvals();
    return this.store.proposals().map((proposal) => {
      const mine = approvals.filter((a) => a.proposalId === proposal.id);
      const grant = mine.find((a) => a.kind === 'grant');
      let status: ProposalStatus = 'pending';
      if (mine.some((a) => a.kind === 'decline')) status = 'declined';
      else if (mine.some((a) => a.kind === 'use')) status = 'added';
      else if (grant) status = 'approved';
      return { ...proposal, status, approvedAt: grant ? grant.at : null };
    });
  }

  grantViews(): GrantView[] {
    const records = this.store.approvals();
    return records
      .filter((r) => r.kind === 'grant')
      .map((grant) => {
        const closing = records.find((r) => r.kind !== 'grant' && r.ref === grant.seq);
        return {
          seq: grant.seq,
          action: JSON.parse(grant.action) as Record<string, unknown>,
          by: grant.by,
          at: grant.at,
          status: closing ? (closing.kind === 'use' ? 'used' : 'declined') : 'ready',
        };
      });
  }

  // ---------- shared checks ----------

  /**
   * What an attempt row records about its target: a known person, event or cell, or a valid recruit name. Anything
   * else a caller sent is recorded as "[not recognised]", so no argument reaches the store unchecked.
   */
  private safeTarget(target: string): string {
    const people = new Set(this.store.people().map((p) => p.name));
    const events = new Set(this.store.events().map((e) => e.id));
    const [person = '', event] = target.split('::');
    if (event !== undefined) return people.has(person) && events.has(event) ? target : '[not recognised]';
    if (people.has(target) || events.has(target) || recruitNamePattern.test(target)) return target;
    return '[not recognised]';
  }

  /** Counts the attempt whatever its outcome, and refuses once the run has made too many. */
  private attempt<T extends { ok: boolean }>(tool: string, rawTarget: string, work: () => T | Refusal): T | Refusal {
    const target = this.safeTarget(rawTarget);
    const limit = this.config.rules.maxWritesPerRun;
    const result: T | Refusal =
      this.store.attemptsSinceLastRun() >= limit
        ? refuse('write_limit', `stopped after ${limit} write attempts in this run: something is probably wrong`)
        : work();
    this.store.appendAttempt(this.now(), tool, target, outcomeOf(result as { ok: boolean } & Record<string, unknown>));
    return result;
  }

  private checkEvidence(input: EvidenceInput): Refusal | null {
    if (!input.source || !isKnownSourceLabel(input.source, this.config.trust.knownChannels)) {
      return refuse('source_required', 'every write needs a known source label (chat #channel, chat DM, mail, call notes, circuit calendar)');
    }
    if (!input.evidenceAt || !isValidInstant(input.evidenceAt)) {
      return refuse('evidence_time_required', 'every write needs the time the thing was said, with its offset');
    }
    if (compareInstants(input.evidenceAt, this.now()) > 0) return refuse('evidence_in_future', `evidence time ${input.evidenceAt} is after now`);
    return null;
  }

  private checkSaidBy(saidBy: string, extra: string[] = []): Refusal | null {
    const known = new Set([...this.store.people().map((p) => p.name), 'Ghillie', ...this.config.roles.eventAuthorities, ...extra]);
    return known.has(saidBy) ? null : refuse('said_by_unknown', 'the speaker is not someone the rota knows');
  }

  private newerThan(entity: LogEntity, key: string, field: string, evidenceAt: string): Refusal | null {
    const latest = this.store.latestFor(entity, key, field);
    if (!latest) return null;
    const latestAt = latest.evidenceAt || latest.writtenAt;
    if (compareInstants(latestAt, evidenceAt) > 0) {
      return refuse('newer_entry', `the log holds a newer entry for ${field} (${latestAt})`, {
        latest: { evidenceAt: latestAt, saidBy: latest.saidBy || latest.who, value: latest.new },
      });
    }
    return null;
  }

  /** Defence in depth: the service composed this text, but it is checked anyway before it is stored. */
  private checkComposed(text: string): Refusal | null {
    if (text.includes(emDash)) return refuse('em_dash', 'no em dashes');
    const check = checkRotaText(text);
    if (!check.ok) return refuse(check.reason, 'refused by the privacy check');
    return null;
  }

  private checkWords(words: string[]): Refusal | null {
    const check = checkDateWords(words, this.store.events(), londonDate(this.now()));
    return check.ok ? null : refuse('invalid_date_words', 'date words must be dates and event names only, never a reason');
  }

  private logWrite(entity: LogEntity, key: string, field: string, old: string, value: string, input: EvidenceInput, saidBy: string): void {
    this.store.appendLog({ writtenAt: this.now(), who: 'agent', saidBy, entity, key, field, old, new: value, source: input.source, evidenceAt: input.evidenceAt });
  }

  private benchPerson(name: string): Person | Refusal {
    const person = this.store.person(name);
    if (!person) return refuse('unknown_person', 'nobody by that name on the rota');
    if (!onBenchStatuses.includes(person.status)) {
      return refuse('not_on_bench', `${name} is ${person.status}: no availability row (record a statement in their note instead)`);
    }
    return person;
  }

  private liveEvent(id: string): GamesEvent | Refusal {
    const event = this.store.event(id);
    if (!event) return refuse('unknown_event', 'no such event');
    if (event.type === 'Superseded') return refuse('event_superseded', `${event.label} is superseded`);
    return event;
  }

  private useGrant(grant: ApprovalRecord): void {
    this.store.appendApproval({
      kind: 'use',
      fingerprint: grant.fingerprint,
      proposalId: grant.proposalId,
      ref: grant.seq,
      by: 'agent',
      at: this.now(),
      action: grant.action,
    });
  }

  private eventNames(): Map<string, string> {
    return new Map(this.store.events().map((e) => [e.id, e.type === 'Setup day' ? 'Setup day' : e.village]));
  }

  // ---------- availability ----------

  setAvailability(input: Provenance & { person: string; event: string; value: string; basis?: string; dateWords?: string[] }): CellWriteResult {
    return this.store.transaction(() =>
      this.attempt('set_availability', cellKey(input.person, input.event), (): CellWriteResult => {
        const bad = this.checkEvidence(input) ?? this.checkSaidBy(input.saidBy);
        if (bad) return bad;
        if (!isAnswer(input.value)) return refuse('invalid_value', 'not an answer (Yes, Maybe, No, Unknown)');
        const basis = (input.basis ?? 'answer') as Basis;
        if (!(bases as readonly string[]).includes(basis)) return refuse('invalid_value', 'not a basis');
        const words = input.dateWords ?? [];
        const badWords = this.checkWords(words);
        if (badWords) return badWords;
        if ((basis === 'vague' || basis === 'request') && !words.length) return refuse('invalid_date_words', `a ${basis} answer quotes its date words`);
        const person = this.benchPerson(input.person);
        if ('refusal' in person) return person;
        const event = this.liveEvent(input.event);
        if ('refusal' in event) return event;
        const note = cellNote(basis, words, input.source);
        const composedBad = this.checkComposed(note);
        if (composedBad) return composedBad;

        const key = cellKey(input.person, input.event);
        const newer = this.newerThan('cell', key, 'value', input.evidenceAt);
        if (newer) return newer;
        const cell = this.store.cell(input.person, input.event);
        const same = { ok: true as const, changed: false, person: input.person, event: input.event, old: cell.value, value: cell.value };
        // A Yes from someone already booked confirms the booking; it never downgrades it to availability.
        if (input.value === 'Yes' && (onSiteDecisions as readonly string[]).includes(cell.value)) return same;
        if (cell.value === input.value) {
          if (note === cell.note) return same;
          const newerNote = this.newerThan('cell', key, 'note', input.evidenceAt);
          if (newerNote) return newerNote;
          this.store.putCell({ ...cell, note });
          this.logWrite('cell', key, 'note', cell.note, note, input, input.saidBy);
          return { ...same, noteUpdated: true };
        }
        this.store.putCell({ ...cell, value: input.value, note, inferred: false });
        this.logWrite('cell', key, 'value', cell.value, input.value, input, input.saidBy);
        if (note !== cell.note) this.logWrite('cell', key, 'note', cell.note, note, input, input.saidBy);
        return { ok: true, changed: true, person: input.person, event: input.event, old: cell.value, value: input.value };
      }),
    );
  }

  // ---------- decisions: only with the organiser's approval of that exact decision ----------

  setDecision(input: EvidenceInput & { person: string; event: string; value: string }): CellWriteResult {
    return this.store.transaction(() =>
      this.attempt('set_decision', cellKey(input.person, input.event), (): CellWriteResult => {
        const bad = this.checkEvidence(input);
        if (bad) return bad;
        if (!isDecision(input.value)) return refuse('invalid_value', 'not a decision');
        // Mode first, as before: the same predicate answers again below, with the grant.
        if (this.store.getMode() !== 'full') return refuse('decision_needs_full_mode', 'tuning mode: propose the decision to the organiser instead');
        const person = this.benchPerson(input.person);
        if ('refusal' in person) return person;
        const event = this.liveEvent(input.event);
        if ('refusal' in event) return event;
        const authority = authorise(this.store, { kind: 'set_decision', person: input.person, event: input.event, value: input.value }, this.organiser);
        if (!authority.ok) return refuse(authority.refusal, authority.detail);
        if (authority.noop) {
          const current = this.store.cell(input.person, input.event);
          return { ok: true, changed: false, person: input.person, event: input.event, old: current.value, value: current.value };
        }
        const grant = authority.grant;
        if ((onSiteDecisions as readonly string[]).includes(input.value)) {
          const clash = this.store
            .events()
            .find(
              (other) =>
                other.id !== event.id &&
                other.type === 'Games' &&
                other.date === event.date &&
                (onSiteDecisions as readonly string[]).includes(this.store.cell(input.person, other.id).value),
            );
          if (clash) return refuse('double_booked', `${input.person} is already on the ground at ${clash.label} that Saturday`, { clashesWith: clash.id });
        }
        const key = cellKey(input.person, input.event);
        const newer = this.newerThan('cell', key, 'value', input.evidenceAt);
        if (newer) return newer;
        const cell = this.store.cell(input.person, input.event);
        this.useGrant(grant);
        if (cell.value === input.value) return { ok: true, changed: false, person: input.person, event: input.event, old: cell.value, value: cell.value };
        this.store.putCell({ ...cell, value: input.value, note: '', inferred: false });
        this.logWrite('cell', key, 'value', cell.value, input.value, input, grant.by);
        return { ok: true, changed: true, person: input.person, event: input.event, old: cell.value, value: input.value };
      }),
    );
  }

  // ---------- people ----------

  updatePerson(input: Provenance & { person: string; fields?: PersonFields; create?: { surname: string; status: string } }): PersonWriteResult {
    return this.store.transaction(() =>
      this.attempt('update_person', input.person, (): PersonWriteResult => {
        const bad = this.checkEvidence(input) ?? this.checkSaidBy(input.saidBy);
        if (bad) return bad;
        const fields = input.fields ?? {};
        const unknown = Object.keys(fields).filter((name) => !(personFieldNames as readonly string[]).includes(name));
        if (unknown.length) return refuse('field_not_allowed', `not writable: ${unknown.join(', ')}`);
        return input.create ? this.addPerson(input, input.create) : this.changePerson(input, fields);
      }),
    );
  }

  private addPerson(input: Provenance & { person: string }, create: { surname: string; status: string }): PersonWriteResult {
    if (!firstName.test(input.person) || !firstName.test(create.surname)) return refuse('invalid_value', 'a name is one capitalised word, and so is a surname');
    if (!isPersonStatus(create.status)) return refuse('invalid_value', 'not a status');
    if (this.store.person(input.person)) return refuse('person_exists', `${input.person} is already on the rota`);
    const fullName = `${input.person} ${create.surname}`;
    const authority = authorise(this.store, { kind: 'add_person', person: input.person, surname: create.surname, status: create.status }, this.organiser);
    if (!authority.ok) return refuse(authority.refusal, authority.detail);
    const grant = authority.grant;
    if (!grant) return refuse('approval_missing', `no approval from ${this.organiser} for adding ${fullName} as ${create.status}`);
    const proposal = this.store.proposals().find((p) => p.id === grant.proposalId);
    const person: Person = {
      name: input.person,
      surname: create.surname,
      status: create.status,
      role: '',
      email: '',
      note: proposal ? `${formatDay(londonDate(proposal.evidenceAt))}: suggested for the Pipeline (${proposal.source})` : '',
      risk: '',
      nextStep: `${this.organiser} to ask ${input.person} for dates if joining`,
      lastChecked: '',
      stewardedBefore: false,
      pronouns: '',
    };
    this.store.insertPerson(person);
    this.useGrant(grant);
    this.logWrite('person', input.person, 'added', '', canonicalJson({ surname: create.surname, status: create.status }), input, grant.by);
    return { ok: true, person: input.person, added: true, changed: [], skipped: [] };
  }

  private changePerson(input: Provenance & { person: string }, fields: PersonFields): PersonWriteResult {
    const person = this.store.person(input.person);
    if (!person) return refuse('unknown_person', 'nobody by that name on the rota');
    const names = this.eventNames();
    const changed: FieldChange[] = [];
    const skipped: FieldSkip[] = [];

    // Validate everything before writing anything: fail closed.
    let statementText: string | undefined;
    if (fields.statement) {
      const parsed = statementSchema.safeParse(fields.statement);
      if (!parsed.success) return refuse('invalid_value', 'a statement is a list of answers and date words');
      if (parsed.data.verdicts.some((v) => !names.has(v.event))) return refuse('unknown_event', 'a statement names an event the rota does not have');
      const badWords = this.checkWords(parsed.data.dateWords);
      if (badWords) return badWords;
      statementText = statementLine(parsed.data, input.evidenceAt, input.source, names);
    }
    let stepText: string | undefined;
    if (fields.nextStep) {
      const parsed = nextStepSchema.safeParse(fields.nextStep);
      if (!parsed.success) return refuse('invalid_value', 'a next step is an action from the list');
      if (!this.store.person(parsed.data.about)) return refuse('unknown_person', 'a next step about someone not on the rota');
      if ((parsed.data.events ?? []).some((e) => !names.has(e))) return refuse('unknown_event', 'a next step names an event the rota does not have');
      stepText = nextStepText(parsed.data, this.organiser, names);
      const words = stepText.split(/\s+/).filter(Boolean).length;
      if (words > this.config.rules.nextStepMaxWords) return refuse('next_step_too_long', `next step is ${words} words; keep it to about ten`);
    }
    if (fields.lastChecked !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fields.lastChecked)) return refuse('invalid_value', 'last checked is a date');
    if (fields.status !== undefined && !isPersonStatus(fields.status)) return refuse('invalid_value', 'not a status');
    for (const text of [statementText, stepText]) {
      const composedBad = text ? this.checkComposed(text) : null;
      if (composedBad) return composedBad;
    }

    const write = (field: 'note' | 'nextStep' | 'lastChecked' | 'status', old: string, next: string, saidBy: string): boolean => {
      // Every field, notes included, takes the newest word: older evidence is refused however late it arrives.
      const newer = this.newerThan('person', input.person, field, input.evidenceAt);
      if (newer) {
        skipped.push({ field, refusal: 'newer_entry', detail: newer.detail });
        return false;
      }
      if (old === next) return false;
      this.store.updatePersonField(input.person, field, next);
      this.logWrite('person', input.person, field, old, next, input, saidBy);
      changed.push({ field, old, value: next });
      return true;
    };

    if (statementText !== undefined && !person.note.split('\n').includes(statementText)) {
      write('note', person.note, person.note ? `${person.note}\n${statementText}` : statementText, input.saidBy);
    }
    if (stepText !== undefined) write('nextStep', person.nextStep, stepText, input.saidBy);
    // Last checked only moves forward, so replaying an old window never winds it back.
    if (fields.lastChecked !== undefined && !(person.lastChecked && fields.lastChecked <= person.lastChecked)) {
      write('lastChecked', person.lastChecked, fields.lastChecked, input.saidBy);
    }
    if (fields.status !== undefined && fields.status !== person.status) {
      const authority = authorise(this.store, { kind: 'set_status', person: input.person, status: fields.status }, this.organiser);
      if (!authority.ok || !authority.grant) skipped.push({ field: 'status', refusal: 'approval_missing', detail: `a status changes only with ${this.organiser}'s approval` });
      else if (write('status', person.status, fields.status, authority.grant.by)) this.useGrant(authority.grant);
    }
    return { ok: true, person: input.person, added: false, changed, skipped };
  }

  // ---------- events: only with the organiser's approval of that exact change ----------

  updateEvent(input: EvidenceInput & { event: string; fields: EventFields & { label?: string } }): EventWriteResult {
    return this.store.transaction(() =>
      this.attempt('update_event', input.event, (): EventWriteResult => {
        const bad = this.checkEvidence(input);
        if (bad) return bad;
        if ('label' in input.fields) return refuse('rename_not_allowed', `only ${this.organiser} renames an event`);
        const unknown = Object.keys(input.fields).filter((name) => !(eventFieldNames as readonly string[]).includes(name));
        if (unknown.length) return refuse('field_not_allowed', `not writable: ${unknown.join(', ')}`);
        const event = this.store.event(input.event);
        if (!event) return refuse('unknown_event', 'no such event');
        const { date, confirmed, target, type } = input.fields;
        if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse('invalid_value', 'a date is YYYY-MM-DD');
        if (date !== undefined && event.type === 'Games' && new Date(`${date}T12:00:00Z`).getUTCDay() !== 6) return refuse('invalid_value', 'games are on a Saturday');
        if (type !== undefined && type !== 'Games' && type !== 'Setup day' && type !== 'Superseded') return refuse('invalid_value', 'not an event type');
        if (target !== undefined && target !== null && (!Number.isInteger(target) || target < 0)) return refuse('invalid_value', 'a target is a whole number');

        const action: { [key: string]: string | number | boolean | null } = {};
        for (const name of eventFieldNames) if (input.fields[name] !== undefined) action[name] = input.fields[name] ?? null;
        const authority = authorise(this.store, { kind: 'update_event', event: event.id, fields: action }, this.organiser);
        if (!authority.ok) return refuse(authority.refusal, authority.detail);
        const grant = authority.grant;
        if (!grant) return refuse('approval_missing', `no approval from ${this.organiser} for this change to ${event.label}: raise it instead`);

        const changed: FieldChange[] = [];
        const skipped: FieldSkip[] = [];
        const reset: EventWriteOk['reset'] = [];
        const apply = (field: (typeof eventFieldNames)[number], old: string, next: string, write: () => void): boolean => {
          const newer = this.newerThan('event', event.id, field, input.evidenceAt);
          if (newer) {
            skipped.push({ field, refusal: 'newer_entry', detail: newer.detail });
            return false;
          }
          if (old === next) return false;
          write();
          this.logWrite('event', event.id, field, old, next, input, grant.by);
          changed.push({ field, old, value: next });
          return true;
        };

        if (date !== undefined) {
          const moved = apply('date', event.date, date, () => this.store.updateEventField(event.id, 'date', date));
          if (moved) {
            // The answers were for the old dates: reset every one, decisions and pencils included.
            for (const cell of this.store.cells().filter((c) => c.event === event.id && c.value !== '' && c.value !== 'Unknown')) {
              reset.push({ person: cell.person, previous: cell.value });
              this.store.putCell({ ...cell, value: 'Unknown', note: '', pencilled: false, pencilledAsLead: false, inferred: false });
              this.logWrite('cell', cellKey(cell.person, event.id), 'value', cell.value, 'Unknown', { ...input, source: 'event moved' }, grant.by);
            }
            if (confirmed === undefined && event.confirmed) {
              this.store.updateEventField(event.id, 'confirmed', false);
              this.logWrite('event', event.id, 'confirmed', 'true', 'false', input, grant.by);
              changed.push({ field: 'confirmed', old: 'true', value: 'false' });
            }
          }
        }
        if (confirmed !== undefined) apply('confirmed', String(event.confirmed), String(confirmed), () => this.store.updateEventField(event.id, 'confirmed', confirmed));
        if (target !== undefined) {
          apply('target', event.target === null ? '' : String(event.target), target === null ? '' : String(target), () =>
            this.store.updateEventField(event.id, 'target', target),
          );
        }
        if (type !== undefined) apply('type', event.type, type, () => this.store.updateEventField(event.id, 'type', type));
        this.useGrant(grant);
        return { ok: true, event: event.id, changed, skipped, reset };
      }),
    );
  }

  // ---------- recruits ----------

  proposeRecruit(input: Provenance & { name: string; suggestedBy: string; arena?: string; evidenceFrom: 'self' | 'organiser' | 'other' }): ProposalResult {
    return this.store.transaction(() =>
      this.attempt('propose_recruit', input.name, (): ProposalResult => {
        const bad = this.checkEvidence(input) ?? this.checkSaidBy(input.saidBy, recruitNamePattern.test(input.saidBy) ? [input.saidBy] : []);
        if (bad) return bad;
        // A recruit's name is the one piece of source text the rota keeps: two or three capitalised words, checked again.
        if (!recruitNamePattern.test(input.name) || !checkRotaText(input.name).ok) return refuse('invalid_value', 'a recruit is named by first name and surname');
        if (!this.store.person(input.suggestedBy) && input.suggestedBy !== input.name) return refuse('unknown_person', 'the suggester is not on the rota');
        const arenas = new Set(this.store.events().flatMap((e) => e.arenas.map((a) => a.toLowerCase())));
        if (input.arena !== undefined && !arenas.has(input.arena.toLowerCase())) return refuse('invalid_value', 'not an arena');
        const wanted = normaliseName(input.name);
        const existing = this.store.people().find((p) => normaliseName(`${p.name} ${p.surname}`) === wanted);
        if (existing) return refuse('person_exists', `${input.name} is already on the rota as ${existing.status}`);
        const views = this.proposalViews().filter((p) => normaliseName(p.name) === wanted);
        if (views.some((p) => p.status === 'declined')) return refuse('organiser_declined', `${this.organiser} turned ${input.name} down: never proposed again`);
        const latest = views.at(-1);
        if (latest) {
          // Raised again only on new evidence from the recruit or the organiser, newer than what was proposed before.
          const isNew = input.evidenceFrom !== 'other' && compareInstants(input.evidenceAt, latest.evidenceAt) > 0;
          if (!isNew) return refuse('already_proposed', `${input.name} was proposed on ${latest.proposedAt} with no new evidence since`);
        }
        const print = fingerprint(addPersonAction(input.name, 'Pipeline'));
        const id = `proposal-${this.store.proposals().length + 1}`;
        this.store.appendProposal({
          id,
          kind: 'add_person',
          name: input.name,
          why: recruitWhy(input.suggestedBy, input.arena),
          source: input.source,
          evidenceAt: input.evidenceAt,
          evidenceFrom: input.evidenceFrom,
          fingerprint: print,
          proposedAt: this.now(),
        });
        return { ok: true, proposalId: id, fingerprint: print };
      }),
    );
  }

  // ---------- the message ----------

  /** Validates structured exceptions and readings, writes the message itself, and sends it to the organiser. */
  messageOrganiser(input: { exceptions: unknown[]; readings: unknown[] }): { ok: true; seq: number; to: string; text: string } | Refusal {
    const exceptions: RotaException[] = [];
    const readings: Reading[] = [];
    const people = new Set(this.store.people().map((p) => p.name));
    const events = this.store.events();
    const eventIds = new Set(events.map((e) => e.id));
    for (const raw of input.exceptions) {
      const parsed = exceptionSchema.safeParse(raw);
      if (!parsed.success) return refuse('invalid_message', `an exception is not in the vocabulary: ${parsed.error.issues[0]?.message ?? ''}`);
      const problem = this.checkException(parsed.data, people, eventIds);
      if (problem) return problem;
      exceptions.push(parsed.data);
    }
    for (const raw of input.readings) {
      const parsed = readingSchema.safeParse(raw);
      if (!parsed.success) return refuse('invalid_message', 'a reading is a person, a source, a time, date words and answers');
      const reading = parsed.data;
      if (!people.has(reading.person)) return refuse('unknown_person', 'a reading about someone not on the rota');
      if (!isKnownSourceLabel(reading.source, this.config.trust.knownChannels)) return refuse('source_required', 'a reading needs a known source label');
      if (!isValidInstant(reading.at)) return refuse('evidence_time_required', 'a reading needs the time it was said');
      if (reading.verdicts.some((v) => !eventIds.has(v.event))) return refuse('unknown_event', 'a reading names an event the rota does not have');
      const badWords = this.checkWords(reading.dateWords);
      if (badWords) return badWords;
      readings.push(reading);
    }
    const text = renderMessage({
      exceptions,
      readings,
      context: { events, organiser: this.organiser },
      maxBullets: this.config.rules.maxBullets,
      planLink: this.config.planLink,
    });
    if (!text.trim()) return refuse('empty_message', 'no exceptions and no readings means no message');
    if (text.includes(emDash)) return refuse('em_dash', 'no em dashes in the message');
    const bullets = countBullets(text);
    if (bullets > this.config.rules.maxBullets) return refuse('too_many_bullets', `${bullets} bullets; at most ${this.config.rules.maxBullets}`);
    const check = checkMessageText(text);
    if (!check.ok) return refuse(check.reason, 'refused by the privacy check');
    const sent = this.store.appendOutbox(this.now(), this.organiser, text);
    return { ok: true, seq: sent.seq, to: this.organiser, text };
  }

  private checkException(e: RotaException, people: Set<string>, events: Set<string>): Refusal | null {
    const record = e as Record<string, unknown>;
    // Only an unmatched name, or a recruit, may be someone the rota does not know.
    const outsiderAllowed = e.type === 'unresolved' && e.reason === 'unmatched';
    for (const field of ['person', 'suggestedBy', 'requestedBy']) {
      const value = record[field];
      if (typeof value === 'string' && !people.has(value) && !outsiderAllowed) return refuse('unknown_person', 'an exception names someone not on the rota');
    }
    if (e.type === 'pipeline_suggestion' && e.verdicts && !people.has(e.name)) return refuse('unknown_person', 'an exception names someone not on the rota');
    const sources = [record.source, ...(e.type === 'red_or_delta_drop' ? e.causes.map((c) => c.source) : [])];
    for (const label of sources) {
      if (typeof label === 'string' && !isKnownSourceLabel(label, this.config.trust.knownChannels) && !logSourceLabels.includes(label)) {
        return refuse('source_required', 'an exception cites a source label the rota does not know');
      }
    }
    const ids: string[] = [];
    if (typeof record.event === 'string') ids.push(record.event);
    if (Array.isArray(record.events)) ids.push(...(record.events as string[]));
    if (e.type === 'red_or_delta_drop') ids.push(...e.causes.map((c) => c.event));
    if (e.type === 'tuning_write') ids.push(...e.writes.flatMap((w) => (w.event ? [w.event] : [])));
    if (e.type === 'pipeline_suggestion' && e.verdicts) ids.push(...e.verdicts.map((v) => v.event));
    if (ids.some((id) => !events.has(id))) return refuse('unknown_event', 'an exception names an event the rota does not have');
    if (e.type === 'unresolved' && e.dateWords) {
      const badWords = this.checkWords(e.dateWords);
      if (badWords) return badWords;
    }
    if (e.type === 'pipeline_suggestion' && e.arena !== undefined) {
      const arenas = new Set(this.store.events().flatMap((ev) => ev.arenas.map((a) => a.toLowerCase())));
      if (!arenas.has(e.arena.toLowerCase())) return refuse('invalid_value', 'not an arena');
    }
    for (const at of [record.at, ...(e.type === 'red_or_delta_drop' ? e.causes.map((c) => c.at) : [])]) {
      if (typeof at === 'string' && !isValidInstant(at)) return refuse('evidence_time_required', 'an exception time must carry its offset');
    }
    return null;
  }

  /** Renders an exception as it would appear in the message, for logs and dry runs. */
  describe(exception: RotaException): string {
    return renderException(exception, { events: this.store.events(), organiser: this.organiser });
  }

  // ---------- the run log: the service computes it ----------

  logRun(input: unknown): { ok: true; seq: number; summary: RunSummary } | Refusal {
    const parsed = runInputSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_summary', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    return this.store.transaction(() => {
      const view = this.read();
      const written = this.store.log(this.store.lastRunLogSeq()).filter((e) => e.who === 'agent' && e.entity !== 'run');
      const attempts = this.store.attemptsSinceLastRunList();
      const summary: RunSummary = {
        window: parsed.data.window,
        mode: view.mode,
        writes: written.length,
        refused: attempts.filter((a) => !['changed', 'unchanged', 'proposed'].includes(a.outcome)).length,
        exceptions: parsed.data.exceptions,
        messaged: this.store.outboxSinceLastRun() > 0,
        sources: parsed.data.sources,
        sourceWindows: parsed.data.sourceWindows,
        snapshot: snapshotOf(view.plan, view.events, view.cells, this.config.rules.lookaheadWeeks),
        pipelineProposed: attempts.filter((a) => a.tool === 'propose_recruit' && a.outcome === 'proposed').map((a) => a.target),
        read: parsed.data.read,
        toolCalls: parsed.data.toolCalls,
      };
      const run = this.store.appendRun(this.now(), JSON.stringify(summary));
      this.store.appendLog({
        writtenAt: this.now(),
        who: 'agent',
        saidBy: 'Ghillie',
        entity: 'run',
        key: String(run.seq),
        field: 'run',
        old: '',
        new: `${summary.writes} writes, ${summary.exceptions} exceptions, messaged ${summary.messaged ? 'yes' : 'no'}`,
        source: 'run',
        evidenceAt: '',
      });
      return { ok: true as const, seq: run.seq, summary };
    });
  }
}

export { logSourceLabels };
