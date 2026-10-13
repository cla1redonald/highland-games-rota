/**
 * The eval case format. Each case states the rules its expected outcome follows from; the expectation was written
 * from those rules before the case was run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/);

const stepSchema = z
  .object({
    at: instant.optional(),
    edits: z.array(z.object({ person: z.string(), event: z.string(), value: z.string() }).strict()).optional(),
    pencils: z.array(z.object({ person: z.string(), event: z.string(), asLead: z.boolean().optional() }).strict()).optional(),
    moves: z.array(z.object({ event: z.string(), date: z.string() }).strict()).optional(),
    proposals: z.array(z.object({ name: z.string(), suggestedBy: z.string(), arena: z.string().optional() }).strict()).optional(),
    approvals: z
      .array(
        z
          .object({
            decision: z.object({ person: z.string(), event: z.string(), value: z.enum(['Stewarding', 'Supporting', 'Watching', 'Not going']) }).strict().optional(),
            event: z.object({ id: z.string(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict().optional(),
            recruit: z.string().optional(),
            status: z.object({ person: z.string(), status: z.enum(['In', 'Maybe', 'Leadership', 'Pipeline', 'Out']) }).strict().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const itemSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,30}$/),
    source: z.enum(['chat', 'mail', 'minutes', 'calendar']),
    label: z.string(),
    who: z.string(),
    at: instant,
    text: z.string(),
    trusted: z.boolean().optional(),
    aliases: z.record(z.string(), z.string()).optional(),
    calendar: z.object({ eventId: z.string(), date: z.string(), by: z.string() }).strict().optional(),
  })
  .strict();

const writePattern = z
  .object({
    action: z.string().optional(),
    person: z.string().optional(),
    event: z.string().optional(),
    value: z.string().optional(),
    field: z.string().optional(),
    outcome: z.string().optional(),
  })
  .strict();

export const expectSchema = z
  .object({
    writes_include: z.array(writePattern).optional(),
    writes_exclude: z.array(writePattern).optional(),
    refused_include: z.array(writePattern).optional(),
    proposals_include: z.array(z.object({ person: z.string(), value: z.string().optional() }).strict()).optional(),
    proposals_exclude: z.array(z.object({ person: z.string(), value: z.string().optional() }).strict()).optional(),
    exceptions_include: z.array(z.string()).optional(),
    exceptions_exclude: z.array(z.string()).optional(),
    message: z.enum(['required', 'none', 'any']).default('any'),
    message_contains: z.array(z.string()).optional(),
    message_contains_all: z.array(z.string()).optional(),
    forbidden_text: z.array(z.string()).optional(),
    max_writes: z.number().int().nonnegative().optional(),
    state: z
      .object({
        cells: z.array(z.object({ person: z.string(), event: z.string(), value: z.string() }).strict()).optional(),
        events: z.array(z.object({ id: z.string(), date: z.string() }).strict()).optional(),
        people: z.array(z.object({ name: z.string(), status: z.string().optional(), role: z.string().optional(), absent: z.boolean().optional() }).strict()).optional(),
        leads: z.array(z.object({ event: z.string(), lead: z.string().nullable() }).strict()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,38}$/),
    title: z.string(),
    rules: z.array(z.string().regex(/^R\d+$/)).min(1),
    /** Which of the original case templates' structure this reuses, described in this world's terms. */
    basedOn: z.string(),
    /** A case the stand-in cannot do, with the reason: reported as skipped, never as a pass. */
    skip: z.string().optional(),
    now: instant,
    mode: z.enum(['tuning', 'full']).default('full'),
    setup: z.object({ before: stepSchema.optional(), previousRunAt: instant, after: z.array(stepSchema).optional() }).strict(),
    evidence: z.object({ sources: z.record(z.string(), z.string()), items: z.array(itemSchema) }).strict(),
    expect: expectSchema,
  })
  .strict();

export type EvalCase = z.infer<typeof caseSchema>;
export type Expect = z.infer<typeof expectSchema>;
export type WritePattern = z.infer<typeof writePattern>;

export const casesDir = new URL('../cases/', import.meta.url);

export function loadCases(): EvalCase[] {
  return readdirSync(casesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const parsed = caseSchema.safeParse(JSON.parse(readFileSync(new URL(file, casesDir), 'utf8')));
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      if (`${parsed.data.id}.json` !== file) throw new Error(`${file}: id ${parsed.data.id} does not match the file name`);
      return parsed.data;
    });
}
