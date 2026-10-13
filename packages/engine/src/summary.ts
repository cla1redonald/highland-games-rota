/**
 * The run summary: one row per run. The next run reads it to anchor its window and spot what changed; the watchdog
 * reads it to tell "nothing to say" from "did not run" and "could not say".
 */
import { z } from 'zod';

const ragSchema = z.enum(['Green', 'Amber', 'Red']);

export const snapshotSchema = z.object({
  /** Saturday date: [delta now, RAG]. Each person counted once across the day's games. */
  saturdays: z.record(z.string(), z.tuple([z.number(), ragSchema])),
  /** Games id: [delta now, RAG]. */
  games: z.record(z.string(), z.tuple([z.number(), ragSchema])),
  /** Games id within the lookahead: the Chief Steward booked or pencilled there, or null. */
  leads: z.record(z.string(), z.string().nullable()),
  /** "person@games" for everyone over-used within the lookahead. */
  overUsed: z.array(z.string()),
  /** Saturdays within the lookahead where anyone dropping out makes it short. */
  noSpare: z.array(z.string()),
  /** "person@games=kind" for every booking (Stewarding, Supporting) and pencil. */
  booked: z.array(z.string()),
  doubleBooked: z.array(z.string()),
  events: z.record(
    z.string(),
    z.object({ label: z.string(), date: z.string(), type: z.string(), confirmed: z.boolean() }),
  ),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

export const runSummarySchema = z.object({
  window: z.tuple([z.string(), z.string()]),
  mode: z.enum(['tuning', 'full']),
  writes: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  exceptions: z.number().int().nonnegative(),
  messaged: z.boolean(),
  /** Source name: "ok" or the problem in a few words. */
  sources: z.record(z.string(), z.string()),
  /** The window each source was read for, so a source that failed is re-read from where it last worked. */
  sourceWindows: z.record(z.string(), z.tuple([z.string(), z.string()])),
  snapshot: snapshotSchema,
  pipelineProposed: z.array(z.string()),
  /** Evidence ids read this run, so overlapping windows never report the same thing twice. */
  read: z.array(z.string()),
  toolCalls: z.number().int().nonnegative(),
});

export type RunSummary = z.infer<typeof runSummarySchema>;

const sourceStatus = z.string().regex(/^(ok|timed out after \d+ ms|error|needs re-authorising)$/);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/);

/**
 * What a caller may tell log_run. Everything else in the summary (counts, mode, snapshot, proposals, whether the
 * organiser was messaged) the service works out for itself.
 */
export const runInputSchema = z
  .object({
    window: z.tuple([instant, instant]),
    sources: z.partialRecord(z.enum(['chat', 'mail', 'minutes', 'calendar']), sourceStatus),
    sourceWindows: z.partialRecord(z.enum(['chat', 'mail', 'minutes', 'calendar']), z.tuple([instant, instant])),
    exceptions: z.number().int().nonnegative(),
    /** Digests of the evidence ids read: an id can carry source text, so only its digest is kept. */
    read: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(500),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict();

export type RunInput = z.infer<typeof runInputSchema>;
