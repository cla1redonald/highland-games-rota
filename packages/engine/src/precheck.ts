/**
 * A read-only re-check of a tool call, before the call reaches the service. Harnesses use it as a second line (the
 * Agent SDK's pre-tool-use hook, the Managed Agents confirmer).
 *
 * It decides exactly what the service would decide about authority, because it calls the same predicate
 * (`authorise`, in authority.ts) against the same store: the approvals ledger and the run mode held in engine state.
 * The call's arguments only say which action is being asked for (a person, an event, a value). Nothing in them is
 * read as authority: no saidBy, no source, no approval id, no flag, and no environment variable is consulted.
 *
 * Fields that would carry authority (approved, actor, approver, mode and the like) never get this far: every tool's
 * schema is closed, and harnesses validate against it before calling this. If anything goes wrong reading the
 * store, the answer is a refusal, never an allow.
 */
import { config as defaultConfig, type GhillieConfig } from './config.js';
import { authorise, type AuthorityRequest } from './authority.js';
import type { Store } from './store.js';

export type Precheck = { ok: true } | { ok: false; refusal: string; detail: string };

const eventFieldNames = ['date', 'confirmed', 'target', 'type'] as const;

class BadArguments extends Error {}

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new BadArguments(`${name} is not text`);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadArguments(`${name} is not an object`);
  return value as Record<string, unknown>;
}

/** The action a call asks for, as the authority predicate names it. Null for calls that need no authority. */
export function authorityRequestOf(tool: string, args: Record<string, unknown>): AuthorityRequest[] {
  switch (tool) {
    case 'set_decision':
      return [{ kind: 'set_decision', person: text(args, 'person'), event: text(args, 'event'), value: text(args, 'value') }];
    case 'update_event': {
      const fields = object(args.fields, 'fields');
      const action: { [key: string]: string | number | boolean | null } = {};
      for (const name of eventFieldNames) {
        const value = fields[name];
        if (value === undefined) continue;
        if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new BadArguments(`fields.${name}`);
        action[name] = value;
      }
      return [{ kind: 'update_event', event: text(args, 'event'), fields: action }];
    }
    case 'update_person': {
      const requests: AuthorityRequest[] = [];
      const person = text(args, 'person');
      if (args.create !== undefined) {
        const create = object(args.create, 'create');
        requests.push({ kind: 'add_person', person, surname: text(create, 'surname'), status: text(create, 'status') });
      }
      if (args.fields !== undefined) {
        const fields = object(args.fields, 'fields');
        if (fields.status !== undefined) requests.push({ kind: 'set_status', person, status: text(fields, 'status') });
      }
      return requests;
    }
    default:
      return [];
  }
}

export function precheckCall(store: Store, tool: string, args: Record<string, unknown>, settings: GhillieConfig = defaultConfig): Precheck {
  try {
    for (const request of authorityRequestOf(tool, args)) {
      // A status the person already has changes nothing; the service skips it without asking for authority.
      if (request.kind === 'set_status' && store.person(request.person)?.status === request.status) continue;
      const answer = authorise(store, request, settings.roles.organiser);
      if (!answer.ok) return { ok: false, refusal: answer.refusal, detail: answer.detail };
    }
    return { ok: true };
  } catch (error) {
    // Fail closed: arguments the check cannot read, or a store it cannot read, are a refusal.
    if (error instanceof BadArguments) return { ok: false, refusal: 'invalid_arguments', detail: error.message };
    return { ok: false, refusal: 'store_unreadable', detail: error instanceof Error ? error.message : String(error) };
  }
}
