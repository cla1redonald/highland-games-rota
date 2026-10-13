/**
 * List prices in US dollars per million tokens, as the platform documents them for each model (October 2026).
 * Cache writes are 1.25 times input for the five-minute lifetime and twice input for the hour. A model not on this
 * list cannot be priced, and an unpriced call is refused rather than recorded as free.
 */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function rates(input: number, output: number, cacheRead: number): Rates {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

const table: Record<string, Rates> = {
  'claude-sonnet-5-5': rates(2, 10, 0.2),
  'claude-opus-5-5': rates(4, 20, 0.2),
  // Server-side fallback targets: a refused request may be answered by one of these, billed at its own rates.
  'claude-sonnet-5': rates(2, 10, 0.2),
  'claude-opus-5': rates(5, 25, 0.5),
  'claude-opus-4-8': rates(5, 25, 0.5),
};

/** Haiku 5.5 has two tiers: prompts of 100K tokens or fewer, and larger ones. */
const haiku = { small: rates(0.1, 0.5, 0.01), large: rates(0.5, 2.5, 0.05) };
const haikuThreshold = 100_000;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function ratesFor(model: string, promptTokens: number): Rates {
  if (model === 'claude-haiku-5-5') return promptTokens > haikuThreshold ? haiku.large : haiku.small;
  const found = table[model];
  if (!found) throw new Error(`no list price for model "${model}": refusing to record a call that cannot be priced`);
  return found;
}

/** The cost of one response in US dollars. */
export function priceTokens(model: string, tokens: TokenCounts): number {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const r = ratesFor(model, prompt);
  const perToken =
    tokens.input * r.input + tokens.output * r.output + tokens.cacheRead * r.cacheRead + tokens.cacheWrite5m * r.cacheWrite5m + tokens.cacheWrite1h * r.cacheWrite1h;
  return perToken / 1_000_000;
}

export const pricedModels = [...Object.keys(table), 'claude-haiku-5-5'];
