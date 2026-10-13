/**
 * Connections to the Phase 1a MCP server: as a stdio subprocess (the same entry point Phase 1a ships, configured by
 * GHILLIE_DB and GHILLIE_CLOCK), or in memory for tests. Every call goes through `ObservedMcp`, which times it and
 * hands the outcome to whoever is recording the run.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { performance } from 'node:perf_hooks';
import type { CallOutcome } from './recorder.js';

export interface McpConnection {
  client: Client;
  close: () => Promise<void>;
}

/** How to start the server: the built entry point if there is one, otherwise the TypeScript source through tsx. */
export function serverCommand(): { command: string; args: string[] } {
  const built = fileURLToPath(new URL('../../mcp-server/dist/main.js', import.meta.url));
  const source = fileURLToPath(new URL('../../mcp-server/src/main.ts', import.meta.url));
  const fromSource = import.meta.url.endsWith('.ts') || !existsSync(built);
  return fromSource
    ? { command: process.execPath, args: ['--conditions=ghillie-source', '--import', 'tsx', source] }
    : { command: process.execPath, args: [built] };
}

/** The environment the server process gets: a path to find node, and a temporary directory. Nothing else. */
export function serverEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
}

/** Starts the MCP server as a subprocess over a store file, with a fixed clock. */
export async function spawnRotaServer(options: { dbPath: string; clock: string }): Promise<McpConnection> {
  const { command, args } = serverCommand();
  const transport = new StdioClientTransport({
    command,
    args,
    // Only what the server needs: no API key or anything else from this process reaches it.
    env: { ...serverEnv(), GHILLIE_DB: options.dbPath, GHILLIE_CLOCK: options.clock },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ghillie-harness', version: '0.1.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export interface ObservedCall extends CallOutcome {
  durationMs: number;
}

/** Calls a tool and returns its outcome without throwing: an MCP error is an outcome, marked as one. */
export async function callObserved(client: Client, name: string, args: Record<string, unknown>): Promise<ObservedCall> {
  const started = performance.now();
  try {
    const raw = await client.callTool({ name, arguments: args });
    const content = Array.isArray(raw.content) ? (raw.content as { type: string; text?: string }[]) : [];
    const text = content.map((c) => c.text ?? '').join('\n');
    const structured = (raw.structuredContent as Record<string, unknown> | undefined) ?? null;
    return { isError: raw.isError === true, result: raw.isError ? null : structured, text, durationMs: performance.now() - started };
  } catch (error) {
    return { isError: true, result: null, text: `error: ${error instanceof Error ? error.message : String(error)}`, durationMs: performance.now() - started };
  }
}
