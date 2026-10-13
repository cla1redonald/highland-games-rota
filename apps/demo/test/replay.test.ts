/**
 * The recorded demo, offline: two ticks are "recorded" from a scripted stub (standing in for the live API), then
 * replayed against a fresh world through the real stdio MCP server. The replay must ask for exactly what was
 * recorded and leave the rota in the same state.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '@ghillie/ledger';
import type { MessagesPort, Params, Reply } from '@ghillie/agent-messages';
import { createDemoWorld, fortnightTicks, playTicks } from '@ghillie/demo';
import { messagesDemo, readManifest } from '../src/messages.js';

function scripted(): MessagesPort {
  let n = 0;
  return {
    create: (params: Params): Promise<Reply> => {
      n++;
      const first = params.messages[0]!.content as { text: string }[];
      const facts = JSON.parse(first[0]!.text.split('\n\n')[0]!.split('\n').slice(1).join('\n')) as { logRun: Record<string, unknown> };
      const content =
        n === 1
          ? [{ type: 'tool_use', id: 'toolu_a', name: 'read_rota', input: {} }]
          : n === 2
            ? [{ type: 'tool_use', id: 'toolu_b', name: 'log_run', input: { ...facts.logRun, exceptions: 0, toolCalls: 2 } }]
            : [{ type: 'text', text: 'Done.' }];
      return Promise.resolve({
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content,
        stop_reason: n < 3 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
      } as unknown as Reply);
    },
  };
}

describe('the recorded demo', () => {
  it('replays a recorded run exactly, spending nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghillie-recording-'));
    const ticks = fortnightTicks().slice(0, 2);
    const ledger = new Ledger({ path: join(dir, 'spend.jsonl'), print: () => undefined, stop: (m) => { throw new Error(m); } });

    const recordWorld = await createDemoWorld(join(dir, 'record.db'));
    const recording = messagesDemo({ mode: 'live', model: 'claude-sonnet-5-5', meter: ledger, dir, livePortFor: scripted });
    const recorded = await playTicks(recordWorld, ticks, { agent: recording.agent, watchdog: false });
    recording.finish();
    await recordWorld.close();
    expect(readManifest(dir)?.ticks).toHaveLength(2);
    expect(ledger.total).toBeGreaterThan(0);

    const replayWorld = await createDemoWorld(join(dir, 'replay.db'));
    const replaying = messagesDemo({ mode: 'replay', model: 'claude-sonnet-5-5', dir });
    const replayed = await playTicks(replayWorld, ticks, { agent: replaying.agent, watchdog: false });
    expect(replaying.mismatches()).toBe(0);
    expect(replayed.map((r) => r.run?.summary?.toolCalls)).toEqual(recorded.map((r) => r.run?.summary?.toolCalls));
    expect(replayed.map((r) => r.run?.toolCalls)).toEqual([2, 2]);
    // The seed run and the two replayed ticks.
    expect(replayWorld.store.runs()).toHaveLength(3);
    // The replay's own spend is nothing: it never touched the ledger.
    expect(ledger.total).toBeCloseTo(readManifest(dir)!.totalUsd, 9);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    await replayWorld.close();
  }, 60_000);
});
