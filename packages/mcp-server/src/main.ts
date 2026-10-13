#!/usr/bin/env node
/**
 * Entry point. Stdio by default. Configured by environment:
 *   GHILLIE_DB          path to the SQLite store (required; the change log is written beside it)
 *   GHILLIE_CLOCK       a fixed ISO time to use as "now", for replays and tests (optional)
 *   GHILLIE_HTTP_PORT   serve Streamable HTTP on this loopback port instead of stdio (optional)
 *   GHILLIE_HTTP_BEARER the bearer token every HTTP request must carry (required with GHILLIE_HTTP_PORT)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RotaService, Store } from '@ghillie/engine';
import { startHttpServer } from './http.js';
import { createRotaServer } from './server.js';

async function main(): Promise<void> {
  const path = process.env.GHILLIE_DB;
  if (!path) {
    process.stderr.write('GHILLIE_DB is not set: refusing to start without a store\n');
    process.exit(2);
  }
  const fixed = process.env.GHILLIE_CLOCK;
  if (fixed && Number.isNaN(Date.parse(fixed))) {
    process.stderr.write('GHILLIE_CLOCK is not a time\n');
    process.exit(2);
  }
  const store = new Store({ path, changeLogPath: `${path}.changes.ndjson` });
  const service = new RotaService({ store, clock: () => (fixed ? new Date(fixed) : new Date()) });
  const httpPort = process.env.GHILLIE_HTTP_PORT;
  if (httpPort) {
    const running = await startHttpServer({ service, port: Number(httpPort), token: process.env.GHILLIE_HTTP_BEARER ?? '' });
    process.stderr.write(`ghillie mcp server on ${running.url}\n`);
    return;
  }
  const server = createRotaServer({ service });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`ghillie mcp server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
