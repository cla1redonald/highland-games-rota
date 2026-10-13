/**
 * The one door every model-requested tool call goes through in a harness that executes tools itself: check, call,
 * record. A refused check is returned to the model as an error result, with the reason, and the MCP server never sees
 * the call.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallGuard } from './guard.js';
import { callObserved } from './mcp.js';
import type { RunRecorder } from './recorder.js';

export interface GateResult {
  isError: boolean;
  /** What goes back to the model: the service's JSON result, or the error. */
  content: string;
  ok: boolean;
  refusal?: string;
  durationMs: number;
}

export class ToolGate {
  constructor(
    private readonly client: Client,
    private readonly guard: CallGuard,
    private readonly recorder: RunRecorder,
  ) {}

  async run(name: string, input: unknown): Promise<GateResult> {
    const args = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const decision = this.guard.check(name, input);
    if (!decision.ok) {
      const content = `refused by the harness (${decision.stage}): ${decision.refusal}: ${decision.detail}`;
      this.recorder.record(name, args, { isError: true, result: null, text: content });
      return { isError: true, content, ok: false, refusal: decision.refusal, durationMs: 0 };
    }
    const outcome = await callObserved(this.client, name, args);
    this.recorder.record(name, args, outcome);
    const refusal = outcome.result?.ok === false && typeof outcome.result.refusal === 'string' ? outcome.result.refusal : undefined;
    return {
      isError: outcome.isError,
      content: outcome.isError ? outcome.text : JSON.stringify(outcome.result),
      ok: !outcome.isError && outcome.result?.ok !== false,
      ...(refusal ? { refusal } : {}),
      durationMs: outcome.durationMs,
    };
  }
}
