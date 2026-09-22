import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { SEALED, ZONE_GATES, ZoneGates } from '../src/game/zombies/zones'
import { setDoorOpen } from '../src/world/doors'
import { buildNavScene } from './nav-scene'

// The compound as Dead Ink plays it, with the zone gates and fence: every zone is sealed except
// through its gates, for the player (colliders) and the zombies (the navigation graph).
const { scene, world, doors } = buildNavScene()
// Dead Ink keeps the secure exit gate shut, as the runtime does.
for (const door of doors) if (SEALED.some(seal => seal.door === door.name)) { setDoorOpen(door, false, true); door.userData.missionLocked = true }
world.refresh()
const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
const zones = new ZoneGates(scene as THREE.Scene, world, graph)
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const spawn = v(-30, 0, -25)
const places = {
  'mess yard': v(-30, 0, -25), 'water tower deck': v(10.9, 12.6, -30), 'observation tower deck': v(-50.4, 6.8, 16.5),
  'southwest stores': v(-57, 0.7, 64), 'southwest yard': v(-40, 0, 40),
  'warehouse': v(25.5, 0.7, -6), 'warehouse yard': v(20, 0, 20), 'south barracks': v(30, 0, 44),
  'rail yard': v(60, 0, -21), 'east annex': v(120, 0, 0),
} as const
type Place = keyof typeof places
const reachable = () => {
  graph.flow([spawn])
  const out = new Set<Place>()
  for (const [name, p] of Object.entries(places) as [Place, THREE.Vector3][]) if (Number.isFinite(graph.distance(graph.nearest(p)))) out.add(name)
  return out
}
const expect = (label: string, open: Place[]) => {
  const got = reachable()
  for (const name of Object.keys(places) as Place[]) {
    const want = open.includes(name)
    assert.equal(got.has(name), want, `${label}: ${name} should be ${want ? 'reachable' : 'shut off'}`)
  }
}
// With every gate open the whole compound is one place.
expect('before any gate is shut', Object.keys(places) as Place[])
zones.closeAll()
const start: Place[] = ['mess yard', 'water tower deck', 'observation tower deck']
expect('all gates shut', start)
const byId = (id: string) => zones.gates.find(g => g.spec.id === id)!
// A closed gate blocks a body; an open one does not.
const body = (p: THREE.Vector3) => new Capsule(p.clone().setY(0.35), p.clone().setY(1.45), 0.3)
for (const g of zones.gates) {
  const centre = v(g.spec.centre[0], 0, g.spec.centre[1])
  assert.equal(world.fits(body(centre)), false, `${g.spec.id}: the shut gate blocks a body`)
}
zones.open(byId('southwest'))
expect('southwest gate open', [...start, 'southwest stores', 'southwest yard'])
const southwestCentre = v(...byId('southwest').spec.centre.flatMap((n, i) => i ? [0, n] : [n]) as [number, number, number])
assert.equal(world.fits(body(southwestCentre)), true, 'the opened gate lets a body through')
zones.open(byId('warehouse'))
expect('warehouse gate open too', [...start, 'southwest stores', 'southwest yard', 'warehouse', 'warehouse yard', 'south barracks'])
zones.open(byId('rail'))
expect('rail gate open too', [...start, 'southwest stores', 'southwest yard', 'warehouse', 'warehouse yard', 'south barracks', 'rail yard'])
zones.open(byId('annex'))
expect('everything open', Object.keys(places) as Place[])
// The other ways in: through the southwest and the new yards gate; round by the rail entrance.
for (const g of zones.gates) zones.open(g)
zones.update(5)
zones.closeAll()
zones.open(byId('southwest')); zones.open(byId('yards'))
expect('into the warehouse yard from the southwest', [...start, 'southwest stores', 'southwest yard', 'warehouse', 'warehouse yard', 'south barracks'])
zones.open(byId('rail')); zones.open(byId('railEntrance'))
expect('into the annex by the rail entrance', Object.keys(places) as Place[])
console.log(`zombies zones checks passed: ${ZONE_GATES.length} gates seal ${Object.keys(places).length - start.length} places behind them`)
zones.dispose()
world.dispose()
