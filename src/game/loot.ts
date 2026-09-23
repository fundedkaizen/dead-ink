import { WEAPON_RULES } from './balance'
import type { WeaponName } from './types'

/**
 * Loot rarity, Fortnite-style: grey, green, blue, purple, gold. Above gold, Dead Ink's Mythic: magenta,
 * a colour nothing else uses, and only ever from the Mystery Box (about one roll in a thousand).
 *
 * Rarity is a MODEST boost, never a win button. A skilled player with a grey gun should still beat
 * an average player with a gold one, otherwise the game turns into a lottery. So rarity only moves
 * damage and reload time; magazine size, fire rate, range and recoil stay the weapon's own.
 *
 * An item with no rarity is exactly today's weapon. The original mission never assigns one, so its
 * behaviour and its checks are unchanged by this module.
 */
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const
export type Rarity = typeof RARITIES[number]

export const RARITY_INFO: Record<Rarity, { label: string; color: number; css: string; damage: number; reload: number; beam: boolean }> = {
  common: { label: 'Common', color: 0x8c8c8c, css: '#8c8c8c', damage: 1.00, reload: 1.00, beam: false },
  uncommon: { label: 'Uncommon', color: 0x3fae49, css: '#3fae49', damage: 1.05, reload: 0.95, beam: true },
  rare: { label: 'Rare', color: 0x2f7fe0, css: '#2f7fe0', damage: 1.10, reload: 0.90, beam: true },
  epic: { label: 'Epic', color: 0x9b4fd6, css: '#9b4fd6', damage: 1.15, reload: 0.85, beam: true },
  legendary: { label: 'Legendary', color: 0xe8a317, css: '#e8a317', damage: 1.20, reload: 0.80, beam: true },
  // Half as much again as gold's bonus, and no more: +30% damage, 25% quicker reload.
  mythic: { label: 'Mythic', color: 0xe0268f, css: '#e0268f', damage: 1.30, reload: 0.75, beam: true },
}

/**
 * Where loot comes from decides its odds. Floor loot is mostly grey and green; chests shift the odds
 * up; supply drops are the only reliable source of gold, which is what makes them worth fighting over.
 * Weights are relative, not percentages. Mythic never drops from the ground, a chest or a supply drop.
 */
export type LootSource = 'floor' | 'chest' | 'supply'
export const DROP_WEIGHTS: Record<LootSource, Record<Rarity, number>> = {
  floor: { common: 40, uncommon: 30, rare: 20, epic: 8, legendary: 2, mythic: 0 },
  chest: { common: 0, uncommon: 35, rare: 38, epic: 20, legendary: 7, mythic: 0 },
  supply: { common: 0, uncommon: 0, rare: 0, epic: 60, legendary: 40, mythic: 0 },
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
/**
 * Dead Ink's Death Machine power-up, a minigun on the AK's handling: about 1,100 rounds a minute, and
 * each round nearly always kills (as in Call of Duty) until the late rounds; almost no kick. Tuned by play.
 */
export const DEATH_MACHINE = { interval: 0.055, damage: 20, kick: 0.005, settle: 0.4 } as const

/**
 * Dead Ink's Pack-a-Punch: an upgraded gun hits twice as hard and gets its own name, as upgraded guns do
 * in Call of Duty. Names are the ink's own.
 */
export const PACKED = { damage: [2, 3.2, 4.8] } as const
/**
 * Bodies a bullet passes through (Dead Ink). A sniper round goes through a line of them; an upgraded
 * gun's rounds go through one more (two more for the sniper); the Death Machine through two.
 */
export function pierceOf(item: { name: WeaponName; special?: string; packLevel?: number; packed?: boolean }) {
  if (item.special === 'deathMachine') return 2
  const level = item.packLevel ?? (item.packed ? 1 : 0)
  const base = item.name === 'sniper' ? 3 : item.name === 'magnum' || item.name === 'lmg' ? 2 : 1
  return base + (level > 0 ? (item.name === 'sniper' ? 2 : 1) : 0)
}
export const PACKED_NAMES: Record<WeaponName, string> = { pistol: 'Fountain Pen', smg: 'Inkjet', ak: 'Blotter', shotgun: 'Splatter', sniper: 'Quill',
  magnum: 'Deadline', lmg: 'Printing Press' }

export function weaponRules(item: { name: WeaponName; rarity?: Rarity; special?: 'deathMachine' | 'rayGun'; packed?: boolean; packLevel?: number }): ScaledRules {
  const base = WEAPON_RULES[item.name]
  // The Ink Ray's bolts do their damage by bursting (the runtime's blast), so its rules are its handling.
  if (item.special === 'rayGun') return { ...base, label: 'Ink Ray', interval: 0.3, kick: 0.02, settle: 0.5, range: 120 }
  if (item.special === 'deathMachine') return { ...base, label: 'Death Machine', automatic: true,
    interval: DEATH_MACHINE.interval, damage: base.damage * DEATH_MACHINE.damage, kick: DEATH_MACHINE.kick, settle: DEATH_MACHINE.settle }
  const rules: ScaledRules = { ...base }
  if (item.rarity && item.rarity !== 'common') {
    const info = RARITY_INFO[item.rarity]
    rules.label = `${info.label} ${base.label}`; rules.damage *= info.damage; rules.reload *= info.reload
  }
  if (item.packed) {
    const level = Math.max(1, Math.min(3, item.packLevel ?? 1))
    rules.label = `${PACKED_NAMES[item.name]}${level > 1 ? ` ${'I'.repeat(level)}` : ''}`
    rules.damage *= PACKED.damage[level - 1]
  }
  return rules
}

export const rarityOf = (item: { rarity?: Rarity } | null | undefined): Rarity => item?.rarity ?? 'common'
