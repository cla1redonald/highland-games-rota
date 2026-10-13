/**
 * The harness's own read of the rota before a tick, through the same MCP server, so it can prepare the brief. It is
 * not one of the model's tool calls and is not counted as one.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RotaView } from '@ghillie/engine';
import { callObserved } from './mcp.js';

export async function readView(client: Client): Promise<RotaView> {
  const outcome = await callObserved(client, 'read_rota', {});
  const view = outcome.result?.view;
  if (outcome.isError || !view) throw new Error(`could not read the rota: ${outcome.text}`);
  return view as RotaView;
}
