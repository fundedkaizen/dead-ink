import * as THREE from 'three'
import { Draft, wallText } from '../../render/ink'

/**
 * Dead Ink's main quest, "The Last Edition", in the manner of Black Ops 3's main Easter eggs: a chain of
 * steps across the whole map that ends in a boss fight and a finale.
 *
 * 1. Turn on the power.  2. Build the Pack-a-Punch.
 * 3. Three inkwells wake up across the compound. Zombies that die near one send their ink flying into it
 *    (Call of Duty's soul boxes); a full well leaves a bottle of ink.
 * 4. Pour the three bottles into the Pack-a-Punch.
 * 5. The Editor, a giant Brute, climbs out by the machine. Kill it and the edition is printed.
 */
export type QuestStep = 'power' | 'pack' | 'wells' | 'pour' | 'editor' | 'done'
type Place = [number, number, number]

export const QUEST = {
  souls: 15, soulRadius: 7, soulFlight: 1.25,
  /** The Editor: the Brute's health for the round, times this. */
  editorHealth: 3,
  editorDelay: 3,
} as const

/** The inkwells: the southwest yard, the rail yard, the east annex. */
export const INKWELL_PLACES: readonly Place[] = [[-44, 0, 36], [62, 0, -24], [126, 0, 4]]

/** What the quest line on the HUD says at each step. */
export function questHint(step: QuestStep, detail: { souls?: number; bottles?: number } = {}) {
  switch (step) {
    case 'power': return 'Find the power switch'
    case 'pack': return 'Build the Pack-a-Punch'
    case 'wells': return `Feed the inkwells · ${detail.souls ?? 0}/${QUEST.souls * INKWELL_PLACES.length}${detail.bottles ? ` · ${detail.bottles} bottle${detail.bottles === 1 ? '' : 's'}` : ''}`
    case 'pour': return 'Pour the ink into the Pack-a-Punch'
    case 'editor': return 'Kill the Editor'
    case 'done': return null
  }
}

const ink = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
const glass = new THREE.MeshBasicMaterial({ color: 0xdcefe3, toneMapped: false })

/**
 * An inkwell: a stone pedestal with a wide bowl. Dormant, it is dry; awake, black ink swirls in it and
 * rises with every soul; full, it overflows and a bottle of ink stands on its rim for you to take.
 */
export class Inkwell {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  souls = 0
  awake = false
  bottleTaken = false
  private surface: THREE.Mesh
  private swirl: THREE.Mesh
  private bottle: THREE.Group
  private pulse = 0
  private time = Math.random() * 10

  constructor(at: THREE.Vector3) {
    this.root.name = 'Inkwell'
    this.root.userData.noCollision = true
    this.root.position.copy(at)
    const stone = new Draft('Inkwell pedestal')
    stone.cylinder(0.28, 0.8, 0, 0.4, 0, 'paper', 0.22)
    stone.cylinder(0.55, 0.22, 0, 0.91, 0, 'paper', 0.62)
    stone.ring(0.62, 1.02, 0, 0, 'edge', 48)
    stone.hatch([-0.25, 0.1, 0.285], [0.5, 0, 0], [0, 0.55, 0], { spacing: 0.06 })
    stone.finish()
    this.root.add(stone)
    this.surface = new THREE.Mesh(new THREE.CircleGeometry(0.54, 32), ink)
    this.surface.rotation.x = -Math.PI / 2
    this.surface.position.y = 0.84
    this.surface.visible = false
    this.swirl = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.4, 32, 1, 0, Math.PI * 1.2), new THREE.MeshBasicMaterial({ color: 0x5a5a5a, transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false }))
    this.swirl.rotation.x = -Math.PI / 2
    this.swirl.visible = false
    this.root.add(this.surface, this.swirl)
    // The bottle of ink a full well leaves on its rim.
    this.bottle = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.2, 14), glass)
    const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.15, 14), ink)
    fill.position.y = -0.02
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.08, 10), glass)
    neck.position.y = 0.14
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.096, 0.22, 14), new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false }))
    this.bottle.add(rim, body, fill, neck)
    this.bottle.position.set(0.4, 1.14, 0)
    this.bottle.visible = false
    this.root.add(this.bottle)
    this.root.add(wallText('FEED ME', [0, 1.75, 0], 0.2))
    this.root.children[this.root.children.length - 1].visible = false
    this.point = at.clone().setY(at.y + 1.1)
  }

  get full() { return this.souls >= QUEST.souls }
  /** A bottle stands on the rim, waiting to be taken. */
  get bottleWaiting() { return this.full && !this.bottleTaken }

  wake() {
    this.awake = true
    this.surface.visible = true
    this.swirl.visible = true
    this.root.children[this.root.children.length - 1].visible = true
  }

  addSoul() {
    if (!this.awake || this.full) return false
    this.souls++
    this.pulse = 0.4
    if (this.full) { this.bottle.visible = true; this.root.children[this.root.children.length - 1].visible = false }
    return true
  }

  takeBottle() {
    if (!this.bottleWaiting) return false
    this.bottleTaken = true
    this.bottle.visible = false
    return true
  }

  reset() {
    this.souls = 0; this.awake = false; this.bottleTaken = false; this.pulse = 0
    this.surface.visible = false; this.swirl.visible = false; this.bottle.visible = false
    this.root.children[this.root.children.length - 1].visible = false
  }

  update(dt: number) {
    this.time += dt
    if (!this.awake) return
    this.pulse = Math.max(0, this.pulse - dt)
    // The ink rises from the bottom of the bowl to its brim as the souls come in.
    const level = 0.84 + 0.14 * Math.min(1, this.souls / QUEST.souls)
    this.surface.position.y = level
    this.swirl.position.y = level + 0.005
    this.swirl.rotation.z += dt * (this.full ? 0.6 : 2.2)
    const bob = 1 + this.pulse * 0.6
    this.surface.scale.setScalar(bob)
    if (this.bottle.visible) this.bottle.rotation.y += dt * 1.2
  }

  dispose() {
    this.root.removeFromParent()
    // Only what this well made: the pedestal's ink drawing shares its materials with the whole map.
    for (const mesh of [this.surface, this.swirl]) mesh.geometry.dispose()
    ;(this.swirl.material as THREE.Material).dispose()
    this.bottle.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
  }
}

/** The ink of a zombie killed near a well, flying to it in an arc: pooled black blobs with a tail. */
/** A soul's brush stroke: points sampled back along its own path (so it looks the same at any frame rate). */
const SOUL = { points: 28, spacing: 0.016, width: 0.15, head: 0.14 } as const

type Soul = {
  head: THREE.Mesh; stroke: THREE.Mesh; positions: THREE.BufferAttribute
  from: THREE.Vector3; c1: THREE.Vector3; c2: THREE.Vector3; to: THREE.Vector3
  /** How far along, 0 to 1, and past 1 while the stroke drains into the well after the head. */
  t: number; seed: number; target: Inkwell | null
}

/**
 * Souls on their way to an inkwell, drawn as Call of Duty draws them into its soul boxes: a wisp of ink
 * tears out of the body, climbs, swings round in a wide arc and spirals down into the well, dragging a
 * long brush stroke that thins to nothing. Big and slow enough to follow across a yard.
 */
export class SoulStreams {
  private live: Soul[] = []
  private pool: Soul[] = []
  private headGeometry = new THREE.SphereGeometry(SOUL.head, 12, 10)
  private strokeMaterial = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false, side: THREE.DoubleSide })
  private point = new THREE.Vector3()
  private behind = new THREE.Vector3()
  private side = new THREE.Vector3()
  private view = new THREE.Vector3()

  constructor(private scene: THREE.Scene) {}

  emit(from: THREE.Vector3, well: Inkwell) {
    const soul = this.pool.pop() ?? this.make()
    soul.from.copy(from)
    soul.to.copy(well.point).setY(well.point.y - 0.15)
    // A wide arc: up out of the body, round to one side, and down onto the well from above.
    const across = this.side.set(soul.to.z - from.z, 0, from.x - soul.to.x)
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0)
    across.normalize().multiplyScalar((Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.4))
    soul.c1.copy(from).add(across).setY(from.y + 2.4 + Math.random())
    soul.c2.copy(soul.to).addScaledVector(across, 0.5).setY(soul.to.y + 3.2)
    soul.t = 0; soul.seed = Math.random() * 100; soul.target = well
    soul.head.visible = true
    this.place(soul, 0, soul.head.position)
    this.scene.add(soul.head, soul.stroke)
    this.live.push(soul)
  }

  /** Move them; returns the wells whose soul arrived this frame. */
  update(dt: number, camera: THREE.Camera): Inkwell[] {
    const arrived: Inkwell[] = []
    const drain = SOUL.points * SOUL.spacing
    for (let n = this.live.length - 1; n >= 0; n--) {
      const soul = this.live[n]
      const before = soul.t
      soul.t += dt / QUEST.soulFlight
      if (before < 1 && soul.t >= 1) {
        if (soul.target) arrived.push(soul.target)
        soul.head.visible = false
      }
      if (soul.t >= 1 + drain) { this.release(soul, n); continue }
      if (soul.t < 1) {
        this.place(soul, soul.t, soul.head.position)
        soul.head.scale.setScalar(1 + Math.sin(Math.PI * soul.t) * 0.45)
      }
      this.draw(soul, camera)
    }
    return arrived
  }

  /** Where a soul is `k` of the way: an eased cubic curve, a little life, and a tightening spiral at the end. */
  private place(soul: Soul, k: number, out: THREE.Vector3) {
    k = Math.min(1, Math.max(0, k))
    const e = k * k * (3 - 2 * k), u = 1 - e
    out.copy(soul.from).multiplyScalar(u * u * u)
      .addScaledVector(soul.c1, 3 * u * u * e).addScaledVector(soul.c2, 3 * u * e * e).addScaledVector(soul.to, e * e * e)
    const swirl = Math.sin(Math.PI * Math.min(1, Math.max(0, (k - 0.55) / 0.45))) * 0.55, angle = soul.seed + k * 16
    out.x += Math.cos(angle) * swirl; out.z += Math.sin(angle) * swirl
    out.y += Math.sin(soul.seed * 3 + k * 23) * 0.07 * (1 - k)
    return out
  }

  /** The brush stroke: a ribbon along the path just flown, turned to the camera, thinning to a point. */
  private draw(soul: Soul, camera: THREE.Camera) {
    const array = soul.positions.array as Float32Array
    for (let i = 0; i < SOUL.points; i++) {
      const k = soul.t - i * SOUL.spacing
      this.place(soul, k, this.point)
      this.place(soul, k - SOUL.spacing, this.behind)
      this.behind.subVectors(this.point, this.behind)
      this.view.subVectors(camera.position, this.point)
      this.side.crossVectors(this.behind, this.view)
      const length = this.side.length()
      const width = k <= 0 ? 0 : SOUL.width * Math.pow(1 - i / (SOUL.points - 1), 0.8)
      if (length > 1e-6) this.side.multiplyScalar(width / length); else this.side.set(0, 0, 0)
      array[i * 6] = this.point.x + this.side.x; array[i * 6 + 1] = this.point.y + this.side.y; array[i * 6 + 2] = this.point.z + this.side.z
      array[i * 6 + 3] = this.point.x - this.side.x; array[i * 6 + 4] = this.point.y - this.side.y; array[i * 6 + 5] = this.point.z - this.side.z
    }
    soul.positions.needsUpdate = true
  }

  private make(): Soul {
    const head = new THREE.Mesh(this.headGeometry, ink)
    const geometry = new THREE.BufferGeometry()
    const positions = new THREE.BufferAttribute(new Float32Array(SOUL.points * 6), 3)
    positions.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positions)
    const index: number[] = []
    for (let i = 0; i < SOUL.points - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    geometry.setIndex(index)
    const stroke = new THREE.Mesh(geometry, this.strokeMaterial)
    // Rebuilt every frame from the path: its bounds never hold still, so never cull it.
    stroke.frustumCulled = false
    head.userData.noCollision = stroke.userData.noCollision = true
    return { head, stroke, positions, from: new THREE.Vector3(), c1: new THREE.Vector3(), c2: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, seed: 0, target: null }
  }

  private release(soul: Soul, n: number) {
    soul.head.removeFromParent(); soul.stroke.removeFromParent()
    soul.target = null
    this.live.splice(n, 1)
    this.pool.push(soul)
  }

  clear() { for (let n = this.live.length - 1; n >= 0; n--) this.release(this.live[n], n) }
  dispose() {
    this.clear()
    this.headGeometry.dispose(); this.strokeMaterial.dispose()
    for (const soul of this.pool) soul.stroke.geometry.dispose()
  }
}
