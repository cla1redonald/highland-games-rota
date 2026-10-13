/**
 * One tick of the Messages API build: the harness's read, the brief, the guarded tool gate, the loop, the run record.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { performance } from 'node:perf_hooks';
import { CallGuard, RunRecorder, SchemaValidator, ToolGate, loadCatalogue, readView, renderBrief, rotaTools, type AgentTick, type TickInput } from '@ghillie/agent-kit';
import { runLoop, type Meter, type MessagesPort } from './loop.js';

export interface MessagesTickOptions {
  port: MessagesPort;
  /** A connection to the Phase 1a MCP server (a stdio subprocess for live runs). */
  client: Client;
  tick: TickInput;
  model: string;
  meter: Meter;
  label: string;
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high';
  print?: (line: string) => void;
}

export const logReminder = 'You have not called log_run yet. Log the run now with the logRun fields from the brief, then stop.';

export async function runMessagesTick(o: MessagesTickOptions): Promise<AgentTick> {
  const started = performance.now();
  const tools = (await loadCatalogue(o.client)).filter((t) => (rotaTools as readonly string[]).includes(t.name));
  const recorder = new RunRecorder(o.tick);
  const guard = new CallGuard({ validator: new SchemaValidator(tools), allowed: rotaTools });
  const gate = new ToolGate(o.client, guard, recorder);
  const result = await runLoop({
    port: o.port,
    gate,
    tools,
    brief: renderBrief(o.tick),
    model: o.model,
    meter: o.meter,
    label: o.label,
    maxTurns: o.maxTurns ?? 24,
    ...(o.effort ? { effort: o.effort } : {}),
    obligation: () => (recorder.names.includes('log_run') ? null : logReminder),
    ...(o.print ? { print: o.print } : {}),
  });
  const view = await readView(o.client);
  return {
    impl: 'messages',
    model: o.model,
    outcome: result.outcome,
    ...(result.detail ? { detail: result.detail } : {}),
    run: recorder.finish(view.events, view.organiser),
    turns: result.turns,
    usd: result.usd,
    durationMs: performance.now() - started,
  };
}
