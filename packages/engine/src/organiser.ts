/**
 * The organiser's own hand: edits she makes herself, approvals and declines, the mode switch, and accepting a
 * Saturday's suggested split. None of this is reachable through the MCP server. In the demo, the feed's console items
 * stand in for her clicking these buttons.
 */
import { addPersonAction, canonicalJson, fingerprint } from './fingerprint.js';
import { planRota } from './coverage.js';
import { londonDate } from './dates.js';
import { cellKey, type Store } from './store.js';
import type { CellValue, Decision, Mode, PersonStatus } from './types.js';
import { config as defaultConfig, type GhillieConfig } from './config.js';

export class OrganiserConsole {
  constructor(
    private readonly store: Store,
    private readonly clock: () => Date,
    private readonly settings: GhillieConfig = defaultConfig,
  ) {}

  private get name(): string {
    return this.settings.roles.organiser;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** A hand edit to a cell. Her edit carries its own time as evidence, so older evidence can never overwrite it. */
  editCell(person: string, event: string, value: CellValue, note?: string): void {
    this.store.transaction(() => {
      const cell = this.store.cell(person, event);
      this.store.putCell({ ...cell, value, note: note ?? cell.note, inferred: false });
      this.store.appendLog({
        writtenAt: this.now(),
        who: 'organiser',
        saidBy: this.name,
        entity: 'cell',
        key: cellKey(person, event),
        field: 'value',
        old: cell.value,
        new: value,
        source: 'hand edit',
        evidenceAt: this.now(),
      });
    });
  }

  /** Her provisional rota. Pencilled people must have said Yes; the split places them first. */
  pencil(person: string, event: string, asLead = false): void {
    this.store.transaction(() => {
      const cell = this.store.cell(person, event);
      this.store.putCell({ ...cell, pencilled: true, pencilledAsLead: asLead });
      this.store.appendLog({
        writtenAt: this.now(),
        who: 'organiser',
        saidBy: this.name,
        entity: 'cell',
        key: cellKey(person, event),
        field: 'pencilled',
        old: String(cell.pencilled),
        new: asLead ? 'as lead' : 'true',
        source: 'hand edit',
        evidenceAt: this.now(),
      });
    });
  }

  private grant(action: Record<string, string | number | boolean | null | Record<string, string | number | boolean | null>>, proposalId = ''): number {
    return this.store.appendApproval({
      kind: 'grant',
      fingerprint: fingerprint(action),
      proposalId,
      by: this.name,
      at: this.now(),
      action: canonicalJson(action),
    }).seq;
  }

  /** Approves one recruit proposal: adding that named person to the Pipeline, once. */
  approve(proposalId: string): { ok: boolean; detail: string } {
    const proposal = this.store.proposals().find((p) => p.id === proposalId);
    if (!proposal) return { ok: false, detail: `no proposal ${proposalId}` };
    this.grant(addPersonAction(proposal.name, 'Pipeline'), proposalId);
    return { ok: true, detail: `${this.name} approved adding ${proposal.name} to the Pipeline` };
  }

  /** Approves one booking decision for one person at one event. The agent may record exactly that, once. */
  approveDecision(person: string, event: string, value: Decision): { ok: boolean; detail: string } {
    this.grant({ kind: 'set_decision', person, event, value });
    return { ok: true, detail: `${this.name} approved ${person} ${value} at ${event}` };
  }

  /** Approves one change to an event, field for field. A date change resets every answer when it is carried out. */
  approveEventChange(event: string, fields: Record<string, string | number | boolean | null>): { ok: boolean; detail: string } {
    this.grant({ kind: 'update_event', event, fields });
    return { ok: true, detail: `${this.name} approved changing ${event}: ${Object.entries(fields).map(([k, v]) => `${k} ${String(v)}`).join(', ')}` };
  }

  /** Approves one status change for one person. */
  approveStatus(person: string, status: PersonStatus): { ok: boolean; detail: string } {
    this.grant({ kind: 'set_status', person, status });
    return { ok: true, detail: `${this.name} approved ${person} as ${status}` };
  }

  /** Declines a recruit: that person is never proposed again. */
  decline(proposalId: string): { ok: boolean; detail: string } {
    const proposal = this.store.proposals().find((p) => p.id === proposalId);
    if (!proposal) return { ok: false, detail: `no proposal ${proposalId}` };
    this.store.appendApproval({
      kind: 'decline',
      fingerprint: proposal.fingerprint,
      proposalId,
      by: this.name,
      at: this.now(),
      action: canonicalJson(addPersonAction(proposal.name, 'Pipeline')),
    });
    return { ok: true, detail: `${this.name} declined ${proposal.name}` };
  }

  /** Withdraws an approval she granted and has not been used. */
  withdraw(grantSeq: number): { ok: boolean; detail: string } {
    const grant = this.store.approvals().find((a) => a.seq === grantSeq && a.kind === 'grant');
    if (!grant) return { ok: false, detail: `no approval ${grantSeq}` };
    this.store.appendApproval({ kind: 'decline', fingerprint: grant.fingerprint, proposalId: grant.proposalId, ref: grant.seq, by: this.name, at: this.now(), action: grant.action });
    return { ok: true, detail: `${this.name} withdrew approval ${grantSeq}` };
  }

  setMode(mode: Mode): void {
    const old = this.store.getMode();
    this.store.setModeRow(mode);
    this.store.appendLog({
      writtenAt: this.now(),
      who: 'organiser',
      saidBy: this.name,
      entity: 'settings',
      key: 'mode',
      field: 'mode',
      old,
      new: mode,
      source: 'console',
      evidenceAt: this.now(),
    });
  }

  /** Books a Saturday's suggested split under her name: the people placed become Stewarding at the game they were placed. */
  acceptSplit(date: string): { booked: { person: string; event: string }[] } {
    const plan = planRota(this.store.people(), this.store.events(), this.store.cells(), londonDate(this.now()), {
      rules: this.settings.rules,
      roles: this.settings.roles,
    });
    const booked: { person: string; event: string }[] = [];
    for (const game of plan.games.filter((g) => g.date === date)) {
      for (const person of game.placed) {
        this.editCell(person, game.id, 'Stewarding');
        booked.push({ person, event: game.id });
      }
    }
    return { booked };
  }
}
