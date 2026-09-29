import * as THREE from 'three'
import { FINGERS, InkHand, aimThumb, handClips, PALM, SKIN, THUMB, fingerJoints, gunCloud, palmPoints, radiusAt, solveGrip, thumbJoints, type GripCloud, type HandPose, type Surface } from './hands'
import type { WeaponItem } from './types'
import { BAKED_GRIPS, type BakedGrip } from './grip-plans'

/**
 * How each gun is held (hands.ts draws the hands): where the firing hand sits on the grip and how it wraps,
 * where the index finger rests and how it pulls the trigger, and what the other hand does: cups the firing
 * hand under a pistol, holds the magazine of the PDW, cradles a rifle's handguard or pump, holds a front grip,
 * cradles the Ink Cannon's tank.
 *
 * Every hold works the same way. The hand is turned to face what it holds, set with its knuckles where the
 * fingers start to wrap, and slid in until its palm meets the gun; then each finger closes one joint at a
 * time until it touches (solveGrip). Everything is measured from each gun's own model; only the trigger's
 * place and the guard the fingers pass under are listed per gun. A left hand is solved as a right hand on the
 * gun seen in a mirror. Plans are cached per drawing.
 */
export type SupportStyle = 'cup' | 'handguard' | 'vertical' | 'tank'
export type GripPlan = {
  /** The firing hand's frame in the gun's frame (a right hand), and its wrist, where the arm meets it. */
  firing: THREE.Matrix4
  wrist: THREE.Vector3
  /** The firing hand at rest (the index on the trigger) and pulling it. */
  idle: HandPose
  pull: HandPose
  /** The other hand: its frame in the gun's frame (for the mirrored left hand), its wrist, and its grip. */
  support: THREE.Matrix4
  supportWrist: THREE.Vector3
  supportPose: HandPose
  style: SupportStyle
}

/** Tunables for placement, kept together so the look can be adjusted in one place. */
export const GRIP_TUNING = {
  /** The hands' size against the guns (the stickman's hands are drawn a little large). */
  scale: 1.1,
  /**
   * How far the firing hand is turned round the grip (radians): its heel round the back strap, its knuckles out
   * at the front corner on its own side, the palm facing forward and in.
   */
  wrap: 0.5,
  /** The same for the cupping hand under a pistol, on the other side. */
  cupWrap: 0.5,
  /** How far ahead of the grip's front the knuckles are set before the hand slides onto the grip (m). */
  reach: 0.016,
}

/**
 * Per gun, in its model's frame: where the index finger meets the trigger [y, z], and the lowest edge of the
 * trigger guard (or trigger housing) that the other fingers wrap below. Read off each model.
 */
const TRIGGERS: Record<string, { trigger: [number, number]; under: number; wrap?: number; fist?: number[]; reach?: number }> = {
  pistol: { trigger: [0.012, 0.052], under: -0.018 },
  burst: { trigger: [0.012, 0.054], under: -0.018 },
  magnum: { trigger: [0.012, 0.045], under: -0.011 },
  smg: { trigger: [0.016, 0.046], under: -0.023 },
  pdw: { trigger: [0.016, 0.047], under: -0.024 },
  ak: { trigger: [0.02, 0.05], under: -0.005 },
  // Its ammunition box rides low on the right, beside the trigger: the hand turns round the grip less, and
  // the index comes to the trigger already bent.
  deathMachine: { trigger: [0.0, 0.045], under: -0.024, wrap: 0.2, fist: [0.7, 0, 0, 0] },
  // The ammunition box sits close ahead of the grip: the hand comes square onto it, lower than the trigger
  // housing, its fingers already bent straight across the front (not reaching out into the box).
  lmg: { trigger: [0.0, 0.05], under: -0.009, wrap: 0.1, fist: [1.45, 1.55, 1.55, 1.55], reach: 0.016 },
  shotgun: { trigger: [0.02, 0.037], under: -0.002 },
  sniper: { trigger: [0.013, 0.04], under: -0.009 },
  lever: { trigger: [0.03, 0.05], under: 0.014 },
  rocket: { trigger: [0.012, 0.045], under: -0.008 },
  inkCannon: { trigger: [0.02, 0.03], under: 0.003 },
  rayGun: { trigger: [0.02, 0.04], under: 0.006 },
}
const DEFAULT_TRIGGER = { trigger: [0.015, 0.05] as [number, number], under: -0.015 }

const plans = new Map<string, GripPlan>()

/** What the gun's model says about itself, in its own frame. */
type ModelInfo = THREE.Object3D & { userData: { name: string; cls: string; support?: THREE.Vector3; parts: Record<string, THREE.Object3D> } }

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1)
const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1)
const flip = (v: THREE.Vector3) => v.clone().setX(-v.x)

/** The same surface seen in a mirror across the gun's middle (x to -x): a left hand is solved there as a right one. */
function mirrored(surface: Surface): Surface {
  const q = new THREE.Vector3()
  return { near: (p, r) => surface.near(q.set(-p.x, p.y, p.z), r) }
}

/** A posed hand as a surface (fingers and thumb as tapered capsules, the palm as its ellipsoid), for the other hand to hold over. */
function handSurface(pose: HandPose, matrix: THREE.Matrix4): Surface {
  const scale = matrix.getMaxScaleOnAxis(), inverse = matrix.clone().invert()
  const segments: { a: THREE.Vector3; b: THREE.Vector3; ra: number; rb: number }[] = []
  for (let f = 0; f < 5; f++) {
    const joints = f < 4 ? fingerJoints(f, pose.fingers[f]) : thumbJoints(pose.thumb), spec = f < 4 ? FINGERS[f] : THUMB
    for (let s = 0; s < 3; s++) segments.push({ a: joints[s].clone().applyMatrix4(matrix), b: joints[s + 1].clone().applyMatrix4(matrix), ra: radiusAt(spec, s / 3) * scale, rb: radiusAt(spec, (s + 1) / 3) * scale })
  }
  const ab = new THREE.Vector3(), ap = new THREE.Vector3(), q = new THREE.Vector3()
  return {
    near(p, r) {
      for (const { a, b, ra, rb } of segments) {
        ab.subVectors(b, a); ap.subVectors(p, a)
        const t = THREE.MathUtils.clamp(ap.dot(ab) / ab.lengthSq(), 0, 1)
        if (ap.addScaledVector(ab, -t).length() <= r + ra + (rb - ra) * t) return true
      }
      q.copy(p).applyMatrix4(inverse).sub(PALM.centre)
      const grow = r / scale
      return (q.x / (PALM.radii.x + grow)) ** 2 + (q.y / (PALM.radii.y + grow)) ** 2 + (q.z / (PALM.radii.z + grow)) ** 2 <= 1
    },
  }
}

const union = (...surfaces: Surface[]): Surface => ({ near: (p, r) => surfaces.some(s => s.near(p, r)) })

/** The grip's front and back at a height (from the cloud's points near it, within a band of z and of x). */
function strap(cloud: GripCloud, y: number, zMin: number, zMax: number, xMax = 0.03) {
  const points = cloud.points
  let front = -Infinity, back = Infinity, width = 0
  for (let i = 0; i < points.length; i += 3) {
    const px = points[i], py = points[i + 1], pz = points[i + 2]
    if (Math.abs(py - y) > 0.003 || pz < zMin || pz > zMax || Math.abs(px) > xMax) continue
    front = Math.max(front, pz); back = Math.min(back, pz); width = Math.max(width, Math.abs(px))
  }
  return front > -Infinity ? { front, back, width } : null
}

/** A hand's start: fingers nearly straight, the thumb raised off the palm toward what it holds. */
function startPose(indexSpread = 0.06): HandPose {
  return {
    fingers: [
      { curl: [0.05, 0.08, 0.04], spread: indexSpread }, { curl: [0.06, 0.08, 0.04], spread: 0.02 },
      { curl: [0.06, 0.08, 0.04], spread: -0.03 }, { curl: [0.08, 0.1, 0.05], spread: -0.09 },
    ],
    thumb: { yaw: 0.15, lift: 0.85, curl: [0.08, 0.1, 0.05] },
  }
}

/**
 * Hold something with a right hand: its thumb along `thumb`, its straight fingers along `fingers`, its palm
 * facing `palm` (a right-handed set). The middle finger's knuckle goes to `knuckle`, then the hand slides in
 * along `palm` until the palm meets the surface, and the fingers close round it.
 */
function hold(surface: Surface, thumb: THREE.Vector3, fingers: THREE.Vector3, palm: THREE.Vector3, knuckle: THREE.Vector3, start: HandPose, thumbAt: THREE.Vector3, which: number[] = [0, 1, 2, 3, 4]) {
  const scale = GRIP_TUNING.scale
  const basis = new THREE.Matrix4().makeBasis(thumb, fingers, palm)
  const origin = knuckle.clone().sub(new THREE.Vector3(0.008, 0.074, 0).multiplyScalar(scale).applyMatrix4(basis))
  const sized = new THREE.Matrix4().makeScale(scale, scale, scale)
  const frameAt = (d: number) => basis.clone().setPosition(origin.clone().addScaledVector(palm, d)).multiply(sized)
  const face = palmPoints(), p = new THREE.Vector3()
  const touching = (d: number) => {
    const frame = frameAt(d)
    return face.some(point => surface.near(p.copy(point).applyMatrix4(frame), SKIN))
  }
  // From well off (further out if something is already there), in a millimetre at a time until the palm would
  // meet the surface.
  let d = -0.09
  while (d > -0.2 && touching(d)) d -= 0.01
  while (d < 0.08 && !touching(d + 0.001)) d += 0.001
  const frame = frameAt(d)
  // The thumb aimed where it lies, then every finger and the thumb closed onto the surface.
  return { frame, pose: solveGrip(aimThumb(start, frame, surface, thumbAt), frame, surface, which) }
}

/** The name a gun's grip is kept under: the weapon and its drawing. */
export function gripKey(item: Pick<WeaponItem, 'name' | 'special'>, model: { userData: { name: string } }) {
  return `${item.special ?? item.name}:${model.userData.name}`
}

/**
 * The grip for a gun in hand. Every gun's grip is solved ahead of time (scripts/bake-grips.ts writes them to
 * grip-plans.ts), so taking a gun up costs nothing on a phone; a gun without one is solved here, once.
 */
export function gripPlan(model: ModelInfo, item: Pick<WeaponItem, 'name' | 'special'>, key = gripKey(item, model)): GripPlan {
  const cached = plans.get(key)
  if (cached) return cached
  const baked = BAKED_GRIPS[key]
  const plan = baked ? unbake(baked) : solveGripPlan(model, item, key)
  plans.set(key, plan)
  return plan
}

/**
 * Solve the grip for a gun. `model` is its first-person model (at rest, in its own frame), `item` the weapon,
 * `key` its name for the surface cache.
 */
export function solveGripPlan(model: ModelInfo, item: Pick<WeaponItem, 'name' | 'special'>, key = gripKey(item, model)): GripPlan {
  model.updateWorldMatrix(true, true)
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert()
  const inModel = (object: THREE.Object3D | undefined) => object ? object.getWorldPosition(new THREE.Vector3()).applyMatrix4(toModel) : null
  const kind = item.special ?? (item.name === 'cannon' ? 'inkCannon' : item.name)
  const scale = GRIP_TUNING.scale
  // Only where hands go is sampled: round the firing grip, and round the support point, the magazine, the tank.
  const around = (p: THREE.Vector3, r: number) => new THREE.Box3(p.clone().subScalar(r), p.clone().addScalar(r))
  const regions = [new THREE.Box3(new THREE.Vector3(-0.06, -0.12, -0.12), new THREE.Vector3(0.06, 0.07, 0.12))]
  const supportPoint = model.userData.support?.clone() ?? new THREE.Vector3(0, -0.005, 0.26)
  if (model.userData.support) regions.push(around(supportPoint, 0.1))
  const tankAt = inModel(model.userData.parts.tank), magazineAt = inModel(model.userData.parts.magazine)
  if (tankAt) regions.push(around(tankAt, 0.09))
  if (kind === 'pdw' && magazineAt) regions.push(around(magazineAt, 0.1))
  const cloud = gunCloud(model, key, regions)

  // ---- The firing hand: the fingers under the guard round the grip, the index on the trigger.
  const { trigger, under, wrap = GRIP_TUNING.wrap, fist = [0, 0, 0, 0], reach = GRIP_TUNING.reach } = TRIGGERS[kind] ?? DEFAULT_TRIGGER
  const rMiddle = FINGERS[1].radius[0] * scale
  const yMiddle = under - rMiddle - 0.002
  const zLimit = trigger[1] - 0.008
  const high = strap(cloud, yMiddle, trigger[1] - 0.14, zLimit), low = strap(cloud, yMiddle - 0.03, trigger[1] - 0.14, zLimit + 0.03)
  // The grip's rake, from its front edge; its forward, square to that.
  const up = high && low ? new THREE.Vector3(0, 0.03, high.front - low.front).normalize() : Y.clone()
  if (up.y < 0.8) up.copy(Y)
  const forward = Z.clone().addScaledVector(up, -up.z).normalize()
  const fingers = forward.clone().multiplyScalar(Math.cos(wrap)).addScaledVector(X, -Math.sin(wrap)).normalize()
  const palm = new THREE.Vector3().crossVectors(up, fingers).normalize()
  // The knuckles at the grip's front corner (the slide in, along the palm, takes them back onto it).
  const front = high?.front ?? 0.02
  const zKnuckle = front + reach
  // The index lifted along the frame to the trigger's height.
  const indexBase = yMiddle + (FINGERS[0].base.x - FINGERS[1].base.x) * scale
  const indexSpread = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp((trigger[0] - indexBase) / (FINGERS[0].lengths[0] * scale + 0.012), -1, 1)), -0.1, 0.8)
  // The thumb over the back of the grip, its tip up on the far side under the frame.
  const top = strap(cloud, trigger[0], trigger[1] - 0.14, zLimit)
  const thumbAt = new THREE.Vector3((top?.width ?? 0.018) * 0.8, trigger[0] + 0.004, (top?.back ?? -0.02) - 0.01)
  const start = startPose(indexSpread)
  start.fingers.forEach((f, i) => { f.curl[0] = Math.max(f.curl[0], fist[i]) })
  const firingHold = hold(cloud, up, fingers, palm, new THREE.Vector3(0, yMiddle, zKnuckle), start, thumbAt, [1, 2, 3, 4])
  const firing = firingHold.frame
  const idle = solveGrip(firingHold.pose, firing, cloud, [0, 4])
  // Pulling: the index's middle and end joints close on the trigger, which gives under it, as far as they can
  // without sinking into the frame or the guard.
  const pullBy = (t: number): HandPose => ({ fingers: idle.fingers.map((f, i) => ({ spread: f.spread, curl: i ? [...f.curl] : [f.curl[0] + 0.03 * t, f.curl[1] + 0.2 * t, f.curl[2] + 0.16 * t] })) as HandPose['fingers'], thumb: { ...idle.thumb, curl: [...idle.thumb.curl] as [number, number, number] } })
  let give = 1
  while (give > 0 && handClips(pullBy(give), firing, cloud, [0], false)) give -= 0.1
  const pull = pullBy(Math.max(0, give))

  // ---- The other hand, solved in the mirror as a right hand.
  const style: SupportStyle = kind === 'inkCannon' ? 'tank'
    : kind === 'rocket' || kind === 'deathMachine' || kind === 'pdw' ? 'vertical'
    : model.userData.cls === 'pistol' ? 'cup' : 'handguard'
  let mirrorHold: { frame: THREE.Matrix4; pose: HandPose }
  if (style === 'handguard') {
    // Palm up under the handguard, its fingers round the right side, the thumb along the left.
    // Its underside and its width there, from a slice of the gun at the support point.
    let bottom = Infinity, width = 0.012
    const points = cloud.points
    for (let i = 0; i < points.length; i += 3) if (Math.abs(points[i + 2] - supportPoint.z) < 0.004 && Math.abs(points[i]) < 0.06 && points[i + 1] < supportPoint.y + 0.1) bottom = Math.min(bottom, points[i + 1])
    if (bottom === Infinity) bottom = supportPoint.y
    for (let i = 0; i < points.length; i += 3) if (Math.abs(points[i + 2] - supportPoint.z) < 0.004 && points[i + 1] < bottom + 0.02) width = Math.max(width, Math.abs(points[i]))
    const knuckle = new THREE.Vector3(width - 0.004, bottom - 0.02, supportPoint.z)
    // The thumb forward along the handguard's left side (the mirror's right).
    mirrorHold = hold(mirrored(cloud), Z.clone(), X.clone(), Y.clone(), knuckle, startPose(0.04), new THREE.Vector3(-width - 0.006, bottom + 0.018, supportPoint.z + 0.06))
  } else if (style === 'vertical') {
    // A vertical grip (a front grip, the PDW's magazine) held as the firing grip is, in the left hand.
    const centre = kind === 'pdw' && magazineAt ? magazineAt : supportPoint
    const top = kind === 'pdw' ? -0.006 : kind === 'rocket' ? 0.035 : 0.012
    const yM = top - FINGERS[0].radius[0] * scale - 0.002 - (FINGERS[0].base.x - FINGERS[1].base.x) * scale
    const post = strap(cloud, yM, centre.z - 0.06, centre.z + 0.06, 0.04)
    const knuckle = new THREE.Vector3(0, yM, (post?.front ?? centre.z + 0.017) + GRIP_TUNING.reach)
    const f = Z.clone().multiplyScalar(Math.cos(wrap)).addScaledVector(X, -Math.sin(wrap)).normalize()
    const thumbTip = new THREE.Vector3(-0.022, top - 0.004, (post?.front ?? centre.z) - 0.01)
    mirrorHold = hold(mirrored(cloud), Y.clone(), f, new THREE.Vector3().crossVectors(Y, f).normalize(), knuckle, startPose(0.06), thumbTip)
  } else if (style === 'cup') {
    // Round the pistol's grip from the left, over the firing hand's fingers, a little lower.
    const cupWrap = GRIP_TUNING.cupWrap
    const f = forward.clone().multiplyScalar(Math.cos(cupWrap)).addScaledVector(X, -Math.sin(cupWrap)).normalize()
    const knuckle = new THREE.Vector3(0, yMiddle - 0.012, front + GRIP_TUNING.reach + 0.01)
    const both = mirrored(union(cloud, handSurface(idle, firing)))
    // Thumbs forward: the left thumb along the frame under the right one.
    const thumbTip = new THREE.Vector3(-(top?.width ?? 0.018) - 0.012, trigger[0] - 0.006, trigger[1] - 0.012)
    mirrorHold = hold(both, up.clone(), f, new THREE.Vector3().crossVectors(up, f).normalize(), knuckle, startPose(0.1), thumbTip)
  } else {
    // The Ink Cannon: the left hand on the tank's left side, its fingers over the top.
    const centre = tankAt ?? supportPoint
    let top = centre.y + 0.03
    const points = cloud.points
    for (let i = 0; i < points.length; i += 3) if (Math.abs(points[i + 2] - centre.z) < 0.004 && Math.abs(points[i] - centre.x) < 0.01) top = Math.max(top, points[i + 1])
    const knuckle = new THREE.Vector3(-centre.x, top - 0.004, centre.z + 0.004)
    const thumbTip = new THREE.Vector3(centre.x - 0.05, centre.y, centre.z - 0.06)
    mirrorHold = hold(mirrored(cloud), Z.clone().negate(), Y.clone(), X.clone(), knuckle, startPose(0.04), thumbTip)
  }
  // Back out of the mirror: the right hand's frame reflected is the left hand's (its scale carries the reflection).
  const support = MIRROR.clone().multiply(mirrorHold.frame)
  const supportWrist = flip(new THREE.Vector3().setFromMatrixPosition(mirrorHold.frame))
  return { firing, wrist: new THREE.Vector3().setFromMatrixPosition(firing), idle, pull, support, supportWrist, supportPose: mirrorHold.pose, style }
}

/** A plan as plain numbers, to be written into grip-plans.ts (matrices to 0.01 mm, joint angles to 0.0001 rad). */
export function bakeGrip(plan: GripPlan): BakedGrip {
  const round = (v: number, places: number) => Number(v.toFixed(places))
  const pose = (p: HandPose): BakedGrip['idle'] => ({
    fingers: p.fingers.map(f => ({ curl: f.curl.map(c => round(c, 4)), spread: round(f.spread, 4) })),
    thumb: { yaw: round(p.thumb.yaw, 4), lift: round(p.thumb.lift, 4), curl: p.thumb.curl.map(c => round(c, 4)), twist: round(p.thumb.twist ?? 0, 4) },
  })
  return { firing: plan.firing.elements.map(v => round(v, 5)), support: plan.support.elements.map(v => round(v, 5)), idle: pose(plan.idle), pull: pose(plan.pull), supportPose: pose(plan.supportPose), style: plan.style }
}

function unbake(baked: BakedGrip): GripPlan {
  const firing = new THREE.Matrix4().fromArray(baked.firing), support = new THREE.Matrix4().fromArray(baked.support)
  return {
    firing, wrist: new THREE.Vector3().setFromMatrixPosition(firing), idle: baked.idle as HandPose, pull: baked.pull as HandPose,
    support, supportWrist: new THREE.Vector3().setFromMatrixPosition(support), supportPose: baked.supportPose as HandPose, style: baked.style,
  }
}

/** Put a hand where a plan says, in the gun's frame (its root must be a child of the gun's mount). */
export function placeHand(hand: InkHand, matrix: THREE.Matrix4) {
  matrix.decompose(hand.root.position, hand.root.quaternion, hand.root.scale)
}

/** Checks only: forget the cached plans (after a tuning change). */
export function clearGripPlans() { plans.clear() }

/** Checks only: the grip as seen by the left hand (the gun in the mirror, with the firing hand for a cup grip). */
export function supportSurface(plan: GripPlan, cloud: GripCloud): Surface {
  return plan.style === 'cup' ? union(cloud, handSurface(plan.idle, plan.firing)) : cloud
}

