import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrganiserConsole, RotaService, Store, type RotaView } from '@ghillie/engine';
import { seedWorld } from '@ghillie/feed';
import { callTool, connectInMemory, createRotaServer, toolNames } from '@ghillie/mcp-server';

const serverEntry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const now = '2027-06-07T13:00:00+01:00';
const evidence = { source: 'chat #committee', evidenceAt: '2027-06-07T11:00:00+01:00' };

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = Array.isArray(result.content) ? (result.content as { text?: string }[]) : [];
  return content.map((c) => c.text ?? '').join(' ');
}

describe('the MCP server over stdio', () => {
  let dbPath: string;
  let client: Client;

  beforeAll(async () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'ghillie-mcp-')), 'rota.db');
    const store = new Store({ path: dbPath });
    const { console: organiser } = seedWorld(store, () => new Date(now));
    organiser.setMode('full');
    // The organiser approves one booking on her own path, before the server starts.
    organiser.approveDecision('Dougie', 'inverallt', 'Stewarding');
    organiser.approveDecision('Dougie', 'balvaig', 'Stewarding');
    store.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--conditions=ghillie-source', '--import', 'tsx', serverEntry],
      env: { ...(process.env as Record<string, string>), GHILLIE_DB: dbPath, GHILLIE_CLOCK: now },
      stderr: 'pipe',
    });
    client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it('exposes exactly the eight rota tools, deny by default, each with a closed input schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...toolNames].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
  });

  it('takes no actor, approver, approval flag, mode or recipient in any tool schema', async () => {
    const { tools } = await client.listTools();
    const forbidden = ['actor', 'approver', 'approved', 'mode', 'to', 'recipient', 'organiser', 'who'];
    for (const tool of tools) {
      const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(properties.filter((p) => forbidden.includes(p)), tool.name).toEqual([]);
    }
    const decision = tools.find((t) => t.name === 'set_decision');
    expect(Object.keys((decision?.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain('saidBy');
  });

  it('refuses by schema a call that supplies an actor, an approval or a recipient', async () => {
    const decision = { person: 'Senga', event: 'kinloch', value: 'Stewarding', ...evidence };
    const attempts: [string, Record<string, unknown>][] = [
      ['set_decision', { ...decision, actor: 'Isla' }],
      ['set_decision', { ...decision, approved: true }],
      ['set_decision', { ...decision, approver: 'Isla' }],
      ['set_decision', { ...decision, saidBy: 'Isla' }],
      ['update_event', { event: 'strathcorrie', fields: { date: '2027-07-24' }, ...evidence, saidBy: 'Isla' }],
      ['update_event', { event: 'strathcorrie', fields: { date: '2027-07-24' }, ...evidence, approved: true }],
      ['message_organiser', { exceptions: [], readings: [], to: 'Dougie' }],
      ['message_organiser', { exceptions: [], readings: [], recipient: 'Dougie' }],
      ['log_run', { window: [now, now], sources: {}, sourceWindows: {}, exceptions: 0, read: [], toolCalls: 0, mode: 'full' }],
      ['update_person', { person: 'Ailsa', fields: { stewardedBefore: true }, ...evidence, saidBy: 'Ailsa' }],
      ['update_event', { event: 'kinloch', fields: { label: 'Kinloch Highland Games' }, ...evidence }],
    ];
    for (const [name, args] of attempts) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    const store = new Store({ path: dbPath });
    expect(store.cell('Senga', 'kinloch').value).not.toBe('Stewarding');
    expect(store.outbox()).toHaveLength(0);
    store.close();
  });

  it('refuses a set_decision without an approval record, in the service', async () => {
    const result = await callTool(client, 'set_decision', { person: 'Senga', event: 'kinloch', value: 'Stewarding', ...evidence });
    expect(result).toMatchObject({ ok: false, refusal: 'approval_missing' });
  });

  it('records a decision the organiser approved on her own path, once, and refuses the clashing one unchanged', async () => {
    expect(await callTool(client, 'set_decision', { person: 'Dougie', event: 'inverallt', value: 'Stewarding', ...evidence })).toMatchObject({ ok: true, changed: true });
    expect(await callTool(client, 'set_decision', { person: 'Dougie', event: 'balvaig', value: 'Stewarding', ...evidence })).toMatchObject({
      ok: false,
      refusal: 'double_booked',
      clashesWith: 'inverallt',
    });
  });

  it('reads the rota, including the approvals the organiser granted', async () => {
    const result = await callTool<{ ok: boolean; view: RotaView }>(client, 'read_rota', {});
    expect(result.view.organiser).toBe('Isla');
    expect(result.view.grants.map((g) => g.status)).toEqual(['used', 'ready']);
  });

  it('writes an answer and returns a typed result, and a refusal, not an error, for older evidence', async () => {
    const write = { person: 'Gregor', event: 'glen-dunnock', value: 'Yes', source: 'chat #stewards', saidBy: 'Gregor' };
    expect(await callTool(client, 'set_availability', { ...write, evidenceAt: '2027-06-07T10:00:00+01:00' })).toMatchObject({ ok: true, changed: true, value: 'Yes' });
    expect(await callTool(client, 'set_availability', { ...write, value: 'No', evidenceAt: '2027-06-01T10:00:00+01:00' })).toMatchObject({
      ok: false,
      refusal: 'newer_entry',
    });
  });

  it('builds the message itself and sends it only to the organiser', async () => {
    const sent = await callTool(client, 'message_organiser', { exceptions: [{ type: 'no_spare', saturday: '2027-07-10', events: ['balvaig', 'inverallt'] }], readings: [] });
    expect(sent).toMatchObject({ ok: true, to: 'Isla' });
    expect(String(sent.text)).toContain('has no spare: anyone dropping out makes it short.');
  });

  it('traces every tool call with its duration', () => {
    const store = new Store({ path: dbPath });
    const trace = store.trace();
    store.close();
    expect(trace.length).toBeGreaterThanOrEqual(6);
    expect(trace.every((t) => t.durationMs >= 0 && t.argsDigest.length === 16)).toBe(true);
    expect(trace.some((t) => t.outcome === 'approval_missing' && !t.ok)).toBe(true);
  });

  it('fails closed on a schema error, naming the problem', async () => {
    const result = await client.callTool({ name: 'set_availability', arguments: { person: 'Gregor' } });
    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
  });
});

describe('the MCP server in memory', () => {
  it('registers only the tools on the allow-list', async () => {
    const store = new Store({ path: ':memory:' });
    const service = new RotaService({ store, clock: () => new Date(now) });
    const server = createRotaServer({ service, enabledTools: ['read_rota'] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await server.connect(b);
    await client.connect(a);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['read_rota']);
    await client.close();
  });

  it('refuses decisions in tuning mode, the mode coming from the store', async () => {
    const store = new Store({ path: ':memory:' });
    const clock = (): Date => new Date(now);
    const { service } = seedWorld(store, clock);
    const organiser = new OrganiserConsole(store, clock);
    organiser.setMode('tuning');
    organiser.approveDecision('Fergus', 'glen-dunnock', 'Stewarding');
    const { client, close } = await connectInMemory(service);
    const result = await callTool(client, 'set_decision', { person: 'Fergus', event: 'glen-dunnock', value: 'Stewarding', source: 'chat #committee', evidenceAt: '2027-06-07T09:14:00+01:00' });
    expect(result).toMatchObject({ ok: false, refusal: 'decision_needs_full_mode' });
    await close();
  });
});
