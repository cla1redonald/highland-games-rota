/**
 * The security review's findings, one block each. The principle throughout: the service validates; the caller never
 * decides. No name, flag or mode a caller supplies grants anything, and nothing a source said reaches the store, the
 * log or the message except date words that pass the grammar.
 */
import { describe, expect, it } from 'vitest';
import { config } from '@ghillie/engine';
import { games, makeWorld, person, said } from './helpers.js';

const t1 = '2027-06-07T10:00:00+01:00';
const t2 = '2027-06-07T11:00:00+01:00';
const evidence = (at: string): { source: string; evidenceAt: string } => ({ source: 'chat #committee', evidenceAt: at });

function world(mode: 'tuning' | 'full' = 'full') {
  return makeWorld({
    people: [person('Ann'), person('Bob'), person('Isla', { status: 'Leadership' }), person('Pip', { status: 'Pipeline' })],
    events: [games('a', '2027-07-10'), games('b', '2027-07-10'), games('c', '2027-07-17')],
    mode,
  });
}

describe('finding 1: authority comes only from an organiser approval of the exact action, used once', () => {
  it('refuses a decision whatever the caller claims, without an organiser approval', () => {
    const { service } = world();
    const claims = { approved: true, approver: 'Isla', saidBy: 'Isla', actor: 'Isla' } as Record<string, unknown>;
    const result = service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...evidence(t1), ...claims });
    expect(result).toMatchObject({ ok: false, refusal: 'approval_missing' });
    expect(service.store.cell('Ann', 'a').value).toBe('');
  });

  it('binds an approval to the exact person, event and decision', () => {
    const { service, console: organiser } = world();
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Supporting', ...evidence(t1) })).toMatchObject({ refusal: 'approval_missing' });
    expect(service.setDecision({ person: 'Bob', event: 'a', value: 'Stewarding', ...evidence(t1) })).toMatchObject({ refusal: 'approval_missing' });
    expect(service.setDecision({ person: 'Ann', event: 'c', value: 'Stewarding', ...evidence(t1) })).toMatchObject({ refusal: 'approval_missing' });
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...evidence(t1) })).toMatchObject({ ok: true, changed: true });
  });

  it('uses an approval once, marked used in the same transaction as the write', () => {
    const { service, console: organiser, store, setNow } = world();
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...evidence(t1) }).ok).toBe(true);
    expect(store.approvals().map((r) => [r.kind, r.ref])).toEqual([
      ['grant', 0],
      ['use', 1],
    ]);
    setNow('2027-06-07T12:00:00+01:00');
    organiser.editCell('Ann', 'a', 'Yes');
    setNow('2027-06-07T13:00:00+01:00');
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...evidence('2027-06-07T12:30:00+01:00') })).toMatchObject({
      refusal: 'approval_missing',
    });
  });

  it('leaves the approval unused when the write is refused, so a refusal never spends it', () => {
    const { service, console: organiser } = world();
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    organiser.approveDecision('Ann', 'b', 'Stewarding');
    service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...evidence(t1) });
    expect(service.setDecision({ person: 'Ann', event: 'b', value: 'Stewarding', ...evidence(t1) })).toMatchObject({ refusal: 'double_booked' });
    expect(service.grantViews().map((g) => g.status)).toEqual(['used', 'ready']);
  });

  it('adds a Pipeline person only with an approval of that exact name and status', () => {
    const { service, console: organiser } = world();
    const proposal = service.proposeRecruit({ name: 'Wilma Craig', suggestedBy: 'Bob', evidenceFrom: 'other', ...said(t1, 'Bob') });
    if (!proposal.ok) throw new Error('expected a proposal');
    expect(service.updatePerson({ person: 'Wilma', create: { surname: 'Craig', status: 'Pipeline' }, ...said(t2, 'Isla') })).toMatchObject({ refusal: 'approval_missing' });
    organiser.approve(proposal.proposalId);
    expect(service.updatePerson({ person: 'Wilma', create: { surname: 'Craig', status: 'In' }, ...said(t2, 'Isla') })).toMatchObject({ refusal: 'approval_missing' });
    expect(service.updatePerson({ person: 'Wilma', create: { surname: 'Craig', status: 'Pipeline' }, ...said(t2, 'Isla') })).toMatchObject({ ok: true, added: true });
    expect(service.store.person('Wilma')?.note).toBe("Mon 7 Jun: suggested for the Pipeline (chat #stewards)");
  });

  it("treats a claim to be the organiser as provenance only: it grants no status change", () => {
    const { service, console: organiser } = world();
    expect(service.updatePerson({ person: 'Pip', fields: { status: 'Maybe' }, ...said(t1, 'Isla') })).toMatchObject({
      skipped: [{ field: 'status', refusal: 'approval_missing' }],
    });
    organiser.approveStatus('Pip', 'Maybe');
    expect(service.updatePerson({ person: 'Pip', fields: { status: 'Maybe' }, ...said(t2, 'Bob') })).toMatchObject({ changed: [{ field: 'status', value: 'Maybe' }] });
  });

  it('carries out an event change only as approved, field for field', () => {
    const { service, console: organiser } = world();
    organiser.approveEventChange('c', { date: '2027-07-24' });
    expect(service.updateEvent({ event: 'c', fields: { date: '2027-07-31' }, ...evidence(t1) })).toMatchObject({ refusal: 'approval_missing' });
    expect(service.updateEvent({ event: 'c', fields: { date: '2027-07-24', confirmed: true }, ...evidence(t1) })).toMatchObject({ refusal: 'approval_missing' });
    expect(service.updateEvent({ event: 'c', fields: { date: '2027-07-24' }, ...evidence(t1) }).ok).toBe(true);
  });
});

describe('finding 2: tuning mode and the write cap are enforced inside the service', () => {
  it('refuses decisions in tuning mode, even with an approval', () => {
    const { service, console: organiser } = world('tuning');
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...evidence(t1) })).toMatchObject({ refusal: 'decision_needs_full_mode' });
    expect(service.grantViews()[0]?.status).toBe('ready');
  });

  it('counts every attempted write towards the cap, refused ones included', () => {
    const { service, store } = world();
    for (let i = 0; i < config.rules.maxWritesPerRun; i++) {
      expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', source: 'not a label', evidenceAt: t1, saidBy: 'Ann' })).toMatchObject({
        refusal: 'source_required',
      });
    }
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', ...said(t1, 'Ann') })).toMatchObject({ refusal: 'write_limit' });
    expect(store.attemptsSinceLastRun()).toBe(config.rules.maxWritesPerRun + 1);
    const logged = service.logRun({ window: [t1, t2], sources: { chat: 'ok' }, sourceWindows: { chat: [t1, t2] }, exceptions: 0, read: [], toolCalls: 1 });
    expect(logged).toMatchObject({ ok: true, summary: { refused: config.rules.maxWritesPerRun + 1, writes: 0 } });
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', ...said(t1, 'Ann') }).ok).toBe(true);
  });

  it('cannot be told the mode, the counts or whether it messaged: the service works the run summary out', () => {
    const { service } = world();
    const base = { window: [t1, t2], sources: { chat: 'ok' }, sourceWindows: { chat: [t1, t2] }, exceptions: 0, read: [], toolCalls: 1 };
    expect(service.logRun({ ...base, mode: 'full' })).toMatchObject({ refusal: 'invalid_summary' });
    expect(service.logRun({ ...base, writes: 999 })).toMatchObject({ refusal: 'invalid_summary' });
    expect(service.logRun({ ...base, messaged: true })).toMatchObject({ refusal: 'invalid_summary' });
    expect(service.logRun({ ...base, sources: { chat: 'fine, she said the hospital was quick' } })).toMatchObject({ refusal: 'invalid_summary' });
    expect(service.logRun(base)).toMatchObject({ ok: true, summary: { mode: 'full', messaged: false, writes: 0 } });
  });
});

describe('finding 3: no free text from a source is stored, logged or sent', () => {
  it('refuses date words that carry a reason, and accepts date words alone', () => {
    const { service } = world();
    const base = { person: 'Ann', event: 'a', value: 'Maybe', basis: 'vague', ...said(t1, 'Ann') };
    for (const words of [['my gall bladder op'], ['away for her mum'], ['mid-July', 'hospital']]) {
      expect(service.setAvailability({ ...base, dateWords: words })).toMatchObject({ refusal: 'invalid_date_words' });
    }
    expect(service.setAvailability({ ...base, dateWords: ['until the a Games', 'Tuesday 29 June', 'a fortnight'] }).ok).toBe(true);
  });

  it('composes notes from structure only: a statement is answers and date words, nothing else', () => {
    const { service } = world();
    expect(
      service.updatePerson({
        person: 'Ann',
        fields: { statement: { verdicts: [{ event: 'a', value: 'No' }], dateWords: ['gall bladder'] } },
        ...said(t1, 'Ann'),
      }),
    ).toMatchObject({ refusal: 'invalid_date_words' });
    const loose = { verdicts: [{ event: 'a', value: 'No', reason: 'op' }], dateWords: [] } as unknown as { verdicts: []; dateWords: [] };
    expect(service.updatePerson({ person: 'Ann', fields: { statement: loose }, ...said(t1, 'Ann') })).toMatchObject({ refusal: 'invalid_value' });
  });

  it('refuses a message that carries a sentence, a field outside the vocabulary or an unknown person', () => {
    const { service } = world();
    expect(
      service.messageOrganiser({ exceptions: [{ type: 'unresolved', reason: 'vague', person: 'Ann', dateWords: ['she has a hospital appointment'] }], readings: [] }),
    ).toMatchObject({ refusal: 'invalid_date_words' });
    expect(
      service.messageOrganiser({ exceptions: [{ type: 'booked_dropout', person: 'Ann', event: 'a', kind: 'Stewarding', value: 'No', detail: 'her op' }], readings: [] }),
    ).toMatchObject({ refusal: 'invalid_message' });
    expect(service.messageOrganiser({ exceptions: [{ type: 'over_used', person: 'Dougal', event: 'a', weeks: 3 }], readings: [] })).toMatchObject({
      refusal: 'unknown_person',
    });
    expect(service.store.outbox()).toHaveLength(0);
  });
});

describe('finding 4: older evidence is refused for every field, however late it arrives', () => {
  it('refuses an older answer, decision, note, next step, status and event change', () => {
    const { service, console: organiser } = world();
    // Newer entries first.
    service.setAvailability({ person: 'Ann', event: 'a', value: 'No', ...said(t2, 'Ann') });
    service.updatePerson({ person: 'Ann', fields: { statement: { verdicts: [{ event: 'a', value: 'No' }], dateWords: [] } }, ...said(t2, 'Ann') });
    service.updatePerson({ person: 'Ann', fields: { nextStep: { action: 'decide_joining', about: 'Ann' } }, ...said(t2, 'Ghillie') });
    organiser.approveStatus('Bob', 'Maybe');
    service.updatePerson({ person: 'Bob', fields: { status: 'Maybe' }, ...said(t2, 'Isla') });
    organiser.approveEventChange('c', { target: 3 });
    service.updateEvent({ event: 'c', fields: { target: 3 }, ...evidence(t2) });

    // Then older evidence for the same fields, arriving later.
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', ...said(t1, 'Ann') })).toMatchObject({ refusal: 'newer_entry' });
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...evidence(t1) })).toMatchObject({ refusal: 'newer_entry' });
    expect(service.updatePerson({ person: 'Ann', fields: { statement: { verdicts: [{ event: 'a', value: 'Yes' }], dateWords: [] } }, ...said(t1, 'Ann') })).toMatchObject({
      skipped: [{ field: 'note', refusal: 'newer_entry' }],
    });
    expect(service.updatePerson({ person: 'Ann', fields: { nextStep: { action: 'ask_dates', about: 'Ann' } }, ...said(t1, 'Ghillie') })).toMatchObject({
      skipped: [{ field: 'nextStep', refusal: 'newer_entry' }],
    });
    organiser.approveStatus('Bob', 'In');
    expect(service.updatePerson({ person: 'Bob', fields: { status: 'In' }, ...said(t1, 'Isla') })).toMatchObject({ skipped: [{ field: 'status', refusal: 'newer_entry' }] });
    organiser.approveEventChange('c', { target: 5 });
    expect(service.updateEvent({ event: 'c', fields: { target: 5 }, ...evidence(t1) })).toMatchObject({ skipped: [{ field: 'target', refusal: 'newer_entry' }] });
  });
});

describe('finding 5: every other path from a tool argument to the store or the message', () => {
  it('refuses an unknown speaker as provenance, and a free-text source label', () => {
    const { service } = world();
    expect(service.updatePerson({ person: 'Ann', fields: { lastChecked: '2027-06-07' }, ...said(t1, 'Somebody from the pub') })).toMatchObject({
      refusal: 'said_by_unknown',
    });
    expect(service.proposeRecruit({ name: 'Wilma Craig', suggestedBy: 'Bob', evidenceFrom: 'other', source: 'Bob, over a pint', evidenceAt: t1, saidBy: 'Bob' })).toMatchObject({
      refusal: 'source_required',
    });
  });

  it('fixes the recipient in configuration: the message goes to the organiser and nobody else', () => {
    const { service } = world();
    const sent = service.messageOrganiser({ exceptions: [{ type: 'write_limit', limit: 60 }], readings: [] });
    expect(sent).toMatchObject({ ok: true, to: config.roles.organiser });
    expect(service.store.outbox().map((m) => m.to)).toEqual([config.roles.organiser]);
  });
});
