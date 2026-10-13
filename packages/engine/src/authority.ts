/**
 * Who may do what: the one predicate for every write that needs the organiser's authority. The service calls it at
 * the moment of a write; harnesses call it (through precheckCall) before a call reaches the service. Same function,
 * same store, same answer.
 *
 * Authority is derived from the engine's own state only: the approvals ledger (a grant the organiser made on her own
 * path, for exactly this action's fingerprint, neither used nor declined) and the run mode held in the store. The
 * request names the action being asked for and nothing else: no actor, approver, approval id, flag or mode. A grant
 * can be found only by recomputing the fingerprint of the action itself, so an approval id, a replayed approval, an
 * approval for a different action and a used or declined approval all fail the same way.
 */
import { addPersonAction } from './fingerprint.js';
import { findOpenGrant } from './grants.js';
import type { Store } from './store.js';
import type { ApprovalRecord } from './types.js';

export type AuthorityRequest =
  | { kind: 'set_decision'; person: string; event: string; value: string }
  | { kind: 'update_event'; event: string; fields: { [key: string]: string | number | boolean | null } }
  | { kind: 'add_person'; person: string; surname: string; status: string }
  | { kind: 'set_status'; person: string; status: string };

export type AuthorityRefusal = 'decision_needs_full_mode' | 'approval_missing';

export type Authority =
  | { ok: true; grant: ApprovalRecord; noop?: false }
  /** Recording what is already there changes nothing, so it needs no authority. */
  | { ok: true; grant: null; noop: true }
  | { ok: false; refusal: AuthorityRefusal; detail: string };

export function authorise(store: Store, request: AuthorityRequest, organiser: string): Authority {
  switch (request.kind) {
    case 'set_decision': {
      if (store.getMode() !== 'full') return { ok: false, refusal: 'decision_needs_full_mode', detail: 'tuning mode: propose the decision to the organiser instead' };
      const grant = findOpenGrant(store.approvals(), { kind: 'set_decision', person: request.person, event: request.event, value: request.value });
      if (grant) return { ok: true, grant };
      if (store.cell(request.person, request.event).value === request.value) return { ok: true, grant: null, noop: true };
      return { ok: false, refusal: 'approval_missing', detail: `no approval from ${organiser} for ${request.person} ${request.value} at ${request.event}: propose it instead` };
    }
    case 'update_event': {
      const grant = findOpenGrant(store.approvals(), { kind: 'update_event', event: request.event, fields: request.fields });
      if (grant) return { ok: true, grant };
      return { ok: false, refusal: 'approval_missing', detail: `no approval from ${organiser} for this change to ${request.event}: raise it instead` };
    }
    case 'add_person': {
      const fullName = `${request.person} ${request.surname}`;
      const grant = findOpenGrant(store.approvals(), addPersonAction(fullName, request.status));
      if (grant) return { ok: true, grant };
      return { ok: false, refusal: 'approval_missing', detail: `no approval from ${organiser} for adding ${fullName} as ${request.status}` };
    }
    case 'set_status': {
      const grant = findOpenGrant(store.approvals(), { kind: 'set_status', person: request.person, status: request.status });
      if (grant) return { ok: true, grant };
      return { ok: false, refusal: 'approval_missing', detail: `a status changes only with ${organiser}'s approval` };
    }
  }
}
