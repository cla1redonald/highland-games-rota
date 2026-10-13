import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARD_CAP_USD, Ledger, priceTokens, tokenCounts, type LedgerEntry } from '@ghillie/ledger';

class Stopped extends Error {}
const stop = (message: string): never => {
  throw new Stopped(message);
};
const quiet = (): void => undefined;
const fresh = (): string => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'spend.jsonl');
const meta = { impl: 'test', label: 'case' };

describe('prices', () => {
  it('prices each of the five token kinds at the model list rate', () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 five-minute write, $4 hour write, per million.
    const cost = priceTokens('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 });
    expect(cost).toBeCloseTo(2 + 10 + 0.2 + 2.5 + 4, 6);
    expect(priceTokens('claude-opus-5-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeCloseTo(4, 6);
  });

  it('prices Haiku 5.5 by the size of the prompt', () => {
    const small = priceTokens('claude-haiku-5-5', { input: 100_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    const large = priceTokens('claude-haiku-5-5', { input: 100_001, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(small).toBeCloseTo(0.01, 6);
    expect(large).toBeCloseTo(0.0500005, 6);
  });

  it('refuses to price a model it does not know rather than calling it free', () => {
    expect(() => priceTokens('some-other-model', { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toThrow(/no list price/);
  });

  it('splits cache writes by lifetime when the response says so', () => {
    expect(tokenCounts({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 10 } })).toEqual({
      input: 5,
      output: 7,
      cacheRead: 11,
      cacheWrite5m: 20,
      cacheWrite1h: 10,
    });
  });
});

describe('the ledger', () => {
  it('appends every response with its model, token counts and a running total, across processes', () => {
    const path = fresh();
    const first = new Ledger({ path, stop, print: quiet });
    first.record('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }, meta);
    const second = new Ledger({ path, stop, print: quiet });
    expect(second.total).toBeCloseTo(first.total, 9);
    second.record('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500 }, meta);
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerEntry);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ model: 'claude-sonnet-5-5', input: 1000, output: 500, cacheRead: 2000, impl: 'test', label: 'case', basis: 'usage' });
    expect(lines[1]!.totalUsd).toBeCloseTo(lines[0]!.usd + lines[1]!.usd, 6);
  });

  it('prices each hop of a server-side fallback at the model that served it', () => {
    const path = fresh();
    const ledger = new Ledger({ path, stop, print: quiet });
    const entries = ledger.record(
      'claude-sonnet-5-5',
      {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [
          { type: 'message', input_tokens: 1000, output_tokens: 10 },
          { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 300 },
        ],
      },
      meta,
    );
    expect(entries.map((e) => e.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5']);
  });

  it(`stops the process when the running total passes the hard cap of $${HARD_CAP_USD}`, () => {
    const path = fresh();
    writeFileSync(path, `${JSON.stringify({ usd: HARD_CAP_USD - 0.01, totalUsd: HARD_CAP_USD - 0.01 })}\n`);
    const ledger = new Ledger({ path, stop, print: quiet });
    expect(() => ledger.assertUnderCap()).not.toThrow();
    // A million output tokens on Sonnet is $10: well past the cap.
    expect(() => ledger.record('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 1_000_000 }, meta)).toThrow(Stopped);
    // The call that crossed the cap is still written down, and the next call is refused before it starts.
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(() => new Ledger({ path, stop, print: quiet }).assertUnderCap()).toThrow(/over the hard cap/);
  });

  it('records a platform list cost as given', () => {
    const ledger = new Ledger({ path: fresh(), stop, print: quiet });
    const entry = ledger.recordListCost('claude-sonnet-5-5', 0.42, { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 0, cacheWrite1h: 0 }, meta);
    expect(entry).toMatchObject({ usd: 0.42, basis: 'list_cost' });
    expect(ledger.summary()).toMatch(new RegExp(`^Ledger total: \\$0\\.4200 of the \\$${HARD_CAP_USD} hard cap`));
  });
});
