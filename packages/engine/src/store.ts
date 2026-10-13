/**
 * The store: SQLite through better-sqlite3, plus an append-only NDJSON change log beside it.
 *
 * This layer knows nothing about the rules. It reads and writes rows. The guards live in service.ts, and nothing
 * outside the engine writes here except the organiser console (her own hand edits) and the seed.
 *
 * History is append-only and enforced by the database itself: triggers refuse any UPDATE or DELETE on the log, runs,
 * proposals, approvals, trace and outbox, and any DELETE on people, events and cells.
 */
import Database from 'better-sqlite3';
import { appendFileSync } from 'node:fs';
import type {
  ApprovalRecord,
  Cell,
  CellValue,
  GamesEvent,
  LogEntity,
  LogEntry,
  Mode,
  OutboxMessage,
  Person,
  Proposal,
  TraceRecord,
} from './types.js';

const schema = `
create table if not exists people (
  ord integer primary key autoincrement,
  name text not null unique,
  surname text not null default '',
  status text not null,
  role text not null default '',
  email text not null default '',
  note text not null default '',
  risk text not null default '',
  next_step text not null default '',
  last_checked text not null default '',
  stewarded_before integer not null default 0,
  pronouns text not null default ''
);
create table if not exists events (
  ord integer primary key autoincrement,
  id text not null unique,
  label text not null unique,
  type text not null,
  village text not null default '',
  date text not null,
  arenas text not null default '[]',
  target integer,
  confirmed integer not null default 0,
  notes text not null default ''
);
create table if not exists cells (
  person text not null,
  event text not null,
  value text not null default '',
  note text not null default '',
  pencilled integer not null default 0,
  pencilled_as_lead integer not null default 0,
  inferred integer not null default 0,
  primary key (person, event)
);
create table if not exists log (
  seq integer primary key autoincrement,
  written_at text not null,
  who text not null,
  said_by text not null default '',
  entity text not null,
  key text not null,
  field text not null,
  old text not null default '',
  new text not null default '',
  source text not null default '',
  evidence_at text not null default ''
);
create index if not exists log_by_field on log (entity, key, field);
create table if not exists runs (
  seq integer primary key autoincrement,
  logged_at text not null,
  summary text not null,
  attempts_upto integer not null default 0,
  outbox_upto integer not null default 0
);
create table if not exists attempts (
  seq integer primary key autoincrement,
  at text not null,
  tool text not null,
  target text not null,
  outcome text not null
);
create table if not exists proposals (
  seq integer primary key autoincrement,
  id text not null unique,
  kind text not null,
  name text not null,
  why text not null,
  source text not null,
  evidence_at text not null,
  evidence_from text not null,
  fingerprint text not null,
  proposed_at text not null
);
create table if not exists approvals (
  seq integer primary key autoincrement,
  kind text not null,
  fingerprint text not null,
  proposal_id text not null default '',
  ref integer not null default 0,
  by text not null,
  at text not null,
  action text not null
);
create table if not exists trace (
  seq integer primary key autoincrement,
  at text not null,
  tool text not null,
  ok integer not null,
  outcome text not null,
  duration_ms real not null,
  args_digest text not null
);
create table if not exists outbox (
  seq integer primary key autoincrement,
  at text not null,
  to_whom text not null,
  text text not null
);
create table if not exists meta (
  key text primary key,
  value text not null
);
`;

const appendOnlyTables = ['log', 'runs', 'attempts', 'proposals', 'approvals', 'trace', 'outbox'];
const neverDeletedTables = ['people', 'events', 'cells'];

function guardTriggers(): string {
  const statements: string[] = [];
  for (const table of appendOnlyTables) {
    statements.push(
      `create trigger if not exists ${table}_no_update before update on ${table} begin select raise(abort, 'append-only: ${table}'); end;`,
      `create trigger if not exists ${table}_no_delete before delete on ${table} begin select raise(abort, 'append-only: ${table}'); end;`,
    );
  }
  for (const table of neverDeletedTables) {
    statements.push(
      `create trigger if not exists ${table}_no_delete before delete on ${table} begin select raise(abort, 'rows are never deleted: ${table}'); end;`,
    );
  }
  return statements.join('\n');
}

interface PersonRow {
  name: string;
  surname: string;
  status: string;
  role: string;
  email: string;
  note: string;
  risk: string;
  next_step: string;
  last_checked: string;
  stewarded_before: number;
  pronouns: string;
}

interface EventRow {
  id: string;
  label: string;
  type: string;
  village: string;
  date: string;
  arenas: string;
  target: number | null;
  confirmed: number;
  notes: string;
}

interface CellRow {
  person: string;
  event: string;
  value: string;
  note: string;
  pencilled: number;
  pencilled_as_lead: number;
  inferred: number;
}

interface LogRow {
  seq: number;
  written_at: string;
  who: string;
  said_by: string;
  entity: string;
  key: string;
  field: string;
  old: string;
  new: string;
  source: string;
  evidence_at: string;
}

export interface StoredRun {
  seq: number;
  loggedAt: string;
  summary: string;
}

export type NewLogEntry = Omit<LogEntry, 'seq'>;

export interface StoreOptions {
  /** A file path, or ':memory:'. */
  path: string;
  /** The NDJSON change log. Omit for in-memory stores used by tests and evals. */
  changeLogPath?: string;
}

const personColumns: Record<keyof Omit<Person, 'name'>, string> = {
  surname: 'surname',
  status: 'status',
  role: 'role',
  email: 'email',
  note: 'note',
  risk: 'risk',
  nextStep: 'next_step',
  lastChecked: 'last_checked',
  stewardedBefore: 'stewarded_before',
  pronouns: 'pronouns',
};

const eventColumns: Record<keyof Omit<GamesEvent, 'id'>, string> = {
  label: 'label',
  type: 'type',
  village: 'village',
  date: 'date',
  arenas: 'arenas',
  target: 'target',
  confirmed: 'confirmed',
  notes: 'notes',
};

export function cellKey(person: string, event: string): string {
  return `${person}::${event}`;
}

export class Store {
  readonly db: Database.Database;
  private readonly changeLogPath: string | undefined;

  constructor(options: StoreOptions) {
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(schema);
    this.db.exec(guardTriggers());
    this.changeLogPath = options.changeLogPath;
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  // ---------- meta ----------

  getMode(): Mode {
    const row = this.db.prepare('select value from meta where key = ?').get('mode') as { value: string } | undefined;
    return row?.value === 'full' ? 'full' : 'tuning';
  }

  setModeRow(mode: Mode): void {
    this.db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run('mode', mode);
  }

  // ---------- people ----------

  insertPerson(person: Person): void {
    this.db
      .prepare(
        `insert into people (name, surname, status, role, email, note, risk, next_step, last_checked, stewarded_before, pronouns)
         values (@name, @surname, @status, @role, @email, @note, @risk, @nextStep, @lastChecked, @stewardedBefore, @pronouns)`,
      )
      .run({ ...person, stewardedBefore: person.stewardedBefore ? 1 : 0 });
  }

  people(): Person[] {
    const rows = this.db.prepare('select * from people order by ord').all() as PersonRow[];
    return rows.map(toPerson);
  }

  person(name: string): Person | undefined {
    const row = this.db.prepare('select * from people where name = ?').get(name) as PersonRow | undefined;
    return row ? toPerson(row) : undefined;
  }

  updatePersonField(name: string, field: keyof Omit<Person, 'name'>, value: string | boolean): void {
    const column = personColumns[field];
    const stored = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    this.db.prepare(`update people set ${column} = ? where name = ?`).run(stored, name);
  }

  // ---------- events ----------

  insertEvent(event: GamesEvent): void {
    this.db
      .prepare(
        `insert into events (id, label, type, village, date, arenas, target, confirmed, notes)
         values (@id, @label, @type, @village, @date, @arenas, @target, @confirmed, @notes)`,
      )
      .run({ ...event, arenas: JSON.stringify(event.arenas), confirmed: event.confirmed ? 1 : 0 });
  }

  events(): GamesEvent[] {
    const rows = this.db.prepare('select * from events order by date, ord').all() as EventRow[];
    return rows.map(toEvent);
  }

  event(id: string): GamesEvent | undefined {
    const row = this.db.prepare('select * from events where id = ?').get(id) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  updateEventField(id: string, field: keyof Omit<GamesEvent, 'id'>, value: string | number | boolean | null | string[]): void {
    const column = eventColumns[field];
    let stored: string | number | null;
    if (Array.isArray(value)) stored = JSON.stringify(value);
    else if (typeof value === 'boolean') stored = value ? 1 : 0;
    else stored = value;
    this.db.prepare(`update events set ${column} = ? where id = ?`).run(stored, id);
  }

  // ---------- cells ----------

  cells(): Cell[] {
    const rows = this.db.prepare('select * from cells').all() as CellRow[];
    return rows.map(toCell);
  }

  cell(person: string, event: string): Cell {
    const row = this.db.prepare('select * from cells where person = ? and event = ?').get(person, event) as CellRow | undefined;
    return row
      ? toCell(row)
      : { person, event, value: '', note: '', pencilled: false, pencilledAsLead: false, inferred: false };
  }

  putCell(cell: Cell): void {
    this.db
      .prepare(
        `insert into cells (person, event, value, note, pencilled, pencilled_as_lead, inferred)
         values (@person, @event, @value, @note, @pencilled, @pencilledAsLead, @inferred)
         on conflict(person, event) do update set value = excluded.value, note = excluded.note,
           pencilled = excluded.pencilled, pencilled_as_lead = excluded.pencilled_as_lead, inferred = excluded.inferred`,
      )
      .run({
        ...cell,
        pencilled: cell.pencilled ? 1 : 0,
        pencilledAsLead: cell.pencilledAsLead ? 1 : 0,
        inferred: cell.inferred ? 1 : 0,
      });
  }

  // ---------- log ----------

  appendLog(entry: NewLogEntry): LogEntry {
    const info = this.db
      .prepare(
        `insert into log (written_at, who, said_by, entity, key, field, old, new, source, evidence_at)
         values (@writtenAt, @who, @saidBy, @entity, @key, @field, @old, @new, @source, @evidenceAt)`,
      )
      .run(entry);
    const stored: LogEntry = { seq: Number(info.lastInsertRowid), ...entry };
    if (this.changeLogPath) appendFileSync(this.changeLogPath, JSON.stringify(stored) + '\n');
    return stored;
  }

  log(sinceSeq = 0): LogEntry[] {
    const rows = this.db.prepare('select * from log where seq > ? order by seq').all(sinceSeq) as LogRow[];
    return rows.map(toLogEntry);
  }

  /** The newest entry for one field, by evidence time (or write time when there is none). */
  latestFor(entity: LogEntity, key: string, field: string): LogEntry | undefined {
    const rows = this.db
      .prepare('select * from log where entity = ? and key = ? and field = ? order by seq')
      .all(entity, key, field) as LogRow[];
    let best: LogEntry | undefined;
    for (const row of rows) {
      const entry = toLogEntry(row);
      const at = Date.parse(entry.evidenceAt || entry.writtenAt);
      const bestAt = best ? Date.parse(best.evidenceAt || best.writtenAt) : -Infinity;
      if (!best || at >= bestAt) best = entry;
    }
    return best;
  }

  // ---------- runs ----------

  appendRun(loggedAt: string, summary: string): StoredRun {
    const outbox = this.db.prepare('select max(seq) as seq from outbox').get() as { seq: number | null };
    const info = this.db
      .prepare('insert into runs (logged_at, summary, attempts_upto, outbox_upto) values (?, ?, ?, ?)')
      .run(loggedAt, summary, this.lastAttemptSeq(), outbox.seq ?? 0);
    return { seq: Number(info.lastInsertRowid), loggedAt, summary };
  }

  // ---------- attempts: every write a caller tries, refused or not ----------

  appendAttempt(at: string, tool: string, target: string, outcome: string): number {
    return Number(this.db.prepare('insert into attempts (at, tool, target, outcome) values (?, ?, ?, ?)').run(at, tool, target, outcome).lastInsertRowid);
  }

  private lastRunMark(column: 'attempts_upto' | 'outbox_upto'): number {
    const row = this.db.prepare(`select ${column} as mark from runs order by seq desc limit 1`).get() as { mark: number } | undefined;
    return row?.mark ?? 0;
  }

  attemptsSinceLastRunList(): { seq: number; tool: string; target: string; outcome: string }[] {
    return this.db.prepare('select seq, tool, target, outcome from attempts where seq > ? order by seq').all(this.lastRunMark('attempts_upto')) as {
      seq: number;
      tool: string;
      target: string;
      outcome: string;
    }[];
  }

  outboxSinceLastRun(): number {
    const row = this.db.prepare('select count(*) as n from outbox where seq > ?').get(this.lastRunMark('outbox_upto')) as { n: number };
    return row.n;
  }

  lastAttemptSeq(): number {
    const row = this.db.prepare('select max(seq) as seq from attempts').get() as { seq: number | null };
    return row.seq ?? 0;
  }

  /** Attempts since the last run was logged: the write cap counts these. */
  attemptsSinceLastRun(): number {
    const row = this.db.prepare('select count(*) as n from attempts where seq > ?').get(this.lastRunMark('attempts_upto')) as { n: number };
    return row.n;
  }

  runs(): StoredRun[] {
    const rows = this.db.prepare('select seq, logged_at, summary from runs order by seq').all() as {
      seq: number;
      logged_at: string;
      summary: string;
    }[];
    return rows.map((row) => ({ seq: row.seq, loggedAt: row.logged_at, summary: row.summary }));
  }

  /** The log sequence number at the time of the last run, so writes since then can be counted. */
  lastRunLogSeq(): number {
    const row = this.db.prepare("select max(seq) as seq from log where entity = 'run'").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  // ---------- proposals and approvals ----------

  appendProposal(proposal: Proposal): void {
    this.db
      .prepare(
        `insert into proposals (id, kind, name, why, source, evidence_at, evidence_from, fingerprint, proposed_at)
         values (@id, @kind, @name, @why, @source, @evidenceAt, @evidenceFrom, @fingerprint, @proposedAt)`,
      )
      .run(proposal);
  }

  proposals(): Proposal[] {
    const rows = this.db.prepare('select * from proposals order by seq').all() as {
      id: string;
      kind: string;
      name: string;
      why: string;
      source: string;
      evidence_at: string;
      evidence_from: string;
      fingerprint: string;
      proposed_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      kind: 'add_person',
      name: row.name,
      why: row.why,
      source: row.source,
      evidenceAt: row.evidence_at,
      evidenceFrom: row.evidence_from === 'self' || row.evidence_from === 'organiser' ? row.evidence_from : 'other',
      fingerprint: row.fingerprint,
      proposedAt: row.proposed_at,
    }));
  }

  appendApproval(record: Omit<ApprovalRecord, 'seq' | 'ref'> & { ref?: number }): ApprovalRecord {
    const info = this.db
      .prepare(
        `insert into approvals (kind, fingerprint, proposal_id, ref, by, at, action)
         values (@kind, @fingerprint, @proposalId, @ref, @by, @at, @action)`,
      )
      .run({ ...record, ref: record.ref ?? 0 });
    return { seq: Number(info.lastInsertRowid), ...record, ref: record.ref ?? 0 };
  }

  approvals(): ApprovalRecord[] {
    const rows = this.db.prepare('select * from approvals order by seq').all() as {
      seq: number;
      kind: string;
      fingerprint: string;
      proposal_id: string;
      ref: number;
      by: string;
      at: string;
      action: string;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      kind: row.kind === 'use' ? 'use' : row.kind === 'decline' ? 'decline' : 'grant',
      fingerprint: row.fingerprint,
      proposalId: row.proposal_id,
      ref: row.ref,
      by: row.by,
      at: row.at,
      action: row.action,
    }));
  }

  // ---------- trace and outbox ----------

  appendTrace(record: Omit<TraceRecord, 'seq'>): void {
    this.db
      .prepare(
        `insert into trace (at, tool, ok, outcome, duration_ms, args_digest) values (@at, @tool, @ok, @outcome, @durationMs, @argsDigest)`,
      )
      .run({ ...record, ok: record.ok ? 1 : 0 });
  }

  trace(): TraceRecord[] {
    const rows = this.db.prepare('select * from trace order by seq').all() as {
      seq: number;
      at: string;
      tool: string;
      ok: number;
      outcome: string;
      duration_ms: number;
      args_digest: string;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      at: row.at,
      tool: row.tool,
      ok: row.ok === 1,
      outcome: row.outcome,
      durationMs: row.duration_ms,
      argsDigest: row.args_digest,
    }));
  }

  appendOutbox(at: string, to: string, text: string): OutboxMessage {
    const info = this.db.prepare('insert into outbox (at, to_whom, text) values (?, ?, ?)').run(at, to, text);
    return { seq: Number(info.lastInsertRowid), at, to, text };
  }

  outbox(): OutboxMessage[] {
    const rows = this.db.prepare('select seq, at, to_whom, text from outbox order by seq').all() as {
      seq: number;
      at: string;
      to_whom: string;
      text: string;
    }[];
    return rows.map((row) => ({ seq: row.seq, at: row.at, to: row.to_whom, text: row.text }));
  }
}

function toPerson(row: PersonRow): Person {
  return {
    name: row.name,
    surname: row.surname,
    status: row.status as Person['status'],
    role: row.role,
    email: row.email,
    note: row.note,
    risk: row.risk,
    nextStep: row.next_step,
    lastChecked: row.last_checked,
    stewardedBefore: row.stewarded_before === 1,
    pronouns: row.pronouns,
  };
}

function toEvent(row: EventRow): GamesEvent {
  return {
    id: row.id,
    label: row.label,
    type: row.type as GamesEvent['type'],
    village: row.village,
    date: row.date,
    arenas: JSON.parse(row.arenas) as string[],
    target: row.target,
    confirmed: row.confirmed === 1,
    notes: row.notes,
  };
}

function toCell(row: CellRow): Cell {
  return {
    person: row.person,
    event: row.event,
    value: row.value as CellValue,
    note: row.note,
    pencilled: row.pencilled === 1,
    pencilledAsLead: row.pencilled_as_lead === 1,
    inferred: row.inferred === 1,
  };
}

function toLogEntry(row: LogRow): LogEntry {
  return {
    seq: row.seq,
    writtenAt: row.written_at,
    who: row.who,
    saidBy: row.said_by,
    entity: row.entity as LogEntity,
    key: row.key,
    field: row.field,
    old: row.old,
    new: row.new,
    source: row.source,
    evidenceAt: row.evidence_at,
  };
}
