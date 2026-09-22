import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { CollisionWorld } from '../src/player/collision'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { findLootSpots, rollMatchLoot, standingPoint } from '../src/game/royale/loot-spawn'
import { seeded } from '../src/game/royale/random'
import { RARITIES } from '../src/game/loot'

// The real compound, built exactly as the game builds it.
const scene = new THREE.Scene()
const compound = createCompound()
const mission = createMissionWorld(compound)
prepareCompound(compound)
scene.add(compound, mission.root)
const world = new CollisionWorld(scene)
const seeds = mission.enemies.flatMap(e => [e.position, ...e.patrol])

const COUNT = 90
const spots = findLootSpots(world, mission.bounds, seeded(2026), { count: COUNT, seeds })
assert(spots.length >= COUNT * 0.9, `placed ${spots.length} of ${COUNT} loot spots`)

const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.3)
for (const [x, y, z] of spots) {
  // Inside the playable arena.
  const b = mission.bounds
  assert(x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ, `spot ${x},${z} is outside the arena`)
  // Floor directly under it, not floating and not buried.
  const floor = world.floor(new THREE.Vector3(x, y + 0.3, z), 0.5, 1.0, 0.25)
  assert(Number.isFinite(floor) && Math.abs(floor - y) < 0.1, `spot ${x.toFixed(1)},${y.toFixed(2)},${z.toFixed(1)} has no floor under it`)
  // A player body fits: the loot is reachable, not inside a wall.
  capsule.start.set(x, y + 0.3, z); capsule.end.set(x, y + 1.74 - 0.3, z)
  assert(world.fits(capsule), `spot ${x.toFixed(1)},${z.toFixed(1)} is inside geometry`)
}
// Spread out.
for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
  const [ax, ay, az] = spots[i], [bx, by, bz] = spots[j]
  assert(Math.hypot(ax - bx, az - bz) >= 7 - 1e-6 || Math.abs(ay - by) > 2.5, `spots ${i} and ${j} are piled together`)
}
// Coverage: not all bunched in one corner of the map.
const xs = spots.map(s => s[0]), zs = spots.map(s => s[2])
assert(Math.max(...xs) - Math.min(...xs) > 200 && Math.max(...zs) - Math.min(...zs) > 100, 'loot covers the whole compound')
const upstairs = spots.filter(s => s[1] > 1.5).length

// A standing point is really rejected inside solid geometry: probe the middle of every wall-like
// collider would be fragile, so probe far below the ground instead, where nothing can stand.
assert.equal(standingPoint(world, 0, -40, 0), null, 'nothing stands in the void under the map')

// Loot contents.
const loot = rollMatchLoot(spots, seeded(99))
assert.equal(loot.length, spots.length)
assert.equal(new Set(loot.map(l => l.id)).size, loot.length, 'loot ids are unique')
for (const item of loot) {
  assert(item.rarity && RARITIES.includes(item.rarity))
  assert(item.magazine > 0 && item.reserve >= item.magazine, `${item.id} comes with ammunition`)
}
// Determinism: the same seed lays out the same match.
assert.deepEqual(findLootSpots(world, mission.bounds, seeded(2026), { count: COUNT, seeds }), spots)

const rarityCount = Object.fromEntries(RARITIES.map(r => [r, loot.filter(l => l.rarity === r).length]))
console.log(`royale loot checks passed: ${spots.length} spots (${upstairs} upstairs), rarities ${JSON.stringify(rarityCount)}`)
world.dispose()
