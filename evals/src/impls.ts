/**
 * The three builds, each as a case agent: given a prepared store file, run the case's tick live and return the run.
 * Each starts the Phase 1a MCP server as a stdio subprocess over that file, with the case's clock.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CallGuard, SchemaValidator, loadCatalogue, prepareTick, readView, rotaTools, spawnRotaServer, type AgentTick } from '@ghillie/agent-kit';
import { credentialVariable, livePort, runMessagesTick } from '@ghillie/agent-messages';
import { harnessState, runSdkTick } from '@ghillie/agent-sdk';
import { guardConfirmer, liveManagedPort, readIds, runManagedTick } from '@ghillie/agent-managed';
import type { Ledger } from '@ghillie/ledger';
import type { EvalCase } from './cases.js';
import type { PreparedCase } from './harness.js';

export type Impl = 'messages' | 'sdk' | 'managed';
export const impls: Impl[] = ['messages', 'sdk', 'managed'];

export interface ImplOptions {
  model: string;
  ledger: Ledger;
  /** Managed Agents: the ids file the setup step wrote. */
  managedIds?: string;
  quiet?: boolean;
}

export function caseAgent(impl: Impl, o: ImplOptions): (c: EvalCase, prepared: PreparedCase) => Promise<AgentTick> {
  const print = o.quiet ? (): void => undefined : (line: string): void => void process.stdout.write(`    ${line}\n`);
  return async (c, prepared) => {
    const { client, close } = await spawnRotaServer({ dbPath: prepared.dbPath, clock: c.now });
    try {
      const tick = prepareTick(await readView(client), { items: prepared.items, sources: prepared.sources, windows: {} }, c.now);
      if (impl === 'messages') {
        return await runMessagesTick({ port: livePort(), client, tick, model: o.model, meter: o.ledger, label: c.id, print });
      }
      if (impl === 'sdk') {
        const name = credentialVariable();
        const value = process.env[name] ?? '';
        return await runSdkTick({
          query,
          tick,
          tickId: c.id,
          model: o.model,
          meter: o.ledger,
          state: harnessState(mkdtempSync(join(tmpdir(), `ghillie-sdk-${c.id}-`))),
          dbPath: prepared.dbPath,
          clock: c.now,
          store: () => prepared.store,
          client,
          credential: { name, value },
          print,
        });
      }
      const ids = readIds(o.managedIds ?? 'packages/agent-managed/resources/ids.json');
      if (!ids.agent || !ids.environment) throw new Error('Managed Agents has no agent or environment id: run npm run managed -- setup first');
      const validator = new SchemaValidator((await loadCatalogue(client)).filter((t) => (rotaTools as readonly string[]).includes(t.name)));
      return await runManagedTick({
        port: liveManagedPort(),
        agent: ids.agent,
        environmentId: ids.environment.id,
        model: o.model,
        tick,
        client,
        gateGuard: new CallGuard({ validator, allowed: rotaTools }),
        confirmer: guardConfirmer(new CallGuard({ validator, allowed: rotaTools, store: () => prepared.store })),
        meter: o.ledger,
        label: c.id,
        exportPath: join('recordings', 'managed', 'eval', `${c.id}.jsonl`),
        print,
      });
    } finally {
      await close();
    }
  };
}
