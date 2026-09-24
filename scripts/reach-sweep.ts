// The zombie reach sweep: every place a PLAYER can stand, found from the player's side (their own
// capsule, step, jump, ladder and zip line rules), then checked from the zombies' side (the navigation
// graph and the real director). Shared by the fast regression check (zombies-reach-sweep-checks.ts) and
// the full sweep that writes its report to artifacts/ (zombies-reach-sweep.ts).
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { CollisionWorld } from '../src/player/collision'
import { EnemyNavigation } from '../src/game/navigation'
import { ATTACK, ZombieDirector, spotInReach, type Zombie, type ZombieGait, type ZombieTarget } from '../src/game/zombies/director'
import { NavGraph, geometryHash, type NavData } from '../src/game/zombies/navgraph'
import { pickSpawn } from '../src/game/zombies/spawn'
import { SEALED, ZoneGates } from '../src/game/zombies/zones'
import { setDoorOpen, updateDoors } from '../src/world/doors'
import type { Random } from '../src/game/shared/random'
import { buildNavScene } from './nav-scene'

// The player's body and moves (src/player/body.ts, src/player/actions.ts).
export const PLAYER = { radius: 0.28, height: 1.8, step: 0.34, jumpSpeed: 7, gravity: 22, sprint: 7.6, reach: 2.3 } as const
/** Highest ledge a standing jump lands on: the apex is jumpSpeed² / 2g = 1.11 m, less a margin for the lip. */
const JUMP_UP = 1.05
const TOP = 30, BOTTOM = -12, LEVELS = 6

export type Move = 'start' | 'walk' | 'jump' | 'ladder' | 'drop' | 'zip' | 'leap'
const MOVES: Move[] = ['start', 'walk', 'jump', 'ladder', 'drop', 'zip', 'leap']
/** A place the player can stand, how they first got there, and whether they can walk back out again. */
export type Standing = { x: number; y: number; z: number; move: Move; oneWay: boolean }

export type ReachOptions = {
  /** Lattice spacing in metres. */
  step?: number
  /** Only explore inside this flat box (the fast check). */
  region?: { minX: number; maxX: number; minZ: number; maxZ: number }
  /** Running jumps across gaps: slow, so the fast check leaves them out. */
  leaps?: boolean
}

/** Ladders and zip lines, from the scene exactly as PlayerActions reads them. */
export type Traversals = { ladders: { bottom: THREE.Vector3; top: THREE.Vector3 }[]; zips: { start: THREE.Vector3; end: THREE.Vector3 }[] }

export function traversals(scene: THREE.Object3D, world: CollisionWorld): Traversals {
  const out: Traversals = { ladders: [], zips: [] }
  scene.updateMatrixWorld(true)
  scene.traverse(object => {
    const data = object.userData
    if (data.kind === 'ladder') {
      const bottom = object.localToWorld(new THREE.Vector3(0, data.bottomHeight + 0.025, 0.44))
      const top = object.localToWorld(new THREE.Vector3(0, data.landingHeight + 0.025, -data.landingDepth - 0.18))
      const floor = world.floor(top, 0.7, 0.25)
      if (Number.isFinite(floor)) top.y = floor + 0.025
      out.ladders.push({ bottom, top })
    }
    if (data.kind === 'zipline' && data.gameplay)
      out.zips.push({ start: object.localToWorld(new THREE.Vector3().fromArray(data.startLanding)), end: object.localToWorld(new THREE.Vector3().fromArray(data.endLanding)) })
  })
  return out
}

/**
 * Flood-fill every place the player can stand from `start`, on a lattice of columns, each holding every
 * floor in it (a basement under a guardroom under a roof). Moves: walking and stepping (0.34 m), dropping
 * off an edge, jumping up onto a ledge (to 1.05 m), running jumps across gaps, ladders and the zip line.
 * Places reached only by a one-way move (a drop, a leap, the zip line) are marked `oneWay`.
 */
export function playerReach(world: CollisionWorld, bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  start: THREE.Vector3, ways: Traversals, options: ReachOptions = {}) {
  const s = options.step ?? 0.5
  const box = options.region ?? bounds
  const minX = Math.max(bounds.minX, box.minX), minZ = Math.max(bounds.minZ, box.minZ)
  const nx = Math.ceil((Math.min(bounds.maxX, box.maxX) - minX) / s), nz = Math.ceil((Math.min(bounds.maxZ, box.maxZ) - minZ) / s)
  const columns = nx * nz
  const levels = new Float32Array(columns * LEVELS).fill(NaN)
  const standable = new Uint8Array(columns * LEVELS)
  const counted = new Int8Array(columns).fill(-1)
  const how = new Uint8Array(columns * LEVELS)
  const oneWay = new Uint8Array(columns * LEVELS)
  const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), PLAYER.radius)
  const probe = new THREE.Vector3()
  const fits = (x: number, feet: number, z: number) => {
    capsule.start.set(x, feet + PLAYER.radius, z); capsule.end.set(x, feet + PLAYER.height - PLAYER.radius, z)
    return world.fits(capsule)
  }
  const cx = (c: number) => minX + (Math.floor(c / nz) + 0.5) * s, cz = (c: number) => minZ + (c % nz + 0.5) * s
  const columnAt = (x: number, z: number) => {
    const i = Math.floor((x - minX) / s), k = Math.floor((z - minZ) / s)
    return i < 0 || k < 0 || i >= nx || k >= nz ? -1 : i * nz + k
  }
  /** Every up-facing surface in a column, highest first, and whether a body stands on each. */
  const scan = (c: number) => {
    if (counted[c] >= 0) return counted[c]
    const x = cx(c), z = cz(c)
    let top = TOP, n = 0, above = Infinity
    while (n < LEVELS) {
      const h = world.floor(probe.set(x, top, z), 0, top - BOTTOM)
      if (!Number.isFinite(h)) break
      // Two sheets a few millimetres apart (the paper ground under a concrete apron) are one floor.
      if (above - h < 0.1) { top = h - 0.02; continue }
      above = h
      // The body stands on the highest thing under its whole footprint (a stair tread just ahead, the lip
      // of a kerb), as PlayerBody does, not on what is exactly under its centre.
      let feet = h
      if (!fits(x, h + 0.002, z)) {
        const support = world.floor(probe.set(x, h + PLAYER.step, z), 0, PLAYER.step * 2, PLAYER.radius + 0.04)
        if (Number.isFinite(support) && support > h + 0.01) feet = support
      }
      levels[c * LEVELS + n] = feet
      standable[c * LEVELS + n] = fits(x, feet + 0.002, z) ? 1 : 0
      n++
      top = h - 0.02
    }
    counted[c] = n
    return n
  }
  const level = (node: number) => levels[node]
  const queue: number[] = []
  // Where each place was first reached from, for tracing how a player gets somewhere.
  const parent = new Int32Array(columns * LEVELS).fill(-1)
  let pass = 0, from = -1
  const visit = (node: number, move: Move) => {
    if (how[node]) return
    how[node] = MOVES.indexOf(move) + 1
    oneWay[node] = pass
    parent[node] = from
    queue.push(node)
  }
  /** The standable level of column c within `tolerance` of height y (nearest), or -1. */
  const levelNear = (c: number, y: number, tolerance: number) => {
    const n = scan(c)
    let best = -1, gap = tolerance
    for (let l = 0; l < n; l++) {
      const node = c * LEVELS + l
      if (!standable[node]) continue
      const d = Math.abs(levels[node] - y)
      if (d <= gap) { best = node; gap = d }
    }
    return best
  }
  const startColumn = columnAt(start.x, start.z)
  if (startColumn < 0) throw new Error('start outside the sweep region')
  const first = levelNear(startColumn, start.y, 0.6)
  if (first < 0) throw new Error(`nowhere to stand at the start ${start.toArray()}`)
  visit(first, 'start')
  const around: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  // Columns a standing jump can land in: up to 1.1 m out.
  const jumpReach: [number, number][] = []
  for (let di = -3; di <= 3; di++) for (let dk = -3; dk <= 3; dk++) if ((di || dk) && Math.hypot(di, dk) * s <= 1.1) jumpReach.push([di, dk])
  // Ladder and zip ends: the player takes one from within reach of its end (PlayerActions.findTarget).
  const ends = [
    ...ways.ladders.flatMap(l => [{ from: l.bottom, to: l.top, vertical: 1, oneWay: false }, { from: l.top, to: l.bottom, vertical: 1, oneWay: false }]),
    ...ways.zips.map(z => ({ from: z.start, to: z.end, vertical: 0.8, oneWay: true })),
  ]
  // A body fits all along from (x, z) to one column over, at `feet`. Closely spaced: a closed shape (a
  // fuel tank) only stops a body from outside, in a band as wide as the body, and a single sample in the
  // middle of the step can land either side of that band and walk straight into the tank.
  const along = (x: number, z: number, di: number, dk: number, feet: number) =>
    fits(x + di * s * 0.25, feet, z + dk * s * 0.25) && fits(x + di * s * 0.5, feet, z + dk * s * 0.5) && fits(x + di * s * 0.75, feet, z + dk * s * 0.75)
  const expand = (node: number) => {
    const c = Math.floor(node / LEVELS), i = Math.floor(c / nz), k = c % nz, h = level(node)
    const x = cx(c), z = cz(c)
    for (const [di, dk] of around) {
      const ii = i + di, kk = k + dk
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue
      const next = ii * nz + kk, n = scan(next)
      let walked = false
      for (let l = 0; l < n; l++) {
        const other = next * LEVELS + l
        if (!standable[other] || Math.abs(levels[other] - h) > PLAYER.step) continue
        if (along(x, z, di, dk, Math.max(h, levels[other]) + 0.002)) { walked = true; visit(other, 'walk') }
      }
      if (walked || pass === 0 || (di && dk)) continue
      // Off an edge: the body clears it at this height, then falls to the first floor below.
      if (!along(x, z, di, dk, h + 0.002) || !fits(cx(next), h + 0.002, cz(next))) continue
      for (let l = 0; l < n; l++) {
        const other = next * LEVELS + l
        if (levels[other] >= h - PLAYER.step) continue
        if (standable[other]) visit(other, 'drop')
        break
      }
    }
    // A standing jump onto a ledge: room overhead here, over the lip, and on top.
    for (const [di, dk] of jumpReach) {
      const ii = i + di, kk = k + dk
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue
      const next = ii * nz + kk, n = scan(next)
      for (let l = 0; l < n; l++) {
        const other = next * LEVELS + l, rise = levels[other] - h
        if (!standable[other] || rise <= PLAYER.step || rise > JUMP_UP || how[other]) continue
        const lift = levels[other] + 0.02, tx = cx(next), tz = cz(next)
        let clear = fits(x, lift, z)
        for (let j = 1, n = Math.ceil(Math.hypot(tx - x, tz - z) / 0.2); j < n && clear; j++) clear = fits(x + (tx - x) * j / n, lift, z + (tz - z) * j / n)
        if (clear) visit(other, 'jump')
      }
    }
    // Ladders and the zip line.
    for (const end of ends) {
      if ((end.oneWay && pass === 0) || Math.abs(end.from.y - h) > end.vertical || Math.hypot(end.from.x - x, end.from.z - z) > PLAYER.reach) continue
      const to = columnAt(end.to.x, end.to.z)
      if (to < 0) continue
      const landing = levelNear(to, end.to.y, 0.6)
      if (landing >= 0) visit(landing, end.oneWay ? 'zip' : 'ladder')
    }
    if (pass === 0 || !options.leaps) return
    // A running jump across a gap: a sprint at 7.6 m/s, 7 m/s up, 22 m/s² down, along 8 headings.
    for (const [di, dk] of around) {
      const length = Math.hypot(di, dk)
      const ux = di / length, uz = dk / length
      // Only where walking that way does not simply carry on (an edge, a gap, a rail).
      const ahead = columnAt(x + ux * s, z + uz * s)
      if (ahead >= 0 && levelNear(ahead, h, PLAYER.step) >= 0) continue
      for (let d = 1.0; d <= 4.6; d += s) {
        const target = columnAt(x + ux * d, z + uz * d)
        if (target < 0) break
        const n = scan(target)
        for (let l = 0; l < n; l++) {
          const other = target * LEVELS + l, rise = levels[other] - h
          if (!standable[other] || how[other] || rise > 0.9 || rise < -4) continue
          const flight = (PLAYER.jumpSpeed + Math.sqrt(PLAYER.jumpSpeed ** 2 - 2 * PLAYER.gravity * rise)) / PLAYER.gravity
          if (d / flight > PLAYER.sprint) continue
          // Samples closer than a body's radius, so the arc cannot skip through a wire fence.
          const samples = Math.ceil(d / 0.2)
          let clear = true
          for (let j = 1; j <= samples && clear; j++) {
            const t = flight * j / samples, along = d * j / samples
            clear = fits(x + ux * along, h + PLAYER.jumpSpeed * t - PLAYER.gravity / 2 * t * t + 0.03, z + uz * along)
          }
          if (clear) visit(other, 'leap')
        }
      }
    }
  }
  for (pass = 0; pass < 2; pass++) {
    if (pass === 1) for (let node = 0; node < how.length; node++) if (how[node]) queue.push(node)
    for (let q = 0; q < queue.length; q++) { from = queue[q]; expand(from) }
    queue.length = 0
  }
  const places: Standing[] = []
  for (let node = 0; node < how.length; node++) {
    if (!how[node]) continue
    const c = Math.floor(node / LEVELS)
    places.push({ x: cx(c), y: levels[node], z: cz(c), move: MOVES[how[node] - 1], oneWay: !!oneWay[node] })
  }
  /** The way the flood first got to the place at `p`, from the start, as [x, y, z, move] steps. */
  const trace = (p: { x: number; y: number; z: number }) => {
    const c = columnAt(p.x, p.z)
    let node = c < 0 ? -1 : levelNear(c, p.y, 0.3)
    const steps: [number, number, number, Move][] = []
    while (node >= 0 && steps.length < 100000) {
      const col = Math.floor(node / LEVELS)
      steps.push([cx(col), levels[node], cz(col), MOVES[how[node] - 1]])
      node = parent[node]
    }
    return steps.reverse()
  }
  return { places, trace, columns: { nx, nz, step: s, minX, minZ, scanned: counted.reduce((a, n) => a + (n >= 0 ? 1 : 0), 0) } }
}

// ---------------------------------------------------------------- the zombies' side

/** Dead Ink's compound as the runtime sets it up: every door open but the sealed exits, the baked graph, the zone gates. */
export function sweepWorld(graphFile = 'public/nav/compound.json') {
  const nav = buildNavScene()
  // The map's fingerprint as the runtime takes it (every door open), then the sealed exits shut.
  const hash = geometryHash(nav.scene)
  for (const door of nav.doors) if (SEALED.some(seal => seal.door === door.name)) { setDoorOpen(door, false, true); door.userData.missionLocked = true }
  nav.world.refresh()
  const graph = NavGraph.fromData(JSON.parse(readFileSync(graphFile, 'utf8')) as NavData)
  const zones = new ZoneGates(nav.scene, nav.world, graph)
  const doors = nav.doors.filter(door => !door.userData.missionLocked)
  const navigation = new EnemyNavigation(nav.world, doors, () => {})
  return { ...nav, doors, graph, zones, navigation, hash, ways: traversals(nav.scene, nav.world) }
}
export type SweepWorld = ReturnType<typeof sweepWorld>

export type Verdict = 'ok' | 'off-graph' | 'unreachable' | 'cannot hit' | 'stuck' | 'oscillating' | 'wrong way' | 'timeout'
export const VERDICTS: Verdict[] = ['ok', 'off-graph', 'unreachable', 'cannot hit', 'stuck', 'oscillating', 'wrong way', 'timeout']

/** Graph regions zombies can rise in (any with a ground spot), for the gates as they are now. */
export function spawnRegions(graph: NavGraph) {
  const { id } = graph.regions()
  const spawnable = new Set<number>()
  for (let s = 0; s < graph.cells; s++) if (id[s] >= 0) spawnable.add(id[s])
  return { id, spawnable }
}

const IGNORE = new THREE.Object3D()
const f1 = (n: number) => n.toFixed(1)
export const at = (p: { x: number; y: number; z: number }) => `${f1(p.x)}, ${f1(p.y)}, ${f1(p.z)}`
/** How much further a zombie reaches up at a player on something it cannot get onto (the director's REACH_UP). */
const REACH_UP = 0.8

/** From `from`, can a zombie get at a player standing at `feet`: walk straight there, or swipe from where it is? */
export function touches(w: SweepWorld, from: THREE.Vector3, feet: THREE.Vector3) {
  const flat = Math.hypot(from.x - feet.x, from.z - feet.z), up = feet.y - from.y
  if (Math.abs(up) < 1.2 && flat < 12) {
    const a = w.navigation.floor(from.clone()), b = w.navigation.floor(feet.clone())
    if (a && b && w.navigation.segment(a, b)) return true
  }
  const swipe = (flat <= ATTACK.range && Math.abs(up) < 1.3) || (up > 0.4 && up < 1.5 && flat <= ATTACK.range + REACH_UP)
  return swipe && w.world.visible(from.clone().setY(from.y + 1.2), feet.clone().setY(feet.y + 1.2), IGNORE)
}

/**
 * The quick verdict for a place, from the graph alone: where the zombies' flow field starts for a player
 * standing there (the flow's own nearest-spot rule), whether zombies can rise anywhere that leads there,
 * and whether a zombie on that spot can get at the player.
 */
export function staticCheck(w: SweepWorld, place: Standing, regions: ReturnType<typeof spawnRegions>): { spot: number; verdict: Verdict; note?: string } {
  const feet = new THREE.Vector3(place.x, place.y + 0.002, place.z)
  // The flow field's own rule for where it starts (NavGraph.flow with the director's spotInReach).
  const clear = (s: number, from: THREE.Vector3) => spotInReach(w.graph, w.world, s, from)
  let spot = w.graph.nearest(feet, 3, 2.2, clear)
  if (spot < 0) spot = w.graph.nearest(feet, 6, 6, clear)
  if (spot < 0) return { spot, verdict: 'off-graph', note: 'no graph spot within reach' }
  if (!regions.spawnable.has(regions.id[spot])) return { spot, verdict: 'unreachable', note: `spot ${at(w.graph.point(spot))} is cut off from every spawn` }
  const point = w.graph.point(spot)
  const flat = Math.hypot(point.x - feet.x, point.z - feet.z), up = feet.y - point.y
  if ((flat <= 0.9 && Math.abs(up) <= 0.35) || touches(w, point, feet)) return { spot, verdict: 'ok' }
  return { spot, verdict: 'off-graph', note: `the flow starts at ${at(point)}, ${f1(flat)} m away and ${f1(Math.abs(up))} m ${up > 0 ? 'below' : 'above'}, and cannot get at them from there` }
}

let stickmanLoaded = false
/** The real stickman from disk (the loader normally fetches it). */
function loadStickmanFromDisk() {
  if (stickmanLoaded) return
  stickmanLoaded = true
  const bytes = readFileSync('public/models/stickman.glb')
  GLTFLoader.prototype.loadAsync = async function () {
    return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '')
  }
}

export async function sweepDirector(w: SweepWorld, pool = 3) {
  loadStickmanFromDisk()
  const hits: string[] = []
  const director = new ZombieDirector({ scene: w.scene, world: w.world, doors: w.doors, graph: w.graph, emit: () => {}, damagePlayer: id => { hits.push(id) } })
  await director.init(pool)
  return { director, hits }
}
export type SweepDirector = Awaited<ReturnType<typeof sweepDirector>>

export type SimResult = {
  verdict: Verdict; seconds: number; budget: number; walk: number; relocated: number
  /** Longest a zombie stood still with the player out of reach, and the worst path walked over walking distance. */
  idle: number; detour: number; note?: string
}

const RISE_SECONDS = 1.9, RUN = 4.4

/**
 * The real director, a few zombies rising where the game would raise them (pickSpawn with the runtime's
 * rules), the player standing at `place`: does one land a swipe within a budget that grows with the
 * walk? Stranded zombies are moved as the runtime's relocateStranded moves them (only out of sight).
 */
export function simulate(w: SweepWorld, sim: SweepDirector, place: Standing, random: Random,
  gaits: ZombieGait[] = ['run', 'sprint', 'run'], fps = 60): SimResult {
  const { director, hits } = sim, graph = w.graph
  director.clear()
  hits.length = 0
  const feet = new THREE.Vector3(place.x, place.y + 0.002, place.z), eye = feet.clone().setY(feet.y + 1.65)
  const target: ZombieTarget = { id: 'p1', feet, alive: true }
  graph.flow([feet], (s, from) => spotInReach(graph, w.world, s, from))
  type Tracked = { zombie: Zombie; walk: number; travelled: number; last: THREE.Vector3; still: number; trail: { t: number; p: THREE.Vector3; d: number }[] }
  const zombies: Tracked[] = []
  for (const gait of gaits) {
    const spot = pickSpawn(graph, w.world, { near: 14, far: 42, eyes: [] }, random)
    if (!spot) continue
    const zombie = director.spawn(spot, 1e6, gait, Math.atan2(feet.x - spot.x, feet.z - spot.z), true)
    if (zombie) zombies.push({ zombie, walk: graph.distance(graph.nearest(zombie.position)), travelled: 0, last: zombie.position.clone(), still: 0, trail: [] })
  }
  if (!zombies.length) return { verdict: 'unreachable', seconds: 0, budget: 0, walk: Infinity, relocated: 0, idle: 0, detour: 0, note: 'nowhere to rise that leads here' }
  const walk = Math.min(...zombies.map(z => z.walk))
  const budget = RISE_SECONDS + 4 + 1.6 * (Number.isFinite(walk) ? walk : 60) / RUN
  const dt = 1 / fps
  let t = 0, relocated = 0, idle = 0, nextSample = 0, nextStrand = 0.5
  while (t < budget && !hits.length) {
    // Doors swing as the game swings them (a zombie pushing a shut one open).
    if (updateDoors(w.doors, dt)) w.world.refresh()
    director.update(dt, [target])
    t += dt
    for (const z of zombies) {
      const zombie = z.zombie
      if (zombie.state !== 'chase') continue
      z.travelled += Math.hypot(zombie.position.x - z.last.x, zombie.position.z - z.last.z)
      z.last.copy(zombie.position)
      const flat = Math.hypot(zombie.position.x - feet.x, zombie.position.z - feet.z)
      const busy = zombie.rise > 0 || !!zombie.climb || zombie.moving || zombie.swing > 0 || zombie.recover > 0 || flat < ATTACK.range + 0.6
      z.still = busy ? 0 : z.still + dt
      idle = Math.max(idle, z.still)
    }
    if (t >= nextSample) {
      nextSample += 0.5
      for (const z of zombies) z.trail.push({ t, p: z.zombie.position.clone(), d: graph.distance(graph.nearest(z.zombie.position)) })
    }
    if (t >= nextStrand) {
      nextStrand += 0.5
      for (const z of zombies) {
        if (z.zombie.state !== 'chase' || !z.zombie.stranded) continue
        if (w.world.visible(eye, z.zombie.position.clone().setY(z.zombie.position.y + 1.2), z.zombie.actor.root)) continue
        const spot = pickSpawn(graph, w.world, { near: 12, far: 32, eyes: [eye] }, random)
        if (spot && director.relocate(z.zombie, spot)) { relocated++; z.last.copy(z.zombie.position); z.trail.length = 0 }
      }
    }
  }
  const detour = Math.max(...zombies.map(z => (Number.isFinite(z.walk) && z.walk > 8 ? z.travelled / z.walk : 0)))
  const result = { seconds: t, budget, walk, relocated, idle, detour }
  if (hits.length) return { verdict: 'ok', ...result }
  // Why not: look at the zombie that came closest, over its last few seconds.
  const flatOf = (p: THREE.Vector3) => Math.hypot(p.x - feet.x, p.z - feet.z)
  const close = zombies.find(z => flatOf(z.zombie.position) <= ATTACK.range + 0.3 && Math.abs(z.zombie.position.y - feet.y) < 1.5)
  if (close) return { verdict: 'cannot hit', ...result, note: `a zombie stood at ${at(close.zombie.position)} and never landed a swipe` }
  const best = zombies.reduce((a, b) => (flatOf(b.zombie.position) < flatOf(a.zombie.position) ? b : a))
  const recent = best.trail.filter(s => s.t >= t - 4)
  const where = `closest zombie at ${at(best.zombie.position)}, ${f1(flatOf(best.zombie.position))} m short`
  if (recent.length >= 4) {
    let path = 0
    for (let i = 1; i < recent.length; i++) path += Math.hypot(recent[i].p.x - recent[i - 1].p.x, recent[i].p.z - recent[i - 1].p.z)
    const first = recent[0], last = recent[recent.length - 1]
    const net = Math.hypot(last.p.x - first.p.x, last.p.z - first.p.z)
    if (path < 0.6) return { verdict: 'stuck', ...result, note: where }
    if (net < 1.2) return { verdict: 'oscillating', ...result, note: `${where}, ${f1(path)} m walked for ${f1(net)} m gained` }
    if (last.d > first.d + 2 || (Number.isFinite(first.d) && !Number.isFinite(last.d))) return { verdict: 'wrong way', ...result, note: `${where}, walking away (${f1(first.d)} to ${f1(last.d)} m)` }
  }
  return { verdict: 'timeout', ...result, note: where }
}
