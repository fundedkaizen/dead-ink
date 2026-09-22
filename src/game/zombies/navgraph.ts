import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import type { CollisionWorld } from '../../player/collision'
import { EnemyNavigation } from '../navigation'

/**
 * A map-wide walking graph for zombies: a grid of walkable spots over the whole arena, linked wherever
 * a body can walk between them, plus LINKS for everything a grid misses: doorways (they rarely line up
 * with the grid), narrow stairs, and later ladders. A link may carry its own route (waypoints between
 * its two spots) and a kind ('walk', later 'climb'), so a zombie follows the actual way in.
 *
 * Building it costs seconds of collision queries, so it is BAKED ahead of time into a small data file
 * (scripts/build-navgraph.ts writes public/nav/compound.json) and loaded at startup, as games bake
 * their navmeshes. zombies-navgraph-checks rebuilds it from the geometry and fails if the file is stale.
 *
 * Zombies do not plan individual routes. A flow field (multi-source Dijkstra from every player) gives
 * each spot its walking distance to the NEAREST player; every zombie walks downhill on it. That costs
 * the same for 24 zombies as for one, and with two players each zombie goes for whoever is closer on
 * foot, not in a straight line.
 */

export const NAV_VERSION = 3
export const CELL = 1.6
/** A neighbour this much higher or lower still passes the quick test; beyond it, the fine walk test decides. */
export const MAX_STEP = 0.45
/** Beyond this height difference two spots are never linked directly (it is a ledge, not stairs). */
export const MAX_CLIMB = 1.4
const BODY_RADIUS = 0.3, BODY_HEIGHT = 1.74
/** Neighbour directions, as (di, dk) grid offsets. Bit i of a spot's mask means direction i is walkable. */
export const DIRECTIONS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/** A link between two spots. `via` holds waypoints from `a` toward `b` as flat x,y,z triples. */
export type NavLink = { a: number; b: number; via?: number[]; kind?: 'walk' | 'climb' }

export type NavData = {
  version: number; cell: number; minX: number; minZ: number; nx: number; nz: number
  /** Floor height per spot in centimetres; -32768 means not walkable. Base64 of little-endian Int16. */
  heights: string
  /** Walkable directions per spot, one byte each (bits follow DIRECTIONS). Base64. */
  masks: string
  links: NavLink[]
  /** Hash of the collision geometry the graph was built from, to detect a stale bake. */
  geometry: string
}

const NONE = -32768

// btoa/atob exist in browsers and in Node 16+, so the same code runs in the game and in checks.
function toBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
function fromBase64(text: string) {
  const s = atob(text), out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A stable fingerprint of what the zombies walk on: every static collider's bounds, rounded. */
export function geometryHash(scene: THREE.Object3D) {
  let hash = 2166136261
  const add = (n: number) => { hash ^= Math.round(n * 10) | 0; hash = Math.imul(hash, 16777619) >>> 0 }
  scene.updateWorldMatrix(true, true)
  const box = new THREE.Box3()
  scene.traverse(object => {
    for (let p: THREE.Object3D | null = object; p; p = p.parent) if (p.userData.noCollision) return
    if (!(object instanceof THREE.Mesh) || object.material instanceof THREE.ShaderMaterial) return
    box.setFromObject(object)
    add(box.min.x); add(box.min.y); add(box.min.z); add(box.max.x); add(box.max.y); add(box.max.z)
  })
  return hash.toString(16)
}

type Edge = { to: number; link: NavLink; length: number; forward: boolean }

export class NavGraph {
  readonly heights: Float32Array
  readonly masks: Uint8Array
  readonly links: NavLink[] = []
  private edges = new Map<number, Edge[]>()
  // Full precision on purpose: Float32 would round a distance below the value that put it in the
  // queue, so the 'stale entry' test would drop the entry and the search would stop at the source.
  private dist: Float64Array
  private heap = new MinHeap()
  private scratchA = new THREE.Vector3()
  private scratchB = new THREE.Vector3()

  constructor(readonly cell: number, readonly minX: number, readonly minZ: number, readonly nx: number, readonly nz: number,
    heights: Float32Array, masks: Uint8Array, links: NavLink[], readonly geometry = '') {
    this.heights = heights
    this.masks = masks
    for (const link of links) this.addLink(link)
    this.dist = new Float64Array(nx * nz).fill(Infinity)
  }

  addLink(link: NavLink) {
    if (link.a === link.b || this.links.some(l => (l.a === link.a && l.b === link.b) || (l.a === link.b && l.b === link.a))) return
    this.links.push(link)
    const route = this.linkRoute(link, true)
    let length = 0
    for (let i = 1; i < route.length; i++) length += route[i - 1].distanceTo(route[i])
    for (const [from, to, forward] of [[link.a, link.b, true], [link.b, link.a, false]] as const) {
      if (!this.edges.has(from)) this.edges.set(from, [])
      this.edges.get(from)!.push({ to, link, length, forward })
    }
  }

  /** Points along a link from one end to the other, both ends included. */
  private linkRoute(link: NavLink, forward: boolean) {
    const points = [this.point(link.a)]
    const via = link.via ?? []
    for (let i = 0; i + 2 < via.length; i += 3) points.push(new THREE.Vector3(via[i], via[i + 1], via[i + 2]))
    points.push(this.point(link.b))
    return forward ? points : points.reverse()
  }

  get size() { return this.nx * this.nz }
  walkable(index: number) { return index >= 0 && index < this.size && !Number.isNaN(this.heights[index]) }
  index(i: number, k: number) { return i < 0 || k < 0 || i >= this.nx || k >= this.nz ? -1 : i * this.nz + k }
  point(index: number, out = new THREE.Vector3()) {
    const i = Math.floor(index / this.nz), k = index % this.nz
    return out.set(this.minX + (i + 0.5) * this.cell, this.heights[index], this.minZ + (k + 0.5) * this.cell)
  }

  /** Neighbours of a spot: grid directions from its mask, then links. */
  neighbours(index: number, out: number[] = []) {
    out.length = 0
    const i = Math.floor(index / this.nz), k = index % this.nz, mask = this.masks[index]
    for (let d = 0; d < 8; d++) if (mask & (1 << d)) out.push((i + DIRECTIONS[d][0]) * this.nz + k + DIRECTIONS[d][1])
    const edges = this.edges.get(index)
    if (edges) for (const edge of edges) out.push(edge.to)
    return out
  }

  /**
   * The way from spot `from` to its neighbour `to`: the waypoints of the link between them if there is
   * one (so a zombie follows the real stairs), otherwise just the neighbour's own point.
   */
  route(from: number, to: number): { points: THREE.Vector3[]; kind: 'walk' | 'climb' } {
    const edge = this.edges.get(from)?.find(e => e.to === to)
    if (!edge) return { points: [this.point(to)], kind: 'walk' }
    return { points: this.linkRoute(edge.link, edge.forward), kind: edge.link.kind ?? 'walk' }
  }

  /**
   * Remove a link that turned out to be impassable in play. The baked graph is built from geometry
   * tests that can be slightly too generous (a gap a body fits through at the spot centres but not
   * from where a zombie actually stands), so the game corrects it: after repeated failures the link
   * goes, and the next flow field routes everyone around it.
   */
  blockEdge(a: number, b: number) {
    const i = Math.floor(a / this.nz), k = a % this.nz
    for (let d = 0; d < 8; d++) {
      const [di, dk] = DIRECTIONS[d]
      if ((i + di) * this.nz + k + dk !== b) continue
      this.masks[a] &= ~(1 << d)
      const back = DIRECTIONS.findIndex(([x, z]) => x === -di && z === -dk)
      this.masks[b] &= ~(1 << back)
    }
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const edges = this.edges.get(from)
      if (edges) this.edges.set(from, edges.filter(edge => edge.to !== to))
    }
    const index = this.links.findIndex(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))
    if (index >= 0) this.links.splice(index, 1)
  }

  /** True when `from` to `to` is a plain grid step (safe to cut straight across when smoothing). */
  plainStep(from: number, to: number) { return !this.edges.get(from)?.some(e => e.to === to) }

  /** The walkable spot nearest to a position on roughly the same level, searching a few rings out. */
  nearest(position: THREE.Vector3, rings = 3) {
    const ci = Math.floor((position.x - this.minX) / this.cell), ck = Math.floor((position.z - this.minZ) / this.cell)
    let best = -1, bestScore = Infinity
    for (let r = 0; r <= rings && best < 0; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(k - ck)) !== r) continue
        const index = this.index(i, k)
        if (!this.walkable(index)) continue
        const dy = Math.abs(this.heights[index] - position.y)
        if (dy > 2.2) continue
        const x = this.minX + (i + 0.5) * this.cell - position.x, z = this.minZ + (k + 0.5) * this.cell - position.z
        const score = x * x + z * z + dy * dy * 4
        if (score < bestScore) { best = index; bestScore = score }
      }
    }
    return best
  }

  /**
   * Walking distance from every spot to the nearest of `sources` (players). Afterwards `distance(i)`
   * reads it and `downhill(i)` gives the next spot toward that player.
   */
  flow(sources: readonly THREE.Vector3[]) {
    const dist = this.dist, a = this.scratchA, b = this.scratchB
    dist.fill(Infinity)
    this.heap.clear()
    for (const source of sources) {
      const start = this.nearest(source)
      if (start < 0) continue
      const d = this.point(start, a).distanceTo(source)
      if (d < dist[start]) { dist[start] = d; this.heap.push(start, d) }
    }
    while (this.heap.length) {
      const [node, d] = this.heap.pop()
      if (d > dist[node]) continue
      const i = Math.floor(node / this.nz), k = node % this.nz, mask = this.masks[node]
      this.point(node, a)
      for (let dir = 0; dir < 8; dir++) {
        if (!(mask & (1 << dir))) continue
        const next = (i + DIRECTIONS[dir][0]) * this.nz + k + DIRECTIONS[dir][1]
        const nd = d + a.distanceTo(this.point(next, b))
        if (nd < dist[next]) { dist[next] = nd; this.heap.push(next, nd) }
      }
      const edges = this.edges.get(node)
      if (edges) for (const edge of edges) {
        const nd = d + edge.length
        if (nd < dist[edge.to]) { dist[edge.to] = nd; this.heap.push(edge.to, nd) }
      }
    }
  }

  distance(index: number) { return index >= 0 ? this.dist[index] : Infinity }

  /** The neighbour closest to a player by walking distance, or -1 at a dead end. */
  downhill(index: number) {
    let best = -1, bestDistance = this.distance(index)
    const around: number[] = []
    for (const next of this.neighbours(index, around)) if (this.dist[next] < bestDistance) { best = next; bestDistance = this.dist[next] }
    return best
  }

  toData(): NavData {
    const cm = new Int16Array(this.size)
    for (let i = 0; i < this.size; i++) cm[i] = Number.isNaN(this.heights[i]) ? NONE : Math.round(this.heights[i] * 100)
    return { version: NAV_VERSION, cell: this.cell, minX: this.minX, minZ: this.minZ, nx: this.nx, nz: this.nz,
      heights: toBase64(new Uint8Array(cm.buffer)), masks: toBase64(this.masks),
      links: this.links.map(l => ({ a: l.a, b: l.b,
        ...(l.via?.length ? { via: l.via.map(n => Math.round(n * 100) / 100) } : {}),
        ...(l.kind && l.kind !== 'walk' ? { kind: l.kind } : {}) })),
      geometry: this.geometry }
  }

  static fromData(data: NavData) {
    if (data.version !== NAV_VERSION) throw new Error(`navigation data version ${data.version}, expected ${NAV_VERSION}`)
    const raw = fromBase64(data.heights), cm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)
    const heights = new Float32Array(cm.length)
    for (let i = 0; i < cm.length; i++) heights[i] = cm[i] === NONE ? NaN : cm[i] / 100
    return new NavGraph(data.cell, data.minX, data.minZ, data.nx, data.nz, heights, fromBase64(data.masks), data.links, data.geometry)
  }

  /** Connected regions: region id per spot (-1 where not walkable), and region sizes. */
  regions() {
    const id = new Int32Array(this.size).fill(-1), sizes: number[] = [], around: number[] = []
    for (let s = 0; s < this.size; s++) {
      if (!this.walkable(s) || id[s] >= 0) continue
      const region = sizes.length, stack = [s]
      id[s] = region
      let count = 0
      while (stack.length) {
        const n = stack.pop()!
        count++
        for (const m of this.neighbours(n, around)) if (id[m] < 0) { id[m] = region; stack.push(m) }
      }
      sizes.push(count)
    }
    return { id, sizes }
  }

  /**
   * Build from collision geometry, in three passes:
   * 1. Spots: floor under it and a whole body fits.
   * 2. Grid links: small steps pass a quick knee-and-chest ray test; steps, ramps and anything the rays
   *    reject get the guards' own fine walk test. Diagonals never cut a corner. Doorways get links.
   * 3. Pockets: any region the grid could not reach (narrow stairs are the usual reason) asks the
   *    guards' fine route planner for a way to the main region, and stores it as a link with waypoints.
   * Seconds of work: run it offline (scripts/build-navgraph.ts).
   */
  static build(world: CollisionWorld, bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    doors: readonly THREE.Object3D[], geometry = '', cell = CELL, log: (message: string) => void = () => {}) {
    const nx = Math.ceil((bounds.maxX - bounds.minX) / cell), nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell)
    const heights = new Float32Array(nx * nz).fill(NaN)
    const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), BODY_RADIUS)
    const probe = new THREE.Vector3()
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      const x = bounds.minX + (i + 0.5) * cell, z = bounds.minZ + (k + 0.5) * cell
      const h = world.floor(probe.set(x, 0.6, z), 0.6, 1.2, BODY_RADIUS * 0.95)
      if (!Number.isFinite(h)) continue
      capsule.start.set(x, h + 0.024 + BODY_RADIUS, z); capsule.end.set(x, h + 0.024 + BODY_HEIGHT - BODY_RADIUS, z)
      if (world.fits(capsule)) heights[i * nz + k] = h
    }
    // The guards' own "can a body walk from A to B" test: a capsule swept in small steps, following the
    // floor up steps and ramps. Authoritative but slow, so it only runs where the quick test cannot decide.
    const walker = new EnemyNavigation(world, doors as THREE.Group[], () => {})
    const walks = (from: THREE.Vector3, to: THREE.Vector3) => {
      const start = walker.floor(from), end = walker.floor(to)
      return !!start && !!end && walker.segment(start, end)
    }
    const masks = new Uint8Array(nx * nz)
    const ignore = new THREE.Object3D(), a = new THREE.Vector3(), b = new THREE.Vector3()
    const at = (i: number, k: number) => (i < 0 || k < 0 || i >= nx || k >= nz) ? NaN : heights[i * nz + k]
    const place = (index: number, out: THREE.Vector3) =>
      out.set(bounds.minX + (Math.floor(index / nz) + 0.5) * cell, heights[index], bounds.minZ + (index % nz + 0.5) * cell)
    const raysClear = () => {
      for (const lift of [0.45, 1.3]) if (!world.visible(a.clone().setY(a.y + lift), b.clone().setY(b.y + lift), ignore)) return false
      return true
    }
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      const h = at(i, k)
      if (Number.isNaN(h)) continue
      for (let d = 0; d < 8; d++) {
        const [di, dk] = DIRECTIONS[d], ii = i + di, kk = k + dk
        // Each pair is tested once, from the lower index, and mirrored.
        if (ii * nz + kk < i * nz + k) continue
        const h2 = at(ii, kk)
        if (Number.isNaN(h2) || Math.abs(h2 - h) > MAX_CLIMB) continue
        if (di && dk && (Number.isNaN(at(i + di, k)) || Number.isNaN(at(i, k + dk)))) continue
        place(i * nz + k, a); place(ii * nz + kk, b)
        const flat = Math.abs(h2 - h) <= MAX_STEP
        if (!(flat && raysClear()) && !walks(a.clone(), b.clone())) continue
        masks[i * nz + k] |= 1 << d
        masks[ii * nz + kk] |= 1 << DIRECTIONS.findIndex(([x, z]) => x === -di && z === -dk)
      }
    }
    const graph = new NavGraph(cell, bounds.minX, bounds.minZ, nx, nz, heights, masks, [], geometry)
    // Doorways: link spots on opposite sides whose connecting line passes through the opening.
    const centre = new THREE.Vector3(), flatCentre = new THREE.Vector3(), closest = new THREE.Vector3()
    for (const door of doors) {
      door.getWorldPosition(centre)
      flatCentre.copy(centre).setY(0)
      const ci = Math.floor((centre.x - bounds.minX) / cell), ck = Math.floor((centre.z - bounds.minZ) / cell)
      const near: number[] = []
      for (let i = ci - 2; i <= ci + 2; i++) for (let k = ck - 2; k <= ck + 2; k++) {
        const index = i * nz + k
        if (i < 0 || k < 0 || i >= nx || k >= nz || Number.isNaN(heights[index])) continue
        if (Math.abs(heights[index] - centre.y) > 1.2) continue
        near.push(index)
      }
      for (const p of near) for (const q of near) {
        if (q <= p) continue
        place(p, a); place(q, b)
        const length = Math.hypot(b.x - a.x, b.z - a.z)
        if (length < cell * 1.2 || length > 3.8 || Math.abs(a.y - b.y) > MAX_CLIMB) continue
        const line = new THREE.Line3(a.clone().setY(0), b.clone().setY(0))
        if (line.closestPointToPoint(flatCentre, true, closest).distanceTo(flatCentre) > 0.45) continue
        if (!walks(a.clone(), b.clone())) continue
        graph.addLink({ a: p, b: q })
      }
    }
    // Pockets: ask the guards' fine planner for a way from each cut-off region to the main one.
    const { id, sizes } = graph.regions()
    const main = sizes.indexOf(Math.max(...sizes))
    const mainSpots: number[] = []
    for (let s = 0; s < graph.size; s++) if (id[s] === main) mainSpots.push(s)
    log(`${sizes.length} regions before connecting pockets; main holds ${sizes[main]} of ${sizes.reduce((x, y) => x + y, 0)} spots`)
    for (let region = 0; region < sizes.length; region++) {
      if (region === main || sizes[region] < 6) continue
      const pairs: [number, number, number][] = []
      for (let p = 0; p < graph.size; p++) {
        if (id[p] !== region) continue
        place(p, a)
        let best = -1, bestDistance = 25
        for (const q of mainSpots) {
          place(q, b)
          const d = Math.hypot(b.x - a.x, b.z - a.z)
          if (d < bestDistance) { best = q; bestDistance = d }
        }
        if (best >= 0) pairs.push([p, best, bestDistance])
      }
      // Try the pocket spots closest to the main region first, but SPREAD OUT along the pocket: the way
      // in is often a single narrow staircase at one end (the warehouse dock is 55 m long with one
      // flight at its west end), so sampling only the few nearest spots misses it.
      pairs.sort((x, y) => x[2] - y[2])
      const attempts = sizes[region] >= 20 ? 16 : 4, spacing = 5
      const tried: THREE.Vector3[] = []
      let connected = false
      for (const [p, q] of pairs) {
        if (connected || tried.length >= attempts) break
        const from = place(p, new THREE.Vector3())
        if (tried.some(t => t.distanceTo(from) < spacing)) continue
        tried.push(from)
        const start = walker.floor(from.clone()), end = walker.floor(place(q, b).clone())
        if (!start || !end) continue
        const job = walker.createPlan(start, end)
        let result = job.next()
        while (!result.done) result = job.next()
        const path = result.value
        if (!path.length) continue
        // The plan ends at the goal itself; everything before it is the route between the two spots.
        graph.addLink({ a: p, b: q, via: path.slice(0, -1).flatMap(v => [v.x, v.y, v.z]) })
        log(`  region ${region} (${sizes[region]} spots) linked in from ${from.toArray().map(n => n.toFixed(1)).join(',')} after ${tried.length} tries`)
        connected = true
        break
      }
      if (!connected) log(`  region ${region} (${sizes[region]} spots) could not be linked after ${tried.length} tries; ${pairs.length} candidate pairs`)
    }
    return graph
  }
}

/** A small binary min-heap of (node, priority). */
class MinHeap {
  private nodes: number[] = []
  private keys: number[] = []
  get length() { return this.nodes.length }
  clear() { this.nodes.length = 0; this.keys.length = 0 }
  push(node: number, key: number) {
    const nodes = this.nodes, keys = this.keys
    let i = nodes.length
    nodes.push(node); keys.push(key)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      nodes[i] = nodes[parent]; keys[i] = keys[parent]
      i = parent
    }
    nodes[i] = node; keys[i] = key
  }
  pop(): [number, number] {
    const nodes = this.nodes, keys = this.keys
    const top: [number, number] = [nodes[0], keys[0]]
    const lastNode = nodes.pop()!, lastKey = keys.pop()!
    if (nodes.length) {
      let i = 0
      const n = nodes.length
      while (true) {
        const l = 2 * i + 1, r = l + 1
        let smallest = i, sk = lastKey
        if (l < n && keys[l] < sk) { smallest = l; sk = keys[l] }
        if (r < n && keys[r] < sk) { smallest = r; sk = keys[r] }
        if (smallest === i) break
        nodes[i] = nodes[smallest]; keys[i] = keys[smallest]
        i = smallest
      }
      nodes[i] = lastNode; keys[i] = lastKey
    }
    return top
  }
}
