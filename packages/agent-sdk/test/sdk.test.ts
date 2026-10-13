/**
 * The Agent SDK build against a fake `query` that behaves like the SDK at its edges: an init message listing the
 * session's tools, assistant turns with usage, the harness's own hooks called with the SDK's hook inputs, the tool run
 * against the real Phase 1a MCP server (in memory here), and a result. No model is called.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Store } from '@ghillie/engine';
import { logSeedRun, seedRun, seedWorld } from '@ghillie/feed';
import { connectInMemory } from '@ghillie/mcp-server';
import { prepareTick, readView, type TickInput } from '@ghillie/agent-kit';
import { Ledger } from '@ghillie/ledger';
import { allowedToolNames, buildSdkOptions, builtInTools, denyOthers, harnessState, outcomeOfResponse, resumePrompt, runSdkTick, type QueryFn } from '@ghillie/agent-sdk';

const now = '2027-06-07T13:00:00+01:00';
const model = 'claude-sonnet-5-5';

type Step = { call: [string, Record<string, unknown>] } | { kill: string } | { result: 'success' | 'error_max_turns' | 'error_max_budget_usd' } | { offer: string[] };

interface Seen {
  prompt: string;
  options: Options;
}

/** A stand-in for the SDK's query(): each pass runs one script, calling the harness's hooks as the SDK would. */
function fakeSdk(server: Client, passes: Step[][], seen: Seen[]): QueryFn {
  let turn = 0;
  return ({ prompt, options }) =>
    (async function* (): AsyncGenerator<SDKMessage> {
      seen.push({ prompt, options });
      const sessionId = options.resume ?? `session-${seen.length}`;
      const script = passes.shift() ?? [];
      const offered = script.find((s): s is { offer: string[] } => 'offer' in s)?.offer ?? [...allowedToolNames];
      yield { type: 'system', subtype: 'init', session_id: sessionId, tools: offered } as unknown as SDKMessage;
      const hook = (event: 'PreToolUse' | 'PostToolUse'): HookCallback => options.hooks![event]![0]!.hooks[0]!;
      for (const step of script) {
        if ('kill' in step) throw new Error(step.kill);
        if ('result' in step) {
          yield { type: 'result', subtype: step.result, session_id: sessionId, total_cost_usd: 0.01, num_turns: turn, errors: [] } as unknown as SDKMessage;
          continue;
        }
        if (!('call' in step)) continue;
        const [name, args] = step.call;
        const id = `toolu_${++turn}`;
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          session_id: sessionId,
          message: { id: `msg_${turn}`, model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: `mcp__rota__${name}`, input: args }], usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
        } as unknown as SDKMessage;
        const base = { session_id: sessionId, transcript_path: '', cwd: '', tool_name: `mcp__rota__${name}`, tool_input: args, tool_use_id: id };
        const decided = (await hook('PreToolUse')({ ...base, hook_event_name: 'PreToolUse' }, id, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
        if (decided.hookSpecificOutput?.permissionDecision === 'deny') continue;
        const response = await server.callTool({ name, arguments: args });
        await hook('PostToolUse')({ ...base, hook_event_name: 'PostToolUse', tool_response: response }, id, { signal: new AbortController().signal });
      }
    })();
}

async function world() {
  const store = new Store({ path: ':memory:' });
  let clock = seedRun.loggedAt;
  const { service, console: organiser } = seedWorld(store, () => new Date(clock));
  logSeedRun(service);
  clock = now;
  const { client, close } = await connectInMemory(service);
  const tick: TickInput = prepareTick(await readView(client), { items: [], sources: { chat: 'ok', mail: 'ok', minutes: 'ok', calendar: 'ok' }, windows: {} }, now);
  const stateDir = mkdtempSync(join(tmpdir(), 'ghillie-sdk-'));
  const state = harnessState(stateDir);
  const ledger = new Ledger({ path: join(stateDir, 'spend.jsonl'), print: () => undefined, stop: (m) => { throw new Error(m); } });
  const base = { tick, model, meter: ledger, state, dbPath: join(stateDir, 'rota.db'), clock: now, store: () => store, client, print: () => undefined };
  return { store, service, organiser, client, close, tick, state, ledger, base };
}

const decision = (person: string, event: string) => ({ person, event, value: 'Stewarding', source: 'organiser approval', evidenceAt: now });

describe('deny by default', () => {
  it('offers only the eight rota tools, named in code, and loads no settings, skills, plugins or other servers', () => {
    const options = buildSdkOptions({ model, dbPath: 'x.db', clock: now, stateDir: mkdtempSync(join(tmpdir(), 'opts-')), hooks: {}, maxTurns: 20, maxBudgetUsd: 1.5 });
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(['log_run', 'message_organiser', 'propose_recruit', 'read_rota', 'set_availability', 'set_decision', 'update_event', 'update_person'].map((t) => `mcp__rota__${t}`));
    expect(options.disallowedTools).toEqual(builtInTools);
    expect(options).toMatchObject({ settingSources: [], skills: [], plugins: [], strictMcpConfig: true, permissionMode: 'dontAsk', maxTurns: 20, maxBudgetUsd: 1.5, persistSession: true });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['rota']);
    // Its own config directory and home: nothing from the machine's user configuration.
    expect(options.env?.CLAUDE_CONFIG_DIR).toMatch(/config$/);
    expect(Object.keys(options.env ?? {}).filter((k) => k !== 'TMPDIR').sort()).toEqual(['CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
  });

  it('denies any tool that is not a rota tool when asked', async () => {
    expect(await denyOthers('Bash', {}, { signal: new AbortController().signal, toolUseID: 'x' } as never)).toMatchObject({ behavior: 'deny' });
    expect(await denyOthers('mcp__rota__read_rota', {}, { signal: new AbortController().signal, toolUseID: 'x' } as never)).toMatchObject({ behavior: 'allow' });
  });

  it('stops the tick if the session offers anything beyond the rota tools', async () => {
    const w = await world();
    const tick = await runSdkTick({ ...w.base, tickId: 'offer', query: fakeSdk(w.client, [[{ offer: [...allowedToolNames, 'Bash'] }, { result: 'success' }]], []) });
    expect(tick).toMatchObject({ outcome: 'interrupted', detail: expect.stringMatching(/deny by default broken: the session offers Bash/) });
    await w.close();
  });
});

describe('reading a tool result from the hook', () => {
  it('reads the plain string the SDK passes (measured live), content blocks, and errors', () => {
    expect(outcomeOfResponse('{"ok":true,"changed":true}')).toEqual({ isError: false, result: { ok: true, changed: true }, text: '{"ok":true,"changed":true}' });
    expect(outcomeOfResponse('{"ok":false,"refusal":"approval_missing"}').result).toMatchObject({ ok: false, refusal: 'approval_missing' });
    expect(outcomeOfResponse('error: person: Required')).toMatchObject({ isError: true, result: null });
    expect(outcomeOfResponse({ content: [{ type: 'text', text: '{"ok":true}' }] })).toMatchObject({ isError: false, result: { ok: true } });
    expect(outcomeOfResponse({ content: [{ type: 'text', text: 'boom' }], isError: true })).toMatchObject({ isError: true });
  });
});

describe('the pre-tool-use hook', () => {
  it('refuses a forged approval in the arguments, and a decision with no approval, before the server sees either', async () => {
    const w = await world();
    const before = w.store.trace().length;
    const tick = await runSdkTick({
      ...w.base,
      tickId: 'forged',
      query: fakeSdk(w.client, [[
        { call: ['set_decision', { ...decision('Dougie', 'inverallt'), approved: true }] },
        { call: ['set_decision', { ...decision('Dougie', 'inverallt'), approval: { id: 1, by: 'Isla' } }] },
        { call: ['set_decision', decision('Dougie', 'inverallt')] },
        { call: ['log_run', { ...w.tick.logRun, exceptions: 0, toolCalls: 4 }] },
        { result: 'success' },
      ]], []),
    });
    // Only log_run reached the server (plus the harness's own reads).
    expect(w.store.trace().slice(before).map((t) => t.tool).filter((t) => t !== 'read_rota')).toEqual(['log_run']);
    expect(w.store.cell('Dougie', 'inverallt').value).not.toBe('Stewarding');
    expect(tick.run.refused.map((r) => r.detail ?? '')).toEqual([expect.stringMatching(/schema/), expect.stringMatching(/schema/), expect.stringMatching(/no approval from Isla/)]);
    // A forged field is a malformed call; a missing approval is the service's own refusal, recorded as such.
    expect(tick.run.refused.map((r) => r.outcome)).toEqual(['error', 'error', 'approval_missing']);
    const denials = w.state.audit.entries().filter((e) => e.decision === 'deny');
    expect(denials.map((d) => d.reason)).toEqual(['schema: invalid_arguments', 'schema: invalid_arguments', 'precheck: approval_missing']);
    await w.close();
  });

  it('writes an audit entry for every decision and every result, with digests, never the arguments', async () => {
    const w = await world();
    await runSdkTick({ ...w.base, tickId: 'audit', query: fakeSdk(w.client, [[{ call: ['read_rota', {}] }, { call: ['log_run', { ...w.tick.logRun, exceptions: 0, toolCalls: 2 }] }, { result: 'success' }]], []) });
    const entries = w.state.audit.entries();
    expect(entries.map((e) => `${e.hook} ${e.decision} ${e.reason}`)).toEqual(['PreToolUse allow checked', 'PostToolUse recorded ok', 'PreToolUse allow checked', 'PostToolUse recorded ok']);
    expect(entries.every((e) => /^[0-9a-f]{16}$/.test(e.argsDigest) && !('args' in e))).toBe(true);
    await w.close();
  });
});

describe('kill and resume by tick id', () => {
  it('loses no decision the organiser made and carries none out twice', async () => {
    const w = await world();
    w.organiser.approveDecision('Dougie', 'inverallt', 'Stewarding');
    w.organiser.approveDecision('Senga', 'kinloch', 'Stewarding');
    const seen: Seen[] = [];
    const passes: Step[][] = [
      // The first process carries out one approval, then dies.
      [{ call: ['read_rota', {}] }, { call: ['set_decision', decision('Dougie', 'inverallt')] }, { kill: 'SIGKILL' }],
      // The second process resumes the same session, re-reads, and finishes.
      [
        { call: ['read_rota', {}] },
        { call: ['set_decision', decision('Dougie', 'inverallt')] },
        { call: ['set_decision', decision('Senga', 'kinloch')] },
        { call: ['log_run', { ...w.tick.logRun, exceptions: 0, toolCalls: 6 }] },
        { result: 'success' },
      ],
    ];
    const query = fakeSdk(w.client, passes, seen);
    const killed = await runSdkTick({ ...w.base, tickId: 'tick-2027-06-07T13', query });
    expect(killed.outcome).toBe('interrupted');
    expect(w.state.sessions.get('tick-2027-06-07T13')).toMatchObject({ sessionId: 'session-1', status: 'interrupted' });

    const resumed = await runSdkTick({ ...w.base, tickId: 'tick-2027-06-07T13', query });
    expect(resumed.outcome).toBe('completed');
    expect(seen[1]).toMatchObject({ prompt: resumePrompt, options: { resume: 'session-1' } });
    expect(w.state.sessions.get('tick-2027-06-07T13')).toMatchObject({ sessionId: 'session-1', status: 'completed' });

    expect(w.store.cell('Dougie', 'inverallt').value).toBe('Stewarding');
    expect(w.store.cell('Senga', 'kinloch').value).toBe('Stewarding');
    const approvals = w.store.approvals();
    expect(approvals.filter((a) => a.kind === 'grant')).toHaveLength(2);
    // Each approval used exactly once, across both processes.
    expect(approvals.filter((a) => a.kind === 'use')).toHaveLength(2);
    // The record spans the kill: the first process's write is in it, and the repeat was a no-op.
    const decisions = resumed.run.writes.filter((r) => r.action === 'set_decision').map((r) => `${r.person} ${r.outcome}`);
    expect(decisions).toEqual(['Dougie changed', 'Dougie unchanged', 'Senga changed']);
    expect(resumed.run.summary).not.toBeNull();
    await w.close();
  });

  it('starts a finished tick fresh rather than resuming it', async () => {
    const w = await world();
    const seen: Seen[] = [];
    const log = { call: ['log_run', { ...w.tick.logRun, exceptions: 0, toolCalls: 1 }] } as Step;
    const query = fakeSdk(w.client, [[log, { result: 'success' }], [log, { result: 'success' }]], seen);
    await runSdkTick({ ...w.base, tickId: 'done', query });
    await runSdkTick({ ...w.base, tickId: 'done', query });
    expect(seen[1]?.options.resume).toBeUndefined();
    await w.close();
  });
});

describe('ceilings and spend', () => {
  it('passes the turn and spend ceilings to every run and reports hitting them', async () => {
    const w = await world();
    const seen: Seen[] = [];
    const budget = await runSdkTick({ ...w.base, tickId: 'budget', maxTurns: 7, maxBudgetUsd: 0.5, query: fakeSdk(w.client, [[{ call: ['read_rota', {}] }, { result: 'error_max_budget_usd' }]], seen) });
    expect(seen[0]?.options).toMatchObject({ maxTurns: 7, maxBudgetUsd: 0.5 });
    expect(budget.outcome).toBe('budget');
    const turns = await runSdkTick({ ...w.base, tickId: 'turns', query: fakeSdk(w.client, [[{ result: 'error_max_turns' }]], []) });
    expect(turns.outcome).toBe('turn_limit');
    await w.close();
  });

  it('records each assistant message once in the ledger, from its usage', async () => {
    const w = await world();
    const tick = await runSdkTick({ ...w.base, tickId: 'spend', query: fakeSdk(w.client, [[{ call: ['read_rota', {}] }, { call: ['log_run', { ...w.tick.logRun, exceptions: 0, toolCalls: 2 }] }, { result: 'success' }]], []) });
    expect(tick.turns).toHaveLength(2);
    expect(tick.usd).toBeGreaterThan(0);
    expect(tick.usd).toBeCloseTo(w.ledger.total, 9);
    await w.close();
  });

  it('reminds the session once, by resuming it, if it finished without logging the run', async () => {
    const w = await world();
    const seen: Seen[] = [];
    const query = fakeSdk(w.client, [[{ result: 'success' }], [{ call: ['log_run', { ...w.tick.logRun, exceptions: 0, toolCalls: 1 }] }, { result: 'success' }]], seen);
    const tick = await runSdkTick({ ...w.base, tickId: 'remind', query });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.options.resume).toBe('session-1');
    expect(tick.run.summary).not.toBeNull();
    await w.close();
  });
});
