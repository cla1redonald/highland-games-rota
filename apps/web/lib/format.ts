/** Words and formats the page uses, ported from the local room demo so both read the same. */
import type { Write } from './messages';

const tz = 'Europe/London';

export const fmtTick = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(' at ', ', ');
export const fmtShort = (iso: string): string => new Date(iso).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDay = (d: string): string => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
export const chipDay = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric' });
export const chipHour = (iso: string): string => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
export const money = (n: number | undefined): string => `$${(n ?? 0).toFixed(n && n < 1 ? 3 : 2)}`;
export const clockOf = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const secs = (ms: number): string => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

export const toolWords: Record<string, string> = {
  read_rota: 'Reads the rota',
  set_availability: 'Records an answer',
  set_decision: 'Writes a booking',
  update_event: 'Changes a games',
  update_person: 'Updates a person',
  propose_recruit: 'Proposes a recruit to Isla',
  message_organiser: 'Messages Isla',
  log_run: 'Logs the run',
  gather_evidence: 'Asks for the evidence',
};

export const sourceWords: Record<string, string> = { chat: 'chat', mail: 'mail', minutes: 'call notes', calendar: 'circuit calendar' };

export type Labels = Record<string, string>;

export const withLabels = (text: string, labels: Labels): string => text.replace(/\b([a-z]+(?:-[a-z]+)*)\b/g, (w) => labels[w] ?? w);

export function writeText(w: Write, labels: Labels): string {
  const fields = w.fields ?? {};
  if (w.action === 'update_event') return `${labels[w.event ?? ''] ?? w.event}: ${Object.entries(fields).map(([k, v]) => `${k} ${String(v)}`).join(', ')}`;
  if (w.action === 'update_person') return `${w.person}: ${Object.keys(fields).join(', ')}`;
  return `${w.person} ${w.value} at ${labels[w.event ?? ''] ?? w.event}`;
}

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

export function argText(name: string, input: Input, labels: Labels): string {
  if (name === 'message_organiser' || name === 'log_run' || name === 'read_rota') return '';
  const parts: string[] = [];
  if (input.person) parts.push(str(input.person));
  if (input.value) parts.push(str(input.value));
  if (typeof input.event === 'string') parts.push(`at ${labels[input.event] ?? input.event}`);
  if (input.name) parts.push(str(input.name));
  const fields = input.fields as Input | undefined;
  if (fields && typeof fields === 'object') {
    const words: Record<string, string> = { statement: 'notes what they said', nextStep: 'sets the next step', lastChecked: 'marks last checked', status: 'status', create: 'adds them', date: 'date', target: 'target', confirmed: 'confirmed', type: 'type' };
    parts.push(
      Object.entries(fields)
        .map(([k, v]) => (name === 'update_event' || k === 'status' ? `${words[k] ?? k} ${str(v)}` : (words[k] ?? k)))
        .join(', '),
    );
    const statement = fields.statement as Input | undefined;
    const dw = statement?.dateWords;
    if (Array.isArray(dw) && dw.length) parts.push(`date words: ${dw.map((w) => `"${str(w)}"`).join(', ')}`);
  }
  if (Array.isArray(input.dateWords) && input.dateWords.length) parts.push(`date words: ${input.dateWords.map((w) => `"${str(w)}"`).join(', ')}`);
  if (input.source) parts.push(`[${str(input.source)}]`);
  return parts.join(' · ');
}

export interface Pill {
  cls: '' | 'ok' | 'no' | 'wait';
  text: string;
}

export function outcomeOf(name: string, text: string, isError: boolean): { pill: Pill; bad?: boolean; written?: boolean } {
  if (isError) {
    const m = /not confirmed: [a-z_]+: ([a-z_]+)/.exec(text);
    return { bad: true, pill: { cls: 'no', text: m?.[1] ? `Stopped before it ran: ${m[1].replace(/_/g, ' ')}` : `Error: ${text.slice(0, 120)}` } };
  }
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { pill: { cls: 'ok', text: 'done' } };
  }
  if (r.ok === false) return { bad: true, pill: { cls: 'no', text: `The service refused: ${str(r.refusal ?? 'refused').replace(/_/g, ' ')}` } };
  if (name === 'read_rota') return { pill: { cls: '', text: 'read' } };
  if (name === 'message_organiser') return { pill: { cls: 'ok', text: 'sent to Isla' } };
  if (name === 'log_run') return { pill: { cls: 'ok', text: 'logged' } };
  if (r.changed === true || r.added === true || (Array.isArray(r.changed) && r.changed.length)) return { written: true, pill: { cls: 'ok', text: 'written' } };
  if (r.changed === false || (Array.isArray(r.changed) && !r.changed.length)) return { pill: { cls: '', text: r.noteUpdated ? 'note added' : 'no change: already so' } };
  return { pill: { cls: 'ok', text: 'done' } };
}

export const valueClass: Record<string, string> = { Stewarding: 'v-stew', Supporting: 'v-sup', Watching: 'v-sup', 'Not going': 'v-no', Yes: 'v-yes', Maybe: 'v-maybe', No: 'v-no', Unknown: 'v-unk', '': 'v-unk' };
export const valueText = (v: string): string => (v === 'Stewarding' ? 'Steward' : v === 'Supporting' ? 'Support' : v === 'Unknown' || !v ? '·' : v);
export const cellKey = (person: string, event: string): string => `${person}|${event}`;
