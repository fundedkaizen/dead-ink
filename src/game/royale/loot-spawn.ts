import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import type { CollisionWorld } from '../../player/collision'
import { WEAPON_RULES } from '../balance'
import { rollRarity, type LootSource } from '../loot'
import type { Vec3, WeaponItem, WeaponName } from '../types'
import { between, shuffled, weighted, type Random } from './random'
import type { Arena } from './storm'

/** Which gun a floor spot holds. Snipers are scarcer so long-range fights stay a choice, not the default. */
export const WEAPON_WEIGHTS: Record<WeaponName, number> = { ak: 24, smg: 24, pistol: 20, shotgun: 20, sniper: 12 }
/** Share of spots that roll with chest odds (better rarity). */
export const CHEST_SHARE = 0.15

const BODY_RADIUS = 0.3, BODY_HEIGHT = 1.74

/**
 * Where a player could actually stand: a floor exists under the point and a full body capsule fits
 * there. Returns the standing point, or null. Loot can therefore never spawn inside a wall, under the
 * map, or in mid-air.
 */
export function standingPoint(world: CollisionWorld, x: number, y: number, z: number, capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), BODY_RADIUS)) {
  const height = world.floor(new THREE.Vector3(x, y, z), 1.0, 1.5, BODY_RADIUS * 0.95)
  if (!Number.isFinite(height)) return null
  const feet = new THREE.Vector3(x, height + 0.024, z)
  capsule.start.copy(feet).y += BODY_RADIUS
  capsule.end.copy(feet).y += BODY_HEIGHT - BODY_RADIUS
  return world.fits(capsule) ? feet : null
}

/**
 * Spread loot spots over the arena. `seeds` are points known to be reachable (the guards' patrol
 * routes, which include upper floors); random ground samples fill in the gaps. Spots keep `spacing`
 * metres apart so loot is spread out rather than piled up.
 */
export function findLootSpots(world: CollisionWorld, arena: Arena, random: Random,
  options: { count: number; spacing?: number; seeds?: Vec3[]; attempts?: number }): Vec3[] {
  const spacing = options.spacing ?? 7, attempts = options.attempts ?? options.count * 60
  const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), BODY_RADIUS)
  const spots: THREE.Vector3[] = []
  const farEnough = (p: THREE.Vector3) => spots.every(s => Math.hypot(s.x - p.x, s.z - p.z) >= spacing || Math.abs(s.y - p.y) > 2.5)
  const consider = (x: number, y: number, z: number) => {
    if (spots.length >= options.count) return
    const p = standingPoint(world, x, y, z, capsule)
    if (p && farEnough(p)) spots.push(p)
  }
  for (const [x, y, z] of shuffled(random, options.seeds ?? [])) consider(x, y + 0.5, z)
  for (let i = 0; i < attempts && spots.length < options.count; i++)
    consider(between(random, arena.minX, arena.maxX), 0.5, between(random, arena.minZ, arena.maxZ))
  return spots.map(p => p.toArray() as Vec3)
}

/** One piece of loot: a gun, its rarity, a full magazine and one or two magazines in reserve. */
export function rollLootItem(id: string, position: Vec3, random: Random, source: LootSource = 'floor'): WeaponItem {
  const name = weighted(random, WEAPON_WEIGHTS)
  const capacity = WEAPON_RULES[name].capacity
  return { id, name, rarity: rollRarity(source, random), magazine: capacity, reserve: capacity * (1 + Math.floor(random() * 2)), position: [...position] }
}

/** Loot for a whole match: roughly one spot in seven rolls with chest odds. */
export function rollMatchLoot(spots: Vec3[], random: Random): WeaponItem[] {
  return spots.map((spot, i) => rollLootItem(`loot-${i + 1}`, spot, random, random() < CHEST_SHARE ? 'chest' : 'floor'))
}
