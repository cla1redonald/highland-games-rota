/**
 * What the harness keeps between processes, so a tick that was killed can be resumed by its tick id:
 *
 *   - the session index: tick id to SDK session id, and whether the tick finished;
 *   - the call journal: every tool call the tick made and its outcome, so the resumed run's record includes the
 *     calls made before the kill;
 *   - the audit trail: every hook decision, allowed or denied, with a digest of the arguments.
 *
 * All of it is NDJSON or JSON under the harness's state directory (data/, gitignored).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest } from '@ghillie/engine';
import type { CallOutcome } from '@ghillie/agent-kit';

export interface SessionEntry {
  sessionId: string;
  status: 'running' | 'interrupted' | 'completed';
  updatedAt: string;
}

export class SessionIndex {
  constructor(private readonly path: string) {}

  private load(): Record<string, SessionEntry> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, SessionEntry>) : {};
  }

  get(tickId: string): SessionEntry | undefined {
    return this.load()[tickId];
  }

  set(tickId: string, entry: Omit<SessionEntry, 'updatedAt'>): void {
    const all = this.load();
    all[tickId] = { ...entry, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(all, null, 1)}\n`);
  }
}

export interface JournalEntry {
  tickId: string;
  name: string;
  args: Record<string, unknown>;
  outcome: CallOutcome;
}

function appendLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export class CallJournal {
  constructor(private readonly path: string) {}

  append(entry: JournalEntry): void {
    appendLine(this.path, entry);
  }

  forTick(tickId: string): JournalEntry[] {
    return readLines<JournalEntry>(this.path).filter((e) => e.tickId === tickId);
  }
}

export interface AuditEntry {
  at: string;
  tickId: string;
  sessionId: string;
  hook: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
  tool: string;
  argsDigest: string;
  decision: 'allow' | 'deny' | 'recorded';
  /** For a denial: the stage and the refusal. For a result: the service's outcome. */
  reason: string;
}

export class AuditTrail {
  constructor(private readonly path: string) {}

  write(entry: Omit<AuditEntry, 'at' | 'argsDigest'> & { args: unknown }): void {
    const { args, ...rest } = entry;
    appendLine(this.path, { at: new Date().toISOString(), ...rest, argsDigest: digest(JSON.stringify(args ?? null)) });
  }

  entries(): AuditEntry[] {
    return readLines<AuditEntry>(this.path);
  }
}

export interface HarnessState {
  dir: string;
  sessions: SessionIndex;
  journal: CallJournal;
  audit: AuditTrail;
}

export function harnessState(dir: string): HarnessState {
  return { dir, sessions: new SessionIndex(join(dir, 'sessions.json')), journal: new CallJournal(join(dir, 'calls.ndjson')), audit: new AuditTrail(join(dir, 'audit.ndjson')) };
}
