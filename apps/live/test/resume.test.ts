/**
 * The hosted demo keeps a visitor's run between ticks as a saved show plus its store file, closed and reopened in a
 * fresh process each time. A fortnight played that way must end exactly where one played straight through ends.
 */
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Show } from '../src/show.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ghillie-resume-'));

describe('a saved show', () => {
  it('ends the fortnight where an unbroken one does, saved and reopened after every tick', async () => {
    const straight = await Show.open({ dbPath: join(tmp(), 'straight.db') });
    while (!straight.finished) await straight.step('stand-in');

    const dir = tmp();
    let path = join(dir, 'hop-0.db');
    let show = await Show.open({ dbPath: path });
    let hops = 0;
    while (!show.finished) {
      await show.step('stand-in');
      const saved = JSON.parse(JSON.stringify(show.save())) as ReturnType<Show['save']>;
      await show.close();
      // A new file each time, as a fresh function gets the snapshot on its own disk.
      const next = join(dir, `hop-${++hops}.db`);
      copyFileSync(path, next);
      path = next;
      show = await Show.resume({ dbPath: path }, saved);
    }

    expect(hops).toBe(straight.ticks.length);
    expect(straight.world.store.outbox().length).toBeGreaterThan(3);
    expect(show.grid()).toEqual(straight.grid());
    expect(show.plan()).toEqual(straight.plan());
    expect(show.world.store.outbox().map((m) => m.text)).toEqual(straight.world.store.outbox().map((m) => m.text));
    expect(show.world.store.log().length).toBe(straight.world.store.log().length);
    expect(show.results.map((r) => [r.at, r.mode, r.watchdog])).toEqual(straight.results.map((r) => [r.at, r.mode, r.watchdog]));
    await show.close();
    await straight.close();
  });

  it('replays a recorded Managed Agents tick the same way with its tool calls answered in this process', async () => {
    const viaSubprocess = await Show.open({ dbPath: join(tmp(), 'sub.db') });
    const inProcess = await Show.open({ dbPath: join(tmp(), 'in.db'), inProcess: true });
    expect(viaSubprocess.rows()[0]?.recorded).toBe(true);
    const a = await viaSubprocess.step('replay', { speed: 1000 });
    const b = await inProcess.step('replay', { speed: 1000 });
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(b.run?.writes.length).toBeGreaterThan(0);
    expect(b.run?.writes).toEqual(a.run?.writes);
    expect(inProcess.grid()).toEqual(viaSubprocess.grid());
    await viaSubprocess.close();
    await inProcess.close();
  });

  it('applies none of Isla\'s console actions twice and misses none', async () => {
    const dir = tmp();
    const show = await Show.open({ dbPath: join(dir, 'a.db') });
    const applied: string[] = [];
    for (let i = 0; i < 6; i++) applied.push(...(await show.step('stand-in')).console);
    const saved = show.save();
    await show.close();
    const again = await Show.resume({ dbPath: join(dir, 'a.db') }, saved);
    while (!again.finished) applied.push(...(await again.step('stand-in')).console);

    const straight = await Show.open({ dbPath: join(tmp(), 'b.db') });
    const expected: string[] = [];
    while (!straight.finished) expected.push(...(await straight.step('stand-in')).console);
    expect(applied).toEqual(expected);
    await again.close();
    await straight.close();
  });
});
