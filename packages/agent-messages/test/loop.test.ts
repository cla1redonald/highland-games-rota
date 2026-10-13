/**
 * The hand-written loop, against the real Phase 1a MCP server in memory and a stubbed API client that replays each
 * stop reason. No live call is made here; the one live test at the bottom runs only when asked to and a key is set.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@ghillie/engine';
import { logSeedRun, seedRun, seedWorld } from '@ghillie/feed';
import { connectInMemory } from '@ghillie/mcp-server';
import { CallGuard, RunRecorder, SYSTEM_PROMPT, SchemaValidator, ToolGate, loadCatalogue, optionalCount, prepareTick, readView, renderBrief, rotaTools, strictOptionalLimit } from '@ghillie/agent-kit';
import { Ledger } from '@ghillie/ledger';
import {
  ReplayPort,
  RecordingPort,
  buildRequest,
  fallbackBeta,
  hasCredentials,
  livePort,
  logReminder,
  runLoop,
  runMessagesTick,
  type MessagesPort,
  type Params,
  type Reply,
} from '@ghillie/agent-messages';

const now = '2027-06-07T13:00:00+01:00';
const model = 'claude-sonnet-5-5';

type Block = Record<string, unknown>;

function reply(stop: string, content: Block[], usage: Partial<Reply['usage']> = {}): Reply {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: stop === 'refusal' ? { type: 'refusal', category: 'cyber', explanation: null } : null,
    container: null,
    context_management: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  } as unknown as Reply;
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input });
const text = (t: string): Block => ({ type: 'text', text: t });

/** Returns scripted replies in order and keeps every request it was sent. */
class Stub implements MessagesPort {
  readonly requests: Params[] = [];
  constructor(private readonly script: (Reply | ((n: number) => Reply))[]) {}
  create(params: Params): Promise<Reply> {
    this.requests.push(structuredClone(params));
    const next = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    if (!next) return Promise.reject(new Error('stub has no reply'));
    return Promise.resolve(typeof next === 'function' ? next(this.requests.length) : next);
  }
}

async function harness() {
  const store = new Store({ path: ':memory:' });
  let clock = seedRun.loggedAt;
  const { service } = seedWorld(store, () => new Date(clock));
  logSeedRun(service);
  clock = now;
  const { client, close } = await connectInMemory(service);
  const tools = await loadCatalogue(client);
  const tick = prepareTick(await readView(client), { items: [], sources: { chat: 'ok', mail: 'ok', minutes: 'ok', calendar: 'ok' }, windows: {} }, now);
  const recorder = new RunRecorder(tick);
  const gate = new ToolGate(client, new CallGuard({ validator: new SchemaValidator(tools), allowed: rotaTools }), recorder);
  const lines: string[] = [];
  const ledger = new Ledger({ path: join(mkdtempSync(join(tmpdir(), 'loop-')), 'spend.jsonl'), print: () => undefined, stop: (m) => { throw new Error(m); } });
  const options = { gate, tools, brief: renderBrief(tick), model, meter: ledger, label: 'test', maxTurns: 8, print: (l: string) => lines.push(l) };
  return { store, client, close, tools, tick, recorder, gate, ledger, lines, options };
}

const logRunArgs = (tick: ReturnType<typeof prepareTick>) => ({ ...tick.logRun, exceptions: 0, toolCalls: 2 });

describe('the Messages API loop', () => {
  it('runs tool_use turns to end_turn, resending the full history and appending each turn as returned', async () => {
    const h = await harness();
    const first = reply('tool_use', [{ type: 'thinking', thinking: '', signature: 'sig-1' }, toolUse('toolu_1', 'read_rota', {})]);
    const second = reply('tool_use', [toolUse('toolu_2', 'log_run', logRunArgs(h.tick))]);
    const stub = new Stub([first, second, reply('end_turn', [text('Done.')])]);
    const result = await runLoop({ ...h.options, port: stub });
    expect(result.outcome).toBe('completed');
    expect(stub.requests.map((r) => r.messages.length)).toEqual([1, 3, 5]);
    // The assistant turn goes back exactly as it came, thinking block and signature included.
    expect(stub.requests[1]!.messages[1]).toEqual({ role: 'assistant', content: first.content });
    expect(h.recorder.names).toEqual(['read_rota', 'log_run']);
    await h.close();
  });

  it('keys every tool result by its tool_use id and marks errors as errors', async () => {
    const h = await harness();
    const stub = new Stub([
      reply('tool_use', [
        toolUse('toolu_ok', 'read_rota', {}),
        toolUse('toolu_bad_schema', 'set_decision', { person: 'Senga', event: 'kinloch', value: 'Stewarding', source: 'mail', evidenceAt: now, approved: true }),
        toolUse('toolu_not_a_tool', 'send_message', { to: 'Dougie' }),
        toolUse('toolu_refused', 'set_decision', { person: 'Senga', event: 'kinloch', value: 'Stewarding', source: 'mail', evidenceAt: now }),
      ]),
      reply('end_turn', [text('Done.')]),
    ]);
    await runLoop({ ...h.options, port: stub, obligation: () => null });
    const results = stub.requests[1]!.messages[2]!.content as { tool_use_id: string; is_error?: boolean; content: string }[];
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ['toolu_ok', false],
      ['toolu_bad_schema', true],
      ['toolu_not_a_tool', true],
      // A refusal is a normal result the model can act on, not an error.
      ['toolu_refused', false],
    ]);
    expect(results[1]!.content).toMatch(/schema/);
    expect(results[3]!.content).toMatch(/approval_missing/);
    // The forged and unknown calls never reached the server.
    expect(h.store.trace().map((t) => t.tool)).toEqual(['read_rota', 'read_rota', 'set_decision']);
    await h.close();
  });

  it('resends a pause_turn as it is, with no extra user message', async () => {
    const h = await harness();
    const paused = reply('pause_turn', [text('Working.')]);
    const stub = new Stub([paused, reply('end_turn', [text('Done.')])]);
    const result = await runLoop({ ...h.options, port: stub, obligation: () => null });
    expect(result.outcome).toBe('completed');
    expect(stub.requests[1]!.messages).toHaveLength(2);
    expect(stub.requests[1]!.messages[1]).toEqual({ role: 'assistant', content: paused.content });
    await h.close();
  });

  it('never runs a tool call cut off at max_tokens: it retries the same request with more room', async () => {
    const h = await harness();
    const truncated = reply('max_tokens', [toolUse('toolu_cut', 'set_availability', { person: 'Ailsa' })]);
    const stub = new Stub([truncated, reply('end_turn', [text('Done.')])]);
    const result = await runLoop({ ...h.options, port: stub, obligation: () => null });
    expect(result.outcome).toBe('completed');
    expect(stub.requests.map((r) => r.max_tokens)).toEqual([16000, 32000]);
    expect(stub.requests[1]!.messages).toEqual(stub.requests[0]!.messages);
    expect(h.recorder.names).toEqual([]);
    await h.close();
  });

  it('stops at max_tokens once there is no more room to give', async () => {
    const h = await harness();
    const stub = new Stub([reply('max_tokens', [text('...')])]);
    const result = await runLoop({ ...h.options, port: stub, maxTokens: 64000 });
    expect(result.outcome).toBe('max_tokens');
    expect(stub.requests).toHaveLength(1);
    await h.close();
  });

  it('stops on a refusal, uses nothing from it and runs none of its tools', async () => {
    const h = await harness();
    const stub = new Stub([reply('refusal', [toolUse('toolu_x', 'read_rota', {})])]);
    const result = await runLoop({ ...h.options, port: stub });
    expect(result).toMatchObject({ outcome: 'refusal', detail: 'refused, category cyber' });
    expect(h.recorder.names).toEqual([]);
    expect(result.messages).toHaveLength(1);
    await h.close();
  });

  it('counts the turn limit in code', async () => {
    const h = await harness();
    const stub = new Stub([(n) => reply('tool_use', [toolUse(`toolu_${n}`, 'read_rota', {})])]);
    const result = await runLoop({ ...h.options, port: stub, maxTurns: 3 });
    expect(result).toMatchObject({ outcome: 'turn_limit', detail: 'stopped after 3 turns' });
    expect(stub.requests).toHaveLength(3);
    await h.close();
  });

  it('reminds the model once if it stops without logging the run', async () => {
    const h = await harness();
    const stub = new Stub([reply('end_turn', [text('Done.')]), reply('end_turn', [text('Still done.')])]);
    const result = await runLoop({ ...h.options, port: stub, obligation: () => (h.recorder.names.includes('log_run') ? null : logReminder) });
    expect(result.outcome).toBe('completed');
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: logReminder }] });
    await h.close();
  });

  it('traces every turn with usage, duration and cost, prints the cost, and records it in the ledger', async () => {
    const h = await harness();
    const stub = new Stub([reply('tool_use', [toolUse('toolu_1', 'read_rota', {})], { input_tokens: 1000, cache_read_input_tokens: 9000 }), reply('end_turn', [text('Done.')])]);
    const result = await runLoop({ ...h.options, port: stub, obligation: () => null });
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({ turn: 1, stopReason: 'tool_use', usage: { input: 1000, cacheRead: 9000 }, tools: [{ name: 'read_rota', ok: true }] });
    expect(result.turns[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usd).toBeCloseTo(h.ledger.total, 9);
    expect(h.lines[0]).toMatch(/^turn 1 tool_use .*\$0\.\d{4} tools: read_rota$/);
    await h.close();
  });
});

describe('the request', () => {
  it('puts the stable prompt first with a breakpoint, the brief last, strict tools in a fixed order, and fallbacks on', async () => {
    const h = await harness();
    const params = buildRequest(h.options, [{ role: 'user', content: [{ type: 'text', text: h.options.brief }] }], 16000);
    expect(params.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual([fallbackBeta]);
    const tools = params.tools as { name: string; strict: boolean; input_schema: unknown }[];
    expect(tools.map((t) => t.name)).toEqual([...tools.map((t) => t.name)].sort());
    // As many strict as the API compiles (measured); the rest are checked locally before they run.
    expect(tools.filter((t) => !t.strict).map((t) => t.name)).toEqual(['log_run', 'message_organiser']);
    expect(tools.filter((t) => t.strict).reduce((n, t) => n + optionalCount(t.input_schema), 0)).toBeLessThanOrEqual(strictOptionalLimit);
    expect(JSON.stringify(params.messages.at(-1))).toContain('<evidence>');
    await h.close();
  });

  it('sends a byte-identical prefix (tools and system) on every tick, so the second tick reads it from cache', async () => {
    const h = await harness();
    const one = buildRequest(h.options, [{ role: 'user', content: [{ type: 'text', text: 'tick one' }] }], 16000);
    const two = buildRequest(h.options, [{ role: 'user', content: [{ type: 'text', text: 'tick two, different evidence' }] }], 16000);
    expect(JSON.stringify([one.tools, one.system])).toBe(JSON.stringify([two.tools, two.system]));
    await h.close();
  });
});

describe('cassettes', () => {
  it('replays a recorded tick exactly, with no request out of step and no spend', async () => {
    const first = await harness();
    const script = new Stub([reply('tool_use', [toolUse('toolu_1', 'read_rota', {})]), reply('tool_use', [toolUse('toolu_2', 'log_run', logRunArgs(first.tick))]), reply('end_turn', [text('Done.')])]);
    const recorder = new RecordingPort(script, { label: 'test', model, recordedAt: now });
    await runLoop({ ...first.options, port: recorder });
    const replay = new ReplayPort(structuredClone(recorder.cassette));
    const second = await harness();
    const result = await runLoop({ ...second.options, port: replay });
    expect(result.outcome).toBe('completed');
    expect(replay.mismatches).toBe(0);
    expect(replay.remaining).toBe(0);
    expect(second.recorder.names).toEqual(first.recorder.names);
    await first.close();
    await second.close();
  });

  it('blanks thinking signatures before anything is saved', async () => {
    const h = await harness();
    const recorder = new RecordingPort(new Stub([reply('end_turn', [{ type: 'thinking', thinking: '', signature: 'x'.repeat(200) }, text('Done.')])]), { label: 't', model, recordedAt: now });
    await runLoop({ ...h.options, port: recorder, obligation: () => null });
    expect(JSON.stringify(recorder.cassette)).not.toContain('x'.repeat(50));
    await h.close();
  });
});

describe('one tick, end to end, with a stub', () => {
  it('returns the run in the shape the graders read', async () => {
    const h = await harness();
    const stub = new Stub([reply('tool_use', [toolUse('toolu_1', 'log_run', logRunArgs(h.tick))]), reply('end_turn', [text('Done.')])]);
    const tick = await runMessagesTick({ port: stub, client: h.client, tick: h.tick, model, meter: h.ledger, label: 'e2e', print: () => undefined });
    expect(tick).toMatchObject({ impl: 'messages', outcome: 'completed' });
    expect(tick.run.summary).not.toBeNull();
    await h.close();
  });
});

// Live: two ticks with the same stable prefix. The second must read the prefix from cache. Costs about a cent.
const live = process.env.GHILLIE_LIVE === '1' && hasCredentials();
describe.skipIf(!live)('live, under the ledger', () => {
  it('reads the cache on the second tick', async () => {
    const ledger = new Ledger();
    const reads: number[] = [];
    for (const label of ['cache check tick 1', 'cache check tick 2']) {
      const h = await harness();
      const port: MessagesPort = { create: async (p) => {
        const r = await livePort().create({ ...p, max_tokens: 2000 });
        reads.push(r.usage.cache_read_input_tokens ?? 0);
        return r;
      } };
      await runLoop({ ...h.options, port, meter: ledger, label, maxTurns: 1 });
      await h.close();
    }
    process.stdout.write(`${ledger.summary()}\n`);
    expect(reads[1]).toBeGreaterThan(0);
  }, 120_000);
});
