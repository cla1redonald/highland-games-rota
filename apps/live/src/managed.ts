/**
 * One tick of the room demo on Managed Agents, live or replayed, with every step reported as it happens.
 *
 *   live    a real session on the agent and environment in packages/agent-managed/resources/ids.json, under the
 *           ledger. The stream is recorded to recordings/managed-live/, with the time each event arrived.
 *   replay  plays a recording back at its recorded pace (or faster). No API is called and nothing is spent; the tool
 *           calls still run against the real MCP server, and every write still goes through the guard.
 *
 * The session code is the build's own (driveSession). This file only wraps the port, to watch what crosses it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CallGuard, SchemaValidator, loadCatalogue, rotaTools, spawnRotaServer, type AgentTick, type TickInput } from '@ghillie/agent-kit';
import { guardConfirmer, liveManagedPort, readIds, runManagedTick, type Confirmer, type ManagedEvent, type ManagedMeter, type ManagedPort, type ManagedSession } from '@ghillie/agent-managed';
import { priceTokens, tokenCounts, type ApiUsage } from '@ghillie/ledger';
import type { Store } from '@ghillie/engine';

export const liveRecordingDir = 'recordings/managed-live';
export const idsPath = 'packages/agent-managed/resources/ids.json';

export interface Recording {
  at: string;
  recordedAt: string;
  model: string;
  sessionId: string;
  /** Each event the stream delivered, with the milliseconds since the session was created. */
  events: { ms: number; event: ManagedEvent }[];
  final: ManagedSession;
  usd: number;
}

export const recordingFile = (at: string): string => `${at.slice(0, 16).replace(/[:T]/g, '-')}.json`;

export function readRecording(at: string, dir = liveRecordingDir): Recording | null {
  const path = join(dir, recordingFile(at));
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Recording) : null;
}

/** What the page is told, step by step. */
export type Step =
  | { kind: 'session'; sessionId: string; replayOf?: string }
  | { kind: 'model'; request: number; input: number; output: number; cacheRead: number; usd: number }
  | { kind: 'call'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'verdict'; name: string; allow: boolean; reason?: string }
  | { kind: 'result'; id: string; text: string; isError: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'status'; text: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every method of a port, bound, so a wrapper can replace some and pass the rest through (a class instance cannot be spread). */
function delegate(inner: ManagedPort): ManagedPort {
  return {
    createAgent: (body) => inner.createAgent(body),
    createEnvironment: (body) => inner.createEnvironment(body),
    createDeployment: (body) => inner.createDeployment(body),
    pauseDeployment: (id) => inner.pauseDeployment(id),
    createSession: (body) => inner.createSession(body),
    retrieveSession: (id) => inner.retrieveSession(id),
    listSessions: () => inner.listSessions(),
    stream: (id) => inner.stream(id),
    send: (id, events) => inner.send(id, events),
    listEvents: (id) => inner.listEvents(id),
    listDeploymentRuns: (id) => inner.listDeploymentRuns(id),
  };
}

/** Watches a port: everything the stream delivers and everything the repo sends back. Optionally records the stream. */
export function observedPort(inner: ManagedPort, onStep: (step: Step) => void, model: string, record?: { events: { ms: number; event: ManagedEvent }[]; started: () => number }): ManagedPort {
  let requests = 0;
  const seen = (event: ManagedEvent): void => {
    if (event.type === 'agent.custom_tool_use') onStep({ kind: 'call', id: event.id, name: String(event.name), input: (event.input ?? {}) as Record<string, unknown> });
    else if (event.type === 'agent.message') {
      const text = (Array.isArray(event.content) ? (event.content as { text?: unknown }[]) : []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
      if (text) onStep({ kind: 'note', text });
    } else if (event.type === 'agent.thinking') onStep({ kind: 'status', text: 'thinking' });
    else if (event.type === 'span.model_request_start') onStep({ kind: 'status', text: 'asking the model' });
    else if (event.type === 'span.model_request_end') {
      const usage = event.model_usage as ApiUsage;
      requests++;
      onStep({ kind: 'model', request: requests, input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, usd: priceTokens(model, tokenCounts(usage)) });
    }
  };
  return {
    ...delegate(inner),
    createSession: async (body) => {
      const session = await inner.createSession(body);
      onStep({ kind: 'session', sessionId: session.id });
      return session;
    },
    stream: async (id) => {
      const events = await inner.stream(id);
      return (async function* () {
        for await (const event of events) {
          record?.events.push({ ms: Math.round(performance.now() - record.started()), event });
          seen(event);
          yield event;
        }
      })();
    },
    send: async (id, events) => {
      for (const e of events) {
        if (e.type === 'user.custom_tool_result') {
          const content = Array.isArray(e.content) ? (e.content as { text?: unknown }[]) : [];
          onStep({ kind: 'result', id: String(e.custom_tool_use_id), text: content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n'), isError: e.is_error === true });
        } else if (e.type === 'user.message') {
          const content = Array.isArray(e.content) ? (e.content as { text?: unknown }[]) : [];
          const text = content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
          onStep({ kind: 'status', text: text.startsWith('The tick') ? 'brief sent' : `reminder sent: ${text}` });
        }
      }
      await inner.send(id, events);
    },
  };
}

/** A port that plays a recording back. Sends are accepted and dropped: the recording already holds what came next. */
export function replayPort(recording: Recording, speed: number): ManagedPort {
  const refuse = (): never => {
    throw new Error('a replay creates nothing');
  };
  return {
    createAgent: refuse,
    createEnvironment: refuse,
    createDeployment: refuse,
    pauseDeployment: refuse,
    listSessions: () => Promise.resolve([]),
    listDeploymentRuns: () => Promise.resolve([]),
    createSession: () => Promise.resolve({ id: recording.sessionId, status: 'running' }),
    retrieveSession: () => Promise.resolve(recording.final),
    listEvents: () => Promise.resolve(recording.events.map((e) => e.event)),
    send: () => Promise.resolve(),
    stream: () => {
      const started = performance.now();
      return Promise.resolve(
        (async function* () {
          for (const { ms, event } of recording.events) {
            const wait = ms / speed - (performance.now() - started);
            if (wait > 0) await sleep(wait);
            yield event;
          }
        })(),
      );
    },
  };
}

/** Prices each request without writing to the ledger: a replay spends nothing. */
export function replayMeter(): ManagedMeter {
  return {
    assertUnderCap: () => undefined,
    record: (model, usage) => [{ usd: priceTokens(model, tokenCounts(usage)) }],
    recordListCost: (_model, usd) => ({ usd }),
  };
}

export interface ManagedTickArgs {
  mode: 'live' | 'replay';
  dbPath: string;
  store: Store;
  tick: TickInput;
  model: string;
  onStep: (step: Step) => void;
  /** Live only: the ledger. */
  meter?: ManagedMeter;
  /** Replay only: how much faster than recorded. */
  speed?: number;
  /** Tests stand a stub in for the platform. */
  port?: ManagedPort;
  dir?: string;
}

/** Wraps the confirmer so the page sees each verdict on a write before the session resumes. */
function watchedConfirmer(inner: Confirmer, onStep: (step: Step) => void): Confirmer {
  return {
    confirm: async (name, input) => {
      const verdict = await inner.confirm(name, input);
      onStep(verdict.allow ? { kind: 'verdict', name, allow: true } : { kind: 'verdict', name, allow: false, reason: verdict.reason });
      return verdict;
    },
  };
}

export async function runManagedDemoTick(a: ManagedTickArgs): Promise<AgentTick> {
  const dir = a.dir ?? liveRecordingDir;
  const ids = readIds(idsPath);
  if (!ids.agent || !ids.environment) throw new Error(`no agent or environment id in ${idsPath}: run npm run managed -- setup first`);
  const { client, close } = await spawnRotaServer({ dbPath: a.dbPath, clock: a.tick.now });
  try {
    const validator = new SchemaValidator((await loadCatalogue(client)).filter((t) => (rotaTools as readonly string[]).includes(t.name)));
    const confirmer = watchedConfirmer(guardConfirmer(new CallGuard({ validator, allowed: rotaTools, store: () => a.store })), a.onStep);
    const gateGuard = new CallGuard({ validator, allowed: rotaTools });
    if (a.mode === 'replay') {
      const recording = readRecording(a.tick.now, dir);
      if (!recording) throw new Error(`no recording for ${a.tick.now}`);
      a.onStep({ kind: 'session', sessionId: recording.sessionId, replayOf: recording.recordedAt });
      const port = observedPort(replayPort(recording, a.speed ?? 1), (step) => (step.kind === 'session' ? undefined : a.onStep(step)), recording.model);
      return await runManagedTick({ port, agent: ids.agent, environmentId: ids.environment.id, model: recording.model, tick: a.tick, client, gateGuard, confirmer, meter: replayMeter(), label: `room replay ${a.tick.now}`, print: () => undefined });
    }
    if (!a.meter) throw new Error('a live tick needs the ledger');
    let createdAt = performance.now();
    const events: { ms: number; event: ManagedEvent }[] = [];
    const inner = a.port ?? liveManagedPort();
    const timed: ManagedPort = {
      ...delegate(inner),
      createSession: async (body) => {
        createdAt = performance.now();
        return inner.createSession(body);
      },
    };
    let sessionId = '';
    const port = observedPort(timed, (step) => {
      if (step.kind === 'session') sessionId = step.sessionId;
      a.onStep(step);
    }, a.model, { events, started: () => createdAt });
    const result = await runManagedTick({ port, agent: ids.agent, environmentId: ids.environment.id, model: a.model, tick: a.tick, client, gateGuard, confirmer, meter: a.meter, label: `room live ${a.tick.now}`, print: () => undefined });
    const recording: Recording = { at: a.tick.now, recordedAt: new Date().toISOString(), model: a.model, sessionId, events, final: await inner.retrieveSession(sessionId), usd: result.usd };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, recordingFile(a.tick.now)), `${JSON.stringify(recording, null, 1)}\n`);
    return result;
  } finally {
    await close();
  }
}
