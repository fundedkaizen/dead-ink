import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import { WEAPON_RULES } from '../balance'
import { PACKED, weaponRules } from '../loot'
import type { WeaponItem } from '../types'

/**
 * Dead Ink's explosives go off with a fixed damage at their centre, less toward their edge (the director's
 * falloff: half at the rim), as Call of Duty's do: not scaled with the round, so an early round dies to
 * them and a late one survives at the edges, where a hard hit takes the legs (a crawler). The frag's number
 * is in grenades.ts, the Ink Rocket's in rockets.ts; this file has the Deadline's rounds and what your
 * own blast does to you.
 */

/** How a blast looks and sounds: a frag's (the Ink Doll's and the Ink Ray's too), a rocket's, a Deadline round's. */
export type BlastKind = 'grenade' | 'rocket' | 'round'

/**
 * The Deadline (the Pack-a-Punched Magnum, held akimbo: akimbo.ts) fires explosive rounds, as Mustang &
 * Sally does: each bursts where it strikes, a small splash about a third of a frag's, with gibs and
 * crawlers; fired at your feet, it hurts. `look` is the size its burst is drawn at.
 */
export const DEADLINE_ROUND = { radius: 1.75, damage: 400, selfRadius: 2, selfDamage: 30, look: 1.2 } as const

/** A Deadline round's burst damage: rising with the Pack-a-Punch level and the gun's rarity as its bullets do. */
export function roundDamage(item: Pick<WeaponItem, 'name' | 'rarity' | 'packed' | 'packLevel'>) {
  return DEADLINE_ROUND.damage * weaponRules(item).damage / (WEAPON_RULES.magnum.damage * PACKED.damage[0])
}

/**
 * What your own blast does to you: `damage` point blank, less further out, nothing from `reach` on or with a
 * wall between. Measured to the nearest point of your body, feet to eyes, so a burst at your feet counts.
 */
export function selfBlast(world: CollisionWorld, at: THREE.Vector3, feet: THREE.Vector3, eye: THREE.Vector3, reach: number, damage: number) {
  const body = new THREE.Line3(feet.clone().setY(feet.y + 0.3), eye).closestPointToPoint(at, true, new THREE.Vector3())
  const distance = body.distanceTo(at)
  if (distance >= reach || !world.visible(at, body, new THREE.Object3D())) return 0
  return damage * (1 - distance / reach)
}
