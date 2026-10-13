import { describe, expect, it } from 'vitest';
import {
  countBullets,
  diffPlans,
  emDash,
  footprint,
  formatWhen,
  londonInstant,
  planRota,
  renderMessage,
  renderPlanHtml,
  renderPlanText,
  watchdogProblems,
  weeksAway,
  type RunSummary,
} from '@ghillie/engine';
import { cell, games, person } from './helpers.js';

describe('dates', () => {
  it('builds London wall-clock instants in summer and winter', () => {
    expect(londonInstant('2027-06-07', '13:00')).toBe('2027-06-07T13:00:00+01:00');
    expect(londonInstant('2027-01-11', '13:00')).toBe('2027-01-11T13:00:00+00:00');
  });

  it('gives games a Friday-to-Sunday footprint and a setup day one day', () => {
    expect(footprint({ type: 'Games', date: '2027-07-10' })).toEqual({ start: '2027-07-09', end: '2027-07-11' });
    expect(footprint({ type: 'Setup day', date: '2027-06-25' })).toEqual({ start: '2027-06-25', end: '2027-06-25' });
  });

  it('formats in London time and counts whole weeks', () => {
    expect(formatWhen('2027-06-08T10:02:00Z')).toBe('Tue 8 Jun 11:02');
    expect(weeksAway('2027-07-17', '2027-06-07')).toBe(5);
  });
});

describe('the message to the organiser', () => {
  const events = [games('balvaig', '2027-07-10', { village: 'Balvaig Bridge' })];
  const context = { events, organiser: 'Isla' };
  const reading = { person: 'Ailsa', source: 'chat #stewards', at: '2027-06-08T11:02:00+01:00', dateWords: ['mid-July'], verdicts: [{ event: 'balvaig', value: 'Maybe' as const }] };

  it('is empty when there are no exceptions and no readings', () => {
    expect(renderMessage({ exceptions: [], readings: [], context })).toBe('');
  });

  it('says nothing needs her when readings are the only content', () => {
    const text = renderMessage({ exceptions: [], readings: [reading], context });
    expect(text.split('\n')[0]).toBe('Ghillie: nothing needs you, readings below');
    expect(text).toContain('• Ailsa (chat Tue 8 Jun 11:02: "mid-July"): Balvaig Bridge Maybe');
  });

  it('keeps to ten bullets in all and says how many more are in the run log', () => {
    const exceptions = Array.from({ length: 12 }, (_, i) => ({ type: 'write_limit' as const, limit: 60 + i }));
    const text = renderMessage({ exceptions, readings: [reading], context });
    expect(countBullets(text)).toBe(10);
    expect(text).toContain('• 4 more in the run log');
    expect(text.split('\n')[0]).toBe('Ghillie: 12 things need you');
    expect(text.includes(emDash)).toBe(false);
  });
});

describe('the watchdog', () => {
  const summary = (fields: Partial<RunSummary> = {}): string =>
    JSON.stringify({
      window: ['2027-06-16T12:00:00+01:00', '2027-06-16T13:00:00+01:00'],
      mode: 'full',
      writes: 0,
      refused: 0,
      exceptions: 0,
      messaged: false,
      sources: { chat: 'ok' },
      sourceWindows: {},
      snapshot: { saturdays: {}, games: {}, leads: {}, overUsed: [], noSpare: [], booked: [], doubleBooked: [], events: {} },
      pipelineProposed: [],
      read: [],
      toolCalls: 1,
      ...fields,
    });

  it('alerts when a scheduled slot has no run logged', () => {
    const runs = [{ loggedAt: '2027-06-16T13:00:00+01:00', summary: summary() }];
    expect(watchdogProblems('2027-06-16T20:00:00+01:00', runs)).toEqual(['No run was logged for the 18:00 slot today. Last run: Wed 16 Jun 13:00.']);
  });

  it('is quiet when both runs happened, and at weekends', () => {
    const runs = [
      { loggedAt: '2027-06-16T13:00:00+01:00', summary: summary() },
      { loggedAt: '2027-06-16T18:00:00+01:00', summary: summary() },
    ];
    expect(watchdogProblems('2027-06-16T20:00:00+01:00', runs)).toEqual([]);
    expect(watchdogProblems('2027-06-19T20:00:00+01:00', [])).toEqual([]);
  });

  it('alerts when a run had something for her but could not message her', () => {
    const runs = [
      { loggedAt: '2027-06-16T13:00:00+01:00', summary: summary({ exceptions: 2, messaged: false, sources: { chat: 'timed out' } }) },
      { loggedAt: '2027-06-16T18:00:00+01:00', summary: summary() },
    ];
    expect(watchdogProblems('2027-06-16T20:00:00+01:00', runs)).toEqual([
      'The run at Wed 16 Jun 13:00 found 2 thing(s) for you but could not message you (sources not read: chat).',
    ]);
  });
});

describe('the plan renderers', () => {
  const plan = planRota(
    [person('Ann', { stewardedBefore: false }), person('Bob')],
    [games('a', '2027-06-26', { label: 'Glen <Test> Games' })],
    [cell('Ann', 'a', 'Yes'), cell('Bob', 'a', 'Maybe')],
    '2027-06-07',
  );

  it('prints a terminal plan with places, Short and Maybes', () => {
    const text = renderPlanText(plan);
    expect(text).toContain('Places: Ann (new) | Short');
    expect(text).toContain('Maybe: Bob');
    expect(text).toContain('Problem: Short 1 of 2. Maybes who could fill it: Bob.');
  });

  it('writes accessible, escaped HTML with a caption and header scopes', () => {
    const html = renderPlanHtml(plan);
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('<caption>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('Glen &lt;Test&gt; Games');
    expect(html.includes(emDash)).toBe(false);
  });

  it('lists what changed between two plans', () => {
    const later = planRota([person('Ann'), person('Bob')], [games('a', '2027-06-26', { label: 'Glen <Test> Games' })], [cell('Ann', 'a', 'Yes'), cell('Bob', 'a', 'Yes')], '2027-06-07');
    expect(diffPlans(plan, later)).toEqual(['Glen <Test> Games: -1 Amber to 0 Green; in: Bob']);
  });
});
