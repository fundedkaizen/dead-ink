import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import { CANNON_INK, CANNON_INK_PACKED } from '../../lab/weapons/models/cannon'

/**
 * The Ink Cannon, Dead Ink's second wonder weapon. Hold the trigger to charge, let go to lob a heavy blob of
 * ink in an arc; it bursts on the first thing it touches (a zombie, a wall, the ground) and every zombie in
 * the burst melts into a splashing puddle. The Pack-a-Punched Ink Deluge bursts wider and leaves a sticky
 * pool that holds zombies to a crawl for a few seconds.
 *
 * Pure numbers (cannonShot, cannonDamage) are checked in Node; InkBlobs and InkPools draw and step it.
 */
export const INK_CANNON = {
  /** Launch speed, m/s, from a tap to a full charge; a charged blob flies flatter and further. */
  speed: { tap: 13, full: 27 },
  /** The lob: extra lift added to the aim, and gravity (lighter than a stone's, it is ink). */
  loft: 0.16, gravity: 12,
  /** Burst radius, m, from a tap to full; the Deluge's is this much wider. */
  radius: { tap: 2.6, full: 4.2 }, packedRadius: 1.35,
  /**
   * Damage in zombie healths at this round: a tap kills anything ordinary at its centre, a full charge
   * anything in the burst (the burst falls off to half at its edge). Never less than `floor`. The Deluge
   * hits twice as hard. The Brute takes it as a heavy blow, nothing more.
   */
  damage: { tap: 2.2, full: 4.2 }, floor: 1500, packedDamage: 2,
  /** A blob that has hit nothing after this long bursts where it is. */
  life: 4,
  /** Standing too close to your own burst stings. */
  selfRadius: 2.4, selfDamage: 35,
  /** The Deluge's sticky pool: how long it lasts, how wide (a share of the burst), and the speed zombies keep in it. */
  pool: { seconds: 7, share: 0.85, slow: 0.35 },
} as const

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

/** What a shot at this charge does: its launch speed, its burst radius, its damage in zombie healths. */
export function cannonShot(charge: number, packed = false) {
  const c = clamp01(charge)
  return {
    speed: lerp(INK_CANNON.speed.tap, INK_CANNON.speed.full, c),
    radius: lerp(INK_CANNON.radius.tap, INK_CANNON.radius.full, c) * (packed ? INK_CANNON.packedRadius : 1),
    healths: lerp(INK_CANNON.damage.tap, INK_CANNON.damage.full, c) * (packed ? INK_CANNON.packedDamage : 1),
  }
}

/** The burst's damage at its centre: `zombieHealth` is one zombie's health this round (difficulty included). */
export function cannonDamage(zombieHealth: number, charge: number, packed = false) {
  return Math.max(INK_CANNON.floor * (packed ? INK_CANNON.packedDamage : 1), zombieHealth * cannonShot(charge, packed).healths)
}

/** A blob's velocity out of the muzzle: along the aim, lifted a little, at the charge's speed. */
export function launchVelocity(direction: THREE.Vector3, charge: number, packed = false, out = new THREE.Vector3()) {
  return out.copy(direction).normalize().add(new THREE.Vector3(0, INK_CANNON.loft, 0)).normalize().multiplyScalar(cannonShot(charge, packed).speed)
}

export type CannonBurst = { at: THREE.Vector3; charge: number; packed: boolean; radius: number; remote: boolean }

type Blob = { root: THREE.Group; velocity: THREE.Vector3; age: number; charge: number; packed: boolean; remote: boolean; drip: number }
type Drop = { mesh: THREE.Mesh; velocity: THREE.Vector3; age: number; life: number }
type Ring = { mesh: THREE.Mesh; age: number; life: number; size: number }

const colourOf = (packed: boolean) => packed ? CANNON_INK_PACKED : CANNON_INK

/**
 * Blobs in flight: a wobbling ball of ink drawn with a black outline, dripping as it goes, squashed along
 * its flight. `bodies` answers the distance along a ray to the nearest zombie, as the director measures it.
 */
export class InkBlobs {
  private blobs: Blob[] = []
  private drops: Drop[] = []
  private rings: Ring[] = []
  private ball = new THREE.SphereGeometry(0.16, 16, 12)
  private shell = new THREE.SphereGeometry(0.175, 16, 12)
  private dropGeometry = new THREE.SphereGeometry(0.045, 8, 6)
  private ringGeometry = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2)
  private outline = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, side: THREE.BackSide, toneMapped: false })
  private ink = new Map<boolean, THREE.MeshBasicMaterial>()
  private splash = new Map<boolean, THREE.MeshBasicMaterial>()

  constructor(private scene: THREE.Scene, private world: CollisionWorld,
    private bodies: (origin: THREE.Vector3, direction: THREE.Vector3, max: number) => number) {}

  private inkOf(packed: boolean) {
    let material = this.ink.get(packed)
    if (!material) { material = new THREE.MeshBasicMaterial({ color: colourOf(packed), toneMapped: false }); this.ink.set(packed, material) }
    return material
  }

  /** `remote`: a teammate's blob, drawn and burst here for the look only (the host does the damage). */
  fire(origin: THREE.Vector3, direction: THREE.Vector3, charge: number, packed = false, remote = false) {
    const root = new THREE.Group()
    root.name = 'Ink Cannon blob'
    root.userData.noCollision = true
    const ball = new THREE.Mesh(this.ball, this.inkOf(packed))
    const shell = new THREE.Mesh(this.shell, this.outline)
    root.add(ball, shell)
    const size = 0.8 + 0.5 * clamp01(charge)
    root.scale.setScalar(size)
    root.userData.size = size
    root.position.copy(origin)
    this.scene.add(root)
    this.blobs.push({ root, velocity: launchVelocity(direction, charge, packed), age: 0, charge: clamp01(charge), packed, remote, drip: 0 })
  }

  /** Step the blobs; returns where they burst this frame. */
  update(dt: number): CannonBurst[] {
    const bursts: CannonBurst[] = []
    const step = Math.min(dt, 0.05)
    for (const blob of [...this.blobs]) {
      blob.age += step
      blob.velocity.y -= INK_CANNON.gravity * step
      const move = blob.velocity.clone().multiplyScalar(step), length = move.length()
      const from = blob.root.position, direction = move.clone().normalize()
      const wall = length > 0 ? this.world.raySurface(from, direction, length + 0.12) : null
      const body = blob.remote || length <= 0 ? Infinity : this.bodies(from, direction, length + 0.15)
      const reach = Math.min(wall?.distance ?? Infinity, body < length + 0.15 ? body : Infinity)
      if (reach < Infinity || blob.age > INK_CANNON.life) {
        const at = from.clone().addScaledVector(direction, Math.max(0, Math.min(reach, length) - 0.05))
        bursts.push({ at, charge: blob.charge, packed: blob.packed, radius: cannonShot(blob.charge, blob.packed).radius, remote: blob.remote })
        this.splashAt(at, blob.packed, cannonShot(blob.charge, blob.packed).radius)
        this.remove(blob)
        continue
      }
      from.add(move)
      // Wobble, and stretch along the flight.
      const size = blob.root.userData.size as number
      const wob = 1 + 0.12 * Math.sin(blob.age * 26)
      blob.root.scale.set(size * wob, size / wob, size * (1 + Math.min(0.5, blob.velocity.length() * 0.012)))
      blob.root.lookAt(from.clone().add(blob.velocity))
      // A trail of drops falling off it.
      if ((blob.drip -= step) <= 0) {
        blob.drip = 0.035
        this.drop(from, blob.velocity.clone().multiplyScalar(0.25).add(new THREE.Vector3((Math.random() - 0.5), 0, (Math.random() - 0.5))), blob.packed, 0.6)
      }
    }
    for (const drop of [...this.drops]) {
      drop.age += step
      drop.velocity.y -= 9.8 * step
      drop.mesh.position.addScaledVector(drop.velocity, step)
      drop.mesh.scale.setScalar(Math.max(0.01, 1 - drop.age / drop.life))
      if (drop.age >= drop.life) { drop.mesh.removeFromParent(); this.drops.splice(this.drops.indexOf(drop), 1) }
    }
    for (const ring of [...this.rings]) {
      ring.age += step
      const t = ring.age / ring.life
      ring.mesh.scale.setScalar(ring.size * (0.2 + 0.8 * (1 - (1 - t) ** 3)))
      ;(ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t)
      if (ring.age >= ring.life) { ring.mesh.removeFromParent(); this.rings.splice(this.rings.indexOf(ring), 1) }
    }
    return bursts
  }

  /** The burst's look: a ring of ink racing out over the ground and a shower of coloured drops. */
  splashAt(at: THREE.Vector3, packed: boolean, radius: number) {
    let material = this.splash.get(packed)
    if (!material) {
      material = new THREE.MeshBasicMaterial({ color: colourOf(packed), transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
      this.splash.set(packed, material)
    }
    const floor = this.world.floor(at.clone().setY(at.y + 0.5), 0.2, 3)
    const mesh = new THREE.Mesh(this.ringGeometry, material.clone())
    mesh.position.set(at.x, (Number.isFinite(floor) ? floor : at.y) + 0.04, at.z)
    mesh.userData.noCollision = true
    this.scene.add(mesh)
    this.rings.push({ mesh, age: 0, life: 0.55, size: radius })
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, out = 2 + Math.random() * 4
      this.drop(at, new THREE.Vector3(Math.cos(a) * out, 3 + Math.random() * 4, Math.sin(a) * out), packed, 0.9 + Math.random() * 0.5)
    }
    while (this.drops.length > 160) { const old = this.drops.shift()!; old.mesh.removeFromParent() }
  }

  private drop(at: THREE.Vector3, velocity: THREE.Vector3, packed: boolean, life: number) {
    const mesh = new THREE.Mesh(this.dropGeometry, this.inkOf(packed))
    mesh.position.copy(at)
    mesh.userData.noCollision = true
    this.scene.add(mesh)
    this.drops.push({ mesh, velocity, age: 0, life })
  }

  get flying() { return this.blobs.length }

  private remove(blob: Blob) {
    blob.root.removeFromParent()
    this.blobs.splice(this.blobs.indexOf(blob), 1)
  }

  clear() {
    for (const blob of [...this.blobs]) this.remove(blob)
    for (const drop of this.drops) drop.mesh.removeFromParent()
    for (const ring of this.rings) { ring.mesh.removeFromParent(); (ring.mesh.material as THREE.Material).dispose() }
    this.drops = []; this.rings = []
  }

  dispose() {
    this.clear()
    for (const geometry of [this.ball, this.shell, this.dropGeometry, this.ringGeometry]) geometry.dispose()
    this.outline.dispose()
    for (const material of [...this.ink.values(), ...this.splash.values()]) material.dispose()
  }
}

type Pool = { mesh: THREE.Mesh; centre: THREE.Vector3; radius: number; left: number; seconds: number }

/**
 * The Ink Deluge's sticky pools: a glossy puddle on the floor with a ragged edge, drying out over a few
 * seconds. While it lasts, any zombie standing in it moves at `INK_CANNON.pool.slow` of its speed.
 */
export class InkPools {
  readonly pools: Pool[] = []
  private material = new THREE.MeshBasicMaterial({ color: CANNON_INK_PACKED, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  private edge = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })

  constructor(private scene: THREE.Scene | null) {}

  /** A pool at `at` (on the floor under it, `floor`), `radius` wide, for `seconds`. */
  add(at: THREE.Vector3, radius: number, seconds: number = INK_CANNON.pool.seconds, floor = at.y) {
    let mesh: THREE.Mesh
    if (this.scene) {
      // A ragged puddle: a circle whose rim wanders in and out, with a black inked rim just outside it.
      const shape = new THREE.Shape(), rim = new THREE.Shape(), n = 28, seed = Math.random() * 10
      for (let i = 0; i <= n; i++) {
        const a = i / n * Math.PI * 2, wobble = 1 + 0.12 * Math.sin(a * 3 + seed) + 0.07 * Math.sin(a * 7 + seed * 2)
        const x = Math.cos(a) * radius * wobble, y = Math.sin(a) * radius * wobble
        if (i) { shape.lineTo(x, y); rim.lineTo(x * 1.04, y * 1.04) } else { shape.moveTo(x, y); rim.moveTo(x * 1.04, y * 1.04) }
      }
      mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), this.material.clone())
      const border = new THREE.Mesh(new THREE.ShapeGeometry(rim).rotateX(-Math.PI / 2), this.edge.clone())
      border.position.y = -0.005
      mesh.add(border)
      mesh.position.set(at.x, floor + 0.03, at.z)
      mesh.userData.noCollision = true
      mesh.name = 'Ink Deluge pool'
      this.scene.add(mesh)
    } else mesh = new THREE.Mesh()
    this.pools.push({ mesh, centre: new THREE.Vector3(at.x, floor, at.z), radius, left: seconds, seconds })
  }

  /** The speed a body at `position` keeps: the pool's slow inside a live pool, else 1. */
  slowAt(position: THREE.Vector3) {
    for (const pool of this.pools) {
      if (pool.left <= 0 || Math.abs(position.y - pool.centre.y) > 1.2) continue
      if (Math.hypot(position.x - pool.centre.x, position.z - pool.centre.z) <= pool.radius) return INK_CANNON.pool.slow
    }
    return 1
  }

  update(dt: number) {
    for (const pool of [...this.pools]) {
      pool.left -= dt
      const fade = Math.min(1, Math.max(0, pool.left / 1.5))
      pool.mesh.traverse(o => { if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshBasicMaterial) o.material.opacity = (o === pool.mesh ? 0.8 : 0.9) * fade })
      if (pool.left <= 0) this.remove(pool)
    }
  }

  private remove(pool: Pool) {
    pool.mesh.removeFromParent()
    pool.mesh.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose?.() } })
    this.pools.splice(this.pools.indexOf(pool), 1)
  }

  clear() { for (const pool of [...this.pools]) this.remove(pool) }
  dispose() { this.clear(); this.material.dispose(); this.edge.dispose() }
}

/**
 * The Ink Cannon's charge under the crosshair: an ink ring that fills round as the shot charges, in the
 * cannon's ink (red for the Deluge), with a tick at full. Hidden unless the cannon is in your hands.
 */
export class ChargeMeter {
  readonly element = document.createElement('div')
  private arc: SVGCircleElement
  private shown = -1

  constructor(parent: HTMLElement) {
    this.element.className = 'ink-charge'
    this.element.hidden = true
    this.element.setAttribute('aria-hidden', 'true')
    this.element.innerHTML = '<svg viewBox="0 0 64 64"><circle class="ink-charge-track" cx="32" cy="32" r="26"/><circle class="ink-charge-fill" cx="32" cy="32" r="26" pathLength="100"/></svg>'
    this.arc = this.element.querySelector('.ink-charge-fill')!
    parent.append(this.element)
  }

  /** `charge` 0 to 1, or null to hide. */
  update(charge: number | null, packed: boolean) {
    this.element.hidden = charge === null
    if (charge === null) { this.shown = -1; return }
    const value = Math.round(charge * 100)
    if (value === this.shown) return
    this.shown = value
    this.element.classList.toggle('full', value >= 100)
    this.element.classList.toggle('packed', packed)
    this.arc.style.strokeDasharray = `${value} 100`
  }

  dispose() { this.element.remove() }
}
