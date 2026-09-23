import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'

/**
 * The Ink Ray's bolts: glowing green slugs that fly fast, not instantly, and burst on the first thing
 * they touch, a zombie or a wall. What the burst does belongs to the runtime.
 */
export const INK_RAY = { speed: 45, life: 3, radius: 3, selfRadius: 3, selfDamage: 40, boxWeight: 0.05 } as const
const GREEN = 0x46e05a

type Bolt = { mesh: THREE.Mesh; trail: THREE.Mesh; velocity: THREE.Vector3; age: number }

export class InkRayBolts {
  private bolts: Bolt[] = []
  private geometry = new THREE.SphereGeometry(0.07, 10, 8)
  private trailGeometry = new THREE.CylinderGeometry(0.035, 0.005, 1, 8).rotateX(Math.PI / 2).translate(0, 0, -0.5)
  private material = new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false })
  private trailMaterial = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false })

  constructor(private scene: THREE.Scene, private world: CollisionWorld,
    /** Distance along a ray to the nearest zombie body, as the director measures it. */
    private bodies: (origin: THREE.Vector3, direction: THREE.Vector3, max: number) => number) {}

  fire(origin: THREE.Vector3, direction: THREE.Vector3) {
    const mesh = new THREE.Mesh(this.geometry, this.material)
    const trail = new THREE.Mesh(this.trailGeometry, this.trailMaterial)
    for (const m of [mesh, trail]) { m.userData.noCollision = true; m.position.copy(origin); this.scene.add(m) }
    this.bolts.push({ mesh, trail, velocity: direction.clone().normalize().multiplyScalar(INK_RAY.speed), age: 0 })
  }

  /** Returns where bolts burst this frame. */
  update(dt: number): THREE.Vector3[] {
    const bursts: THREE.Vector3[] = []
    for (const bolt of [...this.bolts]) {
      bolt.age += dt
      const step = bolt.velocity.length() * dt, direction = bolt.velocity.clone().normalize()
      const from = bolt.mesh.position
      const wall = this.world.raySurface(from, direction, step)
      const body = this.bodies(from, direction, step)
      const reach = Math.min(wall?.distance ?? Infinity, body)
      if (reach <= step || bolt.age > INK_RAY.life) {
        bursts.push(from.clone().addScaledVector(direction, Math.min(reach, step)))
        this.remove(bolt)
        continue
      }
      from.addScaledVector(direction, step)
      bolt.trail.position.copy(from)
      bolt.trail.lookAt(from.clone().add(direction))
      bolt.trail.scale.set(1, 1, Math.min(1.4, bolt.age * INK_RAY.speed))
    }
    return bursts
  }

  private remove(bolt: Bolt) {
    bolt.mesh.removeFromParent(); bolt.trail.removeFromParent()
    this.bolts.splice(this.bolts.indexOf(bolt), 1)
  }

  clear() { for (const bolt of [...this.bolts]) this.remove(bolt) }
  dispose() { this.clear(); this.geometry.dispose(); this.trailGeometry.dispose(); this.material.dispose(); this.trailMaterial.dispose() }
}
