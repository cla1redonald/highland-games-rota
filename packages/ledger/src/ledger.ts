/**
 * The cost ledger. Every model response's usage is recorded here with its model id, priced at list rates, appended to
 * ledger/spend.jsonl with the running total, and the process stops when the running total passes the hard cap.
 *
 * The running total is the whole file, across every script and every run, not just this process: the cap is on the
 * phase's spend. The cap is a constant. Raising it means editing this file, which is the point.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { priceTokens, type TokenCounts } from './prices.js';

/**
 * The approved ceiling for Phase 1b was $150, with a stop at $100. The organisation's monthly limit is shared with
 * other work, so the stop is lowered to $60. Raising it means editing this line.
 */
export const HARD_CAP_USD = 60;

export const defaultLedgerPath = 'ledger/spend.jsonl';

/** The usage block every response carries, in the API's own field names. */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  /** Per-hop usage when a request ran on more than one model (server-side fallback). */
  iterations?: ({ type: string; model?: string | null } & Omit<ApiUsage, 'iterations'>)[] | null;
}

export interface SpendMeta {
  /** Which build made the call: messages, sdk, managed, check. */
  impl: string;
  /** What the call was for: an eval case, a demo tick, a smoke test. */
  label: string;
}

export interface LedgerEntry extends SpendMeta, TokenCounts {
  at: string;
  model: string;
  usd: number;
  totalUsd: number;
  /** Where the figure came from: priced here from usage, or the platform's own list cost for a session. */
  basis: 'usage' | 'list_cost';
}

export interface LedgerOptions {
  path?: string;
  /** For tests: how to stop. Defaults to exiting the process with code 3. */
  stop?: (message: string) => never;
  now?: () => string;
  /** Where to print each entry. Defaults to stderr, so it never mixes with a script's output. */
  print?: (line: string) => void;
}

/** Splits an API usage block into the five priced counts. Cache writes without a lifetime breakdown are five-minute. */
export function tokenCounts(usage: Omit<ApiUsage, 'iterations'>): TokenCounts {
  const written = usage.cache_creation_input_tokens ?? 0;
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: Math.max(0, written - hour),
    cacheWrite1h: hour,
  };
}

const usd = (n: number): string => `$${n.toFixed(4)}`;

export class Ledger {
  readonly path: string;
  private running: number;
  private readonly stop: (message: string) => never;
  private readonly now: () => string;
  private readonly print: (line: string) => void;
  /** Spend recorded by this process, for "this script cost" lines. */
  private session = 0;

  constructor(options: LedgerOptions = {}) {
    this.path = options.path ?? defaultLedgerPath;
    this.stop =
      options.stop ??
      ((message: string): never => {
        process.stderr.write(`${message}\n`);
        process.exit(3);
      });
    this.now = options.now ?? ((): string => new Date().toISOString());
    this.print = options.print ?? ((line: string): void => void process.stderr.write(`${line}\n`));
    this.running = Ledger.totalIn(this.path);
  }

  /** The running total recorded in a ledger file. */
  static totalIn(path: string): number {
    if (!existsSync(path)) return 0;
    let total = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as Partial<LedgerEntry>;
      total += typeof entry.usd === 'number' ? entry.usd : 0;
    }
    return total;
  }

  get total(): number {
    return this.running;
  }

  get spentThisProcess(): number {
    return this.session;
  }

  /** Call before every model request: refuses to start one once the cap has been passed. */
  assertUnderCap(): void {
    if (this.running > HARD_CAP_USD) this.stop(`Ledger: ${usd(this.running)} already spent, over the hard cap of $${HARD_CAP_USD}. No more calls.`);
  }

  /** Records one response's usage. Returns the entry; stops the process if the running total passes the cap. */
  record(model: string, usage: ApiUsage, meta: SpendMeta): LedgerEntry[] {
    const hops = usage.iterations?.length ? usage.iterations : [{ ...usage, type: 'message', model }];
    return hops.map((hop) => this.append({ ...meta, model: hop.model ?? model, ...tokenCounts(hop), basis: 'usage' }));
  }

  /** Records a figure the platform priced itself (a Managed Agents session's list cost), with its token counts. */
  recordListCost(model: string, amountUsd: number, tokens: TokenCounts, meta: SpendMeta): LedgerEntry {
    return this.append({ ...meta, model, ...tokens, basis: 'list_cost' }, amountUsd);
  }

  private append(entry: SpendMeta & TokenCounts & { model: string; basis: LedgerEntry['basis'] }, listUsd?: number): LedgerEntry {
    const cost = listUsd ?? priceTokens(entry.model, entry);
    this.running += cost;
    this.session += cost;
    const full: LedgerEntry = { at: this.now(), ...entry, usd: round(cost), totalUsd: round(this.running) };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(full)}\n`);
    this.print(
      `ledger: ${entry.impl} ${entry.label} ${entry.model} in ${entry.input} out ${entry.output} cache read ${entry.cacheRead} cache write ${entry.cacheWrite5m + entry.cacheWrite1h}: ${usd(cost)} (running ${usd(this.running)})`,
    );
    if (this.running > HARD_CAP_USD) this.stop(`Ledger: running total ${usd(this.running)} passed the hard cap of $${HARD_CAP_USD}. Stopping.`);
    return full;
  }

  /** The line every script prints at the end. */
  summary(): string {
    return `Ledger total: ${usd(this.running)} of the $${HARD_CAP_USD} hard cap (this run ${usd(this.session)}). File: ${this.path}`;
  }
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
