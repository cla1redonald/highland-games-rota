import { describe, expect, it } from 'vitest';
import { config, planRota, ragOf, targetOf, type PlanSettings } from '@ghillie/engine';
import { cell, games, person } from './helpers.js';

const today = '2027-06-07';
const settings: PlanSettings = {
  rules: { stewardsPerArena: 2, overUsedFrom: 3, lookaheadWeeks: 6 },
  roles: { chiefStewards: ['Lead1', 'Lead2'], partnerNominees: ['Partner'] },
};

describe('targets and RAG', () => {
  it('defaults to arenas x stewards per arena, and a per-event target overrides it', () => {
    const event = games('a', '2027-06-26', { arenas: ['x', 'y', 'z'] });
    expect(targetOf(event, 2)).toBe(6);
    expect(targetOf({ ...event, target: 4 }, 2)).toBe(4);
    expect(targetOf({ ...event, target: null }, 2)).toBe(6);
  });

  it('is Green at delta 0 or more, Amber if the Maybes could fill it, Red if short even then', () => {
    expect(ragOf(0, 0)).toBe('Green');
    expect(ragOf(-1, 0)).toBe('Amber');
    expect(ragOf(-2, -1)).toBe('Red');
  });
});

describe('coverage for one game', () => {
  it('counts a Yes, says what is wrong, and leaves places beyond the target blank', () => {
    const plan = planRota([person('Ann')], [games('a', '2027-06-26')], [cell('Ann', 'a', 'Yes')], today, settings);
    const game = plan.games[0]!;
    expect(game.target).toBe(2);
    expect(game.counted).toBe(1);
    expect(game.deltaNow).toBe(-1);
    expect(game.problems.startsWith('Short 1 of 2.')).toBe(true);
  });

  it('follows a target override: a target of 1 with one Yes is delta 0', () => {
    const plan = planRota([person('Ann')], [games('a', '2027-06-26', { target: 1 })], [cell('Ann', 'a', 'Yes')], today, settings);
    expect(plan.games[0]!.deltaNow).toBe(0);
  });

  it('never counts Pipeline, Leadership or Out, and an Out person keeps their answer in the store', () => {
    const people = [person('In1'), person('Pip', { status: 'Pipeline' }), person('Lead', { status: 'Leadership' }), person('Gone', { status: 'Out' })];
    const cells = people.map((p) => cell(p.name, 'a', 'Yes'));
    const plan = planRota(people, [games('a', '2027-06-26', { target: 4 })], cells, today, settings);
    expect(plan.games[0]!.counted).toBe(1);
    expect(plan.chase.map((c) => c.person)).not.toContain('Pip');
    expect(cells.find((c) => c.person === 'Gone')?.value).toBe('Yes');
  });

  it('counts Stewarding but not Supporting, Watching or Not going', () => {
    const people = ['S', 'Su', 'W', 'N'].map((n) => person(n));
    const cells = [cell('S', 'a', 'Stewarding'), cell('Su', 'a', 'Supporting'), cell('W', 'a', 'Watching'), cell('N', 'a', 'Not going')];
    const plan = planRota(people, [games('a', '2027-06-26', { target: 4 })], cells, today, settings);
    expect(plan.games[0]!.counted).toBe(1);
    expect(plan.games[0]!.supporting).toEqual(['Su']);
  });

  it('flags no spare when a game is exactly filled with nobody to lose', () => {
    const plan = planRota([person('A'), person('B')], [games('a', '2027-06-26')], [cell('A', 'a', 'Yes'), cell('B', 'a', 'Yes')], today, settings);
    expect(plan.games[0]!.problems).toBe('No spare: anyone dropping out makes it short.');
    expect(plan.saturdays[0]!.noSpare).toBe(true);
  });

  it('leaves finished and superseded games out of the plan', () => {
    const plan = planRota([person('A')], [games('old', '2027-05-29'), games('gone', '2027-06-26', { type: 'Superseded' })], [], today, settings);
    expect(plan.games).toHaveLength(0);
  });
});

describe('the Saturday block: staff the Saturday, not the game', () => {
  const two = [games('a', '2027-07-10'), games('b', '2027-07-10')];

  it('counts a person who is Yes at two same-day games once, and needs the sum of both targets', () => {
    const plan = planRota([person('Ann')], two, [cell('Ann', 'a', 'Yes'), cell('Ann', 'b', 'Yes')], today, settings);
    const saturday = plan.saturdays[0]!;
    expect(saturday.counted).toBe(1);
    expect(saturday.need).toBe(4);
    expect(saturday.deltaNow).toBe(-3);
  });

  it('places the shared person at one game only, so the game deltas add up to the Saturday (-1 and -2)', () => {
    const plan = planRota([person('Ann')], two, [cell('Ann', 'a', 'Yes'), cell('Ann', 'b', 'Yes')], today, settings);
    const [a, b] = plan.games;
    expect([a!.deltaNow, b!.deltaNow]).toEqual([-1, -2]);
    expect(a!.placed).toContain('Ann');
    expect(b!.placed).not.toContain('Ann');
    expect(a!.problems.startsWith('Short 1 of 2.')).toBe(true);
    expect(b!.problems.startsWith('Short 2 of 2.')).toBe(true);
  });

  it('never crowds out someone who can only make one game: the flexible person is moved instead', () => {
    // Flex comes first in order and could go to either; Only can only do game a, which has one place.
    const events = [games('a', '2027-07-10', { target: 1 }), games('b', '2027-07-10', { target: 1 })];
    const cells = [cell('Flex', 'a', 'Yes'), cell('Flex', 'b', 'Yes'), cell('Only', 'a', 'Yes')];
    const plan = planRota([person('Flex'), person('Only')], events, cells, today, settings);
    expect(plan.games.find((g) => g.id === 'a')!.placed).toEqual(['Only']);
    expect(plan.games.find((g) => g.id === 'b')!.placed).toEqual(['Flex']);
  });

  it('lists a double booking (a hand edit the service would have refused)', () => {
    const plan = planRota([person('Ann')], two, [cell('Ann', 'a', 'Stewarding'), cell('Ann', 'b', 'Supporting')], today, settings);
    expect(plan.saturdays[0]!.doubleBooked).toEqual(['Ann']);
    expect(plan.games[0]!.problems).toContain('Double-booked: Ann also supporting at b Games');
  });
});

describe('placement order', () => {
  it('keeps bookings, then pencilled people, then fills with Yes people up to the target, the rest spare', () => {
    const people = ['Booked', 'Yes1', 'Pencil', 'Yes2'].map((n) => person(n));
    const cells = [
      cell('Booked', 'a', 'Stewarding'),
      cell('Yes1', 'a', 'Yes'),
      cell('Pencil', 'a', 'Yes', { pencilled: true }),
      cell('Yes2', 'a', 'Yes'),
    ];
    const plan = planRota(people, [games('a', '2027-06-26', { target: 3 })], cells, today, settings);
    const game = plan.games[0]!;
    expect(game.booked).toEqual(['Booked']);
    expect(game.placed).toEqual(['Pencil', 'Yes1']);
    expect(game.spare).toEqual(['Yes2']);
    expect(game.deltaNow).toBe(1);
  });

  it('flags someone pencilled at two games on one Saturday and places them at the first', () => {
    const events = [games('a', '2027-07-10'), games('b', '2027-07-10')];
    const cells = [cell('Ann', 'a', 'Yes', { pencilled: true }), cell('Ann', 'b', 'Yes', { pencilled: true })];
    const plan = planRota([person('Ann')], events, cells, today, settings);
    expect(plan.games[0]!.pencilled).toEqual(['Ann']);
    expect(plan.games[1]!.problems).toContain('Pencilled twice this Saturday: Ann (placed at a Games)');
  });

  it('places Chief Stewards last, in preference order, and only when the game would otherwise be short', () => {
    const people = [person('Lead1'), person('Lead2'), person('Vol')];
    const cells = [cell('Lead1', 'a', 'Yes'), cell('Lead2', 'a', 'Yes'), cell('Vol', 'a', 'Yes')];
    const plan = planRota(people, [games('a', '2027-06-26', { target: 2 })], cells, today, settings);
    expect(plan.games[0]!.placed).toEqual(['Vol', 'Lead1']);
    expect(plan.games[0]!.spare).toEqual(['Lead2']);
  });

  it('fills remaining gaps with Maybes the same way, and counts them only in "if Maybes come good"', () => {
    const plan = planRota([person('M')], [games('a', '2027-06-26')], [cell('M', 'a', 'Maybe')], today, settings);
    const game = plan.games[0]!;
    expect(game.maybes).toEqual(['M']);
    expect(game.deltaNow).toBe(-2);
    expect(game.deltaMaybe).toBe(-1);
    expect(game.rag).toBe('Red');
  });
});

describe('over-use: nobody three calendar weeks in a row', () => {
  const weekly = [games('w1', '2027-06-26'), games('w2', '2027-07-03'), games('w3', '2027-07-10')];

  it('flags the third Saturday running, and two in a row is fine', () => {
    const cells = weekly.map((g) => cell('Ann', g.id, 'Stewarding'));
    const plan = planRota([person('Ann')], weekly, cells, today, settings);
    expect(plan.games[1]!.overUsed).toEqual([]);
    expect(plan.games[2]!.overUsed).toEqual([{ person: 'Ann', weeks: 3 }]);
    expect(plan.games[2]!.problems).toContain('Over-used: Ann (3rd Saturday running)');
  });

  it('resets after a week off, whether or not that week has games', () => {
    const gap = [games('w1', '2027-06-26'), games('w2', '2027-07-03'), games('w4', '2027-07-17'), games('w5', '2027-07-24')];
    const cells = gap.map((g) => cell('Ann', g.id, 'Stewarding'));
    const plan = planRota([person('Ann')], gap, cells, today, settings);
    expect(plan.games.flatMap((g) => g.overUsed)).toEqual([]);
  });

  it('counts only Saturdays where the person is going, and puts the fewest weeks running first', () => {
    const cells = [cell('Ann', 'w1', 'Yes'), cell('Ann', 'w2', 'Yes'), cell('Ann', 'w3', 'Stewarding'), cell('Bob', 'w1', 'Yes'), cell('Bob', 'w2', 'Yes')];
    const events = weekly.map((g) => ({ ...g, target: 1 }));
    const plan = planRota([person('Bob'), person('Ann')], events, cells, today, settings);
    // w1: a tie, so row order: Bob. Ann's Yes at w1 is not going, so at w2 she is on one week running to Bob's two.
    expect(plan.games[0]!.placed).toEqual(['Bob']);
    expect(plan.games[1]!.placed).toEqual(['Ann']);
    expect(plan.games.flatMap((g) => g.overUsed)).toEqual([]);
  });

  it('looks ahead at bookings: someone booked the next Saturday is placed after everyone else', () => {
    const events = weekly.map((g) => ({ ...g, target: 1 }));
    // Ann is booked at w1 and w3. Putting her at w2 would make three running, so Bob gets w2.
    const cells = [cell('Ann', 'w1', 'Stewarding'), cell('Ann', 'w2', 'Yes'), cell('Ann', 'w3', 'Stewarding'), cell('Bob', 'w2', 'Yes')];
    const plan = planRota([person('Ann'), person('Bob')], events, cells, today, settings);
    expect(plan.games[1]!.placed).toEqual(['Bob']);
    expect(plan.games[1]!.spare).toEqual(['Ann']);
  });

  it('still places a tired person when the game cannot be filled otherwise, and flags it', () => {
    const events = weekly.map((g) => ({ ...g, target: 1 }));
    const cells = [cell('Ann', 'w1', 'Stewarding'), cell('Ann', 'w2', 'Stewarding'), cell('Ann', 'w3', 'Yes')];
    const plan = planRota([person('Ann')], events, cells, today, settings);
    expect(plan.games[2]!.placed).toEqual(['Ann']);
    expect(plan.games[2]!.overUsed).toEqual([{ person: 'Ann', weeks: 3 }]);
  });
});

describe('leads, newcomers and the chase list', () => {
  it('takes the lead from Chief Stewards booked or pencilled, never a partner nominee', () => {
    const people = [person('Lead2'), person('Partner'), person('Vol')];
    const events = [games('a', '2027-06-26'), games('b', '2027-07-03')];
    const cells = [
      cell('Lead2', 'a', 'Yes', { pencilled: true, pencilledAsLead: true }),
      cell('Partner', 'b', 'Yes', { pencilled: true, pencilledAsLead: true }),
      cell('Vol', 'b', 'Yes'),
    ];
    const plan = planRota(people, events, cells, today, settings);
    expect(plan.games[0]!.lead).toBe('Lead2');
    expect(plan.games[1]!.lead).toBeNull();
    expect(plan.games[1]!.partnerLead).toBe('Partner');
  });

  it("marks someone new at their first counted game, unless they have stewarded before", () => {
    const people = [person('New', { stewardedBefore: false }), person('Old', { stewardedBefore: true })];
    const events = [games('a', '2027-06-26'), games('b', '2027-07-03')];
    const cells = [cell('New', 'a', 'Yes'), cell('New', 'b', 'Yes'), cell('Old', 'a', 'Yes')];
    const plan = planRota(people, events, cells, today, settings);
    expect(plan.games[0]!.newcomers).toEqual(['New']);
    expect(plan.games[1]!.newcomers).toEqual([]);
  });

  it('chases Maybe, Unknown and not asked within the lookahead, and flags cells pending a call', () => {
    const plan = planRota(
      [person('A'), person('B'), person('C')],
      [games('a', '2027-06-26'), games('far', '2027-09-25')],
      [cell('A', 'a', 'Maybe', { note: 'Pending a call with Isla on Wed 9 Jun' }), cell('B', 'a', 'Yes')],
      today,
      settings,
    );
    expect(plan.chase.map((c) => [c.person, c.event, c.value, c.pendingCall])).toEqual([
      ['A', 'a', 'Maybe', true],
      ['C', 'a', '', false],
    ]);
  });

  it('uses the shipped config by default', () => {
    const plan = planRota([person('Morven')], [games('a', '2027-06-26')], [cell('Morven', 'a', 'Yes', { pencilled: true })], today);
    expect(config.roles.chiefStewards[0]).toBe('Morven');
    expect(plan.games[0]!.lead).toBe('Morven');
  });
});
