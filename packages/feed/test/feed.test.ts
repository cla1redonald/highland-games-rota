import { describe, expect, it } from 'vitest';
import { Store } from '@ghillie/engine';
import {
  CalendarSource,
  ChatSource,
  FaultPlan,
  MailSource,
  MinutesSource,
  consoleActions,
  events,
  logSeedRun,
  people,
  schedule,
  seedRun,
  seedWorld,
} from '@ghillie/feed';

const fortnight = { from: '2027-06-04T18:00:00+01:00', to: '2027-06-18T18:00:00+01:00' };

describe('the fictional world', () => {
  it('covers every status, three Chief Stewards, a partner nominee and an organiser', () => {
    const statuses = new Set(people.map((p) => p.status));
    expect([...statuses].sort()).toEqual(['In', 'Leadership', 'Maybe', 'Out', 'Pipeline']);
    expect(people.filter((p) => p.role === 'Chief Steward').map((p) => p.name)).toEqual(['Morven', 'Hamish', 'Eilidh']);
    expect(people.find((p) => p.name === 'Isla')?.role).toBe('Organiser');
    expect(people.every((p) => !p.email || p.email.endsWith('@example.scot'))).toBe(true);
  });

  it('has six Saturday games with two on one Saturday, and a Friday setup day', () => {
    const gamesDays = events.filter((e) => e.type === 'Games').map((e) => e.date);
    expect(gamesDays).toHaveLength(6);
    expect(gamesDays.filter((d) => d === '2027-07-10')).toHaveLength(2);
    expect(events.find((e) => e.type === 'Setup day')?.date).toBe('2027-06-25');
  });

  it('seeds a store with history and a previous run to anchor on', () => {
    const store = new Store({ path: ':memory:' });
    let now = seedRun.loggedAt;
    const { service } = seedWorld(store, () => new Date(now));
    logSeedRun(service);
    now = '2027-06-07T13:00:00+01:00';
    const view = service.read();
    expect(view.mode).toBe('full');
    expect(view.lastRun?.summary.window).toEqual([seedRun.from, seedRun.to]);
    expect(store.log().some((e) => e.who === 'seed' && e.evidenceAt)).toBe(true);
  });
});

describe('chat', () => {
  it('lists messages in a window, oldest first, without huddle notices', async () => {
    const chat = new ChatSource();
    const monday = await chat.messages({ from: '2027-06-07T00:00:00+01:00', to: '2027-06-07T13:00:00+01:00' });
    expect(monday.map((m) => m.user)).toEqual(['u_isla', 'u_senga', 'u_senga', 'u_fergus']);
    const all = await chat.messages(fortnight);
    expect(all.some((m) => m.subtype === 'huddle_started')).toBe(false);
  });

  it('finds the huddle a call started in, by time', () => {
    const huddles = new ChatSource().huddlesAround('2027-06-09T14:03:00+01:00', 15);
    expect(huddles).toHaveLength(1);
    expect(huddles[0]!.members).toEqual(['u_isla', 'u_kirsty']);
  });

  it('uses no identifier shaped like a real workspace id', () => {
    const chat = new ChatSource();
    expect(chat.user('u_isla')?.real_name).toBe('Isla Munro');
  });
});

describe('mail', () => {
  const lastTick = { from: '2027-06-18T17:00:00+01:00', to: '2027-06-18T18:00:00+01:00' };

  it('lists a thread whose newest reply the search listing does not show', async () => {
    const mail = new MailSource();
    const listing = await mail.search(lastTick);
    expect(listing.map((l) => l.threadId)).toEqual(['thread-piping']);
    expect(listing[0]!.messages.map((m) => m.id)).toEqual(['msg-piping-1', 'msg-piping-2']);
  });

  it('shows the reply once the thread is opened', async () => {
    const thread = await new MailSource().getThread('thread-piping', lastTick.to);
    expect(thread?.messages.at(-1)?.body).toContain("I'll have to pull out of Glen Dunnock");
  });
});

describe('call notes and the calendar', () => {
  it('returns notes by when they were filed, not when the call was', async () => {
    const minutes = new MinutesSource();
    const filedTuesday = await minutes.filed({ from: '2027-06-15T13:00:00+01:00', to: '2027-06-15T18:00:00+01:00' });
    expect(filedTuesday.map((n) => n.callAt)).toEqual(['2027-06-11T11:00:00+01:00']);
  });

  it('keeps the misheard name and the wrong title, as the recording service did', async () => {
    const [note] = await new MinutesSource().filed({ from: '2027-06-09T14:00:00+01:00', to: '2027-06-09T15:00:00+01:00' });
    expect(note?.title).toBe('Kinloch sponsors catch-up');
    expect(note?.attendees).toContain('Christy Imrie');
  });

  it('shows the Strathcorrie move on the Thursday it was made', async () => {
    const updates = await new CalendarSource().updates({ from: '2027-06-10T00:00:00+01:00', to: '2027-06-10T13:00:00+01:00' });
    expect(updates).toMatchObject([{ uid: 'strathcorrie', date: '2027-07-24', by: 'Circuit secretary' }]);
  });
});

describe('faults and the schedule', () => {
  it('makes a source hang at the chosen tick, and only then', async () => {
    const faults = new FaultPlan(schedule().faults);
    faults.setNow('2027-06-15T13:00:00+01:00');
    expect(faults.shouldHang('mail')).toBe(true);
    expect(faults.shouldHang('chat')).toBe(false);
    const hung = faults.wrap('mail', () => Promise.resolve('read'));
    const outcome = await Promise.race([hung, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20))]);
    expect(outcome).toBe('still waiting');
    faults.setNow('2027-06-15T18:00:00+01:00');
    await expect(faults.wrap('mail', () => Promise.resolve('read'))).resolves.toBe('read');
  });

  it('skips one tick and lists the organiser\'s own console actions', () => {
    expect(schedule().skip.map((s) => s.at)).toEqual(['2027-06-16T18:00:00+01:00']);
    expect(consoleActions().map((a) => a.action)).toEqual(['approve_decision', 'approve_decision', 'pencil', 'approve_event', 'approve', 'edit', 'approve_decision', 'approve_decision']);
  });
});
