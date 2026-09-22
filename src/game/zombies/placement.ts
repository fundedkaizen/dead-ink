import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import type { NavGraph } from './navgraph'
import { shuffled, type Random } from '../shared/random'

/**
 * Where wall guns and the Mystery Box go, found from the map itself rather than hand-placed, so any map
 * works. A spot is a patch of floor the player can stand on, connected to the spawn (the flow field
 * must already be computed FROM the spawn: a finite walking distance means reachable), with a real
 * wall close in front of it. The ink battle royale once spawned players inside a sealed building;
 * requiring a finite walking distance from the spawn rules that out here.
 */
export type WallSpot = {
  /** Where the player stands to use it. */
  stand: THREE.Vector3
  /** The point on the wall face, and the wall's outward normal (flat, unit length). */
  wall: THREE.Vector3
  normal: THREE.Vector3
  /** Walking distance from the spawn. */
  walk: number
}

const DIRECTIONS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(Math.sin(i * Math.PI / 4), 0, Math.cos(i * Math.PI / 4)))

/** True when the hit belongs to a door leaf: a gun mounted on a door would swing away with it. */
function onDoor(mesh: THREE.Object3D) {
  for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (p.userData.doorHinge || p.userData.kind === 'door') return true
  return false
}

/**
 * Read a wall in front of a standing spot. A wall must be vertical, face the player, and be tall: the
 * ray at chest height and one at head height both hit the same plane, so railings and crates do not
 * count.
 */
export function wallFacing(world: CollisionWorld, stand: THREE.Vector3, direction: THREE.Vector3, reach = 1.3) {
  const chest = stand.clone().setY(stand.y + 1.3), head = stand.clone().setY(stand.y + 1.9)
  const low = world.raySurface(chest, direction, reach)
  if (!low || low.backFace || low.distance < 0.35 || onDoor(low.mesh)) return null
  const normal = low.normal.clone().setY(0)
  if (Math.abs(low.normal.y) > 0.2 || normal.lengthSq() < 0.5) return null
  normal.normalize()
  if (normal.dot(direction) > -0.7) return null
  const high = world.raySurface(head, direction, reach + 0.2)
  if (!high || high.backFace || Math.abs(high.distance - low.distance) > 0.12 || high.normal.clone().setY(0).normalize().dot(normal) < 0.95) return null
  if (!clearArea(world, stand, low.point, normal) || !flatFloor(world, stand, low.point, normal)) return null
  return { wall: low.point.clone(), normal, distance: low.distance }
}

/**
 * The whole face a wall gun covers must be one flat piece of wall: rays straight at it, spread over
 * the sheet's area, all land on the same plane. Two centre rays alone let a sheet overlap a window
 * sill or hang past a corner; a window opening lets a ray through, a sill stops it short.
 */
export const SHEET = { halfWidth: 0.62, bottom: 1.0, top: 1.72 } as const
function clearArea(world: CollisionWorld, stand: THREE.Vector3, wall: THREE.Vector3, normal: THREE.Vector3) {
  const into = normal.clone().negate()
  const tangent = new THREE.Vector3(normal.z, 0, -normal.x)
  const depth = wall.clone().sub(stand).dot(into)
  const origin = new THREE.Vector3()
  // A 5 x 5 grid: sparse enough to stay cheap (placement runs once), dense enough that a window corner
  // cannot slip between the samples.
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const along = -SHEET.halfWidth + i * SHEET.halfWidth / 2, height = SHEET.bottom + j * (SHEET.top - SHEET.bottom) / 4
    origin.copy(stand).addScaledVector(tangent, along).setY(stand.y + height)
    const hit = world.raySurface(origin, into, depth + 0.3)
    if (!hit || hit.backFace || onDoor(hit.mesh) || Math.abs(hit.distance - depth) > 0.06) return false
    if (hit.normal.clone().setY(0).normalize().dot(normal) < 0.95) return false
  }
  return true
}

/** Level floor along the wall in front of it, wide enough for the Mystery Box to sit on. */
export const FOOTPRINT = { halfWidth: 0.75, depth: 0.75 } as const
function flatFloor(world: CollisionWorld, stand: THREE.Vector3, wall: THREE.Vector3, normal: THREE.Vector3) {
  const tangent = new THREE.Vector3(normal.z, 0, -normal.x)
  const point = new THREE.Vector3()
  for (const along of [-FOOTPRINT.halfWidth, 0, FOOTPRINT.halfWidth]) for (const out of [0.12, FOOTPRINT.depth]) {
    point.copy(wall).addScaledVector(tangent, along).addScaledVector(normal, out).setY(stand.y + 0.5)
    const floor = world.floor(point, 0.6, 1.2, 0)
    if (!Number.isFinite(floor) || Math.abs(floor - stand.y) > 0.08) return false
  }
  return true
}

export function findWallSpots(graph: NavGraph, world: CollisionWorld, random: Random,
  options: { count: number; near: number; far: number; spacing: number; avoid?: readonly THREE.Vector3[] }): WallSpot[] {
  const candidates: number[] = []
  for (let i = 0; i < graph.cells; i++) {
    if (!graph.walkable(i)) continue
    const walk = graph.distance(i)
    if (Number.isFinite(walk) && walk >= options.near && walk <= options.far) candidates.push(i)
  }
  // Nearest first, with a little shuffle inside distance bands so the layout varies by seed but the
  // cheap guns still end up close to the spawn.
  const ordered = shuffled(random, candidates).sort((a, b) => Math.floor(graph.distance(a) / 6) - Math.floor(graph.distance(b) / 6))
  const spots: WallSpot[] = []
  const taken = [...(options.avoid ?? [])]
  const stand = new THREE.Vector3()
  for (const index of ordered) {
    if (spots.length >= options.count) break
    graph.point(index, stand)
    if (taken.some(t => Math.hypot(t.x - stand.x, t.z - stand.z) < options.spacing)) continue
    for (const direction of shuffled(random, DIRECTIONS)) {
      const facing = wallFacing(world, stand, direction)
      if (!facing) continue
      spots.push({ stand: stand.clone(), wall: facing.wall, normal: facing.normal, walk: graph.distance(index) })
      taken.push(stand.clone())
      break
    }
  }
  return spots
}
