/**
 * Recorded Managed Agents sessions, for replays. The ones committed to the repo ship with the deployment; a live tick
 * run on the hosted demo records another, kept in Turso, and the newest recording of a tick is the one replayed.
 * Before a tick, both are laid out in one directory in the shape the show reads.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordingFile, type Recording } from '@ghillie/live';
import { db, text } from './db';
import { committedRecordings, scratch } from './paths';

export async function layOutRecordings(): Promise<string> {
  const dir = scratch('recordings');
  if (existsSync(committedRecordings)) {
    for (const name of readdirSync(committedRecordings)) if (name.endsWith('.json')) copyFileSync(join(committedRecordings, name), join(dir, name));
  }
  const rows = await (await db()).execute('select at, body from recordings');
  for (const row of rows.rows) writeFileSync(join(dir, recordingFile(text(row.at))), text(row.body));
  return dir;
}

/** Keeps the recording a live tick just wrote, so the next visitor can replay it. */
export async function keepRecording(dir: string, at: string, runId: string): Promise<void> {
  const path = join(dir, recordingFile(at));
  if (!existsSync(path)) return;
  const body = readFileSync(path, 'utf8');
  const recording = JSON.parse(body) as Recording;
  await (await db()).execute({
    sql: 'insert into recordings (at, recorded_at, run_id, body) values (?, ?, ?, ?) on conflict(at) do update set recorded_at = excluded.recorded_at, run_id = excluded.run_id, body = excluded.body',
    args: [at, recording.recordedAt, runId, body],
  });
}
