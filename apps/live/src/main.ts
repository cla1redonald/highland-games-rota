#!/usr/bin/env node
/**
 * npm run live                  the room demo: a page at http://127.0.0.1:4317 that runs the fortnight tick by tick,
 *                               each tick live on Managed Agents, replayed from a recording, or by the free stand-in
 * npm run live -- --port 8080   another port
 *
 * Live ticks need the API key named in .env.example, read from the environment or from .env, and go through the
 * ledger like every other call. Without a key the page still runs replays and the stand-in, for nothing.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { hasCredentials } from '@ghillie/agent-messages';
import { config } from '@ghillie/engine';
import { Ledger } from '@ghillie/ledger';
import { createLiveServer } from './server.js';
import { Show } from './show.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const port = Number(arg('--port') ?? 4317);
  const model = config.models.managedAgents;
  const ledger = hasCredentials() ? new Ledger() : undefined;
  mkdirSync('data', { recursive: true });
  const show = await Show.open({ ...(ledger ? { meter: ledger } : {}), model });
  const server = createLiveServer({ show, model, ...(ledger ? { ledger } : {}) });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Ghillie room demo: http://127.0.0.1:${port}\n`);
    process.stdout.write(ledger ? `Live ticks on ${model} are on. ${ledger.summary()}\n` : 'No API key found: live ticks are off. Replays and the stand-in still run, for nothing.\n');
  });
  const stop = (): void => {
    server.close();
    void show.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`live: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
