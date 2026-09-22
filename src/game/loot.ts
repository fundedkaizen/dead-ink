import { WEAPON_RULES } from './balance'
import type { WeaponName } from './types'

/**
 * Loot rarity, Fortnite-style: grey, green, blue, purple, gold.
 *
 * Rarity is a MODEST boost, never a win button. A skilled player with a grey gun should still beat
 * an average player with a gold one, otherwise the game turns into a lottery. So rarity only moves
 * damage and reload time; magazine size, fire rate, range and recoil stay the weapon's own.
 *
 * An item with no rarity is exactly today's weapon. The original mission never assigns one, so its
 * behaviour and its checks are unchanged by this module.
 */
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const
export type Rarity = typeof RARITIES[number]

export const RARITY_INFO: Record<Rarity, { label: string; color: number; css: string; damage: number; reload: number; beam: boolean }> = {
  common: { label: 'Common', color: 0x8c8c8c, css: '#8c8c8c', damage: 1.00, reload: 1.00, beam: false },
  uncommon: { label: 'Uncommon', color: 0x3fae49, css: '#3fae49', damage: 1.05, reload: 0.95, beam: true },
  rare: { label: 'Rare', color: 0x2f7fe0, css: '#2f7fe0', damage: 1.10, reload: 0.90, beam: true },
  epic: { label: 'Epic', color: 0x9b4fd6, css: '#9b4fd6', damage: 1.15, reload: 0.85, beam: true },
  legendary: { label: 'Legendary', color: 0xe8a317, css: '#e8a317', damage: 1.20, reload: 0.80, beam: true },
}

/**
 * Where loot comes from decides its odds. Floor loot is mostly grey and green; chests shift the odds
 * up; supply drops are the only reliable source of gold, which is what makes them worth fighting over.
 * Weights are relative, not percentages.
 */
export type LootSource = 'floor' | 'chest' | 'supply'
export const DROP_WEIGHTS: Record<LootSource, Record<Rarity, number>> = {
  floor: { common: 40, uncommon: 30, rare: 20, epic: 8, legendary: 2 },
  chest: { common: 0, uncommon: 35, rare: 38, epic: 20, legendary: 7 },
  supply: { common: 0, uncommon: 0, rare: 0, epic: 60, legendary: 40 },
}

/** `random` returns [0, 1). Pass a seeded generator in checks so results are reproducible. */
export function rollRarity(source: LootSource, random: () => number = Math.random): Rarity {
  const weights = DROP_WEIGHTS[source]
  const total = RARITIES.reduce((sum, rarity) => sum + weights[rarity], 0)
  let pick = random() * total
  for (const rarity of RARITIES) {
    pick -= weights[rarity]
    if (pick < 0) return rarity
  }
  // Floating-point edge: random() infinitesimally below 1 can fall through; return the rarest tier
  // that actually has weight rather than a tier this source can never drop.
  return [...RARITIES].reverse().find(rarity => weights[rarity] > 0)!
}

type Rules = typeof WEAPON_RULES[WeaponName]
/** The weapon table is `as const`, so its fields are exact literals; scaled values need the wide types. */
type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T
export type ScaledRules = { -readonly [K in keyof Rules]: Widen<Rules[K]> }

/**
 * A weapon's stats after rarity. Common, or no rarity at all, returns the base values unchanged,
 * including the label, so existing text and checks see exactly what they always did.
 */
export function weaponRules(item: { name: WeaponName; rarity?: Rarity }): ScaledRules {
  const base = WEAPON_RULES[item.name]
  if (!item.rarity || item.rarity === 'common') return { ...base }
  const info = RARITY_INFO[item.rarity]
  return { ...base, label: `${info.label} ${base.label}`, damage: base.damage * info.damage, reload: base.reload * info.reload }
}

export const rarityOf = (item: { rarity?: Rarity } | null | undefined): Rarity => item?.rarity ?? 'common'
