/**
 * The harness's check on every tool call, before it reaches the MCP server. In order, and the first refusal wins:
 *
 *   1. the tool is on the allow-list (named in code: the server's eight tools and nothing else);
 *   2. the arguments match the server's own closed schema, so a call carrying a field such as approved, actor,
 *      approver, mode or an approval id is refused here, before any rule is consulted;
 *   3. optionally, the engine's own authority predicate, read-only, against the store (precheckCall). If the store
 *      cannot be opened or read, the call is refused: the guard fails closed.
 *
 * The service checks everything again when the call arrives. The guard exists so a call that could only be refused
 * is stopped where the harness can record why.
 */
import { config as defaultConfig, precheckCall, type GhillieConfig, type Store } from '@ghillie/engine';
import type { SchemaValidator } from './catalogue.js';

export type GuardStage = 'allow_list' | 'schema' | 'precheck';

export type GuardDecision = { ok: true } | { ok: false; stage: GuardStage; refusal: string; detail: string };

export interface GuardOptions {
  validator: SchemaValidator;
  /** Tool names the harness allows, named in code. */
  allowed: readonly string[];
  /** Opens (or returns) the store for the read-only precheck. Leave out to skip the precheck. */
  store?: () => Store;
  settings?: GhillieConfig;
}

export class CallGuard {
  private readonly allowed: Set<string>;

  constructor(private readonly options: GuardOptions) {
    this.allowed = new Set(options.allowed);
  }

  check(name: string, args: unknown): GuardDecision {
    if (!this.allowed.has(name) || !this.options.validator.has(name)) {
      return { ok: false, stage: 'allow_list', refusal: 'tool_not_allowed', detail: `${name} is not one of the rota tools` };
    }
    const valid = this.options.validator.validate(name, args);
    if (!valid.ok) return { ok: false, stage: 'schema', refusal: 'invalid_arguments', detail: valid.errors };
    const openStore = this.options.store;
    if (!openStore) return { ok: true };
    let store: Store;
    try {
      store = openStore();
    } catch (error) {
      return { ok: false, stage: 'precheck', refusal: 'store_unreadable', detail: error instanceof Error ? error.message : String(error) };
    }
    const answer = precheckCall(store, name, args as Record<string, unknown>, this.options.settings ?? defaultConfig);
    return answer.ok ? { ok: true } : { ok: false, stage: 'precheck', refusal: answer.refusal, detail: answer.detail };
  }
}

/** The eight rota tools, named in code. Anything else is never offered and never run. */
export const rotaTools = ['log_run', 'message_organiser', 'propose_recruit', 'read_rota', 'set_availability', 'set_decision', 'update_event', 'update_person'] as const;

/** The tools that change something. Managed Agents asks before each of these runs. */
export const writeTools: readonly string[] = ['log_run', 'message_organiser', 'propose_recruit', 'set_availability', 'set_decision', 'update_event', 'update_person'];
