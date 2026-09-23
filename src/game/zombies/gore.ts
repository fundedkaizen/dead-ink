import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { penPalette } from '../../render/ballpoint'
import type { EnemyActor } from '../actors'

/**
 * Dead Ink's gore, in ink: a headshot pops the head in a burst of ink, a heavy hit tears an arm off, a
 * blast takes the legs (the zombie crawls on) or blows the whole body into ink chunks. Blood is black ink,
 * never red: every drop, chunk and splat here is ink that lands and dries back into the paper.
 *
 * Body parts are never re-meshed. A lost part's bone is shrunk to nothing, which collapses its skinned
 * vertices onto the joint (a stump); a stand-in piece of the same shape flies off in its place. Every
 * effect is pooled and instanced with a hard cap, so a crowd under constant fire costs a fixed handful of
 * draw calls, and the oldest piece gives way when a cap is reached.
 */
export const GORE = {
  chunks: 140, drops: 260, splats: 90, pieces: 12, bursts: 8,
  /** Seconds a splat stays before it has dried back into the paper. */
  splatLife: 14,
  /** Seconds a torn-off limb lies there, then sinks into the ink. */
  pieceLie: 4.5, pieceSink: 1.4,
} as const

export type BodyPart = 'head' | 'arm.L' | 'arm.R' | 'legs'
/** A shrunk bone's scale: small enough to vanish, not zero, so the skinning shader's rotation stays finite. */
const GONE = 0.001

/** What is left of a thigh when the legs go: a stump a bit over half its length, dragged behind. */
export const STUMP = 0.55

/** Hide (or bring back) a body part on a pooled actor. Lost parts collapse onto their joint. */
export function setPartLost(actor: EnemyActor, part: BodyPart, lost: boolean) {
  const bones = actor.rig.bones
  if (part === 'legs') {
    // Torn off at the thigh: the shins vanish, short stumps stay.
    for (const side of ['L', 'R'] as const) {
      bones[`thigh.${side}`].scale.setScalar(lost ? STUMP : 1)
      bones[`shin.${side}`].scale.setScalar(lost ? GONE / STUMP : 1)
    }
    return
  }
  bones[part === 'head' ? 'head' : part === 'arm.L' ? 'upper_arm.L' : 'upper_arm.R'].scale.setScalar(lost ? GONE : 1)
}

/** Every part back: a zombie reused from the pool is whole again. */
export function restoreParts(actor: EnemyActor) {
  for (const part of ['head', 'arm.L', 'arm.R', 'legs'] as const) setPartLost(actor, part, false)
}

export function partLost(actor: EnemyActor, part: BodyPart) {
  const bones = actor.rig.bones
  const bone = part === 'head' ? bones.head : part === 'legs' ? bones['shin.L'] : bones[part === 'arm.L' ? 'upper_arm.L' : 'upper_arm.R']
  return bone.scale.x < 0.5
}

const BODY = new THREE.Color(penPalette.character)
const INK = new THREE.Color(penPalette.ink)
const PAPER = new THREE.Color(penPalette.paper)
const GRAVITY = 14
const smooth = THREE.MathUtils.smoothstep

/** An arm as the stickman has it, shoulder at the origin, along +Y: upper arm, forearm, fist. */
function armGeometry() {
  const upper = new THREE.CapsuleGeometry(0.052, 0.2, 3, 8).translate(0, 0.12, 0)
  const fore = new THREE.CapsuleGeometry(0.045, 0.2, 3, 8).translate(0, 0.35, 0)
  const fist = new THREE.SphereGeometry(0.058, 8, 6).translate(0, 0.5, 0.005)
  return mergeGeometries([upper, fore, fist])!
}
/** A leg, hip at the origin, along +Y: thigh, shin, a foot turned forward. */
function legGeometry() {
  const thigh = new THREE.CapsuleGeometry(0.085, 0.28, 3, 8).translate(0, 0.18, 0)
  const shin = new THREE.CapsuleGeometry(0.065, 0.34, 3, 8).translate(0, 0.57, 0)
  const foot = new THREE.CapsuleGeometry(0.06, 0.1, 3, 8).rotateX(Math.PI / 2).translate(0, 0.79, 0.05)
  return mergeGeometries([thigh, shin, foot])!
}
const PIECE_LENGTH = [0.56, 0.84], PIECE_RADIUS = [0.055, 0.085]

/** A lumpy ink blob for chunks: an icosphere pushed in and out. */
function blobGeometry() {
  const geometry = new THREE.IcosahedronGeometry(1, 1)
  const p = geometry.getAttribute('position')
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    const k = 0.78 + 0.34 * Math.abs(Math.sin(v.x * 5.1 + v.y * 3.3) * Math.cos(v.z * 4.7 - v.y * 2.1))
    p.setXYZ(i, v.x * k, v.y * k * 0.85, v.z * k)
  }
  geometry.computeVertexNormals()
  return geometry
}

/** A flat ink splat: a ragged blot with a few flung droplets around it. Radius about 1. */
function splatGeometry() {
  const shapes: THREE.Shape[] = []
  const blot = new THREE.Shape(), points: THREE.Vector2[] = []
  for (let i = 0; i < 40; i++) {
    const a = i / 40 * Math.PI * 2
    const r = 0.62 + Math.sin(a * 5 + 0.4) * 0.1 + Math.sin(a * 11 + 2) * 0.06 + (i % 7 === 0 ? 0.22 : 0)
    points.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r))
  }
  blot.setFromPoints(points)
  shapes.push(blot)
  for (let i = 0; i < 7; i++) {
    const a = i * 2.39996 + 0.3, d = 0.95 + (i * 0.37 % 0.4), r = 0.05 + (i * 0.13 % 0.08)
    const dot = new THREE.Shape()
    dot.absarc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2, false)
    shapes.push(dot)
  }
  const geometry = new THREE.ShapeGeometry(shapes, 3)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

let splashTexture: THREE.CanvasTexture | null = null
/** The pop: a spiky ink splash with flung drops, drawn once on a canvas. */
function splash() {
  if (splashTexture || typeof document === 'undefined') return splashTexture
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const c = canvas.getContext('2d')!
  c.translate(128, 128)
  c.fillStyle = '#000'
  c.beginPath()
  for (let i = 0; i <= 56; i++) {
    const a = i / 56 * Math.PI * 2
    const spike = i % 4 === 0 ? 34 + (i * 29 % 23) : i % 2 ? 0 : 12
    const r = 52 + Math.sin(a * 6 + 1) * 8 + spike
    c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r)
  }
  c.closePath(); c.fill()
  for (let i = 0; i < 16; i++) {
    const a = i * 2.39996, d = 92 + (i * 17 % 26)
    c.beginPath(); c.arc(Math.cos(a) * d, Math.sin(a) * d, 3 + (i * 7 % 6), 0, Math.PI * 2); c.fill()
  }
  // A paper-white crack through the middle: the pop reads as a burst, not a flat dot.
  c.fillStyle = '#fff'
  c.beginPath()
  for (let i = 0; i <= 10; i++) {
    const a = i / 10 * Math.PI * 2, r = i % 2 ? 9 : 24
    c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r)
  }
  c.closePath(); c.fill()
  splashTexture = new THREE.CanvasTexture(canvas)
  splashTexture.colorSpace = THREE.SRGBColorSpace
  return splashTexture
}

type Piece = { kind: 0 | 1; position: THREE.Vector3; velocity: THREE.Vector3; quaternion: THREE.Quaternion; spin: THREE.Vector3; floor: number; scale: number; age: number; landed: number; bounced: boolean; lie: THREE.Quaternion | null }
type Chunk = { position: THREE.Vector3; velocity: THREE.Vector3; spin: THREE.Vector3; rotation: THREE.Euler; floor: number; size: number; age: number; life: number; landed: boolean }
type Drop = { position: THREE.Vector3; velocity: THREE.Vector3; radius: number; floor: number; age: number; marks: boolean }
type Splat = { position: THREE.Vector3; angle: number; size: number; age: number; grow: number }
type Burst = { sprite: THREE.Sprite; age: number; size: number; life: number }
type Spurt = { bone: THREE.Object3D; floor: number; age: number; next: number; scale: number }

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.name = name
  mesh.userData.noCollision = true
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.visible = false
  return mesh
}

export class InkGore {
  readonly root = new THREE.Group()
  readonly pieceMeshes: [THREE.InstancedMesh, THREE.InstancedMesh]
  readonly chunkMesh: THREE.InstancedMesh
  readonly dropMesh: THREE.InstancedMesh
  readonly splatMesh: THREE.InstancedMesh
  private pieces: Piece[] = []
  private chunks: Chunk[] = []
  private drops: Drop[] = []
  private splats: Splat[] = []
  private bursts: Burst[] = []
  private spare: THREE.Sprite[] = []
  private spurts: Spurt[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private turn = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private point = new THREE.Vector3()
  private axis = new THREE.Vector3()
  private color = new THREE.Color()

  constructor(scene: THREE.Object3D) {
    this.root.name = 'Ink gore'
    this.root.userData.noCollision = true
    const body = new THREE.MeshBasicMaterial({ color: BODY, toneMapped: false })
    this.pieceMeshes = [instanced(armGeometry(), body, GORE.pieces, 'Torn-off arms'), instanced(legGeometry(), body, GORE.pieces, 'Torn-off legs')]
    this.chunkMesh = instanced(blobGeometry(), new THREE.MeshBasicMaterial({ color: INK, toneMapped: false }), GORE.chunks, 'Ink chunks')
    this.dropMesh = instanced(new THREE.SphereGeometry(1, 5, 4), new THREE.MeshBasicMaterial({ color: INK, toneMapped: false }), GORE.drops, 'Ink drops')
    this.splatMesh = instanced(splatGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), GORE.splats, 'Ink splats')
    this.splatMesh.setColorAt(0, INK)
    this.splatMesh.renderOrder = 1
    const texture = splash()
    for (let i = 0; i < GORE.bursts; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false }))
      sprite.name = 'Ink pop'
      sprite.visible = false
      sprite.renderOrder = 13
      sprite.userData.noCollision = true
      this.spare.push(sprite)
      this.root.add(sprite)
    }
    this.root.add(...this.pieceMeshes, this.chunkMesh, this.dropMesh, this.splatMesh)
    scene.add(this.root)
  }

  /** How much gore is in flight or on the ground (for checks). */
  get counts() { return { pieces: this.pieces.length, chunks: this.chunks.length, drops: this.drops.length, splats: this.splats.length, bursts: this.bursts.length } }

  // ---------------------------------------------------------------- emitting

  /** The camera-facing ink splash that sells a pop. */
  pop(at: THREE.Vector3, size: number, life = 0.32) {
    const sprite = this.spare.pop() ?? this.bursts.shift()?.sprite
    if (!sprite) return
    sprite.position.copy(at)
    sprite.material.rotation = Math.random() * Math.PI * 2
    sprite.material.opacity = 1
    sprite.visible = true
    this.bursts.push({ sprite, age: 0, size, life })
  }

  /** Ink thrown from `at`, mostly along `direction` and upward. */
  spray(at: THREE.Vector3, direction: THREE.Vector3, count: number, floor: number, speed = 3.2, marks = true) {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(1.3)
        .addScaledVector(direction, i % 4 === 0 ? -0.4 : 0.9).normalize().multiplyScalar(speed * (0.45 + Math.random() * 0.8))
      v.y += 1 + Math.random() * 1.6
      this.drops.push({ position: at.clone(), velocity: v, radius: 0.014 + Math.random() * 0.026, floor, age: 0, marks: marks && Math.random() < 0.4 })
    }
    if (this.drops.length > GORE.drops) this.drops.splice(0, this.drops.length - GORE.drops)
  }

  /** Lumps of ink flung from `at`: they arc, land, leave a splat and melt away. */
  fling(at: THREE.Vector3, direction: THREE.Vector3, count: number, floor: number, size = 1, speed = 3.5, spread = 1) {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 2 * spread, 0, (Math.random() - 0.5) * 2 * spread)
        .addScaledVector(direction, 0.6 + Math.random() * 0.6).setY(0)
      v.normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8))
      v.y = 2.2 + Math.random() * 3.2 * Math.min(1.4, speed / 3.5)
      this.chunks.push({ position: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12)),
        velocity: v, spin: new THREE.Vector3(Math.random() * 14 - 7, Math.random() * 14 - 7, Math.random() * 14 - 7),
        rotation: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        floor, size: size * (0.035 + Math.random() * 0.05), age: 0, life: 2.4 + Math.random() * 1.6, landed: false })
    }
    if (this.chunks.length > GORE.chunks) this.chunks.splice(0, this.chunks.length - GORE.chunks)
  }

  /** A splat on the floor at `at` (its y is the floor), growing to `size` metres across. */
  splat(at: THREE.Vector3, size: number) {
    this.splats.push({ position: at.clone(), angle: Math.random() * Math.PI * 2, size: size * 0.5, grow: size, age: 0 })
    if (this.splats.length > GORE.splats) this.splats.shift()
  }

  /**
   * A headshot kill: the head bursts. A pop of ink where it was, chunks and a spray thrown on along the
   * bullet, a splat under it, and the neck spurting for a moment as the body goes down.
   */
  headPop(head: THREE.Vector3, direction: THREE.Vector3, floor: number, neck?: THREE.Object3D, scale = 1) {
    this.pop(head, 1.15 * scale, 0.34)
    this.fling(head, direction, 7, floor, scale, 3.2, 0.9)
    this.spray(head, direction, 34, floor, 3.6)
    this.splat(new THREE.Vector3(head.x, floor, head.z).addScaledVector(direction.clone().setY(0).normalize(), 0.6), 0.55 * scale)
    if (neck) {
      this.spurts.push({ bone: neck, floor, age: 0, next: 0, scale })
      if (this.spurts.length > 8) this.spurts.shift()
    }
  }

  /**
   * A limb comes off: a stand-in arm or leg starts exactly where the lost one was (the bone's own world
   * transform), is thrown along `velocity`, tumbles, bounces once and lies there.
   */
  limb(kind: 'arm' | 'leg', bone: THREE.Object3D, velocity: THREE.Vector3, floor: number, scale = 1) {
    bone.updateWorldMatrix(true, false)
    const position = bone.getWorldPosition(new THREE.Vector3())
    const quaternion = bone.getWorldQuaternion(new THREE.Quaternion())
    const type = kind === 'arm' ? 0 : 1
    const same = this.pieces.filter(p => p.kind === type)
    if (same.length >= GORE.pieces) this.pieces.splice(this.pieces.indexOf(same[0]), 1)
    this.pieces.push({ kind: type, position, velocity: velocity.clone(), quaternion,
      spin: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 6 - 3, Math.random() * 10 - 5),
      floor, scale, age: 0, landed: -1, bounced: false, lie: null })
    const torn = position.clone()
    this.spray(torn, velocity.clone().normalize(), 14, floor, 2.4)
    this.fling(torn, velocity.clone().normalize(), 2, floor, scale * 0.8, 2.2)
  }

  /** A body blown apart: a big pop, a shower of chunks and ink, splats all round. */
  gib(centre: THREE.Vector3, outward: THREE.Vector3, floor: number, scale = 1) {
    this.pop(centre, 1.5 * scale, 0.4)
    this.fling(centre, outward, 16, floor, scale * 1.5, 5, 1.2)
    this.spray(centre, outward, 46, floor, 4.6)
    this.splat(new THREE.Vector3(centre.x, floor, centre.z), 0.9 * scale)
  }

  /** One drop of ink falling off a Blot's belly. */
  drip(at: THREE.Vector3, floor: number) {
    this.drops.push({ position: at.clone(), velocity: new THREE.Vector3((Math.random() - 0.5) * 0.3, -0.2, (Math.random() - 0.5) * 0.3),
      radius: 0.02 + Math.random() * 0.015, floor, age: 0, marks: true })
    if (this.drops.length > GORE.drops) this.drops.shift()
  }

  // ---------------------------------------------------------------- frame

  update(dt: number) {
    const delta = Math.min(dt, 0.05)
    if (delta <= 0) return
    this.updateSpurts(delta)
    this.updatePieces(delta)
    this.updateChunks(delta)
    this.updateDrops(delta)
    this.updateSplats(delta)
    this.updateBursts(delta)
  }

  private updateSpurts(delta: number) {
    this.spurts = this.spurts.filter(spurt => {
      spurt.age += delta
      spurt.next -= delta
      if (spurt.next <= 0 && spurt.bone.parent) {
        spurt.next = 0.06
        // Pulsing: strong at first, weaker with every beat.
        const strength = 1 - spurt.age / 1.1
        spurt.bone.updateWorldMatrix(true, false)
        const at = spurt.bone.localToWorld(this.point.set(0, 0.1, 0)).clone()
        const up = this.axis.set(0, 1, 0).applyQuaternion(spurt.bone.getWorldQuaternion(this.quaternion)).clone()
        this.spray(at, up, 3, spurt.floor, 1.6 + 2 * strength * spurt.scale, Math.random() < 0.5)
      }
      return spurt.age < 1.1
    })
  }

  private updatePieces(delta: number) {
    const counts = [0, 0]
    this.pieces = this.pieces.filter(piece => { piece.age += delta; return this.stepPiece(piece, delta) })
    for (const piece of this.pieces) {
      const mesh = this.pieceMeshes[piece.kind]
      let sink = 0, shrink = 1
      if (piece.landed >= 0 && piece.landed > GORE.pieceLie) {
        const k = Math.min(1, (piece.landed - GORE.pieceLie) / GORE.pieceSink)
        sink = k * 0.18 * piece.scale; shrink = 1 - 0.5 * k
      }
      this.point.copy(piece.position); this.point.y -= sink
      mesh.setMatrixAt(counts[piece.kind]++, this.matrix.compose(this.point, piece.quaternion, this.scale.setScalar(piece.scale * shrink)))
    }
    for (const kind of [0, 1] as const) finish(this.pieceMeshes[kind], counts[kind])
  }

  /** Move one torn-off limb; false once it has sunk away. */
  private stepPiece(piece: Piece, delta: number) {
    const length = PIECE_LENGTH[piece.kind] * piece.scale, radius = PIECE_RADIUS[piece.kind] * piece.scale
    if (piece.landed >= 0) {
      piece.landed += delta
      if (piece.lie) piece.quaternion.slerp(piece.lie, 1 - Math.exp(-delta * 14))
      return piece.landed < GORE.pieceLie + GORE.pieceSink
    }
    piece.velocity.y -= GRAVITY * delta
    piece.position.addScaledVector(piece.velocity, delta)
    const angle = piece.spin.length() * delta
    if (angle > 1e-6) piece.quaternion.premultiply(this.turn.setFromAxisAngle(this.axis.copy(piece.spin).normalize(), angle))
    // Its lowest end touching the floor: bounce once, then settle lying flat.
    const along = this.axis.set(0, 1, 0).applyQuaternion(piece.quaternion)
    const lowest = Math.min(piece.position.y, piece.position.y + along.y * length) - radius
    if (lowest > piece.floor || piece.velocity.y > 0) return true
    if (!piece.bounced && piece.velocity.y < -2.5) {
      piece.bounced = true
      piece.velocity.set(piece.velocity.x * 0.45, -piece.velocity.y * 0.28, piece.velocity.z * 0.45)
      piece.spin.multiplyScalar(0.5)
      piece.position.y += piece.floor - lowest
      this.splat(new THREE.Vector3(piece.position.x, piece.floor, piece.position.z), 0.28 * piece.scale)
      return true
    }
    piece.landed = 0
    piece.velocity.set(0, 0, 0)
    piece.position.y = piece.floor + radius
    // Lying down: the same heading, its long axis turned level.
    const level = along.clone().setY(0)
    if (level.lengthSq() < 1e-4) level.set(1, 0, 0)
    piece.lie = new THREE.Quaternion().setFromUnitVectors(along.clone().normalize(), level.normalize()).multiply(piece.quaternion)
    return true
  }

  private updateChunks(delta: number) {
    this.chunks = this.chunks.filter(chunk => (chunk.age += delta) < chunk.life)
    this.chunks.forEach((chunk, i) => {
      if (!chunk.landed) {
        chunk.velocity.y -= GRAVITY * delta
        chunk.position.addScaledVector(chunk.velocity, delta)
        chunk.rotation.x += chunk.spin.x * delta; chunk.rotation.y += chunk.spin.y * delta; chunk.rotation.z += chunk.spin.z * delta
        if (chunk.position.y - chunk.size * 0.6 <= chunk.floor && chunk.velocity.y < 0) {
          chunk.landed = true
          chunk.position.y = chunk.floor + chunk.size * 0.45
          // It lands as a splat and flattens into it.
          this.splat(new THREE.Vector3(chunk.position.x, chunk.floor, chunk.position.z), chunk.size * 2.6)
          chunk.life = Math.min(chunk.life, chunk.age + 0.9)
        }
      }
      const flat = chunk.landed ? 1 - smooth(chunk.age, chunk.life - 0.9, chunk.life) : 1
      this.scale.set(chunk.size, chunk.size * (chunk.landed ? 0.35 + 0.65 * flat : 1), chunk.size).multiplyScalar(chunk.landed ? 0.4 + 0.6 * flat : 1)
      this.chunkMesh.setMatrixAt(i, this.matrix.compose(chunk.position, this.quaternion.setFromEuler(chunk.rotation), this.scale))
    })
    finish(this.chunkMesh, this.chunks.length)
  }

  private updateDrops(delta: number) {
    const up = this.axis.set(0, 1, 0)
    let n = 0
    this.drops = this.drops.filter(drop => {
      drop.age += delta
      drop.velocity.y -= GRAVITY * delta
      drop.position.addScaledVector(drop.velocity, delta)
      if (drop.position.y <= drop.floor) {
        if (drop.marks) this.splat(new THREE.Vector3(drop.position.x, drop.floor, drop.position.z), drop.radius * 3)
        return false
      }
      return drop.age < 2.5
    })
    for (const drop of this.drops) {
      const speed = drop.velocity.length(), stretch = 1 + Math.min(speed * 0.22, 1.8)
      this.quaternion.setFromUnitVectors(up, this.point.copy(drop.velocity).divideScalar(speed || 1))
      this.scale.set(drop.radius / Math.sqrt(stretch), drop.radius * stretch, drop.radius / Math.sqrt(stretch))
      this.dropMesh.setMatrixAt(n++, this.matrix.compose(drop.position, this.quaternion, this.scale))
    }
    finish(this.dropMesh, n)
  }

  private updateSplats(delta: number) {
    this.splats = this.splats.filter(splat => (splat.age += delta) < GORE.splatLife)
    this.splats.forEach((splat, i) => {
      const size = THREE.MathUtils.lerp(splat.size, splat.grow, 1 - Math.exp(-splat.age * 14))
      this.point.copy(splat.position).setY(splat.position.y + 0.008 + (i % 6) * 0.0012)
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, splat.angle)
      this.splatMesh.setMatrixAt(i, this.matrix.compose(this.point, this.quaternion, this.scale.set(size, 1, size)))
      this.splatMesh.setColorAt(i, this.color.copy(INK).lerp(PAPER, smooth(splat.age, GORE.splatLife - 4, GORE.splatLife)))
    })
    finish(this.splatMesh, this.splats.length)
  }

  private updateBursts(delta: number) {
    this.bursts = this.bursts.filter(burst => {
      burst.age += delta
      const t = burst.age / burst.life
      if (t >= 1) { burst.sprite.visible = false; this.spare.push(burst.sprite); return false }
      // Bang out to full size in a few frames, then eaten away.
      burst.sprite.scale.setScalar(burst.size * (0.35 + 0.65 * (1 - (1 - Math.min(1, burst.age / 0.06)) ** 3)))
      burst.sprite.material.opacity = 1 - smooth(t, 0.45, 1)
      return true
    })
  }

  clear() {
    this.pieces = []; this.chunks = []; this.drops = []; this.splats = []; this.spurts = []
    for (const burst of this.bursts) { burst.sprite.visible = false; this.spare.push(burst.sprite) }
    this.bursts = []
    for (const mesh of [...this.pieceMeshes, this.chunkMesh, this.dropMesh, this.splatMesh]) finish(mesh, 0)
  }

  dispose() {
    this.clear()
    this.root.removeFromParent()
    for (const mesh of [...this.pieceMeshes, this.chunkMesh, this.dropMesh, this.splatMesh]) {
      mesh.geometry.dispose(); mesh.dispose()
    }
    ;(this.pieceMeshes[0].material as THREE.Material).dispose()
    for (const mesh of [this.chunkMesh, this.dropMesh, this.splatMesh]) (mesh.material as THREE.Material).dispose()
    for (const sprite of this.spare) sprite.material.dispose()
  }
}

function finish(mesh: THREE.InstancedMesh, count: number) {
  mesh.count = count
  mesh.visible = count > 0
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}
