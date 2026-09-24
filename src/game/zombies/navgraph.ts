import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import type { CollisionWorld } from '../../player/collision'
import { EnemyNavigation } from '../navigation'

/**
 * A map-wide walking graph for zombies: a grid of walkable spots over the whole arena, linked wherever
 * a body can walk between them, plus LINKS for everything a grid misses: doorways (they rarely line up
 * with the grid), narrow stairs, ledges a body vaults and ladders it climbs. A link may carry its own
 * route (waypoints between its two spots) and a kind ('walk' or 'climb'), so a zombie follows the
 * actual way in.
 *
 * The grid holds one spot per cell, at ground level. Every other floor is a LEVEL spot ("raised" in the
 * code, though it may lie below the ground): extra spots in a cell, numbered after the grid, above it or
 * below it. Roofs, tower decks and tank tops are found by walking out from each ladder top; floors the
 * grid's ground probe cannot see (the detention block's basement and its sunken stairwell, a staircase
 * up to a floor above) by walking off the grid wherever a floor carries on beyond its reach. A cell can
 * hold several: the cell block under the guardroom under the roof.
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

export const NAV_VERSION = 4
export const CELL = 1.6
/** A neighbour this much higher or lower still passes the quick test; beyond it, the fine walk test decides. */
export const MAX_STEP = 0.45
/** Beyond this height difference two spots are never linked directly (it is a ledge, not stairs). */
export const MAX_CLIMB = 1.4
const BODY_RADIUS = 0.3, BODY_HEIGHT = 1.74
/** The heights the ground grid looks for a floor between; floors beyond it are level spots. */
const GRID_WINDOW = { low: -0.6, high: 1.2 } as const
/** Neighbour directions, as (di, dk) grid offsets. Bit i of a spot's mask means direction i is walkable. */
export const DIRECTIONS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
/** The direction back, per direction. */
const BACK = DIRECTIONS.map(([di, dk]) => DIRECTIONS.findIndex(([x, z]) => x === -di && z === -dk))

/**
 * Of the level spots `spots` in one cell, the one nearest in height to `y` within `tolerance` (-1 if none).
 * A mask bit leads to the spot the next cell holds at about the same height: this is how a stored graph
 * reads that back, and how the builder checks it will be read back as meant.
 */
function nearestLevel(spots: readonly number[] | undefined, height: (spot: number) => number, y: number, tolerance: number) {
  let best = -1, gap = tolerance
  for (const spot of spots ?? []) {
    const d = Math.abs(height(spot) - y)
    if (d <= gap) { best = spot; gap = d }
  }
  return best
}

/** A link between two spots. `via` holds waypoints from `a` toward `b` as flat x,y,z triples. */
export type NavLink = { a: number; b: number; via?: number[]; kind?: 'walk' | 'climb' }
/**
 * A spot on a raised surface. It belongs to a grid cell but stands wherever in that cell a body fits
 * (a tower deck can be smaller than a cell). Mask bits follow DIRECTIONS and lead to the raised spot of
 * the neighbouring cell at about the same height.
 */
export type RaisedSpot = { cell: number; x: number; y: number; z: number; mask: number }
/**
 * Ways up, from the map itself: ladders (the climb from the bottom rung to the deck) and points on
 * raised surfaces to explore from (ladder tops, zip line landings).
 */
export type RaisedWays = { climbs: { bottom: THREE.Vector3; via: THREE.Vector3[]; top: THREE.Vector3 }[]; seeds: THREE.Vector3[] }
/** Climbing up costs this many times its length on the flow field, so stairs win where they exist. */
export const CLIMB_COST = { up: 2.5, down: 1.3 } as const
/**
 * Walls a zombie climbs without a ladder: tops this high above the ground beside them (containers, crate
 * stacks, sheds, low roofs). Taller buildings keep to their ladders.
 */
export const WALL_CLIMB = { low: 1.4, high: 3.4 } as const
/**
 * Furniture a player might stand on to keep out of reach: desks and tables, 0.55 to 1.4 m up. Zombies
 * vault onto them (a short wall climb), so standing on a desk is no longer safe.
 */
export const FURNITURE = { low: 0.55, high: 1.4 } as const
/**
 * A player somewhere no spot reaches (balanced on a fence rail, down a hole): how far above a zombie it
 * still clambers up to them, as it would a wall, and how far below it drops down to them; how far off to
 * the side it still does (`beside`); and how close a spot on their level must be to swipe from.
 */
export const PERCH = { up: WALL_CLIMB.high + 0.2, down: 6, beside: 2.6, swipe: 1.45 } as const

export type NavData = {
  version: number; cell: number; minX: number; minZ: number; nx: number; nz: number
  /** Floor height per spot in centimetres; -32768 means not walkable. Base64 of little-endian Int16. */
  heights: string
  /** Walkable directions per spot, one byte each (bits follow DIRECTIONS). Base64. */
  masks: string
  links: NavLink[]
  /** Hash of the collision geometry the graph was built from, to detect a stale bake. */
  geometry: string
  /** Raised spots as flat [cell, x, y, z, mask] quintuples, positions in centimetres. */
  raised: number[]
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
    // Not the map: anything without collision, and whatever hangs off a camera (the player's gun).
    for (let p: THREE.Object3D | null = object; p; p = p.parent) if (p.userData.noCollision || (p as THREE.Camera).isCamera) return
    if (!(object instanceof THREE.Mesh) || object.material instanceof THREE.ShaderMaterial) return
    box.setFromObject(object)
    add(box.min.x); add(box.min.y); add(box.min.z); add(box.max.x); add(box.max.y); add(box.max.z)
  })
  return hash.toString(16)
}

type Edge = { to: number; link: NavLink; length: number; forward: boolean }
type Gap = { masks: [number, number][]; raised: [number, number][]; edges: [number, Edge][]; heights?: [number, number][] }

/**
 * Does the flat step p-q cross the gap a-b? A step that starts or ends exactly on it counts too: a spot can
 * stand right on the line of a fence the bake never saw (Dead Ink's zone fences go up at run time), and a
 * step from there must not lead through it.
 */
function crosses(p: { x: number; z: number }, q: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) {
  const side = (o: { x: number; z: number }, u: { x: number; z: number }, v: { x: number; z: number }) => (u.x - o.x) * (v.z - o.z) - (u.z - o.z) * (v.x - o.x)
  const d1 = side(a, b, p), d2 = side(a, b, q), d3 = side(p, q, a), d4 = side(p, q, b)
  const onP = Math.abs(d1) < 1e-9, onQ = Math.abs(d2) < 1e-9
  return (d1 * d2 < 0 || onP !== onQ) && d3 * d4 < 0
}

export class NavGraph {
  readonly heights: Float32Array
  readonly masks: Uint8Array
  readonly links: NavLink[] = []
  private edges = new Map<number, Edge[]>()
  readonly raised: RaisedSpot[]
  /** Per raised spot and direction, the neighbouring raised spot (or -1). */
  private raisedNext: Int32Array
  /** Grid cell to the raised spots above it. */
  private raisedIn = new Map<number, number[]>()
  // Full precision on purpose: Float32 would round a distance below the value that put it in the
  // queue, so the 'stale entry' test would drop the entry and the search would stop at the source.
  private dist: Float64Array
  private heap = new MinHeap()
  /** nearest()'s candidates and their scores, kept between calls. */
  private found: number[] = []
  private foundScores: number[] = []
  private gaps = new Map<number, Gap>()
  private nextGap = 1
  private scratchA = new THREE.Vector3()
  private scratchB = new THREE.Vector3()

  constructor(readonly cell: number, readonly minX: number, readonly minZ: number, readonly nx: number, readonly nz: number,
    heights: Float32Array, masks: Uint8Array, links: NavLink[], readonly geometry = '', raised: RaisedSpot[] = []) {
    this.heights = heights
    this.masks = masks
    this.raised = raised
    this.raisedNext = new Int32Array(raised.length * 8).fill(-1)
    raised.forEach((spot, r) => {
      const list = this.raisedIn.get(spot.cell)
      if (list) list.push(this.cells + r); else this.raisedIn.set(spot.cell, [this.cells + r])
    })
    raised.forEach((spot, r) => {
      const i = Math.floor(spot.cell / nz), k = spot.cell % nz
      for (let d = 0; d < 8; d++) {
        if (!(spot.mask & (1 << d))) continue
        const next = this.raisedAt(this.index(i + DIRECTIONS[d][0], k + DIRECTIONS[d][1]), spot.y, MAX_CLIMB)
        if (next >= 0) this.raisedNext[r * 8 + d] = next
      }
    })
    // Every step between level spots goes both ways: the flow field walks it one way and a zombie the
    // other, so a one-way step leaves a spot with a distance but no way down from it.
    for (let r = 0; r < raised.length; r++) for (let d = 0; d < 8; d++) {
      const next = this.raisedNext[r * 8 + d]
      if (next >= 0 && this.raisedNext[(next - this.cells) * 8 + BACK[d]] !== this.cells + r) this.raisedNext[r * 8 + d] = -1
    }
    for (const link of links) this.addLink(link)
    this.dist = new Float64Array(this.size).fill(Infinity)
  }

  /** The level spot in grid cell `cell` nearest in height to `y`, within `tolerance`, or -1. */
  private raisedAt(cell: number, y: number, tolerance: number) {
    return nearestLevel(this.raisedIn.get(cell), r => this.raised[r - this.cells].y, y, tolerance)
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

  /** Ground spots: the grid. Raised spots are numbered after them, up to `size`. */
  get cells() { return this.nx * this.nz }
  get size() { return this.cells + this.raised.length }
  walkable(index: number) { return index >= 0 && (index < this.cells ? !Number.isNaN(this.heights[index]) : index < this.size) }
  index(i: number, k: number) { return i < 0 || k < 0 || i >= this.nx || k >= this.nz ? -1 : i * this.nz + k }
  point(index: number, out = new THREE.Vector3()) {
    if (index >= this.cells) { const spot = this.raised[index - this.cells]; return out.set(spot.x, spot.y, spot.z) }
    const i = Math.floor(index / this.nz), k = index % this.nz
    return out.set(this.minX + (i + 0.5) * this.cell, this.heights[index], this.minZ + (k + 0.5) * this.cell)
  }
  height(index: number) { return index >= this.cells ? this.raised[index - this.cells].y : this.heights[index] }

  /** Neighbours of a spot: grid directions from its mask, then links. */
  neighbours(index: number, out: number[] = []) {
    out.length = 0
    if (index >= this.cells) {
      for (let d = 0, base = (index - this.cells) * 8; d < 8; d++) if (this.raisedNext[base + d] >= 0) out.push(this.raisedNext[base + d])
    } else {
      const i = Math.floor(index / this.nz), k = index % this.nz, mask = this.masks[index]
      for (let d = 0; d < 8; d++) if (mask & (1 << d)) out.push((i + DIRECTIONS[d][0]) * this.nz + k + DIRECTIONS[d][1])
    }
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

  /** The kind of the link from `from` to `to`; plain grid steps are 'walk'. */
  linkKind(from: number, to: number) { return this.edges.get(from)?.find(e => e.to === to)?.link.kind ?? 'walk' }

  /**
   * Take out a link that turned out to be impassable in play. The baked graph is built from geometry
   * tests that can be slightly too generous (a gap a body fits through at the spot centres but not
   * from where a zombie actually stands), so the game corrects it: after repeated failures the link
   * goes, and the next flow field routes everyone around it. A body can also be stopped by something
   * that passes (a door leaf mid-swing, a shove from the crowd), so it is a gap like closeGap's:
   * openGap(key) puts it back, and the director does after a while.
   */
  blockEdge(a: number, b: number) {
    const cut: Gap = { masks: [], raised: [], edges: [] }
    const i = Math.floor(a / this.nz), k = a % this.nz
    for (const [from, to] of [[a, b], [b, a]] as const) {
      if (from < this.cells) continue
      for (let d = 0, base = (from - this.cells) * 8; d < 8; d++)
        if (this.raisedNext[base + d] === to) { this.raisedNext[base + d] = -1; cut.raised.push([base + d, to]) }
    }
    for (let d = 0; d < 8 && a < this.cells && b < this.cells; d++) {
      const [di, dk] = DIRECTIONS[d]
      if ((i + di) * this.nz + k + dk !== b) continue
      const back = DIRECTIONS.findIndex(([x, z]) => x === -di && z === -dk)
      if (this.masks[a] & (1 << d)) { this.masks[a] &= ~(1 << d); cut.masks.push([a, d]) }
      if (this.masks[b] & (1 << back)) { this.masks[b] &= ~(1 << back); cut.masks.push([b, back]) }
    }
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const edges = this.edges.get(from)
      if (!edges) continue
      for (const edge of edges) if (edge.to === to) cut.edges.push([from, edge])
      this.edges.set(from, edges.filter(edge => edge.to !== to))
    }
    const key = this.nextGap++
    this.gaps.set(key, cut)
    return key
  }

  /**
   * Cut every way across the flat segment a-b (a closed gate, a fence added at run time): grid steps,
   * raised steps and links whose route crosses it. Undone by openGap(key). The graph is baked with
   * every gate open; Dead Ink closes the ones a player has not paid for.
   */
  closeGap(a: { x: number; z: number }, b: { x: number; z: number }) {
    const cut: Gap = { masks: [], raised: [], edges: [] }
    const p = new THREE.Vector3(), q = new THREE.Vector3()
    const i0 = Math.floor((Math.min(a.x, b.x) - this.minX) / this.cell) - 2, i1 = Math.floor((Math.max(a.x, b.x) - this.minX) / this.cell) + 2
    const k0 = Math.floor((Math.min(a.z, b.z) - this.minZ) / this.cell) - 2, k1 = Math.floor((Math.max(a.z, b.z) - this.minZ) / this.cell) + 2
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
      const index = this.index(i, k)
      if (index < 0) continue
      if (this.walkable(index)) {
        this.point(index, p)
        for (let d = 0; d < 8; d++) {
          if (!(this.masks[index] & (1 << d))) continue
          this.point((i + DIRECTIONS[d][0]) * this.nz + k + DIRECTIONS[d][1], q)
          if (crosses(p, q, a, b)) { this.masks[index] &= ~(1 << d); cut.masks.push([index, d]) }
        }
      }
      for (const r of this.raisedIn.get(index) ?? []) {
        this.point(r, p)
        for (let d = 0, base = (r - this.cells) * 8; d < 8; d++) {
          const next = this.raisedNext[base + d]
          if (next < 0 || !crosses(p, this.point(next, q), a, b)) continue
          this.raisedNext[base + d] = -1; cut.raised.push([base + d, next])
        }
      }
    }
    for (const [from, edges] of this.edges) {
      const keep = edges.filter(edge => {
        const route = this.linkRoute(edge.link, edge.forward)
        for (let n = 1; n < route.length; n++) if (crosses(route[n - 1], route[n], a, b)) { cut.edges.push([from, edge]); return false }
        return true
      })
      if (keep.length !== edges.length) this.edges.set(from, keep)
    }
    const key = this.nextGap++
    this.gaps.set(key, cut)
    return key
  }

  /**
   * Cut the graph round `solids`, props put in the world at run time that the bake never saw (Dead Ink's
   * crates, barrels, sandbags, the car), by the bake's own tests: the ground spots a body no longer fits on go,
   * and the steps a body no longer gets along (swept from knee height, else the guards' walker), where the
   * solids are what stops it. A cut step that would strand a spot from where it was connected stays: from
   * there zombies still squeeze past or claw at a player over the prop. Undone by openGap(key).
   */
  closeSolids(world: CollisionWorld, solids: THREE.Object3D) {
    const cut: Gap = { masks: [], raised: [], edges: [], heights: [] }, was = this.regions().id
    const box = new THREE.Box3(), a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3(), gone = new Set<number>()
    const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), BODY_RADIUS)
    const fits = (x: number, base: number, z: number, ignored: THREE.Object3D[]) => [[0, 0], [0.04, 0.03], [-0.03, -0.04]].every(([ox, oz]) => {
      capsule.start.set(x + ox, base + BODY_RADIUS, z + oz); capsule.end.set(x + ox, base + BODY_HEIGHT - BODY_RADIUS, z + oz)
      return world.fits(capsule, ignored)
    })
    const blocked = (x: number, base: number, z: number) => !fits(x, base, z, []) && fits(x, base, z, [solids])
    const walker = new EnemyNavigation(world, [], () => {})
    const walks = () => {
      const start = walker.floor(a.clone()), end = walker.floor(b.clone())
      return !!start && !!end && walker.segment(start, end)
    }
    const unlink = (index: number, d: number) => {
      if (this.masks[index] & (1 << d)) { this.masks[index] &= ~(1 << d); cut.masks.push([index, d]) }
    }
    const areas: [number, number, number, number][] = []
    for (const solid of solids.children) {
      box.setFromObject(solid).expandByScalar(BODY_RADIUS + 0.05)
      const area: [number, number, number, number] = [Math.floor((box.min.x - this.minX) / this.cell), Math.floor((box.max.x - this.minX) / this.cell),
        Math.floor((box.min.z - this.minZ) / this.cell), Math.floor((box.max.z - this.minZ) / this.cell)]
      areas.push(area)
      for (let i = area[0]; i <= area[1]; i++) for (let k = area[2]; k <= area[3]; k++) {
        const index = this.index(i, k)
        if (!this.walkable(index) || gone.has(index)) continue
        this.point(index, a)
        if (!blocked(a.x, a.y + 0.024, a.z)) continue
        gone.add(index)
        cut.heights!.push([index, this.heights[index]])
        for (let d = 0; d < 8; d++) {
          const [di, dk] = DIRECTIONS[d], next = this.index(i + di, k + dk)
          unlink(index, d)
          if (next >= 0) unlink(next, DIRECTIONS.findIndex(([x, z]) => x === -di && z === -dk))
        }
      }
    }
    for (const [index] of cut.heights!) this.heights[index] = NaN
    // The steps from each spot round a solid (one cell further out: a step is a cell long).
    const steps: [number, number, number, number][] = []
    for (const [i0, i1, k0, k1] of areas) for (let i = i0 - 1; i <= i1 + 1; i++) for (let k = k0 - 1; k <= k1 + 1; k++) {
      const index = this.index(i, k)
      if (!this.walkable(index)) continue
      for (let d = 0; d < 8; d++) {
        const [di, dk] = DIRECTIONS[d], next = this.index(i + di, k + dk)
        if (!(this.masks[index] & (1 << d)) || !this.walkable(next)) continue
        this.point(index, a); this.point(next, b)
        const base = Math.max(a.y, b.y) + MAX_STEP * 0.7
        if (![0.25, 0.5, 0.75].some(t => { q.copy(a).lerp(b, t); return blocked(q.x, base, q.z) }) || walks()) continue
        const back = DIRECTIONS.findIndex(([x, z]) => x === -di && z === -dk)
        unlink(index, d); unlink(next, back)
        steps.push([index, d, next, back])
      }
    }
    const now = this.regions().id, joined = new Map<number, number>()
    const find = (r: number): number => { const up = joined.get(r); return up === undefined ? r : find(up) }
    for (const [index, d, next, back] of steps) {
      if (was[index] !== was[next] || find(now[index]) === find(now[next])) continue
      this.masks[index] |= 1 << d; this.masks[next] |= 1 << back
      joined.set(find(now[index]), find(now[next]))
    }
    for (const [from, edges] of this.edges) {
      const keep = edges.filter(edge => {
        if (!gone.has(from) && !gone.has(edge.to)) return true
        cut.edges.push([from, edge])
        return false
      })
      if (keep.length !== edges.length) this.edges.set(from, keep)
    }
    const key = this.nextGap++
    this.gaps.set(key, cut)
    return key
  }

  /** Restore what closeGap(key) cut. */
  openGap(key: number) {
    const cut = this.gaps.get(key)
    if (!cut) return
    this.gaps.delete(key)
    for (const [index, d] of cut.masks) this.masks[index] |= 1 << d
    for (const [index, height] of cut.heights ?? []) this.heights[index] = height
    for (const [slot, next] of cut.raised) this.raisedNext[slot] = next
    for (const [from, edge] of cut.edges) this.edges.get(from)?.push(edge) ?? this.edges.set(from, [edge])
  }

  /** True when `from` to `to` is a plain grid step (safe to cut straight across when smoothing). */
  plainStep(from: number, to: number) { return !this.edges.get(from)?.some(e => e.to === to) }

  /**
   * The walkable spot nearest to a position on roughly the same level (within `reach` metres up or down).
   * The 3 x 3 cells around it are always searched (the nearest spot is often in the next cell, not the
   * position's own); further rings, up to `rings`, only until something turns up. A spot on another level
   * (the guardroom floor over someone on the cell block stairs) loses to one a ring further out on their
   * own level. `clear` may refuse spots (the director refuses one behind a wall): the nearest it accepts
   * wins, or the nearest of all if it accepts none.
   */
  nearest(position: THREE.Vector3, rings = 3, reach = 2.2, clear?: (spot: number, from: THREE.Vector3) => boolean) {
    const ci = Math.floor((position.x - this.minX) / this.cell), ck = Math.floor((position.z - this.minZ) / this.cell)
    let best = -1, bestScore = Infinity, bestRise = 0, last = rings
    const spot = this.scratchA, found = this.found, scores = this.foundScores
    found.length = 0; scores.length = 0
    const consider = (index: number) => {
      this.point(index, spot)
      const dy = Math.abs(spot.y - position.y)
      if (dy > reach) return
      const x = spot.x - position.x, z = spot.z - position.z
      const score = x * x + z * z + dy * dy * 4
      if (clear) { found.push(index); scores.push(score) }
      if (score < bestScore) { best = index; bestScore = score; bestRise = dy }
    }
    for (let r = 0; r <= last; r++) {
      if (r >= 2 && best >= 0) {
        if (bestRise <= 0.6) break
        last = Math.min(last, r)
      }
      for (let i = ci - r; i <= ci + r; i++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(k - ck)) !== r) continue
        const index = this.index(i, k)
        if (index < 0) continue
        if (this.walkable(index)) consider(index)
        const above = this.raisedIn.get(index)
        if (above) for (const raised of above) consider(raised)
      }
    }
    if (!clear || best < 0 || clear(best, position)) return best
    const order = found.map((_, n) => n).sort((p, q) => scores[p] - scores[q])
    for (const n of order) if (found[n] !== best && clear(found[n], position)) return found[n]
    return best
  }

  /**
   * flow()'s starts for a player off the graph: every spot within two cells, in reach, that a zombie gets
   * at them from: close enough to swipe, or right under them (it clambers up to them, up to PERCH.up) or
   * over them (it drops down, up to PERCH.down). Height counts half again, so the spot right under them
   * beats one further off. Returns how many there were.
   */
  private seedAround(source: THREE.Vector3, clear?: (spot: number, from: THREE.Vector3) => boolean) {
    const ci = Math.floor((source.x - this.minX) / this.cell), ck = Math.floor((source.z - this.minZ) / this.cell)
    const p = this.scratchB
    let seeded = 0
    const seed = (index: number) => {
      this.point(index, p)
      const below = source.y - p.y, flat = Math.hypot(p.x - source.x, p.z - source.z)
      const swipe = flat <= PERCH.swipe && Math.abs(below) <= 1.2
      const perch = flat <= PERCH.beside && ((below > 1.2 && below <= PERCH.up) || (below < -1.3 && -below <= PERCH.down))
      if (!(swipe || perch) || (clear && !clear(index, source))) return
      const d = flat + Math.abs(below) * 1.5
      if (d < this.dist[index]) { this.dist[index] = d; this.heap.push(index, d) }
      seeded++
    }
    for (let i = ci - 2; i <= ci + 2; i++) for (let k = ck - 2; k <= ck + 2; k++) {
      const index = this.index(i, k)
      if (index < 0) continue
      if (this.walkable(index)) seed(index)
      for (const level of this.raisedIn.get(index) ?? []) seed(level)
    }
    return seeded
  }

  /**
   * Walking distance from every spot to the nearest of `sources` (players). Afterwards `distance(i)`
   * reads it and `downhill(i)` gives the next spot toward that player.
   */
  flow(sources: readonly THREE.Vector3[], clear?: (spot: number, from: THREE.Vector3) => boolean) {
    const dist = this.dist, a = this.scratchA, b = this.scratchB
    dist.fill(Infinity)
    this.heap.clear()
    for (const source of sources) {
      // A player somewhere the graph does not reach still draws the horde to the closest spot there is:
      // from there a zombie walks straight at them, or claws at them over whatever is in the way.
      let start = this.nearest(source, 3, 2.2, clear)
      if (start < 0) start = this.nearest(source, 6, 6, clear)
      if (start < 0) continue
      const d = this.point(start, a).distanceTo(source)
      // Not standing on it: they are up on something (a fence rail, a sill) or down in a hole. The flow
      // starts from the spots a zombie gets at them from, if there are any, rather than the nearest one
      // (the top of a container across a gap from a rail, where it could only stand and stare).
      if ((Math.hypot(a.x - source.x, a.z - source.z) > 1 || Math.abs(a.y - source.y) > 0.5) && this.seedAround(source, clear)) continue
      if (d < dist[start]) { dist[start] = d; this.heap.push(start, d) }
    }
    while (this.heap.length) {
      const node = this.heap.pop(), d = this.heap.poppedKey
      if (d > dist[node]) continue
      this.point(node, a)
      if (node < this.cells) {
        const i = Math.floor(node / this.nz), k = node % this.nz, mask = this.masks[node]
        for (let dir = 0; dir < 8; dir++) {
          if (!(mask & (1 << dir))) continue
          const next = (i + DIRECTIONS[dir][0]) * this.nz + k + DIRECTIONS[dir][1]
          const nd = d + a.distanceTo(this.point(next, b))
          if (nd < dist[next]) { dist[next] = nd; this.heap.push(next, nd) }
        }
      } else {
        for (let dir = 0, base = (node - this.cells) * 8; dir < 8; dir++) {
          const next = this.raisedNext[base + dir]
          if (next < 0) continue
          const nd = d + a.distanceTo(this.point(next, b))
          if (nd < dist[next]) { dist[next] = nd; this.heap.push(next, nd) }
        }
      }
      const edges = this.edges.get(node)
      if (edges) for (const edge of edges) {
        // The zombie walks this edge the other way, from edge.to toward the player at node: a climb
        // is uphill for it when node is the higher end.
        const cost = edge.link.kind !== 'climb' ? edge.length
          : edge.length * (this.height(node) > this.height(edge.to) ? CLIMB_COST.up : CLIMB_COST.down)
        const nd = d + cost
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
      geometry: this.geometry,
      raised: this.raised.flatMap(r => [r.cell, Math.round(r.x * 100), Math.round(r.y * 100), Math.round(r.z * 100), r.mask]) }
  }

  static fromData(data: NavData) {
    if (data.version !== NAV_VERSION) throw new Error(`navigation data version ${data.version}, expected ${NAV_VERSION}`)
    const raw = fromBase64(data.heights), cm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)
    const heights = new Float32Array(cm.length)
    for (let i = 0; i < cm.length; i++) heights[i] = cm[i] === NONE ? NaN : cm[i] / 100
    const raised: RaisedSpot[] = []
    for (let i = 0; i + 4 < data.raised.length; i += 5)
      raised.push({ cell: data.raised[i], x: data.raised[i + 1] / 100, y: data.raised[i + 2] / 100, z: data.raised[i + 3] / 100, mask: data.raised[i + 4] })
    return new NavGraph(data.cell, data.minX, data.minZ, data.nx, data.nz, heights, fromBase64(data.masks), data.links, data.geometry, raised)
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
   * Build from collision geometry, in these passes:
   * 1. Spots: floor under it and a whole body fits.
   * 2. Grid links: small steps pass a quick knee-and-chest ray test; steps, ramps and anything the rays
   *    reject get the guards' own fine walk test. Diagonals never cut a corner. Doorways get links.
   *    A step too high to walk but low enough to vault, with nothing standing between, is a climb link.
   * 3. Raised spots: from each ladder top and zip line landing, out over the surface up there. Ladders
   *    become climb links from the bottom rung to the deck.
   * 4. Pockets: any region the grid could not reach (narrow stairs are the usual reason) asks the
   *    guards' fine route planner for a way to the main region, and stores it as a link with waypoints.
   * Seconds of work: run it offline (scripts/build-navgraph.ts).
   */
  static build(world: CollisionWorld, bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    doors: readonly THREE.Object3D[], geometry = '', cell = CELL, log: (message: string) => void = () => {},
    ways: RaisedWays = { climbs: [], seeds: [] }) {
    const nx = Math.ceil((bounds.maxX - bounds.minX) / cell), nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell)
    const heights = new Float32Array(nx * nz).fill(NaN)
    // A body standing exactly in the plane of a paper-thin fence reads as clear to the collision test,
    // and fences run along round coordinates where spot centres sit: such a spot would link both sides
    // of the fence. So a body is also tested a hair to either side.
    const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), BODY_RADIUS)
    const bodyFits = (x: number, base: number, z: number) => {
      for (const [ox, oz] of [[0, 0], [0.04, 0.03], [-0.03, -0.04]]) {
        capsule.start.set(x + ox, base + BODY_RADIUS, z + oz); capsule.end.set(x + ox, base + BODY_HEIGHT - BODY_RADIUS, z + oz)
        if (!world.fits(capsule)) return false
      }
      return true
    }
    const probe = new THREE.Vector3()
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      const x = bounds.minX + (i + 0.5) * cell, z = bounds.minZ + (k + 0.5) * cell
      const h = world.floor(probe.set(x, GRID_WINDOW.high, z), 0, GRID_WINDOW.high - GRID_WINDOW.low, BODY_RADIUS * 0.95)
      if (Number.isFinite(h) && bodyFits(x, h + 0.024, z)) heights[i * nz + k] = h
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
    // Sight lines alone pass straight through wire fences (you can see and shoot through them), so a
    // body is swept between the two spots as well: capsules 0.4 m apart, overlapping, from knee height.
    const along = new THREE.Vector3()
    const bodyClear = (base: number) => {
      for (const t of [0.25, 0.5, 0.75]) {
        along.copy(a).lerp(b, t)
        if (!bodyFits(along.x, base, along.z)) return false
      }
      return true
    }
    // Both ways: a closed shape (a fuel tank, a solid step block) only blocks from outside, so from inside
    // a sight line and a body both pass through its wall.
    const seen = (p: THREE.Vector3, q: THREE.Vector3) => world.visible(p, q, ignore) && world.visible(q, p, ignore)
    const raysClear = () => {
      for (const lift of [0.45, 1.3]) if (!seen(a.clone().setY(a.y + lift), b.clone().setY(b.y + lift))) return false
      return bodyClear(Math.max(a.y, b.y) + MAX_STEP * 0.7)
    }
    // A ledge rather than a wall: at the higher spot's level nothing stands between the two.
    const ledgeClear = () => {
      const top = Math.max(a.y, b.y)
      for (const lift of [0.45, 1.3]) if (!seen(a.clone().setY(top + lift), b.clone().setY(top + lift))) return false
      return bodyClear(top + 0.08)
    }
    const vaults: [number, number][] = []
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
        if (!(flat && raysClear()) && !walks(a.clone(), b.clone())) {
          // Too high to step, low enough to vault: the 0.6 m slabs the warehouses stand on, crates.
          if (!flat && !(di && dk) && ledgeClear()) vaults.push([i * nz + k, ii * nz + kk])
          continue
        }
        masks[i * nz + k] |= 1 << d
        masks[ii * nz + kk] |= 1 << DIRECTIONS.findIndex(([x, z]) => x === -di && z === -dk)
      }
      // A cell straddling a ledge's edge has no level footing, so the spots either side of the edge are
      // two cells apart, not neighbours: vault across the gap when there is floor under it.
      for (let d = 0; d < 4; d++) {
        const [di, dk] = DIRECTIONS[d], ii = i + 2 * di, kk = k + 2 * dk
        if (ii * nz + kk < i * nz + k || !Number.isNaN(at(i + di, k + dk))) continue
        const h2 = at(ii, kk)
        if (Number.isNaN(h2) || Math.abs(h2 - h) <= MAX_STEP || Math.abs(h2 - h) > MAX_CLIMB) continue
        place(i * nz + k, a); place(ii * nz + kk, b)
        const edge = a.clone().lerp(b, 0.5)
        const footing = world.floor(edge.setY(Math.max(h, h2) + 0.3), 0.3, Math.abs(h2 - h) + 0.3)
        if (Number.isFinite(footing) && ledgeClear()) vaults.push([i * nz + k, ii * nz + kk])
      }
    }
    // Raised surfaces: walk out from every ladder top and zip line landing over whatever a body can
    // stand on up there, one spot per cell, stopping at edges (a drop is not a way down) and joining the
    // ground grid where stairs reach it.
    const raised: RaisedSpot[] = []
    const raisedIn = new Map<number, number[]>()
    const joins: [number, number][] = []
    const findRaised = (index: number, y: number) => (raisedIn.get(index) ?? []).find(r => Math.abs(raised[r].y - y) < 0.35) ?? -1
    /** Where a body stands in cell (i, k) on the highest floor from `above` over `y` down to 1.6 m under it. */
    const standAt = (i: number, k: number, y: number, first?: THREE.Vector3, above = 0.8) => {
      const cx = bounds.minX + (i + 0.5) * cell, cz = bounds.minZ + (k + 0.5) * cell
      const samples: [number, number][] = [[cx, cz], [cx + 0.4, cz], [cx - 0.4, cz], [cx, cz + 0.4], [cx, cz - 0.4]]
      if (first) samples.unshift([first.x, first.z])
      for (const [x, z] of samples) {
        const h = world.floor(probe.set(x, y, z), above, MAX_CLIMB + 0.2, BODY_RADIUS * 0.95)
        if (Number.isFinite(h) && bodyFits(x, h + 0.024, z)) return new THREE.Vector3(x, h, z)
      }
      return null
    }
    const connects = (p: THREE.Vector3, q: THREE.Vector3) => {
      a.copy(p); b.copy(q)
      if (Math.abs(p.y - q.y) <= MAX_STEP && raysClear()) return true
      return walks(p.clone(), q.clone())
    }
    const queue: number[] = []
    const addRaised = (index: number, spot: THREE.Vector3) => {
      raised.push({ cell: index, x: spot.x, y: spot.y, z: spot.z, mask: 0 })
      const r = raised.length - 1
      raisedIn.set(index, [...(raisedIn.get(index) ?? []), r])
      queue.push(r)
      return r
    }
    for (const seed of ways.seeds) {
      const i = Math.floor((seed.x - bounds.minX) / cell), k = Math.floor((seed.z - bounds.minZ) / cell)
      if (i < 0 || k < 0 || i >= nx || k >= nz) continue
      const index = i * nz + k
      if (Math.abs(heights[index] - seed.y) < 0.35 || findRaised(index, seed.y) >= 0) continue
      const spot = standAt(i, k, seed.y + 0.3, seed)
      if (spot) addRaised(index, spot)
      else log(`  no standing room at raised seed ${seed.toArray().map(n => n.toFixed(1)).join(',')}`)
    }
    // Solid under the whole body, not just somewhere under it: a container lid or a roof, never the top
    // of a wall or fence (a zombie climbing a zone fence would walk over into a zone still shut).
    const footing = (x: number, top: number, z: number) => {
      const r = BODY_RADIUS * 0.9
      for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
        const floor = world.floor(probe.set(x + ox, top + 0.1, z + oz), 0, 0.35)
        if (!Number.isFinite(floor) || Math.abs(floor - top) > 0.25) return false
      }
      return true
    }
    // Ledges: flat tops a body fits on, 1.4 to 3.4 m above the ground next to them (containers, crate
    // stacks, sheds). Seeded here so the same walk-out finds the whole top; wall-climb links reach them.
    const furnish = (index: number, ground: number) => {
      const i = Math.floor(index / nz), k = index % nz
      const cx = bounds.minX + (i + 0.5) * cell, cz = bounds.minZ + (k + 0.5) * cell
      // Indoors the ceiling would answer a probe from above first, so furniture is looked for from just
      // over its own height.
      // A desk is narrower than a grid cell, so look across the cell for a place solidly on its top.
      furniture: for (const ox of [0, -0.4, 0.4, -0.2, 0.2, -0.6, 0.6]) for (const oz of [0, -0.4, 0.4, -0.2, 0.2, -0.6, 0.6]) {
        const x = cx + ox, z = cz + oz
        const low = world.floor(probe.set(x, ground + FURNITURE.high + 0.05, z), 0, FURNITURE.high - FURNITURE.low + 0.05)
        if (!Number.isFinite(low) || low - ground < FURNITURE.low || findRaised(index, low) >= 0) continue
        if (bodyFits(x, low + 0.024, z) && footing(x, low, z)) { addRaised(index, new THREE.Vector3(x, low, z)); break furniture }
      }
      const top = world.floor(probe.set(cx, ground + WALL_CLIMB.high + 0.1, cz), 0, WALL_CLIMB.high - WALL_CLIMB.low + 0.1, BODY_RADIUS * 0.95)
      if (!Number.isFinite(top) || top - ground < WALL_CLIMB.low || findRaised(index, top) >= 0) return
      if (bodyFits(cx, top + 0.024, cz) && footing(cx, top, cz)) addRaised(index, new THREE.Vector3(cx, top, cz))
    }
    // Cells and levels already searched for furniture and ledges.
    const furnished = new Set<number>()
    const furnishedKey = (index: number, y: number) => index * 64 + Math.round(y * 2) + 32
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      let ground = heights[i * nz + k]
      if (Number.isNaN(ground)) {
        for (const [di, dk] of DIRECTIONS) { const h = at(i + di, k + dk); if (!Number.isNaN(h)) { ground = h; break } }
        if (Number.isNaN(ground)) continue
      }
      furnished.add(furnishedKey(i * nz + k, ground))
      furnish(i * nz + k, ground)
    }
    // Floors the ground grid cannot see: where a ground spot's neighbour holds a floor beyond the grid's
    // probe window (the stairwell down to the cell block, a stair up to a floor above) or on another level
    // than the grid spot there, step onto it. The walk-out then follows that floor wherever it goes (the
    // whole basement under the guardroom) and joins the grid again where it comes back up.
    const seedFloorsOffGrid = () => {
      const found = new Set<number>(), here = new THREE.Vector3()
      const seed = (next: number, there: THREE.Vector3, index: number) => {
        let r = findRaised(next, there.y)
        if (r < 0) {
          if (!connects(here, there)) return
          r = addRaised(next, there)
          found.add(r)
        } else if (!connects(here, new THREE.Vector3(raised[r].x, raised[r].y, raised[r].z))) return
        joins.push([r, index])
      }
      for (let index = 0; index < nx * nz; index++) {
        const h = heights[index]
        if (Number.isNaN(h)) continue
        const i = Math.floor(index / nz), k = index % nz
        place(index, here)
        for (const [di, dk] of DIRECTIONS) {
          const ii = i + di, kk = k + dk
          if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue
          const next = ii * nz + kk, grid = heights[next]
          // A neighbour on the grid at about this level has nothing new to show.
          if (!Number.isNaN(grid) && Math.abs(grid - h) <= MAX_STEP) continue
          // Another level than the grid's: beyond its probe window, or over or under the grid spot there.
          const there = standAt(ii, kk, h + 0.3)
          if (there && Math.abs(there.y - h) <= MAX_CLIMB) {
            const beyond = there.y < GRID_WINDOW.low - 0.02 || there.y > GRID_WINDOW.high + 0.02
            if (!(Number.isNaN(grid) ? !beyond && Math.abs(there.y - h) < 0.35 : Math.abs(there.y - grid) < 0.35)) seed(next, there, index)
          }
          // This level where only the cell's centre is blocked: a strip between a fence and a wall too narrow
          // for the grid, a nook behind a counter. Players hide in them; the walk-out follows them along.
          if (Number.isNaN(grid)) {
            const beside = standAt(ii, kk, h + 0.3, undefined, MAX_STEP - 0.25)
            if (beside && Math.abs(beside.y - h) < 0.35) seed(next, beside, index)
          }
        }
      }
      return found
    }
    // Those floors get what the ground gets: furniture and ledges to climb (the bunks in the cells).
    const furnishFloor = (r: number) => {
      const spot = raised[r], i = Math.floor(spot.cell / nz), k = spot.cell % nz
      for (const [di, dk] of [[0, 0], ...DIRECTIONS]) {
        const ii = i + di, kk = k + dk
        if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue
        const key = furnishedKey(ii * nz + kk, spot.y)
        if (furnished.has(key)) continue
        furnished.add(key)
        furnish(ii * nz + kk, spot.y)
      }
    }
    const floors = seedFloorsOffGrid()
    // Every step made between two level spots, as [from, direction, to].
    const steps: [number, number, number][] = []
    while (queue.length && raised.length < 20000) {
      const r = queue.shift()!, from = raised[r]
      const i = Math.floor(from.cell / nz), k = from.cell % nz
      const here = new THREE.Vector3(from.x, from.y, from.z)
      if (floors.has(r)) furnishFloor(r)
      for (let d = 0; d < 8; d++) {
        const [di, dk] = DIRECTIONS[d], ii = i + di, kk = k + dk
        if (ii < 0 || kk < 0 || ii >= nx || kk >= nz || from.mask & (1 << d)) continue
        const next = ii * nz + kk
        let there = standAt(ii, kk, from.y + 0.3)
        // On a floor walked to from the ground, furniture must not hide the floor beside it (a bunk in a
        // cell): if the highest thing there cannot be walked onto, look again just over this floor.
        if (there && floors.has(r) && Math.abs(there.y - from.y) > MAX_STEP && !connects(here, there)) there = standAt(ii, kk, from.y + 0.3, undefined, MAX_STEP - 0.25)
        if (!there || Math.abs(there.y - from.y) > MAX_CLIMB) continue
        if (Math.abs(heights[next] - there.y) < 0.35) {
          if (connects(here, place(next, new THREE.Vector3()))) joins.push([r, next])
          continue
        }
        let other = findRaised(next, there.y)
        if (other >= 0) {
          if (!connects(here, new THREE.Vector3(raised[other].x, raised[other].y, raised[other].z))) continue
        } else {
          if (!connects(here, there)) continue
          other = addRaised(next, there)
          if (floors.has(r)) floors.add(other)
        }
        from.mask |= 1 << d
        raised[other].mask |= 1 << BACK[d]
        steps.push([r, d, other])
      }
    }
    // A step is stored as a mask bit, which reads back as "the spot in the next cell nearest in height"
    // (nearestLevel). Where a cell holds several levels (stairs, a floor under a bunk) that can be another
    // spot than the one stepped to, or the way back can lead elsewhere: those steps are stored as links.
    for (const spot of raised) spot.mask = 0
    const readBack = (r: number, d: number) => {
      const spot = raised[r], ii = Math.floor(spot.cell / nz) + DIRECTIONS[d][0], kk = spot.cell % nz + DIRECTIONS[d][1]
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) return -1
      return nearestLevel(raisedIn.get(ii * nz + kk), other => raised[other].y, spot.y, MAX_CLIMB)
    }
    const stepLinks: [number, number][] = []
    for (const [r, d, other] of steps) {
      if (readBack(r, d) === other && readBack(other, BACK[d]) === r) { raised[r].mask |= 1 << d; raised[other].mask |= 1 << BACK[d] }
      else stepLinks.push([r, other])
    }
    log(`${raised.length} raised spots from ${ways.seeds.length} seeds, ${floors.size} of them on floors off the ground grid, ${joins.length} joins to the ground, ${vaults.length} vaults, ${stepLinks.length} steps between stacked levels`)
    const graph = new NavGraph(cell, bounds.minX, bounds.minZ, nx, nz, heights, masks, [], geometry, raised)
    for (const [r, other] of stepLinks) graph.addLink({ a: graph.cells + r, b: graph.cells + other })
    for (const [r, ground] of joins) graph.addLink({ a: graph.cells + r, b: ground })
    for (const [low, high] of vaults) graph.addLink({ a: low, b: high, kind: 'climb' })
    // Wall climbs: from a ground spot up the face of whatever it stands beside onto the raised spot above,
    // when the column is clear (no overhang). One per raised spot and direction, only at edges.
    const wallClimb = (ground: THREE.Vector3, top: THREE.Vector3) => {
      const dx = top.x - ground.x, dz = top.z - ground.z, span = Math.hypot(dx, dz)
      if (span < 0.2) return null
      const ux = dx / span, uz = dz / span
      // The foot of the wall: the last place on the way that a standing body still fits.
      let foot: THREE.Vector3 | null = null
      for (let t = 0.1; t <= span + 0.05; t += 0.1) {
        const p = new THREE.Vector3(ground.x + ux * t, ground.y, ground.z + uz * t)
        if (!bodyFits(p.x, ground.y + 0.05, p.z)) break
        foot = p
      }
      if (!foot || foot.distanceTo(ground) > span - 0.2) return null
      // Nothing overhanging all the way up.
      for (let h = ground.y + 0.5; h < top.y; h += 0.6) if (!bodyFits(foot.x, h, foot.z)) return null
      if (!bodyFits(foot.x, top.y + 0.05, foot.z)) return null
      // Over the edge onto the top, with nothing in the way at that height (the climb has no collision: a
      // counter behind a wall was climbed onto from outside, straight through the wall, and a wire fence,
      // which sight lines pass, was climbed through onto the slab behind it).
      for (let t = 0.15; t <= 2.4; t += 0.15) {
        const p = new THREE.Vector3(foot.x + ux * t, top.y, foot.z + uz * t)
        if (!seen(foot.clone().setY(top.y + 0.6), p.clone().setY(top.y + 0.6)) || !seen(foot.clone().setY(top.y + 1.3), p.clone().setY(top.y + 1.3))) return null
        if (!bodyFits(p.x, top.y + 0.05, p.z)) return null
        const floor = world.floor(p, 0.5, 0.5, BODY_RADIUS * 0.8)
        if (Number.isFinite(floor) && Math.abs(floor - top.y) < 0.3 && bodyFits(p.x, floor + 0.024, p.z) && footing(p.x, floor, p.z))
          return [foot.x, ground.y + 0.024, foot.z, foot.x, top.y + 0.05, foot.z, p.x, floor + 0.024, p.z]
      }
      return null
    }
    let wallClimbs = 0
    const aboveGround = new THREE.Vector3(), below = new THREE.Vector3()
    // What a climb starts from in a cell: its ground spot, and any floor off the grid there (the cell
    // block floor under a bunk).
    const bases = (index: number) => {
      const out = graph.walkable(index) ? [index] : []
      for (const r of raisedIn.get(index) ?? []) if (floors.has(r)) out.push(graph.cells + r)
      return out
    }
    for (let r = 0; r < raised.length; r++) {
      const spot = raised[r], i = Math.floor(spot.cell / nz), k = spot.cell % nz
      directions: for (let d = 0; d < 4; d++) {
        if (spot.mask & (1 << d)) continue
        for (const reach of [1, 2]) {
          const index = graph.index(i + DIRECTIONS[d][0] * reach, k + DIRECTIONS[d][1] * reach)
          if (index < 0) continue
          for (const base of bases(index)) {
            const rise = spot.y - graph.height(base)
            if (rise < FURNITURE.low || rise > WALL_CLIMB.high) continue
            const via = wallClimb(graph.point(base, below), aboveGround.set(spot.x, spot.y, spot.z))
            if (!via) continue
            graph.addLink({ a: base, b: graph.cells + r, kind: 'climb', via })
            wallClimbs++
            continue directions
          }
        }
      }
    }
    log(`${wallClimbs} wall climbs onto ledges and low roofs`)
    for (const climb of ways.climbs) {
      // Climbed from the nearest ground spot a body can actually walk to the bottom rung from: tower
      // legs and bracing crowd the foot of a ladder, so the very nearest spot can be boxed in.
      const ci = Math.floor((climb.bottom.x - bounds.minX) / cell), ck = Math.floor((climb.bottom.z - bounds.minZ) / cell)
      const around: number[] = []
      for (let i = ci - 2; i <= ci + 2; i++) for (let k = ck - 2; k <= ck + 2; k++) {
        const index = graph.index(i, k)
        if (graph.walkable(index) && Math.abs(heights[index] - climb.bottom.y) < 0.6) around.push(index)
      }
      around.sort((p, q) => place(p, a).distanceToSquared(climb.bottom) - place(q, b).distanceToSquared(climb.bottom))
      const bottom = around.find(index => walks(place(index, new THREE.Vector3()), climb.bottom.clone())) ?? -1
      const top = graph.nearest(climb.top)
      if (bottom < 0 || top < 0 || bottom === top) { log(`  ladder at ${climb.bottom.toArray().map(n => n.toFixed(1)).join(',')} has no spot at ${bottom < 0 ? 'the bottom' : 'the top'}`); continue }
      graph.addLink({ a: bottom, b: top, kind: 'climb', via: [climb.bottom, ...climb.via, climb.top].flatMap(v => [v.x, v.y, v.z]) })
    }
    // Doorways: link spots on opposite sides whose connecting line passes through the opening.
    const centre = new THREE.Vector3(), flatCentre = new THREE.Vector3(), closest = new THREE.Vector3()
    for (const door of doors) {
      door.getWorldPosition(centre)
      flatCentre.copy(centre).setY(0)
      const ci = Math.floor((centre.x - bounds.minX) / cell), ck = Math.floor((centre.z - bounds.minZ) / cell)
      const near: number[] = []
      for (let i = ci - 2; i <= ci + 2; i++) for (let k = ck - 2; k <= ck + 2; k++) {
        const index = i * nz + k
        if (i < 0 || k < 0 || i >= nx || k >= nz) continue
        if (!Number.isNaN(heights[index]) && Math.abs(heights[index] - centre.y) <= 1.2) near.push(index)
        // Doors on other levels too: the cell doors down in the cell block, a roof hatch.
        for (const r of raisedIn.get(index) ?? []) if (Math.abs(raised[r].y - centre.y) <= 1.2) near.push(graph.cells + r)
      }
      for (const p of near) for (const q of near) {
        if (q <= p) continue
        graph.point(p, a); graph.point(q, b)
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
        graph.point(p, a)
        let best = -1, bestDistance = 25
        for (const q of mainSpots) {
          graph.point(q, b)
          // Ground pockets pair with the ground; the fine planner keeps to one level, so a level spot only
          // pairs with spots on its own level.
          if (p < graph.cells ? q >= graph.cells : Math.abs(b.y - a.y) > 1.2) continue
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
        const from = graph.point(p, new THREE.Vector3())
        if (tried.some(t => t.distanceTo(from) < spacing)) continue
        tried.push(from)
        const start = walker.floor(from.clone()), end = walker.floor(graph.point(q, b).clone())
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
    return graph.connectedWhole(log)
  }

  /**
   * The graph without whatever no way leads into: only the one connected whole (at bake time, with every
   * door and gate open, that is the whole map). A pocket nothing walks into (the inside of a fuel tank or
   * a container, which a body only "fits" because their walls stop things from outside only; a roof no
   * ladder or wall reaches) is worse than no spot at all: a player standing on it would start the flow
   * field in it, and no zombie could come. Off the graph, the flow starts from the spots around them.
   */
  private connectedWhole(log: (message: string) => void) {
    const { id, sizes } = this.regions()
    const main = sizes.indexOf(Math.max(...sizes))
    const heights = this.heights.slice(), masks = this.masks.slice()
    for (let s = 0; s < this.cells; s++) if (id[s] !== main) { heights[s] = NaN; masks[s] = 0 }
    const renumber = new Int32Array(this.size).fill(-1)
    for (let s = 0; s < this.cells; s++) if (id[s] === main) renumber[s] = s
    const raised: RaisedSpot[] = []
    this.raised.forEach((spot, r) => {
      if (id[this.cells + r] !== main) return
      renumber[this.cells + r] = this.cells + raised.length
      raised.push({ ...spot })
    })
    const links = this.links.filter(l => renumber[l.a] >= 0 && renumber[l.b] >= 0).map(l => ({ ...l, a: renumber[l.a], b: renumber[l.b] }))
    log(`kept the connected whole: ${sizes[main]} of ${sizes.reduce((x, y) => x + y, 0)} spots, dropped ${sizes.length - 1} pockets`)
    return new NavGraph(this.cell, this.minX, this.minZ, this.nx, this.nz, heights, masks, links, this.geometry, raised)
  }
}

/** A small binary min-heap of (node, priority). */
class MinHeap {
  // Parallel arrays that only ever grow: the flow field refills this several times a second, and emptying
  // an array by setting its length frees its storage, so every refresh used to allocate it all again.
  private nodes: number[] = []
  private keys: number[] = []
  private size = 0
  get length() { return this.size }
  clear() { this.size = 0 }
  push(node: number, key: number) {
    const nodes = this.nodes, keys = this.keys
    let i = this.size++
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      nodes[i] = nodes[parent]; keys[i] = keys[parent]
      i = parent
    }
    nodes[i] = node; keys[i] = key
  }
  /** The key of the node pop() last returned (no tuple per pop: the flow field pops thousands a refresh). */
  poppedKey = 0
  pop(): number {
    const nodes = this.nodes, keys = this.keys
    const top = nodes[0]
    this.poppedKey = keys[0]
    const n = --this.size
    const lastNode = nodes[n], lastKey = keys[n]
    if (n > 0) {
      let i = 0
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
