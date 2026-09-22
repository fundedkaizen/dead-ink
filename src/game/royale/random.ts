/**
 * Seeded random numbers for the battle royale. A match is fully described by its seed, so loot,
 * spawns and the storm path can be reproduced exactly in checks and when chasing a bug.
 */
export type Random = () => number

/** mulberry32: small, fast, and good enough for gameplay; returns [0, 1). */
export function seeded(seed: number): Random {
  let state = seed | 0
  return () => {
    state = state + 0x6D2B79F5 | 0
    let t = Math.imul(state ^ state >>> 15, 1 | state)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

export const between = (random: Random, min: number, max: number) => min + random() * (max - min)

/** Weighted choice over an object of non-negative weights. */
export function weighted<K extends string>(random: Random, weights: Record<K, number>): K {
  const keys = Object.keys(weights) as K[]
  const total = keys.reduce((sum, key) => sum + weights[key], 0)
  let pick = random() * total
  for (const key of keys) {
    pick -= weights[key]
    if (pick < 0) return key
  }
  return [...keys].reverse().find(key => weights[key] > 0)!
}

/** Fisher-Yates on a copy. */
export function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
