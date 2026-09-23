// A repeatable CPU benchmark for the zombie director: 24 zombies climb out of the ground and chase a
// player circling the mess yard on the real compound, as a Dead Ink round does. Not a check (it asserts
// nothing and is not run by `npm test`); run it before and after a change to the director:
//   node scripts/check-player.mjs scripts/zombies-perf-bench.ts
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CollisionWorld } from '../src/player/collision'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { setDoorOpen } from '../src/world/doors'
import { ZombieDirector, type ZombieTarget } from '../src/game/zombies/director'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { pickSpawn } from '../src/game/zombies/spawn'
import { seeded } from '../src/game/shared/random'

const bytes = readFileSync('public/models/stickman.glb')
GLTFLoader.prototype.loadAsync = async function () {
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
}
Math.random = seeded(7)
const scene = new THREE.Scene()
const compound = createCompound(), mission = createMissionWorld(compound)
prepareCompound(compound)
scene.add(compound, mission.root)
const doors: THREE.Group[] = []
scene.traverse(o => { if (o.userData.kind === 'door') doors.push(o as THREE.Group) })
for (const door of doors) { door.userData.missionLocked = false; setDoorOpen(door, true, true) }
const world = new CollisionWorld(scene)
world.refresh()
const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
const director = new ZombieDirector({ scene, world, doors, graph, emit: () => {}, damagePlayer: () => {} })
director.random = seeded(9)
await director.init(24)

const centre = new THREE.Vector3(-30, 0, -26)
const player: ZombieTarget = { id: 'p1', feet: centre.clone(), alive: true }
const place = (t: number) => {
  player.feet.set(centre.x + Math.cos(t * 0.35) * 6, 0.5, centre.z + Math.sin(t * 0.35) * 6)
  player.feet.y = world.floor(player.feet, 1, 1.5, 0.28)
}
place(0)
graph.flow([player.feet])
const random = seeded(4242)
for (let i = 0; i < 24; i++) {
  const spot = pickSpawn(graph, world, { near: 10, far: 40, eyes: [] }, random)
  if (spot) director.spawn(spot, 1e6, (['walk', 'run', 'sprint'] as const)[i % 3], 0, true)
}
const fps = 60, dt = 1 / fps
let time = 0
const step = () => { time += dt; place(time); director.update(dt, [player]) }
for (let i = 0; i < fps * 3; i++) step()
// ALLOC_PROFILE=1 also samples every allocation (including ones the GC has already collected) and prints the top sites.
const inspector = process.env.ALLOC_PROFILE ? new (await import('node:inspector')).Session() : null
const post = (method: string, params?: object) => new Promise<any>((resolve, reject) => inspector!.post(method, params ?? {}, (error: Error | null, result: unknown) => error ? reject(error) : resolve(result)))
if (inspector) { inspector.connect(); await post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }) }
const samples: number[] = []
let allocated = 0, last = process.memoryUsage().heapUsed
for (let i = 0; i < fps * 10; i++) {
  const start = performance.now()
  step()
  samples.push(performance.now() - start)
  const heap = process.memoryUsage().heapUsed
  if (heap > last) allocated += heap - last
  last = heap
}
if (inspector) {
  const { profile } = await post('HeapProfiler.stopSampling')
  const sites = new Map<string, number>()
  let total = 0
  const walk = (node: any, stack: string[]) => {
    const name = `${node.callFrame.functionName || '(anon)'}:${node.callFrame.lineNumber + 1}`
    const next = [...stack, name]
    if (node.selfSize) { total += node.selfSize; const key = next.slice(-3).reverse().join(' < '); sites.set(key, (sites.get(key) ?? 0) + node.selfSize) }
    for (const child of node.children) walk(child, next)
  }
  walk(profile.head, [])
  console.log([...sites].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${(100 * v / total).toFixed(1).padStart(5)}% ${k}`).join('\n'))
}
samples.sort((a, b) => a - b)
const mean = samples.reduce((a, b) => a + b, 0) / samples.length
console.log(JSON.stringify({ alive: director.aliveCount, meanMs: +mean.toFixed(3), p50: +samples[samples.length >> 1].toFixed(3),
  p95: +samples[Math.floor(samples.length * 0.95)].toFixed(3), allocKBPerUpdate: +(allocated / samples.length / 1024).toFixed(1) }))
