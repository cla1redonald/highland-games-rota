import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotaService, Store, addPersonAction, config, fingerprint } from '@ghillie/engine';
import { cell, games, makeWorld, person, said } from './helpers.js';

const t1 = '2027-06-07T10:00:00+01:00';
const t2 = '2027-06-07T11:00:00+01:00';
const at = (t: string): { source: string; evidenceAt: string } => ({ source: 'chat #committee', evidenceAt: t });

function world(mode: 'tuning' | 'full' = 'full') {
  return makeWorld({
    people: [person('Ann'), person('Bob'), person('Isla', { status: 'Leadership' }), person('Pip', { status: 'Pipeline' })],
    events: [
      games('a', '2027-07-10', { arenas: ["Children's races"] }),
      games('b', '2027-07-10'),
      games('c', '2027-07-17'),
      games('old', '2027-07-24', { type: 'Superseded' }),
    ],
    mode,
  });
}

describe('every write needs evidence', () => {
  it('refuses a write with no known source label, no evidence time, no offset, a future time, or an unknown speaker', () => {
    const { service } = world();
    const base = { person: 'Ann', event: 'a', value: 'Yes' };
    expect(service.setAvailability({ ...base, source: '', evidenceAt: t1, saidBy: 'Ann' })).toMatchObject({ refusal: 'source_required' });
    expect(service.setAvailability({ ...base, source: 'what Ann told me at the shop', evidenceAt: t1, saidBy: 'Ann' })).toMatchObject({ refusal: 'source_required' });
    expect(service.setAvailability({ ...base, source: 'mail', evidenceAt: '', saidBy: 'Ann' })).toMatchObject({ refusal: 'evidence_time_required' });
    expect(service.setAvailability({ ...base, source: 'mail', evidenceAt: '2027-06-07T10:00:00', saidBy: 'Ann' })).toMatchObject({ refusal: 'evidence_time_required' });
    expect(service.setAvailability({ ...base, ...said('2027-06-08T10:00:00+01:00', 'Ann') })).toMatchObject({ refusal: 'evidence_in_future' });
    expect(service.setAvailability({ ...base, ...said(t1, 'Nobody') })).toMatchObject({ refusal: 'said_by_unknown' });
  });
});

describe('evidence time is separate from write time', () => {
  it("lets the organiser's hand edit win over older evidence that arrives later", () => {
    const { service, console: organiser, setNow } = world();
    setNow('2027-06-07T12:00:00+01:00');
    organiser.editCell('Ann', 'a', 'Yes');
    setNow('2027-06-07T13:00:00+01:00');
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Maybe', ...said(t1, 'Ann', 'call notes') })).toMatchObject({ refusal: 'newer_entry' });
  });

  it('makes a repeated write a no-op, logged once', () => {
    const { service } = world();
    const write = { person: 'Ann', event: 'a', value: 'Yes', ...said(t1, 'Ann') };
    expect(service.setAvailability(write)).toMatchObject({ ok: true, changed: true });
    expect(service.setAvailability(write)).toMatchObject({ ok: true, changed: false });
    expect(service.store.log().filter((e) => e.key === 'Ann::a')).toHaveLength(1);
  });

  it('keeps a booking when the booked person says Yes again, and lets them drop out with a No', () => {
    const { service, console: organiser } = world();
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...at(t1) }).ok).toBe(true);
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', ...said(t2, 'Ann') })).toMatchObject({ ok: true, changed: false });
    expect(service.store.cell('Ann', 'a').value).toBe('Stewarding');
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'No', ...said(t2, 'Ann') })).toMatchObject({ changed: true, old: 'Stewarding' });
  });

  it('writes the cell note itself from the basis and the date words', () => {
    const { service } = world();
    service.setAvailability({ person: 'Ann', event: 'c', value: 'Maybe', basis: 'vague', dateWords: ['mid-July'], ...said(t1, 'Ann') });
    expect(service.store.cell('Ann', 'c').note).toBe('"mid-July": not pinned to days');
    service.setAvailability({ person: 'Bob', event: 'a', value: 'Maybe', basis: 'condition', ...said(t1, 'Bob', 'mail') });
    expect(service.store.cell('Bob', 'a').note).toBe('condition, see mail');
    expect(service.setAvailability({ person: 'Bob', event: 'b', value: 'Maybe', basis: 'vague', ...said(t1, 'Bob') })).toMatchObject({ refusal: 'invalid_date_words' });
  });
});

describe('decisions', () => {
  it('refuse a second place on the same Saturday, naming the clash; Yes at both is fine', () => {
    const { service, console: organiser } = world();
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', ...said(t1, 'Ann') }).ok).toBe(true);
    expect(service.setAvailability({ person: 'Ann', event: 'b', value: 'Yes', ...said(t1, 'Ann') }).ok).toBe(true);
    organiser.approveDecision('Ann', 'a', 'Stewarding');
    organiser.approveDecision('Ann', 'b', 'Supporting');
    organiser.approveDecision('Ann', 'c', 'Stewarding');
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Stewarding', ...at(t2) }).ok).toBe(true);
    expect(service.setDecision({ person: 'Ann', event: 'b', value: 'Supporting', ...at(t2) })).toMatchObject({ refusal: 'double_booked', clashesWith: 'a' });
    expect(service.setDecision({ person: 'Ann', event: 'c', value: 'Stewarding', ...at(t2) }).ok).toBe(true);
  });

  it('refuse invalid values', () => {
    const { service } = world();
    expect(service.setDecision({ person: 'Ann', event: 'a', value: 'Yes', ...at(t1) })).toMatchObject({ refusal: 'invalid_value' });
    expect(service.setAvailability({ person: 'Ann', event: 'a', value: 'Stewarding', ...said(t1, 'Ann') })).toMatchObject({ refusal: 'invalid_value' });
  });
});

describe('who and what can be written', () => {
  it('has no availability row for Pipeline or Leadership, and refuses unknown people and events', () => {
    const { service } = world();
    expect(service.setAvailability({ person: 'Pip', event: 'a', value: 'Yes', ...said(t1, 'Pip') })).toMatchObject({ refusal: 'not_on_bench' });
    expect(service.setAvailability({ person: 'Isla', event: 'a', value: 'Yes', ...said(t1, 'Isla') })).toMatchObject({ refusal: 'not_on_bench' });
    expect(service.setAvailability({ person: 'Nobody', event: 'a', value: 'Yes', ...said(t1, 'Ann') })).toMatchObject({ refusal: 'unknown_person' });
    expect(service.setAvailability({ person: 'Ann', event: 'zzz', value: 'Yes', ...said(t1, 'Ann') })).toMatchObject({ refusal: 'unknown_event' });
    expect(service.setAvailability({ person: 'Ann', event: 'old', value: 'Yes', ...said(t1, 'Ann') })).toMatchObject({ refusal: 'event_superseded' });
  });

  it('denies any field not on the allow-list, and refuses a rename or free-text notes', () => {
    const { service } = world();
    const fields = { surname: 'Smith' } as unknown as Record<string, string>;
    expect(service.updatePerson({ person: 'Ann', fields, ...said(t1, 'Ann') })).toMatchObject({ refusal: 'field_not_allowed' });
    expect(service.updatePerson({ person: 'Ann', fields: { note: 'anything' } as unknown as Record<string, string>, ...said(t1, 'Ann') })).toMatchObject({
      refusal: 'field_not_allowed',
    });
    expect(service.updateEvent({ event: 'a', fields: { label: 'New name' }, ...at(t1) })).toMatchObject({ refusal: 'rename_not_allowed' });
    expect(service.updateEvent({ event: 'a', fields: { notes: 'x' } as unknown as Record<string, string>, ...at(t1) })).toMatchObject({ refusal: 'field_not_allowed' });
  });

  it('appends a statement to the note in full, never replacing it; a repeated statement is a no-op', () => {
    const { service } = world();
    service.updatePerson({ person: 'Ann', fields: { statement: { verdicts: [{ event: 'a', value: 'Yes' }], dateWords: [] } }, ...said(t1, 'Ann') });
    service.updatePerson({ person: 'Ann', fields: { statement: { verdicts: [{ event: 'b', value: 'No' }], dateWords: ['the 10th'] } }, ...said(t2, 'Ann', 'mail') });
    const again = service.updatePerson({ person: 'Ann', fields: { statement: { verdicts: [{ event: 'b', value: 'No' }], dateWords: ['the 10th'] } }, ...said(t2, 'Ann', 'mail') });
    expect(service.store.person('Ann')?.note).toBe('Mon 7 Jun (chat): Yes a\nMon 7 Jun (mail): No b ("the 10th")');
    expect(again).toMatchObject({ ok: true, changed: [] });
  });

  it('writes the next step itself from an action on a fixed list, and replaces it', () => {
    const { service } = world();
    service.updatePerson({ person: 'Ann', fields: { nextStep: { action: 'ask_dates', about: 'Ann', by: '2027-06-11' } }, ...said(t1, 'Ghillie') });
    expect(service.store.person('Ann')?.nextStep).toBe('Isla to ask Ann for exact dates by Fri 11 Jun');
    service.updatePerson({ person: 'Ann', fields: { nextStep: { action: 'confirm', about: 'Ann', events: ['a'], by: '2027-06-14' } }, ...said(t2, 'Ghillie') });
    expect(service.store.person('Ann')?.nextStep).toBe('Ann to confirm a by Mon 14 Jun');
  });

  it('refuses a next step longer than the configured limit', () => {
    const short = { ...config, rules: { ...config.rules, nextStepMaxWords: 5 } };
    const w = makeWorld({ people: [person('Ann'), person('Isla', { status: 'Leadership' })], events: [games('a', '2027-07-10')], config: short });
    expect(w.service.updatePerson({ person: 'Ann', fields: { nextStep: { action: 'ask_dates', about: 'Ann', by: '2027-06-11' } }, ...said(t1, 'Ghillie') })).toMatchObject({
      refusal: 'next_step_too_long',
    });
  });

  it('never moves last checked backwards', () => {
    const { service } = world();
    service.updatePerson({ person: 'Ann', fields: { lastChecked: '2027-06-07' }, ...said(t1, 'Ghillie') });
    service.updatePerson({ person: 'Ann', fields: { lastChecked: '2027-06-01' }, ...said(t2, 'Ghillie') });
    expect(service.store.person('Ann')?.lastChecked).toBe('2027-06-07');
  });
});

describe('events', () => {
  it("moves an event only with the organiser's approval, resetting every answer and decision and naming previous values", () => {
    const { service, console: organiser } = world();
    service.setAvailability({ person: 'Ann', event: 'c', value: 'Yes', ...said(t1, 'Ann') });
    organiser.approveDecision('Bob', 'c', 'Stewarding');
    service.setDecision({ person: 'Bob', event: 'c', value: 'Stewarding', ...at(t1) });
    expect(service.updateEvent({ event: 'c', fields: { date: '2027-07-24' }, source: 'circuit calendar', evidenceAt: t2 })).toMatchObject({ refusal: 'approval_missing' });
    organiser.approveEventChange('c', { date: '2027-07-24' });
    const result = service.updateEvent({ event: 'c', fields: { date: '2027-07-24' }, source: 'circuit calendar', evidenceAt: t2 });
    expect(result).toMatchObject({ ok: true, reset: [{ person: 'Ann', previous: 'Yes' }, { person: 'Bob', previous: 'Stewarding' }] });
    expect(service.store.cell('Bob', 'c').value).toBe('Unknown');
    expect(service.store.event('c')?.confirmed).toBe(false);
  });

  it('refuses a games date that is not a Saturday', () => {
    const { service, console: organiser } = world();
    organiser.approveEventChange('c', { date: '2027-07-21' });
    expect(service.updateEvent({ event: 'c', fields: { date: '2027-07-21' }, ...at(t1) })).toMatchObject({ refusal: 'invalid_value' });
  });
});

describe('recruits and approvals', () => {
  it('suggests once; a second mention with no new evidence is refused', () => {
    const { service } = world();
    const ask = { name: 'Wilma Craig', suggestedBy: 'Bob', arena: "Children's races", evidenceFrom: 'other' as const };
    expect(service.proposeRecruit({ ...ask, ...said(t1, 'Bob') }).ok).toBe(true);
    expect(service.proposeRecruit({ ...ask, name: 'Wilma Craig', suggestedBy: 'Ann', ...said(t2, 'Ann') })).toMatchObject({ refusal: 'already_proposed' });
    expect(service.proposeRecruit({ ...ask, suggestedBy: 'Wilma Craig', evidenceFrom: 'self', ...said(t2, 'Wilma Craig') }).ok).toBe(true);
    expect(service.proposalViews()[0]?.why).toBe("Bob suggested them for the children's races");
  });

  it('never re-proposes someone the organiser declined, nor someone already on the rota', () => {
    const { service, console: organiser } = world();
    const first = service.proposeRecruit({ name: 'Wilma Craig', suggestedBy: 'Bob', evidenceFrom: 'other', ...said(t1, 'Bob') });
    if (!first.ok) throw new Error('expected a proposal');
    organiser.decline(first.proposalId);
    expect(service.proposeRecruit({ name: 'Wilma Craig', suggestedBy: 'Bob', evidenceFrom: 'organiser', ...said(t2, 'Isla') })).toMatchObject({ refusal: 'organiser_declined' });
    expect(service.proposeRecruit({ name: 'Ann Test', suggestedBy: 'Bob', evidenceFrom: 'other', ...said(t1, 'Bob') })).toMatchObject({ refusal: 'person_exists' });
  });

  it('refuses a recruit name that is not a name, and an arena that does not exist', () => {
    const { service } = world();
    expect(service.proposeRecruit({ name: 'my neighbour from the shop', suggestedBy: 'Bob', evidenceFrom: 'other', ...said(t1, 'Bob') })).toMatchObject({ refusal: 'invalid_value' });
    expect(service.proposeRecruit({ name: 'Wilma Craig', suggestedBy: 'Bob', arena: 'her back garden', evidenceFrom: 'other', ...said(t1, 'Bob') })).toMatchObject({
      refusal: 'invalid_value',
    });
  });

  it('refuses an approval that has already been used', () => {
    const { service, store } = world();
    const print = fingerprint(addPersonAction('Jean Hay', 'Pipeline'));
    const grant = store.appendApproval({ kind: 'grant', fingerprint: print, proposalId: 'p', by: 'Isla', at: t1, action: '{}' });
    store.appendApproval({ kind: 'use', fingerprint: print, proposalId: 'p', ref: grant.seq, by: 'agent', at: t1, action: '{}' });
    expect(service.updatePerson({ person: 'Jean', create: { surname: 'Hay', status: 'Pipeline' }, ...said(t2, 'Isla') })).toMatchObject({ refusal: 'approval_missing' });
  });
});

describe('the message', () => {
  it('goes only to the organiser, written by the service from structured exceptions and readings', () => {
    const { service } = world();
    const sent = service.messageOrganiser({
      exceptions: [{ type: 'no_spare', saturday: '2027-07-10', events: ['a', 'b'] }],
      readings: [{ person: 'Ann', source: 'chat #stewards', at: t1, dateWords: ['mid-July'], verdicts: [{ event: 'c', value: 'Maybe' }] }],
    });
    expect(sent).toMatchObject({ ok: true, to: 'Isla' });
    expect(service.store.outbox()[0]?.text).toBe(
      [
        'Ghillie: 1 thing needs you',
        '• Sat 10 Jul (a Games and b Games) has no spare: anyone dropping out makes it short.',
        'Readings (reply here to correct any)',
        '• Ann (chat Mon 7 Jun 10:00: "mid-July"): c Maybe',
        'Plan: https://rota.example.scot/plan',
      ].join('\n'),
    );
  });

  it('keeps to ten bullets in all', () => {
    const { service } = world();
    const exceptions = Array.from({ length: 12 }, () => ({ type: 'write_limit' as const, limit: 60 }));
    const sent = service.messageOrganiser({ exceptions: exceptions.map((e, i) => ({ ...e, limit: 60 + i })), readings: [] });
    expect(sent.ok && sent.text.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(10);
  });

  it('refuses an empty message', () => {
    expect(world().service.messageOrganiser({ exceptions: [], readings: [] })).toMatchObject({ refusal: 'empty_message' });
  });
});

describe('the store keeps history', () => {
  it('refuses to update or delete log, approval, attempt and run rows, and to delete people, events or cells', () => {
    const { service, store } = world();
    service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', ...said(t1, 'Ann') });
    store.appendApproval({ kind: 'grant', fingerprint: 'f', proposalId: 'p', by: 'Isla', at: t1, action: '{}' });
    expect(() => store.db.prepare("update log set new = 'No'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare('delete from log').run()).toThrow(/append-only/);
    expect(() => store.db.prepare('delete from approvals').run()).toThrow(/append-only/);
    expect(() => store.db.prepare("update attempts set outcome = 'changed'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare('delete from people').run()).toThrow(/never deleted/);
    expect(() => store.db.prepare('delete from cells').run()).toThrow(/never deleted/);
    expect(() => store.db.prepare('delete from events').run()).toThrow(/never deleted/);
  });

  it('writes every log entry to an append-only NDJSON file beside the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghillie-'));
    const store = new Store({ path: join(dir, 'rota.db'), changeLogPath: join(dir, 'rota.db.changes.ndjson') });
    store.insertPerson(person('Ann'));
    store.insertEvent(games('a', '2027-07-10'));
    store.putCell(cell('Ann', 'a', ''));
    const service = new RotaService({ store, clock: () => new Date('2027-06-07T13:00:00+01:00') });
    service.setAvailability({ person: 'Ann', event: 'a', value: 'Yes', ...said(t1, 'Ann') });
    const lines = readFileSync(join(dir, 'rota.db.changes.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ key: 'Ann::a', field: 'value', new: 'Yes', evidenceAt: t1, saidBy: 'Ann', source: 'chat #stewards' });
    store.close();
  });
});
