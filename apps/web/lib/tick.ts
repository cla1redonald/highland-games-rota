/**
 * The "Ghillie at work" panel as data: every row the agent's tick has produced so far, with the time it happened
 * relative to the tick's start. The page folds each streamed message in with `fold`.
 */
import { argText, outcomeOf, toolWords, writeText, type Labels, type Pill } from './format';
import type { StepMessage, TickEnd, TickStart } from './messages';

export type AgentRow =
  | { kind: 'status'; t: number; text: string }
  | { kind: 'model'; t0: number; t1?: number; text?: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; title: string; args: string; t0: number; t1?: number; guard?: boolean; pill?: Pill; bad?: boolean; written?: boolean }
  | { kind: 'note'; t: number; text: string }
  | { kind: 'write'; title: string; detail: string; pill: Pill; bad?: boolean; propose?: boolean };

export interface Tick {
  start: TickStart;
  rows: AgentRow[];
  end: TickEnd | null;
  /** performance.now() when the tick started, on this page. */
  startedAt: number;
  endedAt: number | null;
  session: string;
  requests: number;
  usd: number;
}

export function begin(start: TickStart, now: number): Tick {
  const rows: AgentRow[] = start.mode !== 'stand-in' && (start.items.length || start.console.length) ? [{ kind: 'status', t: 0, text: 'Starting a session' }] : [];
  return { start, rows, end: null, startedAt: now, endedAt: null, session: '', requests: 0, usd: 0 };
}

const lastOpen = <T extends AgentRow>(rows: AgentRow[], match: (r: AgentRow) => r is T): number => {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && match(r)) return i;
  }
  return -1;
};

export function fold(tick: Tick, s: StepMessage, now: number, labels: Labels): Tick {
  const t = now - tick.startedAt;
  const rows = [...tick.rows];
  switch (s.kind) {
    case 'session':
      return { ...tick, session: s.replayOf ? `Replaying ${s.sessionId}, recorded ${new Date(s.replayOf).toLocaleDateString('en-GB')}` : `Session ${s.sessionId}` };
    case 'status':
      if (s.text === 'asking the model') rows.push({ kind: 'model', t0: t });
      else if (s.text !== 'thinking') rows.push({ kind: 'status', t, text: s.text });
      return { ...tick, rows };
    case 'model': {
      const i = lastOpen(rows, (r): r is Extract<AgentRow, { kind: 'model' }> => r.kind === 'model' && r.t1 === undefined);
      const text = `request ${s.request}: ${s.cacheRead.toLocaleString()} from cache, ${s.output.toLocaleString()} written, $${s.usd.toFixed(3)}`;
      const row = rows[i];
      if (row?.kind === 'model') rows[i] = { ...row, t1: t, text };
      else rows.push({ kind: 'model', t0: t, t1: t, text });
      return { ...tick, rows, requests: s.request, usd: tick.usd + s.usd };
    }
    case 'call':
      rows.push({ kind: 'tool', id: s.id, name: s.name, input: s.input, title: toolWords[s.name] ?? s.name, args: argText(s.name, s.input, labels), t0: t });
      return { ...tick, rows };
    case 'verdict': {
      const i = lastOpen(rows, (r): r is Extract<AgentRow, { kind: 'tool' }> => r.kind === 'tool');
      const row = rows[i];
      if (row?.kind === 'tool') rows[i] = { ...row, guard: s.allow };
      return { ...tick, rows };
    }
    case 'result': {
      const i = rows.findIndex((r) => r.kind === 'tool' && r.id === s.id);
      const row = rows[i];
      if (row?.kind !== 'tool') return tick;
      const out = outcomeOf(row.name, s.text, s.isError);
      rows[i] = { ...row, t1: t, pill: out.pill, ...(out.bad ? { bad: true } : {}), ...(out.written ? { written: true } : {}) };
      return { ...tick, rows };
    }
    case 'note':
      rows.push({ kind: 'note', t, text: s.text });
      return { ...tick, rows };
  }
}

export function finish(tick: Tick, end: TickEnd, now: number, labels: Labels): Tick {
  const t = now - tick.startedAt;
  let rows = tick.rows.map((r): AgentRow => (r.kind === 'model' && r.t1 === undefined ? { ...r, t1: t } : r.kind === 'tool' && r.t1 === undefined ? { ...r, t1: t } : r));
  if (end.run && end.mode === 'stand-in') {
    rows = [
      { kind: 'status', t: 0, text: 'Rule-based stand-in: no model, no session. What it did:' },
      ...end.mainWrites.map((w): AgentRow => ({ kind: 'write', title: writeText(w, labels), detail: `${w.source}${w.saidBy ? `, ${w.saidBy}` : ''}`, pill: { cls: 'ok', text: 'written' } })),
      ...end.run.refused.map((w): AgentRow => ({ kind: 'write', title: writeText(w, labels), detail: w.source, pill: { cls: 'no', text: `The service refused: ${String(w.outcome).replace(/_/g, ' ')}` }, bad: true })),
      ...end.run.proposals.map((p): AgentRow => ({ kind: 'write', title: `${p.person} to Isla`, detail: p.why, pill: { cls: '', text: 'not written' }, propose: true })),
    ];
  }
  return { ...tick, rows, end, endedAt: now };
}

/** The strip across the top of the panel: model time, the repo answering tool calls, and refusals. */
export interface Segment {
  kind: 'model' | 'tool' | 'refused';
  t0: number;
  t1: number;
}

export function segments(tick: Tick, now: number): Segment[] {
  const end = (tick.endedAt ?? now) - tick.startedAt;
  return tick.rows.flatMap((r): Segment[] =>
    r.kind === 'model' ? [{ kind: 'model', t0: r.t0, t1: r.t1 ?? end }] : r.kind === 'tool' ? [{ kind: r.bad ? 'refused' : 'tool', t0: r.t0, t1: r.t1 ?? end }] : [],
  );
}
