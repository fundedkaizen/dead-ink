import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { EnemyActor } from '../actors'
import type { EnemyNavigation } from '../navigation'
import type { CollisionWorld } from '../../player/collision'
import type { BoneName } from '../../lab/rig'
import { hitDamage } from '../balance'
import { rayCapsuleDistance, type ActorHit, type HitZone } from '../hit-reactions'
import type { SoundEvent, WeaponName } from '../types'
import { penPalette } from '../../render/ballpoint'
import { BOSS, isBossRound } from './rules'
import type { NavGraph } from './navgraph'
import type { InkGore } from './gore'
import { RISE, bend, solveArm, solveLeg, type Zombie, type ZombieSnap, type ZombieTarget } from './director'

/**
 * The Brute: Dead Ink's boss, its body, its moves and what they leave behind (BOSS in rules.ts has every
 * number). The director hands a Brute's frame to this file on the host, and its snapshot row on a co-op
 * guest; everything the Brute does is drawn from its state here, so both see the same thing.
 *
 * The look is the zombies' own stickman, scaled up and built out: black muscle on its bones (a hump its
 * small head sits low in front of, heavy arms, big fists), stitched paper bandages, iron shackles with a
 * broken chain swinging from each, and a riveted iron mask over red eyes. The muscle, bandages and
 * shackles are one skinned mesh on the stickman's own skeleton: one draw call.
 */

// ---------------------------------------------------------------- rules the runtime uses

/** Whether a boss round sends a Brute: not while one is still hunting (one at a time). */
export const bruteDue = (round: number, hunting: boolean) => isBossRound(round) && !hunting
/** Zombies that hold a round open: every living one but a boss (the Brute and the Editor carry on). */
export const holdsRound = (z: Pick<Zombie, 'state' | 'boss'>) => z.state === 'chase' && !z.boss
export function roundAlive(zombies: readonly Pick<Zombie, 'state' | 'boss'>[]) {
  let n = 0
  for (const z of zombies) if (holdsRound(z)) n++
  return n
}
/** Metres a second on foot. */
export const bruteSpeed = (z: Zombie) => z.brute?.enraged ? BOSS.enragedSpeed : BOSS.speed
/** A move's wind-up and an attack's cooldown, shorter enraged. */
export const bruteWindup = (b: BruteState, seconds: number) => seconds * (b.enraged ? BOSS.enrage.windups : 1)
export const bruteCooldown = (b: BruteState, seconds: number) => seconds * (b.enraged ? BOSS.enrage.cooldowns : 1)
/** A Brute out of sight under the ground (burrowed, before it comes up). */
export const buried = (b: BruteState | null) => !!b && b.move === 'burrow' && b.t >= BOSS.burrow.sink

// ---------------------------------------------------------------- state

/** Its moves; the swing is the zombies' own (`swing`). Their order is their code in the co-op snapshot. */
const MOVES = [null, 'slam', 'charge', 'throw', 'roar', 'stun', 'burrow'] as const
export type BruteMove = Exclude<(typeof MOVES)[number], null>
/**
 * Co-op snapshot bits (bits 14 to 18 are the Brute's): its move in 14 to 16, enraged 17, the mask gone 18.
 * A boss's row also carries three more numbers: seconds into the move, 1 for the Editor, the mask's wear.
 */
export const BRUTE_BITS = { shift: 14, move: 7 << 14, enraged: 1 << 17, unmasked: 1 << 18 } as const

export type BruteState = {
  /** The quest's Editor rather than the Brute: the name on its health bar. */
  editor: boolean
  move: BruteMove | null
  /** Seconds into the move. */
  t: number
  /** A stun's length, and why: into a wall at the end of a charge, or its mask breaking. */
  stun: number
  cause: 'crash' | 'mask' | null
  /** The charge: its line (a yaw) once fixed, metres run, metres it may run, whether it has stopped (and when). */
  locked: boolean
  heading: number
  run: number
  limit: number
  stopped: number
  /** Players it has already hit on this charge. */
  hit: Set<string>
  /** The slam's fists are down; the throw's chunk is torn up, then let go. */
  struck: boolean
  torn: boolean
  released: boolean
  /** Whom the throw is for. Where the burrow comes up. */
  aimId: string
  exit: THREE.Vector3
  /** Seconds before each attack may come again; `gap` before any special at all. */
  cool: { slam: number; charge: number; throw: number; burrow: number; gap: number }
  enraged: boolean
  /** The mask's health (0: broken off), its most, and its wear shown (0 whole to 2 hanging loose). */
  mask: number
  maskMax: number
  wear: number
  /** Stuck: the best walking distance to a player, seconds without beating it, seconds with no way at all, seconds since it last fought. */
  best: number
  stall: number
  lost: number
  idle: number
  /** Seconds until it looks again for a straight run or a clear throw (both cost). */
  probe: number
  /** Metres walked, for the swing of its arms. */
  stride: number
  /** On a guest: the last row, to see what changed. */
  seen: { move: BruteMove | null; t: number; enraged: boolean; unmasked: boolean; first: boolean }
}

function freshState(maxHealth: number): BruteState {
  return {
    editor: false, move: null, t: 0, stun: 0, cause: null, locked: false, heading: 0, run: 0, limit: 0, stopped: -1, hit: new Set(),
    struck: false, torn: false, released: false, aimId: '', exit: new THREE.Vector3(),
    cool: { slam: 3, charge: 4, throw: 3, burrow: 15, gap: 1.5 }, enraged: false,
    mask: maxHealth * BOSS.mask.share, maskMax: maxHealth * BOSS.mask.share, wear: 0,
    best: Infinity, stall: 0, lost: 0, idle: 0, probe: 0, stride: 0,
    seen: { move: null, t: 0, enraged: false, unmasked: false, first: true },
  }
}

/** What the Brute needs of the director: its world, its zombies, and a few of its own abilities. */
export type BruteHost = {
  readonly world: CollisionWorld
  readonly navigation: EnemyNavigation
  readonly graph?: NavGraph
  readonly gore: InkGore
  readonly zombies: readonly Zombie[]
  emit(event: SoundEvent): void
  damagePlayer(id: string, amount: number, source: THREE.Vector3, knock?: THREE.Vector3): void
  onRise?(position: THREE.Vector3): void
  onSlam?(position: THREE.Vector3, radius: number): void
  face(z: Zombie, point: THREE.Vector3, dt: number, rate: number): number
  chase(z: Zombie, goal: THREE.Vector3, flat: number, dt: number): boolean
  canTouch(z: Zombie, feet: THREE.Vector3): boolean
  random(): number
}

// ---------------------------------------------------------------- the look

type V3 = readonly [number, number, number]
const INK = penPalette.ink, PAPER = penPalette.paper, IRON = 0x808080
const EYE = 0xd4332a, EYE_HOT = 0xff2b16
/** Its build against the stickman's, bone by bone: a short neck and small head, heavy arms, big fists, thick legs. */
const PROPORTIONS: Partial<Record<BoneName, number>> = {
  neck: 0.6, head: 1.03, 'upper_arm.L': 1.2, 'upper_arm.R': 1.2, 'forearm.L': 1.1, 'forearm.R': 1.1,
  'hand.L': 1.15, 'hand.R': 1.15, 'thigh.L': 1.05, 'thigh.R': 1.05, 'shin.L': 0.97, 'shin.R': 0.97,
}
const LEG_SCALE = BOSS.scale * (PROPORTIONS['thigh.L'] ?? 1) * (PROPORTIONS['shin.L'] ?? 1)

type Blob = { bone: BoneName; at: V3; size: V3 }
/** The right side's twin of a left-side bone and point. */
const otherSide = (bone: BoneName) => bone.replace('.L', '.R') as BoneName
const flip = (v: V3): V3 => [-v[0], v[1], v[2]]
const mirror = (parts: Blob[]): Blob[] => parts.flatMap(p => [p, { ...p, bone: otherSide(p.bone), at: flip(p.at) }])

/** Black muscle on the stickman, in its bind pose (metres, facing +Z, its left +X), each on the bone it moves with. */
const BULK: readonly Blob[] = [
  // The hump its small head sits low in front of, the traps across the shoulders, a barrel chest, the gut.
  { bone: 'chest', at: [0, 1.26, -0.09], size: [0.29, 0.21, 0.22] },
  { bone: 'chest', at: [0, 1.25, 0], size: [0.21, 0.08, 0.13] },
  { bone: 'chest', at: [0, 1.15, 0.05], size: [0.25, 0.16, 0.17] },
  { bone: 'spine', at: [0, 0.97, 0.05], size: [0.2, 0.15, 0.17] },
  { bone: 'hips', at: [0, 0.85, 0], size: [0.21, 0.13, 0.17] },
  ...mirror([
    { bone: 'upper_arm.L', at: [0.2, 1.23, 0], size: [0.13, 0.13, 0.13] },
    { bone: 'upper_arm.L', at: [0.3, 1.2, 0], size: [0.14, 0.08, 0.085] },
    { bone: 'forearm.L', at: [0.53, 1.19, 0], size: [0.14, 0.095, 0.1] },
    { bone: 'hand.L', at: [0.7, 1.2, 0], size: [0.075, 0.075, 0.07] },
    { bone: 'thigh.L', at: [0.09, 0.62, 0.01], size: [0.125, 0.21, 0.135] },
    { bone: 'shin.L', at: [0.11, 0.27, -0.02], size: [0.095, 0.16, 0.105] },
  ]),
]
/** Paper bandages stitched in ink: rings round a limb (`axis` x) or the body (`axis` y); radii across the ring. */
const BANDS: readonly { bone: BoneName; axis: 'x' | 'y'; at: V3; radius: readonly [number, number]; width: number }[] = [
  { bone: 'forearm.L', axis: 'x', at: [0.465, 1.19, 0], radius: [0.093, 0.098], width: 0.045 },
  { bone: 'forearm.L', axis: 'x', at: [0.575, 1.19, 0], radius: [0.096, 0.1], width: 0.04 },
  { bone: 'upper_arm.R', axis: 'x', at: [-0.3, 1.2, 0], radius: [0.09, 0.095], width: 0.05 },
  { bone: 'thigh.R', axis: 'y', at: [-0.09, 0.66, 0.01], radius: [0.129, 0.139], width: 0.055 },
  { bone: 'hips', axis: 'y', at: [0, 0.9, 0.02], radius: [0.206, 0.18], width: 0.06 },
]
/** Iron shackles on both wrists; the chain hangs from the eye under each. */
const SHACKLES: readonly { bone: BoneName; at: V3 }[] = [{ bone: 'forearm.L', at: [0.628, 1.19, 0] }, { bone: 'forearm.R', at: [-0.628, 1.19, 0] }]
const SHACKLE = { radius: 0.082, tube: 0.024 } as const
const CHAIN_EYE = (side: 'L' | 'R') => new THREE.Vector3(side === 'L' ? 0.628 : -0.628, 1.19 - SHACKLE.radius - SHACKLE.tube - 0.012, 0)
/** The head in the bind pose, and the mask over it. */
const HEAD_CENTRE = new THREE.Vector3(0, 1.51, 0)
const MASK = { radius: 0.236, phi: 1.2, top: 0.45, bottom: 2.25 } as const
const EYES = [new THREE.Vector3(0.075, 0.07, 0.2126), new THREE.Vector3(-0.075, 0.07, 0.2126)]
const HULL = 0.009

/** Colour every vertex, and bind it wholly to skeleton bone `bone` (skinned parts only). Non-indexed, position and colour. */
function paint(source: THREE.BufferGeometry, color: number, bone = -1) {
  const geometry = source.index ? source.toNonIndexed() : source.clone()
  for (const name of Object.keys(geometry.attributes)) if (name !== 'position') geometry.deleteAttribute(name)
  const count = geometry.getAttribute('position').count, c = new THREE.Color(color)
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3)
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (bone >= 0) {
    const index = new Uint16Array(count * 4), weight = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) { index[i * 4] = bone; weight[i * 4] = 1 }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4))
  }
  return geometry
}

/** An ink outline as geometry: the part pushed out along its normals and turned inside out, so only its rim shows. */
function hull(source: THREE.BufferGeometry, width = HULL) {
  const geometry = source.clone()
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal')
  for (let i = 0; i < position.count; i++) position.setXYZ(i, position.getX(i) + normal.getX(i) * width, position.getY(i) + normal.getY(i) * width, position.getZ(i) + normal.getZ(i) * width)
  if (geometry.index) {
    const index = geometry.index.array
    for (let i = 0; i < index.length; i += 3) { const a = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = a }
  } else {
    for (const name of Object.keys(geometry.attributes)) {
      const attribute = geometry.getAttribute(name), size = attribute.itemSize, array = attribute.array
      for (let i = 0; i < attribute.count; i += 3) for (let k = 0; k < size; k++) {
        const a = array[(i + 1) * size + k]; array[(i + 1) * size + k] = array[(i + 2) * size + k]; array[(i + 2) * size + k] = a
      }
    }
  }
  return geometry
}

/** A part and its ink outline, painted and bound. */
function outlined(geometry: THREE.BufferGeometry, color: number, bone = -1, width = HULL) {
  return [paint(geometry, color, bone), paint(hull(geometry, width), INK, bone)]
}

/** A ring of stitches across a band: short ink dashes round it. */
function stitches(axis: 'x' | 'y', at: V3, radius: readonly [number, number], width: number, bone: number) {
  const parts: THREE.BufferGeometry[] = []
  for (let k = 0; k < 10; k++) {
    const a = k / 10 * Math.PI * 2
    const dash = axis === 'x' ? new THREE.BoxGeometry(width * 0.85, 0.008, 0.008) : new THREE.BoxGeometry(0.008, width * 0.85, 0.008)
    const r0 = radius[0] + 0.004, r1 = radius[1] + 0.004
    if (axis === 'x') dash.translate(at[0], at[1] + Math.cos(a) * r0, at[2] + Math.sin(a) * r1)
    else dash.translate(at[0] + Math.cos(a) * r0, at[1], at[2] + Math.sin(a) * r1)
    parts.push(paint(dash, INK, bone))
  }
  return parts
}

/** A point on a sphere round `centre`: `theta` down from the top, `phi` round from its left (+Z is the face at phi = pi/2). */
function onSphere(centre: THREE.Vector3, radius: number, theta: number, phi: number, out = new THREE.Vector3()) {
  return out.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)).multiplyScalar(radius).add(centre)
}

function rivet(at: THREE.Vector3, radius = 0.011) {
  return paint(new THREE.SphereGeometry(radius, 6, 4).translate(at.x, at.y, at.z), INK)
}

let outfitGeometry: THREE.BufferGeometry | null = null
/** The muscle, bandages and shackles as one skinned geometry; `bone` gives each bone's index in the skeleton. */
function buildOutfit(bone: (name: BoneName) => number) {
  const parts: THREE.BufferGeometry[] = []
  for (const blob of BULK) {
    const g = new THREE.SphereGeometry(1, 18, 12).scale(...blob.size).translate(...blob.at)
    parts.push(paint(g, INK, bone(blob.bone)))
  }
  for (const band of BANDS) {
    const index = bone(band.bone)
    const g = new THREE.CylinderGeometry(1, 1, band.width, 22, 1, true)
    if (band.axis === 'x') g.scale(band.radius[0], 1, band.radius[1]).rotateZ(-Math.PI / 2)
    else g.scale(band.radius[0], 1, band.radius[1])
    g.translate(...band.at)
    parts.push(...outlined(g, PAPER, index, 0.007), ...stitches(band.axis, band.at, band.radius, band.width, index))
  }
  for (const shackle of SHACKLES) {
    const index = bone(shackle.bone), side = shackle.at[0] > 0 ? 'L' : 'R'
    const ring = new THREE.TorusGeometry(SHACKLE.radius, SHACKLE.tube, 8, 22).rotateY(Math.PI / 2).translate(...shackle.at)
    parts.push(...outlined(ring, IRON, index))
    for (let k = 0; k < 4; k++) {
      const a = (k + 0.5) / 4 * Math.PI * 2, r = SHACKLE.radius + SHACKLE.tube * 0.8
      parts.push(paint(new THREE.SphereGeometry(0.011, 6, 4).translate(shackle.at[0], shackle.at[1] + Math.cos(a) * r, shackle.at[2] + Math.sin(a) * r), INK, index))
    }
    const eye = CHAIN_EYE(side)
    parts.push(...outlined(new THREE.TorusGeometry(0.02, 0.007, 5, 10).translate(eye.x, eye.y, eye.z), IRON, index, 0.005))
  }
  return mergeGeometries(parts)!
}

let maskGeometry: THREE.BufferGeometry | null = null
/** The riveted iron mask, centred on the head (bind pose): a plate over the face, a strap over the crown, eye slits. */
function buildMask() {
  const c = new THREE.Vector3(), parts: THREE.BufferGeometry[] = []
  const plate = new THREE.SphereGeometry(MASK.radius, 26, 18, Math.PI / 2 - MASK.phi, MASK.phi * 2, MASK.top, MASK.bottom - MASK.top)
  parts.push(...outlined(plate, IRON))
  // The strap: a band of a sphere round its crown, front to back.
  const band = new THREE.SphereGeometry(MASK.radius + 0.006, 40, 32).rotateZ(Math.PI / 2).toNonIndexed()
  const keep: number[] = [], position = band.getAttribute('position')
  for (let i = 0; i < position.count; i += 3) {
    const x = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3, y = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3
    if (Math.abs(x) < 0.028 && y > -0.02) for (let k = 0; k < 3; k++) keep.push(position.getX(i + k), position.getY(i + k), position.getZ(i + k))
  }
  const strap = new THREE.BufferGeometry()
  strap.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3))
  strap.computeVertexNormals()
  parts.push(...outlined(strap, IRON, -1, 0.006))
  // Rivets round the plate's edge and along the strap.
  const p = new THREE.Vector3()
  for (let k = 0; k <= 8; k++) parts.push(rivet(onSphere(c, MASK.radius + 0.004, MASK.top + 0.05, Math.PI / 2 - MASK.phi + 0.08 + k / 8 * (MASK.phi * 2 - 0.16), p)))
  for (let k = 0; k <= 8; k++) parts.push(rivet(onSphere(c, MASK.radius + 0.004, MASK.bottom - 0.05, Math.PI / 2 - MASK.phi + 0.08 + k / 8 * (MASK.phi * 2 - 0.16), p)))
  for (const side of [-1, 1]) for (let k = 1; k < 6; k++) parts.push(rivet(onSphere(c, MASK.radius + 0.004, MASK.top + k / 6 * (MASK.bottom - MASK.top), Math.PI / 2 + side * (MASK.phi - 0.06), p)))
  for (let k = 0; k < 7; k++) {
    const a = 1.05 - k * 0.38
    parts.push(rivet(p.set(0, Math.cos(a), Math.sin(a)).multiplyScalar(MASK.radius + 0.012)))
  }
  // Eye slits, slanting down to the nose.
  for (const [i, eye] of EYES.entries()) {
    const normal = eye.clone().normalize(), sign = i === 0 ? 1 : -1
    const slit = new THREE.BoxGeometry(0.095, 0.036, 0.024).rotateZ(sign * 0.3)
    slit.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)).translate(eye.x, eye.y, eye.z)
    parts.push(paint(slit, INK))
  }
  return mergeGeometries(parts)!
}

const eyeGeometries: THREE.BufferGeometry[] = []
/** Both red eyes as one geometry, at the slits; `size` 1 normally, bigger enraged. */
function buildEyes(size: number) {
  return mergeGeometries(EYES.map((eye, i) => {
    const normal = eye.clone().normalize()
    const g = new THREE.SphereGeometry(1, 10, 8).scale(0.03 * size, 0.016 * size, 0.012).rotateZ((i === 0 ? 1 : -1) * 0.3)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal))
    const at = eye.clone().addScaledVector(normal, 0.014).add(HEAD_CENTRE)
    return paint(g.translate(at.x, at.y, at.z), 0xffffff)
  }))!
}

let chunkGeometry: THREE.BufferGeometry | null = null
/** A torn-up chunk of ground, radius about 1: a lumpy iron-grey rock with an ink outline. */
function buildChunk() {
  const base = mergeVertices(new THREE.IcosahedronGeometry(1, 1).deleteAttribute('normal').deleteAttribute('uv'))
  const position = base.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    const lump = 0.78 + 0.34 * (Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453 % 1 + 1) % 1
    position.setXYZ(i, x * lump, y * lump * 0.8, z * lump)
  }
  base.computeVertexNormals()
  return mergeGeometries(outlined(base, IRON, -1, 0.07))!
}

let linkGeometry: THREE.BufferGeometry | null = null
const LINK = { length: 0.1, links: 5 } as const

/** Shared materials: the outfit's colours, the mask's, the eyes' (calm and enraged), the chain's. */
let materials: { outfit: THREE.MeshBasicMaterial; plain: THREE.MeshBasicMaterial; eye: THREE.MeshBasicMaterial; hot: THREE.MeshBasicMaterial; iron: THREE.MeshBasicMaterial; halo: THREE.PointsMaterial } | null = null
function sharedMaterials() {
  materials ??= {
    outfit: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    plain: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    eye: new THREE.MeshBasicMaterial({ color: EYE, toneMapped: false }),
    hot: new THREE.MeshBasicMaterial({ color: EYE_HOT, toneMapped: false }),
    iron: new THREE.MeshBasicMaterial({ color: 0x5c5c5c, toneMapped: false }),
    halo: new THREE.PointsMaterial({ color: EYE_HOT, size: 0.26, map: glow(), transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: true }),
  }
  return materials
}

/** A soft round glow for the enraged eyes (none in Node, where nothing is drawn). */
function glow() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const c = canvas.getContext('2d')
  if (!c) return null
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g; c.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(canvas)
}

/** A group on `bone` whose children are placed in the bind pose's model space (the bone's inverse bind matrix). */
function mount(actor: EnemyActor, name: BoneName) {
  const skeleton = actor.rig.mesh.skeleton, bone = actor.rig.bones[name]
  const group = new THREE.Group()
  group.name = `Brute ${name}`
  group.matrixAutoUpdate = false
  group.matrix.copy(skeleton.boneInverses[skeleton.bones.indexOf(bone)])
  group.userData.noCollision = true
  bone.add(group)
  return group
}

/** A chain's joints now and a step ago (verlet), whether it hangs yet, and where its shackle was last frame. */
type Chain = { points: THREE.Vector3[]; previous: THREE.Vector3[]; ready: boolean; last: THREE.Vector3 }
/** One actor's Brute parts, made the first time it is the Brute and kept with it after. */
type Look = {
  outfit: THREE.SkinnedMesh
  head: THREE.Group
  mask: THREE.Mesh
  eyes: THREE.Mesh
  halo: THREE.Points
  held: THREE.Mesh
  chains: THREE.InstancedMesh
  links: Chain[]
  zombieEyes: THREE.Object3D[]
  mounts: { forearmL: THREE.Group; forearmR: THREE.Group }
}

function lookOf(actor: EnemyActor) { return actor.root.userData.brute as Look | undefined }

function buildLook(actor: EnemyActor): Look {
  const skeleton = actor.rig.mesh.skeleton, m = sharedMaterials()
  const index = (name: BoneName) => skeleton.bones.indexOf(actor.rig.bones[name])
  outfitGeometry ??= buildOutfit(index)
  const outfit = new THREE.SkinnedMesh(outfitGeometry, m.outfit)
  outfit.name = 'Brute build'
  outfit.frustumCulled = false
  outfit.userData.noCollision = true
  actor.rig.mesh.parent!.add(outfit)
  outfit.bind(skeleton, actor.rig.mesh.bindMatrix)
  const head = mount(actor, 'head')
  maskGeometry ??= buildMask()
  const mask = new THREE.Mesh(maskGeometry, m.plain)
  mask.name = 'Brute mask'
  mask.position.copy(HEAD_CENTRE)
  head.add(mask)
  if (!eyeGeometries.length) eyeGeometries.push(buildEyes(1), buildEyes(1.45))
  const eyes = new THREE.Mesh(eyeGeometries[0], m.eye)
  eyes.name = 'Brute eyes'
  head.add(eyes)
  const haloGeometry = new THREE.BufferGeometry().setFromPoints(EYES.map(eye => eye.clone().multiplyScalar(1.08).add(HEAD_CENTRE)))
  const halo = new THREE.Points(haloGeometry, m.halo)
  halo.name = 'Brute eye glow'
  halo.renderOrder = 3
  head.add(halo)
  const hand = mount(actor, 'hand.R')
  chunkGeometry ??= buildChunk()
  const held = new THREE.Mesh(chunkGeometry, m.plain)
  held.name = 'Brute chunk in hand'
  held.scale.setScalar(0.13)
  held.position.set(-0.74, 1.24, 0.03)
  hand.add(held)
  linkGeometry ??= new THREE.TorusGeometry(0.036, 0.01, 5, 10).scale(1, 1.55, 1)
  const chains = new THREE.InstancedMesh(linkGeometry, m.iron, LINK.links * 2)
  chains.name = 'Brute chains'
  chains.frustumCulled = false
  chains.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  actor.root.add(chains)
  const zombieEyes: THREE.Object3D[] = []
  actor.rig.bones.head.traverse(o => { if (o.name === 'Zombie eye') zombieEyes.push(o) })
  const look: Look = { outfit, head, mask, eyes, halo, held, chains, zombieEyes,
    links: [0, 1].map(() => ({ points: Array.from({ length: LINK.links + 1 }, () => new THREE.Vector3()), previous: Array.from({ length: LINK.links + 1 }, () => new THREE.Vector3()), ready: false, last: new THREE.Vector3() })),
    mounts: { forearmL: mount(actor, 'forearm.L'), forearmR: mount(actor, 'forearm.R') } }
  for (const object of [outfit, mask, eyes, halo, held, chains]) object.userData.noCollision = true
  actor.root.userData.brute = look
  return look
}

/** Dress a pooled actor as the Brute (or undress it back into an ordinary zombie). After gore's restoreParts. */
export function dressBrute(actor: EnemyActor, on: boolean) {
  let look = lookOf(actor)
  if (!look && !on) return
  look ??= buildLook(actor)
  for (const [name, scale] of Object.entries(PROPORTIONS) as [BoneName, number][]) actor.rig.bones[name].scale.setScalar(on ? scale : 1)
  for (const object of [look.outfit, look.head, look.chains]) object.visible = on
  for (const eye of look.zombieEyes) eye.visible = !on
  look.mask.visible = on
  look.mask.rotation.set(0, 0, 0); look.mask.position.copy(HEAD_CENTRE)
  look.eyes.geometry = eyeGeometries[0]; look.eyes.material = sharedMaterials().eye
  look.halo.visible = false
  look.held.visible = false
  for (const chain of look.links) chain.ready = false
}

// ---------------------------------------------------------------- hit volumes

/** Where it can be hit, in the bind pose: the stickman's own volumes and its muscle. Radii grow with each bone's scale. */
type Volume = { bone: BoneName; a: V3; b: V3; radius: number; zone: HitZone }
const LIMB_VOLUMES: Volume[] = [
  { bone: 'upper_arm.L', a: [0.19, 1.23, 0], b: [0.21, 1.23, 0], radius: 0.12, zone: 'arm' },
  { bone: 'upper_arm.L', a: [0.2, 1.2, 0], b: [0.41, 1.2, 0], radius: 0.085, zone: 'arm' },
  { bone: 'forearm.L', a: [0.42, 1.19, 0], b: [0.64, 1.19, 0], radius: 0.1, zone: 'arm' },
  { bone: 'hand.L', a: [0.7, 1.2, 0], b: [0.7, 1.2, 0], radius: 0.075, zone: 'arm' },
  { bone: 'thigh.L', a: [0.08, 0.78, 0], b: [0.1, 0.44, 0], radius: 0.125, zone: 'leg' },
  { bone: 'shin.L', a: [0.1, 0.42, 0], b: [0.13, 0.05, 0], radius: 0.095, zone: 'leg' },
]
const VOLUMES: readonly Volume[] = [
  { bone: 'head', a: [0, 1.51, 0.01], b: [0, 1.51, 0.01], radius: MASK.radius + 0.01, zone: 'head' },
  { bone: 'hips', a: [0, 0.82, 0], b: [0, 0.95, 0], radius: 0.095, zone: 'torso' },
  { bone: 'spine', a: [0, 0.95, 0], b: [0, 1.08, 0], radius: 0.105, zone: 'torso' },
  { bone: 'chest', a: [0, 1.08, 0], b: [0, 1.2, 0], radius: 0.11, zone: 'torso' },
  { bone: 'chest', a: [-0.09, 1.26, -0.09], b: [0.09, 1.26, -0.09], radius: 0.2, zone: 'torso' },
  { bone: 'chest', a: [-0.1, 1.15, 0.05], b: [0.1, 1.15, 0.05], radius: 0.16, zone: 'torso' },
  { bone: 'spine', a: [-0.06, 0.97, 0.05], b: [0.06, 0.97, 0.05], radius: 0.16, zone: 'torso' },
  { bone: 'hips', a: [-0.06, 0.85, 0], b: [0.06, 0.85, 0], radius: 0.14, zone: 'torso' },
  ...LIMB_VOLUMES.flatMap(v => [v, { ...v, bone: otherSide(v.bone), a: flip(v.a), b: flip(v.b) }]),
]

const hv = { m: new THREE.Matrix4(), a: new THREE.Vector3(), b: new THREE.Vector3(), s: new THREE.Vector3() }
/** The nearest hit on the Brute's body along a ray, or null. */
export function bruteRaycast(actor: EnemyActor, origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): ActorHit | null {
  const skeleton = actor.rig.mesh.skeleton
  actor.root.updateMatrixWorld(true)
  let best: ActorHit | null = null
  for (const volume of VOLUMES) {
    const bone = actor.rig.bones[volume.bone]
    hv.m.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[skeleton.bones.indexOf(bone)])
    const a = hv.a.set(...volume.a).applyMatrix4(hv.m), b = hv.b.set(...volume.b).applyMatrix4(hv.m)
    const radius = volume.radius * hv.s.setFromMatrixColumn(hv.m, 0).length()
    const distance = rayCapsuleDistance(origin, direction, a, b, radius)
    if (distance <= maxDistance && (!best || distance < best.distance))
      best = { distance, point: origin.clone().addScaledVector(direction, distance), zone: volume.zone, bone: volume.bone }
  }
  return best
}

// ---------------------------------------------------------------- the ink wave from a slam

const WAVE_PROFILE: readonly (readonly [number, number])[] = [[-0.62, 0], [-0.4, 0.12], [-0.18, 0.33], [-0.04, 0.44], [0.06, 0.36], [0.13, 0.12], [0.16, 0]]
const WAVE_SEGMENTS = 72
type Wave = { mesh: THREE.Mesh; centre: THREE.Vector3; age: number; radius: number; host: boolean; active: boolean; done: Set<string>; pending: Map<string, number>; drip: number }
/** How far the wave has run `age` seconds after the fists came down, and how long it lasts. */
export const waveRadius = (age: number) => Math.min(BOSS.slam.radius, BOSS.slam.inner + BOSS.slam.speed * age)
const WAVE_LIFE = (BOSS.slam.radius - BOSS.slam.inner) / BOSS.slam.speed + 0.3

/** The slam's ink waves: a low crest of ink racing out over the ground. On the host they hurt whoever stands in their way. */
class InkWaves {
  private waves: Wave[] = []
  private material = new THREE.MeshBasicMaterial({ color: INK, toneMapped: false, side: THREE.DoubleSide })
  constructor(private parent: THREE.Object3D) {}

  start(centre: THREE.Vector3, host: boolean) {
    let wave = this.waves.find(w => !w.active)
    if (!wave) {
      if (this.waves.length >= 3) wave = this.waves.reduce((a, b) => (a.age > b.age ? a : b))
      else {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((WAVE_SEGMENTS + 1) * WAVE_PROFILE.length * 3), 3).setUsage(THREE.DynamicDrawUsage))
        const index: number[] = []
        for (let i = 0; i < WAVE_SEGMENTS; i++) for (let j = 0; j < WAVE_PROFILE.length - 1; j++) {
          const a = i * WAVE_PROFILE.length + j, b = a + WAVE_PROFILE.length
          index.push(a, b, b + 1, a, b + 1, a + 1)
        }
        geometry.setIndex(index)
        const mesh = new THREE.Mesh(geometry, this.material)
        mesh.name = 'Brute ink wave'
        mesh.frustumCulled = false
        mesh.userData.noCollision = true
        this.parent.add(mesh)
        wave = { mesh, centre: new THREE.Vector3(), age: 0, radius: 0, host, active: false, done: new Set(), pending: new Map(), drip: 0 }
        this.waves.push(wave)
      }
    }
    wave.centre.copy(centre); wave.age = 0; wave.radius = BOSS.slam.inner; wave.host = host; wave.active = true; wave.drip = 0
    wave.done.clear(); wave.pending.clear()
    wave.mesh.visible = true
    this.shape(wave)
  }

  get count() { return this.waves.filter(w => w.active).length }

  /** Run every wave on; on the host, `hurt` whoever it passes standing (a teammate's jump may arrive `lag` late). */
  update(dt: number, players: readonly ZombieTarget[] | null, world: CollisionWorld, gore: InkGore, hurt: (target: ZombieTarget, amount: number, from: THREE.Vector3) => void) {
    for (const wave of this.waves) {
      if (!wave.active) continue
      const before = wave.radius
      wave.age += dt
      wave.radius = waveRadius(wave.age)
      if (wave.age >= WAVE_LIFE) { wave.active = false; wave.mesh.visible = false; continue }
      this.shape(wave)
      // Ink thrown off the crest as it runs.
      if ((wave.drip -= dt) <= 0 && wave.radius < BOSS.slam.radius) {
        wave.drip = 0.07
        const a = Math.random() * Math.PI * 2
        gore.spray(scratch.a.set(wave.centre.x + Math.cos(a) * wave.radius, wave.centre.y + 0.3, wave.centre.z + Math.sin(a) * wave.radius), UP, 2, wave.centre.y, 2.2, false)
      }
      if (!wave.host || !players) continue
      for (const player of players) {
        if (!player.alive || wave.done.has(player.id)) continue
        const due = wave.pending.get(player.id)
        const safe = player.air || player.feet.y - wave.centre.y > 0.35
        if (due !== undefined) {
          // A teammate the wave passed: their jump may still be on its way to us.
          if (safe) { wave.pending.delete(player.id); wave.done.add(player.id) }
          else if (wave.age >= due) { wave.pending.delete(player.id); wave.done.add(player.id); hurt(player, this.damage(wave, player), wave.centre) }
          continue
        }
        const d = Math.hypot(player.feet.x - wave.centre.x, player.feet.z - wave.centre.z)
        if (d <= before || d > wave.radius || d <= BOSS.slam.inner) continue
        // Up on something, or a wall between: the wave runs along the ground and stops at walls.
        if (Math.abs(player.feet.y - wave.centre.y) > 0.9 || !world.visible(scratch.b.copy(wave.centre).setY(wave.centre.y + 0.4), scratch.c.copy(player.feet).setY(player.feet.y + 0.4), NO_ONE)) { wave.done.add(player.id); continue }
        if (safe) { wave.done.add(player.id); continue }
        if (player.lag) { wave.pending.set(player.id, wave.age + player.lag); continue }
        wave.done.add(player.id)
        hurt(player, this.damage(wave, player), wave.centre)
      }
    }
  }

  /** Less toward its edge. */
  private damage(wave: Wave, player: ZombieTarget) {
    const d = Math.hypot(player.feet.x - wave.centre.x, player.feet.z - wave.centre.z)
    const k = THREE.MathUtils.clamp((d - BOSS.slam.inner) / (BOSS.slam.radius - BOSS.slam.inner), 0, 1)
    return Math.round(BOSS.slam.wave * THREE.MathUtils.lerp(1, BOSS.slam.waveEdge, k))
  }

  private shape(wave: Wave) {
    const position = wave.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const grow = Math.min(1, wave.age / 0.12), fade = 1 - THREE.MathUtils.smoothstep(wave.age, WAVE_LIFE - 0.45, WAVE_LIFE)
    const height = grow * fade
    for (let i = 0; i <= WAVE_SEGMENTS; i++) {
      const a = i / WAVE_SEGMENTS * Math.PI * 2, cos = Math.cos(a), sin = Math.sin(a)
      const ripple = 1 + 0.18 * Math.sin(a * 7 + wave.age * 11) + 0.1 * Math.sin(a * 13 - wave.age * 7)
      for (let j = 0; j < WAVE_PROFILE.length; j++) {
        const [dr, h] = WAVE_PROFILE[j], r = Math.max(0.05, wave.radius + dr)
        position.setXYZ(i * WAVE_PROFILE.length + j, wave.centre.x + cos * r, wave.centre.y + 0.02 + h * height * ripple, wave.centre.z + sin * r)
      }
    }
    position.needsUpdate = true
  }

  clear() { for (const wave of this.waves) { wave.active = false; wave.mesh.visible = false } }
  dispose() { for (const wave of this.waves) { wave.mesh.removeFromParent(); wave.mesh.geometry.dispose() } this.material.dispose(); this.waves = [] }
}

// ---------------------------------------------------------------- the thrown chunk

type Debris = { id: number; mesh: THREE.Mesh; origin: THREE.Vector3; launch: THREE.Vector3; position: THREE.Vector3; age: number; spin: THREE.Vector3; host: boolean }
const DEBRIS_RADIUS = 0.3

/** Chunks of ground in flight: a falling arc from the Brute's hand, bursting on the first thing they meet. */
class DebrisField {
  readonly flying: Debris[] = []
  private idle: THREE.Mesh[] = []
  private next = 1
  /** Chunks a guest has already seen burst, so a late snapshot does not throw them again. */
  private gone = new Set<number>()

  constructor(private parent: THREE.Object3D, private world: CollisionWorld) {}

  launch(origin: THREE.Vector3, velocity: THREE.Vector3, host: boolean, id = this.next++, age = 0) {
    chunkGeometry ??= buildChunk()
    const mesh = this.idle.pop() ?? new THREE.Mesh(chunkGeometry, sharedMaterials().plain)
    mesh.name = 'Brute debris'
    mesh.userData.noCollision = true
    mesh.scale.setScalar(DEBRIS_RADIUS)
    mesh.visible = true
    this.parent.add(mesh)
    const debris: Debris = { id, mesh, origin: origin.clone(), launch: velocity.clone(), position: origin.clone(), age, host,
      spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4) }
    this.at(debris, age, debris.position)
    mesh.position.copy(debris.position)
    this.flying.push(debris)
    return debris
  }

  private at(debris: Debris, age: number, out: THREE.Vector3) {
    return out.copy(debris.origin).addScaledVector(debris.launch, age).setY(debris.origin.y + debris.launch.y * age - 0.5 * BOSS.throw.gravity * age * age)
  }

  /** Fly every chunk on; each that meets a wall, the ground or (on the host) a player bursts there. */
  update(dt: number, players: readonly ZombieTarget[] | null, burst: (debris: Debris, at: THREE.Vector3, struck: ZombieTarget | null) => void) {
    for (const debris of [...this.flying]) {
      const from = scratch.a.copy(debris.position)
      debris.age += dt
      const to = this.at(debris, debris.age, scratch.b)
      const direction = scratch.c.copy(to).sub(from), length = direction.length()
      if (length > 1e-6) direction.divideScalar(length)
      let t = length, struck: ZombieTarget | null = null
      const wall = length > 1e-6 ? this.world.rayDistance(from, direction, length + DEBRIS_RADIUS * 0.5) : Infinity
      if (wall < length + DEBRIS_RADIUS * 0.5) t = Math.max(0, wall - DEBRIS_RADIUS * 0.5)
      if (players) for (const player of players) {
        if (!player.alive) continue
        const hit = closestApproach(from, direction, length, player.feet)
        if (hit !== null && hit <= t) { t = hit; struck = player }
      }
      if (t < length || debris.age > 4) {
        const at = from.clone().addScaledVector(direction, Math.min(t, length))
        this.remove(debris)
        if (debris.host || !this.gone.has(debris.id)) burst(debris, at, struck)
        if (!debris.host) this.gone.add(debris.id)
        continue
      }
      debris.position.copy(to)
      debris.mesh.position.copy(to)
      debris.mesh.rotation.x += debris.spin.x * dt; debris.mesh.rotation.y += debris.spin.y * dt; debris.mesh.rotation.z += debris.spin.z * dt
    }
  }

  private remove(debris: Debris) {
    this.flying.splice(this.flying.indexOf(debris), 1)
    debris.mesh.visible = false
    this.idle.push(debris.mesh)
  }

  /** Co-op, the host: every chunk in flight as [id, origin, launch velocity, age]. */
  rows(): number[][] {
    const r = (n: number) => Math.round(n * 1000) / 1000
    return this.flying.map(d => [d.id, r(d.origin.x), r(d.origin.y), r(d.origin.z), r(d.launch.x), r(d.launch.y), r(d.launch.z), r(d.age)])
  }

  /** Co-op, the guest: chunks the host has in flight that are not yet in the air here. They fly on here from their age. */
  sync(rows: readonly number[][]) {
    for (const [id, ox, oy, oz, vx, vy, vz, age] of rows) {
      if (this.gone.has(id) || this.flying.some(d => d.id === id)) continue
      this.launch(scratch.d.set(ox, oy, oz), scratch.e.set(vx, vy, vz), false, id, age)
    }
    if (this.gone.size > 64) this.gone.clear()
  }

  clear() { for (const debris of [...this.flying]) this.remove(debris); this.gone.clear() }
  dispose() { this.clear(); for (const mesh of this.idle) mesh.removeFromParent(); this.idle = [] }
}

/** How far along a segment (from `from`, `direction`, `length`) it passes within reach of a standing player at `feet`; null if never. */
function closestApproach(from: THREE.Vector3, direction: THREE.Vector3, length: number, feet: THREE.Vector3) {
  const reach = DEBRIS_RADIUS + 0.3
  const steps = Math.max(1, Math.ceil(length / 0.1))
  for (let i = 0; i <= steps; i++) {
    const s = length * i / steps
    const x = from.x + direction.x * s, y = from.y + direction.y * s, z = from.z + direction.z * s
    const up = THREE.MathUtils.clamp(y, feet.y + 0.2, feet.y + 1.6)
    if ((x - feet.x) ** 2 + (y - up) ** 2 + (z - feet.z) ** 2 <= reach * reach) return s
  }
  return null
}

// ---------------------------------------------------------------- pools of ink (the burrow)

type Pool = { at: THREE.Vector3; kind: 'sink' | 'exit'; age: number; ends: number; size: number; bubble: number }
const POOL_FADE = 2.4

/** The ink it sinks into, and the ink that bubbles where it will come up: ragged blots on the ground. */
class InkPools {
  readonly mesh: THREE.InstancedMesh
  private pools: Pool[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private color = new THREE.Color()
  private ink = new THREE.Color(INK)
  private paper = new THREE.Color(PAPER)

  constructor(parent: THREE.Object3D) {
    const points: THREE.Vector2[] = []
    for (let i = 0; i < 56; i++) {
      const a = i / 56 * Math.PI * 2
      const r = 0.82 + Math.sin(a * 5 + 0.7) * 0.07 + Math.sin(a * 11 + 2.1) * 0.05 + (i % 7 === 0 ? 0.16 : 0)
      points.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r))
    }
    const geometry = new THREE.ShapeGeometry(new THREE.Shape(points)).rotateX(-Math.PI / 2)
    this.mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 4)
    this.mesh.name = 'Brute ink pools'
    this.mesh.userData.noCollision = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, this.ink)
    this.mesh.count = 0
    this.mesh.renderOrder = 1
    parent.add(this.mesh)
  }

  /** A pool at `at` (on the ground) until `ends` seconds from now, then it dries. */
  add(at: THREE.Vector3, kind: Pool['kind'], ends: number) {
    this.pools.push({ at: at.clone().setY(at.y + 0.015), kind, age: 0, ends, size: kind === 'sink' ? 1.9 : 1.6, bubble: 0 })
    if (this.pools.length > 4) this.pools.shift()
  }

  /** The pool of `kind` dries now. */
  end(kind: Pool['kind']) { for (const pool of this.pools) if (pool.kind === kind && pool.ends > pool.age) pool.ends = pool.age }

  get count() { return this.pools.length }

  update(dt: number, gore: InkGore) {
    this.pools = this.pools.filter(pool => (pool.age += dt) < pool.ends + POOL_FADE)
    this.pools.forEach((pool, i) => {
      const grow = THREE.MathUtils.smoothstep(pool.age, 0, pool.kind === 'sink' ? 0.7 : 0.5)
      const dry = THREE.MathUtils.smoothstep(pool.age, pool.ends, pool.ends + POOL_FADE)
      // Where it will come up the ink heaves and bubbles.
      const heave = pool.kind === 'exit' && pool.age < pool.ends ? 1 + 0.06 * Math.sin(pool.age * 9) : 1
      this.scale.setScalar(pool.size * (0.3 + 0.7 * grow) * heave * (1 - 0.3 * dry))
      this.quaternion.setFromAxisAngle(UP, i * 1.7)
      this.mesh.setMatrixAt(i, this.matrix.compose(pool.at, this.quaternion, this.scale))
      this.mesh.setColorAt(i, this.color.copy(this.ink).lerp(this.paper, dry))
      if (pool.age < pool.ends && (pool.bubble -= dt) <= 0) {
        pool.bubble = pool.kind === 'exit' ? 0.1 : 0.2
        const a = Math.random() * Math.PI * 2, r = Math.random() * pool.size * 0.7
        gore.spray(scratch.a.set(pool.at.x + Math.cos(a) * r, pool.at.y + 0.05, pool.at.z + Math.sin(a) * r), UP, pool.kind === 'exit' ? 3 : 2, pool.at.y, pool.kind === 'exit' ? 2.2 : 1.4, false)
      }
    })
    this.mesh.count = this.pools.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  clear() { this.pools = []; this.mesh.count = 0 }
  dispose() { this.clear(); this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose() }
}

// ---------------------------------------------------------------- the mask coming off

type Piece = { mesh: THREE.Mesh; velocity: THREE.Vector3; spin: THREE.Vector3; floor: number; age: number; bounced: boolean }

/** A broken-off mask flies, bounces, lies there a while and sinks into the paper. */
class Pieces {
  private list: Piece[] = []
  constructor(private parent: THREE.Object3D) {}

  launch(from: THREE.Object3D, velocity: THREE.Vector3, floor: number) {
    from.updateWorldMatrix(true, false)
    const mesh = new THREE.Mesh((from as THREE.Mesh).geometry, (from as THREE.Mesh).material)
    mesh.name = 'Brute mask, broken off'
    mesh.userData.noCollision = true
    from.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale)
    this.parent.add(mesh)
    this.list.push({ mesh, velocity: velocity.clone(), spin: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 6 - 3, Math.random() * 10 - 5), floor, age: 0, bounced: false })
    if (this.list.length > 3) this.drop(this.list[0])
  }

  get count() { return this.list.length }

  update(dt: number) {
    for (const piece of [...this.list]) {
      piece.age += dt
      const { mesh } = piece
      if (piece.age > 9) { this.drop(piece); continue }
      if (piece.age > 7) { mesh.position.y -= dt * 0.15; continue }
      const low = piece.floor + 0.08 * mesh.scale.y
      if (mesh.position.y > low || piece.velocity.y > 0) {
        piece.velocity.y -= 14 * dt
        mesh.position.addScaledVector(piece.velocity, dt)
        mesh.rotation.x += piece.spin.x * dt; mesh.rotation.y += piece.spin.y * dt; mesh.rotation.z += piece.spin.z * dt
        if (mesh.position.y < low) {
          mesh.position.y = low
          if (!piece.bounced) { piece.bounced = true; piece.velocity.set(piece.velocity.x * 0.35, -piece.velocity.y * 0.3, piece.velocity.z * 0.35); piece.spin.multiplyScalar(0.4) }
          else piece.velocity.set(0, 0, 0)
        }
      }
    }
  }

  private drop(piece: Piece) { piece.mesh.removeFromParent(); this.list.splice(this.list.indexOf(piece), 1) }
  clear() { for (const piece of [...this.list]) this.drop(piece) }
}

// ---------------------------------------------------------------- the Brute

const UP = new THREE.Vector3(0, 1, 0), NO_ONE = new THREE.Object3D()
const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(),
  f: new THREE.Vector3(), l: new THREE.Vector3(), s: new THREE.Vector3(), t: new THREE.Vector3(), p: new THREE.Vector3(), q: new THREE.Vector3(), m: new THREE.Matrix4() }
const pz = { shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), hand: new THREE.Vector3(), target: new THREE.Vector3(), pole: new THREE.Vector3(), rest: new THREE.Vector3(), head: new THREE.Vector3() }
const round2 = (n: number) => Math.round(n * 100) / 100
const e = THREE.MathUtils.smoothstep
/** An Ink Doll the zombies are drawn to (the runtime's `doll-` targets): the Brute walks to it and swings, nothing more. */
const isDoll = (target: ZombieTarget) => target.id.startsWith('doll')
const chainInverse = new THREE.Matrix4(), chainMatrix = new THREE.Matrix4(), chainQuat = new THREE.Quaternion()
const QUARTER = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)

/**
 * Every Brute in play (the Brute, and the Editor, which is one too): what each does, the ink and debris its
 * attacks leave, and what they do to players. The director owns one; its hooks call in here.
 */
export class Brutes {
  readonly waves: InkWaves
  readonly debris: DebrisField
  readonly pools: InkPools
  readonly pieces: Pieces
  readonly root = new THREE.Group()
  private time = 0
  /** The players its attacks can hurt, this frame (the host's), and how each is moving (a throw leads them). */
  private players: readonly ZombieTarget[] = []
  private tracks = new Map<string, { at: THREE.Vector3; velocity: THREE.Vector3 }>()

  constructor(scene: THREE.Object3D, private host: BruteHost) {
    this.root.name = 'Brute effects'
    this.root.userData.noCollision = true
    scene.add(this.root)
    this.waves = new InkWaves(this.root)
    this.debris = new DebrisField(this.root, host.world)
    this.pools = new InkPools(this.root)
    this.pieces = new Pieces(this.root)
  }

  /** A pooled body becomes the Brute (fresh, masked, calm), or stops being one. */
  wake(z: Zombie, on: boolean) {
    z.brute = on ? freshState(z.maxHealth) : null
    if (on) { z.carriage.lean = 0.5; z.carriage.nod = 0; z.carriage.tilt = 0; z.carriage.droopL = z.carriage.droopR = 0; z.carriage.limp = 0 }
    dressBrute(z.actor, on)
  }

  // ---------------------------------------------------------------- the host

  /**
   * Once a frame before the Brutes move (host and guest): the waves, chunks and pools run on, chains swing,
   * a broken mask falls. On the host (`players` given) the waves and chunks hurt players.
   */
  frame(dt: number, players: readonly ZombieTarget[] | null) {
    this.time += dt
    if (players) { this.players = players; this.track(players, dt) }
    const host = players ? this.players : null
    this.waves.update(dt, host, this.host.world, this.host.gore, (target, amount, from) => {
      const away = scratch.p.copy(target.feet).sub(from).setY(0).normalize().multiplyScalar(3).setY(2.5)
      this.host.damagePlayer(target.id, amount, from.clone().setY(from.y + 0.3), away.clone())
    })
    this.debris.update(dt, host, (debris, at, struck) => this.burst(debris.host, at, struck, scratch.q.copy(debris.launch).setY(0).normalize()))
    this.pools.update(dt, this.host.gore)
    this.pieces.update(dt)
    for (const z of this.host.zombies) if (z.brute && z.state !== 'idle') this.chains(z, dt)
  }

  /** How each player is moving, smoothed: where a thrown chunk leads them to. */
  private track(players: readonly ZombieTarget[], dt: number) {
    if (dt <= 0) return
    for (const player of players) {
      const track = this.tracks.get(player.id)
      if (!track) { this.tracks.set(player.id, { at: player.feet.clone(), velocity: new THREE.Vector3() }); continue }
      const v = scratch.a.copy(player.feet).sub(track.at).divideScalar(dt)
      if (v.lengthSq() > 400) v.set(0, 0, 0)
      track.velocity.lerp(v.setY(0), 1 - Math.exp(-dt * 6))
      track.at.copy(player.feet)
    }
  }

  /** One Brute's frame on the host: its moves, its swing, its chase and its pose. */
  update(z: Zombie, target: ZombieTarget | null, dt: number) {
    const b = z.brute!
    b.t += dt
    for (const key of ['slam', 'charge', 'throw', 'burrow', 'gap'] as const) b.cool[key] = Math.max(0, b.cool[key] - dt)
    b.probe -= dt
    b.idle += dt
    z.stagger = Math.max(0, z.stagger - dt); z.recover = Math.max(0, z.recover - dt); z.flinch = Math.max(0, z.flinch - dt)
    // Never the director's to move: it burrows instead (see watch()).
    z.stranded = false
    let moving = false, speed = 0
    if (!b.enraged && z.health <= z.maxHealth * BOSS.enrage.below && !b.move && z.swing <= 0) this.begin(z, 'roar')
    if (b.move) ({ moving, speed } = this.moveStep(z, b, target, dt))
    else if (z.swing > 0) this.swingStep(z, b, target, dt)
    else if (target && z.stagger <= 0) {
      const flat = Math.hypot(target.feet.x - z.position.x, target.feet.z - z.position.z), up = target.feet.y - z.position.y
      const level = Math.abs(up) < 0.9
      if (flat <= BOSS.attack.range && level && z.recover <= 0) {
        z.swing = BOSS.attack.swing; z.swingLanded = false
        this.host.emit({ kind: 'boss-growl', position: this.headHeight(z), radius: 30 })
      } else if (isDoll(target) || !this.pick(z, b, target, flat, up, level)) {
        moving = this.host.chase(z, target.feet, flat, dt)
        speed = bruteSpeed(z)
        if (moving) b.stride += speed * dt
        this.watch(z, b, target, flat, dt)
      }
    }
    z.moving = moving
    this.growl(z, b, dt)
    this.pose(z, dt, moving, speed, target?.feet ?? null)
  }

  /** Its swing: the fist comes down after the wind-up, on whoever is still in reach. */
  private swingStep(z: Zombie, b: BruteState, target: ZombieTarget | null, dt: number) {
    const attack = BOSS.attack
    z.swing -= dt
    if (target) this.host.face(z, target.feet, dt, 5)
    if (!z.swingLanded && attack.swing - z.swing >= attack.windup) {
      z.swingLanded = true
      b.idle = 0
      if (target?.alive && !isDoll(target)) {
        const now = Math.hypot(target.feet.x - z.position.x, target.feet.z - z.position.z)
        if (now <= attack.reach && Math.abs(target.feet.y - z.position.y) < 1.5 && this.host.canTouch(z, target.feet)) {
          const away = scratch.p.copy(target.feet).sub(z.position).setY(0).normalize().multiplyScalar(attack.knock).setY(1.5)
          this.host.damagePlayer(target.id, attack.damage, z.position.clone().setY(z.position.y + 1.6), away.clone())
        }
      }
      this.host.emit({ kind: 'zombie-swipe', position: z.position.clone(), radius: 14 })
    }
    if (z.swing <= 0) { z.swing = 0; z.recover = attack.recover }
  }

  /** A special attack, if one is ready and fits where the player is. */
  private pick(z: Zombie, b: BruteState, target: ZombieTarget, flat: number, up: number, level: boolean) {
    if (b.cool.gap > 0) return false
    if (b.cool.slam <= 0 && level && flat <= BOSS.slam.trigger) return this.begin(z, 'slam', target)
    if (b.probe > 0) return false
    b.probe = 0.25
    if (b.cool.charge <= 0 && level && flat >= BOSS.charge.near && flat <= BOSS.charge.far
      && this.clearRun(z.position, Math.atan2(target.feet.x - z.position.x, target.feet.z - z.position.z), flat) >= flat - 0.5) return this.begin(z, 'charge', target)
    const outOfReach = flat >= BOSS.throw.near || up > 1.2 || b.stall > 3
    if (b.cool.throw <= 0 && outOfReach && flat <= BOSS.throw.far && this.clearThrow(z, target)) return this.begin(z, 'throw', target)
    return false
  }

  /** Metres it could run straight along `yaw` from `from`, up to `most`: floor all the way and room for a body. */
  private clearRun(from: THREE.Vector3, yaw: number, most: number) {
    const dx = Math.sin(yaw), dz = Math.cos(yaw), step = 0.45
    let y = from.y
    for (let d = step; d <= most + 1e-6; d += step) {
      const point = this.host.navigation.floor(scratch.t.set(from.x + dx * d, y, from.z + dz * d))
      if (!point) return d - step
      y = point.y
    }
    return most
  }

  /** A clear line from over its head to the player's chest. */
  private clearThrow(z: Zombie, target: ZombieTarget) {
    return this.host.world.visible(scratch.t.copy(z.position).setY(z.position.y + 2.6), scratch.p.copy(target.feet).setY(target.feet.y + 1.2), z.actor.root)
  }

  /**
   * Stuck: no closer to anyone for a while (and not fighting from where it is), or no way to anyone at all.
   * Then it burrows, in plain view, rather than walk on the spot or be moved while you are not looking.
   */
  private watch(z: Zombie, b: BruteState, target: ZombieTarget, flat: number, dt: number) {
    const graph = this.host.graph
    if (!graph) return
    const walking = graph.distance(graph.nearest(z.position))
    if (!Number.isFinite(walking)) b.lost += dt
    else {
      b.lost = 0
      if (walking < b.best - 1.5) { b.best = walking; b.stall = 0 }
      else if (b.idle > 6) b.stall += dt
    }
    const stuck = b.lost > BOSS.burrow.lost || b.stall > (b.enraged ? BOSS.burrow.enragedStuck : BOSS.burrow.stuck)
    if (stuck && flat > 10 && !isDoll(target) && b.cool.burrow <= 0 && b.cool.gap <= 0) this.begin(z, 'burrow', target)
  }

  /** Start a move: its sound and anything it shows at once. */
  private begin(z: Zombie, move: BruteMove, target?: ZombieTarget) {
    const b = z.brute!
    b.move = move; b.t = 0; b.struck = b.torn = b.released = b.locked = false; b.run = 0; b.stopped = -1; b.hit.clear()
    b.idle = 0
    z.swing = 0
    if (target) b.aimId = target.id
    this.started(z, move)
    if (move === 'roar') b.enraged = true
    return true
  }

  /** What a move shows and sounds like as it starts (on the host, and on a guest when its snapshot says so). */
  private started(z: Zombie, move: BruteMove) {
    const b = z.brute!, at = this.headHeight(z)
    if (move === 'slam') this.host.emit({ kind: 'boss-roar', position: at, radius: 90 })
    if (move === 'charge') this.host.emit({ kind: 'brute-snort', position: at, radius: 80, duration: bruteWindup(b, BOSS.charge.windup) })
    if (move === 'throw') this.host.emit({ kind: 'boss-growl', position: at, radius: 40 })
    if (move === 'roar') {
      this.host.emit({ kind: 'brute-enrage', position: at, radius: 250 })
      this.host.onSlam?.(z.position.clone(), 3.5)
    }
    if (move === 'burrow') {
      this.host.emit({ kind: 'brute-sink', position: at, radius: 200 })
      this.pools.add(z.position, 'sink', BOSS.burrow.sink + 0.4)
    }
    if (move === 'stun' && b.cause === 'crash') this.host.emit({ kind: 'brute-crash', position: at, radius: 90 })
  }

  /** The end of a move: its cooldown, and a breath before the next special. */
  private end(z: Zombie, b: BruteState) {
    const move = b.move
    if (move === 'slam' || move === 'charge' || move === 'throw') b.cool[move] = bruteCooldown(b, BOSS[move].cooldown)
    if (move === 'burrow') b.cool.burrow = BOSS.burrow.cooldown
    b.cool.gap = bruteCooldown(b, BOSS.gap)
    b.move = null; b.t = 0; b.cause = null
    z.recover = Math.max(z.recover, 0.3)
  }

  private moveStep(z: Zombie, b: BruteState, target: ZombieTarget | null, dt: number): { moving: boolean; speed: number } {
    const still = { moving: false, speed: 0 }
    switch (b.move) {
      case 'slam': {
        const windup = bruteWindup(b, BOSS.slam.windup)
        if (!b.struck) {
          if (target) this.host.face(z, target.feet, dt, 3)
          if (b.t >= windup) this.slamDown(z, b)
        } else if (b.t >= windup + BOSS.slam.recover) this.end(z, b)
        return still
      }
      case 'charge': return this.chargeStep(z, b, target, dt)
      case 'throw': {
        const windup = bruteWindup(b, BOSS.throw.windup), release = windup * BOSS.throw.release
        const aim = this.players.find(p => p.id === b.aimId && p.alive) ?? target
        if (aim && !b.released) this.host.face(z, aim.feet, dt, 4)
        if (!b.torn && b.t >= windup * 0.32) this.tear(z, b)
        if (!b.released && b.t >= release) this.letGo(z, b, aim)
        if (b.t >= windup + 0.35) this.end(z, b)
        return still
      }
      case 'roar': if (b.t >= BOSS.enrage.roar) this.end(z, b); return still
      case 'stun': if (b.t >= b.stun) this.end(z, b); return still
      case 'burrow': this.burrowStep(z, b); return still
    }
    return still
  }

  /** The fists come down: close by they hurt at once; then the ink wave runs out along the ground. */
  private slamDown(z: Zombie, b: BruteState) {
    b.struck = true
    b.idle = 0
    const ground = z.position
    for (const player of this.players) {
      if (!player.alive || Math.abs(player.feet.y - ground.y) > 1.3) continue
      const d = Math.hypot(player.feet.x - ground.x, player.feet.z - ground.z)
      if (d > BOSS.slam.inner) continue
      const away = scratch.p.copy(player.feet).sub(ground).setY(0).normalize().multiplyScalar(4).setY(3)
      this.host.damagePlayer(player.id, Math.round(BOSS.slam.damage * (1 - 0.6 * d / BOSS.slam.inner)), ground.clone().setY(ground.y + 0.5), away.clone())
    }
    this.slamLook(z, true)
  }

  /** What a slam looks and sounds like where the fists land; the wave hurts only on the host. */
  private slamLook(z: Zombie, host: boolean) {
    const forward = scratch.f.set(Math.sin(z.yaw), 0, Math.cos(z.yaw))
    const fists = z.position.clone().addScaledVector(forward, 0.9)
    this.host.emit({ kind: 'boss-slam', position: z.position.clone(), radius: 90 })
    this.host.emit({ kind: 'ink-wave', position: z.position.clone(), radius: 60 })
    this.host.onSlam?.(z.position.clone(), BOSS.slam.inner)
    this.waves.start(z.position, host)
    this.host.gore.fling(fists.setY(z.position.y + 0.1), UP, 8, z.position.y, 1.1, 3, 1.3)
    this.host.gore.spray(fists, UP, 16, z.position.y, 3)
  }

  private chargeStep(z: Zombie, b: BruteState, target: ZombieTarget | null, dt: number) {
    const windup = bruteWindup(b, BOSS.charge.windup), charge = BOSS.charge
    if (b.t < windup) {
      // It follows you with its eyes and shoulders, then its line is fixed a moment before it goes.
      const aim = this.players.find(p => p.id === b.aimId && p.alive) ?? target
      if (b.t < windup - charge.lock) { if (aim) this.host.face(z, aim.feet, dt, 5) }
      else if (!b.locked) {
        b.locked = true
        b.heading = z.yaw
        b.limit = this.clearRun(z.position, b.heading, charge.length)
        if (b.limit < 4) { b.move = null; b.t = 0; b.cool.charge = 2; b.cool.gap = 0.5 }
      }
      return { moving: false, speed: 0 }
    }
    if (b.stopped < 0) {
      const speed = charge.speed * (b.enraged ? 1.15 : 1)
      const dx = Math.sin(b.heading), dz = Math.cos(b.heading)
      let budget = speed * dt
      while (budget > 1e-4 && b.stopped < 0) {
        const step = Math.min(0.25, budget)
        budget -= step
        const goal = scratch.t.set(z.position.x + dx * 2, z.position.y, z.position.z + dz * 2)
        const next = b.run + step <= b.limit + 0.3 ? this.host.navigation.step(z.position, goal, step) : null
        if (!next) { this.stopCharge(z, b, true); break }
        z.position.copy(next)
        b.run += step
        this.bash(z, b)
        if (b.run >= charge.length) this.stopCharge(z, b, false)
      }
      z.yaw = b.heading
      b.stride += speed * dt
      if (Math.floor((b.stride - speed * dt) / 1.6) !== Math.floor(b.stride / 1.6)) this.host.emit({ kind: 'brute-stomp', position: z.position.clone(), radius: 45 })
      return { moving: b.stopped < 0, speed }
    }
    if (b.t - b.stopped >= charge.recover) this.end(z, b)
    return { moving: false, speed: 0 }
  }

  /** The charge ends: into a wall it is stunned; out of room or run out, it skids to a stop. */
  private stopCharge(z: Zombie, b: BruteState, blocked: boolean) {
    b.stopped = b.t
    if (!blocked) return
    const ahead = scratch.t.set(z.position.x + Math.sin(b.heading) * 0.6, z.position.y + 0.5, z.position.z + Math.cos(b.heading) * 0.6)
    const floor = this.host.world.floor(ahead, 0.9, 1.2)
    // A wall (there is floor ahead, but no room): it crashes into it. A drop: it just stops at the edge.
    if (!Number.isFinite(floor) || Math.abs(floor - z.position.y) > 0.45) return
    this.end(z, b)
    b.cool.charge = bruteCooldown(b, BOSS.charge.cooldown)
    this.stun(z, BOSS.charge.crash, 'crash')
    const impact = ahead.setY(z.position.y + 1.2)
    this.host.gore.fling(impact, scratch.p.set(-Math.sin(b.heading), 0.6, -Math.cos(b.heading)), 6, z.position.y, 0.9, 3)
    this.host.onSlam?.(z.position.clone(), 1.6)
  }

  /** Stagger it for `seconds` (a crash, or its mask breaking): no attacks meanwhile. */
  private stun(z: Zombie, seconds: number, cause: BruteState['cause']) {
    const b = z.brute!
    if (b.move === 'burrow' || (b.move === 'charge' && b.t >= bruteWindup(b, BOSS.charge.windup) && b.stopped < 0)) return
    b.cause = cause
    b.stun = seconds
    b.move = null
    this.begin(z, 'stun')
  }

  /** Charging through: zombies in its way are thrown aside; a player it runs into is hit and thrown. */
  private bash(z: Zombie, b: BruteState) {
    const width = BOSS.charge.width, dx = Math.sin(b.heading), dz = Math.cos(b.heading)
    for (const other of this.host.zombies) {
      if (other === z || other.state !== 'chase' || other.boss || other.rise > 0 || other.climb || other.window || other.stagger > 0.6) continue
      const ox = other.position.x - z.position.x, oz = other.position.z - z.position.z
      if (ox * ox + oz * oz > width * width || Math.abs(other.position.y - z.position.y) > 1.2) continue
      // Thrown to whichever side of its line it stood, and a little ahead.
      const side = ox * dz - oz * dx >= 0 ? 1 : -1
      const goal = scratch.p.set(other.position.x + dz * side * 1.4 + dx * 0.5, other.position.y, other.position.z - dx * side * 1.4 + dz * 0.5)
      const to = this.host.navigation.step(other.position, goal, 1.4)
      if (to) other.position.copy(to)
      other.stagger = Math.max(other.stagger, 0.9)
      other.flinch = 0.22; other.flinchBack = 1; other.flinchSide = side
      other.swing = 0
      other.route.length = 0
      this.host.emit({ kind: 'brute-bash', position: other.position.clone().setY(other.position.y + 1), radius: 30 })
    }
    for (const player of this.players) {
      if (!player.alive || b.hit.has(player.id)) continue
      const px = player.feet.x - z.position.x, pz = player.feet.z - z.position.z
      if (px * px + pz * pz > (width + 0.1) ** 2 || Math.abs(player.feet.y - z.position.y) > 1.3) continue
      b.hit.add(player.id)
      b.idle = 0
      const side = px * dz - pz * dx >= 0 ? 1 : -1, knock = BOSS.charge.knock
      const push = new THREE.Vector3(dx * knock + dz * side * 3, 4, dz * knock - dx * side * 3)
      this.host.damagePlayer(player.id, BOSS.charge.damage, z.position.clone().setY(z.position.y + 1.2), push)
      this.host.emit({ kind: 'brute-bash', position: player.feet.clone().setY(player.feet.y + 1), radius: 40 })
    }
  }

  /** The throw's first beat: its hand tears a chunk out of the ground. */
  private tear(z: Zombie, b: BruteState) {
    b.torn = true
    const forward = scratch.f.set(Math.sin(z.yaw), 0, Math.cos(z.yaw)), right = scratch.l.set(-Math.cos(z.yaw), 0, Math.sin(z.yaw))
    const spot = z.position.clone().addScaledVector(forward, 1).addScaledVector(right, 0.3)
    this.host.gore.fling(spot.clone().setY(z.position.y + 0.1), UP, 9, z.position.y, 1.1, 3.2, 1.3)
    this.host.gore.spray(spot, UP, 10, z.position.y, 2.5)
    this.host.onSlam?.(spot, 0.9)
    this.host.emit({ kind: 'brute-rip', position: spot, radius: 50 })
  }

  /** Let go: the chunk flies in an arc to where the player will be (half of their lead), and can be dodged. */
  private letGo(z: Zombie, b: BruteState, aim: ZombieTarget | null) {
    b.released = true
    b.idle = 0
    const look = lookOf(z.actor)
    const origin = look ? look.held.getWorldPosition(new THREE.Vector3()) : z.position.clone().setY(z.position.y + 2.8)
    const goal = aim ? aim.feet.clone().setY(aim.feet.y + 1) : origin.clone().addScaledVector(scratch.f.set(Math.sin(z.yaw), 0, Math.cos(z.yaw)), 12)
    const distance = Math.hypot(goal.x - origin.x, goal.z - origin.z)
    const time = THREE.MathUtils.clamp(distance / 15, 0.55, 1.4)
    const lead = aim ? this.tracks.get(aim.id)?.velocity : undefined
    if (lead) goal.addScaledVector(lead, time * 0.5)
    const velocity = goal.sub(origin).divideScalar(time)
    velocity.y += 0.5 * BOSS.throw.gravity * time
    this.debris.launch(origin, velocity, true)
    this.host.emit({ kind: 'brute-throw', position: origin, radius: 50 })
  }

  /** A chunk bursts: clods and ink, a crack in the ground; on the host, it hurts the one it struck and those close by. */
  private burst(host: boolean, at: THREE.Vector3, struck: ZombieTarget | null, direction: THREE.Vector3) {
    const floor = this.host.world.floor(scratch.a.copy(at).setY(at.y + 0.3), 0.5, 4)
    const ground = Number.isFinite(floor) ? floor : at.y
    this.host.gore.fling(at, UP, 10, ground, 1, 3.2, 1.2)
    this.host.gore.spray(at, UP, 12, ground, 2.6)
    this.host.onSlam?.(scratch.b.copy(at).setY(ground), 1.3)
    this.host.emit({ kind: 'debris-crash', position: at.clone(), radius: 70 })
    if (!host) return
    for (const player of this.players) {
      if (!player.alive) continue
      let amount = 0
      if (player === struck) amount = BOSS.throw.damage
      else {
        const d = Math.hypot(player.feet.x - at.x, player.feet.z - at.z)
        if (d > BOSS.throw.splash || Math.abs(player.feet.y - ground) > 1.5) continue
        amount = Math.round(BOSS.throw.damage * BOSS.throw.splashShare * (1 - d / BOSS.throw.splash))
      }
      if (amount <= 0) continue
      const push = direction.clone().multiplyScalar(player === struck ? 5 : 2).setY(2.5)
      this.host.damagePlayer(player.id, amount, at.clone(), push)
    }
  }

  /** Sink into the ink, stay under while a pool bubbles near a player, then climb out there. */
  private burrowStep(z: Zombie, b: BruteState) {
    const burrow = BOSS.burrow
    if (b.t < burrow.sink) return
    if (!b.released) {
      // Under: the body is gone below the ink, and where it will come up bubbles for all to see.
      b.released = true
      const player = this.players.find(p => p.id === b.aimId && p.alive) ?? this.players.find(p => p.alive)
      b.exit.copy((player && this.exitNear(z, player)) ?? z.position)
      z.position.copy(b.exit).setY(b.exit.y - burrow.depth)
      z.actor.root.visible = false
      this.pools.end('sink')
      this.pools.add(b.exit, 'exit', burrow.under - (b.t - burrow.sink))
      this.host.emit({ kind: 'brute-rumble', position: b.exit.clone(), radius: 90 })
      return
    }
    if (b.t < burrow.sink + burrow.under) return
    // Up: the rise, the shockwave, the roar.
    z.position.copy(b.exit)
    z.actor.root.visible = true
    const player = this.players.find(p => p.alive)
    if (player) z.yaw = Math.atan2(player.feet.x - z.position.x, player.feet.z - z.position.z)
    this.end(z, b)
    b.best = Infinity; b.stall = 0; b.lost = 0; b.idle = 0
    z.rise = RISE.seconds
    this.emerged(z)
  }

  /** It comes up out of the ground (host and guest). */
  private emerged(z: Zombie) {
    this.pools.end('exit')
    this.host.onRise?.(z.position.clone())
    this.host.onSlam?.(z.position.clone(), 3)
    this.host.emit({ kind: 'brute-emerge', position: z.position.clone(), radius: 120 })
    this.host.emit({ kind: 'boss-roar', position: this.headHeight(z), radius: 200 })
  }

  /**
   * Where to come up near `player`: standing room on their level, `near` to `far` from them, a short walk
   * to them, in plain sight of them. Relaxed step by step rather than failing; null if nowhere.
   */
  private exitNear(z: Zombie, player: ZombieTarget) {
    const graph = this.host.graph
    if (!graph) return null
    const feet = player.feet, cell = graph.cell
    const i0 = Math.floor((feet.x - graph.minX) / cell), k0 = Math.floor((feet.z - graph.minZ) / cell)
    for (const [near, far, sight, level] of [[BOSS.burrow.near, BOSS.burrow.far, true, 1.3], [4, 16, false, 1.3], [3, 20, false, 4]] as const) {
      const reach = Math.ceil(far / cell) + 1
      let best: THREE.Vector3 | null = null, bestScore = Infinity
      for (let di = -reach; di <= reach; di++) for (let dk = -reach; dk <= reach; dk++) {
        const index = graph.index(i0 + di, k0 + dk)
        if (index < 0 || !graph.walkable(index)) continue
        const walk = graph.distance(index)
        if (!Number.isFinite(walk)) continue
        const p = graph.point(index, scratch.s)
        const flat = Math.hypot(p.x - feet.x, p.z - feet.z)
        if (flat < near || flat > far || Math.abs(p.y - feet.y) > level) continue
        const score = Math.abs(flat - (near + far) / 2) + 0.5 * Math.max(0, walk - flat)
        if (score >= bestScore) continue
        const stand = this.host.navigation.floor(p.clone())
        if (!stand) continue
        if (sight && !this.host.world.visible(scratch.t.copy(stand).setY(stand.y + 1.4), scratch.p.copy(feet).setY(feet.y + 1.4), z.actor.root)) continue
        best = stand; bestScore = score
      }
      if (best) return best
    }
    return null
  }

  /** Its growl now and then, as the zombies groan. */
  private growl(z: Zombie, b: BruteState, dt: number) {
    if (b.move || (z.voice -= dt) > 0) return
    z.voice = 3.5 + Math.random() * 5
    this.host.emit({ kind: 'boss-growl', position: this.headHeight(z), radius: 70 })
  }

  private headHeight(z: Zombie) { return z.position.clone().setY(z.position.y + 1.9 * BOSS.scale * 0.8) }

  // ---------------------------------------------------------------- damage

  /**
   * A bullet's damage to the Brute for `raw` (already scaled and past falloff) in `zone`. While the mask holds,
   * a head shot does its full damage to the mask and only a body shot's to the Brute; once it has broken off,
   * the head is a weak spot.
   */
  shot(z: Zombie, zone: HitZone, raw: number, weapon: WeaponName | undefined, point: THREE.Vector3, direction: THREE.Vector3) {
    const b = z.brute!
    if (buried(b)) return 0
    if (zone !== 'head') return hitDamage(weapon, zone, raw)
    if (b.mask > 0) {
      b.mask = Math.max(0, b.mask - hitDamage(weapon, 'head', raw))
      this.host.emit({ kind: 'brute-clang', position: point.clone(), radius: 40 })
      this.host.gore.spray(point, scratch.p.copy(direction).negate().setY(0.4), 3, z.position.y, 2.4, false)
      const wear = b.mask <= 0 ? 3 : b.mask < b.maskMax / 3 ? 2 : b.mask < b.maskMax * 2 / 3 ? 1 : 0
      if (wear !== b.wear) { b.wear = Math.min(2, wear); this.wearMask(z) }
      if (b.mask <= 0) this.breakMask(z, direction, true)
      return hitDamage(weapon, 'torso', raw)
    }
    return hitDamage(weapon, 'head', raw) * BOSS.mask.weakSpot
  }

  /** The mask works loose as it takes hits: askew, then hanging. */
  private wearMask(z: Zombie) {
    const look = lookOf(z.actor), wear = z.brute!.wear
    if (!look) return
    look.mask.rotation.set(wear >= 2 ? 0.14 : 0, 0, wear === 1 ? 0.13 : wear >= 2 ? -0.24 : 0)
    look.mask.position.copy(HEAD_CENTRE).y -= wear * 0.008
  }

  /** The mask breaks off and flies; the Brute reels (on the host) and its head is bare. */
  private breakMask(z: Zombie, direction: THREE.Vector3, host: boolean) {
    const look = lookOf(z.actor)
    if (look?.mask.visible) {
      const away = direction.clone().setY(0)
      if (away.lengthSq() < 1e-4) away.set(Math.sin(z.yaw), 0, Math.cos(z.yaw))
      away.normalize().multiplyScalar(2.5).setY(3.5)
      this.pieces.launch(look.mask, away, z.position.y)
      look.mask.visible = false
    }
    this.host.emit({ kind: 'brute-mask-break', position: this.headHeight(z), radius: 80 })
    if (host && z.state === 'chase') this.stun(z, BOSS.mask.stagger, 'mask')
  }

  /** Its body dies: the mask, if it still has it, comes off as it falls. */
  died(z: Zombie) {
    const b = z.brute, look = lookOf(z.actor)
    if (!b || !look) return
    look.held.visible = false
    if (look.mask.visible) this.breakMask(z, scratch.p.set(-Math.sin(z.yaw), 0, -Math.cos(z.yaw)), false)
    b.move = null
  }

  /** A body's hit volumes, or none while it is under the ground. */
  raycast(z: Zombie, origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    return buried(z.brute) ? null : bruteRaycast(z.actor, origin, direction, maxDistance)
  }

  // ---------------------------------------------------------------- co-op

  /** The host's snapshot bits for a Brute (bits 14 to 18). */
  flags(z: Zombie) {
    const b = z.brute
    if (!b) return 0
    return (MOVES.indexOf(b.move) << BRUTE_BITS.shift) | (b.enraged ? BRUTE_BITS.enraged : 0) | (b.mask <= 0 ? BRUTE_BITS.unmasked : 0)
  }

  /** The three numbers a Brute's snapshot row carries after the zombies' own. */
  columns(z: Zombie): [number, number, number] {
    const b = z.brute!
    return [round2(b.t), b.editor ? 1 : 0, b.wear]
  }

  /**
   * A guest reads a Brute's row: its move, how far into it, enraged, its mask. What changed plays here as it
   * did on the host (sounds, the slam's wave, the mask flying off, the burrow), but hurts nobody.
   */
  read(z: Zombie, row: ZombieSnap) {
    const b = z.brute!, flags = row[9]
    const move = MOVES[(flags & BRUTE_BITS.move) >> BRUTE_BITS.shift] ?? null
    const t = row[12] ?? 0, enraged = !!(flags & BRUTE_BITS.enraged), unmasked = !!(flags & BRUTE_BITS.unmasked)
    const seen = b.seen, before = seen.t
    b.editor = row[13] === 1
    const wear = row[14] ?? 0
    if (wear !== b.wear) { b.wear = wear; this.wearMask(z) }
    b.enraged = enraged
    if (seen.first) {
      // Joined mid-fight: show its state as it is, without replaying what already happened.
      seen.first = false
      const look = lookOf(z.actor)
      if (unmasked && look) look.mask.visible = false
      b.mask = unmasked ? 0 : 1
      Object.assign(seen, { move, t, enraged, unmasked })
      b.move = move; b.t = t
      return
    }
    if (unmasked && !seen.unmasked) { b.mask = 0; this.breakMask(z, scratch.p.set(-Math.sin(z.yaw), 0, -Math.cos(z.yaw)), false) }
    const restarted = move !== seen.move || t < before - 0.05
    if (restarted && seen.move === 'burrow' && move !== 'burrow') { z.actor.root.visible = true; this.emerged(z) }
    if (restarted && move) {
      if (move === 'stun' && seen.move === 'charge') b.cause = 'crash'
      else if (move === 'stun') b.cause = 'mask'
      this.started(z, move)
    }
    const from = restarted ? 0 : before
    const crossed = (at: number) => from < at && t >= at
    if (move === 'slam' && crossed(bruteWindup(b, BOSS.slam.windup))) this.slamLook(z, false)
    if (move === 'throw') {
      const windup = bruteWindup(b, BOSS.throw.windup)
      if (crossed(windup * 0.32)) this.tear(z, b)
      if (crossed(windup * BOSS.throw.release)) this.host.emit({ kind: 'brute-throw', position: this.headHeight(z), radius: 50 })
    }
    if (move === 'burrow' && crossed(BOSS.burrow.sink)) {
      this.pools.end('sink')
      b.exit.copy(z.position).setY(z.position.y + BOSS.burrow.depth)
      this.pools.add(b.exit, 'exit', BOSS.burrow.under)
      this.host.emit({ kind: 'brute-rumble', position: b.exit.clone(), radius: 90 })
    }
    if (move === 'charge' && z.moving && Math.floor(before * 5) !== Math.floor(t * 5) && t > bruteWindup(b, BOSS.charge.windup)) this.host.emit({ kind: 'brute-stomp', position: z.position.clone(), radius: 45 })
    Object.assign(seen, { move, t, enraged, unmasked })
    b.move = move; b.t = t
  }

  /** A guest draws a Brute from its row (after the director has placed it). */
  puppet(z: Zombie, moving: boolean, dt: number, look?: THREE.Vector3) {
    const b = z.brute!
    const charging = b.move === 'charge' && moving
    const speed = charging ? BOSS.charge.speed * (b.enraged ? 1.15 : 1) : bruteSpeed(z)
    if (moving) b.stride += speed * dt
    this.pose(z, dt, moving, speed, look ?? null)
  }

  // ---------------------------------------------------------------- the pose

  /**
   * The Brute's body this frame, from its state alone (so a guest draws what the host does): the zombies'
   * walk and run at its size, hunched over with its small head up at its prey, arms hanging heavy and
   * swinging, and each move's own pose on top.
   */
  private pose(z: Zombie, dt: number, moving: boolean, speed: number, prey: THREE.Vector3 | null) {
    const b = z.brute!, { actor } = z
    const look = lookOf(actor)
    if (buried(b)) { actor.root.visible = false; if (look) look.held.visible = false; return }
    actor.root.visible = true
    actor.root.position.copy(z.position)
    actor.root.rotation.set(0, z.yaw, 0)
    actor.update(dt, 'patrol', moving, undefined, moving ? speed / BOSS.scale : 0)
    actor.gun.visible = false
    this.shape(z, prey, moving)
    if (look) {
      const hot = b.enraged
      look.eyes.geometry = eyeGeometries[hot ? 1 : 0]
      look.eyes.material = hot ? sharedMaterials().hot : sharedMaterials().eye
      look.halo.visible = hot
      look.held.visible = b.move === 'throw' && b.t >= bruteWindup(b, BOSS.throw.windup) * 0.32 && b.t < bruteWindup(b, BOSS.throw.windup) * BOSS.throw.release
    }
  }

  /** The stance the rise out of the ground hands over to (the clip's pose already applied). */
  stance(z: Zombie) { this.shape(z, null, false) }

  /** Bends and limbs over the clip's pose: the hunch, the head up at its prey, and each move's arms. */
  private shape(z: Zombie, prey: THREE.Vector3 | null, moving: boolean) {
    const b = z.brute!, { actor } = z, bones = actor.rig.bones, t = b.t
    const forward = scratch.f.set(Math.sin(z.yaw), 0, Math.cos(z.yaw)), left = scratch.l.set(Math.cos(z.yaw), 0, -Math.sin(z.yaw))
    const breathe = Math.sin(this.time * 1.7 + z.carriage.phase) * 0.03
    let lean = 0.72 + breathe, twist = 0, raise = 0, crouch = 0, scrape = 0
    let pose: 'hang' | 'slam' | 'charge' | 'skid' | 'throw' | 'roar' | 'dazed' | 'face' | 'sink' | 'swing' = 'hang'
    const swingU = z.swing > 0 ? 1 - z.swing / BOSS.attack.swing : -1
    switch (b.move) {
      case 'slam': {
        const w = bruteWindup(b, BOSS.slam.windup)
        pose = 'slam'
        lean = t < w ? 0.5 - 0.7 * e(t, 0, w * 0.6) : THREE.MathUtils.lerp(1.05, 0.5, e(t, w + BOSS.slam.recover * 0.4, w + BOSS.slam.recover))
        crouch = t < w ? 0.2 * e(t, 0, w) : THREE.MathUtils.lerp(0.75, 0, e(t, w + BOSS.slam.recover * 0.4, w + BOSS.slam.recover))
        raise = t < w ? 0.35 : 0
        break
      }
      case 'charge': {
        const w = bruteWindup(b, BOSS.charge.windup)
        if (t < w) { pose = 'charge'; lean = 0.5 + 0.35 * e(t, 0, 0.3); crouch = 0.45 * e(t, 0, 0.3); scrape = Math.sin(e(t, 0.1, w) * Math.PI * 4); raise = 0.25 }
        else if (moving || b.stopped < 0) { pose = 'charge'; lean = 0.85 }
        else { pose = 'skid'; lean = -0.15 }
        break
      }
      case 'throw': {
        const w = bruteWindup(b, BOSS.throw.windup), rip = w * 0.32, release = w * BOSS.throw.release
        pose = 'throw'
        lean = t < rip ? 0.5 + 0.55 * e(t, 0, rip) : t < release ? THREE.MathUtils.lerp(1.05, -0.3, e(t, rip, release)) : THREE.MathUtils.lerp(0.55, 0.5, e(t, release, w + 0.35))
        crouch = t < rip ? 0.55 * e(t, 0, rip) : 0.55 * (1 - e(t, rip, rip + 0.25))
        twist = t < rip ? 0 : t < release ? -0.45 * e(t, rip, release) : THREE.MathUtils.lerp(-0.45, 0.35, e(t, release, release + 0.12))
        break
      }
      case 'roar': pose = 'roar'; lean = -0.3 + 0.05 * Math.sin(t * 40); raise = 1; break
      case 'stun':
        pose = b.cause === 'mask' ? 'face' : 'dazed'
        lean = b.cause === 'mask' ? -0.15 : 0.75
        raise = b.cause === 'mask' ? 0.3 : -0.5
        break
      case 'burrow': pose = 'sink'; lean = -0.15; raise = 0.7; break
    }
    if (swingU >= 0) {
      pose = 'swing'
      const w = BOSS.attack.windup / BOSS.attack.swing
      const k = e(swingU, 0, w), k2 = e(swingU, w, w + 0.14)
      lean = 0.35 - 0.25 * k + 0.55 * k2
      twist = -0.35 * k + 0.7 * k2
    }
    // A bullet's jolt, small: it barely feels them.
    const jolt = z.flinch > 0 ? Math.sin(Math.PI * z.flinch / 0.22) * 0.35 : 0
    lean -= jolt * z.flinchBack * 0.2
    // Sinking into the ink: the whole body goes down through it.
    if (b.move === 'burrow') actor.root.position.y -= 3.4 * e(t, 0.15, BOSS.burrow.sink)
    if (crouch > 0) actor.root.position.y -= crouch * 0.28
    bend(bones.spine, lean * 0.5, twist * 0.4, 0)
    bend(bones.chest, lean * 0.5, twist * 0.6, 0)
    // The head up at its prey (or where it is looking), against the hunch.
    let yaw = 0, pitch = 0
    if (prey && b.move !== 'roar' && b.move !== 'stun') {
      actor.root.updateMatrixWorld(true)
      const head = bones.head.getWorldPosition(pz.head)
      const toward = Math.atan2(prey.x - head.x, prey.z - head.z)
      yaw = THREE.MathUtils.clamp(Math.atan2(Math.sin(toward - z.yaw), Math.cos(toward - z.yaw)), -0.7, 0.7)
      pitch = THREE.MathUtils.clamp(Math.atan2(prey.y + 1.4 - head.y, Math.max(0.5, Math.hypot(prey.x - head.x, prey.z - head.z))), -0.5, 0.6)
    }
    const up = THREE.MathUtils.clamp(lean + pitch + raise, -0.6, 1.6)
    const wobble = pose === 'dazed' ? Math.sin(t * 5) * 0.35 : 0
    // The clips never move the neck: bend it from rest, or it would add up frame on frame.
    bones.neck.quaternion.copy(actor.rig.rest.neck.quat)
    bend(bones.neck, -up * 0.45, yaw * 0.35, 0)
    bend(bones.head, -up * 0.55, yaw * 0.5 + wobble, wobble * 0.3)
    actor.root.updateMatrixWorld(true)
    if (crouch > 0 || scrape !== 0) this.legs(z, crouch, scrape)
    this.arms(z, pose, moving, forward, left)
  }

  /** Knees bent under a crouch (feet kept on the ground); the right foot scraping back before a charge. */
  private legs(z: Zombie, crouch: number, scrape: number) {
    const bones = z.actor.rig.bones, forward = scratch.f, left = scratch.l, ground = z.position.y
    for (const [key, sign] of [['L', 1], ['R', -1]] as const) {
      const hip = bones[`thigh.${key}`].getWorldPosition(pz.shoulder)
      const foot = pz.target.set(hip.x, ground + 0.03, hip.z).addScaledVector(left, sign * 0.1).addScaledVector(forward, 0.12 * crouch)
      if (key === 'R' && scrape) foot.addScaledVector(forward, -0.45 * Math.max(0, scrape)).y += 0.06 * Math.max(0, scrape)
      solveLeg(bones[`thigh.${key}`], bones[`shin.${key}`], foot, pz.pole.copy(forward).addScaledVector(left, sign * 0.25).normalize(), LEG_SCALE)
    }
  }

  /** Each arm to where its move wants the hand, solved to reach (the elbows out and back). */
  private arms(z: Zombie, pose: string, moving: boolean, forward: THREE.Vector3, left: THREE.Vector3) {
    const b = z.brute!, bones = z.actor.rig.bones, t = b.t, swingU = z.swing > 0 ? 1 - z.swing / BOSS.attack.swing : -1
    const phase = b.stride / (1.15 * BOSS.scale) * Math.PI
    for (const [key, sign] of [['L', 1], ['R', -1]] as const) {
      const upper = bones[`upper_arm.${key}`], fore = bones[`forearm.${key}`], hand = bones[`hand.${key}`]
      const shoulder = upper.getWorldPosition(pz.shoulder)
      const reach = shoulder.distanceTo(fore.getWorldPosition(pz.elbow)) + pz.elbow.distanceTo(hand.getWorldPosition(pz.hand))
      const at = (f: number, u: number, s: number, out = pz.target) => out.copy(shoulder).addScaledVector(forward, f * reach).addScaledVector(UP, u * reach).addScaledVector(left, sign * s * reach)
      // Hanging heavy, swinging with its stride (opposite arms), or barely at rest.
      const swing = Math.sin(phase + (sign > 0 ? 0 : Math.PI)) * (moving ? 1 : 0.12)
      const hang = at(0.28 + 0.22 * swing, -0.82, 0.12, pz.rest)
      const target = pz.target.copy(hang)
      let pole = pz.pole.copy(left).multiplyScalar(sign * 0.7).addScaledVector(forward, -0.45).addScaledVector(UP, -0.25)
      let direction: THREE.Vector3 | undefined
      const w = BOSS.attack.windup / BOSS.attack.swing
      switch (pose) {
        case 'swing':
          if (key === 'R') {
            if (swingU < w) target.lerp(at(-0.12, 0.8, 0.22, scratch.e), e(swingU, 0, w))
            else target.copy(at(-0.12, 0.8, 0.22, scratch.e)).lerp(at(0.8, -0.5, -0.08, scratch.d), e(swingU, w, w + 0.14)).lerp(hang, e(swingU, 0.8, 1))
            pole.copy(left).multiplyScalar(sign * 0.6).addScaledVector(UP, 0.35).addScaledVector(forward, -0.4)
          } else target.copy(at(0.4, -0.55, 0.3))
          break
        case 'slam': {
          const wind = bruteWindup(b, BOSS.slam.windup)
          const shake = t < wind ? Math.sin(t * 38 + sign) * 0.04 : 0
          if (t < wind) target.lerp(at(0.1, 0.85 + shake, 0.16), e(t, 0, wind * 0.5))
          else {
            const ground = scratch.e.copy(z.position).addScaledVector(forward, 0.85).addScaledVector(left, sign * 0.3).setY(z.position.y + 0.14)
            target.copy(at(0.1, 0.85, 0.16, scratch.d)).lerp(ground, e(t, wind, wind + 0.1))
            target.lerp(hang, e(t, wind + BOSS.slam.recover * 0.5, wind + BOSS.slam.recover))
          }
          pole.copy(left).multiplyScalar(sign * 0.8).addScaledVector(forward, -0.2)
          break
        }
        case 'charge': target.copy(at(-0.3, -0.7, 0.3)).addScaledVector(UP, 0.05 * Math.sin(phase * 2) * reach); break
        case 'skid': target.copy(at(0.5, -0.45, 0.4)); break
        case 'throw': {
          const wind = bruteWindup(b, BOSS.throw.windup), rip = wind * 0.32, release = wind * BOSS.throw.release
          if (key === 'R') {
            const ground = scratch.e.copy(z.position).addScaledVector(forward, 1).addScaledVector(left, -0.3).setY(z.position.y + 0.08)
            if (t < rip) target.lerp(ground, e(t, 0, rip))
            else if (t < release) target.copy(ground).lerp(at(-0.35, 0.75, -0.1, scratch.d), e(t, rip, release))
            else target.copy(at(-0.35, 0.75, -0.1, scratch.d)).lerp(at(0.85, -0.1, 0.05, scratch.e), e(t, release, release + 0.1)).lerp(hang, e(t, release + 0.2, wind + 0.35))
            pole.copy(left).multiplyScalar(sign * 0.6).addScaledVector(UP, t < rip ? -0.3 : 0.3).addScaledVector(forward, -0.4)
            direction = t >= rip && t < release ? UP : undefined
          } else target.copy(t < rip ? at(0.3, -0.72, 0.25) : at(0.8, 0.1, 0.1))
          break
        }
        case 'roar': target.copy(at(-0.1, 0.15 + Math.sin(t * 36 + sign) * 0.03, 0.82)); pole.copy(UP).multiplyScalar(-0.6).addScaledVector(forward, -0.5); break
        case 'dazed': target.copy(at(0.12, -0.95, 0.08)); break
        case 'face': {
          const head = bones.head.getWorldPosition(pz.head)
          target.copy(head).addScaledVector(forward, 0.22 * BOSS.scale).addScaledVector(left, sign * 0.1 * BOSS.scale).setY(head.y + 0.05)
          pole.copy(left).multiplyScalar(sign).addScaledVector(UP, -0.6)
          break
        }
        case 'sink': target.copy(at(0.1 + Math.sin(t * 7 + sign) * 0.08, 0.72, 0.35)); pole.copy(left).multiplyScalar(sign * 0.8).addScaledVector(forward, -0.3); break
      }
      solveArm(upper, fore, hand, target, pole.normalize(), forward, direction)
    }
  }

  /** The broken chains hanging from its shackles: a few links each, swinging and settling under their weight. */
  private chains(z: Zombie, dt: number) {
    const look = lookOf(z.actor)
    if (!look || !z.actor.root.visible || !look.chains.visible) return
    // Two small steps a frame; iron barely drags on the air, so gravity has it hang and swing.
    const steps = 2, step = Math.min(dt, 1 / 30) / steps
    const floor = z.position.y + 0.02
    z.actor.root.updateMatrixWorld(true)
    const inverse = chainInverse.copy(z.actor.root.matrixWorld).invert()
    const worldScale = BOSS.scale, length = LINK.length * worldScale
    for (const [i, side] of (['L', 'R'] as const).entries()) {
      const chain = look.links[i]
      const anchor = CHAIN_EYE(side).applyMatrix4((side === 'L' ? look.mounts.forearmL : look.mounts.forearmR).matrixWorld)
      // Its shackle jumped (it rose, or came up from the ink): hang it afresh rather than whip it about.
      if (!chain.ready || chain.last.distanceToSquared(anchor) > 0.5 * 0.5) {
        chain.points.forEach((p, k) => p.copy(anchor).setY(anchor.y - k * length))
        chain.previous.forEach((p, k) => p.copy(chain.points[k]))
        chain.ready = true
      }
      chain.last.copy(anchor)
      for (let s = 0; s < steps; s++) {
        chain.points[0].copy(anchor); chain.previous[0].copy(anchor)
        for (let k = 1; k < chain.points.length; k++) {
          const p = chain.points[k], q = chain.previous[k]
          let vx = (p.x - q.x) * 0.985, vy = (p.y - q.y) * 0.985, vz = (p.z - q.z) * 0.985
          // Never faster than a swung arm can fling it (8 m/s).
          const speed = Math.hypot(vx, vy, vz), most = 8 * step
          if (speed > most) { vx *= most / speed; vy *= most / speed; vz *= most / speed }
          q.copy(p)
          p.x += vx; p.y += vy - 14 * step * step; p.z += vz
        }
        for (let pass = 0; pass < 3; pass++) for (let k = 1; k < chain.points.length; k++) {
          const a = chain.points[k - 1], p = chain.points[k]
          const d = scratch.a.copy(p).sub(a), n = d.length() || 1e-6
          p.copy(a).addScaledVector(d, length / n)
          if (p.y < floor) p.y = floor
        }
      }
      for (let k = 0; k < LINK.links; k++) {
        const a = chain.points[k], p = chain.points[k + 1]
        const mid = scratch.b.copy(a).add(p).multiplyScalar(0.5)
        const axis = scratch.c.copy(p).sub(a).normalize()
        chainQuat.setFromUnitVectors(UP, axis.lengthSq() > 0.5 ? axis : UP)
        // Each link turned a quarter from the one before, as a chain's are.
        if (k % 2) chainQuat.multiply(QUARTER)
        look.chains.setMatrixAt(i * LINK.links + k, chainMatrix.compose(mid, chainQuat, scratch.s.setScalar(worldScale)).premultiply(inverse))
      }
    }
    look.chains.instanceMatrix.needsUpdate = true
  }

  // ---------------------------------------------------------------- upkeep

  /** Back to an empty field: no waves, chunks, pools or loose masks. */
  clear() {
    this.waves.clear(); this.debris.clear(); this.pools.clear(); this.pieces.clear()
    this.tracks.clear(); this.players = []
  }

  dispose() {
    this.clear()
    this.waves.dispose(); this.debris.dispose(); this.pools.dispose()
    this.root.removeFromParent()
  }
}
