/**
 * The Agent SDK options, deny by default. The session gets the rota MCP server's eight tools, named here in code,
 * and nothing else: no built-in tools, no settings files, no CLAUDE.md, no skills, no plugins, no other MCP server,
 * and no permission prompt that could be answered yes. Its config directory is the harness's own, so nothing from
 * the machine's user configuration is loaded and sessions are persisted where the harness can resume them.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanUseTool, HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk';
import { SYSTEM_PROMPT, rotaTools, serverCommand, serverEnv } from '@ghillie/agent-kit';

export const serverName = 'rota';
export const allowedToolNames: readonly string[] = rotaTools.map((t) => `mcp__${serverName}__${t}`);

/** Built-in tool names, refused again by name in case a later SDK version adds any of them back by default. */
export const builtInTools = ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Skill', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write'];

/** Strips the server prefix: "mcp__rota__read_rota" is "read_rota". Anything else is null. */
export function rotaToolName(sdkName: string): string | null {
  return allowedToolNames.includes(sdkName) ? sdkName.slice(`mcp__${serverName}__`.length) : null;
}

export const denyOthers: CanUseTool = (toolName) =>
  Promise.resolve(rotaToolName(toolName) ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: `${toolName} is not a rota tool` });

export interface SdkOptionsInput {
  model: string;
  /** The store the MCP server opens, and the fixed clock it runs on. */
  dbPath: string;
  clock: string;
  /** The harness's own directory: config, persisted sessions and a scratch working directory. */
  stateDir: string;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  maxTurns: number;
  maxBudgetUsd: number;
  resume?: string;
  /** The API-key variable to pass through, by name. Nothing else from this process's environment is passed. */
  credential?: { name: string; value: string };
}

export function buildSdkOptions(input: SdkOptionsInput): Options {
  const configDir = join(input.stateDir, 'config');
  const workDir = join(input.stateDir, 'work');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const { command, args } = serverCommand();
  return {
    model: input.model,
    systemPrompt: SYSTEM_PROMPT,
    effort: 'medium',
    tools: [],
    allowedTools: [...allowedToolNames],
    disallowedTools: builtInTools,
    canUseTool: denyOthers,
    permissionMode: 'dontAsk',
    settingSources: [],
    skills: [],
    plugins: [],
    strictMcpConfig: true,
    mcpServers: { [serverName]: { type: 'stdio', command, args, env: { ...serverEnv(), GHILLIE_DB: input.dbPath, GHILLIE_CLOCK: input.clock } } },
    hooks: input.hooks,
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    persistSession: true,
    cwd: workDir,
    env: {
      ...serverEnv(),
      HOME: input.stateDir,
      CLAUDE_CONFIG_DIR: configDir,
      ...(input.credential ? { [input.credential.name]: input.credential.value } : {}),
    },
    ...(input.resume ? { resume: input.resume } : {}),
  };
}
