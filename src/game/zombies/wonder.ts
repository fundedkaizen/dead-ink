import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'

/**
 * The Ink Ray's bolts: glowing green slugs that fly fast, not instantly, and burst on the first thing
 * they touch, a zombie or a wall. What the burst does belongs to the runtime.
 */
export const INK_RAY = { speed: 45, life: 3, radius: 3, selfRadius: 3, selfDamage: 40, boxWeight: 0.05,
  /** Call of Duty's numbers: the Ray Gun holds 20 with 160 spare; Porter's X2 holds 40 with 200. */
  magazine: 20, reserve: 160, packedReserve: 200,
  /** The X2's burst: wider, and twice the damage. */
  packedRadius: 3.8, packedDamage: 2 } as const
const GREEN = 0x46e05a
/** The X2's bolts are red, as Porter's X2 Ray Gun fires red. */
const RED = 0xd4332a

type Bolt = { mesh: THREE.Mesh; trail: THREE.Mesh; ring: THREE.Mesh; velocity: THREE.Vector3; age: number; packed: boolean }

export class InkRayBolts {
  private bolts: Bolt[] = []
  // A stretched green slug inside a pulsing ring of light, like Call of Duty's Ray Gun shot.
  private geometry = new THREE.SphereGeometry(0.07, 10, 8).scale(1, 1, 2.2)
  private ringGeometry = new THREE.TorusGeometry(0.11, 0.022, 8, 24)
  private ringMaterial = new THREE.MeshBasicMaterial({ color: 0xb8ffb0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  private trailGeometry = new THREE.CylinderGeometry(0.035, 0.005, 1, 8).rotateX(Math.PI / 2).translate(0, 0, -0.5)
  private material = new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false })
  private trailMaterial = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false })
  private packedMaterial = new THREE.MeshBasicMaterial({ color: RED, toneMapped: false })
  private packedTrailMaterial = new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false })
  private packedRingMaterial = new THREE.MeshBasicMaterial({ color: 0xffb0a8, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })

  constructor(private scene: THREE.Scene, private world: CollisionWorld,
    /** Distance along a ray to the nearest zombie body, as the director measures it. */
    private bodies: (origin: THREE.Vector3, direction: THREE.Vector3, max: number) => number) {}

  fire(origin: THREE.Vector3, direction: THREE.Vector3, packed = false) {
    const mesh = new THREE.Mesh(this.geometry, packed ? this.packedMaterial : this.material)
    const trail = new THREE.Mesh(this.trailGeometry, packed ? this.packedTrailMaterial : this.trailMaterial)
    const ring = new THREE.Mesh(this.ringGeometry, packed ? this.packedRingMaterial : this.ringMaterial)
    for (const m of [mesh, trail, ring]) { m.userData.noCollision = true; m.position.copy(origin); this.scene.add(m) }
    mesh.lookAt(origin.clone().add(direction))
    this.bolts.push({ mesh, trail, ring, velocity: direction.clone().normalize().multiplyScalar(INK_RAY.speed), age: 0, packed })
  }

  /** Returns where bolts burst this frame, and whether each came from the X2. */
  update(dt: number): { at: THREE.Vector3; packed: boolean }[] {
    const bursts: { at: THREE.Vector3; packed: boolean }[] = []
    for (const bolt of [...this.bolts]) {
      bolt.age += dt
      const step = bolt.velocity.length() * dt, direction = bolt.velocity.clone().normalize()
      const from = bolt.mesh.position
      const wall = this.world.raySurface(from, direction, step)
      // The body test answers `step` itself when no zombie is in the way: only a shorter answer is a hit.
      const body = this.bodies(from, direction, step)
      const reach = Math.min(wall?.distance ?? Infinity, body < step ? body : Infinity)
      if (reach < Infinity || bolt.age > INK_RAY.life) {
        bursts.push({ at: from.clone().addScaledVector(direction, Math.min(reach, step)), packed: bolt.packed })
        this.remove(bolt)
        continue
      }
      from.addScaledVector(direction, step)
      bolt.trail.position.copy(from)
      bolt.trail.lookAt(from.clone().add(direction))
      bolt.trail.scale.set(1, 1, Math.min(1.4, bolt.age * INK_RAY.speed))
      bolt.mesh.lookAt(from.clone().add(direction))
      bolt.ring.position.copy(from)
      bolt.ring.lookAt(from.clone().add(direction))
      const pulse = 1 + 0.25 * Math.sin(bolt.age * 40)
      bolt.ring.scale.set(pulse, pulse, 1)
    }
    return bursts
  }

  private remove(bolt: Bolt) {
    bolt.mesh.removeFromParent(); bolt.trail.removeFromParent(); bolt.ring.removeFromParent()
    this.bolts.splice(this.bolts.indexOf(bolt), 1)
  }

  clear() { for (const bolt of [...this.bolts]) this.remove(bolt) }
  dispose() {
    this.clear(); this.geometry.dispose(); this.trailGeometry.dispose(); this.ringGeometry.dispose()
    for (const material of [this.material, this.trailMaterial, this.ringMaterial, this.packedMaterial, this.packedTrailMaterial, this.packedRingMaterial]) material.dispose()
  }
}
