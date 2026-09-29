import * as THREE from 'three'
import { createPenSilhouette, penPalette } from '../render/ballpoint'

/**
 * First-person hands that really hold the guns: a palm, four fingers of three segments each and a thumb of
 * three, bent at every joint, drawn in the arms' paper and ink with knuckle creases and nails.
 *
 * A hand is built once with a fixed topology and re-posed by moving its vertices, so it stays three draw
 * calls whatever it does (the fill, its silhouette, and one set of fine ink lines for creases and nails), and
 * gloves recolour its fill. Every hand is modelled as a right hand; a left hand is the same mirrored.
 *
 * Hand frame (metres): the wrist at the origin, +Y along the hand toward the fingers, +X toward the thumb, +Z
 * out of the palm. A finger curls about its own side axis toward +Z.
 *
 * Grips are solved, not hand-placed: `solveGrip` curls each finger until it touches the gun's own geometry
 * (sampled from its model: gunCloud), so fingers wrap round whatever grip, pump or handguard a gun has
 * without floating off it or sinking in.
 */

export type FingerPose = { curl: [number, number, number]; spread: number }
export type HandPose = {
  /** Index, middle, ring, little. */
  fingers: [FingerPose, FingerPose, FingerPose, FingerPose]
  /** The thumb: turned across the palm (`yaw`), raised off it (`lift`), and its two joints bent. */
  thumb: { yaw: number; lift: number; curl: [number, number, number]; twist?: number }
}

/** Where each finger starts on the palm, its three segment lengths, and its thickness at base and tip. */
export const FINGERS = [
  { base: new THREE.Vector3(0.024, 0.071, 0), lengths: [0.031, 0.02, 0.016], radius: [0.0086, 0.0068] },
  { base: new THREE.Vector3(0.008, 0.074, 0), lengths: [0.034, 0.022, 0.017], radius: [0.0088, 0.007] },
  { base: new THREE.Vector3(-0.008, 0.072, 0), lengths: [0.032, 0.021, 0.016], radius: [0.0085, 0.0068] },
  { base: new THREE.Vector3(-0.023, 0.066, 0), lengths: [0.025, 0.016, 0.014], radius: [0.0076, 0.0062] },
] as const
export const THUMB = { base: new THREE.Vector3(0.028, 0.02, 0.006), lengths: [0.03, 0.024, 0.019], radius: [0.0102, 0.0074] } as const
/** The palm: an ellipsoid a little flatter than a mitten. */
export const PALM = { centre: new THREE.Vector3(0, 0.038, 0.001), radii: new THREE.Vector3(0.036, 0.042, 0.0145) } as const

/**
 * The palm's shape from a point on a unit sphere: a rounded slab rather than an egg (squarer across and along,
 * flatter over the back), a little narrower at the wrist than at the knuckles.
 */
export function palmShape(unit: THREE.Vector3, out = new THREE.Vector3()) {
  const shape = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e
  const x = shape(unit.x, 0.55), y = shape(unit.y, 0.6), z = shape(unit.z, 0.8)
  const taper = 0.84 + 0.16 * (y + 1) / 2
  return out.set(PALM.centre.x + x * PALM.radii.x * taper, PALM.centre.y + y * PALM.radii.y, PALM.centre.z + z * PALM.radii.z)
}

/** Rings round each finger tube: along each segment (joints included), and round the tube. */
const RINGS_PER_SEGMENT = 3, RADIAL = 8
/** How far a curl may go at each joint (radians): knuckle, middle, end. */
const MAX_CURL: [number, number, number] = [1.55, 1.75, 1.25]
/** The thumb's joints bend less. */
const THUMB_CURL: [number, number, number] = [0.9, 1.1, 0.9]
/** How far a finger stops short of the surface it grips (metres): the ink line sits on the contact. */
export const SKIN = 0.0012

export const OPEN_HAND: HandPose = {
  fingers: [
    { curl: [0.15, 0.2, 0.1], spread: 0.08 }, { curl: [0.15, 0.2, 0.1], spread: 0.02 },
    { curl: [0.15, 0.2, 0.1], spread: -0.04 }, { curl: [0.18, 0.22, 0.12], spread: -0.1 },
  ],
  thumb: { yaw: 0.5, lift: 0.3, curl: [0.1, 0.15, 0.1] },
}

const clonePose = (pose: HandPose): HandPose => ({
  fingers: pose.fingers.map(f => ({ curl: [...f.curl] as [number, number, number], spread: f.spread })) as HandPose['fingers'],
  thumb: { yaw: pose.thumb.yaw, lift: pose.thumb.lift, curl: [...pose.thumb.curl] as [number, number, number], twist: pose.thumb.twist ?? 0 },
})

/** Blend two poses (0 = a, 1 = b). */
export function mixPose(a: HandPose, b: HandPose, t: number, out: HandPose = clonePose(a)): HandPose {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) out.fingers[i].curl[j] = a.fingers[i].curl[j] + (b.fingers[i].curl[j] - a.fingers[i].curl[j]) * t
    out.fingers[i].spread = a.fingers[i].spread + (b.fingers[i].spread - a.fingers[i].spread) * t
  }
  out.thumb.yaw = a.thumb.yaw + (b.thumb.yaw - a.thumb.yaw) * t
  out.thumb.lift = a.thumb.lift + (b.thumb.lift - a.thumb.lift) * t
  out.thumb.twist = (a.thumb.twist ?? 0) + ((b.thumb.twist ?? 0) - (a.thumb.twist ?? 0)) * t
  for (let j = 0; j < 3; j++) out.thumb.curl[j] = a.thumb.curl[j] + (b.thumb.curl[j] - a.thumb.curl[j]) * t
  return out
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1)

/** A finger's four joints (knuckle to tip) for a pose, in the hand frame. */
export function fingerJoints(i: number, pose: FingerPose, out: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]) {
  const spec = FINGERS[i]
  const dir = Y.clone().applyAxisAngle(Z, -pose.spread), side = X.clone().applyAxisAngle(Z, -pose.spread)
  out[0].copy(spec.base)
  let angle = 0
  for (let s = 0; s < 3; s++) {
    angle += pose.curl[s]
    const d = dir.clone().applyAxisAngle(side, angle)
    out[s + 1].copy(out[s]).addScaledVector(d, spec.lengths[s])
  }
  return out
}

/** The thumb's four joints (its root in the palm to its tip), in the hand frame. */
export function thumbJoints(pose: HandPose['thumb'], out: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]) {
  // Out from the palm toward the thumb side and up the hand, turned across the palm by `yaw` and off it by `lift`.
  const dir = new THREE.Vector3(0.62, 0.78, 0.08).normalize().applyAxisAngle(Z, pose.yaw).applyAxisAngle(Y, -pose.lift)
  const bend = new THREE.Vector3().crossVectors(dir, Z).normalize().applyAxisAngle(dir, pose.twist ?? 0)
  out[0].copy(THUMB.base)
  let angle = 0
  for (let s = 0; s < 3; s++) {
    angle += pose.curl[s]
    const d = dir.clone().applyAxisAngle(bend, -angle)
    out[s + 1].copy(out[s]).addScaledVector(d, THUMB.lengths[s])
  }
  return out
}

export const radiusAt = (spec: { radius: readonly [number, number] }, u: number) => spec.radius[0] + (spec.radius[1] - spec.radius[0]) * u

/**
 * One hand: its fill mesh (paper or a glove), silhouette and ink lines, re-posed in place. `root` is the hand
 * frame; put it where the wrist is and turn it so +Y runs along the hand.
 */
export class InkHand {
  readonly root = new THREE.Group()
  readonly mesh: THREE.Mesh
  readonly lines: THREE.LineSegments
  private geometry = new THREE.BufferGeometry()
  private lineGeometry = new THREE.BufferGeometry()
  private positions: Float32Array
  private linePositions: Float32Array
  private palmVertices: number
  private pose: HandPose = clonePose(OPEN_HAND)
  private scratch = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]

  constructor(name: string, material: THREE.Material, mirror = false) {
    this.root.name = name
    if (mirror) this.root.scale.x = -1
    // The palm: a UV sphere squashed into the palm's ellipsoid, fixed; then five tubes, re-posed.
    const palm = new THREE.SphereGeometry(1, 14, 10)
    const palmPos = palm.getAttribute('position') as THREE.BufferAttribute, palmIndex = palm.getIndex()!
    const unit = new THREE.Vector3(), shaped = new THREE.Vector3()
    for (let i = 0; i < palmPos.count; i++) palmPos.setXYZ(i, ...palmShape(unit.fromBufferAttribute(palmPos, i), shaped).toArray())
    this.palmVertices = palmPos.count
    const tubeVertices = (3 * RINGS_PER_SEGMENT + 1) * RADIAL + 1
    const total = this.palmVertices + tubeVertices * 5
    this.positions = new Float32Array(total * 3)
    this.positions.set(palmPos.array as Float32Array, 0)
    const indices: number[] = Array.from(palmIndex.array as ArrayLike<number>)
    for (let t = 0; t < 5; t++) {
      const start = this.palmVertices + t * tubeVertices, rings = 3 * RINGS_PER_SEGMENT + 1
      for (let r = 0; r < rings - 1; r++) for (let k = 0; k < RADIAL; k++) {
        const a = start + r * RADIAL + k, b = start + r * RADIAL + (k + 1) % RADIAL, c = a + RADIAL, d = b + RADIAL
        indices.push(a, b, c, b, d, c)
      }
      const tip = start + rings * RADIAL, last = start + (rings - 1) * RADIAL
      for (let k = 0; k < RADIAL; k++) indices.push(last + k, last + (k + 1) % RADIAL, tip)
    }
    this.geometry.setIndex(indices)
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    // A glove reads its pattern from this: across the hand, out of the back, along the hand (all about -1 to 1).
    this.geometry.setAttribute('gloveCoord', new THREE.BufferAttribute(new Float32Array(total * 3), 3))
    palm.dispose()
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.name = `${name} fill`
    this.mesh.frustumCulled = false
    const silhouette = createPenSilhouette(this.geometry, 2.4)
    silhouette.name = `${name} contour`
    silhouette.frustumCulled = false
    this.mesh.add(silhouette)
    // Fine ink: a crease across the back of every joint and the outline of each nail (5 x (3 creases + 4 nail edges)).
    this.linePositions = new Float32Array(5 * 7 * 2 * 3)
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3))
    this.lines = new THREE.LineSegments(this.lineGeometry, lineInk)
    this.lines.name = `${name} creases and nails`
    this.lines.frustumCulled = false
    this.root.add(this.mesh, this.lines)
    this.setPose(OPEN_HAND)
  }

  setMaterial(material: THREE.Material) { this.mesh.material = material }
  get currentPose() { return this.pose }

  /** Bend the hand into `pose`. */
  setPose(pose: HandPose) {
    this.pose = clonePose(pose)
    const tubeVertices = (3 * RINGS_PER_SEGMENT + 1) * RADIAL + 1
    let line = 0
    for (let t = 0; t < 5; t++) {
      const joints = t < 4 ? fingerJoints(t, pose.fingers[t], this.scratch) : thumbJoints(pose.thumb, this.scratch)
      const spec = t < 4 ? FINGERS[t] : THUMB
      this.writeTube(this.palmVertices + t * tubeVertices, joints, spec)
      line = this.writeInk(line, joints, spec, t)
    }
    this.writeGloveCoords()
    ;(this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    this.geometry.computeVertexNormals()
    ;(this.lineGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    this.geometry.computeBoundingSphere()
  }

  /** A tube through the joints, tapering from base to tip, with a rounded cap. */
  private writeTube(start: number, joints: THREE.Vector3[], spec: { radius: readonly [number, number] }) {
    const p = this.positions, rings = 3 * RINGS_PER_SEGMENT + 1
    const centre = new THREE.Vector3(), tangent = new THREE.Vector3(), normal = new THREE.Vector3(), binormal = new THREE.Vector3()
    // A stable side vector: the finger's bend axis, from its first and last segments.
    const reference = new THREE.Vector3().subVectors(joints[1], joints[0]).cross(new THREE.Vector3().subVectors(joints[3], joints[2]))
    if (reference.lengthSq() < 1e-10) reference.copy(X)
    reference.normalize()
    for (let r = 0; r < rings; r++) {
      const u = r / (rings - 1), segment = Math.min(2, Math.floor(u * 3)), local = u * 3 - segment
      centre.lerpVectors(joints[segment], joints[segment + 1], local)
      tangent.subVectors(joints[segment + 1], joints[segment]).normalize()
      // Smooth the bend at each joint: average with the neighbouring segment's direction.
      if (local === 0 && segment > 0) tangent.add(new THREE.Vector3().subVectors(joints[segment], joints[segment - 1]).normalize()).normalize()
      normal.copy(reference).addScaledVector(tangent, -reference.dot(tangent))
      if (normal.lengthSq() < 1e-10) normal.set(1, 0, 0)
      normal.normalize()
      binormal.crossVectors(tangent, normal)
      // Knuckles swell a little at each joint.
      const swell = 1 + 0.12 * Math.cos(local * Math.PI * 2) * (r % RINGS_PER_SEGMENT === 0 ? 1 : 0.4)
      const radius = radiusAt(spec, u) * swell
      for (let k = 0; k < RADIAL; k++) {
        const a = k / RADIAL * Math.PI * 2
        const o = (start + r * RADIAL + k) * 3
        p[o] = centre.x + (normal.x * Math.cos(a) + binormal.x * Math.sin(a)) * radius
        p[o + 1] = centre.y + (normal.y * Math.cos(a) + binormal.y * Math.sin(a)) * radius
        p[o + 2] = centre.z + (normal.z * Math.cos(a) + binormal.z * Math.sin(a)) * radius
      }
    }
    // The fingertip: a point a little past the last ring.
    const tip = joints[3].clone().addScaledVector(tangent, radiusAt(spec, 1) * 0.9), o = (start + rings * RADIAL) * 3
    p[o] = tip.x; p[o + 1] = tip.y; p[o + 2] = tip.z
  }

  /** Creases across the back of each joint, and each nail's outline on the back of the last segment. */
  private writeInk(line: number, joints: THREE.Vector3[], spec: { radius: readonly [number, number] }, finger: number) {
    const q = this.linePositions
    const put = (a: THREE.Vector3, b: THREE.Vector3) => { a.toArray(q, line * 6); b.toArray(q, line * 6 + 3); line++ }
    const reference = new THREE.Vector3().subVectors(joints[1], joints[0]).cross(new THREE.Vector3().subVectors(joints[3], joints[2]))
    if (reference.lengthSq() < 1e-10) reference.copy(X)
    reference.normalize()
    for (let j = 1; j <= 3; j++) {
      const tangent = new THREE.Vector3().subVectors(joints[Math.min(3, j)], joints[j - 1]).normalize()
      // The back of the finger: away from the palm (the curl pulls the palm side in).
      const back = new THREE.Vector3().crossVectors(reference, tangent).normalize().multiplyScalar(finger < 4 ? -1 : 1)
      const side = new THREE.Vector3().crossVectors(tangent, back).normalize()
      const r = radiusAt(spec, (j - 1) / 3) * 1.02
      if (j < 3) {
        const at = joints[j].clone().addScaledVector(back, r * 0.96)
        put(at.clone().addScaledVector(side, -r * 0.45), at.clone().addScaledVector(side, r * 0.45))
      } else {
        const rt = radiusAt(spec, 0.9)
        const a = joints[2].clone().lerp(joints[3], 0.45).addScaledVector(back, rt * 1.01), b = joints[3].clone().addScaledVector(back, rt * 0.8)
        const w = rt * 0.55
        put(a.clone().addScaledVector(side, -w), a.clone().addScaledVector(side, w))
        put(a.clone().addScaledVector(side, w), b.clone().addScaledVector(side, w * 0.8))
        put(b.clone().addScaledVector(side, w * 0.8), b.clone().addScaledVector(side, -w * 0.8))
        put(b.clone().addScaledVector(side, -w * 0.8), a.clone().addScaledVector(side, -w))
      }
    }
    // Thumb: one crease fewer; keep the count fixed with a zero-length mark.
    if (finger === 4) while (line < 5 * 7) put(joints[0], joints[0])
    return line
  }

  private writeGloveCoords() {
    const p = this.positions, g = (this.geometry.getAttribute('gloveCoord') as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < p.length; i += 3) {
      g[i] = p[i] / 0.036
      g[i + 1] = -p[i + 2] / 0.0145
      g[i + 2] = (p[i + 1] - 0.05) / 0.05
    }
    ;(this.geometry.getAttribute('gloveCoord') as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    this.root.removeFromParent()
    this.geometry.dispose(); this.lineGeometry.dispose()
  }
}
const lineInk = new THREE.LineBasicMaterial({ color: penPalette.ink, toneMapped: false })

// ---------------------------------------------------------------- grips

/** Anything a hand can touch: whether any of it lies within `radius` of a point. */
export type Surface = { near(p: THREE.Vector3, radius: number): boolean }

/** A gun's surface as points (metres, in the gun's frame), one per few-millimetre voxel, bucketed for quick nearest tests. */
export class GripCloud implements Surface {
  private cells = new Map<number, number[]>()
  private taken = new Set<number>()
  readonly points: number[] = []
  constructor(readonly spacing = 0.003, private cell = 0.02) {}
  private static key(x: number, y: number, z: number) { return ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024) }
  add(p: THREE.Vector3) {
    // One point per voxel of the spacing: a flat face and a thin sliver cost the same per area.
    const voxel = GripCloud.key(Math.floor(p.x / this.spacing), Math.floor(p.y / this.spacing), Math.floor(p.z / this.spacing))
    if (this.taken.has(voxel)) return
    this.taken.add(voxel)
    const i = this.points.length / 3
    this.points.push(p.x, p.y, p.z)
    const key = GripCloud.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell), Math.floor(p.z / this.cell))
    const list = this.cells.get(key)
    if (list) list.push(i); else this.cells.set(key, [i])
  }
  get size() { return this.points.length / 3 }
  /** Whether any surface point lies within `radius` of `p`. */
  near(p: THREE.Vector3, radius: number) {
    const c = this.cell, r2 = radius * radius, points = this.points
    const x0 = Math.floor((p.x - radius) / c), x1 = Math.floor((p.x + radius) / c)
    const y0 = Math.floor((p.y - radius) / c), y1 = Math.floor((p.y + radius) / c)
    const z0 = Math.floor((p.z - radius) / c), z1 = Math.floor((p.z + radius) / c)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const list = this.cells.get(GripCloud.key(x, y, z))
      if (!list) continue
      for (const i of list) {
        const dx = points[i * 3] - p.x, dy = points[i * 3 + 1] - p.y, dz = points[i * 3 + 2] - p.z
        if (dx * dx + dy * dy + dz * dz <= r2) return true
      }
    }
    return false
  }
}

const clouds = new Map<string, GripCloud>()

/**
 * Sample a gun's paper faces (not its ink) into points every few millimetres, within `regions` of its frame
 * (the grips and fore-end are all a hand can touch). Cached by the gun's drawing: every copy shares it.
 */
export function gunCloud(model: THREE.Object3D, key: string, regions: THREE.Box3[] = [new THREE.Box3(new THREE.Vector3(-0.12, -0.2, -0.3), new THREE.Vector3(0.12, 0.2, 0.5))]) {
  const cached = clouds.get(key)
  if (cached) return cached
  const cloud = new GripCloud()
  model.updateWorldMatrix(true, true)
  const inverse = new THREE.Matrix4().copy(model.matrixWorld).invert(), local = new THREE.Matrix4()
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3()
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), box = new THREE.Box3()
  // A triangle is split until its pieces are small, and a piece outside every region is dropped: a long
  // tube's face that crosses a region is sampled only there.
  const sample = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    box.makeEmpty().expandByPoint(a).expandByPoint(b).expandByPoint(c)
    if (!regions.some(r => r.intersectsBox(box))) return
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a))
    if (longest > 0.03) {
      const ab = a.clone().lerp(b, 0.5), bc = b.clone().lerp(c, 0.5), ca = c.clone().lerp(a, 0.5)
      sample(a, ab, ca); sample(ab, b, bc); sample(ca, bc, c); sample(ab, bc, ca)
      return
    }
    e1.subVectors(b, a); e2.subVectors(c, a)
    const n = Math.max(1, Math.ceil(longest / (cloud.spacing * 0.9)))
    for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
      p.copy(a).addScaledVector(e1, u / n).addScaledVector(e2, v / n)
      if (regions.some(r => r.containsPoint(p))) cloud.add(p)
    }
  }
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.material instanceof THREE.ShaderMaterial || !object.visible) return
    const geometry = object.geometry as THREE.BufferGeometry, position = geometry.getAttribute('position')
    if (!position) return
    local.multiplyMatrices(inverse, object.matrixWorld)
    const index = geometry.getIndex(), count = index ? index.count : position.count
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(local)
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(local)
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(local)
      sample(a.clone(), b.clone(), c.clone())
    }
  })
  clouds.set(key, cloud)
  return cloud
}

/** Points over the palm's gripping face (the hand frame): where the palm meets what it holds. */
export function palmPoints() {
  const out: THREE.Vector3[] = []
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const u = -0.85 + (1.7 * i) / 6, v = -0.85 + (1.7 * j) / 6
    const w = 1 - u * u - v * v
    if (w < 0.05) continue
    out.push(palmShape(new THREE.Vector3(u, v, Math.sqrt(w))))
  }
  return out
}

/** A joint's bend `s` of the way (0 to 1) from where it starts to its limit. */
const curlAt = (from: number, max: number, s: number) => from + (max - from) * s

/**
 * Close each finger (and the thumb) of `start` round the surface, one joint at a time from the knuckle out:
 * each joint bends until the finger touches, then the next takes over, so a finger wraps a grip as a real one
 * does (not floating off it, not sinking in). `toGun` takes a point from the hand frame into the cloud's
 * frame. `which` limits it to some fingers (0-3, 4 the thumb); `limit` caps how far each joint may bend (0 to 1
 * of the way to its limit).
 */
export function solveGrip(start: HandPose, toGun: THREE.Matrix4, cloud: Surface, which: readonly number[] = [0, 1, 2, 3, 4], limit = 1): HandPose {
  const pose = clonePose(start)
  const joints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], p = new THREE.Vector3()
  const scale = toGun.getMaxScaleOnAxis()
  const touches = (finger: number, from: number) => {
    if (finger < 4) fingerJoints(finger, pose.fingers[finger], joints); else thumbJoints(pose.thumb, joints)
    const spec = finger < 4 ? FINGERS[finger] : THUMB
    // Along the finger from the moving joint out (the knuckle's own base sits in the palm).
    for (let segment = from; segment < 3; segment++) for (const u of [0.35, 0.7, 1]) {
      if (segment === 0 && u < 0.7) continue
      p.lerpVectors(joints[segment], joints[segment + 1], u).applyMatrix4(toGun)
      if (cloud.near(p, radiusAt(spec, (segment + u) / 3) * scale + SKIN)) return true
    }
    return false
  }
  for (const finger of which) {
    const curls = finger < 4 ? pose.fingers[finger].curl : pose.thumb.curl
    const from = finger < 4 ? start.fingers[finger].curl : start.thumb.curl
    const limits = finger < 4 ? MAX_CURL : THUMB_CURL
    // Touching as it starts: the thumb comes off the palm, a finger in toward its neighbours, until it is clear.
    if (finger === 4) for (let i = 0; i < 14 && touches(4, 0); i++) pose.thumb.lift -= 0.1
    else for (let i = 0; i < 8 && touches(finger, 0); i++) pose.fingers[finger].spread *= 0.6
    // A finger blocked even straight (something close ahead of the grip) starts from a fist just loose enough to be clear.
    const base = [...curls]
    if (finger < 4 && touches(finger, 0)) {
      for (let s = 0.1; s <= 1.001 && touches(finger, 0); s += 0.1) for (let j = 0; j < 3; j++) curls[j] = curlAt(from[j], limits[j], s)
      for (let j = 0; j < 3; j++) base[j] = curls[j]
    }
    if (touches(finger, 0)) { for (let j = 0; j < 3; j++) curls[j] = from[j]; continue }
    // The thumb closes by swinging in toward the palm (its lift) until it lies on the surface; one that would
    // close on nothing stays where it was aimed.
    if (finger === 4) {
      const from = pose.thumb.lift
      let lo = 0, hi = 1.2 * limit
      pose.thumb.lift = from + hi
      if (!touches(4, 0)) { pose.thumb.lift = from; continue }
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; pose.thumb.lift = from + mid; if (touches(4, 0)) hi = mid; else lo = mid }
      pose.thumb.lift = from + lo
      continue
    }
    for (let joint = 0; joint < 3; joint++) {
      let lo = 0, hi = limit
      curls[joint] = curlAt(base[joint], limits[joint], hi)
      if (!touches(finger, joint)) lo = hi
      else for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2
        curls[joint] = curlAt(base[joint], limits[joint], mid)
        if (touches(finger, joint)) hi = mid; else lo = mid
      }
      curls[joint] = curlAt(base[joint], limits[joint], lo)
    }
  }
  return pose
}

/** Whether any part of a posed hand sinks into the surface (checks: no finger or palm through the gun). */
export function handClips(pose: HandPose, toGun: THREE.Matrix4, cloud: Surface, which: readonly number[] = [0, 1, 2, 3, 4], palm = true) {
  const joints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], p = new THREE.Vector3()
  const scale = toGun.getMaxScaleOnAxis()
  for (const finger of which) {
    if (finger < 4) fingerJoints(finger, pose.fingers[finger], joints); else thumbJoints(pose.thumb, joints)
    const spec = finger < 4 ? FINGERS[finger] : THUMB
    for (let segment = 0; segment < 3; segment++) for (const u of [0.35, 0.7, 1]) {
      if (segment === 0 && u < 0.7) continue
      p.lerpVectors(joints[segment], joints[segment + 1], u).applyMatrix4(toGun)
      if (cloud.near(p, radiusAt(spec, (segment + u) / 3) * scale * 0.6)) return true
    }
  }
  // The palm: its face may touch, but a point 3 mm under it must not be at the surface.
  if (palm) for (const point of palmPoints()) {
    p.copy(point).setZ(point.z - 0.003).applyMatrix4(toGun)
    if (cloud.near(p, 0.0015)) return true
  }
  return false
}

/** How far a posed finger's pad is from the surface (metres, skin to surface; checks: every wrapped finger touches). */
export function tipGap(pose: HandPose, finger: number, toGun: THREE.Matrix4, cloud: Surface, max = 0.03) {
  const joints = finger < 4 ? fingerJoints(finger, pose.fingers[finger]) : thumbJoints(pose.thumb)
  const spec = finger < 4 ? FINGERS[finger] : THUMB
  const radius = spec.radius[1] * toGun.getMaxScaleOnAxis()
  // The nearest surface to the last two segments (the pad, not only the very tip).
  let best = Infinity
  const p = new THREE.Vector3()
  for (const [segment, u] of [[1, 0.5], [1, 1], [2, 0.5], [2, 1]] as const) {
    p.lerpVectors(joints[segment], joints[segment + 1], u).applyMatrix4(toGun)
    let lo = 0, hi = max + radius
    if (!cloud.near(p, hi)) continue
    for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (cloud.near(p, mid)) hi = mid; else lo = mid }
    best = Math.min(best, Math.max(0, hi - radius))
  }
  return best
}

/**
 * Turn the thumb (its yaw across the palm and its lift off it) so its tip comes as near `target` (the
 * surface's frame) as it can without touching anything on the way: along the frame's far side, over a
 * handguard, round a tank. solveGrip then closes it onto the surface.
 */
export function aimThumb(start: HandPose, toGun: THREE.Matrix4, surface: Surface, target: THREE.Vector3): HandPose {
  const pose = clonePose(start)
  const joints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], p = new THREE.Vector3()
  const scale = toGun.getMaxScaleOnAxis()
  let best = Infinity, yaw = pose.thumb.yaw, lift = pose.thumb.lift, bend = 0, twist = 0
  const tryPose = (y: number, l: number, c: number) => {
    pose.thumb.yaw = y; pose.thumb.lift = l; pose.thumb.curl = [c * 0.5, c, c * 0.7]
    thumbJoints(pose.thumb, joints)
    for (let segment = 0; segment < 3; segment++) for (const u of [0.35, 0.7, 1]) {
      p.lerpVectors(joints[segment], joints[segment + 1], u).applyMatrix4(toGun)
      if (surface.near(p, radiusAt(THUMB, (segment + u) / 3) * scale + SKIN * 2)) return
    }
    const distance = p.copy(joints[3]).applyMatrix4(toGun).distanceTo(target)
    if (distance < best) { best = distance; yaw = y; lift = l; bend = c; twist = pose.thumb.twist ?? 0 }
  }
  // Coarse over the thumb's whole reach and bend, then fine round the best.
  // The way the thumb bends is searched too (twisted round its own length): it can curl round a back strap.
  for (const w of [-1.2, -0.6, 0, 0.6, 1.2]) for (const c of [0.05, 0.4, 0.8]) for (let y = -2.2; y <= 1.4; y += 0.2) for (let l = -0.6; l <= 1.8; l += 0.2) { pose.thumb.twist = w; tryPose(y, l, c) }
  const [y0, l0, c0, w0] = [yaw, lift, bend, twist]
  for (const w of [w0 - 0.3, w0, w0 + 0.3]) for (const c of [c0 - 0.15, c0, c0 + 0.15]) for (let y = y0 - 0.2; y <= y0 + 0.2; y += 0.05) for (let l = l0 - 0.2; l <= l0 + 0.2; l += 0.05) { pose.thumb.twist = w; tryPose(y, l, Math.max(0, c)) }
  pose.thumb.curl = [bend * 0.5, bend, bend * 0.7]; pose.thumb.twist = twist
  pose.thumb.yaw = yaw; pose.thumb.lift = lift
  return pose
}
