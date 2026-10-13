/**
 * The Managed Agents calls this build makes, behind a narrow port so tests can stand a stub in for the platform. The
 * live adapter maps each to the SDK, which sets the beta header itself.
 */
import ApiClient from '@anthropic-ai/sdk';

/** A platform field as text: empty unless it is a string. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type ManagedEvent = { id: string; type: string } & Record<string, unknown>;

export interface ManagedSession {
  id: string;
  status: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; list_cost?: { amount: string; currency: string } | null } | null;
  metadata?: Record<string, string> | null;
}

export interface ManagedPort {
  createAgent(body: Record<string, unknown>): Promise<{ id: string; version: number }>;
  createEnvironment(body: Record<string, unknown>): Promise<{ id: string }>;
  createDeployment(body: Record<string, unknown>): Promise<{ id: string; schedule?: unknown }>;
  pauseDeployment(id: string): Promise<{ id: string; status?: string }>;
  createSession(body: Record<string, unknown>): Promise<ManagedSession>;
  retrieveSession(id: string): Promise<ManagedSession>;
  listSessions(): Promise<ManagedSession[]>;
  stream(id: string): Promise<AsyncIterable<ManagedEvent>>;
  send(id: string, events: Record<string, unknown>[]): Promise<void>;
  listEvents(id: string): Promise<ManagedEvent[]>;
  listDeploymentRuns(deploymentId: string): Promise<Record<string, unknown>[]>;
}

type Beta = ApiClient['beta'];

async function all<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of pages) out.push(item);
  return out;
}

export function liveManagedPort(client: ApiClient = new ApiClient()): ManagedPort {
  const beta: Beta = client.beta;
  return {
    createAgent: async (body) => await beta.agents.create(body as unknown as Parameters<Beta['agents']['create']>[0]),
    createEnvironment: async (body) => beta.environments.create(body as unknown as Parameters<Beta['environments']['create']>[0]),
    createDeployment: async (body) => beta.deployments.create(body as unknown as Parameters<Beta['deployments']['create']>[0]),
    pauseDeployment: async (id) => await beta.deployments.pause(id),
    createSession: async (body) => await beta.sessions.create(body as unknown as Parameters<Beta['sessions']['create']>[0]),
    retrieveSession: async (id) => await beta.sessions.retrieve(id),
    listSessions: async () => await all(beta.sessions.list()),
    stream: async (id) => (await beta.sessions.events.stream(id)) as unknown as AsyncIterable<ManagedEvent>,
    send: async (id, events) => {
      await beta.sessions.events.send(id, { events } as unknown as Parameters<Beta['sessions']['events']['send']>[1]);
    },
    listEvents: async (id) => (await all(beta.sessions.events.list(id))) as unknown as ManagedEvent[],
    listDeploymentRuns: async (deploymentId) => (await all(beta.deploymentRuns.list({ deployment_id: deploymentId }))) as unknown as Record<string, unknown>[],
  };
}
