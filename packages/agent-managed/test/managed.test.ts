/**
 * The Managed Agents build against a fake platform that behaves like one at the edges: a session is created with a
 * budget, the stream opens, the kickoff starts a scripted agent, every custom tool call pauses the session
 * (idle, requires_action) until the repo answers, and the script resumes only when it does. No API is called.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Store } from '@ghillie/engine';
import { logSeedRun, seedRun, seedWorld } from '@ghillie/feed';
import { connectInMemory } from '@ghillie/mcp-server';
import { CallGuard, SchemaValidator, loadCatalogue, prepareTick, readView, rotaTools } from '@ghillie/agent-kit';
import { Ledger } from '@ghillie/ledger';
import {
  agentDefinition,
  antCanApply,
  builtInToolNames,
  deploymentDefinition,
  ensureResources,
  environmentDefinition,
  guardConfirmer,
  morningAfter,
  renderMorningAfter,
  resourceFiles,
  runManagedTick,
  driveSession,
  workerPass,
  type ManagedEvent,
  type ManagedPort,
  type ManagedSession,
} from '@ghillie/agent-managed';

const now = '2027-06-07T13:00:00+01:00';
const model = 'claude-sonnet-5-5';

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    const w = this.waiting.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

type Step = { custom: string; input?: Record<string, unknown> } | { mcp: string; input?: Record<string, unknown>; ask: boolean } | { end: 'end_turn' | 'budget_reached' | 'refusal' };

/** One scripted segment runs per user.message. Records everything the repo sent. */
class FakePlatform implements ManagedPort {
  readonly created: Record<string, unknown>[] = [];
  readonly sent: Record<string, unknown>[] = [];
  readonly seenByStream: string[] = [];
  private queue = new Queue<ManagedEvent>();
  private resume: ((answer: Record<string, unknown>) => void) | null = null;
  private n = 0;
  listCostCents = 7;
  ids = { agent: 0, environment: 0, deployment: 0 };
  runs: Record<string, unknown>[] = [];
  sessions = new Map<string, ManagedSession>();
  history: ManagedEvent[] = [];

  constructor(private readonly segments: Step[][], private readonly mcp?: Client) {}

  private emit(event: Record<string, unknown>): ManagedEvent {
    const full = { id: `sevt_${++this.n}`, ...event } as ManagedEvent;
    this.history.push(full);
    this.queue.push(full);
    return full;
  }

  createAgent(): Promise<{ id: string; version: number }> {
    return Promise.resolve({ id: `agent_${++this.ids.agent}`, version: 1 });
  }
  createEnvironment(): Promise<{ id: string }> {
    return Promise.resolve({ id: `env_${++this.ids.environment}` });
  }
  paused: string[] = [];
  createDeployment(): Promise<{ id: string }> {
    return Promise.resolve({ id: `depl_${++this.ids.deployment}` });
  }
  pauseDeployment(id: string): Promise<{ id: string }> {
    this.paused.push(id);
    return Promise.resolve({ id });
  }
  createSession(body: Record<string, unknown>): Promise<ManagedSession> {
    this.created.push(body);
    const session = { id: `sesn_${this.created.length}`, status: 'idle' };
    this.sessions.set(session.id, session);
    return Promise.resolve(session);
  }
  retrieveSession(id: string): Promise<ManagedSession> {
    return Promise.resolve({ ...(this.sessions.get(id) ?? { id, status: 'idle' }), usage: { list_cost: { amount: String(this.listCostCents), currency: 'USD' } } });
  }
  listSessions(): Promise<ManagedSession[]> {
    return Promise.resolve([...this.sessions.values()]);
  }
  stream(): Promise<AsyncIterable<ManagedEvent>> {
    return Promise.resolve(this.queue);
  }
  listEvents(): Promise<ManagedEvent[]> {
    return Promise.resolve([...this.history]);
  }
  listDeploymentRuns(): Promise<Record<string, unknown>[]> {
    return Promise.resolve(this.runs);
  }

  send(_id: string, events: Record<string, unknown>[]): Promise<void> {
    for (const event of events) {
      this.sent.push(event);
      this.history.push({ id: `sevt_user_${this.sent.length}`, ...event } as ManagedEvent);
      if (event.type === 'user.message') void this.runSegment(this.segments.shift() ?? [{ end: 'end_turn' }]);
      else if (this.resume) {
        const go = this.resume;
        this.resume = null;
        go(event);
      }
    }
    return Promise.resolve();
  }

  private wait(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => (this.resume = resolve));
  }

  /** Start a session that is already paused on a custom tool call, as a scheduled run is. */
  pausedOn(sessionId: string, name: string): void {
    this.sessions.set(sessionId, { id: sessionId, status: 'idle' });
    this.emit({ type: 'agent.custom_tool_use', name, input: {} });
    this.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action' } });
    this.resume = (answer) => {
      this.seenByStream.push(`answer ${String(answer.type)}`);
      void this.runSegment(this.segments.shift() ?? [{ end: 'end_turn' }]);
    };
  }

  private async runSegment(steps: Step[]): Promise<void> {
    this.emit({ type: 'session.status_running' });
    for (const step of steps) {
      this.emit({ type: 'span.model_request_end', is_error: false, model_usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } });
      if ('custom' in step) {
        this.emit({ type: 'agent.custom_tool_use', name: step.custom, input: step.input ?? {} });
        this.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action' } });
        this.seenByStream.push(`paused on ${step.custom}`);
        const answer = await this.wait();
        this.seenByStream.push(`answered ${step.custom}${answer.is_error ? ' with an error' : ''}`);
        this.emit({ type: 'session.status_running' });
      } else if ('mcp' in step) {
        const use = this.emit({ type: 'agent.mcp_tool_use', name: step.mcp, input: step.input ?? {}, mcp_server_name: 'rota', evaluated_permission: step.ask ? 'ask' : 'allow' });
        let allowed = true;
        if (step.ask) {
          this.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action' } });
          const answer = await this.wait();
          allowed = answer.result === 'allow';
          this.seenByStream.push(`confirmation ${String(answer.result)} for ${step.mcp}`);
          this.emit({ type: 'session.status_running' });
        }
        if (allowed && this.mcp) {
          const raw = await this.mcp.callTool({ name: step.mcp, arguments: step.input ?? {} });
          this.emit({ type: 'agent.mcp_tool_result', mcp_tool_use_id: use.id, content: raw.content, is_error: raw.isError ?? false });
        }
      } else {
        this.emit({ type: 'session.status_idle', stop_reason: { type: step.end } });
      }
    }
  }
}

async function world() {
  const store = new Store({ path: ':memory:' });
  let clock = seedRun.loggedAt;
  const { service, console: organiser } = seedWorld(store, () => new Date(clock));
  logSeedRun(service);
  clock = now;
  const { client, close } = await connectInMemory(service);
  const tools = (await loadCatalogue(client)).filter((t) => (rotaTools as readonly string[]).includes(t.name));
  const validator = new SchemaValidator(tools);
  const tick = prepareTick(await readView(client), { items: [], sources: { chat: 'ok', mail: 'ok', minutes: 'ok', calendar: 'ok' }, windows: {} }, now);
  const dir = mkdtempSync(join(tmpdir(), 'ghillie-managed-'));
  const ledger = new Ledger({ path: join(dir, 'spend.jsonl'), print: () => undefined, stop: (m) => { throw new Error(m); } });
  const base = {
    agent: { id: 'agent_1', version: 1 },
    environmentId: 'env_1',
    model,
    tick,
    client,
    gateGuard: new CallGuard({ validator, allowed: rotaTools }),
    confirmer: guardConfirmer(new CallGuard({ validator, allowed: rotaTools, store: () => store })),
    meter: ledger,
    label: 'test tick',
    print: () => undefined,
  };
  return { store, organiser, client, close, tools, tick, dir, ledger, base };
}

const decision = (person: string, event: string) => ({ person, event, value: 'Stewarding', source: 'organiser approval', evidenceAt: now });

describe('confirm first, with custom tools: pause, answer, resume', () => {
  it('pauses on every tool call, answers each, refuses an unapproved write and runs an approved one', async () => {
    const w = await world();
    w.organiser.approveDecision('Dougie', 'inverallt', 'Stewarding');
    const platform = new FakePlatform([
      [
        { custom: 'gather_evidence' },
        { custom: 'read_rota' },
        { custom: 'set_decision', input: decision('Senga', 'kinloch') },
        { custom: 'set_decision', input: decision('Dougie', 'inverallt') },
        { custom: 'log_run', input: { ...w.tick.logRun, exceptions: 0, toolCalls: 5 } },
        { end: 'end_turn' },
      ],
    ]);
    const before = w.store.trace().length;
    const tick = await runManagedTick({ ...w.base, port: platform });
    expect(tick.outcome).toBe('completed');
    expect(platform.seenByStream).toEqual([
      'paused on gather_evidence',
      'answered gather_evidence',
      'paused on read_rota',
      'answered read_rota',
      'paused on set_decision',
      'answered set_decision with an error',
      'paused on set_decision',
      'answered set_decision',
      'paused on log_run',
      'answered log_run',
    ]);
    // Each answer names the call it answers.
    const toolUses = platform.history.filter((e) => e.type === 'agent.custom_tool_use').map((e) => e.id);
    expect(platform.sent.filter((e) => e.type === 'user.custom_tool_result').map((e) => e.custom_tool_use_id)).toEqual(toolUses);
    // gather_evidence returns the brief; the refused decision never reached the server.
    expect(JSON.stringify(platform.sent[1])).toContain('<evidence>');
    expect(w.store.trace().slice(before).map((t) => t.tool).filter((t) => t !== 'read_rota')).toEqual(['set_decision', 'log_run']);
    expect(w.store.cell('Dougie', 'inverallt').value).toBe('Stewarding');
    expect(w.store.cell('Senga', 'kinloch').value).not.toBe('Stewarding');
    expect(tick.run.refused.map((r) => [r.outcome, r.detail])).toEqual([['approval_missing', expect.stringMatching(/not confirmed: precheck: approval_missing/)]]);
    await w.close();
  });

  it('creates every session with a $2 budget, in cents, and the stream open before the brief is sent', async () => {
    const w = await world();
    const platform = new FakePlatform([[{ custom: 'log_run', input: { ...w.tick.logRun, exceptions: 0, toolCalls: 1 } }, { end: 'end_turn' }]]);
    await runManagedTick({ ...w.base, port: platform });
    expect(platform.created[0]).toMatchObject({ agent: { type: 'agent', id: 'agent_1', version: 1 }, environment_id: 'env_1', budget: { type: 'limit', max_list_cost: { amount: '200', currency: 'USD' } } });
    await w.close();
  });

  it('stops at the session budget and says so', async () => {
    const w = await world();
    const platform = new FakePlatform([[{ custom: 'read_rota' }, { end: 'budget_reached' }]]);
    const tick = await runManagedTick({ ...w.base, port: platform });
    expect(tick).toMatchObject({ outcome: 'budget', detail: 'paused at the session budget of $2.00' });
    await w.close();
  });

  it('reminds the session once if it ends without logging the run', async () => {
    const w = await world();
    const platform = new FakePlatform([[{ end: 'end_turn' }], [{ custom: 'log_run', input: { ...w.tick.logRun, exceptions: 0, toolCalls: 1 } }, { end: 'end_turn' }]]);
    const tick = await runManagedTick({ ...w.base, port: platform });
    expect(platform.sent.filter((e) => e.type === 'user.message')).toHaveLength(2);
    expect(tick.run.summary).not.toBeNull();
    await w.close();
  });

  it('records each model request in the ledger, then the rest of the platform list cost, and saves the event log', async () => {
    const w = await world();
    const platform = new FakePlatform([[{ custom: 'read_rota' }, { custom: 'log_run', input: { ...w.tick.logRun, exceptions: 0, toolCalls: 2 } }, { end: 'end_turn' }]]);
    platform.listCostCents = 9;
    const exportPath = join(w.dir, 'recordings', 'session.jsonl');
    const tick = await runManagedTick({ ...w.base, port: platform, exportPath });
    expect(tick.turns).toHaveLength(3);
    // The ledger ends at what the platform says the session cost.
    expect(w.ledger.total).toBeCloseTo(0.09, 6);
    const log = readFileSync(exportPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ManagedEvent);
    expect(log.some((e) => e.type === 'agent.custom_tool_use')).toBe(true);
    await w.close();
  });
});

describe('confirm first, with the MCP connector: always_ask on every write', () => {
  it('answers each ask with a confirmation, allow or deny with the reason', async () => {
    const w = await world();
    const platform = new FakePlatform(
      [[{ mcp: 'read_rota', ask: false }, { mcp: 'set_decision', ask: true, input: decision('Senga', 'kinloch') }, { mcp: 'log_run', ask: true, input: { ...w.tick.logRun, exceptions: 0, toolCalls: 3 } }, { end: 'end_turn' }]],
      w.client,
    );
    const tick = await runManagedTick({ ...w.base, port: platform });
    expect(platform.seenByStream).toEqual(['confirmation deny for set_decision', 'confirmation allow for log_run']);
    const confirmations = platform.sent.filter((e) => e.type === 'user.tool_confirmation');
    expect(confirmations[0]).toMatchObject({ result: 'deny', deny_message: expect.stringMatching(/approval_missing/) });
    expect(confirmations[1]).toMatchObject({ result: 'allow' });
    expect(tick.run.summary).not.toBeNull();
    expect(w.store.cell('Senga', 'kinloch').value).not.toBe('Stewarding');
    await w.close();
  });
});

describe('the definitions', () => {
  it('disables every built-in tool and offers only the rota tools and gather_evidence', async () => {
    const w = await world();
    const agent = agentDefinition({ model, tools: w.tools }) as { tools: { type: string; name?: string; default_config?: { enabled: boolean }; configs?: { name: string; enabled: boolean }[] }[] };
    const toolset = agent.tools.find((t) => t.type === 'agent_toolset_20260401');
    expect(toolset?.default_config).toEqual({ enabled: false });
    expect(toolset?.configs).toEqual(builtInToolNames.map((name) => ({ name, enabled: false })));
    expect(agent.tools.filter((t) => t.type === 'custom').map((t) => t.name)).toEqual([...rotaTools, 'gather_evidence']);
    await w.close();
  });

  it('puts every write on always_ask in MCP mode', async () => {
    const w = await world();
    const agent = agentDefinition({ model, tools: w.tools, mode: 'mcp', mcpUrl: 'https://rota.example.scot/mcp' }) as { tools: { type: string; configs?: { name: string; permission_policy: { type: string } }[] }[] };
    const policies = Object.fromEntries((agent.tools.find((t) => t.type === 'mcp_toolset')?.configs ?? []).map((c) => [c.name, c.permission_policy.type]));
    expect(policies).toEqual({ log_run: 'always_ask', message_organiser: 'always_ask', propose_recruit: 'always_ask', read_rota: 'always_allow', set_availability: 'always_ask', set_decision: 'always_ask', update_event: 'always_ask', update_person: 'always_ask' });
    await w.close();
  });

  it('limits networking to an explicit host list, empty by default', () => {
    expect(environmentDefinition()).toEqual({ name: 'ghillie-rota', config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false } } });
  });

  it('schedules weekdays at 13:00 and 18:00 London time, each run capped at $2', () => {
    expect(deploymentDefinition({ agent: 'a', environment: 'e' })).toMatchObject({
      schedule: { type: 'cron', expression: '0 13,18 * * 1-5', timezone: 'Europe/London' },
      budget: { type: 'limit', max_list_cost: { amount: '200', currency: 'USD' } },
    });
  });

  it('keeps the checked-in resource files in step with the definitions', async () => {
    const w = await world();
    const files = resourceFiles(agentDefinition({ model, tools: w.tools }));
    for (const [path, text] of Object.entries(files)) {
      expect(readFileSync(new URL(`../resources/${path}`, import.meta.url), 'utf8'), `${path}: run npm run managed:export`).toBe(text);
    }
    await w.close();
  });
});

describe('set up once, by id', () => {
  it('creates the agent, environment and deployment once and nothing on the second run', async () => {
    const w = await world();
    const platform = new FakePlatform([]);
    const idsPath = join(w.dir, 'ids.json');
    const options = { port: platform, idsPath, agent: agentDefinition({ model, tools: w.tools }), environment: environmentDefinition(), deployment: (ids: { agent: unknown; environment: string }) => deploymentDefinition({ agent: ids.agent, environment: ids.environment }) };
    expect((await ensureResources(options)).created).toEqual(['agent agent_1', 'environment env_1', 'deployment depl_1']);
    expect((await ensureResources(options)).created).toEqual([]);
    expect(platform.ids).toEqual({ agent: 1, environment: 1, deployment: 1 });
    expect(platform.paused).toEqual([]);
    const pausedPath = join(w.dir, 'paused-ids.json');
    await ensureResources({ ...options, idsPath: pausedPath, pauseDeployment: true });
    expect(platform.paused).toEqual(['depl_2']);
    await w.close();
  });

  it('knows which ant can apply resource files', () => {
    expect(antCanApply('1.10.0')).toBe(false);
    expect(antCanApply('1.30.0')).toBe(true);
    expect(antCanApply(null)).toBe(false);
  });
});

describe('scheduled runs: the worker and the morning-after report', () => {
  it('serves a run that is waiting, refuses a third run on one day, and reports both', async () => {
    const w = await world();
    const platform = new FakePlatform([[{ custom: 'log_run', input: { ...w.tick.logRun, exceptions: 0, toolCalls: 2 } }, { end: 'end_turn' }]]);
    platform.runs = [
      { id: 'drun_1', session_id: 'sesn_a', trigger_context: { scheduled_at: '2027-06-07T12:00:00Z' }, created_at: '2027-06-07T12:00:01Z' },
      { id: 'drun_2', session_id: 'sesn_b', trigger_context: { scheduled_at: '2027-06-07T17:00:00Z' }, created_at: '2027-06-07T17:00:01Z' },
      { id: 'drun_3', session_id: 'sesn_c', trigger_context: { scheduled_at: '2027-06-07T17:30:00Z' }, created_at: '2027-06-07T17:30:01Z' },
    ];
    platform.sessions.set('sesn_b', { id: 'sesn_b', status: 'running' });
    platform.sessions.set('sesn_c', { id: 'sesn_c', status: 'idle' });
    platform.pausedOn('sesn_a', 'gather_evidence');
    const done = new Set<string>();
    const pass = await workerPass({
      port: platform,
      deploymentId: 'depl_1',
      done,
      serve: (sessionId, events, pending) => driveSession({ ...w.base, port: platform, label: sessionId }, sessionId, events, pending),
    });
    expect(pass).toEqual({ served: ['sesn_a'], refused: ['sesn_c'] });
    expect(platform.sent.find((e) => e.type === 'user.interrupt')).toBeDefined();
    expect(JSON.stringify(platform.sent[0])).toContain('<evidence>');

    const lines = await morningAfter(platform, 'depl_1', '2027-06-07T00:00:00Z');
    expect(lines).toHaveLength(3);
    expect(renderMorningAfter(lines)).toMatch(/3 runs, \$0\.21 in all/);
    await w.close();
  });
});
