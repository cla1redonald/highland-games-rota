/**
 * The message to the organiser. Plain British English, short enough to read on a phone, at most ten bullets in all.
 * Readings go in every message whenever anyone's dates were read: date words only, never reasons.
 *
 * The service composes the whole message from structured exceptions and readings; nothing a source said reaches it
 * except date words that passed the grammar.
 */
import { z } from 'zod';
import { config } from './config.js';
import { formatWhen } from './dates.js';
import { renderException, type RenderContext, type RotaException } from './exceptions.js';
import type { GamesEvent } from './types.js';
import { sourceLabelPattern } from './words.js';

export const qualifiers = ['condition', 'soft_clash', 'request', 'not_written_newer', 'not_written_unordered'] as const;

export const readingSchema = z
  .object({
    person: z.string().regex(/^[A-Z][a-z'-]{1,20}$/),
    source: z.string().regex(sourceLabelPattern),
    at: z.string().min(1),
    /** The date words the reading rests on. Checked against the date-word grammar by the service. */
    dateWords: z.array(z.string()).max(8),
    verdicts: z
      .array(
        z
          .object({
            event: z.string().regex(/^[a-z0-9-]{1,40}$/),
            value: z.enum(['Yes', 'Maybe', 'No', 'Unknown']),
            qualifier: z.enum(qualifiers).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

export type Reading = z.infer<typeof readingSchema>;

const qualifierText: Record<(typeof qualifiers)[number], string> = {
  condition: 'condition',
  soft_clash: 'soft clash',
  request: 'asked to be put down, not an answer',
  not_written_newer: 'not written: the rota has a newer entry',
  not_written_unordered: 'not written: unordered',
};

function shortName(events: GamesEvent[], id: string): string {
  const event = events.find((e) => e.id === id);
  if (!event) return id;
  return event.type === 'Setup day' ? 'Setup day' : event.village;
}

export function readingLine(reading: Reading, events: GamesEvent[]): string {
  const quoted = reading.dateWords.map((w) => `"${w}"`).join(', ');
  const kind = reading.source.startsWith('chat') ? 'chat' : reading.source;
  const verdicts = reading.verdicts
    .map((v) => `${shortName(events, v.event)} ${v.value}${v.qualifier ? ` (${qualifierText[v.qualifier]})` : ''}`)
    .join(', ');
  return `${reading.person} (${kind} ${formatWhen(reading.at)}${quoted ? `: ${quoted}` : ''}): ${verdicts}`;
}

export interface MessageInput {
  exceptions: RotaException[];
  readings: Reading[];
  context: RenderContext;
  maxBullets?: number;
  planLink?: string;
}

/** Returns the message, or an empty string when there is nothing to say. */
export function renderMessage(input: MessageInput): string {
  const maxBullets = input.maxBullets ?? config.rules.maxBullets;
  const planLink = input.planLink ?? config.planLink;
  const { exceptions, readings } = input;
  if (!exceptions.length && !readings.length) return '';

  const lines: string[] = [];
  const count = exceptions.length;
  lines.push(count === 0 ? 'Ghillie: nothing needs you, readings below' : `Ghillie: ${count} ${count === 1 ? 'thing needs' : 'things need'} you`);

  // Exceptions first; readings take what is left of the ten. Anything that does not fit is in the run log.
  const total = exceptions.length + readings.length;
  const room = total > maxBullets ? maxBullets - 1 : maxBullets;
  const shownExceptions = exceptions.slice(0, room);
  const shownReadings = readings.slice(0, Math.max(0, room - shownExceptions.length));
  for (const exception of shownExceptions) lines.push(`• ${renderException(exception, input.context)}`);
  if (shownReadings.length) {
    lines.push('Readings (reply here to correct any)');
    for (const reading of shownReadings) lines.push(`• ${readingLine(reading, input.context.events)}`);
  }
  const hidden = total - shownExceptions.length - shownReadings.length;
  if (hidden > 0) lines.push(`• ${hidden} more in the run log`);
  lines.push(`Plan: ${planLink}`);
  return lines.join('\n');
}
