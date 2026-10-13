/**
 * The real API client behind the loop's port. The SDK reads its credentials from the environment; nothing here
 * names or handles a key.
 */
import { readFileSync } from 'node:fs';
import ApiClient from '@anthropic-ai/sdk';
import { priceTokens, tokenCounts, type ApiUsage, type SpendMeta } from '@ghillie/ledger';
import type { Meter, MessagesPort, Params, Reply } from './loop.js';

export function livePort(client: ApiClient = new ApiClient()): MessagesPort {
  return { create: (params: Params): Promise<Reply> => client.beta.messages.create(params) };
}

/** Prices what a replay would have cost, without adding it to the ledger: replaying a cassette spends nothing. */
export function replayMeter(): Meter & { total: number } {
  const meter = {
    total: 0,
    assertUnderCap: (): void => undefined,
    record: (model: string, usage: ApiUsage, _meta: SpendMeta): { usd: number }[] => {
      const usd = priceTokens(model, tokenCounts(usage));
      meter.total += usd;
      return [{ usd }];
    },
  };
  return meter;
}

/** The one API-key variable, as .env.example names it. Read from the file so it is written down in one place. */
export function credentialVariable(envExample = new URL('../../../.env.example', import.meta.url)): string {
  const line = readFileSync(envExample, 'utf8')
    .split('\n')
    .find((l) => /^[A-Z_]+_API_KEY=$/.test(l.trim()));
  if (!line) throw new Error('.env.example names no API-key variable');
  return line.trim().slice(0, -1);
}

/** Whether live calls are possible: the variable named in .env.example is set and not empty. */
export function hasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[credentialVariable()]?.trim());
}
