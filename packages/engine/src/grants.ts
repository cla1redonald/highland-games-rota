/**
 * Approvals, read-only. One place that answers "has the organiser approved exactly this, and is it still unused?",
 * used by the service before a write and by any harness that wants to re-check a call before it reaches the service.
 */
import { fingerprint } from './fingerprint.js';
import type { ApprovalRecord, LogEntry } from './types.js';

export type ActionValue = string | number | boolean | null | { [key: string]: string | number | boolean | null };

/** The grant for exactly this action that has been neither used nor declined, if there is one. */
export function findOpenGrant(records: ApprovalRecord[], action: { [key: string]: ActionValue }): ApprovalRecord | undefined {
  const print = fingerprint(action);
  const closed = new Set(records.filter((r) => r.kind !== 'grant').map((r) => r.ref));
  return records.find((r) => r.kind === 'grant' && r.fingerprint === print && !closed.has(r.seq));
}

const namePattern = /^[A-Z][a-z'-]{1,20}$/;
const valuePattern = /^(Yes|Maybe|No|Unknown|Stewarding|Supporting|Watching|Not going)$/;
type TuningValue = 'Yes' | 'Maybe' | 'No' | 'Unknown' | 'Stewarding' | 'Supporting' | 'Watching' | 'Not going';

/**
 * The agent's own writes since the last run that change the rota (answers, decisions, events, statuses, people), not
 * notes, next steps or last checked. In tuning mode every one of them is reported to the organiser.
 */
export function tuningWrites(log: LogEntry[]): { count: number; examples: { person?: string; event?: string; value?: TuningValue }[] } {
  const real = log.filter(
    (e) => e.who === 'agent' && ((e.entity === 'cell' && e.field === 'value') || e.entity === 'event' || (e.entity === 'person' && (e.field === 'status' || e.field === 'added'))),
  );
  const examples = real.slice(0, 4).map((e) => {
    const [person = '', event = ''] = e.entity === 'cell' ? e.key.split('::') : e.entity === 'person' ? [e.key, ''] : ['', e.key];
    return {
      ...(namePattern.test(person) ? { person } : {}),
      ...(event ? { event } : {}),
      ...(valuePattern.test(e.new) ? { value: e.new as TuningValue } : {}),
    };
  });
  return { count: real.length, examples };
}
