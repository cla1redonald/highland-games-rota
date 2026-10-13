/**
 * The Messages API build in the demo: each tick starts the Phase 1a MCP server over the demo's store file with the
 * tick's clock, gathers the evidence through the feed adapters, and runs the loop.
 *
 *   live    calls the API under the ledger, and records every reply to recordings/messages-fortnight/
 *   replay  plays those replies back: no API call, no spend; the tools still run against the real server
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatherTick, prepareTick, readView, spawnRotaServer, type AgentTick } from '@ghillie/agent-kit';
import { RecordingPort, ReplayPort, livePort, replayMeter, runMessagesTick, type Meter, type MessagesPort } from '@ghillie/agent-messages';
import type { TickAgent } from './play.js';

export const recordingDir = 'recordings/messages-fortnight';

export interface Manifest {
  model: string;
  recordedAt: string;
  ticks: { at: string; file: string; usd: number; turns: number; outcome: string }[];
  totalUsd: number;
}

export function readManifest(dir = recordingDir): Manifest | null {
  const path = join(dir, 'manifest.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest) : null;
}

const fileFor = (at: string): string => `${at.slice(0, 16).replace(/[:T]/g, '-')}.json`;

export interface MessagesDemo {
  agent: TickAgent;
  ticks: AgentTick[];
  /** Replay only: requests that did not match the recording. */
  mismatches: () => number;
  finish: () => void;
}

export interface MessagesDemoOptions {
  mode: 'live' | 'replay';
  model: string;
  meter?: Meter;
  print?: (line: string) => void;
  /** Where the recordings live. */
  dir?: string;
  /** The live API port, for each tick. Tests pass a stub. */
  livePortFor?: (now: string) => MessagesPort;
}

export function messagesDemo(options: MessagesDemoOptions): MessagesDemo {
  const dir = options.dir ?? recordingDir;
  const ticks: AgentTick[] = [];
  const manifest: Manifest = readManifest(dir) ?? { model: options.model, recordedAt: new Date().toISOString(), ticks: [], totalUsd: 0 };
  if (options.mode === 'live') {
    manifest.ticks = [];
    manifest.recordedAt = new Date().toISOString();
    manifest.model = options.model;
  }
  const meter = options.mode === 'live' ? options.meter : replayMeter();
  if (!meter) throw new Error('a live demo needs the ledger');
  let mismatches = 0;

  const agent: TickAgent = async ({ world, now, window, timeoutMs }) => {
    const { client, close } = await spawnRotaServer({ dbPath: world.dbPath, clock: now });
    try {
      const view = await readView(client);
      const gathered = await gatherTick(world.feed, view, now, { timeoutMs, ...(window ? { window } : {}) });
      const tick = prepareTick(view, gathered, now, window ? { window } : {});
      let port: MessagesPort;
      let recorder: RecordingPort | null = null;
      let replay: ReplayPort | null = null;
      if (options.mode === 'live') {
        recorder = new RecordingPort(options.livePortFor?.(now) ?? livePort(), { label: now, model: options.model, recordedAt: new Date().toISOString() });
        port = recorder;
      } else {
        replay = ReplayPort.load(join(dir, fileFor(now)));
        port = replay;
      }
      const result = await runMessagesTick({ port, client, tick, model: options.model, meter, label: `demo ${now}`, ...(options.print ? { print: options.print } : {}) });
      ticks.push(result);
      if (recorder) {
        recorder.save(join(dir, fileFor(now)));
        manifest.ticks.push({ at: now, file: fileFor(now), usd: result.usd, turns: result.turns.length, outcome: result.outcome });
      }
      if (replay) mismatches += replay.mismatches;
      return result.run;
    } finally {
      await close();
    }
  };

  return {
    agent,
    ticks,
    mismatches: () => mismatches,
    finish: () => {
      if (options.mode !== 'live') return;
      manifest.totalUsd = manifest.ticks.reduce((s, t) => s + t.usd, 0);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}
