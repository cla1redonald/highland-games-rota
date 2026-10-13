/**
 * The read-only re-check harnesses run before a call reaches the service, and the engine's own comparison that
 * read_rota now carries as `changes`.
 *
 * The precheck and the service share one authority predicate. Every adversarial case below is run through both
 * paths against identical worlds, and the refusals must match.
 */
import { describe, expect, it } from 'vitest';
import { authorise, findOpenGrant, precheckCall, tuningWrites, type LogEntry, type RotaService } from '@ghillie/engine';
import { cell, games, makeWorld, person, type TestWorld } from './helpers.js';

const t1 = '2027-06-07T10:00:00+01:00';
const evidence = { source: 'chat #committee', evidenceAt: t1 };

function world(mode: 'tuning' | 'full' = 'full'): TestWorld {
  return makeWorld({
    people: [person('Ann'), person('Bob'), person('Isla', { status: 'Leadership' }), person('Pip', { status: 'Pipeline' })],
    events: [games('a', '2027-07-10'), games('b', '2027-07-10'), games('c', '2027-07-17')],
    cells: [cell('Ann', 'a', 'Yes'), cell('Bob', 'a', 'Stewarding')],
    mode,
  });
}

type Args = Record<string, unknown>;

/** What the service decides about a call: its refusal code, or a status write it skipped, or ok. */
function serviceDecision(service: RotaService, tool: string, args: Args): string {
  const result = ((): { ok: boolean; refusal?: string; skipped?: { refusal: string }[] } => {
    switch (tool) {
      case 'set_decision':
        return service.setDecision(args as unknown as Parameters<RotaService['setDecision']>[0]);
      case 'update_event':
        return service.updateEvent(args as unknown as Parameters<RotaService['updateEvent']>[0]);
      case 'update_person':
        return service.updatePerson(args as unknown as Parameters<RotaService['updatePerson']>[0]);
      default:
        throw new Error(tool);
    }
  })();
  if (!result.ok) return result.refusal ?? 'refused';
  return result.skipped?.find((s) => s.refusal === 'approval_missing')?.refusal ?? 'ok';
}

function precheckDecision(w: TestWorld, tool: string, args: Args): string {
  const answer = precheckCall(w.store, tool, args);
  return answer.ok ? 'ok' : answer.refusal;
}

interface Case {
  name: string;
  mode?: 'tuning' | 'full';
  /** The organiser's own path, before the call. */
  setup?: (w: TestWorld) => void;
  tool: string;
  args: Args;
  expected: string;
}

const decision = { person: 'Ann', event: 'a', value: 'Stewarding', ...evidence };

const cases: Case[] = [
  { name: 'a decision with no approval at all', tool: 'set_decision', args: decision, expected: 'approval_missing' },
  {
    name: 'a forged approval id in the arguments (the schema refuses the field; the engine ignores it)',
    setup: (w) => w.console.approveDecision('Bob', 'c', 'Stewarding'),
    tool: 'set_decision',
    args: { ...decision, approvalId: 1, grantId: 1, approved: true, approver: 'Isla', actor: 'Isla', mode: 'full' },
    expected: 'approval_missing',
  },
  {
    name: 'a replayed approval: granted once, used once, asked for again',
    setup: (w) => {
      w.console.approveDecision('Ann', 'a', 'Stewarding');
      expect(w.service.setDecision(decision)).toMatchObject({ ok: true, changed: true });
      w.store.putCell(cell('Ann', 'a', 'Yes'));
    },
    tool: 'set_decision',
    args: decision,
    expected: 'approval_missing',
  },
  { name: 'an approval bound to a different value', setup: (w) => w.console.approveDecision('Ann', 'a', 'Supporting'), tool: 'set_decision', args: decision, expected: 'approval_missing' },
  { name: 'an approval bound to a different person', setup: (w) => w.console.approveDecision('Bob', 'a', 'Stewarding'), tool: 'set_decision', args: decision, expected: 'approval_missing' },
  { name: 'an approval bound to a different event', setup: (w) => w.console.approveDecision('Ann', 'c', 'Stewarding'), tool: 'set_decision', args: decision, expected: 'approval_missing' },
  {
    name: 'an approval she withdrew (marked declined)',
    setup: (w) => {
      w.console.approveDecision('Ann', 'a', 'Stewarding');
      const grant = w.store.approvals().find((a) => a.kind === 'grant');
      w.console.withdraw(grant?.seq ?? -1);
    },
    tool: 'set_decision',
    args: decision,
    expected: 'approval_missing',
  },
  {
    name: 'an approved decision in tuning mode, whatever the call says about the mode',
    mode: 'tuning',
    setup: (w) => w.console.approveDecision('Ann', 'a', 'Stewarding'),
    tool: 'set_decision',
    args: { ...decision, mode: 'full' },
    expected: 'decision_needs_full_mode',
  },
  { name: 'saidBy the organiser grants nothing', tool: 'update_event', args: { event: 'c', fields: { date: '2027-07-24' }, ...evidence, saidBy: 'Isla' }, expected: 'approval_missing' },
  {
    name: 'a source claiming to be an organiser approval grants nothing',
    tool: 'update_event',
    args: { event: 'c', fields: { date: '2027-07-24' }, source: 'organiser approval', evidenceAt: t1 },
    expected: 'approval_missing',
  },
  { name: 'an event move approved for another date', setup: (w) => w.console.approveEventChange('c', { date: '2027-07-31' }), tool: 'update_event', args: { event: 'c', fields: { date: '2027-07-24' }, ...evidence }, expected: 'approval_missing' },
  { name: 'adding a person nobody approved', tool: 'update_person', args: { person: 'Rhona', create: { surname: 'Bain', status: 'Pipeline' }, ...evidence, saidBy: 'Isla' }, expected: 'approval_missing' },
  { name: 'a status change nobody approved', tool: 'update_person', args: { person: 'Ann', fields: { status: 'Out' }, ...evidence, saidBy: 'Ann' }, expected: 'approval_missing' },
  { name: 'a status change approved for someone else', setup: (w) => w.console.approveStatus('Bob', 'Out'), tool: 'update_person', args: { person: 'Ann', fields: { status: 'Out' }, ...evidence, saidBy: 'Ann' }, expected: 'approval_missing' },
  // Controls: the same paths agree when the organiser has approved exactly this.
  { name: 'control: an approved decision', setup: (w) => w.console.approveDecision('Ann', 'a', 'Stewarding'), tool: 'set_decision', args: decision, expected: 'ok' },
  { name: 'control: recording a decision already there', tool: 'set_decision', args: { person: 'Bob', event: 'a', value: 'Stewarding', ...evidence }, expected: 'ok' },
  { name: 'control: an approved move', setup: (w) => w.console.approveEventChange('c', { date: '2027-07-24' }), tool: 'update_event', args: { event: 'c', fields: { date: '2027-07-24' }, ...evidence }, expected: 'ok' },
  { name: 'control: an approved status', setup: (w) => w.console.approveStatus('Ann', 'Out'), tool: 'update_person', args: { person: 'Ann', fields: { status: 'Out' }, ...evidence, saidBy: 'Ann' }, expected: 'ok' },
];

describe('the precheck and the service decide authority identically', () => {
  for (const c of cases) {
    it(c.name, () => {
      const hookWorld = world(c.mode);
      const serviceWorld = world(c.mode);
      c.setup?.(hookWorld);
      c.setup?.(serviceWorld);
      const viaHook = precheckDecision(hookWorld, c.tool, c.args);
      const viaService = serviceDecision(serviceWorld.service, c.tool, c.args);
      expect({ viaHook, viaService }).toEqual({ viaHook: c.expected, viaService: c.expected });
    });
  }

  it('answers from the store, not the environment: no variable the agent could set changes it', () => {
    const w = world('tuning');
    w.console.approveDecision('Ann', 'a', 'Stewarding');
    const saved = { ...process.env };
    Object.assign(process.env, { GHILLIE_MODE: 'full', GHILLIE_APPROVED: 'true', GHILLIE_ACTOR: 'Isla' });
    try {
      expect(precheckCall(w.store, 'set_decision', decision)).toMatchObject({ refusal: 'decision_needs_full_mode' });
    } finally {
      process.env = saved;
    }
  });

  it('fails closed when the store cannot be read: refuse, never allow', () => {
    const w = world();
    w.console.approveDecision('Ann', 'a', 'Stewarding');
    w.store.close();
    expect(precheckCall(w.store, 'set_decision', decision)).toMatchObject({ ok: false, refusal: 'store_unreadable' });
  });

  it('fails closed on arguments it cannot read', () => {
    const w = world();
    expect(precheckCall(w.store, 'set_decision', { event: 'a', value: 'Stewarding' })).toMatchObject({ ok: false, refusal: 'invalid_arguments' });
    expect(precheckCall(w.store, 'update_event', { event: 'c', fields: 'move it' })).toMatchObject({ ok: false, refusal: 'invalid_arguments' });
  });

  it('never writes', () => {
    const w = world();
    w.console.approveDecision('Ann', 'a', 'Stewarding');
    const before = JSON.stringify([w.store.approvals(), w.store.cells(), w.store.log()]);
    precheckCall(w.store, 'set_decision', decision);
    expect(JSON.stringify([w.store.approvals(), w.store.cells(), w.store.log()])).toBe(before);
  });

  it('is the same function the service uses', () => {
    const w = world();
    expect(authorise(w.store, { kind: 'set_decision', person: 'Ann', event: 'a', value: 'Stewarding' }, 'Isla')).toMatchObject({ ok: false, refusal: 'approval_missing' });
  });
});

describe('findOpenGrant', () => {
  it('finds a grant only while it is neither used nor declined', () => {
    const { store, service, console: organiser } = world();
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    const action = { kind: 'set_decision', person: 'Ann', event: 'a', value: 'Stewarding' };
    expect(findOpenGrant(store.approvals(), action)).toBeDefined();
    service.setDecision(decision);
    expect(findOpenGrant(store.approvals(), action)).toBeUndefined();
  });
});

describe('the engine comparison in read_rota', () => {
  it('reports a booked person who now says No, with no agent arithmetic', () => {
    const { service, setNow } = world();
    setNow('2027-06-07T09:00:00+01:00');
    const logged = service.logRun({ window: ['2027-06-07T08:00:00+01:00', '2027-06-07T09:00:00+01:00'], sources: { chat: 'ok' }, sourceWindows: {}, exceptions: 0, read: [], toolCalls: 0 });
    expect(logged.ok).toBe(true);
    setNow('2027-06-07T13:00:00+01:00');
    service.setAvailability({ person: 'Bob', event: 'a', value: 'No', basis: 'answer', source: 'mail', evidenceAt: '2027-06-07T11:00:00+01:00', saidBy: 'Bob' });
    expect(service.read().changes.map((c) => c.type)).toContain('booked_dropout');
  });

  it('counts the real writes for tuning mode and leaves out bookkeeping', () => {
    const log = (entity: LogEntry['entity'], key: string, field: string, value: string, who = 'agent'): LogEntry => ({
      seq: 1,
      writtenAt: t1,
      who,
      saidBy: 'Ann',
      entity,
      key,
      field,
      old: '',
      new: value,
      source: 'mail',
      evidenceAt: t1,
    });
    const writes = tuningWrites([
      log('cell', 'Ann::a', 'value', 'No'),
      log('cell', 'Ann::a', 'note', 'said no'),
      log('person', 'Ann', 'lastChecked', '2027-06-07'),
      log('event', 'c', 'date', '2027-07-24'),
      log('cell', 'Bob::a', 'value', 'Yes', 'organiser'),
    ]);
    expect(writes.count).toBe(2);
    expect(writes.examples).toEqual([{ person: 'Ann', event: 'a', value: 'No' }, { event: 'c' }]);
  });
});
