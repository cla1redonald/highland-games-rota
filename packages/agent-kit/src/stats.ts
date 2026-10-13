/** Small statistics for eval reports: never a bare mean without its spread. */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Percentile by linear interpolation between closest ranks. p in [0, 100]. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (rank - low);
}

/** Sample standard deviation. */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}

export interface Distribution {
  n: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

export function distribution(xs: number[]): Distribution {
  return { n: xs.length, median: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : 0, mean: mean(xs) };
}
