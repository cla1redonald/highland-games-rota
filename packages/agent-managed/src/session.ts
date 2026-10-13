/**
 * One tick on Managed Agents. The platform runs the loop; the repo runs the tools and answers for every write.
 *
 *   1. Create the session with its budget (set at creation, in cents), open the stream, then send the brief.
 *   2. The session pauses on every custom tool call (idle, requires_action). For a write, the confirmer is asked
 *      first: the harness guard (allow-list, the server's closed schema, the engine's authority predicate, read-only,
 *      failing closed), and anything else the caller adds, such as a person. Allowed: run it against the MCP server
 *      and answer with the result. Refused: answer with the refusal as an error. Either way the session resumes.
 *   3. In "mcp" mode the platform runs the tool itself and asks first (always_ask): the same confirmer answers with
 *      a tool confirmation, allow or deny.
 *   4. Each model request's usage goes into the ledger; at the end, the session's own list cost is reconciled, so the
 *      ledger holds what the platform says the session cost, running time included.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RunRecorder, ToolGate, readView, renderBrief, rotaTools, writeTools, type AgentTick, type CallGuard, type CallOutcome, type TickInput, type TickOutcome, type TurnTrace } from '@ghillie/agent-kit';
import type { ApiUsage, SpendMeta, TokenCounts } from '@ghillie/ledger';
import { budget, sessionBudgetCents } from './definitions.js';
import type { ManagedEvent, ManagedPort } from './port.js';

export interface Confirmer {
  /** On a refusal, `refusal` is the engine's code when the refusal is an authority one (the service's own answer). */
  confirm(name: string, input: unknown): Promise<{ allow: true } | { allow: false; reason: string; refusal?: string }>;
}

/** The default confirmer: the harness guard, with the engine's authority predicate. */
export function guardConfirmer(guard: CallGuard): Confirmer {
  return {
    confirm: (name, input) => {
      const decision = guard.check(name, input);
      if (decision.ok) return Promise.resolve({ allow: true as const });
      return Promise.resolve({ allow: false as const, reason: `${decision.stage}: ${decision.refusal}: ${decision.detail}`, ...(decision.stage === 'precheck' ? { refusal: decision.refusal } : {}) });
    },
  };
}

export interface ManagedMeter {
  assertUnderCap(): void;
  record(model: string, usage: ApiUsage, meta: SpendMeta): { usd: number }[];
  recordListCost(model: string, usd: number, tokens: TokenCounts, meta: SpendMeta): { usd: number };
}

export interface ManagedTickOptions {
  port: ManagedPort;
  agent: { id: string; version?: number };
  environmentId: string;
  model: string;
  tick: TickInput;
  client: Client;
  /** Checks every call (allow-list and schema) before it runs. */
  gateGuard: CallGuard;
  confirmer: Confirmer;
  meter: ManagedMeter;
  label: string;
  budgetCents?: number;
  /** Where to save the session's exported event log. */
  exportPath?: string;
  print?: (line: string) => void;
}

const logReminder = 'You have not called log_run yet. Log the run now with the logRun fields from the brief, then stop.';
const text = (content: string): { type: 'text'; text: string }[] => [{ type: 'text', text: content }];

function mcpOutcome(event: ManagedEvent): CallOutcome {
  const content = Array.isArray(event.content) ? (event.content as { text?: unknown }[]) : [];
  const body = content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
  if (event.is_error === true) return { isError: true, result: null, text: body };
  try {
    return { isError: false, result: JSON.parse(body) as Record<string, unknown>, text: body };
  } catch {
    return { isError: true, result: null, text: body };
  }
}

export async function runManagedTick(o: ManagedTickOptions): Promise<AgentTick> {
  o.meter.assertUnderCap();
  const session = await o.port.createSession({
    agent: { type: 'agent', id: o.agent.id, ...(o.agent.version ? { version: o.agent.version } : {}) },
    environment_id: o.environmentId,
    title: o.label,
    budget: budget(o.budgetCents ?? sessionBudgetCents),
    metadata: { tick: o.tick.now },
  });
  // Stream first, then send, so no event is missed.
  const events = await o.port.stream(session.id);
  await o.port.send(session.id, [{ type: 'user.message', content: text(renderBrief(o.tick)) }]);
  return driveSession(o, session.id, events, []);
}

/**
 * Serves one session to the end: answers its tool calls, records its spend, and returns the tick. `pending` holds
 * tool calls that were already waiting when the harness attached (a scheduled run found by the worker).
 */
export async function driveSession(o: Omit<ManagedTickOptions, 'agent' | 'environmentId'>, sessionId: string, events: AsyncIterable<ManagedEvent>, pending: ManagedEvent[]): Promise<AgentTick> {
  const started = performance.now();
  const print = o.print ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const recorder = new RunRecorder(o.tick);
  const gate = new ToolGate(o.client, o.gateGuard, recorder);
  const brief = renderBrief(o.tick);
  const turns: TurnTrace[] = [];
  const pendingMcp = new Map<string, { name: string; input: Record<string, unknown> }>();
  let usd = 0;
  let outcome: TickOutcome = 'error';
  let detail: string | undefined;
  let reminded = false;

  const session = { id: sessionId };

  const answerCustom = async (event: ManagedEvent): Promise<void> => {
    const name = String(event.name);
    const input = (event.input ?? {}) as Record<string, unknown>;
    let reply: { content: string; isError: boolean };
    if (name === 'gather_evidence') reply = { content: brief, isError: false };
    else if (!(rotaTools as readonly string[]).includes(name)) reply = { content: `${name} is not a rota tool`, isError: true };
    else {
      const verdict = writeTools.includes(name) ? await o.confirmer.confirm(name, input) : ({ allow: true } as const);
      if (!verdict.allow) {
        const refused = `not confirmed: ${verdict.reason}`;
        recorder.record(name, input, verdict.refusal ? { isError: false, result: { ok: false, refusal: verdict.refusal, detail: refused }, text: refused } : { isError: true, result: null, text: refused });
        reply = { content: refused, isError: true };
      } else {
        const ran = await gate.run(name, input);
        reply = { content: ran.content, isError: ran.isError };
      }
    }
    await o.port.send(session.id, [{ type: 'user.custom_tool_result', custom_tool_use_id: event.id, content: text(reply.content), ...(reply.isError ? { is_error: true } : {}) }]);
  };

  for (const event of pending) await answerCustom(event);
  for await (const event of events) {
    if (event.type === 'agent.custom_tool_use') await answerCustom(event);
    else if (event.type === 'agent.mcp_tool_use') {
      const name = String(event.name);
      const input = (event.input ?? {}) as Record<string, unknown>;
      pendingMcp.set(event.id, { name, input });
      if (event.evaluated_permission === 'ask') {
        const verdict = await o.confirmer.confirm(name, input);
        if (!verdict.allow) {
          const refused = `not confirmed: ${verdict.reason}`;
          recorder.record(name, input, verdict.refusal ? { isError: false, result: { ok: false, refusal: verdict.refusal, detail: refused }, text: refused } : { isError: true, result: null, text: refused });
        }
        await o.port.send(session.id, [{ type: 'user.tool_confirmation', tool_use_id: event.id, result: verdict.allow ? 'allow' : 'deny', ...(verdict.allow ? {} : { deny_message: verdict.reason }) }]);
        if (!verdict.allow) pendingMcp.delete(event.id);
      }
    } else if (event.type === 'agent.mcp_tool_result') {
      const call = pendingMcp.get(String(event.mcp_tool_use_id));
      if (call) recorder.record(call.name, call.input, mcpOutcome(event));
    } else if (event.type === 'span.model_request_end') {
      const usage = event.model_usage as ApiUsage;
      const cost = o.meter.record(o.model, usage, { impl: 'managed', label: `${o.label} request ${turns.length + 1}` }).reduce((s, e) => s + e.usd, 0);
      usd += cost;
      turns.push({ turn: turns.length + 1, stopReason: event.is_error ? 'error' : 'request', model: o.model, durationMs: 0, usage: { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 }, usd: cost, tools: [] });
    } else if (event.type === 'session.error') {
      detail = JSON.stringify(event.error ?? event).slice(0, 200);
    } else if (event.type === 'session.status_terminated') {
      outcome = outcome === 'error' ? 'completed' : outcome;
      break;
    } else if (event.type === 'session.status_idle') {
      const stop = (event.stop_reason as { type?: string } | undefined)?.type ?? 'unknown';
      if (stop === 'requires_action') continue;
      if (stop === 'end_turn') {
        if (!reminded && !recorder.names.includes('log_run')) {
          reminded = true;
          await o.port.send(session.id, [{ type: 'user.message', content: text(logReminder) }]);
          continue;
        }
        outcome = 'completed';
      } else if (stop === 'budget_reached') {
        outcome = 'budget';
        detail = `paused at the session budget of $${((o.budgetCents ?? sessionBudgetCents) / 100).toFixed(2)}`;
      } else if (stop === 'refusal') outcome = 'refusal';
      else {
        outcome = 'error';
        detail = `stopped: ${stop}`;
      }
      break;
    }
  }

  // The platform's own figure for the session, running time included, is the one the ledger keeps.
  const final = await o.port.retrieveSession(session.id);
  const listCents = Number(final.usage?.list_cost?.amount ?? NaN);
  if (Number.isFinite(listCents) && listCents / 100 > usd + 0.005) {
    const extra = listCents / 100 - usd;
    usd += o.meter.recordListCost(o.model, extra, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { impl: 'managed', label: `${o.label} list cost beyond tokens` }).usd;
  }
  if (o.exportPath) {
    const log = await o.port.listEvents(session.id);
    mkdirSync(dirname(o.exportPath), { recursive: true });
    writeFileSync(o.exportPath, log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  print(`managed session ${session.id}: ${outcome}, ${turns.length} model requests, $${usd.toFixed(4)}`);
  const view = await readView(o.client);
  return { impl: 'managed', model: o.model, outcome, ...(detail ? { detail } : {}), run: recorder.finish(view.events, view.organiser), turns, usd, durationMs: performance.now() - started };
}
