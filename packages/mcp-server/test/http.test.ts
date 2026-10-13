import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '@ghillie/engine';
import { seedWorld } from '@ghillie/feed';
import { startHttpServer, toolNames, type RunningHttpServer } from '@ghillie/mcp-server';

const now = '2027-06-07T13:00:00+01:00';
// Made up for this test run only.
const bearer = randomBytes(16).toString('hex');

describe('the MCP server over Streamable HTTP, on loopback', () => {
  let running: RunningHttpServer;

  beforeAll(async () => {
    const store = new Store({ path: ':memory:' });
    const { service } = seedWorld(store, () => new Date(now));
    running = await startHttpServer({ service, token: bearer });
  });

  afterAll(async () => {
    await running?.close();
  });

  const connect = async (given: string): Promise<Client> => {
    const client = new Client({ name: 'http-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { authorization: `Bearer ${given}` } } }));
    return client;
  };

  it('binds to the loopback interface', () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('serves the same eight tools with the same closed schemas, given the token', async () => {
    const client = await connect(bearer);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...toolNames].sort());
    expect(tools.every((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties === false)).toBe(true);
    const refused = await client.callTool({ name: 'set_decision', arguments: { person: 'Senga', event: 'kinloch', value: 'Stewarding', source: 'mail', evidenceAt: now, approved: true } });
    expect(refused.isError).toBe(true);
    await client.close();
  });

  it('refuses a request without the token, or with the wrong one', async () => {
    const wrong = randomBytes(16).toString('hex');
    const attempts: Record<string, string>[] = [{}, { authorization: `Bearer ${wrong}` }];
    for (const headers of attempts) {
      const res = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
      expect(res.status).toBe(401);
    }
    await expect(connect(wrong)).rejects.toThrow();
  });

  it('will not bind anywhere but loopback, or start without a real token', async () => {
    const store = new Store({ path: ':memory:' });
    const { service } = seedWorld(store, () => new Date(now));
    await expect(startHttpServer({ service, token: bearer, host: '0.0.0.0' as '127.0.0.1' })).rejects.toThrow(/loopback only/);
    await expect(startHttpServer({ service, token: 'short' })).rejects.toThrow(/bearer token/);
  });
});
