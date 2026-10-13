/**
 * The worker for scheduled runs. A deployment fires a session at 13:00 and 18:00 on weekdays with no client
 * attached; its first act is a custom tool call (gather_evidence), so it waits until the repo answers. The worker
 * finds those sessions through the deployment's runs, attaches, answers what is waiting and serves the session to
 * the end, exactly as a live tick is served.
 *
 * The cap: at most `maxRunsPerDay` runs are served per day. Anything beyond is interrupted and reported, never
 * served, so a schedule that misfires cannot run up spend.
 */
import type { AgentTick } from '@ghillie/agent-kit';
import { maxRunsPerDay } from './definitions.js';
import { str, type ManagedEvent, type ManagedPort } from './port.js';

/** Tool calls the session made that have no answer yet. */
export function unanswered(events: ManagedEvent[]): ManagedEvent[] {
  const answered = new Set(events.filter((e) => e.type === 'user.custom_tool_result').map((e) => String(e.custom_tool_use_id)));
  return events.filter((e) => e.type === 'agent.custom_tool_use' && !answered.has(e.id));
}

export interface WorkerOptions {
  port: ManagedPort;
  deploymentId: string;
  /** Sessions already served or refused, by id, so a second pass leaves them alone. */
  done: Set<string>;
  /** Serves one waiting session to the end (driveSession with this run's tick). */
  serve: (sessionId: string, events: AsyncIterable<ManagedEvent>, pending: ManagedEvent[], scheduledAt: string) => Promise<AgentTick>;
  cap?: number;
}

export interface WorkerPass {
  served: string[];
  refused: string[];
}

export async function workerPass(o: WorkerOptions): Promise<WorkerPass> {
  const cap = o.cap ?? maxRunsPerDay;
  const runs = await o.port.listDeploymentRuns(o.deploymentId);
  const perDay = new Map<string, number>();
  const result: WorkerPass = { served: [], refused: [] };
  const ordered = [...runs].sort((a, b) => str(a.created_at).localeCompare(str(b.created_at)));
  for (const run of ordered) {
    const sessionId = typeof run.session_id === 'string' ? run.session_id : null;
    if (!sessionId) continue;
    const scheduledAt = str((run.trigger_context as { scheduled_at?: unknown } | undefined)?.scheduled_at) || str(run.created_at);
    const day = scheduledAt.slice(0, 10);
    const count = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, count);
    if (o.done.has(sessionId)) continue;
    const session = await o.port.retrieveSession(sessionId);
    if (session.status !== 'idle') continue;
    if (count > cap) {
      await o.port.send(sessionId, [{ type: 'user.interrupt' }]);
      o.done.add(sessionId);
      result.refused.push(sessionId);
      continue;
    }
    const events = await o.port.stream(sessionId);
    const pending = unanswered(await o.port.listEvents(sessionId));
    if (!pending.length) continue;
    await o.serve(sessionId, events, pending, scheduledAt);
    o.done.add(sessionId);
    result.served.push(sessionId);
  }
  return result;
}
