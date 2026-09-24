import { WEAPON_RULES } from '../balance'
import { rollRarity, weaponRules, type Rarity } from '../loot'
import type { WeaponItem, WeaponName } from '../types'
import type { HitZone } from '../hit-reactions'
import { weighted, type Random } from '../shared/random'
import { POINTS, PRICES, wallAmmoPrice } from './rules'

/**
 * Dead Ink's economy: what a hit is worth, what the walls sell, and what the Mystery Box gives.
 * Pure functions, checked in Node.
 */

/** Points for one hit, Call of Duty style: 10 for a hit that does not kill, more for the kill. */
export function pointsForHit(hit: { lethal: boolean; zone: HitZone; knife?: boolean }, doublePoints = false) {
  const base = !hit.lethal ? POINTS.hit : hit.knife ? POINTS.knifeKill : hit.zone === 'head' ? POINTS.headshotKill : POINTS.kill
  return doublePoints ? base * 2 : base
}

/** Weapons carried at once, as in Call of Duty. A perk (later) raises it to 3. */
export const ZOMBIE_SLOTS = 2
/** Spare magazines that come with a gun from a wall or the box. */
export const RESERVE_MAGAZINES = 4
/** The Ink Rocket carries rockets, not magazines: ten spare, sixteen for the Press Ram. */
export const ROCKET_RESERVE = { fresh: 10, packed: 16 } as const

/**
 * The spare ammo a gun is filled to, from the box or a wall, by the Pack-a-Punch or a Max Ammo: four
 * magazines, twice that upgraded (an upgrade can hold more to a magazine); the Ink Rocket its own count.
 */
export function spareAmmo(item: Pick<WeaponItem, 'name' | 'packed' | 'packLevel' | 'rarity'>) {
  if (item.name === 'rocket') return item.packed ? ROCKET_RESERVE.packed : ROCKET_RESERVE.fresh
  return weaponRules(item).capacity * RESERVE_MAGAZINES * (item.packed ? 2 : 1)
}

export const freshWeapon = (id: string, name: WeaponName, rarity?: Rarity): WeaponItem => {
  const capacity = WEAPON_RULES[name].capacity
  return { id, name, magazine: capacity, reserve: spareAmmo({ name }), ...(rarity ? { rarity } : {}) }
}

/** The starting pistol: Call of Duty starts you with one pistol and two spare magazines' worth more. */
export const startingPistol = (): WeaponItem => ({ id: 'start-pistol', name: 'pistol', magazine: WEAPON_RULES.pistol.capacity, reserve: WEAPON_RULES.pistol.capacity * 4 })

/** Guns on the walls, in the order they are placed outward from the spawn: cheap and close first. */
export const WALL_WEAPONS: { name: WeaponName; price: number }[] = [
  { name: 'smg', price: PRICES.wall.smg },
  { name: 'shotgun', price: PRICES.wall.shotgun },
  { name: 'ak', price: PRICES.wall.ak },
  { name: 'sniper', price: PRICES.wall.sniper },
]

export type WallOffer = { kind: 'buy' | 'ammo'; cost: number; label: string } | { kind: 'full'; cost: 0; label: string }

/**
 * What the wall offers you. Owning the gun, it sells ammo at half price (Call of Duty rule), unless
 * you are already full. Wall guns are always plain grey: colour comes from the box and Pack-a-Punch.
 */
export function wallOffer(name: WeaponName, price: number, slots: readonly (WeaponItem | null)[]): WallOffer {
  const label = WEAPON_RULES[name].label
  const owned = slots.find(item => item?.name === name)
  if (!owned) return { kind: 'buy', cost: price, label: `Buy ${label} · ${price}` }
  const capacity = WEAPON_RULES[name].capacity
  if (owned.magazine >= capacity && owned.reserve >= capacity * RESERVE_MAGAZINES) return { kind: 'full', cost: 0, label: `${label} ammo full` }
  const cost = wallAmmoPrice(price)
  return { kind: 'ammo', cost, label: `${label} ammo · ${cost}` }
}

/**
 * The Mystery Box's weapon table. Snipers and shotguns are the exciting draws; the pistol is the
 * letdown every box has; the Ink Rocket, only ever from the box, the rarest pull. Weights are relative.
 */
export const BOX_WEIGHTS: Record<WeaponName, number> = { ak: 24, smg: 22, shotgun: 22, sniper: 18, pistol: 14, magnum: 12, lmg: 10, rocket: 5 }
/** The chance a box roll is the Ink Ray, Dead Ink's wonder weapon (Call of Duty's Ray Gun is a rare draw too). */
export const RAY_GUN_CHANCE = 0.05
/**
 * The chance an ordinary box roll is Mythic, the tier above gold: about one in a thousand. Drawn on its
 * own after the Ink Ray, so the grey-to-gold odds among the other rolls are exactly the chest odds.
 */
export const MYTHIC_CHANCE = 0.001
/** Seconds the box spins before showing its gun, and how long you have to take it. */
export const BOX_SPIN = 3.2, BOX_OFFER = 12

/**
 * One box roll: never a gun you are already carrying (as in Call of Duty), and a rarity with chest
 * odds, so the box never gives grey; now and then Mythic, never while you already carry one. Falls back
 * to any gun if you somehow hold every one.
 */
export function rollBox(random: Random, held: readonly (WeaponItem | null)[]): { name: WeaponName; rarity: Rarity; special?: 'rayGun' } {
  // The wonder weapon: rare, always gold, never twice.
  if (!held.some(item => item?.special === 'rayGun') && random() < RAY_GUN_CHANCE) return { name: 'pistol', rarity: 'legendary', special: 'rayGun' }
  const mythic = !held.some(item => item?.rarity === 'mythic') && random() < MYTHIC_CHANCE
  const weights = { ...BOX_WEIGHTS }
  for (const item of held) if (item) weights[item.name] = 0
  const pool = Object.values(weights).some(w => w > 0) ? weights : BOX_WEIGHTS
  const name = weighted(random, pool)
  return { name, rarity: mythic ? 'mythic' : rollRarity('chest', random) }
}

