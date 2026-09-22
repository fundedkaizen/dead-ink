import * as THREE from 'three'
import { penPalette } from '../../render/ballpoint'

/**
 * Where a zombie climbs out of the ground: a cracked ink blot spreads on the floor, clods fly up and
 * fall back, and the blot fades into the paper over a few seconds. Two instanced meshes, so any number
 * of risings costs two draw calls.
 */
const MARKS = 24, CLODS = 160
const MARK_LIFE = 9, CLOD_LIFE = 1.1
const INK = new THREE.Color(penPalette.ink), PAPER = new THREE.Color(penPalette.paper)

type Mark = { position: THREE.Vector3; angle: number; size: number; age: number }
type Clod = { position: THREE.Vector3; velocity: THREE.Vector3; spin: THREE.Vector3; rotation: THREE.Euler; floor: number; size: number; age: number }

/** A ragged blot with cracks running out of it, as one flat shape. */
function crackedBlot() {
  const shape = new THREE.Shape()
  const points: THREE.Vector2[] = []
  const cracks = [0.3, 1.5, 2.4, 3.6, 4.5, 5.6]
  for (let i = 0; i < 72; i++) {
    const angle = i / 72 * Math.PI * 2
    let radius = 0.55 + Math.sin(angle * 5 + 1.3) * 0.08 + Math.sin(angle * 11) * 0.04
    // Each crack is a thin spike well beyond the blot's edge.
    for (const crack of cracks) {
      const off = Math.abs(Math.atan2(Math.sin(angle - crack), Math.cos(angle - crack)))
      if (off < 0.09) radius = Math.max(radius, 0.55 + (1 - off / 0.09) * (0.5 + (crack * 7 % 1) * 0.45))
    }
    points.push(new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius))
  }
  shape.setFromPoints(points)
  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

export class RiseMarks {
  readonly marks = new THREE.InstancedMesh(crackedBlot(),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), MARKS)
  readonly clods = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({ color: penPalette.ink, toneMapped: false }), CLODS)
  private active: Mark[] = []
  private flying: Clod[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private color = new THREE.Color()

  constructor(scene: THREE.Scene) {
    for (const [mesh, name] of [[this.marks, 'Zombie rising ink marks'], [this.clods, 'Zombie rising clods']] as const) {
      mesh.name = name
      mesh.userData.noCollision = true
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
    }
    this.marks.setColorAt(0, INK)
    this.marks.renderOrder = 1
    scene.add(this.marks, this.clods)
  }

  emit(position: THREE.Vector3) {
    this.active.push({ position: position.clone().setY(position.y + 0.012), angle: Math.random() * Math.PI * 2, size: 0.85 + Math.random() * 0.3, age: 0 })
    if (this.active.length > MARKS) this.active.shift()
    for (let i = 0; i < 14; i++) {
      const angle = i * 2.399 + Math.random() * 0.4, out = 1.2 + Math.random() * 1.8
      this.flying.push({
        position: position.clone().add(new THREE.Vector3(Math.cos(angle) * 0.25, 0.05, Math.sin(angle) * 0.25)),
        velocity: new THREE.Vector3(Math.cos(angle) * out, 3 + Math.random() * 2.5, Math.sin(angle) * out),
        spin: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 12 - 6, Math.random() * 12 - 6),
        rotation: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        floor: position.y + 0.03, size: 0.035 + Math.random() * 0.05, age: 0,
      })
    }
    if (this.flying.length > CLODS) this.flying.splice(0, this.flying.length - CLODS)
  }

  update(dt: number) {
    const delta = Math.min(dt, 0.05)
    this.active = this.active.filter(mark => (mark.age += delta) < MARK_LIFE)
    this.active.forEach((mark, i) => {
      // Spreads fast as the ground breaks, then fades from ink into the paper.
      const grow = Math.min(1, mark.age / 0.35)
      const fade = THREE.MathUtils.smoothstep(mark.age, MARK_LIFE - 3, MARK_LIFE)
      this.scale.setScalar(mark.size * (0.4 + 0.6 * grow))
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, mark.angle)
      this.marks.setMatrixAt(i, this.matrix.compose(mark.position, this.quaternion, this.scale))
      this.marks.setColorAt(i, this.color.copy(INK).lerp(PAPER, fade))
    })
    this.marks.count = this.active.length
    this.marks.instanceMatrix.needsUpdate = true
    if (this.marks.instanceColor) this.marks.instanceColor.needsUpdate = true
    this.flying = this.flying.filter(clod => (clod.age += delta) < CLOD_LIFE)
    this.flying.forEach((clod, i) => {
      if (clod.position.y > clod.floor || clod.velocity.y > 0) {
        clod.velocity.y -= 14 * delta
        clod.position.addScaledVector(clod.velocity, delta)
        clod.rotation.x += clod.spin.x * delta; clod.rotation.y += clod.spin.y * delta; clod.rotation.z += clod.spin.z * delta
        if (clod.position.y < clod.floor) { clod.position.y = clod.floor; clod.velocity.set(0, 0, 0) }
      }
      this.scale.setScalar(clod.size * (1 - THREE.MathUtils.smoothstep(clod.age, CLOD_LIFE - 0.3, CLOD_LIFE)))
      this.clods.setMatrixAt(i, this.matrix.compose(clod.position, this.quaternion.setFromEuler(clod.rotation), this.scale))
    })
    this.clods.count = this.flying.length
    this.clods.instanceMatrix.needsUpdate = true
  }

  clear() { this.active = []; this.flying = []; this.marks.count = 0; this.clods.count = 0 }

  dispose() {
    this.clear()
    for (const mesh of [this.marks, this.clods]) {
      mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose()
    }
  }
}

// ---------------------------------------------------------------- light motes

let dot: THREE.CanvasTexture | null = null
/** A soft round glow, white, tinted per particle. */
function glowDot() {
  if (dot || typeof document === 'undefined') return dot
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g; c.fillRect(0, 0, 64, 64)
  dot = new THREE.CanvasTexture(canvas)
  return dot
}

type Mote = { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number; color: THREE.Color }

/**
 * Glowing specks of light that rise and fade: the Mystery Box's magic. Positions are local to the
 * object the motes are added to. One Points draw call.
 */
export class LightMotes extends THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
  private motes: Mote[] = []
  private positions: Float32Array
  private colors: Float32Array
  private credit = 0

  constructor(private capacity = 120, size = 0.07) {
    const geometry = new THREE.BufferGeometry()
    const positions = new Float32Array(capacity * 3), colors = new Float32Array(capacity * 4)
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage))
    geometry.setDrawRange(0, 0)
    super(geometry, new THREE.PointsMaterial({ size, map: glowDot(), vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: true }))
    this.positions = positions; this.colors = colors
    this.name = 'Light motes'
    this.userData.noCollision = true
    this.frustumCulled = false
    this.renderOrder = 12
  }

  /**
   * Emit `rate` motes a second from `source` (called with a vector to fill), rising at `speed`,
   * in `color`; then move and fade every mote.
   */
  update(dt: number, rate: number, source: (out: THREE.Vector3) => void, color: THREE.ColorRepresentation, speed = 0.6) {
    const delta = Math.min(dt, 0.05)
    this.credit += rate * delta
    const tint = new THREE.Color(color)
    while (this.credit >= 1 && this.motes.length < this.capacity) {
      this.credit -= 1
      const position = new THREE.Vector3()
      source(position)
      const angle = Math.random() * Math.PI * 2, drift = 0.08 + Math.random() * 0.12
      this.motes.push({ position, velocity: new THREE.Vector3(Math.cos(angle) * drift, speed * (0.6 + Math.random() * 0.8), Math.sin(angle) * drift),
        age: 0, life: 0.9 + Math.random() * 1.1, color: tint.clone() })
    }
    if (this.credit >= 1) this.credit = 0
    this.motes = this.motes.filter(mote => (mote.age += delta) < mote.life)
    this.motes.forEach((mote, i) => {
      // A slow swirl as they rise.
      const swirl = Math.sin(mote.age * 3 + i) * 0.15 * delta
      mote.position.addScaledVector(mote.velocity, delta)
      mote.position.x += swirl; mote.position.z -= swirl
      mote.position.toArray(this.positions, i * 3)
      const fade = Math.min(1, mote.age / 0.2) * (1 - THREE.MathUtils.smoothstep(mote.age, mote.life * 0.55, mote.life))
      this.colors[i * 4] = mote.color.r; this.colors[i * 4 + 1] = mote.color.g; this.colors[i * 4 + 2] = mote.color.b; this.colors[i * 4 + 3] = fade
    })
    this.geometry.setDrawRange(0, this.motes.length)
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.color.needsUpdate = true
  }

  reset() { this.motes = []; this.credit = 0; this.geometry.setDrawRange(0, 0) }
  dispose() { this.removeFromParent(); this.geometry.dispose(); this.material.dispose() }
}

// ---------------------------------------------------------------- muzzle sparks

type Spark = { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number }
const SPARK_COLOR = new THREE.Color(0xffb13b)

/** Short hot streaks thrown forward from the muzzle on every shot. Instanced, one draw call. */
export class MuzzleSparks {
  readonly mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.006, 0.006, 1),
    new THREE.MeshBasicMaterial({ color: SPARK_COLOR, toneMapped: false, transparent: true, depthWrite: false }), 64)
  private sparks: Spark[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private forward = new THREE.Vector3(0, 0, 1)

  constructor(scene: THREE.Scene) {
    this.mesh.name = 'Muzzle sparks'
    this.mesh.userData.noCollision = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.renderOrder = 12
    scene.add(this.mesh)
  }

  emit(origin: THREE.Vector3, direction: THREE.Vector3, count = 4) {
    const side = new THREE.Vector3()
    for (let i = 0; i < count; i++) {
      side.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.9)
      const velocity = direction.clone().normalize().add(side).normalize().multiplyScalar(6 + Math.random() * 7)
      this.sparks.push({ position: origin.clone(), velocity, age: 0, life: 0.06 + Math.random() * 0.08 })
    }
    if (this.sparks.length > 64) this.sparks.splice(0, this.sparks.length - 64)
  }

  update(dt: number) {
    const delta = Math.min(dt, 0.05)
    this.sparks = this.sparks.filter(spark => (spark.age += delta) < spark.life)
    this.sparks.forEach((spark, i) => {
      spark.velocity.y -= 9 * delta
      spark.position.addScaledVector(spark.velocity, delta)
      const speed = spark.velocity.length()
      this.quaternion.setFromUnitVectors(this.forward, spark.velocity.clone().divideScalar(speed))
      this.scale.set(1, 1, Math.min(0.12, speed * 0.012) * (1 - spark.age / spark.life))
      this.mesh.setMatrixAt(i, this.matrix.compose(spark.position, this.quaternion, this.scale))
    })
    this.mesh.count = this.sparks.length
    this.mesh.instanceMatrix.needsUpdate = true
  }

  clear() { this.sparks = []; this.mesh.count = 0 }
  dispose() { this.clear(); this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose() }
}

// ---------------------------------------------------------------- the Brute's slam

type Ring = { position: THREE.Vector3; radius: number; age: number }
const RING_LIFE = 0.7

/** An ink ring racing out over the ground from where the Brute's fists came down. */
export class Shockwaves {
  readonly mesh = new THREE.InstancedMesh(new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), 6)
  private rings: Ring[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private color = new THREE.Color()

  constructor(scene: THREE.Scene) {
    this.mesh.name = 'Brute shockwaves'
    this.mesh.userData.noCollision = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, INK)
    this.mesh.count = 0
    scene.add(this.mesh)
  }

  emit(position: THREE.Vector3, radius: number) {
    this.rings.push({ position: position.clone().setY(position.y + 0.03), radius, age: 0 })
    if (this.rings.length > 6) this.rings.shift()
  }

  update(dt: number) {
    this.rings = this.rings.filter(ring => (ring.age += Math.min(dt, 0.05)) < RING_LIFE)
    this.rings.forEach((ring, i) => {
      const t = ring.age / RING_LIFE
      this.scale.set(1, 1, 1).multiplyScalar(ring.radius * (0.15 + 0.85 * Math.sqrt(t)))
      this.mesh.setMatrixAt(i, this.matrix.compose(ring.position, this.quaternion, this.scale))
      this.mesh.setColorAt(i, this.color.copy(INK).lerp(PAPER, t * t))
    })
    this.mesh.count = this.rings.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  clear() { this.rings = []; this.mesh.count = 0 }
  dispose() { this.clear(); this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose() }
}
