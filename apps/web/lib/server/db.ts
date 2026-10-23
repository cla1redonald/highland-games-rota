/**
 * The hosted demo's own state, in Turso: each visitor's run, every dollar the live ticks spent, and the recordings
 * live ticks made. A run's rota is not spread over tables here. It is the engine's own SQLite file, kept whole as a
 * snapshot, so the engine runs exactly as it does on a laptop.
 *
 * Locally, with no Turso URL set, the same client writes to a file under data/.
 */
import { createClient, type Client } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths';

const schema = [
  `create table if not exists runs (
    id text primary key,
    created_at text not null,
    updated_at text not null,
    saved text not null,
    view text not null,
    snapshot blob not null,
    busy_until integer not null default 0
  )`,
  `create table if not exists spend (
    seq integer primary key autoincrement,
    at text not null,
    run_id text not null,
    tick_at text not null,
    model text not null,
    usd real not null,
    basis text not null,
    entry text not null
  )`,
  `create table if not exists recordings (
    at text primary key,
    recorded_at text not null,
    run_id text not null,
    body text not null
  )`,
];

let ready: Promise<Client> | null = null;

function connect(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) return createClient({ url, ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}) });
  if (process.env.VERCEL) throw new Error('TURSO_DATABASE_URL is not set');
  mkdirSync(join(repoRoot, 'data'), { recursive: true });
  return createClient({ url: `file:${join(repoRoot, 'data', 'web.db')}` });
}

/** A text column's value. Anything else is a schema mistake, so it throws rather than guess. */
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected text from the database, got ${typeof value}`);
  return value;
}

/** The database, with its tables made on first use. */
export function db(): Promise<Client> {
  ready ??= (async () => {
    const client = connect();
    await client.batch(schema, 'write');
    return client;
  })().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}
