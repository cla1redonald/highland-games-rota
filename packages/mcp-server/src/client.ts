/**
 * A small client helper: connects an MCP client to a rota server, in memory or over any transport, and calls tools
 * returning their structured result. The stand-in and the demo use it; Phase 1b agents will use their own clients.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RotaService } from '@ghillie/engine';
import { createRotaServer } from './server.js';

export interface RotaClient {
  client: Client;
  close: () => Promise<void>;
}

export async function connectInMemory(service: RotaService): Promise<RotaClient> {
  const server = createRotaServer({ service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ghillie-stand-in', version: '0.1.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Calls a tool and returns its structured result. A tool error becomes a thrown error: fail closed. */
export async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const content = Array.isArray(result.content) ? result.content : [];
    const first = content[0] as { text?: string } | undefined;
    throw new Error(`${name} failed: ${first?.text ?? 'unknown error'}`);
  }
  return result.structuredContent as T;
}
