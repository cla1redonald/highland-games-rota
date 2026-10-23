/**
 * Live ticks spend money, so they go through the same Ledger as every other build, with the same hard cap. The
 * ledger lives in a file; a function's disk does not last. So each tick gets a fresh ledger file whose first line
 * carries the running total from Turso, and whatever the tick adds is copied back to Turso when it ends.
 *
 * Each live session is also capped by the platform itself (a session budget, set in the build's definitions), so a
 * runaway session stops even if this process dies before it can count.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARD_CAP_USD, Ledger, type LedgerEntry } from '@ghillie/ledger';
import { db } from './db';
import { scratch } from './paths';

export const capUsd = HARD_CAP_USD;

export async function totalSpent(): Promise<number> {
  const result = await (await db()).execute('select coalesce(sum(usd), 0) as total from spend');
  return Number(result.rows[0]?.total ?? 0);
}

export class TickLedger {
  readonly ledger: Ledger;
  private constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly tickAt: string,
  ) {
    this.ledger = new Ledger({
      path,
      stop: (message: string): never => {
        throw new Error(message);
      },
      print: () => undefined,
    });
  }

  static async open(runId: string, tickAt: string): Promise<TickLedger> {
    const path = join(scratch('ledgers'), `${randomUUID()}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ usd: await totalSpent(), basis: 'carried from Turso' })}\n`);
    return new TickLedger(path, runId, tickAt);
  }

  /** Copies this tick's entries to Turso. Safe to call once, whatever happened in the tick. */
  async flush(): Promise<number> {
    const entries = readFileSync(this.path, 'utf8')
      .split('\n')
      .slice(1)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LedgerEntry);
    rmSync(this.path, { force: true });
    if (!entries.length) return 0;
    await (await db()).batch(
      entries.map((e) => ({
        sql: 'insert into spend (at, run_id, tick_at, model, usd, basis, entry) values (?, ?, ?, ?, ?, ?, ?)',
        args: [e.at, this.runId, this.tickAt, e.model, e.usd, e.basis, JSON.stringify(e)],
      })),
      'write',
    );
    return entries.reduce((sum, e) => sum + e.usd, 0);
  }
}
