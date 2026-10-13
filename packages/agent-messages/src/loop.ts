/**
 * The rota agent as a hand-written Messages API loop. Everything the other two builds get from a framework is here in
 * plain sight:
 *
 *   - the full history is resent on every call, and each assistant turn is appended exactly as it was returned
 *     (thinking blocks included: they are tied to this conversation and must come back unchanged);
 *   - every stop reason is routed: tool_use runs the tools, pause_turn resends, max_tokens retries once with more room
 *     and never runs a truncated tool call, refusal stops, end_turn finishes (after one reminder if the run was not
 *     logged);
 *   - the turn limit is counted here, in code;
 *   - every tool call goes through the gate (allow-list, the server's own schema) before it reaches the MCP server;
 *   - tool results are keyed by tool_use id, and errors are marked as errors;
 *   - every turn is traced with its usage, duration and cost, and the cost is printed as it happens;
 *   - the stable prompt comes first with a cache breakpoint, the volatile brief last, and the growing conversation
 *     is cached automatically behind it;
 *   - server-side fallbacks are on, so a refused request is retried on the recommended model before we see it.
 */
import type ApiClient from '@anthropic-ai/sdk';
import { performance } from 'node:perf_hooks';
import { SYSTEM_PROMPT, formatTurn, strictSchema, strictToolNames, type GateResult, type TickOutcome, type ToolSpec, type TurnTrace } from '@ghillie/agent-kit';
import type { ApiUsage, SpendMeta } from '@ghillie/ledger';

export type Params = ApiClient.Beta.Messages.MessageCreateParamsNonStreaming;
export type Reply = ApiClient.Beta.Messages.BetaMessage;
type MessageParam = ApiClient.Beta.Messages.BetaMessageParam;
type ToolResult = ApiClient.Beta.Messages.BetaToolResultBlockParam;

/** The one API call the loop makes. The real client, a recorder or a test stub. */
export interface MessagesPort {
  create(params: Params): Promise<Reply>;
}

/** Records spend and refuses to start once the cap has passed: the ledger, or a meter that only prices replays. */
export interface Meter {
  assertUnderCap(): void;
  record(model: string, usage: ApiUsage, meta: SpendMeta): { usd: number }[];
}

export interface LoopOptions {
  port: MessagesPort;
  gate: { run: (name: string, input: unknown) => Promise<GateResult> };
  tools: ToolSpec[];
  brief: string;
  model: string;
  meter: Meter;
  label: string;
  maxTurns: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Checked when the model stops: a reminder to send once, or null if nothing is missing. */
  obligation?: () => string | null;
  print?: (line: string) => void;
}

export interface LoopResult {
  outcome: TickOutcome;
  detail?: string;
  turns: TurnTrace[];
  usd: number;
  messages: MessageParam[];
}

/** The beta that turns on `fallbacks: "default"`, the form the platform recommends. */
export const fallbackBeta = 'server-side-fallback-2026-07-01';
const maxTokensCeiling = 64_000;

/** Same tools, same order, same bytes on every request: the prefix the cache reads. */
export function apiTools(tools: ToolSpec[]): ApiClient.Beta.Messages.BetaTool[] {
  const strict = strictToolNames(tools);
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object' as const, ...strictSchema(t.inputSchema) }, strict: strict.has(t.name) }));
}

export function buildRequest(o: Pick<LoopOptions, 'model' | 'tools' | 'effort'>, messages: MessageParam[], maxTokens: number): Params {
  return {
    model: o.model,
    max_tokens: maxTokens,
    betas: [fallbackBeta],
    fallbacks: 'default',
    output_config: { effort: o.effort ?? 'medium' },
    tools: apiTools(o.tools),
    // The stable prompt, with its own breakpoint: tools and system are read from cache on every later request.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    // Automatic caching for the growing conversation behind it.
    cache_control: { type: 'ephemeral' },
    messages: [...messages],
  };
}

const counts = (u: Reply['usage']): TurnTrace['usage'] => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
});

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const print = o.print ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const messages: MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: o.brief }] }];
  const turns: TurnTrace[] = [];
  let maxTokens = o.maxTokens ?? 16_000;
  let usd = 0;
  let reminded = false;
  const done = (outcome: TickOutcome, detail?: string): LoopResult => ({ outcome, ...(detail ? { detail } : {}), turns, usd, messages });

  for (let turn = 1; turn <= o.maxTurns; turn++) {
    o.meter.assertUnderCap();
    const started = performance.now();
    const reply = await o.port.create(buildRequest(o, messages, maxTokens));
    const cost = o.meter.record(reply.model, reply.usage, { impl: 'messages', label: `${o.label} turn ${turn}` }).reduce((sum, e) => sum + e.usd, 0);
    usd += cost;
    const trace: TurnTrace = { turn, stopReason: reply.stop_reason ?? 'none', model: reply.model, durationMs: performance.now() - started, usage: counts(reply.usage), usd: cost, tools: [] };
    turns.push(trace);

    switch (reply.stop_reason) {
      case 'tool_use': {
        messages.push({ role: 'assistant', content: reply.content });
        const results: ToolResult[] = [];
        for (const block of reply.content) {
          if (block.type !== 'tool_use') continue;
          const ran = await o.gate.run(block.name, block.input);
          trace.tools.push({ name: block.name, ok: ran.ok, ...(ran.refusal ? { refusal: ran.refusal } : {}), durationMs: ran.durationMs });
          results.push({ type: 'tool_result', tool_use_id: block.id, content: ran.content, ...(ran.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        break;
      }
      case 'pause_turn':
        // The server paused its own loop: send the turn back as it is and it carries on. No extra user message.
        messages.push({ role: 'assistant', content: reply.content });
        break;
      case 'max_tokens':
        // A tool call cut off here can still parse. Never run it: retry the same request with more room, once.
        if (maxTokens >= maxTokensCeiling) {
          print(formatTurn(trace));
          return done('max_tokens', `stopped at ${maxTokens} output tokens`);
        }
        maxTokens = Math.min(maxTokens * 2, maxTokensCeiling);
        break;
      case 'refusal': {
        // The whole fallback chain declined. Nothing in this turn is used, and no tool in it runs.
        print(formatTurn(trace));
        const category = reply.stop_details && 'category' in reply.stop_details ? String(reply.stop_details.category ?? 'none') : 'none';
        return done('refusal', `refused, category ${category}`);
      }
      case 'end_turn':
      case 'stop_sequence': {
        messages.push({ role: 'assistant', content: reply.content });
        const missing = reminded ? null : (o.obligation?.() ?? null);
        print(formatTurn(trace));
        if (!missing) return done('completed');
        reminded = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: missing }] });
        continue;
      }
      default:
        print(formatTurn(trace));
        return done('error', `unexpected stop reason ${String(reply.stop_reason)}`);
    }
    print(formatTurn(trace));
  }
  return done('turn_limit', `stopped after ${o.maxTurns} turns`);
}
