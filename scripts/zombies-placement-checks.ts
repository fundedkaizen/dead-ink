import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { SEALED, ZoneGates } from '../src/game/zombies/zones'
import { setDoorOpen } from '../src/world/doors'
import { MACHINE_PLACES, PackAPunch, PerkMachine } from '../src/game/zombies/perks'
import { BENCH_PLACE, BuildSite, POWER_PLACE, PowerSwitch } from '../src/game/zombies/buildables'
import { MysteryBox } from '../src/game/zombies/stations'
import { findWallSpots, type WallSize, type WallSpot } from '../src/game/zombies/placement'
import type { CollisionWorld } from '../src/player/collision'
import { seeded } from '../src/game/shared/random'
import { buildNavScene } from './nav-scene'

// Big wall things (perk machines, the Pack-a-Punch and its sign, the power switch and its conduit, the
// shield bench, the Mystery Box) each get a wall where their whole block fits: no side wall, corner or
// door frame inside their width, nothing overhead below their top, one flat face behind them. Placed as
// the runtime places them, every zone gate shut.
const { scene, world, doors } = buildNavScene()
for (const door of doors) if (SEALED.some(seal => seal.door === door.name)) { setDoorOpen(door, false, true); door.userData.missionLocked = true }
world.refresh()
const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
const zones = new ZoneGates(scene as THREE.Scene, world, graph)
zones.closeAll()
const v = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2])

/**
 * Everything wrong with a block on its wall, probed more densely than the placement code does (so the
 * check does not merely repeat it): rays at the face every 6 cm across and 15 cm up; rays along the wall
 * from the middle out to each side at four depths; rays straight up across the whole footprint.
 */
function problems(world: CollisionWorld, spot: WallSpot, size: WallSize) {
  const n = spot.normal, t = new THREE.Vector3(n.z, 0, -n.x), into = n.clone().negate(), up = new THREE.Vector3(0, 1, 0)
  const at = (along: number, height: number, out: number) => spot.wall.clone().addScaledVector(t, along).addScaledVector(n, out).setY(spot.stand.y + height)
  const found: string[] = [], face = size.face ?? size.top, low = Math.max(0.3, size.bottom ?? 0)
  const out = size.depth + 0.1
  for (let a = -size.halfWidth; a <= size.halfWidth + 1e-9; a += 0.06) for (let h = low; h <= size.top - 0.03; h += 0.15) {
    const hit = world.raySurface(at(a, h, out), into, out + 0.3)
    if (h <= face ? !(hit && Math.abs(hit.distance - out) < 0.08) : !!hit && hit.distance < out - 0.08) found.push(`face at ${a.toFixed(2)}, ${h.toFixed(2)}`)
  }
  for (const side of [-1, 1]) for (const z of [0.07, 0.15, size.depth / 2, size.depth]) for (let h = low; h <= size.top - 0.03; h += 0.2)
    if (world.raySurface(at(0, h, z), t.clone().multiplyScalar(side), size.halfWidth)) found.push(`${side < 0 ? 'left' : 'right'} side at ${z.toFixed(2)} out, ${h.toFixed(2)} up`)
  for (let a = -size.halfWidth; a <= size.halfWidth + 1e-9; a += 0.2) for (const z of [0.07, size.depth / 2, size.depth])
    if (world.raySurface(at(a, 1, z), up, size.top - 1)) found.push(`overhead at ${a.toFixed(2)}, ${z.toFixed(2)} out`)
  return found
}

const things: [string, readonly number[], WallSize][] = [
  ...MACHINE_PLACES.map(([kind, place]): [string, readonly number[], WallSize] => [kind, place, kind === 'pack' ? PackAPunch.SIZE : PerkMachine.SIZE]),
  ['power switch', POWER_PLACE, PowerSwitch.SIZE], ['shield bench', BENCH_PLACE, BuildSite.BENCH],
  ['Mystery Box', [-60, 0, 45], MysteryBox.SIZE], ['Mystery Box', [0, 0, 40], MysteryBox.SIZE], ['Mystery Box', [145, 0, 5], MysteryBox.SIZE],
]
const report: string[] = []
for (const [name, place, size] of things) {
  graph.flow([v(place)])
  const spots = findWallSpots(graph, world, seeded(11), { count: 3, near: 0, far: 35, spacing: 7, size })
  assert(spots.length > 0, `a wall that fits the ${name} near ${place[0]}, ${place[2]}`)
  for (const spot of spots) {
    assert(Number.isFinite(graph.distance(graph.nearest(spot.stand))), `the ${name} stands in the zone of its place`)
    const wrong = problems(world, spot, size)
    assert.equal(wrong.length, 0, `the ${name} at ${spot.wall.x.toFixed(1)}, ${spot.wall.z.toFixed(1)} fits its wall: ${wrong.slice(0, 4).join('; ')}`)
  }
  report.push(`${name} ${spots[0].wall.x.toFixed(0)},${spots[0].wall.z.toFixed(0)}`)
}

// The probe has teeth: the sheet-only check used to put the Pack-a-Punch where its block met a side wall
// or a corner (the owner's screenshot), and the probe says so.
const [kind, pack] = MACHINE_PLACES.find(([k]) => k === 'pack')!
graph.flow([v(pack)])
const old = findWallSpots(graph, world, seeded(11), { count: 12, near: 0, far: 35, spacing: 1.5 })
assert(old.some(spot => problems(world, spot, PackAPunch.SIZE).length), `some ${kind} walls the sheet-only check picks are too small for it`)

console.log(`zombies placement checks passed: ${report.join('; ')}`)
zones.dispose()
world.dispose()
