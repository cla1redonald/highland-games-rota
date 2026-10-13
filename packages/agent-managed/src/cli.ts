#!/usr/bin/env node
/**
 * npm run managed -- export    write resources/ (the ant apply files) from the definitions
 * npm run managed -- setup     print the ant apply command if ant can apply; otherwise create what has no id, once
 * npm run managed -- report    the morning-after report for the deployment, since yesterday 00:00
 * npm run managed -- worker    serve scheduled runs that are waiting on the repo, once
 *
 * Everything but export calls the API, under the ledger.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallGuard, SchemaValidator, gatherTick, loadCatalogue, prepareTick, rotaTools, spawnRotaServer, type ToolSpec } from '@ghillie/agent-kit';
import { RotaService, Store, addDays, config, londonDate } from '@ghillie/engine';
import { feedSources, seedWorld } from '@ghillie/feed';
import { connectInMemory } from '@ghillie/mcp-server';
import { Ledger } from '@ghillie/ledger';
import { agentDefinition, deploymentDefinition, environmentDefinition, resourceFiles } from './definitions.js';
import { liveManagedPort } from './port.js';
import { morningAfter, renderMorningAfter } from './report.js';
import { driveSession, guardConfirmer } from './session.js';
import { antCanApply, antVersion, ensureResources, readIds } from './setup.js';
import { workerPass } from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, '..', 'resources');
const idsPath = join(resources, 'ids.json');
export const managedModel = config.models.managedAgents;

/** The tool list, read from the Phase 1a server itself. */
async function rotaToolSpecs(): Promise<ToolSpec[]> {
  const store = new Store({ path: ':memory:' });
  const { service } = seedWorld(store, () => new Date('2027-06-07T13:00:00+01:00'));
  const { client, close } = await connectInMemory(service);
  const tools = (await loadCatalogue(client)).filter((t) => (rotaTools as readonly string[]).includes(t.name));
  await close();
  store.close();
  return tools;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const ledger = new Ledger();
  const tools = await rotaToolSpecs();
  const agent = agentDefinition({ model: managedModel, tools });
  if (command === 'export') {
    for (const [path, text] of Object.entries(resourceFiles(agent))) {
      mkdirSync(dirname(join(resources, path)), { recursive: true });
      writeFileSync(join(resources, path), text);
      process.stdout.write(`wrote resources/${path}\n`);
    }
    return;
  }
  const port = liveManagedPort();
  if (command === 'setup') {
    const version = antVersion();
    if (antCanApply(version)) {
      process.stdout.write(`ant ${version ?? ''} can apply the files. Review the plan, then apply it yourself:\n  ant apply --dry-run -v packages/agent-managed/resources/agents packages/agent-managed/resources/environments packages/agent-managed/resources/deployments\n`);
      return;
    }
    process.stdout.write(`ant ${version ?? 'is not installed'}${version ? ' cannot apply files (1.30.0 or later needed)' : ''}: creating in code, once.\n`);
    const { ids, created } = await ensureResources({ port, idsPath, agent, environment: environmentDefinition(), deployment: (refs) => deploymentDefinition({ agent: refs.agent, environment: refs.environment }), pauseDeployment: !process.argv.includes('--active') });
    process.stdout.write(`${created.length ? `created ${created.join(', ')}` : 'nothing to create'}\n${JSON.stringify(ids, null, 2)}\n`);
  } else if (command === 'report') {
    const deployment = readIds(idsPath).deployment?.id;
    if (!deployment) throw new Error('no deployment id in resources/ids.json: run setup first');
    const since = `${addDays(londonDate(new Date().toISOString()), -1)}T00:00:00Z`;
    process.stdout.write(`${renderMorningAfter(await morningAfter(port, deployment, since))}\n`);
  } else if (command === 'worker') {
    const ids = readIds(idsPath);
    if (!ids.deployment) throw new Error('no deployment id in resources/ids.json: run setup first');
    const dbPath = process.env.GHILLIE_DB ?? 'data/managed.db';
    const done = new Set<string>();
    const pass = await workerPass({
      port,
      deploymentId: ids.deployment.id,
      done,
      serve: async (sessionId, events, pending, scheduledAt) => {
        const store = new Store({ path: dbPath });
        const service = new RotaService({ store, clock: () => new Date(scheduledAt) });
        const tick = prepareTick(service.read(), await gatherTick(feedSources(), service.read(), scheduledAt), scheduledAt);
        const { client, close } = await spawnRotaServer({ dbPath, clock: scheduledAt });
        const validator = new SchemaValidator(tools);
        try {
          return await driveSession(
            {
              model: managedModel,
              tick,
              client,
              gateGuard: new CallGuard({ validator, allowed: rotaTools }),
              confirmer: guardConfirmer(new CallGuard({ validator, allowed: rotaTools, store: () => store })),
              meter: ledger,
              label: `scheduled ${scheduledAt}`,
              port,
              exportPath: join('recordings', 'managed', `${sessionId}.jsonl`),
            },
            sessionId,
            events,
            pending,
          );
        } finally {
          await close();
          store.close();
        }
      },
    });
    process.stdout.write(`served ${pass.served.length}, refused ${pass.refused.length} over the daily cap\n`);
  } else {
    process.stdout.write('usage: managed export | setup | report | worker\n');
  }
  process.stdout.write(`${ledger.summary()}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`managed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(`${new Ledger().summary()}\n`);
  process.exit(1);
});
