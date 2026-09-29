// Every place the rescue campaign names on the compound, walked against the real collision world: spawns and
// the hostage's cells stand on free floor, panels and locks can be reached, guard and dog patrols are on the
// guards' navigation floor, helicopter landing zones are clear, boosts land on floor, and every mission only
// names anchors its map has.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { buildNavScene } from './nav-scene'
import { EnemyNavigation } from '../src/game/navigation'
import { COMPOUND_MAP } from '../src/game/campaign/maps/compound'
import { MISSIONS, mapFor } from '../src/game/campaign/missions'
import type { Vec3 } from '../src/game/types'

const { world, doors } = buildNavScene()
const navigation = new EnemyNavigation(world, doors, () => {})
const map = COMPOUND_MAP
const failures: string[] = []
const v = (p: Vec3) => new THREE.Vector3(...p)
const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.28)

function standing(label: string, p: Vec3, tolerance = 0.45) {
  const floor = world.floor(new THREE.Vector3(p[0], p[1] + 0.6, p[2]), 1, 2)
  if (!Number.isFinite(floor) || Math.abs(floor - p[1]) > tolerance) { failures.push(`${label}: no floor near ${p} (found ${floor})`); return }
  capsule.start.set(p[0], floor + 0.3, p[2]); capsule.end.set(p[0], floor + 1.55, p[2])
  if (!world.fits(capsule)) failures.push(`${label}: blocked at ${p}`)
}
function walkable(label: string, p: Vec3) {
  if (!navigation.floor(v(p))) failures.push(`${label}: not on the navigation floor at ${p}`)
}

for (const spawn of Object.values(map.spawns)) standing(`spawn ${spawn.id}`, spawn.position)
for (const cell of Object.values(map.cells)) {
  standing(`cell ${cell.id} hostage`, cell.hostage)
  if (!cell.station) standing(`cell ${cell.id} lock`, cell.lock.position, 0.6)
}
for (const panel of Object.values(map.panels)) standing(`panel ${panel.id}`, panel.position, 0.6)
for (const boost of Object.values(map.boosts)) { standing(`boost ${boost.id} from`, boost.from); standing(`boost ${boost.id} to`, boost.to) }
for (const extraction of Object.values(map.extractions)) {
  standing(`extraction ${extraction.id} board`, extraction.board)
  if (extraction.call) standing(`extraction ${extraction.id} radio`, extraction.call.position, 0.6)
  if (extraction.kind === 'helicopter') {
    const clear = new Capsule(new THREE.Vector3(extraction.park[0], 6.5, extraction.park[2]), new THREE.Vector3(extraction.park[0], 8, extraction.park[2]), 6)
    if (!world.fits(clear)) failures.push(`extraction ${extraction.id}: landing zone not clear`)
  }
}
for (const guard of Object.values(map.guards)) {
  if (guard.role === 'sniper') { standing(`sniper ${guard.id}`, guard.position, 0.5); continue }
  for (const route of [guard.patrol, ...(guard.routes ?? [])]) route.forEach((point, i) => walkable(`guard ${guard.id} point ${i}`, point))
}
for (const dog of Object.values(map.dogs)) dog.route.forEach((point, i) => walkable(`dog ${dog.id} point ${i}`, point))
for (const zone of Object.values(map.zones)) assert(zone.r > 0)

const doorNames = new Set(doors.map(door => door.name))
for (const cell of Object.values(map.cells)) if (cell.door && !doorNames.has(cell.door)) failures.push(`cell ${cell.id}: no door named ${cell.door}`)
for (const mission of MISSIONS) {
  const m = mapFor(mission)
  const need = (kind: string, table: Record<string, unknown>, ids: string[]) => ids.forEach(id => { if (!table[id]) failures.push(`${mission.id}: unknown ${kind} ${id}`) })
  need('spawn', m.spawns, mission.spawns); need('cell', m.cells, mission.cells); need('extraction', m.extractions, [mission.extraction])
  need('camera', m.cameras, mission.cameras); need('panel', m.panels, mission.panels); need('boost', m.boosts, mission.boosts)
  need('guard', m.guards, mission.guards.filter(id => id !== 'world')); need('dog', m.dogs, mission.dogs)
  need('keycard spot', m.panels, mission.keycards.flatMap(card => card.at))
  for (const locked of mission.lockedDoors) if (!doorNames.has(locked.door)) failures.push(`${mission.id}: no door named ${locked.door}`)
  for (const door of mission.alarmLocks) if (!doorNames.has(door)) failures.push(`${mission.id}: no alarm door named ${door}`)
  for (const stage of mission.stages) for (const objective of stage.objectives) {
    if (objective.zone && !m.zones[objective.zone]) failures.push(`${mission.id}: objective ${objective.id} names zone ${objective.zone}`)
    for (const panel of objective.panels ?? []) if (!m.panels[panel] && !['security-computer', 'signals-office-computer'].includes(panel)) failures.push(`${mission.id}: objective ${objective.id} names panel ${panel}`)
  }
  assert(mission.hostages <= mission.cells.length, `${mission.id} has fewer cells than hostages`)
}

if (failures.length) { console.log(failures.join('\n')); assert.fail(`${failures.length} campaign anchors are not where they can be used`) }
console.log(`PASS every campaign anchor on the compound stands on usable floor (${Object.keys(map.guards).length} guards, ${Object.keys(map.dogs).length} dogs, ${Object.keys(map.cells).length} cells)`)
