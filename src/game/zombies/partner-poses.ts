import * as THREE from 'three'
import type { EnemyActor } from '../actors'
import { BONE_NAMES, type Rig } from '../../lab/rig'
import { poseQuat, type Pose } from '../../lab/clip'
import { heldPose } from '../../lab/weapons/poses'
import { FOOT_CLEARANCE, SHIN_LENGTH } from '../../lab/gait'
import { metal } from '../../lab/weapons/models/common'
import { createPenSilhouette, penPalette } from '../../render/ballpoint'
import type { PlayerState } from './coop'

/**
 * How the other players see a teammate go down, lie in last stand, crawl, get back up, revive someone and
 * bleed out (Dead Ink co-op). PartnerAvatar lends its stickman to this while any of that plays, and gets it
 * back through EnemyActor.setPosture('stand') once they are on their feet again.
 *
 * Poses are written straight onto the rig: keyed poses sampled on a spline, then a crawl, breathing and aim
 * layer, then IK for the pistol (elbow on the floor), the free hand, the head, and legs lying on the floor.
 * Every change starts from the pose on screen and every layer eases in and out, so nothing pops.
 * Nothing is allocated per frame.
 */
export type PartnerPhase = 'up' | 'fall' | 'down' | 'rise' | 'revive' | 'dead'
/** What the poses read from a player's state. `rv` (the revive's progress, 0 to 1) is set while they hold F on a downed teammate. */
export type PartnerPoseState = Pick<PlayerState, 'dn' | 'mv' | 'yaw' | 'pitch' | 'rv'>

export const PARTNER_POSE_SECONDS = { fall: 0.6, rise: 1.2, kneel: 0.25, slump: 1.1 } as const
/** Last stand aim limits (radians, from the body's heading): a lying body turns to face anything further round. */
export const PARTNER_AIM_LIMITS = { left: 0.95, right: 0.55, down: -0.35, up: 0.8 } as const

// Dev builds: window.__partnerPoses (partner-poses-debug.ts) plays every pose on a stickman in front of you.
if (import.meta.env?.DEV && typeof window !== 'undefined') void import('./partner-poses-debug').then(debug => debug.install())

const N = BONE_NAMES.length
const DEG = THREE.MathUtils.DEG2RAD
/** Heights above the floor of joints resting on it (death-settle.ts measures the same mesh; feet as the gait stands them). */
const ELBOW_FLOOR = 0.065, HAND_FLOOR = 0.054, KNEE_FLOOR = 0.065, FOOT_FLOOR = FOOT_CLEARANCE
/** One crawl cycle covers this much ground; the planted hand sweeps half of it, so it does not slide. */
const CRAWL_STRIDE = 0.6
/**
 * Reviving: they look at the teammate to revive them, so the look's pitch (from about REVIVE_EYE above the
 * teammate) says how far ahead the syringe goes: from REACH to REACH_MOST. Past LEAN_FROM the kneeling body
 * leans in toward it, at most LEAN; further it would kneel on them, so the arm reaches the rest.
 */
const REACH = 0.46, REACH_MOST = 1.0, LEAN_FROM = 0.7, LEAN = 0.3, REVIVE_EYE = 1.4
/** How much further the kneeling back bends (radians) for a syringe at REACH_MOST. */
const REVIVE_BEND = 0.4

// ---------------------------------------------------------------- poses (degrees, lab convention: see rig.ts)

type V3 = [number, number, number]
/**
 * A torso segment by intent (degrees, in the body's frame): how far its spine rises above the floor, how far
 * it turns left, and how far it rolls about itself onto its right side (0 = face down, 90 = on the right side).
 */
type Segment = [rise: number, turn: number, roll: number]
/** Lying poses give the pelvis and chest this way; the spine takes half the bend between them. */
type Keyed = { pose: Pose; root: V3; pelvis?: Segment; chest?: Segment }
/** Arms hanging, as src/lab/clips/idle.ts `hang` (that module builds clips on import, so it is not imported). */
const HANG: Pose = { 'upper_arm.L': [-78, 0, 0], 'upper_arm.R': [-78, 0, 0], 'forearm.L': [0, 0, -10], 'forearm.R': [0, 0, 10] }
const UPRIGHT: Pose = { ...HANG, hips: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
  'thigh.L': [0, 0, 0], 'thigh.R': [0, 0, 0], 'shin.L': [0, 0, 0], 'shin.R': [0, 0, 0], 'hand.L': [0, 0, 0], 'hand.R': [0, 0, 0] }
/** Left hand pressed to the belly, as the hit clips clutch the chest. */
const CLUTCH: Pose = { 'upper_arm.L': [-62, -70, 0], 'forearm.L': [-30, 0, -125], 'hand.L': [-20, 0, 0] }
const GUN_LOW: Pose = { 'upper_arm.R': [-72, -18, 0], 'forearm.R': [0, 0, 38], 'hand.R': [0, 0, 20] }
/** Gun held in front of the belly: when the body is low a hanging gun hand would go through the floor. */
const GUN_TUCK: Pose = { 'upper_arm.R': [-70, -25, 0], 'forearm.R': [0, 0, 85], 'hand.R': [0, 0, 20] }

/** Last stand: rolled onto the right side, chest up on the right elbow, pistol forward, left knee drawn up. */
const DOWN: Keyed = { root: [0, -0.68, -0.15], pelvis: [15, 0, 45], chest: [40, -6, 50], pose: { ...UPRIGHT, ...CLUTCH,
  neck: [-15, 0, -20], head: [-20, 0, -20],
  'thigh.R': [24.5, -8.5, -1], 'shin.R': [10, 0, 0], 'thigh.L': [-66, -31, -3], 'shin.L': [81, 0, 0],
  'upper_arm.R': [-20, -70, 0], 'forearm.R': [0, 0, 100], 'hand.R': [0, 0, 0] } }
/** The collapse: knees go, down onto the right hip, over onto the side. */
const BUCKLE: Keyed = { root: [0, -0.12, -0.03], pose: { ...UPRIGHT, ...CLUTCH, ...GUN_LOW,
  hips: [10, 0, -1], spine: [14, 0, 0], chest: [8, 0, 0], neck: [6, 0, 0], head: [18, 0, 0],
  'thigh.L': [-29, 0, -4], 'shin.L': [60, 0, 0], 'thigh.R': [-16.5, 0, -2], 'shin.R': [52, 0, 0] } }
const HIP: Keyed = { root: [0.04, -0.476, -0.1], pose: { ...UPRIGHT, ...CLUTCH,
  hips: [22, 0, 34], spine: [8, 0, -10], chest: [4, 0, -8], neck: [4, 0, -4], head: [8, 0, -10],
  'thigh.L': [-78, 6.5, -12], 'shin.L': [105.5, 0, 0], 'thigh.R': [-53.5, -3.5, -16], 'shin.R': [121, 0, 0],
  'upper_arm.R': [-86, -24, 0], 'forearm.R': [0, 0, 30], 'hand.R': [0, 0, 0] } }
const SIDE: Keyed = { root: [0.02, -0.508, -0.12], pelvis: [25, 0, 55], chest: [30, 0, 55], pose: { ...UPRIGHT, ...CLUTCH,
  neck: [-6, 0, -10], head: [-12, 0, -12],
  'thigh.L': [-62.5, 9, 1.5], 'shin.L': [87, 0, 0], 'thigh.R': [-10, 7, -7.5], 'shin.R': [46, 0, 0],
  'upper_arm.R': [-40, -60, 0], 'forearm.R': [0, 0, 70], 'hand.R': [0, 0, 0] } }
/** The get-up: roll onto the knees, up on one knee, push off it, stand. */
const ROLL: Keyed = { root: [0, -0.48, -0.08], pose: { ...UPRIGHT, ...GUN_TUCK,
  hips: [78, 0, 16], spine: [-12, 0, 0], chest: [-10, 0, 0], neck: [-12, 0, 0], head: [-30, 0, 0],
  'thigh.L': [-111, -9, -1.5], 'shin.L': [120, 0, 0], 'thigh.R': [-32, 1.3, -5], 'shin.R': [43, 0, 0],
  'upper_arm.L': [-30, -60, 0], 'forearm.L': [0, 0, -20], 'hand.L': [0, 0, -30] } }
const KNEE: Keyed = { root: [0, -0.408, -0.05], pose: { ...UPRIGHT, ...GUN_TUCK,
  hips: [44, 0, 2], spine: [14, 0, 0], chest: [10, 0, 0], neck: [-8, 0, 0], head: [-24, 0, 0],
  'thigh.L': [-92.5, 0, -10.5], 'shin.L': [122.5, 0, 0], 'thigh.R': [-15, 0, -8.5], 'shin.R': [61.5, 0, 0],
  'upper_arm.L': [-48, -64, 0], 'forearm.L': [-10, 0, -30], 'hand.L': [0, 0, -20] } }
const KNEEL_UP: Keyed = { root: [0, -0.371, -0.06], pose: { ...UPRIGHT, ...GUN_TUCK,
  hips: [8, 0, 0], spine: [10, 0, 0], chest: [6, 0, 0], neck: [0, 0, 0], head: [-6, 0, 0],
  'thigh.L': [-96, 0, -7.5], 'shin.L': [93, 0, 0], 'thigh.R': [-25.5, 0, -4], 'shin.R': [106, 0, 0],
  'upper_arm.L': [-66, -58, 0], 'forearm.L': [-20, 0, -40], 'hand.L': [0, 0, -20] } }
const PUSH: Keyed = { root: [0, -0.139, -0.03], pose: { ...UPRIGHT, ...GUN_LOW,
  hips: [14, 0, 0], spine: [8, 0, 0], chest: [4, 0, 0], head: [-4, 0, 0],
  'thigh.L': [-43, 0, -3], 'shin.L': [68, 0, 0], 'thigh.R': [-6.5, 0, -2], 'shin.R': [43, 0, 0],
  'upper_arm.L': [-74, -20, 0], 'forearm.L': [0, 0, -30] } }
const STAND: Keyed = { root: [0, 0, 0], pose: UPRIGHT }
/** Reviving: down on the right knee, leaning in over them, gun low; the left hand is IK (the syringe). */
const KNEEL: Keyed = { root: [0, -0.38, -0.06], pose: { ...UPRIGHT, ...GUN_LOW,
  hips: [12, 0, 0], spine: [30, 0, 0], chest: [22, 0, 0], neck: [8, 0, 0], head: [18, 0, 0],
  'thigh.L': [-102, 0, -5], 'shin.L': [92, 0, 0], 'thigh.R': [-28, 0, -4], 'shin.R': [106, 0, 0],
  'upper_arm.L': [-30, -70, 0], 'forearm.L': [0, 0, -20], 'hand.L': [0, 0, -40] } }
/**
 * Bled out: still, face down, head turned, as the hostage mission's body-shot death ends (dieBody's last
 * key). Its arms are laid at bind, bent forward on the floor from where the last stand's arms were.
 */
const DEAD: Keyed = { root: [0, -0.71, -0.09], pose: { ...UPRIGHT,
  hips: [90, 0, 0], chest: [-6, 0, 0], neck: [-12, 0, 0], head: [-18, 42, 0],
  'thigh.L': [0, 0, -4], 'thigh.R': [0, 0, -4], 'shin.L': [12, 0, 0], 'shin.R': [8, 0, 0] } }
/** Crawl cycle keys over DOWN: the left knee draws up and drives, the body surges forward. */
const CRAWL: Keyed[] = [
  { root: [0, -0.68, -0.17], pelvis: [15, 4, 48], chest: [38, 4, 52], pose: { 'thigh.L': [-82, -26, 0], 'shin.L': [107, 0, 0], 'thigh.R': [12, 2, -9.5], 'shin.R': [9.5, 0, 0] } },
  { root: [0, -0.685, -0.12], pelvis: [14, 0, 44], chest: [36, -2, 48], pose: { 'thigh.L': [-50, -35, 1.3], 'shin.L': [74.5, 0, 0], 'thigh.R': [8, -5.5, -12.5], 'shin.R': [12, 0, 0] } },
  { root: [0, -0.68, -0.08], pelvis: [15, -3, 42], chest: [40, -8, 46], pose: { 'thigh.L': [-18, -14.5, -6], 'shin.L': [24, 0, 0], 'thigh.R': [6, -13, -15], 'shin.R': [18, 0, 0] } },
  { root: [0, -0.675, -0.13], pelvis: [16, 0, 46], chest: [41, -4, 50], pose: { 'thigh.L': [-50, -31.5, 0], 'shin.L': [76, 0, 0], 'thigh.R': [10, -1.5, -12], 'shin.R': [12, 0, 0] } },
]
/** The actor's standing pistol aim (its actor is made with a pistol, so it holds every gun this way): the get-up ends in it. */
const AIM_HOLD = { position: [-0.13, 1.22, 0.55] as V3, pitch: 0 }

// ---------------------------------------------------------------- frames: a whole pose as flat quaternions

type Frame = { q: Float64Array; hips: THREE.Vector3 }
type Key = { t: number; f: Frame }
const newFrame = (): Frame => ({ q: new Float64Array(N * 4), hips: new THREE.Vector3() })
const smooth = (u: number) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
/**
 * A layer's weight. Two lags in series: it leaves at zero speed (a single lag jumps a quarter of the way
 * in its first frame, which snaps an arm), settles over about 2.5 `seconds`, and lands exactly.
 */
class Weight {
  value = 0
  private lead = 0
  to(target: number, dt: number, seconds: number) {
    const k = 1 - Math.exp(-2 * dt / seconds)
    this.lead += (target - this.lead) * k
    this.value += (this.lead - this.value) * k
    if (Math.abs(target - this.lead) < 1e-3 && Math.abs(target - this.value) < 1e-3) this.lead = this.value = target
  }
  cap(max: number) { this.lead = Math.min(this.lead, max); this.value = Math.min(this.value, max) }
  reset() { this.lead = this.value = 0 }
}

/** A torso segment's rotation in the body frame: +Y along its spine, +Z out of its front. */
function segment([rise, turn, roll]: Segment) {
  const spine = new THREE.Vector3(Math.sin(turn * DEG) * Math.cos(rise * DEG), Math.sin(rise * DEG), Math.cos(turn * DEG) * Math.cos(rise * DEG))
  const front = new THREE.Vector3(0, -1, 0).addScaledVector(spine, spine.y).normalize().applyAxisAngle(spine, roll * DEG)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(spine, front), spine, front))
}
function frameOf(rig: Rig, key: Keyed, base?: Keyed, out = newFrame()) {
  const full: Pose = base ? { ...base.pose, ...key.pose } : key.pose
  const q = new THREE.Quaternion()
  BONE_NAMES.forEach((name, i) => poseQuat(name, full[name] ?? [0, 0, 0], q).toArray(out.q, i * 4))
  const pelvis = key.pelvis ?? base?.pelvis, chest = key.chest ?? base?.chest
  if (pelvis && chest) {
    // The hips hang from the body frame; spine and chest share the bend from pelvis to chest.
    const p = segment(pelvis), c = segment(chest), mid = p.clone().slerp(c, 0.5)
    p.toArray(out.q, BONE_NAMES.indexOf('hips') * 4)
    p.clone().invert().multiply(mid).toArray(out.q, BONE_NAMES.indexOf('spine') * 4)
    mid.clone().invert().multiply(c).toArray(out.q, BONE_NAMES.indexOf('chest') * 4)
  }
  out.hips.copy(rig.rest.hips.pos).add(new THREE.Vector3(...key.root))
  return out
}
function copyFrame(out: Frame, from: Frame) { out.q.set(from.q); out.hips.copy(from.hips) }
function capture(out: Frame, rig: Rig) {
  for (let i = 0; i < N; i++) rig.bones[BONE_NAMES[i]].quaternion.toArray(out.q, i * 4)
  out.hips.copy(rig.bones.hips.position)
}
/** three's slerpFlat works on typed arrays too; its typings only say number[]. */
const slerpFlat = THREE.Quaternion.slerpFlat as unknown as
  (dst: Float64Array, dstOffset: number, a: Float64Array, aOffset: number, b: Float64Array, bOffset: number, t: number) => void
function mix(out: Frame, a: Frame, b: Frame, w: number) {
  for (let i = 0; i < N; i++) slerpFlat(out.q, i * 4, a.q, i * 4, b.q, i * 4, w)
  out.hips.lerpVectors(a.hips, b.hips, w)
}
// No Math.hypot in per-frame code: V8 allocates an array for its arguments on every call.
const dot4 = (a: Float64Array, b: Float64Array, i: number) => a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3]
/** Catmull-Rom from b to c on the quaternion components (signs aligned, then normalised); `out` may be any input. */
function spline(out: Frame, a: Frame, b: Frame, c: Frame, d: Frame, u: number) {
  const u2 = u * u, u3 = u2 * u
  const wa = -0.5 * u3 + u2 - 0.5 * u, wb = 1.5 * u3 - 2.5 * u2 + 1, wc = -1.5 * u3 + 2 * u2 + 0.5 * u, wd = 0.5 * u3 - 0.5 * u2
  for (let i = 0; i < N * 4; i += 4) {
    const sc = dot4(c.q, b.q, i) < 0 ? -wc : wc, sa = dot4(a.q, b.q, i) < 0 ? -wa : wa
    const sd = dot4(d.q, c.q, i) * sc < 0 ? -wd : wd
    const x = sa * a.q[i] + wb * b.q[i] + sc * c.q[i] + sd * d.q[i]
    const y = sa * a.q[i + 1] + wb * b.q[i + 1] + sc * c.q[i + 1] + sd * d.q[i + 1]
    const z = sa * a.q[i + 2] + wb * b.q[i + 2] + sc * c.q[i + 2] + sd * d.q[i + 2]
    const w = sa * a.q[i + 3] + wb * b.q[i + 3] + sc * c.q[i + 3] + sd * d.q[i + 3]
    const scale = 1 / Math.sqrt(x * x + y * y + z * z + w * w)
    out.q[i] = x * scale; out.q[i + 1] = y * scale; out.q[i + 2] = z * scale; out.q[i + 3] = w * scale
  }
  const hx = a.hips.x * wa + b.hips.x * wb + c.hips.x * wc + d.hips.x * wd
  const hy = a.hips.y * wa + b.hips.y * wb + c.hips.y * wc + d.hips.y * wd
  const hz = a.hips.z * wa + b.hips.z * wb + c.hips.z * wc + d.hips.z * wd
  out.hips.set(hx, hy, hz)
}
/** Sample keyed frames; easeIn/easeOut make the ends start and stop at rest. */
function sampleKeys(out: Frame, keys: readonly Key[], t: number, easeIn: boolean, easeOut: boolean) {
  const n = keys.length
  if (t <= keys[0].t) return copyFrame(out, keys[0].f)
  if (t >= keys[n - 1].t) return copyFrame(out, keys[n - 1].f)
  let i = 1
  while (keys[i].t < t) i++
  const k1 = keys[i - 1], k2 = keys[i]
  spline(out, i >= 2 ? keys[i - 2].f : easeIn ? k2.f : k1.f, k1.f, k2.f,
    i + 1 < n ? keys[i + 1].f : easeOut ? k1.f : k2.f, (t - k1.t) / (k2.t - k1.t))
}
function sampleLoop(out: Frame, loop: readonly Frame[], phase: number) {
  const n = loop.length, x = (phase - Math.floor(phase)) * n, i = Math.floor(x) % n
  spline(out, loop[(i + n - 1) % n], loop[i], loop[(i + 1) % n], loop[(i + 2) % n], x - Math.floor(x))
}
function apply(rig: Rig, f: Frame) {
  for (let i = 0; i < N; i++) rig.bones[BONE_NAMES[i]].quaternion.fromArray(f.q, i * 4)
  rig.bones.hips.position.copy(f.hips)
}

// ---------------------------------------------------------------- scratch (shared: updates are synchronous)

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3()
const v5 = new THREE.Vector3(), v6 = new THREE.Vector3(), v7 = new THREE.Vector3(), v8 = new THREE.Vector3()
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion()
const e1 = new THREE.Euler()
const m1 = new THREE.Matrix4()
const UP = new THREE.Vector3(0, 1, 0)
const ORIGIN = new THREE.Vector3()
const FIST = new THREE.Vector3(0, 0.035, 0)
const FOOT_END = new THREE.Vector3(0, SHIN_LENGTH, 0)
const HEAD_CENTRE = new THREE.Vector3(0, 0.19, 0)
const HAND_ALONG_Z = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)

/** `[side, up, forward]` from `from` in the body's heading, to world. Left is +side. Pass ORIGIN for a direction. */
function bodyPoint(out: THREE.Vector3, from: THREE.Vector3, heading: number, side: number, up: number, forward: number) {
  const s = Math.sin(heading), c = Math.cos(heading)
  return out.set(from.x + s * forward + c * side, from.y + up, from.z + c * forward - s * side)
}
/** A world rotation whose +Z is `forward` and whose +Y leans to `up`. */
function lookRotation(out: THREE.Quaternion, forward: THREE.Vector3, up: THREE.Vector3) {
  v7.crossVectors(up, forward)
  if (v7.lengthSq() < 1e-8) v7.set(1, 0, 0)
  v7.normalize()
  v8.crossVectors(forward, v7)
  return out.setFromRotationMatrix(m1.makeBasis(v7, v8, forward))
}
/** Turn one bone so its local point `end` lands on `target` (world), without stretching it. */
function aimBone(bone: THREE.Bone, end: THREE.Vector3, target: THREE.Vector3) {
  bone.getWorldPosition(v1)
  v2.copy(end); bone.localToWorld(v2).sub(v1)
  v3.subVectors(target, v1)
  if (v2.lengthSq() < 1e-10 || v3.lengthSq() < 1e-10) return
  q1.setFromUnitVectors(v2.normalize(), v3.normalize()).multiply(bone.getWorldQuaternion(q2))
  bone.quaternion.copy(bone.parent!.getWorldQuaternion(q3).invert().multiply(q1))
  bone.updateWorldMatrix(false, true)
}
/** How fast the posed body may turn to face somewhere new (rad/s). */
const TURN_SPEED = 8
/** How fast a floor clamp's heading may turn (rad/s). */
const HEADING_TURN = 9
/** The body's forward, for segments that point straight down and so have no heading of their own. */
const FORWARD = new THREE.Vector3(0, 0, 1)
/** Where a segment from `origin` of `length` ends at height `height`, heading along `memory` (see trackHeading). */
function groundedEnd(out: THREE.Vector3, origin: THREE.Vector3, length: number, height: number, memory: THREE.Vector3) {
  const dy = THREE.MathUtils.clamp(height - origin.y, -length, length)
  return out.copy(memory).multiplyScalar(Math.sqrt(Math.max(0, length * length - dy * dy))).add(origin).setY(origin.y + dy)
}
/**
 * Keep `memory` on a segment's heading (its direction seen from above), every frame. When the segment
 * has a clear heading it is simply that; near vertical the heading is noise that can swing round in one
 * frame, so there the memory only turns toward it slowly, by how much of a heading the segment has.
 */
function trackHeading(memory: THREE.Vector3, origin: THREE.Vector3, end: THREE.Vector3, length: number, dt: number) {
  if (memory.lengthSq() < 0.5) memory.copy(FORWARD)
  const x = end.x - origin.x, z = end.z - origin.z, flat = Math.sqrt(x * x + z * z), own = smooth(flat / (0.35 * length))
  if (flat < 1e-9 || own <= 0) return
  // A turn about the vertical (a weighted sum of the two could cancel out when they point apart).
  const angle = Math.atan2(memory.z * x - memory.x * z, memory.x * x + memory.z * z)
  const limit = HEADING_TURN * dt + own ** 4 * Math.abs(angle)
  const turn = THREE.MathUtils.clamp(own * angle, -limit, limit), c = Math.cos(turn), s = Math.sin(turn)
  memory.set(memory.x * c + memory.z * s, 0, -memory.x * s + memory.z * c).normalize()
}
/** Swing `bone` so its local point `end` sits at `height`: all the way by `settle`, or just enough to clear the floor. */
function restOnFloor(bone: THREE.Bone, end: THREE.Vector3, length: number, height: number, settle: number, memory: THREE.Vector3, dt: number) {
  bone.getWorldPosition(v5)
  const tip = bone.localToWorld(v4.copy(end))
  trackHeading(memory, v5, tip, length, dt)
  const target = tip.y < height ? height : THREE.MathUtils.lerp(tip.y, height, settle)
  if (Math.abs(target - tip.y) < 1e-4) return
  groundedEnd(v6, v5, length, target, memory)
  aimBone(bone, end, v6)
}
/** How far a steep segment's end (bone-local `end`) is under `height`, scaled by how steep it is. */
function standOn(bone: THREE.Bone, end: THREE.Vector3, length: number, height: number) {
  bone.getWorldPosition(v5)
  const tip = bone.localToWorld(v4.copy(end)), steep = smooth(((v5.y - tip.y) / length - 0.6) / 0.3)
  return steep > 0 ? (height - tip.y) * steep : 0
}
/** How far `point` (bone-local, or the joint itself) is under `height`. */
function under(bone: THREE.Bone, local: THREE.Vector3 | null, height: number) {
  return height - (local ? bone.localToWorld(v4.copy(local)) : bone.getWorldPosition(v4)).y
}
function addEuler(bone: THREE.Bone, x: number, y: number, z: number) {
  bone.quaternion.multiply(q1.setFromEuler(e1.set(x, y, z, 'ZYX')))
}
/** Where a hand goes: its world turn (or undefined to keep the wrist's own bend) and where the elbow points. */
type Placement = { orientation?: THREE.Quaternion; pole: THREE.Vector3 }
const placement: Placement = { pole: new THREE.Vector3() }
/** The one placement object every reach reuses. */
function place(orientation: THREE.Quaternion | undefined, pole: THREE.Vector3) {
  placement.orientation = orientation
  placement.pole = pole
  return placement
}

// Scratch for the arm solve.
const shoulderAt = new THREE.Vector3(), elbowAt = new THREE.Vector3(), wristAt = new THREE.Vector3()
const goalWrist = new THREE.Vector3(), goalBend = new THREE.Vector3(), goalHinge = new THREE.Vector3()
const handNow = new THREE.Quaternion(), handLocal = new THREE.Quaternion(), handGoal = new THREE.Quaternion(), handOut = new THREE.Quaternion()
const hingeUpper = new THREE.Vector3(), hingeFore = new THREE.Vector3(), goalElbow = new THREE.Vector3(), bendOut = new THREE.Vector3()
const reachAxis = new THREE.Vector3(), turnedA = new THREE.Vector3(), offset = new THREE.Vector3()
const shortArc = new THREE.Quaternion(), longArc = new THREE.Quaternion(), parentTurn = new THREE.Quaternion()
const laidUpper = new THREE.Quaternion(), laidFore = new THREE.Quaternion(), laidElbow = new THREE.Vector3(), laidWrist = new THREE.Vector3()
const frameX = new THREE.Vector3(), frameY = new THREE.Vector3(), frameZ = new THREE.Vector3(), frameM = new THREE.Matrix4()
const Z_AXIS = new THREE.Vector3(0, 0, 1)
/** Each arm's bones, upper to hand (named once: a template string would build a new name every frame). */
const ARM = { L: ['upper_arm.L', 'forearm.L', 'hand.L'], R: ['upper_arm.R', 'forearm.R', 'hand.R'] } as const
/** Within 20 degrees of a half turn the two ways round swap from frame to frame: there, keep to last frame's. */
const HALF_TURN_QUATERNION = Math.cos((Math.PI - 20 * DEG) / 2)

/** Slerp from a to b along the short arc, or the long one. */
function arc(out: THREE.Quaternion, a: THREE.Quaternion, b: THREE.Quaternion, t: number, long: boolean) {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, sign = 1
  if ((dot < 0) !== long) { sign = -1; dot = -dot }
  const theta = Math.acos(THREE.MathUtils.clamp(dot, -1, 1)), sin = Math.sin(theta)
  if (sin < 1e-6) return out.set(a.x + (sign * b.x - a.x) * t, a.y + (sign * b.y - a.y) * t, a.z + (sign * b.z - a.z) * t, a.w + (sign * b.w - a.w) * t).normalize()
  const wa = Math.sin((1 - t) * theta) / sin, wb = sign * Math.sin(t * theta) / sin
  return out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb, a.w * wa + b.w * wb)
}
/** A bone's world turn with +Y along `y` and +Z toward `z` (made square to it). */
function frame(out: THREE.Quaternion, y: THREE.Vector3, z: THREE.Vector3) {
  frameZ.copy(z).addScaledVector(y, -z.dot(y))
  if (frameZ.lengthSq() < 1e-10) {
    frameZ.set(y.y, -y.x, 0)
    if (frameZ.lengthSq() < 1e-10) frameZ.set(0, y.z, -y.y)
  }
  frameZ.normalize()
  frameX.crossVectors(y, frameZ)
  return out.setFromRotationMatrix(frameM.makeBasis(frameX, y, frameZ))
}
const PALM_DOWN = new THREE.Quaternion()
/** A hand flat on the floor: fingers (+Y) along `forward`, palm (-Z) down. */
function palmDown(forward: THREE.Vector3) {
  frameY.copy(forward).setY(0).normalize()
  frameZ.set(0, 1, 0)
  frameX.crossVectors(frameY, frameZ)
  return PALM_DOWN.setFromRotationMatrix(frameM.makeBasis(frameX, frameY, frameZ))
}
/**
 * Lay an arm from the shoulder to a wrist point: the elbow toward `bend` (square to the reach), the upper
 * arm and forearm each turned about their length so +Z (the elbow's hinge) points to `zUpper` / `zFore`.
 * Leaves the world turns in laidUpper / laidFore. Unlike a minimal-rotation solve, the result depends only
 * on these inputs, never on the pose the arm had, so it cannot flip or spin between frames.
 */
function layArm(shoulder: THREE.Vector3, wrist: THREE.Vector3, bend: THREE.Vector3, zUpper: THREE.Vector3, zFore: THREE.Vector3, upperLength: number, foreLength: number) {
  reachAxis.subVectors(wrist, shoulder)
  const distance = reachAxis.length()
  if (distance < 1e-6) reachAxis.set(0, -1, 0)
  else reachAxis.divideScalar(distance)
  const reach = THREE.MathUtils.clamp(distance, Math.abs(upperLength - foreLength) + 1e-4, (upperLength + foreLength) * 0.9999)
  const along = (upperLength * upperLength - foreLength * foreLength + reach * reach) / (2 * reach)
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along))
  offset.copy(bend).addScaledVector(reachAxis, -bend.dot(reachAxis))
  if (offset.lengthSq() < 1e-10) {
    offset.set(reachAxis.y, -reachAxis.x, 0)
    if (offset.lengthSq() < 1e-10) offset.set(0, reachAxis.z, -reachAxis.y)
  }
  offset.normalize()
  laidElbow.copy(shoulder).addScaledVector(reachAxis, along).addScaledVector(offset, height)
  laidWrist.copy(shoulder).addScaledVector(reachAxis, reach)
  frame(laidUpper, frameY.subVectors(laidElbow, shoulder).normalize(), zUpper)
  frame(laidFore, frameY.subVectors(laidWrist, laidElbow).normalize(), zFore)
}
/**
 * Pull a wrist goal in toward the shoulder near the arm's full length, smoothly: past 90% of it the reach
 * eases toward 98.5%. A straight arm's elbow moves infinitely fast as it starts to bend; this one never
 * quite straightens, so an out-of-reach goal coming into reach does not kick the elbow.
 */
function softReach(wrist: THREE.Vector3, shoulder: THREE.Vector3, length: number) {
  offset.subVectors(wrist, shoulder)
  const distance = offset.length(), knee = length * 0.9, most = length * 0.985
  if (distance <= knee) return
  wrist.copy(shoulder).addScaledVector(offset, (knee + (most - knee) * Math.tanh((distance - knee) / (most - knee))) / distance)
}
/** The elbow's inside angle (pi when straight) for a wrist `reach` from the shoulder. */
function elbowAngle(reach: number, upperLength: number, foreLength: number) {
  return Math.acos(THREE.MathUtils.clamp((upperLength * upperLength + foreLength * foreLength - reach * reach) / (2 * upperLength * foreLength), -1, 1))
}
/** The elbow's hinge (the bones' +Z) for an elbow bending toward `bend` off `axis`: +Z on the right arm, -Z on the left. */
function hingeFor(out: THREE.Vector3, bend: THREE.Vector3, axis: THREE.Vector3, side: 'L' | 'R') {
  out.crossVectors(bend, axis)
  if (side === 'L') out.negate()
  return out.normalize()
}
/** Move unit vector `from` toward `to` by `t`; through the half turn it keeps to `last`'s side. */
function towardDirection(out: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3, t: number, last: THREE.Vector3 | null) {
  out.copy(from).multiplyScalar(1 - t).addScaledVector(to, t)
  const length = out.length()
  if (length < 0.35 && last) out.addScaledVector(last, 0.35 - length)
  if (out.lengthSq() < 1e-10) out.copy(to)
  return out.normalize()
}

/** How well turning bendOut by `swing` about the reach (offset = reach x bendOut) keeps the elbow where it was, and out to its side. */
function elbowScore(swing: number, lastSide: THREE.Vector3, heading: number, out: number) {
  const c = Math.cos(swing), s = Math.sin(swing)
  const x = bendOut.x * c + offset.x * s, y = bendOut.y * c + offset.y * s, z = bendOut.z * c + offset.z * s
  return (x * lastSide.x + y * lastSide.y + z * lastSide.z) / (lastSide.length() || 1) + 0.25 * out * (x * Math.cos(heading) - z * Math.sin(heading))
}
/**
 * Keep an arm out of the floor: the wrist raised onto it, the elbow kept on its side of the reach (turned
 * up about it only if under the floor), both segments keeping their twist, the hand its turn. A segment
 * turned out of the floor has no clear way to turn when it points straight down; this has no such case.
 */
function armOffFloor(rig: Rig, side: 'L' | 'R', ground: number, heading: number, lastSide: THREE.Vector3) {
  const arm = ARM[side], upper = rig.bones[arm[0]], fore = rig.bones[arm[1]], hand = rig.bones[arm[2]]
  upper.getWorldPosition(shoulderAt)
  fore.getWorldPosition(elbowAt)
  hand.getWorldPosition(wristAt)
  const wristLow = ground + HAND_FLOOR - wristAt.y, elbowLow = ground + ELBOW_FLOOR - elbowAt.y
  if (wristLow <= 0 && elbowLow <= 0) {
    lastSide.subVectors(elbowAt, shoulderAt)
    return
  }
  const upperLength = shoulderAt.distanceTo(elbowAt), foreLength = elbowAt.distanceTo(wristAt)
  if (wristLow > 0) wristAt.y += wristLow
  reachAxis.subVectors(wristAt, shoulderAt)
  const reach = THREE.MathUtils.clamp(reachAxis.length(), Math.abs(upperLength - foreLength) + 1e-4, (upperLength + foreLength) * 0.9999)
  reachAxis.normalize()
  const along = (upperLength * upperLength - foreLength * foreLength + reach * reach) / (2 * reach)
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along))
  bendOut.subVectors(elbowAt, shoulderAt)
  bendOut.addScaledVector(reachAxis, -bendOut.dot(reachAxis))
  if (bendOut.lengthSq() < 1e-10) bendOut.set(0, 1, 0).addScaledVector(reachAxis, -reachAxis.y)
  bendOut.normalize()
  // The elbow's height is shoulder + along the reach + bendOut * height: turn bendOut about the reach
  // (the shortest way) until that clears the floor.
  const needed = height > 1e-6 ? (ground + ELBOW_FLOOR - shoulderAt.y - reachAxis.y * along) / height : -Infinity
  if (bendOut.y < needed) {
    offset.crossVectors(reachAxis, bendOut)
    const r = Math.sqrt(bendOut.y * bendOut.y + offset.y * offset.y), phase = Math.atan2(offset.y, bendOut.y)
    const open = needed >= r ? 0 : Math.acos(needed / r)
    // Two ways up round the reach: the one nearest last frame's elbow, and from an elbow pointing
    // straight down (both as near) the one that takes the elbow out to the side.
    const out = side === 'L' ? 1 : -1
    const swing = elbowScore(phase - open, lastSide, heading, out) >= elbowScore(phase + open, lastSide, heading, out) ? phase - open : phase + open
    bendOut.multiplyScalar(Math.cos(swing)).addScaledVector(offset, Math.sin(swing))
  }
  hand.getWorldQuaternion(handNow)
  // Small corrections keep each segment's own twist; a big one re-lays the arm, and an old hinge axis
  // could then lie along a segment's new direction: take the hinge the new elbow bend gives instead.
  const big = smooth(Math.max(wristLow, elbowLow) / 0.06)
  hingeFor(goalHinge, bendOut, reachAxis, side)
  upper.getWorldQuaternion(parentTurn)
  towardDirection(hingeUpper, offset.copy(Z_AXIS).applyQuaternion(parentTurn), goalHinge, big, null)
  fore.getWorldQuaternion(parentTurn)
  towardDirection(hingeFore, offset.copy(Z_AXIS).applyQuaternion(parentTurn), goalHinge, big, null)
  layArm(shoulderAt, wristAt, bendOut, hingeUpper, hingeFore, upperLength, foreLength)
  upper.quaternion.copy(upper.parent!.getWorldQuaternion(parentTurn).invert().multiply(laidUpper))
  fore.quaternion.copy(parentTurn.copy(laidUpper).invert().multiply(laidFore))
  hand.quaternion.copy(parentTurn.copy(laidFore).invert().multiply(handNow))
  upper.updateWorldMatrix(false, true)
  lastSide.subVectors(laidElbow, shoulderAt)
}

/**
 * One IK layer on one arm, laid analytically (see layArm). The goal is the fist on `target`, the hand turned
 * to the placement's orientation, and the elbow toward its pole. Below full weight it does not blend bone
 * rotations (which can sweep the forearm through the floor or flip half-way) but what the arm does: the
 * wrist's direction from the shoulder and the elbow's bend angle, the elbow's position, the hand's turn and
 * each segment's hinge axis, each from the pose below toward the goal. At weight 0 the arm is exactly as it was.
 */
class Reach {
  private readonly lastHand = new THREE.Quaternion()
  private readonly lastBend = new THREE.Vector3()
  private readonly lastUpper = new THREE.Vector3()
  private readonly lastFore = new THREE.Vector3()
  private live = false
  constructor(private readonly side: 'L' | 'R') {}
  /** Not used this frame: the next use starts afresh. */
  idle() { this.live = false }
  apply(rig: Rig, target: THREE.Vector3, weight: number, goal: Placement) {
    if (!(weight > 0)) { this.live = false; return }
    const side = this.side, arm = ARM[side], upper = rig.bones[arm[0]], fore = rig.bones[arm[1]], hand = rig.bones[arm[2]]
    // The arm as the pose below this layer has it.
    upper.getWorldPosition(shoulderAt)
    fore.getWorldPosition(elbowAt)
    hand.getWorldPosition(wristAt)
    const upperLength = shoulderAt.distanceTo(elbowAt), foreLength = elbowAt.distanceTo(wristAt)
    hand.getWorldQuaternion(handNow)
    handLocal.copy(hand.quaternion)
    // The goal: the wrist behind the fist, the hinge square to the reach and the pole.
    if (goal.orientation) handGoal.copy(goal.orientation)
    else handGoal.copy(handNow)
    for (let pass = goal.orientation ? 1 : 0; pass < 2; pass++) {
      goalWrist.copy(FIST).applyQuaternion(handGoal).negate().add(target)
      softReach(goalWrist, shoulderAt, upperLength + foreLength)
      turnedA.subVectors(goalWrist, shoulderAt).normalize()
      goalBend.copy(goal.pole).addScaledVector(turnedA, -goal.pole.dot(turnedA))
      if (goalBend.lengthSq() < 1e-8) goalBend.copy(this.lastBend)
      goalBend.normalize()
      hingeFor(goalHinge, goalBend, turnedA, side)
      layArm(shoulderAt, goalWrist, goalBend, goalHinge, goalHinge, upperLength, foreLength)
      // No turn given: keep the wrist's own bend on the goal's forearm, then place the wrist again.
      if (pass === 0) handGoal.copy(laidFore).multiply(handLocal)
    }
    goalElbow.copy(laidElbow)
    if (weight >= 1) {
      handOut.copy(handGoal)
      wristAt.copy(goalWrist)
      bendOut.copy(goalBend)
      hingeUpper.copy(goalHinge)
      hingeFore.copy(goalHinge)
    } else {
      // The short way round; only near a half turn, where the two ways swap, keep to last frame's side.
      arc(shortArc, handNow, handGoal, weight, false)
      const dot = Math.abs(handNow.x * handGoal.x + handNow.y * handGoal.y + handNow.z * handGoal.z + handNow.w * handGoal.w)
      if (this.live && dot < HALF_TURN_QUATERNION) {
        arc(longArc, handNow, handGoal, weight, true)
        handOut.copy(longArc.angleTo(this.lastHand) < shortArc.angleTo(this.lastHand) ? longArc : shortArc)
      } else handOut.copy(shortArc)
      // The wrist: its direction from the shoulder and the elbow's bend blend apart, not its position. The
      // pose below may hold the arm dead straight (the guard's aim does), and a straight arm's elbow jumps
      // when the wrist comes in even a little; a blended bend angle opens it smoothly instead.
      const bendNow = elbowAngle(shoulderAt.distanceTo(wristAt), upperLength, foreLength)
      const bendGoal = elbowAngle(shoulderAt.distanceTo(goalWrist), upperLength, foreLength)
      offset.subVectors(wristAt, shoulderAt).normalize()
      turnedA.subVectors(goalWrist, shoulderAt).normalize()
      offset.multiplyScalar(1 - weight).addScaledVector(turnedA, weight)
      if (offset.lengthSq() < 1e-8) offset.copy(turnedA)
      const angle = THREE.MathUtils.lerp(bendNow, bendGoal, weight)
      wristAt.copy(shoulderAt).addScaledVector(offset.normalize(),
        Math.sqrt(Math.max(0, upperLength * upperLength + foreLength * foreLength - 2 * upperLength * foreLength * Math.cos(angle))))
      turnedA.subVectors(wristAt, shoulderAt).normalize()
      // The elbow's side: from its own position, moved in a straight line toward the goal's. Exact at
      // both ends, and a line only swings round the reach when the two elbows face opposite ways.
      bendOut.lerpVectors(elbowAt, goalElbow, weight).sub(shoulderAt)
      bendOut.addScaledVector(turnedA, -bendOut.dot(turnedA))
      if (bendOut.lengthSq() < 1e-10) bendOut.copy(this.lastBend)
      upper.getWorldQuaternion(parentTurn)
      towardDirection(hingeUpper, offset.copy(Z_AXIS).applyQuaternion(parentTurn), goalHinge, weight, this.live ? this.lastUpper : null)
      fore.getWorldQuaternion(parentTurn)
      towardDirection(hingeFore, offset.copy(Z_AXIS).applyQuaternion(parentTurn), goalHinge, weight, this.live ? this.lastFore : null)
    }
    layArm(shoulderAt, wristAt, bendOut, hingeUpper, hingeFore, upperLength, foreLength)
    upper.quaternion.copy(upper.parent!.getWorldQuaternion(parentTurn).invert().multiply(laidUpper))
    fore.quaternion.copy(parentTurn.copy(laidUpper).invert().multiply(laidFore))
    hand.quaternion.copy(parentTurn.copy(laidFore).invert().multiply(handOut))
    upper.updateWorldMatrix(false, true)
    this.lastHand.copy(handOut)
    this.lastBend.copy(bendOut)
    this.lastUpper.copy(hingeUpper)
    this.lastFore.copy(hingeFore)
    this.live = true
  }
}

// ---------------------------------------------------------------- the ink syringe (made once per avatar)

let syringeGeometry: Record<'barrel' | 'ink' | 'rod' | 'needle', THREE.CylinderGeometry> | null = null
/** The ink's needle end and the plunger's rest, along the hand's +Y. */
const SYRINGE_INK_END = 0.085, SYRINGE_ROD = -0.035
let inkMaterial: THREE.MeshBasicMaterial | null = null
function createSyringe() {
  syringeGeometry ??= {
    barrel: new THREE.CylinderGeometry(0.014, 0.014, 0.05, 10),
    ink: new THREE.CylinderGeometry(0.0145, 0.0145, 0.045, 10),
    rod: new THREE.CylinderGeometry(0.004, 0.004, 0.05, 6),
    needle: new THREE.CylinderGeometry(0.0018, 0.0018, 0.05, 4),
  }
  inkMaterial ??= new THREE.MeshBasicMaterial({ color: penPalette.ink, toneMapped: false })
  const g = new THREE.Group()
  g.name = 'Ink syringe'
  g.userData.noCollision = true
  const piece = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, y: number, outline: boolean) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.y = y
    parent.add(mesh)
    if (outline) { const hull = createPenSilhouette(geometry, 1.6, penPalette.ink, 'weapon'); hull.position.y = y; parent.add(hull) }
  }
  // Along the hand's +Y, needle first: black ink, then the empty paper barrel, then the plunger.
  piece(g, syringeGeometry.needle, inkMaterial, 0.11, false)
  const ink = new THREE.Group(), rod = new THREE.Group()
  ink.position.y = SYRINGE_INK_END
  rod.position.y = SYRINGE_ROD
  g.add(ink, rod)
  piece(ink, syringeGeometry.ink, inkMaterial, -0.0225, true)
  piece(g, syringeGeometry.barrel, metal, 0.01, true)
  piece(rod, syringeGeometry.rod, metal, 0, true)
  g.userData.ink = ink
  g.userData.rod = rod
  g.visible = false
  return g
}
/** As the revive runs, the plunger goes in and the ink goes into them. */
function pushPlunger(syringe: THREE.Group, progress: number) {
  const p = THREE.MathUtils.clamp(progress, 0, 1)
  ;(syringe.userData.ink as THREE.Group).scale.y = Math.max(0.02, 1 - p)
  ;(syringe.userData.rod as THREE.Group).position.y = SYRINGE_ROD + 0.045 * p
}

// ---------------------------------------------------------------- the poser

type Frames = Record<'down' | 'buckle' | 'hip' | 'side' | 'roll' | 'knee' | 'kneelUp' | 'push' | 'stand' | 'kneel' | 'dead', Frame>
type Limb = { upper: THREE.Bone; lower: THREE.Bone; end: THREE.Vector3; upperLength: number; endLength: number; mid: number; tip: number
  /** Last floor-clamp headings of the upper and lower segment. */
  upperHeading: THREE.Vector3; lowerHeading: THREE.Vector3 }

export class PartnerPoses {
  phase: PartnerPhase = 'up'
  /** Seconds since the phase began. */
  time = 0
  /** The body's facing while posed (the root's Y rotation). */
  heading = 0
  /** Crawl cycle (0-1 per stride). */
  crawlPhase = 0
  /** Made with the rig, in the left hand. */
  syringe: THREE.Group | null = null
  /**
   * Where the teammate they revive lies (their feet: PlayerState.p of player `rt`), when the game knows it:
   * the kneel then faces them and reaches to them. Without it, it faces along the reviver's look and judges
   * the reach from how far down they look.
   */
  reviveAt: THREE.Vector3 | null = null
  private rig: Rig | null = null
  private actor: EnemyActor | null = null
  private readonly from = newFrame()
  private readonly base = newFrame()
  private readonly layer = newFrame()
  private frames: Frames | null = null
  private crawlFrames: Frame[] = []
  private legs: Limb[] = []
  private keys: Key[] = []
  private easeIn = false
  private easeOut = false
  // Layer weights, eased every frame so no layer switches on or off in one step.
  private readonly aimWeight = new Weight()
  private readonly clutchWeight = new Weight()
  private readonly crawlWeight = new Weight()
  private readonly reachWeight = new Weight()
  private readonly breathWeight = new Weight()
  private readonly settleWeight = new Weight()
  /** Where each elbow was last frame (from the shoulder), for the arm floor clamp. */
  private readonly elbowSides = { L: new THREE.Vector3(), R: new THREE.Vector3() }
  private readonly floorWeight = new Weight()
  private readonly kneeWeight = new Weight()
  // One per IK layer, each remembering its own last blend.
  private readonly reaches = { pistol: new Reach('R'), belly: new Reach('L'), crawl: new Reach('L'), floor: new Reach('L'),
    knee: new Reach('L'), syringe: new Reach('L'), gunLow: new Reach('R'), gunFloor: new Reach('R') }
  private readonly lastFeet = new THREE.Vector3()
  private readonly velocity = new THREE.Vector3()
  private hasFeet = false
  private syringeTimer = 0
  private clock = 0
  /** The rise is only standing up out of the revive kneel. */
  private fromKneel = false
  /** How far ahead the syringe goes and how far the kneel leans in (eased toward the teammate's distance). */
  private handReach = REACH
  private lunge = 0
  private pitch = 0
  /** The look, eased: states come 15 times a second and a raw look would step the pistol arm. */
  private lookYaw = 0
  private lookPitch = 0

  /** How much of the crawl shows (0-1). */
  get crawl() { return this.crawlWeight.value }
  private get aim() { return this.aimWeight.value }
  private get clutch() { return this.clutchWeight.value }
  private get reach() { return this.reachWeight.value }
  private get breath() { return this.breathWeight.value }
  private get settle() { return this.settleWeight.value }

  /**
   * Pose the partner for this frame. Returns true while the poses own the rig: the caller must not run
   * the actor's own update then. `facing` is the avatar's eased facing (its root Y rotation when standing).
   */
  update(dt: number, actor: EnemyActor, state: PartnerPoseState, facing: number, gun: THREE.Object3D | null) {
    if (this.actor !== actor) this.bind(actor)
    this.pitch = state.pitch
    dt = Math.max(0, Math.min(dt, 0.1))
    this.clock += dt
    this.track(dt, actor.root.position)
    const want: PartnerPhase = state.dn === 1 ? 'down' : state.dn === 2 ? 'dead' : state.rv ? 'revive' : 'up'
    this.time += dt
    switch (this.phase) {
      case 'up':
        if (want === 'down' || want === 'dead') this.enter('fall')
        else if (want === 'revive') this.enter('revive')
        break
      case 'fall':
        if (want === 'up' || want === 'revive') this.enter('rise')
        else if (this.time >= this.keys[this.keys.length - 1].t) this.enter(want)
        break
      case 'down':
        if (want === 'up' || want === 'revive') this.enter('rise')
        else if (want === 'dead') this.enter('dead')
        break
      case 'dead':
        if (want === 'up' || want === 'revive') this.enter('rise')
        else if (want === 'down') this.enter('down')
        break
      case 'rise':
        if (want === 'down' || want === 'dead') this.enter('fall')
        else if (want === 'revive' && this.fromKneel) this.enter('revive')
        else if (this.time >= this.keys[this.keys.length - 1].t) this.handBack()
        break
      case 'revive':
        if (want === 'down' || want === 'dead') this.enter('fall')
        else if (want === 'up') this.enter('rise')
        break
    }
    // The syringe shows while kneeling and for a moment after, while the hand swings away.
    this.syringeTimer = this.phase === 'revive' ? 0.14 : Math.max(0, this.syringeTimer - dt)
    this.syringe!.visible = this.syringeTimer > 0 && (this.phase !== 'revive' || this.time > 0.06)
    if (this.phase === 'revive') pushPlunger(this.syringe!, state.rv ?? 0)
    // Bled out, the gun slips from the hand.
    if (gun) gun.visible = this.phase !== 'dead' || this.time < 0.35
    if (this.phase === 'up') return false
    this.pose(dt, this.rig!, actor, state, facing)
    return true
  }

  /** The syringe; the actor and its rig belong to the avatar. */
  dispose() {
    // Its geometry and materials are shared by every avatar's syringe and live as long as the page.
    this.syringe?.removeFromParent()
    this.syringe = null
    this.rig = null
    this.actor = null
  }

  private bind(actor: EnemyActor) {
    this.actor = actor
    const rig = this.rig = actor.rig
    const f = (key: Keyed, base?: Keyed) => frameOf(rig, key, base)
    const frames = this.frames = { down: f(DOWN), buckle: f(BUCKLE), hip: f(HIP), side: f(SIDE), roll: f(ROLL), knee: f(KNEE),
      kneelUp: f(KNEEL_UP), push: f(PUSH), stand: f(STAND), kneel: f(KNEEL), dead: f(DEAD) }
    this.crawlFrames = CRAWL.map(key => f(key, DOWN))
    // The keys' arms as their layers lay them: the pistol and the clutch lying down, the hands on the floor rolling up.
    const lying = [frames.down, frames.side, ...this.crawlFrames]
    this.bake(rig, lying, 'R', reach => this.aimPistol(rig, actor, ORIGIN, 0, 0, 1, reach))
    this.bake(rig, lying, 'L', reach => this.clutchBelly(rig, 1, reach))
    this.bake(rig, [frames.roll], 'R', reach => this.gunOnFloor(rig, actor, ORIGIN, 1, reach))
    this.bake(rig, [frames.roll, frames.knee], 'L', reach => this.handOnFloor(rig, ORIGIN, 1, reach))
    for (const side of ['L', 'R'] as const) this.bake(rig, [frames.dead], side, reach => {
      const out = side === 'L' ? 1 : -1
      reach.apply(rig, bodyPoint(v1, ORIGIN, 0, 0.24 * out, HAND_FLOOR, 0.6), 1, place(palmDown(FORWARD), bodyPoint(v2, ORIGIN, 0, out, -0.05, -0.2)))
    })
    // The get-up ends in the actor's own standing aim, so handing the rig back does not show.
    const aim = heldPose(HANG, AIM_HOLD), q = new THREE.Quaternion()
    BONE_NAMES.forEach((name, i) => { if (/^(upper_arm|forearm|hand)\./.test(name)) poseQuat(name, aim[name] ?? [0, 0, 0], q).toArray(frames.stand.q, i * 4) })
    const limb = (upper: THREE.Bone, lower: THREE.Bone, end: THREE.Vector3, mid: number, tip: number): Limb =>
      ({ upper, lower, end, upperLength: lower.position.length(), endLength: end.length(), mid, tip, upperHeading: new THREE.Vector3(), lowerHeading: new THREE.Vector3() })
    const b = rig.bones
    this.legs = [limb(b['thigh.L'], b['shin.L'], FOOT_END, KNEE_FLOOR, FOOT_FLOOR), limb(b['thigh.R'], b['shin.R'], FOOT_END, KNEE_FLOOR, FOOT_FLOOR)]
    this.phase = 'up'
    this.time = 0
    this.heading = actor.root.rotation.y
    this.syringe ??= createSyringe()
    b['hand.L'].add(this.syringe)
    this.syringe.position.copy(FIST)
  }

  /** Smoothed ground velocity of the avatar's feet. */
  private track(dt: number, feet: THREE.Vector3) {
    if (!this.hasFeet || dt <= 0 || this.lastFeet.distanceToSquared(feet) > 4) this.velocity.set(0, 0, 0)
    else this.velocity.lerp(v1.subVectors(feet, this.lastFeet).divideScalar(dt).setY(0), 1 - Math.exp(-dt * 6))
    this.lastFeet.copy(feet)
    this.hasFeet = true
  }

  private enter(phase: PartnerPhase) {
    const rig = this.rig!, frames = this.frames!
    this.fromKneel = this.phase === 'revive'
    if (this.phase === 'up') {
      this.lookYaw = this.actor!.root.rotation.y
      this.lookPitch = this.pitch
      // Take the rig from the actor as it is on screen, without any length change its clips made.
      for (const name of BONE_NAMES) if (name !== 'hips') rig.bones[name].position.copy(rig.rest[name].pos)
      capture(this.from, rig)
      this.heading = this.actor!.root.rotation.y
    } else copyFrame(this.from, this.base)  // before the layers, which keep easing on their own
    const low = this.from.hips.y < 0.5
    const from: Key = { t: 0, f: this.from }
    const key = (t: number, f: Frame): Key => ({ t, f })
    this.phase = phase
    this.time = 0
    this.easeIn = this.easeOut = true
    switch (phase) {
      case 'fall':
        this.easeIn = this.easeOut = false
        this.keys = low ? [from, key(0.25, frames.side), key(0.5, frames.down)]
          : [from, key(0.14, frames.buckle), key(0.3, frames.hip), key(0.45, frames.side), key(PARTNER_POSE_SECONDS.fall, frames.down)]
        break
      case 'rise':
        // Off the floor: roll to a knee, push up, stand. From reviving: just stand up out of the kneel.
        this.keys = this.fromKneel ? [from, key(PARTNER_POSE_SECONDS.kneel, frames.stand)]
          : [from, key(0.28, frames.roll), key(0.52, frames.knee), key(0.76, frames.kneelUp), key(0.98, frames.push), key(PARTNER_POSE_SECONDS.rise, frames.stand)]
        break
      case 'revive':
        this.handReach = this.reviveDistance()
        this.keys = [from, key(PARTNER_POSE_SECONDS.kneel, frames.kneel)]
        break
      case 'down':
        this.keys = [from, key(0.6, frames.down)]
        break
      case 'dead':
        this.keys = [from, key(PARTNER_POSE_SECONDS.slump, frames.dead)]
        break
    }
  }

  /** How far ahead of the kneel the teammate is: measured when the game says where, judged from the look if not. */
  private reviveDistance() {
    const at = this.reviveAt, feet = this.actor!.root.position
    const distance = at ? Math.sqrt((at.x - feet.x) ** 2 + (at.z - feet.z) ** 2) : this.pitch < -0.2 ? REVIVE_EYE / Math.tan(-this.pitch) : REACH
    return THREE.MathUtils.clamp(distance, REACH, REACH_MOST)
  }

  private handBack() {
    this.phase = 'up'
    this.time = 0
    for (const weight of [this.aimWeight, this.clutchWeight, this.crawlWeight, this.reachWeight, this.breathWeight, this.settleWeight,
      this.floorWeight, this.kneeWeight]) weight.reset()
    this.actor!.setPosture('stand')
  }

  private pose(dt: number, rig: Rig, actor: EnemyActor, state: PartnerPoseState, facing: number) {
    const phase = this.phase, t = this.time
    const feet = actor.root.position, ground = feet.y
    // ---- heading: a lying body turns slowly; the chest and arm cover the rest of the aim. Reviving faces the teammate.
    // (Standing up from a revive turns back quickly: the actor takes over along the look 0.25 s later.)
    const turn = phase === 'down' ? 2.2 : phase === 'rise' ? (this.fromKneel ? 20 : t > 0.45 ? 10 : 1.5) : phase === 'revive' ? 14 : 0
    const toward = phase === 'revive' && this.reviveAt ? Math.atan2(this.reviveAt.x - feet.x, this.reviveAt.z - feet.z) : facing
    if (turn) this.heading += THREE.MathUtils.clamp(wrap(toward - this.heading) * (1 - Math.exp(-dt * turn)), -TURN_SPEED * dt, TURN_SPEED * dt)
    if (phase === 'revive') {
      this.handReach += (this.reviveDistance() - this.handReach) * (1 - Math.exp(-dt / 0.15))
      this.lunge = THREE.MathUtils.clamp(this.handReach - LEAN_FROM, 0, LEAN)
    }
    actor.root.rotation.set(0, this.heading, 0, 'YXZ')
    FORWARD.set(Math.sin(this.heading), 0, Math.cos(this.heading))
    // ---- layer weights
    // The pistol stays up through the collapse: its elbow comes down with the shoulder until it plants.
    const lying = phase === 'down' || (phase === 'fall' && t > 0.1)
    this.aimWeight.to(lying ? 1 : 0, dt, 0.14)
    this.clutchWeight.to((phase === 'down' || phase === 'fall') && !state.mv ? 1 : 0, dt, 0.2)
    this.crawlWeight.to(phase === 'down' && state.mv ? 1 : 0, dt, 0.25)
    this.reachWeight.to(phase === 'revive' ? 1 : 0, dt, 0.1)
    this.breathWeight.to(phase === 'dead' ? 0 : 1, dt, 0.4)
    this.settleWeight.to(phase === 'down' || phase === 'dead' ? 1 : 0, dt, 0.14)
    // Getting up off the floor: both fists push off it, then the free hand pushes off the front knee.
    const pushing = phase === 'rise' && !this.fromKneel
    this.floorWeight.to(pushing ? smooth((t - 0.02) / 0.22) * (1 - smooth((t - 0.44) / 0.14)) : 0, dt, 0.06)
    this.kneeWeight.to(pushing ? smooth((t - 0.5) / 0.12) * (1 - smooth((t - 0.9) / 0.14)) : 0, dt, 0.05)
    if (phase === 'dead') {
      // Bled out: the arm drops, the hand slips off the belly, the breathing stops, all by the slump's end.
      const left = 1 - smooth(t / (PARTNER_POSE_SECONDS.slump * 0.6))
      this.aimWeight.cap(left)
      this.clutchWeight.cap(left)
      this.breathWeight.cap(1 - smooth(t / PARTNER_POSE_SECONDS.slump))
    }
    // ---- crawl cycle: one stride per CRAWL_STRIDE of ground, run backwards when they back away
    if (this.crawl > 0.001) {
      const forward = this.velocity.x * Math.sin(this.heading) + this.velocity.z * Math.cos(this.heading)
      this.crawlPhase += dt * THREE.MathUtils.clamp(this.velocity.length() / CRAWL_STRIDE, 0.45, 1.6) * (forward < -0.05 ? -1 : 1)
      this.crawlPhase -= Math.floor(this.crawlPhase)
    }
    // ---- base pose (kept before the layers: the next phase starts from it)
    sampleKeys(this.base, this.keys, t, this.easeIn, this.easeOut)
    if (this.crawl > 0.001) {
      sampleLoop(this.layer, this.crawlFrames, this.crawlPhase)
      mix(this.base, this.base, this.layer, this.crawl)
    }
    apply(rig, this.base)
    // Reviving further off, the kneel leans in and bends over its front knee; it eases back as they stand.
    if (this.reach > 0.001) {
      rig.bones.hips.position.z += this.lunge * this.reach
      const bend = (this.handReach - REACH) / (REACH_MOST - REACH) * REVIVE_BEND * this.reach
      addEuler(rig.bones.spine, bend * 0.6, 0, 0)
      addEuler(rig.bones.chest, bend * 0.4, 0, 0)
    }
    // ---- breathing, laboured while down
    if (this.breath > 0.001) {
      const hurt = phase === 'down' || phase === 'fall'
      const b = Math.sin(this.clock * (hurt ? 4.6 : 3.0)) * this.breath * (hurt ? 1 : 0.5)
      addEuler(rig.bones.chest, -0.035 * b, 0, 0)
      addEuler(rig.bones.spine, -0.015 * b, 0, 0)
      addEuler(rig.bones.head, 0.03 * b, 0, 0)
      rig.bones.hips.position.y += 0.004 * b
    }
    // ---- aim: the chest turns toward the look, the arm does the rest
    const follow = 1 - Math.exp(-dt / 0.07)
    this.lookYaw += wrap(state.yaw + Math.PI - this.lookYaw) * follow
    this.lookPitch += (state.pitch - this.lookPitch) * follow
    const yaw = this.heading + THREE.MathUtils.clamp(wrap(this.lookYaw - this.heading), -PARTNER_AIM_LIMITS.right, PARTNER_AIM_LIMITS.left)
    const pitch = THREE.MathUtils.clamp(this.lookPitch, PARTNER_AIM_LIMITS.down, PARTNER_AIM_LIMITS.up)
    if (this.aim > 0.001) {
      addEuler(rig.bones.spine, 0, wrap(yaw - this.heading) * 0.14 * this.aim, 0)
      addEuler(rig.bones.chest, 0, wrap(yaw - this.heading) * 0.2 * this.aim, 0)
    }
    rig.root.updateMatrixWorld(true)
    // ---- floor: nothing sinks into it mid-blend; lying legs rest on it
    this.lift(rig, ground)
    for (let i = 0; i < this.legs.length; i++) this.restLimb(this.legs[i], ground, this.settle, dt)
    // ---- hands and head
    const r = this.reaches
    if (this.aim > 0.001) this.aimPistol(rig, actor, feet, yaw, pitch); else r.pistol.idle()
    if (this.clutch * (1 - this.crawl) > 0.001) this.clutchBelly(rig); else r.belly.idle()
    if (this.crawl > 0.001) this.crawlReach(rig, feet); else r.crawl.idle()
    if (this.reach > 0.001) this.reviveHands(rig, actor, feet); else { r.syringe.idle(); r.gunLow.idle() }
    if (this.floorWeight.value + this.kneeWeight.value > 0) this.pushUp(rig, actor, feet); else { r.floor.idle(); r.knee.idle(); r.gunFloor.idle() }
    this.look(rig, yaw, pitch)
    armOffFloor(rig, 'L', ground, this.heading, this.elbowSides.L)
    armOffFloor(rig, 'R', ground, this.heading, this.elbowSides.R)
  }

  /** Getting up: both fists push off the floor (the gun lying flat in one), then the free hand off the front knee. */
  private pushUp(rig: Rig, actor: EnemyActor, feet: THREE.Vector3) {
    const floor = this.floorWeight.value, knee = this.kneeWeight.value
    this.gunOnFloor(rig, actor, feet, floor, this.reaches.gunFloor)
    this.handOnFloor(rig, feet, floor, this.reaches.floor)
    rig.bones['shin.L'].getWorldPosition(v1)
    this.reaches.knee.apply(rig, bodyPoint(v1, v1, this.heading, 0.02, 0.07, 0.02), knee, place(undefined, bodyPoint(v2, ORIGIN, this.heading, 0.8, 0.2, -0.6)))
  }

  /** Getting up: the gun fist flat on the floor beside the chest, barrel forward. */
  private gunOnFloor(rig: Rig, actor: EnemyActor, feet: THREE.Vector3, weight: number, reach: Reach) {
    lookRotation(q2, FORWARD, UP)
    q2.multiply(q3.copy(actor.gun.quaternion).invert())
    reach.apply(rig, bodyPoint(v1, feet, this.heading, -0.2, HAND_FLOOR + 0.02, 0.26), weight, place(q2, bodyPoint(v2, ORIGIN, this.heading, -0.7, 0.6, -0.4)))
  }

  /** Getting up: the free hand flat on the floor, pushing. */
  private handOnFloor(rig: Rig, feet: THREE.Vector3, weight: number, reach: Reach) {
    reach.apply(rig, bodyPoint(v1, feet, this.heading, 0.16, HAND_FLOOR, 0.3), weight, place(palmDown(FORWARD), bodyPoint(v2, ORIGIN, this.heading, 0.7, 0.6, -0.4)))
  }

  private restLimb(limb: Limb, ground: number, settle: number, dt: number) {
    restOnFloor(limb.upper, limb.lower.position, limb.upperLength, ground + limb.mid, settle, limb.upperHeading, dt)
    restOnFloor(limb.lower, limb.end, limb.endLength, ground + limb.tip, settle, limb.lowerHeading, dt)
  }

  /** Lift the whole body when the pelvis, chest or head would sink into the floor mid-blend. */
  private lift(rig: Rig, ground: number) {
    const b = rig.bones
    let need = Math.max(under(b.hips, null, ground + 0.1), under(b.spine, null, ground + 0.1), under(b.chest, null, ground + 0.11),
      under(b.neck, null, ground + 0.12), under(b.head, HEAD_CENTRE, ground + 0.12))
    // A knee or foot under a steep thigh or shin is stood or knelt on: raise the body. (Tilting a vertical
    // segment to lift its end even a millimetre swings it degrees at once; lying legs are laid on the floor
    // by their clamp instead.)
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i]
      need = Math.max(need, standOn(leg.upper, leg.lower.position, leg.upperLength, ground + KNEE_FLOOR), standOn(leg.lower, FOOT_END, SHIN_LENGTH, ground + FOOT_FLOOR))
    }
    if (need <= 0) return
    // The root only turns about Y, so world up is the hips' parent's up.
    b.hips.position.y += need / rig.root.scale.y
    rig.root.updateMatrixWorld(true)
  }

  /**
   * The pistol hand: elbow planted on the floor under the shoulder, forearm raised toward the aim, the wrist
   * levelling the gun onto it. The hidden guard gun (actor.gun) carries the grip's mount in the hand.
   */
  private aimPistol(rig: Rig, actor: EnemyActor, feet: THREE.Vector3, yaw: number, pitch: number, weight = this.aim, reach = this.reaches.pistol) {
    const fore = rig.bones['forearm.R'], hand = rig.bones['hand.R']
    const upperLength = fore.position.length(), foreLength = hand.position.length()
    const shoulder = rig.bones['upper_arm.R'].getWorldPosition(v1)
    const drop = THREE.MathUtils.clamp(shoulder.y - feet.y - ELBOW_FLOOR, upperLength * 0.25, upperLength * 0.97)
    const out = Math.sqrt(upperLength * upperLength - drop * drop)
    // Under and a little in front of the shoulder, following the aim a little and dragging in the crawl.
    const elbowYaw = this.heading - 0.3 + wrap(yaw - this.heading) * 0.35 + Math.sin(this.crawlPhase * Math.PI * 2 + Math.PI) * 0.12 * this.crawl
    const elbow = v5.set(shoulder.x + Math.sin(elbowYaw) * out, shoulder.y - drop, shoulder.z + Math.cos(elbowYaw) * out)
    // Forearm raised toward the aim; the wrist takes the last 25 degrees so the gun sits level.
    const lift = THREE.MathUtils.clamp(pitch + 25 * DEG, 8 * DEG, 80 * DEG)
    const wrist = v2.set(Math.sin(yaw) * Math.cos(lift), Math.sin(lift), Math.cos(yaw) * Math.cos(lift)).multiplyScalar(foreLength).add(elbow)
    lookRotation(q2, v3.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)), UP)
    q2.multiply(q3.copy(actor.gun.quaternion).invert())
    const fist = v4.copy(FIST).applyQuaternion(q2).add(wrist)
    const pole = v6.addVectors(shoulder, wrist).multiplyScalar(-0.5).add(elbow)
    reach.apply(rig, fist, weight, place(q2, pole))
  }

  /**
   * Lay the arms of keyed poses the way their live layers will (the pistol, the clutch, hands pushing off
   * the floor), at the origin facing +Z. The layers then only ever correct a key a little, and blends
   * between keys never swing an authored arm through the floor or the body.
   */
  private bake(rig: Rig, frames: Frame[], side: 'L' | 'R', solve: (reach: Reach) => void) {
    const saved = newFrame(), positions = BONE_NAMES.map(name => rig.bones[name].position.clone())
    capture(saved, rig)
    const at = rig.root.position.clone(), turn = rig.root.quaternion.clone(), heading = this.heading, forward = FORWARD.clone()
    rig.root.position.set(0, 0, 0)
    rig.root.quaternion.identity()
    this.heading = 0
    FORWARD.set(0, 0, 1)
    const reach = new Reach(side), arm = ARM[side].map(name => BONE_NAMES.indexOf(name))
    for (const frame of frames) {
      for (const name of BONE_NAMES) if (name !== 'hips') rig.bones[name].position.copy(rig.rest[name].pos)
      apply(rig, frame)
      rig.root.updateMatrixWorld(true)
      reach.idle()
      solve(reach)
      for (const i of arm) rig.bones[BONE_NAMES[i]].quaternion.toArray(frame.q, i * 4)
    }
    apply(rig, saved)
    BONE_NAMES.forEach((name, i) => rig.bones[name].position.copy(positions[i]))
    rig.root.position.copy(at)
    rig.root.quaternion.copy(turn)
    this.heading = heading
    FORWARD.copy(forward)
    rig.root.updateMatrixWorld(true)
  }

  /** The free hand pressed to the belly. */
  private clutchBelly(rig: Rig, weight = this.clutch * (1 - this.crawl), reach = this.reaches.belly) {
    const target = rig.bones.spine.localToWorld(v1.set(0.075, 0.09, 0.115))
    const pole = v2.set(0.7, -0.4, -0.6).transformDirection(rig.bones.chest.matrixWorld)
    reach.apply(rig, target, weight, place(undefined, pole))
  }

  /** The free hand in the crawl: reach out, plant, drag the body up to it, lift, reach again. */
  private crawlReach(rig: Rig, feet: THREE.Vector3) {
    const p = this.crawlPhase, stance = p < 0.5, u = stance ? p / 0.5 : (p - 0.5) / 0.5
    const forward = stance ? THREE.MathUtils.lerp(0.78, 0.48, u) : THREE.MathUtils.lerp(0.48, 0.78, smooth(u))
    const up = HAND_FLOOR + (stance ? 0 : Math.sin(u * Math.PI) * 0.11)
    const target = bodyPoint(v1, feet, this.heading, 0.16, up, forward)
    this.reaches.crawl.apply(rig, target, this.crawl, place(palmDown(FORWARD), bodyPoint(v2, ORIGIN, this.heading, 0.8, 0.9, -0.2)))
  }

  /** Reviving: the syringe hand down on their chest, pressing; the gun low in the right hand. */
  private reviveHands(rig: Rig, actor: EnemyActor, feet: THREE.Vector3) {
    const press = Math.max(0, Math.sin(this.clock * 7)) * 0.025
    const target = bodyPoint(v1, feet, this.heading, 0.06, 0.22 - press, REACH + (this.handReach - REACH) * this.reach)
    // The hand's +Y (the syringe, needle first) points down into them.
    lookRotation(q1, bodyPoint(v4, ORIGIN, this.heading, 0, -1, 0.35).normalize(), bodyPoint(v5, ORIGIN, this.heading, 0, 0, 1))
    q1.multiply(HAND_ALONG_Z)
    this.reaches.syringe.apply(rig, target, this.reach, place(q1, bodyPoint(v2, ORIGIN, this.heading, 0.9, 0.2, -0.3)))
    // Gun lowered at the right side, muzzle to the floor ahead.
    const gunAt = bodyPoint(v1, feet, this.heading, -0.27, 0.36, 0.1 + this.lunge * this.reach)
    lookRotation(q2, bodyPoint(v4, ORIGIN, this.heading, -0.15, -0.75, 0.64).normalize(), UP)
    q2.multiply(q3.copy(actor.gun.quaternion).invert())
    this.reaches.gunLow.apply(rig, gunAt, this.reach, place(q2, bodyPoint(v2, ORIGIN, this.heading, -1, -0.2, -0.3)))
  }

  /** The head looks along the aim while down, and at the patient while reviving. */
  private look(rig: Rig, yaw: number, pitch: number) {
    const weight = Math.max(this.aim * 0.85, this.reach * 0.6)
    if (weight < 0.001) return
    const head = rig.bones.head
    const forward = this.reach > this.aim ? bodyPoint(v1, ORIGIN, this.heading, 0, -0.75, 0.66).normalize()
      : v1.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    lookRotation(q1, forward, UP).premultiply(head.parent!.getWorldQuaternion(q2).invert())
    head.quaternion.slerp(q1, weight)
    head.updateWorldMatrix(false, true)
  }
}
