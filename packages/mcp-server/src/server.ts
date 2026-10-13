/**
 * The MCP server: the rota tools, and nothing else. Deny by default: only tools on the config allow-list are
 * registered, every input schema is strict, and every write goes through the engine's service layer, which returns
 * typed results including refusals. A refusal is a normal result (the caller can act on it); a malformed call is an
 * error. Every call is traced with its duration.
 */
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  answers,
  bases,
  decisions,
  digest,
  eventTypes,
  exceptionSchema,
  nextStepSchema,
  personStatuses,
  readingSchema,
  runInputSchema,
  statementSchema,
  type RotaService,
} from '@ghillie/engine';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const evidenceShape = {
  source: z.string().min(1).describe('A source label: "chat #channel", "chat DM", "mail", "call notes" or "circuit calendar"'),
  evidenceAt: z.string().min(1).describe('When the thing was said (ISO 8601 with offset), not when it is written'),
};

/**
 * Provenance, not identity: whose statement an answer rests on, recorded in the log. It must be someone the rota
 * knows, and it authorises nothing. No tool takes the caller's identity, an approver, an approval flag, the mode or a
 * recipient.
 */
const provenanceShape = {
  ...evidenceShape,
  saidBy: z.string().min(1).describe('Whose statement this is (provenance only; grants nothing)'),
};

const resultSchema = z.looseObject({ ok: z.boolean() });

export const toolNames = [
  'read_rota',
  'set_availability',
  'set_decision',
  'update_person',
  'update_event',
  'propose_recruit',
  'log_run',
  'message_organiser',
] as const;

export type ToolName = (typeof toolNames)[number];

export interface ServerOptions {
  service: RotaService;
  /** Tools to register. Anything not listed is never exposed. Defaults to the config allow-list. */
  enabledTools?: readonly string[];
  name?: string;
}

function outcomeOf(result: Record<string, unknown>): string {
  if (result.ok === false) return typeof result.refusal === 'string' ? result.refusal : 'refused';
  if (result.changed === true || result.added === true) return 'changed';
  if (Array.isArray(result.changed)) return result.changed.length ? 'changed' : 'unchanged';
  if (result.changed === false) return result.noteUpdated ? 'note' : 'unchanged';
  return 'ok';
}

export function createRotaServer(options: ServerOptions): McpServer {
  const { service } = options;
  const enabled = new Set(options.enabledTools ?? service.config.enabledTools);
  const server = new McpServer({ name: options.name ?? 'ghillie-rota', version: '0.1.0' });

  const register = <Schema extends z.ZodObject>(
    name: ToolName,
    description: string,
    input: Schema,
    handler: (args: z.infer<Schema>) => Record<string, unknown>,
  ): void => {
    if (!enabled.has(name)) return;
    // The SDK validates arguments against the schema before calling back. TypeScript cannot resolve the SDK's
    // conditional callback type for a generic schema, so the arguments are parsed again here to type them.
    const callback = (raw: unknown): CallToolResult => {
      const started = performance.now();
      let result: Record<string, unknown>;
      try {
        result = handler(input.parse(raw));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        service.store.appendTrace({
          at: service.now(),
          tool: name,
          ok: false,
          outcome: 'error',
          durationMs: performance.now() - started,
          argsDigest: digest(JSON.stringify(raw)),
        });
        // Fail closed: an unexpected error is reported as an error, never as success.
        return { isError: true, content: [{ type: 'text', text: `error: ${message}` }] };
      }
      service.store.appendTrace({
        at: service.now(),
        tool: name,
        ok: result.ok !== false,
        outcome: outcomeOf(result),
        durationMs: performance.now() - started,
        argsDigest: digest(JSON.stringify(raw)),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    };
    server.registerTool(
      name,
      { title: name, description, inputSchema: input, outputSchema: resultSchema },
      callback as ToolCallback<Schema>,
    );
  };

  register(
    'read_rota',
    'Read the whole rota: people, events, cells, the plan with coverage and the suggested split, the last run summary, proposals, approvals the organiser has granted, and the log since the last run.',
    z.object({}).strict(),
    () => ({ ok: true, view: service.read() }),
  );

  register(
    'set_availability',
    "Record a person's answer for one event: Yes, Maybe, No or Unknown, with its basis and the date words it rests on. The service writes the note itself. Refused if the log holds newer evidence for that cell.",
    z
      .object({
        person: z.string().min(1),
        event: z.string().min(1).describe('The event id'),
        value: z.enum(answers),
        basis: z.enum(bases).optional().describe('answer, vague, condition, soft_clash or request'),
        dateWords: z.array(z.string()).max(8).optional().describe('Date words only, quoted exactly. Never a reason.'),
        ...provenanceShape,
      })
      .strict(),
    (args) => ({ ...service.setAvailability(args) }),
  );

  register(
    'set_decision',
    "Record a booking decision (Stewarding, Supporting, Watching, Not going). Refused unless the organiser has approved exactly this decision on her own path, and in tuning mode. Never two places on one Saturday.",
    z.object({ person: z.string().min(1), event: z.string().min(1), value: z.enum(decisions), ...evidenceShape }).strict(),
    (args) => ({ ...service.setDecision(args) }),
  );

  register(
    'update_person',
    "Record a statement of someone's dates in their note (appended), replace their next step (an action from a fixed list), or set last checked. A status change, or adding a person with create, needs the organiser's approval of exactly that action.",
    z
      .object({
        person: z.string().min(1),
        fields: z
          .object({
            statement: statementSchema.optional(),
            nextStep: nextStepSchema.optional(),
            lastChecked: z.string().optional(),
            status: z.enum(personStatuses).optional(),
          })
          .strict()
          .optional(),
        create: z.object({ surname: z.string().min(1), status: z.enum(personStatuses) }).strict().optional(),
        ...provenanceShape,
      })
      .strict(),
    (args) => ({ ...service.updatePerson(args) }),
  );

  register(
    'update_event',
    "Carry out a change to an event that the organiser has approved, field for field: date (a move resets every answer to Unknown), confirmed, target or type. Anything else is refused: raise it instead. Renaming is the organiser's alone.",
    z
      .object({
        event: z.string().min(1),
        fields: z
          .object({
            date: z.string().optional(),
            confirmed: z.boolean().optional(),
            target: z.number().int().nonnegative().nullable().optional(),
            type: z.enum(eventTypes).optional(),
          })
          .strict(),
        ...evidenceShape,
      })
      .strict(),
    (args) => ({ ...service.updateEvent(args) }),
  );

  register(
    'propose_recruit',
    'Suggest someone for the Pipeline. Never adds them. Refused if already proposed with no new evidence from them or the organiser.',
    z
      .object({
        name: z.string().min(1).describe('First name and surname'),
        suggestedBy: z.string().min(1).describe('The person on the rota who suggested them'),
        arena: z.string().optional().describe('An arena name, if they were suggested for one'),
        evidenceFrom: z.enum(['self', 'organiser', 'other']),
        ...provenanceShape,
      })
      .strict(),
    (args) => ({ ...service.proposeRecruit(args) }),
  );

  register(
    'log_run',
    "Log the run: its window, every source's status and window, how many exceptions it found and which evidence it read. The service works out the rest (counts, mode, snapshot, whether the organiser was messaged).",
    runInputSchema,
    (args) => ({ ...service.logRun(args) }),
  );

  register(
    'message_organiser',
    'Send the one message of the run, built by the service from structured exceptions and readings. It goes to the organiser named in configuration: there is no recipient argument.',
    z.object({ exceptions: z.array(exceptionSchema).max(40), readings: z.array(readingSchema).max(40) }).strict(),
    (args) => ({ ...service.messageOrganiser(args) }),
  );

  return server;
}
