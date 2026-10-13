import { describe, expect, it } from 'vitest';
import { detectChanges, londonDate, renderException, snapshotOf, type RotaException, type RotaService } from '@ghillie/engine';
import { cell, games, makeWorld, person, said } from './helpers.js';

const t1 = '2027-06-07T10:00:00+01:00';

function base() {
  return makeWorld({
    people: [person('Morven'), person('Ann'), person('Bob'), person('Cat'), person('Torquil'), person('Isla', { status: 'Leadership' })],
    events: [games('a', '2027-06-26', { target: 2 }), games('b', '2027-07-03', { target: 2 }), games('c', '2027-07-10', { target: 2 })],
    cells: [
      cell('Morven', 'a', 'Yes', { pencilled: true, pencilledAsLead: true }),
      cell('Ann', 'a', 'Stewarding'),
      cell('Bob', 'a', 'Yes'),
      cell('Ann', 'b', 'Yes'),
      cell('Bob', 'b', 'Yes'),
      cell('Torquil', 'c', 'Yes', { pencilled: true, pencilledAsLead: true }),
      cell('Cat', 'c', 'Yes'),
    ],
  });
}

function snap(service: RotaService) {
  const view = service.read();
  return snapshotOf(view.plan, view.events, view.cells, 6);
}

function detect(service: RotaService, previous: ReturnType<typeof snap> | null): RotaException[] {
  const view = service.read();
  return detectChanges(previous, snapshotOf(view.plan, view.events, view.cells, 6), {
    plan: view.plan,
    events: view.events,
    cells: view.cells,
    log: service.store.log(),
    organiser: 'Isla',
    lookaheadWeeks: 6,
  });
}

const types = (list: RotaException[]): string[] => list.map((e) => e.type);

function text(service: RotaService, e: RotaException | undefined): string {
  return e ? renderException(e, { events: service.store.events(), organiser: 'Isla' }) : '';
}

describe('what needs the organiser', () => {
  it('reports nothing when nothing changed', () => {
    const { service } = base();
    const before = snap(service);
    expect(detect(service, before)).toEqual([]);
  });

  it('reports a booked person who now says No, with the source of the change, and the spare it cost', () => {
    const { service } = base();
    const before = snap(service);
    service.setAvailability({ person: 'Ann', event: 'a', value: 'No', ...said(t1, 'Ann', 'mail') });
    const found = detect(service, before);
    expect(types(found)).toEqual(['booked_dropout', 'no_spare']);
    expect(text(service, found[0])).toBe('Ann, stewarding at a Games, now says No (mail Mon 7 Jun 10:00).');
  });

  it('reports a Saturday whose delta fell below zero, naming who said what', () => {
    const { service } = base();
    const before = snap(service);
    service.setAvailability({ person: 'Bob', event: 'b', value: 'No', ...said(t1, 'Bob', 'chat #stewards') });
    const found = detect(service, before);
    expect(found[0]?.type).toBe('red_or_delta_drop');
    expect(text(service, found[0])).toBe(
      'Sat 3 Jul (b Games) now -1, Red: Bob said No for b Games (chat #stewards Mon 7 Jun 10:00). Still open: Morven (not asked), Cat (not asked), Torquil (not asked)',
    );
  });

  it('reports a pencilled lead dropping out as a dropout and as a ground that lost its lead', () => {
    const { service } = base();
    const before = snap(service);
    service.setAvailability({ person: 'Morven', event: 'a', value: 'No', ...said(t1, 'Morven') });
    const found = types(detect(service, before));
    expect(found).toContain('booked_dropout');
    expect(found).toContain('lost_lead');
  });

  it('does not treat a partner nominee as a lead: a ground led by one never "loses" a lead', () => {
    const { service } = base();
    const before = snap(service);
    expect(before.leads.c).toBeNull();
    service.setAvailability({ person: 'Torquil', event: 'c', value: 'No', ...said(t1, 'Torquil') });
    expect(types(detect(service, before))).not.toContain('lost_lead');
  });

  it("reports a move with everyone's previous value, but not as a dropout per person", () => {
    const { service, console: organiser } = base();
    const before = snap(service);
    organiser.approveEventChange('b', { date: '2027-07-17' });
    service.updateEvent({ event: 'b', fields: { date: '2027-07-17' }, source: 'circuit calendar', evidenceAt: t1 });
    const found = detect(service, before);
    const change = text(service, found.find((e) => e.type === 'event_change'));
    expect(change).toContain('moved from Sat 3 Jul to Sat 17 Jul');
    expect(change).toContain('Ann (was Yes), Bob (was Yes)');
    expect(types(found)).not.toContain('booked_dropout');
  });

  it("does not report the organiser's own hand edit back to her", () => {
    const { service, console: organiser } = base();
    const before = snap(service);
    organiser.editCell('Bob', 'b', 'No');
    expect(types(detect(service, before))).not.toContain('event_change');
    expect(types(detect(service, before))).not.toContain('booked_dropout');
  });

  it('reports a newly over-used person once, saying whose limit it is', () => {
    const world = makeWorld({
      people: [person('Ann')],
      events: [games('a', '2027-06-26', { target: 1 }), games('b', '2027-07-03', { target: 1 }), games('c', '2027-07-10', { target: 1 })],
      cells: [cell('Ann', 'a', 'Stewarding'), cell('Ann', 'b', 'Stewarding')],
    });
    const before = snap(world.service);
    world.service.setAvailability({ person: 'Ann', event: 'c', value: 'Yes', ...said(t1, 'Ann') });
    const found = detect(world.service, before);
    const over = found.filter((e) => e.type === 'over_used');
    expect(over).toHaveLength(1);
    expect(text(world.service, over[0])).toContain("That is the rota's limit (two in a row), not Ann's.");
    const after = snap(world.service);
    expect(types(detect(world.service, after))).not.toContain('over_used');
  });

  it('reports a Saturday that newly has no spare', () => {
    const { service } = base();
    service.setAvailability({ person: 'Cat', event: 'b', value: 'Yes', ...said(t1, 'Cat') });
    const before = snap(service);
    service.setAvailability({ person: 'Cat', event: 'b', value: 'No', ...said('2027-06-07T11:00:00+01:00', 'Cat') });
    expect(types(detect(service, before))).toContain('no_spare');
  });

  it('reports a new double booking made by hand', () => {
    const world = makeWorld({ people: [person('Ann')], events: [games('a', '2027-07-10'), games('b', '2027-07-10')], cells: [cell('Ann', 'a', 'Stewarding')] });
    const before = snap(world.service);
    world.console.editCell('Ann', 'b', 'Supporting');
    const found = detect(world.service, before);
    expect(text(world.service, found.find((e) => e.type === 'double_booked'))).toBe('Ann is on the ground at two games on Sat 10 Jul: a Games and b Games.');
  });

  it('reports every Red Saturday on a first run with no snapshot, and only new drops after that', () => {
    const { service } = base();
    service.setAvailability({ person: 'Cat', event: 'c', value: 'No', ...said(t1, 'Cat') });
    expect(types(detect(service, null))).toContain('red_or_delta_drop');
    const before = snap(service);
    expect(types(detect(service, before))).not.toContain('red_or_delta_drop');
  });

  it('ignores staffing problems beyond the lookahead', () => {
    const world = makeWorld({ people: [person('Ann')], events: [games('far', '2027-09-25')], cells: [cell('Ann', 'far', 'Yes')] });
    expect(londonDate('2027-06-07T13:00:00+01:00')).toBe('2027-06-07');
    expect(types(detect(world.service, null))).toEqual([]);
  });
});
