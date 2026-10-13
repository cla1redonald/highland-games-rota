/**
 * One tick of the Agent SDK build. The SDK runs the loop and the MCP server; the harness owns the brief, the hooks,
 * the ceilings, the ledger and the record, and keeps enough on disk to resume a tick that was killed.
 *
 * Resuming: a tick id whose session did not finish is resumed with `resume`, so the conversation carries on where
 * it stopped. Nothing the organiser decided can be lost or done twice either way: her approvals live in the store and
 * each is used once by the service, so a decision carried out before the kill is a no-op after it, and one not yet
 * carried out is still waiting.
 */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { performance } from 'node:perf_hooks';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallGuard, RunRecorder, SchemaValidator, loadCatalogue, readView, renderBrief, rotaTools, type AgentTick, type TickInput, type TickOutcome, type TurnTrace } from '@ghillie/agent-kit';
import type { Store } from '@ghillie/engine';
import type { ApiUsage } from '@ghillie/ledger';
import { createHooks } from './hooks.js';
import { allowedToolNames, buildSdkOptions } from './options.js';
import type { HarnessState } from './state.js';

export type QueryFn = (params: { prompt: string; options: Options }) => Query | AsyncIterable<SDKMessage>;

export interface SdkMeter {
  assertUnderCap(): void;
  record(model: string, usage: ApiUsage, meta: { impl: string; label: string }): { usd: number }[];
}

export interface SdkTickOptions {
  query: QueryFn;
  tick: TickInput;
  tickId: string;
  model: string;
  meter: SdkMeter;
  state: HarnessState;
  /** The store file the MCP server opens, and its clock. */
  dbPath: string;
  clock: string;
  /** Opens the same store, read-only use, for the pre-tool-use check. */
  store: () => Store;
  /** A connection for the harness's own reads (the catalogue and the final view). */
  client: Client;
  maxTurns?: number;
  maxBudgetUsd?: number;
  credential?: { name: string; value: string };
  print?: (line: string) => void;
}

export const resumePrompt =
  'You were interrupted part way through this tick. Read the rota again and carry on from where you stopped. Anything the rota already shows is done: do not repeat it. Finish with message_organiser if needed, then log_run.';
const logReminder = 'You have not called log_run yet. Log the run now with the logRun fields from the brief, then stop.';

const resultOutcome: Record<string, TickOutcome> = { success: 'completed', error_max_turns: 'turn_limit', error_max_budget_usd: 'budget', error_during_execution: 'error' };

export async function runSdkTick(o: SdkTickOptions): Promise<AgentTick> {
  const started = performance.now();
  const print = o.print ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const tools = (await loadCatalogue(o.client)).filter((t) => (rotaTools as readonly string[]).includes(t.name));
  const recorder = new RunRecorder(o.tick);
  // Calls made before a kill are part of this tick's record.
  for (const entry of o.state.journal.forTick(o.tickId)) recorder.record(entry.name, entry.args, entry.outcome);
  const guard = new CallGuard({ validator: new SchemaValidator(tools), allowed: rotaTools, store: o.store });
  const hooks = createHooks({ tickId: o.tickId, guard, recorder, state: o.state });
  const turns: TurnTrace[] = [];
  const seen = new Set<string>();
  let usd = 0;
  // Written from inside the pass closure, so kept in an object TypeScript does not narrow.
  const status: { outcome: TickOutcome; detail?: string } = { outcome: 'error' };

  const pass = async (prompt: string, resume?: string): Promise<void> => {
    o.meter.assertUnderCap();
    const options = buildSdkOptions({
      model: o.model,
      dbPath: o.dbPath,
      clock: o.clock,
      stateDir: o.state.dir,
      hooks,
      maxTurns: o.maxTurns ?? 24,
      maxBudgetUsd: o.maxBudgetUsd ?? 2,
      ...(resume ? { resume } : {}),
      ...(o.credential ? { credential: o.credential } : {}),
    });
    let turnStarted = performance.now();
    for await (const message of o.query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        const extra = message.tools.filter((t) => !allowedToolNames.includes(t));
        if (extra.length) throw new Error(`deny by default broken: the session offers ${extra.join(', ')}`);
        o.state.sessions.set(o.tickId, { sessionId: message.session_id, status: 'running' });
      } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
        const reply = message.message;
        // A streamed message can arrive in several frames with the same id and usage: count it once.
        if (seen.has(reply.id)) continue;
        seen.add(reply.id);
        const cost = o.meter.record(reply.model, reply.usage, { impl: 'sdk', label: `${o.tickId} turn ${turns.length + 1}` }).reduce((s, e) => s + e.usd, 0);
        usd += cost;
        const now = performance.now();
        turns.push({
          turn: turns.length + 1,
          stopReason: reply.stop_reason ?? 'streamed',
          model: reply.model,
          durationMs: now - turnStarted,
          usage: { input: reply.usage.input_tokens, output: reply.usage.output_tokens, cacheRead: reply.usage.cache_read_input_tokens ?? 0, cacheWrite: reply.usage.cache_creation_input_tokens ?? 0 },
          usd: cost,
          tools: reply.content.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, ok: true, durationMs: 0 })),
        });
        turnStarted = now;
      } else if (message.type === 'result') {
        status.outcome = resultOutcome[message.subtype] ?? 'error';
        status.detail =
          message.subtype === 'success' ? `SDK reported $${message.total_cost_usd.toFixed(4)} over ${message.num_turns} turns` : `${message.subtype}: ${message.errors.join('; ')}`;
        o.state.sessions.set(o.tickId, { sessionId: message.session_id, status: status.outcome === 'completed' ? 'completed' : 'interrupted' });
      }
    }
  };

  const previous = o.state.sessions.get(o.tickId);
  try {
    if (previous && previous.status !== 'completed') await pass(resumePrompt, previous.sessionId);
    else await pass(renderBrief(o.tick));
    const sessionId = o.state.sessions.get(o.tickId)?.sessionId;
    if (status.outcome === 'completed' && !recorder.names.includes('log_run') && sessionId) await pass(logReminder, sessionId);
  } catch (error) {
    // Killed, crashed or cut off: the session stays resumable under this tick id.
    const entry = o.state.sessions.get(o.tickId);
    if (entry) o.state.sessions.set(o.tickId, { sessionId: entry.sessionId, status: 'interrupted' });
    status.outcome = 'interrupted';
    status.detail = error instanceof Error ? error.message : String(error);
  }
  for (const t of turns) print(`turn ${t.turn} ${t.stopReason} $${t.usd.toFixed(4)}`);
  const view = await readView(o.client);
  return { impl: 'sdk', model: o.model, outcome: status.outcome, ...(status.detail ? { detail: status.detail } : {}), run: recorder.finish(view.events, view.organiser), turns, usd, durationMs: performance.now() - started };
}
