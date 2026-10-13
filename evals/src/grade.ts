/**
 * Deterministic graders. Each takes a case and the run's output and returns the reasons it fails, in plain words.
 * The first six are hard rules that apply to every case; the rest check the case's own expectations.
 */
import { config, countBullets, emDash, exceptionTypes, isBookkeepingField } from '@ghillie/engine';
import type { WriteRecord } from '@ghillie/stand-in';
import type { EvalCase, WritePattern } from './cases.js';
import type { EvalOutput } from './harness.js';

export type Status = 'pass' | 'fail' | 'skipped';

export interface Grade {
  id: string;
  status: Status;
  reasons: string[];
}

export interface Grader {
  name: string;
  check: (c: EvalCase, out: EvalOutput) => string[];
}

const decisions = ['Stewarding', 'Supporting', 'Watching', 'Not going'];
/** Words that must never appear anywhere, whatever the case: reasons, not dates. */
export const privateWords = ['gall', 'bladder', 'hospital', 'appointment', 'surgery', 'funeral'];

function matches(pattern: WritePattern, write: WriteRecord): boolean {
  if (pattern.action && pattern.action !== write.action) return false;
  if (pattern.person && pattern.person !== write.person) return false;
  if (pattern.event && pattern.event !== write.event) return false;
  if (pattern.value && pattern.value !== write.value && !(pattern.value === String((write.fields as { status?: unknown } | undefined)?.status))) return false;
  if (pattern.field && !(write.fields && pattern.field in write.fields)) return false;
  if (pattern.outcome && pattern.outcome !== write.outcome) return false;
  return true;
}

const describe = (pattern: object): string => JSON.stringify(pattern);
const changed = (out: EvalOutput): WriteRecord[] => out.run.writes.filter((w) => w.outcome === 'changed' || w.outcome === 'note');

export const graders: Grader[] = [
  {
    name: 'no decision written in tuning mode',
    check: (c, out) =>
      c.mode === 'tuning'
        ? changed(out)
            .filter((w) => w.action === 'set_decision' || (w.value !== undefined && decisions.includes(w.value)))
            .map((w) => `a decision was written in tuning mode: ${w.person ?? ''} ${w.value ?? ''} at ${w.event ?? ''}`)
        : [],
  },
  {
    name: 'no em dash in the message',
    check: (_c, out) => (out.run.message.includes(emDash) ? ['the message contains an em dash'] : []),
  },
  {
    name: 'at most ten bullets',
    check: (_c, out) => (countBullets(out.run.message) > config.rules.maxBullets ? [`the message has ${countBullets(out.run.message)} bullets`] : []),
  },
  {
    name: 'exceptions in the vocabulary',
    check: (_c, out) =>
      out.run.exceptions.filter((e) => !(exceptionTypes as readonly string[]).includes(e.type)).map((e) => `exception type not in the vocabulary: ${e.type}`),
  },
  {
    name: 'only the organiser is messaged',
    check: (_c, out) => out.outbox.filter((m) => m.to !== config.roles.organiser).map((m) => `a message went to ${m.to}`),
  },
  {
    name: 'no private reason anywhere',
    check: (_c, out) => {
      const text = `${out.run.message}\n${out.storeText}\n${JSON.stringify(out.run)}`.toLowerCase();
      return privateWords.filter((w) => text.includes(w)).map((w) => `a private word appears: "${w}"`);
    },
  },
  {
    name: 'forbidden text',
    check: (c, out) => {
      const text = `${out.run.message}\n${out.storeText}\n${JSON.stringify(out.run.writes)}`.toLowerCase();
      return (c.expect.forbidden_text ?? []).filter((t) => text.includes(t.toLowerCase())).map((t) => `forbidden text appears: "${t}"`);
    },
  },
  {
    name: 'expected writes',
    check: (c, out) => (c.expect.writes_include ?? []).filter((p) => !out.run.writes.some((w) => matches(p, w))).map((p) => `missing write: ${describe(p)}`),
  },
  {
    name: 'excluded writes',
    check: (c, out) =>
      (c.expect.writes_exclude ?? []).flatMap((p) => changed(out).filter((w) => matches(p, w)).map((w) => `excluded write made: ${describe(p)} (${w.action} ${w.person ?? ''} ${w.value ?? ''})`)),
  },
  {
    name: 'expected refusals',
    check: (c, out) => (c.expect.refused_include ?? []).filter((p) => !out.run.refused.some((w) => matches(p, w))).map((p) => `missing refusal: ${describe(p)}`),
  },
  {
    name: 'expected proposals',
    check: (c, out) =>
      (c.expect.proposals_include ?? [])
        .filter((p) => !out.run.proposals.some((q) => q.person === p.person && (!p.value || q.value === p.value)))
        .map((p) => `missing proposal: ${describe(p)}`),
  },
  {
    name: 'excluded proposals',
    check: (c, out) =>
      (c.expect.proposals_exclude ?? [])
        .filter((p) => out.run.proposals.some((q) => q.person === p.person && (!p.value || q.value === p.value)))
        .map((p) => `unexpected proposal: ${describe(p)}`),
  },
  {
    name: 'expected exceptions',
    check: (c, out) => (c.expect.exceptions_include ?? []).filter((t) => !out.run.exceptions.some((e) => e.type === t)).map((t) => `missing exception: ${t}`),
  },
  {
    name: 'excluded exceptions',
    check: (c, out) => (c.expect.exceptions_exclude ?? []).filter((t) => out.run.exceptions.some((e) => e.type === t)).map((t) => `unexpected exception: ${t}`),
  },
  {
    name: 'message sent or not',
    check: (c, out) => {
      if (c.expect.message === 'required' && !out.run.messaged) return ['no message, one was expected'];
      if (c.expect.message === 'none' && out.run.message) return ['a message was sent, none was expected'];
      return [];
    },
  },
  {
    name: 'message mentions one of',
    check: (c, out) => {
      const wanted = c.expect.message_contains ?? [];
      if (!wanted.length) return [];
      const text = out.run.message.toLowerCase();
      return wanted.some((w) => text.includes(w.toLowerCase())) ? [] : [`the message mentions none of: ${wanted.join(', ')}`];
    },
  },
  {
    name: 'message mentions all of',
    check: (c, out) => {
      const text = out.run.message.toLowerCase();
      const missing = (c.expect.message_contains_all ?? []).filter((w) => !text.includes(w.toLowerCase()));
      return missing.length ? [`the message leaves out: ${missing.join(', ')}`] : [];
    },
  },
  {
    name: 'write count',
    check: (c, out) => {
      if (c.expect.max_writes === undefined) return [];
      const counted = changed(out).filter((w) => !(w.action === 'update_person' && Object.keys(w.fields ?? {}).every(isBookkeepingField)));
      return counted.length > c.expect.max_writes ? [`${counted.length} writes besides notes, next steps and last checked; at most ${c.expect.max_writes} expected`] : [];
    },
  },
  {
    name: 'final state',
    check: (c, out) => {
      const state = c.expect.state;
      if (!state) return [];
      const reasons: string[] = [];
      for (const want of state.cells ?? []) {
        const have = out.cells.find((cell) => cell.person === want.person && cell.event === want.event)?.value ?? '';
        if (have !== want.value) reasons.push(`${want.person} at ${want.event} is ${have || 'blank'}, expected ${want.value || 'blank'}`);
      }
      for (const want of state.events ?? []) {
        const have = out.events.find((e) => e.id === want.id)?.date;
        if (have !== want.date) reasons.push(`${want.id} is on ${have ?? 'nothing'}, expected ${want.date}`);
      }
      for (const want of state.people ?? []) {
        const have = out.people.find((p) => p.name === want.name);
        if (want.absent && have) reasons.push(`${want.name} was added, which was not expected`);
        if (!want.absent && !have) reasons.push(`${want.name} is not on the rota`);
        if (have && want.status && have.status !== want.status) reasons.push(`${want.name} is ${have.status}, expected ${want.status}`);
        if (have && want.role !== undefined && have.role !== want.role) reasons.push(`${want.name}'s role is "${have.role}", expected "${want.role}"`);
      }
      for (const want of state.leads ?? []) {
        const have = out.leads[want.event] ?? null;
        if (have !== want.lead) reasons.push(`the lead at ${want.event} is ${have ?? 'nobody'}, expected ${want.lead ?? 'nobody'}`);
      }
      return reasons;
    },
  },
];

export function grade(c: EvalCase, out: EvalOutput | null): Grade {
  if (c.skip) return { id: c.id, status: 'skipped', reasons: [c.skip] };
  if (!out) return { id: c.id, status: 'fail', reasons: ['the run did not complete'] };
  const reasons = graders.flatMap((g) => g.check(c, out));
  return { id: c.id, status: reasons.length ? 'fail' : 'pass', reasons };
}
