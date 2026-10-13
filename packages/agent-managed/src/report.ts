/**
 * The morning-after report: what each scheduled run since a given time did, from the platform's own records. One line
 * per run: when it was due, whether a session started, how it ended, what it cost, whether it messaged the organiser
 * and whether it logged the run. A run that is still waiting on the repo is called out, since nobody else will.
 */
import { str, type ManagedEvent, type ManagedPort } from './port.js';

export interface RunLine {
  scheduledAt: string;
  sessionId: string | null;
  error: string | null;
  status: string;
  costUsd: number | null;
  messaged: boolean;
  logged: boolean;
  waiting: boolean;
}

const calledTool = (events: ManagedEvent[], name: string): boolean =>
  events.some((e) => (e.type === 'agent.custom_tool_use' || e.type === 'agent.mcp_tool_use') && e.name === name);

export async function morningAfter(port: ManagedPort, deploymentId: string, since: string): Promise<RunLine[]> {
  const runs = await port.listDeploymentRuns(deploymentId);
  const lines: RunLine[] = [];
  for (const run of runs) {
    const scheduledAt = str((run.trigger_context as { scheduled_at?: unknown } | undefined)?.scheduled_at) || str(run.created_at);
    if (scheduledAt < since) continue;
    const sessionId = typeof run.session_id === 'string' ? run.session_id : null;
    const error = run.error ? str((run.error as { type?: unknown }).type) || 'error' : null;
    if (!sessionId) {
      lines.push({ scheduledAt, sessionId, error, status: 'no session', costUsd: null, messaged: false, logged: false, waiting: false });
      continue;
    }
    const session = await port.retrieveSession(sessionId);
    const events = await port.listEvents(sessionId);
    const lastIdle = [...events].reverse().find((e) => e.type === 'session.status_idle');
    const stop = (lastIdle?.stop_reason as { type?: string } | undefined)?.type ?? '';
    const cents = Number(session.usage?.list_cost?.amount ?? NaN);
    lines.push({
      scheduledAt,
      sessionId,
      error,
      status: stop ? `${session.status} (${stop})` : session.status,
      costUsd: Number.isFinite(cents) ? cents / 100 : null,
      messaged: calledTool(events, 'message_organiser'),
      logged: calledTool(events, 'log_run'),
      waiting: stop === 'requires_action',
    });
  }
  return lines.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

export function renderMorningAfter(lines: RunLine[]): string {
  if (!lines.length) return 'No scheduled runs since then.';
  const out = lines.map((l) => {
    const cost = l.costUsd === null ? 'cost unknown' : `$${l.costUsd.toFixed(2)}`;
    const what = l.sessionId ? `${l.status}, ${cost}, ${l.messaged ? 'messaged Isla' : 'no message'}, ${l.logged ? 'logged' : 'NOT LOGGED'}` : `did not start: ${l.error ?? 'unknown'}`;
    return `${l.scheduledAt}  ${what}${l.waiting ? '  WAITING ON THE WORKER' : ''}`;
  });
  const total = lines.reduce((s, l) => s + (l.costUsd ?? 0), 0);
  const unlogged = lines.filter((l) => !l.logged).length;
  return [...out, `${lines.length} runs, $${total.toFixed(2)} in all, ${unlogged} not logged.`].join('\n');
}
