// The mini map's floor plan (src/game/zombies/minimap.ts), built from the compound as Dead Ink plays it:
// a room for every building, every open doorway a gap, the zone gates left to the live map, the locked exit
// gate drawn, the rail yard's tracks in grey.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { SEALED, ZONE_GATES, ZoneGates, gateSegment } from '../src/game/zombies/zones'
import { setDoorOpen } from '../src/world/doors'
import { floorPlan } from '../src/game/zombies/minimap'
import { buildNavScene } from './nav-scene'

const { scene, world, doors, bounds } = buildNavScene()
for (const door of doors) if (SEALED.some(seal => seal.door === door.name)) { door.userData.missionLocked = true; setDoorOpen(door, false, true) }
world.refresh()
const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
new ZoneGates(scene as THREE.Scene, world, graph).closeAll()
const started = performance.now()
const plan = floorPlan(scene, bounds)
const ms = performance.now() - started

/** How far (x, z) is from the nearest of these segments. */
function gap(segments: Float32Array, x: number, z: number) {
  let best = Infinity
  for (let i = 0; i < segments.length; i += 4) {
    const ax = segments[i], az = segments[i + 1], dx = segments[i + 2] - ax, dz = segments[i + 3] - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z))
  }
  return best
}

assert(plan.walls.length / 4 > 3000 && plan.props.length / 4 > 1000, `the plan has walls and props: ${plan.walls.length / 4}, ${plan.props.length / 4}`)
let buildings = 0
scene.traverse(object => { if (Array.isArray(object.userData.footprint)) buildings++ })
assert.equal(plan.rooms.length / 8, buildings, 'a room for every building with a footprint')

let doorways = 0
for (const door of doors) {
  const at = door.getWorldPosition(new THREE.Vector3())
  if (door.userData.missionLocked || at.y > 1 || at.y < -0.5) continue
  doorways++
  assert(gap(plan.walls, at.x, at.z) > 0.4, `the doorway of ${door.name} is a gap in the walls`)
}
assert(doorways > 20, `ground-floor doorways checked: ${doorways}`)

for (const spec of ZONE_GATES) {
  const [a, b] = gateSegment(spec)
  for (let t = 0.1; t <= 0.9; t += 0.1) {
    const p = a.clone().lerp(b, t)
    assert(gap(plan.walls, p.x, p.z) > 0.2, `the ${spec.id} gate's opening is left to the live map`)
  }
}

for (let z = 8; z <= 14; z++) assert(gap(plan.walls, 164, z) < 0.3, `the locked exit gate is drawn at z ${z}`)

// Standard gauge either side of the line (compound.ts railway at plan y 324), from the yard to the annex.
for (let x = 30; x <= 110; x += 10) for (const side of [-1, 1])
  assert(gap(plan.props, x, -32.4 + side * 0.7175) < 0.15, `a rail at x ${x}`)

console.log(`minimap plan: ${plan.walls.length / 4} wall and ${plan.props.length / 4} prop segments, ${plan.rooms.length / 8} rooms, ${doorways} doorways, ${ms.toFixed(0)} ms`)
