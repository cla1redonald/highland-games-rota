/**
 * Cassettes: the live responses of one run, saved so the demo can replay them for free.
 *
 * Recording wraps the live port and keeps every reply, with a digest of the request that produced it. Replaying
 * returns the replies in order and checks each request against the digest it was recorded with: the MCP server is
 * deterministic, so a replay that asks for something different is counted and reported, never hidden.
 *
 * Thinking signatures and redacted thinking are blanked before saving: they are only meaningful to the API, a replay
 * never sends them anywhere, and they are long opaque strings that do not belong in the repo.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MessagesPort, Params, Reply } from './loop.js';

export interface Cassette {
  version: 1;
  label: string;
  model: string;
  recordedAt: string;
  turns: { request: string; reply: Reply }[];
}

/** Strips what differs between a live request and its replay but carries no meaning: signatures and cache markers. */
function normalised(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalised);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'signature' || key === 'cache_control' || key === 'data') continue;
    out[key] = normalised(inner);
  }
  return out;
}

export function requestDigest(params: Params): string {
  return createHash('sha256').update(JSON.stringify(normalised(params.messages))).digest('hex').slice(0, 16);
}

export function sanitiseReply(reply: Reply): Reply {
  const content = reply.content.map((block) => {
    if (block.type === 'thinking') return { ...block, signature: '' };
    if (block.type === 'redacted_thinking') return { ...block, data: '' };
    return block;
  });
  return { ...reply, content };
}

export class RecordingPort implements MessagesPort {
  readonly cassette: Cassette;

  constructor(
    private readonly inner: MessagesPort,
    meta: { label: string; model: string; recordedAt: string },
  ) {
    this.cassette = { version: 1, ...meta, turns: [] };
  }

  async create(params: Params): Promise<Reply> {
    const reply = await this.inner.create(params);
    this.cassette.turns.push({ request: requestDigest(params), reply: sanitiseReply(reply) });
    return reply;
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(this.cassette, null, 1)}\n`);
  }
}

export class ReplayPort implements MessagesPort {
  private next = 0;
  /** Requests that did not match what was recorded. Zero for a faithful replay. */
  mismatches = 0;

  constructor(readonly cassette: Cassette) {}

  static load(path: string): ReplayPort {
    return new ReplayPort(JSON.parse(readFileSync(path, 'utf8')) as Cassette);
  }

  create(params: Params): Promise<Reply> {
    const turn = this.cassette.turns[this.next++];
    if (!turn) return Promise.reject(new Error(`cassette ${this.cassette.label} has no reply ${this.next}: the replay asked for more than was recorded`));
    if (turn.request !== requestDigest(params)) this.mismatches++;
    return Promise.resolve(turn.reply);
  }

  get remaining(): number {
    return this.cassette.turns.length - this.next;
  }
}
