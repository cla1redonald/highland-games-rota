/**
 * The agent, the environment and the deployment, defined once here and written out as files in the layout
 * `ant apply` reads (resources/). Frontmatter is JSON, which is valid YAML.
 *
 * Tools: the rota server's eight tools as custom tools, with the same names and schemas the server lists, plus one
 * harness tool, gather_evidence, for scheduled runs that start with no brief. Custom tools run in the repo's own
 * process, against the same MCP server over stdio; the platform never connects to it. Every built-in tool is
 * declared and switched off.
 *
 * The other path, the platform calling the MCP server by URL, is written here too (mode "mcp"): the rota toolset
 * with every write tool on always_ask and read_rota on always_allow. It needs the server reachable from the
 * platform, which this repo does not do (see docs/decisions/0002-phase-1b.md).
 */
import { SYSTEM_PROMPT, strictSchema, writeTools, type ToolSpec } from '@ghillie/agent-kit';

export const builtInToolNames = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'web_search'] as const;

/** A session's spend cap at creation, in US cents: $2. */
export const sessionBudgetCents = 200;

/** Weekdays at 13:00 and 18:00, London time, as the rota's schedule says. */
export const weekdaySchedule = { type: 'cron', expression: '0 13,18 * * 1-5', timezone: 'Europe/London' } as const;

/** Scheduled runs a weekday may have; more than this and the worker refuses to serve them. */
export const maxRunsPerDay = 2;

export const scheduledKickoff =
  'Scheduled tick. Call gather_evidence first: it returns this tick\'s brief, with the evidence and the logRun fields. Then work through the tick exactly as your instructions say.';

export const gatherEvidenceTool = {
  type: 'custom',
  name: 'gather_evidence',
  description: "Returns this tick's brief: the harness's facts (now, the organiser, the window, source statuses, the logRun fields) and the evidence items. Call it first on a scheduled run.",
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export type ToolMode = 'custom' | 'mcp';

export function budget(cents: number): { type: 'limit'; max_list_cost: { amount: string; currency: 'USD' } } {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('a budget is a whole number of cents above zero');
  return { type: 'limit', max_list_cost: { amount: String(cents), currency: 'USD' } };
}

const disabledToolset = {
  type: 'agent_toolset_20260401',
  default_config: { enabled: false },
  configs: builtInToolNames.map((name) => ({ name, enabled: false })),
};

export function agentDefinition(options: { model: string; tools: ToolSpec[]; mode?: ToolMode; mcpUrl?: string }): Record<string, unknown> {
  const mode = options.mode ?? 'custom';
  const base = {
    name: 'Ghillie rota agent',
    description: 'Keeps the Highland games volunteer rota true and proposes rather than decides.',
    model: { id: options.model, effort: 'medium' },
    system: SYSTEM_PROMPT,
    metadata: { repo: 'ghillie', phase: '1b' },
  };
  if (mode === 'mcp') {
    if (!options.mcpUrl) throw new Error('mode "mcp" needs the URL the platform can reach the server at');
    return {
      ...base,
      mcp_servers: [{ type: 'url', name: 'rota', url: options.mcpUrl }],
      tools: [
        disabledToolset,
        {
          type: 'mcp_toolset',
          mcp_server_name: 'rota',
          default_config: { enabled: false, permission_policy: { type: 'always_ask' } },
          configs: [...options.tools]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({ name: t.name, enabled: true, permission_policy: { type: writeTools.includes(t.name) ? 'always_ask' : 'always_allow' } })),
        },
        gatherEvidenceTool,
      ],
    };
  }
  const custom = [...options.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ type: 'custom', name: t.name, description: t.description, input_schema: strictSchema(t.inputSchema) }));
  return { ...base, tools: [disabledToolset, ...custom, gatherEvidenceTool] };
}

/** Deny by default: no package managers, no MCP egress, and only the hosts listed. Custom tools need none. */
export function environmentDefinition(allowedHosts: string[] = []): Record<string, unknown> {
  return {
    name: 'ghillie-rota',
    config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: allowedHosts, allow_package_managers: false, allow_mcp_servers: false } },
  };
}

export function deploymentDefinition(refs: { agent: unknown; environment: unknown }, cents = sessionBudgetCents): Record<string, unknown> {
  return {
    name: 'Ghillie weekday ticks',
    agent: refs.agent,
    environment_id: refs.environment,
    schedule: weekdaySchedule,
    budget: budget(cents),
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: scheduledKickoff }] }],
  };
}

/** The files `ant apply` reads, rendered from the definitions above. */
export function resourceFiles(agent: Record<string, unknown>): Record<string, string> {
  const { system, ...agentFront } = agent;
  const deployment = deploymentDefinition({ agent: '../agents/ghillie.md', environment: '../environments/ghillie.yaml' });
  const deploymentFront = Object.fromEntries(Object.entries(deployment).filter(([key]) => key !== 'initial_events'));
  return {
    'agents/ghillie.md': `---\n${JSON.stringify(agentFront, null, 2)}\n---\n\n${String(system)}\n`,
    'environments/ghillie.yaml': `${JSON.stringify(environmentDefinition(), null, 2)}\n`,
    'deployments/weekday-ticks.md': `---\n${JSON.stringify(deploymentFront, null, 2)}\n---\n\n${scheduledKickoff}\n`,
  };
}
