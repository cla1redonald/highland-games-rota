import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emDash, countBullets } from '@ghillie/engine';
import type { Window } from '@ghillie/feed';
import { createDemoWorld, fortnightTicks, playTicks, type DemoWorld, type TickResult } from '@ghillie/demo';

let world: DemoWorld;
let results: TickResult[];

beforeAll(async () => {
  world = await createDemoWorld(':memory:');
  results = await playTicks(world, fortnightTicks());
});

afterAll(async () => {
  await world.close();
});

const runAt = (at: string) => results.find((r) => r.tick.at === at)?.run;
const messages = (): string[] => world.store.outbox().map((m) => m.text);

describe('the seeded fortnight', () => {
  it('plays twenty half-day ticks, one of them slept through', () => {
    expect(results).toHaveLength(20);
    expect(results.filter((r) => !r.run).map((r) => r.tick.at)).toEqual(['2027-06-16T18:00:00+01:00']);
  });

  it('fires the watchdog on the evening a run was missed, and only then', () => {
    const alerts = results.filter((r) => r.watchdog.length);
    expect(alerts.map((r) => r.tick.at)).toEqual(['2027-06-16T18:00:00+01:00']);
  });

  it('messages only the organiser, in plain text with no em dash and at most ten bullets', () => {
    expect(world.store.outbox().every((m) => m.to === 'Isla')).toBe(true);
    for (const text of messages()) {
      expect(text.includes(emDash)).toBe(false);
      expect(countBullets(text)).toBeLessThanOrEqual(10);
    }
  });

  it('never lets a medical or personal reason out, anywhere', () => {
    const everything = [JSON.stringify(world.store.log()), JSON.stringify(world.store.people()), JSON.stringify(world.store.cells()), ...messages(), JSON.stringify(results)].join(
      '\n',
    );
    for (const word of [/gall/i, /bladder/i, /\bop\b/i, /Feis/, /\bband's\b/i, /Inverness/]) expect(everything).not.toMatch(word);
  });

  it("reads Gregor's span as dates only, and Ailsa's vague phrase as Maybe with the words quoted", () => {
    const text = messages().find((m) => m.includes('Gregor (mail'));
    expect(text).toContain('Gregor (mail Tue 8 Jun 12:15: "until the Auchterbrae Games", "Tuesday 29 June", "a fortnight")');
    expect(messages().some((m) => m.includes("Ailsa's \"mid-July\" does not pin down days"))).toBe(true);
  });

  it('treats the instruction from a volunteer as data: Dougie never becomes a Chief Steward', () => {
    expect(world.store.cell('Dougie', 'kinloch')).toMatchObject({ value: 'Maybe', note: '"Kinloch-on-Spey": asked to be put down, not a confirmed answer' });
    expect(world.store.person('Dougie')?.role).toBe('Tug-of-war marshal');
  });

  it("refuses the late call notes because Isla's hand edit is newer", () => {
    const run = runAt('2027-06-15T18:00:00+01:00');
    expect(run?.refused.map((w) => [w.person, w.event, w.outcome])).toEqual([['Dougie', 'auchterbrae', 'newer_entry']]);
    expect(world.store.cell('Dougie', 'auchterbrae').value).toBe('Yes');
  });

  it('asks for approval before moving Strathcorrie, then moves it and names who to ask again', () => {
    expect(runAt('2027-06-10T13:00:00+01:00')?.exceptions.map((e) => e.type)).toEqual(['event_change']);
    expect(runAt('2027-06-10T13:00:00+01:00')?.exceptions[0]?.detail).toContain('Approve the move in the console');
    const moved = runAt('2027-06-10T18:00:00+01:00')?.message ?? '';
    expect(moved).toContain('Strathcorrie Games moved from Sat 17 Jul to Sat 24 Jul');
    expect(moved).toContain('Morven (was Yes)');
    expect(world.store.event('strathcorrie')?.date).toBe('2027-07-24');
  });

  it('suggests Bridie once, suppresses the second mention, and adds her only after Isla approves', () => {
    expect(runAt('2027-06-07T13:00:00+01:00')?.exceptions.some((e) => e.type === 'pipeline_suggestion')).toBe(true);
    expect(runAt('2027-06-10T13:00:00+01:00')?.skipped.some((s) => s.what.startsWith('Bridie Tosh suggested again'))).toBe(true);
    expect(world.store.person('Bridie')).toMatchObject({ status: 'Pipeline', surname: 'Tosh' });
    expect(world.store.approvals().filter((a) => a.proposalId === 'proposal-1').map((a) => a.kind)).toEqual(['grant', 'use']);
  });

  it('reads the mail source again in full after it timed out', () => {
    expect(runAt('2027-06-15T13:00:00+01:00')?.exceptions.map((e) => e.type)).toEqual(['source_unreadable']);
    expect(runAt('2027-06-15T18:00:00+01:00')?.writes.some((w) => w.person === 'Netta' && w.value === 'Yes')).toBe(true);
  });

  it('refuses the double booking on the Saturday two games share', () => {
    expect(runAt('2027-06-17T18:00:00+01:00')?.exceptions.map((e) => e.type)).toEqual(['double_booked']);
    expect(world.store.cell('Dougie', 'inverallt').value).toBe('Stewarding');
    expect(world.store.cell('Dougie', 'balvaig').value).not.toBe('Stewarding');
  });

  it('finds the piper dropping out at the last moment, in a reply the mail listing did not show', () => {
    const run = runAt('2027-06-18T18:00:00+01:00');
    expect(run?.exceptions.map((e) => e.detail)).toContain('Calum, stewarding at Glen Dunnock Games, now says No (mail Fri 18 Jun 17:40).');
  });

  it("flags a lost lead when Morven drops Kinloch, and Eilidh's offer to lead as Isla's call", () => {
    const types = runAt('2027-06-17T13:00:00+01:00')?.exceptions.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['booked_dropout', 'lost_lead', 'proposed_decision']));
  });

  it("does not report Isla's own bookings back to her", () => {
    expect(runAt('2027-06-07T13:00:00+01:00')?.exceptions.map((e) => e.type)).toEqual(['pipeline_suggestion']);
  });

  it('makes zero net writes when the same windows are replayed', async () => {
    const windows = new Map<string, Window>();
    for (const r of results) if (r.run) windows.set(r.tick.at, { from: r.run.window[0], to: r.run.window[1] });
    const nonRun = (): number => world.store.log().filter((e) => e.entity !== 'run').length;
    const before = nonRun();
    const replay = await playTicks(world, fortnightTicks(), { windows, applyConsole: false, watchdog: false });
    const changed = replay.flatMap((r) => r.run?.writes ?? []).filter((w) => w.outcome === 'changed' || w.outcome === 'note');
    expect(changed).toEqual([]);
    expect(nonRun()).toBe(before);
  });
});
