/**
 * The hooks. PreToolUse re-checks every call on its actual arguments before the MCP server sees it (allow-list, the
 * server's closed schema, then the engine's own authority predicate against the store, read-only, failing closed).
 * PostToolUse and PostToolUseFailure record the outcome. Every decision goes into the audit trail.
 */
import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { CallGuard, CallOutcome, RunRecorder } from '@ghillie/agent-kit';
import { rotaToolName } from './options.js';
import type { HarnessState } from './state.js';

export interface HookContext {
  tickId: string;
  guard: CallGuard;
  recorder: RunRecorder;
  state: HarnessState;
}

const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

const asArgs = (input: unknown): Record<string, unknown> => (input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {});

/**
 * The MCP result as the SDK hands it to PostToolUse. Measured on a live run: a plain string, the tool's text content
 * (the service's JSON). Content blocks, with or without structured content, are handled too.
 */
export function outcomeOfResponse(response: unknown): CallOutcome {
  if (typeof response === 'string') return outcomeOfText(response, false);
  const blocks = Array.isArray(response) ? response : Array.isArray((response as { content?: unknown })?.content) ? (response as { content: unknown[] }).content : [];
  const text = (blocks as { text?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
  const structured = (response as { structuredContent?: unknown })?.structuredContent;
  const isError = (response as { isError?: unknown })?.isError === true || text.startsWith('error:');
  if (structured && typeof structured === 'object') return { isError, result: structured as Record<string, unknown>, text };
  return outcomeOfText(text, isError);
}

function outcomeOfText(text: string, flagged: boolean): CallOutcome {
  const isError = flagged || text.startsWith('error:');
  if (isError) return { isError: true, result: null, text };
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? { isError: false, result: parsed as Record<string, unknown>, text } : { isError: true, result: null, text };
  } catch {
    return { isError: true, result: null, text };
  }
}

export function createHooks(context: HookContext): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { tickId, guard, recorder, state } = context;
  const record = (name: string, args: Record<string, unknown>, outcome: CallOutcome): void => {
    recorder.record(name, args, outcome);
    state.journal.append({ tickId, name, args, outcome });
  };

  const pre: HookCallback = (input) => {
    if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
    const name = rotaToolName(input.tool_name);
    const args = asArgs(input.tool_input);
    const base = { tickId, sessionId: input.session_id, hook: 'PreToolUse' as const, tool: input.tool_name, args };
    if (!name) {
      state.audit.write({ ...base, decision: 'deny', reason: 'allow_list: not a rota tool' });
      return Promise.resolve(deny(`${input.tool_name} is not one of the rota tools`));
    }
    const decision = guard.check(name, input.tool_input);
    if (!decision.ok) {
      state.audit.write({ ...base, decision: 'deny', reason: `${decision.stage}: ${decision.refusal}` });
      // The model sees the refusal as the tool's result; the recorder keeps it with the run's refusals. An authority
      // refusal is the service's own answer (the same predicate), so it is recorded as the service would return it.
      const text = `refused by the hook (${decision.stage}): ${decision.refusal}: ${decision.detail}`;
      record(name, args, decision.stage === 'precheck' ? { isError: false, result: { ok: false, refusal: decision.refusal, detail: decision.detail }, text } : { isError: true, result: null, text });
      return Promise.resolve(deny(`refused (${decision.stage}): ${decision.refusal}: ${decision.detail}`));
    }
    state.audit.write({ ...base, decision: 'allow', reason: 'checked' });
    return Promise.resolve({});
  };

  const post: HookCallback = (input) => {
    if (input.hook_event_name === 'PostToolUse') {
      const name = rotaToolName(input.tool_name);
      if (name) {
        const outcome = outcomeOfResponse(input.tool_response);
        record(name, asArgs(input.tool_input), outcome);
        const reason = outcome.isError ? 'error' : outcome.result?.ok === false ? String(outcome.result.refusal) : 'ok';
        state.audit.write({ tickId, sessionId: input.session_id, hook: 'PostToolUse', tool: input.tool_name, args: input.tool_input, decision: 'recorded', reason });
      }
    } else if (input.hook_event_name === 'PostToolUseFailure') {
      const name = rotaToolName(input.tool_name);
      if (name) record(name, asArgs(input.tool_input), { isError: true, result: null, text: `error: ${input.error}` });
      state.audit.write({ tickId, sessionId: input.session_id, hook: 'PostToolUseFailure', tool: input.tool_name, args: input.tool_input, decision: 'recorded', reason: input.error });
    }
    return Promise.resolve({});
  };

  return { PreToolUse: [{ hooks: [pre] }], PostToolUse: [{ hooks: [post] }], PostToolUseFailure: [{ hooks: [post] }] };
}
