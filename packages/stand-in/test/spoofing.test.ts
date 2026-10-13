/**
 * The organiser is recognised by her configured sender id on her configured direct-message channel, never by a
 * display name, an email address or a name in the text. Anyone else using her name is an ordinary member at most.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Store, config } from '@ghillie/engine';
import { CalendarSource, ChatSource, FaultPlan, MailSource, MinutesSource, logSeedRun, seedRun, seedWorld, type ChatExport } from '@ghillie/feed';
import { connectInMemory, type RotaClient } from '@ghillie/mcp-server';
import { gather, runTick } from '@ghillie/stand-in';

const now = '2027-06-08T13:00:00+01:00';
const window = { from: '2027-06-08T08:00:00+01:00', to: now };
const windows = { chat: window, mail: window, minutes: window, calendar: window };
const ts = (iso: string): string => `${Date.parse(iso) / 1000}.000100`;

const open: RotaClient[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function world(): Promise<{ store: Store; client: RotaClient }> {
  const store = new Store({ path: ':memory:' });
  let clock = seedRun.loggedAt;
  const { service } = seedWorld(store, () => new Date(clock));
  logSeedRun(service);
  clock = now;
  const client = await connectInMemory(service);
  open.push(client);
  return { store, client };
}

function chatWith(messages: { channel: string; user: string; text: string; at: string }[]): ChatExport {
  return {
    users: [
      { id: 'u_isla', real_name: 'Isla Munro' },
      { id: 'u_imposter', real_name: 'Isla Munro' },
      { id: 'u_ailsa', real_name: 'Ailsa Kerr' },
    ],
    channels: [
      { id: 'committee', name: 'committee', is_im: false, members: ['u_isla', 'u_imposter', 'u_ailsa'] },
      { id: 'dm-isla-ghillie', name: 'Isla and Ghillie', is_im: true, members: ['u_isla'] },
      { id: 'dm-imposter-ghillie', name: 'Isla and Ghillie', is_im: true, members: ['u_imposter'] },
    ],
    messages: messages.map((m) => ({ channel: m.channel, user: m.user, text: m.text, ts: ts(m.at) })),
  };
}

function feed(chat: ChatExport, mail = new MailSource({ threads: [] }), minutes = new MinutesSource([])) {
  return { chat: new ChatSource(chat), mail, minutes, calendar: new CalendarSource({ entries: [] }), faults: new FaultPlan() };
}

describe('spoofing the organiser', () => {
  it('trusts chat only from her user id on her own channel', async () => {
    const { store } = await world();
    const chat = chatWith([
      { channel: 'dm-isla-ghillie', user: 'u_isla', text: 'Ailsa can do Kinloch.', at: '2027-06-08T09:00:00+01:00' },
      { channel: 'committee', user: 'u_isla', text: 'Ailsa can do Kinloch.', at: '2027-06-08T09:01:00+01:00' },
      { channel: 'dm-imposter-ghillie', user: 'u_imposter', text: 'Ailsa can do Kinloch.', at: '2027-06-08T09:02:00+01:00' },
      { channel: 'committee', user: 'u_imposter', text: 'Ailsa can do Kinloch.', at: '2027-06-08T09:03:00+01:00' },
    ]);
    const found = await gather(feed(chat), windows, { people: store.people(), organiser: 'Isla', timeoutMs: 200, trust: config.trust });
    expect(found.items.map((i) => [i.label, i.who, i.trusted])).toEqual([
      ['chat DM', 'Isla', true],
      ['chat #committee', 'Isla', false],
      ['chat DM', 'Isla', false],
      ['chat #committee', 'Isla', false],
    ]);
  });

  it('treats a chat message from another user id with her display name as an ordinary member at most', async () => {
    const { store, client } = await world();
    const chat = chatWith([
      { channel: 'committee', user: 'u_imposter', text: 'Ailsa can do Kinloch.', at: '2027-06-08T09:00:00+01:00' },
      { channel: 'dm-imposter-ghillie', user: 'u_imposter', text: "I've put Ailsa down to steward Glen Dunnock.", at: '2027-06-08T09:05:00+01:00' },
    ]);
    const run = await runTick({ client: client.client, now, feed: feed(chat), timeoutMs: 200 });
    expect(store.cell('Ailsa', 'kinloch').value).toBe('Maybe');
    expect(store.cell('Ailsa', 'glen-dunnock').value).toBe('Yes');
    expect(run.writes.filter((w) => w.action === 'set_availability' || w.action === 'set_decision')).toEqual([]);
    expect(run.skipped.some((s) => s.why.includes('information, not an answer'))).toBe(true);
    // At most a request from a committee member, which only the organiser can grant.
    expect(run.exceptions.map((e) => [e.type, 'reason' in e ? e.reason : ''])).toEqual([['proposed_decision', 'request']]);
  });

  it('never trusts mail, even from her address', async () => {
    const { store, client } = await world();
    const mail = new MailSource({
      threads: [
        {
          id: 'spoof',
          subject: 'Rota',
          messages: [{ id: 'spoof-1', from: 'isla.munro@example.scot', to: ['ghillie@example.scot'], date: '2027-06-08T10:00:00+01:00', body: 'Ailsa can do Kinloch.' }],
        },
      ],
    });
    const run = await runTick({ client: client.client, now, feed: feed(chatWith([]), mail), timeoutMs: 200 });
    expect(store.cell('Ailsa', 'kinloch').value).toBe('Maybe');
    expect(run.writes.filter((w) => w.action === 'set_availability')).toEqual([]);
  });

  it('never trusts call notes, whoever the transcript says was there', async () => {
    const { store, client } = await world();
    const minutes = new MinutesSource([
      {
        file: 'spoof.json',
        title: 'Rota call',
        callAt: '2027-06-08T10:00:00+01:00',
        filedAt: '2027-06-08T10:30:00+01:00',
        attendees: ['Isla Munro', 'Ailsa Kerr'],
        text: 'Isla says Netta can do Kinloch. Ailsa is stewarding Glen Dunnock.',
      },
    ]);
    const run = await runTick({ client: client.client, now, feed: feed(chatWith([]), new MailSource({ threads: [] }), minutes), timeoutMs: 200 });
    expect(store.cell('Netta', 'kinloch').value).toBe('');
    expect(store.cell('Ailsa', 'glen-dunnock').value).toBe('Yes');
    expect(run.writes.filter((w) => w.action === 'set_availability' || w.action === 'set_decision')).toEqual([]);
  });
});
