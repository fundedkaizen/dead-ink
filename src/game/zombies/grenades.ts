import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'

/**
 * Frag grenades, Call of Duty style: two at the start and two more each round, four at most, thrown
 * with Q (or G). They fly, bounce off walls and floors, roll to a stop and go off after their fuse.
 * This file is the physics; what the blast does belongs to the runtime.
 *
 * `damage` is fixed, as a frag's is in Call of Duty, and meets the director's falloff (half at the rim):
 * about 1080 to a zombie standing over it, 600 at the edge. So a pack dies to it through round 5 (550
 * health); from round 6 or 7 the ones at the edge live through it, and a survivor it hit hard enough can
 * lose its legs and crawl; from round 11 a frag no longer kills on its own. Tuned to that description of
 * Call of Duty, not taken from a source.
 */
export const GRENADE = { start: 2, perRound: 2, max: 4, fuse: 2.2, speed: 13, lift: 3.6, radius: 5.5, damage: 1200, cooldown: 0.8, selfRadius: 4, selfDamage: 60 } as const

type Live = { object: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3; fuse: number; resting: boolean; restAge: number }

export class Grenades {
  private live: Live[] = []
  private hit = new THREE.Vector3()

  /** `fuse` in seconds; `upright` for something that lands on its feet and stays there (the Ink Doll). */
  constructor(private scene: THREE.Scene, private world: CollisionWorld, private model: () => THREE.Object3D = inkFrag,
    private options: { fuse?: number; upright?: boolean } = {}) {}

  /** Those lying still, with seconds since they came to rest. */
  resting() { return this.live.filter(g => g.resting).map(g => ({ object: g.object, position: g.object.position, age: g.restAge })) }

  get count() { return this.live.length }

  throw(origin: THREE.Vector3, direction: THREE.Vector3, carried = new THREE.Vector3()) {
    const object = this.model()
    object.position.copy(origin)
    object.userData.noCollision = true
    this.scene.add(object)
    const velocity = direction.clone().normalize().multiplyScalar(GRENADE.speed).add(new THREE.Vector3(0, GRENADE.lift, 0)).add(carried)
    this.live.push({ object, velocity, spin: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5), fuse: this.options.fuse ?? GRENADE.fuse, resting: false, restAge: 0 })
  }

  /** Move, bounce and count down; returns where grenades went off this frame. */
  update(dt: number): THREE.Vector3[] {
    const bursts: THREE.Vector3[] = []
    const step = Math.min(dt, 0.05)
    for (const g of [...this.live]) {
      g.fuse -= step
      if (!g.resting) {
        g.velocity.y -= 9.8 * step
        const move = g.velocity.clone().multiplyScalar(step), length = move.length()
        if (length > 1e-5) {
          const surface = this.world.raySurface(g.object.position, move.clone().divideScalar(length), length + 0.06)
          if (surface) {
            // Bounce off what it struck, losing most of its speed; nearly still on a floor, it rests.
            this.hit.copy(surface.normal)
            g.object.position.copy(surface.point).addScaledVector(this.hit, 0.06)
            g.velocity.reflect(this.hit).multiplyScalar(0.4)
            if (this.hit.y > 0.6 && g.velocity.length() < 1.2) {
              g.resting = true; g.velocity.set(0, 0, 0)
              if (this.options.upright) { g.object.rotation.set(0, g.object.rotation.y, 0); g.object.position.y -= 0.06 }
            }
          } else g.object.position.add(move)
        }
        g.object.rotation.x += g.spin.x * step; g.object.rotation.y += g.spin.y * step; g.object.rotation.z += g.spin.z * step
        if (g.object.position.y < -20) g.fuse = 0
      }
      else g.restAge += step
      if (g.fuse <= 0) {
        bursts.push(g.object.position.clone())
        this.remove(g)
      }
    }
    return bursts
  }

  private remove(g: Live) {
    g.object.removeFromParent()
    g.object.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    this.live.splice(this.live.indexOf(g), 1)
  }

  clear() { for (const g of [...this.live]) this.remove(g) }
  dispose() { this.clear() }
}

const inkMaterial = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
const paperMaterial = new THREE.MeshBasicMaterial({ color: 0xfbfaf5, toneMapped: false })

/** A small frag in ink: a dark body, a paper band, the lever and ring. */
export function inkFrag() {
  const g = new THREE.Group()
  g.name = 'Frag grenade'
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), inkMaterial)
  body.scale.set(1, 1.15, 1)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.012, 12), paperMaterial)
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.03, 10), inkMaterial)
  top.position.y = 0.055
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, 0.006), inkMaterial)
  lever.position.set(0.03, 0.035, 0); lever.rotation.z = -0.35
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.003, 6, 14), inkMaterial)
  ring.position.set(-0.02, 0.07, 0)
  g.add(body, band, top, lever, ring)
  return g
}
