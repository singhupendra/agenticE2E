/** SPEC-012 FR-6: deterministic journey-level sharding. */
export interface Shard {
  current: number;
  total: number;
}

export function parseShard(s: string): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(s.trim());
  const current = m ? Number(m[1]) : NaN,
    total = m ? Number(m[2]) : NaN;
  if (!m || total < 1 || current < 1 || current > total)
    throw new Error(`Invalid shard "${s}": expected "i/n" with 1 <= i <= n, e.g. 1/4`);
  return { current, total };
}

/** Sorted ids split into `total` contiguous chunks (first chunks get the remainder); returns chunk `current`. */
export function applyShard(ids: string[], shard: Shard): string[] {
  const sorted = [...ids].sort();
  const base = Math.floor(sorted.length / shard.total),
    extra = sorted.length % shard.total;
  const i = shard.current - 1;
  const start = i * base + Math.min(i, extra);
  return sorted.slice(start, start + base + (i < extra ? 1 : 0));
}
