/**
 * The watchdog. Without it, "no message" could mean "nothing to say", "did not run" or "could not say". It runs on
 * weekday evenings and alerts the organiser when a scheduled run left no trace, or a run had something for her but
 * could not message her.
 */
import { config, type ScheduleConfig } from './config.js';
import { compareInstants, formatWhen, isWeekday, londonDate, londonInstant } from './dates.js';
import { runSummarySchema } from './summary.js';

export interface LoggedRun {
  loggedAt: string;
  summary: string;
}

export function watchdogProblems(now: string, runs: LoggedRun[], schedule: ScheduleConfig = config.schedule): string[] {
  const today = londonDate(now);
  if (!isWeekday(today)) return [];
  const problems: string[] = [];
  const slots = schedule.ticks.map((time) => londonInstant(today, time));
  const graceMs = schedule.graceMinutes * 60_000;
  const last = [...runs].sort((a, b) => compareInstants(a.loggedAt, b.loggedAt)).at(-1);

  slots.forEach((slot, i) => {
    const due = new Date(new Date(slot).getTime() + graceMs).toISOString();
    if (compareInstants(due, now) > 0) return;
    const next = slots[i + 1];
    const ran = runs.some(
      (run) => compareInstants(run.loggedAt, slot) >= 0 && (!next || compareInstants(run.loggedAt, next) < 0),
    );
    if (!ran) {
      problems.push(`No run was logged for the ${schedule.ticks[i]} slot today. Last run: ${last ? formatWhen(last.loggedAt) : 'never'}.`);
    }
  });

  for (const run of runs) {
    if (londonDate(run.loggedAt) !== today) continue;
    let parsed;
    try {
      parsed = runSummarySchema.safeParse(JSON.parse(run.summary));
    } catch {
      problems.push(`The run at ${formatWhen(run.loggedAt)} logged a summary that could not be read.`);
      continue;
    }
    if (!parsed.success) {
      problems.push(`The run at ${formatWhen(run.loggedAt)} logged a summary that could not be read.`);
      continue;
    }
    const summary = parsed.data;
    if (summary.exceptions > 0 && !summary.messaged) {
      const bad = Object.entries(summary.sources)
        .filter(([, status]) => status !== 'ok')
        .map(([name]) => name);
      problems.push(
        `The run at ${formatWhen(run.loggedAt)} found ${summary.exceptions} thing(s) for you but could not message you` +
          (bad.length ? ` (sources not read: ${bad.join(', ')})` : '') +
          '.',
      );
    }
  }
  return problems;
}
