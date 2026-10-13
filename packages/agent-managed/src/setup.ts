/**
 * The agent, environment and deployment are made once and referred to by id ever after. Two ways:
 *
 *   - `ant apply` over resources/ (needs ant 1.30.0 or later, signed in): the files are the definitions and
 *     claude-lock.json records the ids. The repo prints the command; applying is the owner's decision (`--yes`).
 *   - In code, once: if resources/ids.json has no id for a resource, it is created and its id written there. Every
 *     later run reads the id and creates nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ManagedPort } from './port.js';

export interface ResourceIds {
  agent?: { id: string; version: number };
  environment?: { id: string };
  /** The schedule as the platform parsed it, and whether the deployment was left paused. */
  deployment?: { id: string; schedule?: unknown; paused?: boolean };
}

export function readIds(path: string): ResourceIds {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ResourceIds) : {};
}

function writeIds(path: string, ids: ResourceIds): void {
  writeFileSync(path, `${JSON.stringify(ids, null, 2)}\n`);
}

export interface EnsureOptions {
  port: ManagedPort;
  idsPath: string;
  agent: Record<string, unknown>;
  environment: Record<string, unknown>;
  /** Built from the ids, once the agent and environment exist. Left out: no deployment is made. */
  deployment?: (ids: { agent: { type: 'agent'; id: string; version: number }; environment: string }) => Record<string, unknown>;
  /** Pause the deployment as soon as it is made, so no run fires until a worker is there to serve it. */
  pauseDeployment?: boolean;
}

/** Creates only what has no id yet. Returns the ids and what it created. */
export async function ensureResources(o: EnsureOptions): Promise<{ ids: ResourceIds; created: string[] }> {
  const ids = readIds(o.idsPath);
  const created: string[] = [];
  if (!ids.agent) {
    const agent = await o.port.createAgent(o.agent);
    ids.agent = { id: agent.id, version: agent.version };
    created.push(`agent ${agent.id}`);
    writeIds(o.idsPath, ids);
  }
  if (!ids.environment) {
    const environment = await o.port.createEnvironment(o.environment);
    ids.environment = { id: environment.id };
    created.push(`environment ${environment.id}`);
    writeIds(o.idsPath, ids);
  }
  if (o.deployment && !ids.deployment) {
    const deployment = await o.port.createDeployment(o.deployment({ agent: { type: 'agent', ...ids.agent }, environment: ids.environment.id }));
    ids.deployment = { id: deployment.id, ...(deployment.schedule ? { schedule: deployment.schedule } : {}) };
    created.push(`deployment ${deployment.id}`);
    writeIds(o.idsPath, ids);
    if (o.pauseDeployment) {
      await o.port.pauseDeployment(deployment.id);
      ids.deployment.paused = true;
      writeIds(o.idsPath, ids);
    }
  }
  return { ids, created };
}

/** The installed ant version, or null if there is none. */
export function antVersion(run: (cmd: string, args: string[]) => string = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })): string | null {
  try {
    return /(\d+\.\d+\.\d+)/.exec(run('ant', ['--version']))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether this ant can apply resource files (1.30.0 or later). */
export function antCanApply(version: string | null): boolean {
  if (!version) return false;
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 30);
}
