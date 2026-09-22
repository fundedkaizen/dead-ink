import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import type { NavGraph } from './navgraph'
import type { Random } from '../shared/random'

/**
 * Where a zombie appears. Call of Duty spawns them in the zone you are in; here the flow field does
 * that for free, because it is seeded from the players: a spot has a finite walking distance only if
 * it is in a region a player can be reached from. So "somewhere it can walk to you from" and
 * "somewhere in your zone" are the same test, even where the navigation graph is imperfect.
 *
 * Preference order: far enough away, out of sight, on a spot a body fits. If the region is small
 * (you are holed up in one room), the rules relax in steps rather than failing.
 */
export type SpawnRules = { near: number; far: number; eyes: readonly THREE.Vector3[] }

export function pickSpawn(graph: NavGraph, world: CollisionWorld, rules: SpawnRules, random: Random, tries = 320) {
  const point = new THREE.Vector3(), head = new THREE.Vector3()
  const hidden = (p: THREE.Vector3) => {
    head.copy(p).y += 1.5
    return rules.eyes.every(eye => !world.visible(eye, head, IGNORE))
  }
  // Pass 1: the full rules. Pass 2: closer is allowed. Pass 3: being seen is allowed.
  for (const pass of [0, 1, 2]) {
    const near = pass === 0 ? rules.near : rules.near * 0.45
    const far = pass === 0 ? rules.far : rules.far * 1.6
    for (let i = 0; i < tries; i++) {
      const index = Math.floor(random() * graph.size)
      if (!graph.walkable(index)) continue
      const distance = graph.distance(index)
      if (!Number.isFinite(distance) || distance < near || distance > far) continue
      graph.point(index, point)
      if (pass < 2 && !hidden(point)) continue
      return point.clone()
    }
  }
  return null
}

const IGNORE = new THREE.Object3D()
