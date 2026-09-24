import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import { disposeGun, type Gun } from '../../lab/weapons/models'
import { buildRocketRound } from '../../lab/weapons/models/launcher'
import { WEAPON_RULES } from '../balance'
import { weaponRules } from '../loot'
import type { WeaponItem } from '../types'
import { finish, puffMesh, release } from './vfx'

/**
 * The Ink Rocket's rockets (the launcher is a Mystery Box gun: balance.ts, launcher.ts). A rocket leaves the
 * tube slowly enough to see, its motor pushes it on, and it trails ink smoke; it bursts on the first thing
 * it touches, a zombie or a wall, as the Ink Ray's bolts do (wonder.ts). What the burst does belongs to the
 * runtime. Numbers are ours, tuned to Call of Duty's feel: a launcher's blast clears a pack in the early
 * rounds and leaves crawlers at its edge from about round 12; the Press Ram's reaches further.
 */
export const ROCKET = {
  /** Metres a second out of the tube, the motor's push (m/s²), its top speed, and seconds before it bursts anyway. */
  speed: 20, thrust: 75, top: 58, life: 4,
  /** The burst: this at its centre, less toward its edge (the director's falloff: half at the rim). Fixed, not scaled with the round. */
  radius: 6, damage: 2500,
  /** The Press Ram's burst is wider (its damage rises with the Pack-a-Punch, as any upgraded gun's does). */
  packedRadius: 7.5,
  /** Too close and it hurts you: this much at point blank, none from `selfRadius` of its radius out. */
  selfDamage: 80, selfRadius: 5 / 6,
  /** Metres of flight between two puffs of its trail. */
  puffEvery: 0.42,
  /**
   * In flight the round is drawn this much bigger than the warhead on the launcher, so it reads at a
   * distance; it grows into it over its first moment, while it is already racing away from you.
   */
  flightScale: 1.7, growSeconds: 0.15,
} as const

/** Upgraded shots are red in Dead Ink (the Pack-a-Punch's tracers, the Ink Ray X2); a flame is heat's orange. */
const RED = 0xd4332a, HEAT = 0xffb13b
const TRAIL = 360

/** What one rocket carries to its burst, fixed when it was fired. */
export type RocketLoad = { packed: boolean; radius: number; damage: number }
export type RocketBurst = RocketLoad & { at: THREE.Vector3; direction: THREE.Vector3 }

/** What a launcher's rocket carries: the Press Ram's wider burst, and damage risen with rarity and the Pack-a-Punch. */
export function rocketLoad(item: Pick<WeaponItem, 'name' | 'rarity' | 'packed' | 'packLevel'>): RocketLoad {
  const packed = !!item.packed
  return { packed, radius: packed ? ROCKET.packedRadius : ROCKET.radius, damage: ROCKET.damage * weaponRules(item).damage / WEAPON_RULES.rocket.damage }
}

/** `drawn`: a teammate's rocket, only drawn here; its burst is theirs and arrives as a blast of its own. */
type Flight = { model: Gun; flame: THREE.Mesh; direction: THREE.Vector3; speed: number; age: number; puff: number; load: RocketLoad; drawn: boolean }
type Puff = { position: THREE.Vector3; velocity: THREE.Vector3; size: number; grow: number; age: number; life: number; tone: number; seed: number }

export class InkRockets {
  private flights: Flight[] = []
  /** The trail's puffs, grey-white ink smoke; the Press Ram's carry a red tint. */
  private smoke = puffMesh('Ink Rocket trail', TRAIL, 2)
  private redSmoke = puffMesh('Press Ram trail', TRAIL, 2)
  private puffs: Puff[] = []
  private redPuffs: Puff[] = []
  private flameGeometry = new THREE.ConeGeometry(0.034, 0.24, 10).rotateX(-Math.PI / 2).translate(0, 0, -0.2)
  private flameMaterial = new THREE.MeshBasicMaterial({ color: HEAT, toneMapped: false })
  private redFlameMaterial = new THREE.MeshBasicMaterial({ color: RED, toneMapped: false })
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private look = new THREE.Vector3()

  constructor(private scene: THREE.Scene, private world: CollisionWorld,
    /** Distance along a ray to the nearest zombie body, as the director measures it (the full `max` when none). */
    private bodies: (origin: THREE.Vector3, direction: THREE.Vector3, max: number) => number) {
    ;(this.redSmoke.material as THREE.ShaderMaterial).uniforms.heat.value.setHex(RED)
    scene.add(this.smoke, this.redSmoke)
  }

  get count() { return this.flights.length }
  /** The rockets in flight, for checks and screenshots. */
  get inFlight() { return this.flights.map(f => ({ position: f.model.position, direction: f.direction, packed: f.load.packed, speed: f.speed })) }
  get trailPuffs() { return this.puffs.length + this.redPuffs.length }

  /**
   * A rocket leaves the tube at `origin` (the warhead's base), flying along `direction`. `drawn`: a
   * teammate's, seen flying here but bursting silently (co-op sends its burst as a blast).
   */
  fire(origin: THREE.Vector3, direction: THREE.Vector3, load: RocketLoad, drawn = false) {
    const model = buildRocketRound()
    model.name = load.packed ? 'Press Ram rocket' : 'Ink Rocket rocket'
    model.userData.noCollision = true
    model.traverse(object => { object.userData.noCollision = true })
    const flame = new THREE.Mesh(this.flameGeometry, load.packed ? this.redFlameMaterial : this.flameMaterial)
    flame.name = 'Rocket flame'
    flame.userData.noCollision = true
    model.add(flame)
    model.position.copy(origin)
    const heading = direction.clone().normalize()
    model.lookAt(this.look.copy(origin).add(heading))
    this.scene.add(model)
    // A first puff right at the mouth.
    this.flights.push({ model, flame, direction: heading, speed: ROCKET.speed, age: 0, puff: ROCKET.puffEvery, load, drawn })
  }

  /** Fly, trail smoke and burst; returns the bursts of this frame. */
  update(dt: number): RocketBurst[] {
    const bursts: RocketBurst[] = []
    const delta = Math.min(dt, 0.05)
    for (const flight of [...this.flights]) {
      flight.age += delta
      flight.speed = Math.min(ROCKET.top, flight.speed + ROCKET.thrust * delta)
      const step = flight.speed * delta, from = flight.model.position, direction = flight.direction
      const wall = this.world.raySurface(from, direction, step)
      // The body test answers `step` itself when no zombie is in the way: only a shorter answer is a hit.
      const body = this.bodies(from, direction, step)
      const reach = Math.min(wall?.distance ?? Infinity, body < step ? body : Infinity)
      if (reach < Infinity || flight.age > ROCKET.life) {
        // On the near side of what it struck, so the blast sees the room it went off in.
        const travel = Math.min(reach, step)
        const at = from.clone().addScaledVector(direction, Math.max(0, travel - 0.08))
        this.trail(flight, travel)
        if (!flight.drawn) bursts.push({ ...flight.load, at, direction: direction.clone() })
        this.remove(flight)
        continue
      }
      this.trail(flight, step)
      from.addScaledVector(direction, step)
      flight.model.lookAt(this.look.copy(from).add(direction))
      flight.model.rotateZ(flight.age * 9)
      flight.model.scale.setScalar(1 + (ROCKET.flightScale - 1) * Math.min(1, flight.age / ROCKET.growSeconds))
      // The motor's flame flickers.
      const flicker = 0.75 + Math.random() * 0.5
      flight.flame.scale.set(flicker, flicker, 0.7 + Math.random() * 0.8)
    }
    this.updateSmoke(this.smoke, this.puffs, delta, false)
    this.updateSmoke(this.redSmoke, this.redPuffs, delta, true)
    return bursts
  }

  /** Puffs every so often along the stretch about to be flown, from the rocket's tail: an unbroken line at any speed. */
  private trail(flight: Flight, distance: number) {
    const list = flight.load.packed ? this.redPuffs : this.puffs
    const tail = flight.model.position.clone().addScaledVector(flight.direction, -0.14)
    let along = ROCKET.puffEvery - flight.puff
    for (; along <= distance; along += ROCKET.puffEvery) {
      const jitter = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.05)
      list.push({ position: tail.clone().addScaledVector(flight.direction, along).add(jitter),
        velocity: jitter.clone().multiplyScalar(4).add(new THREE.Vector3(0, 0.18, 0)),
        size: 0.04 + Math.random() * 0.03, grow: 0.15 + Math.random() * 0.1, age: 0, life: 0.8 + Math.random() * 0.45,
        tone: 0.04 + Math.random() * 0.14, seed: Math.random() * 100 })
      if (list.length > TRAIL) list.shift()
    }
    flight.puff = distance - (along - ROCKET.puffEvery)
  }

  /** Smoke swells, drifts up and thins away; hot at first (the flame's orange, or the Press Ram's red). */
  private updateSmoke(mesh: THREE.InstancedMesh, list: Puff[], delta: number, red: boolean) {
    for (let i = list.length - 1; i >= 0; i--) if ((list[i].age += delta) >= list[i].life) list.splice(i, 1)
    const attribute = mesh.geometry.getAttribute('puff') as THREE.InstancedBufferAttribute
    list.forEach((puff, i) => {
      puff.velocity.multiplyScalar(Math.exp(-2.5 * delta))
      puff.position.addScaledVector(puff.velocity, delta)
      const k = puff.age / puff.life
      const size = THREE.MathUtils.lerp(puff.size, puff.grow, 1 - (1 - Math.min(1, k * 2.2)) ** 3)
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, puff.seed)
      mesh.setMatrixAt(i, this.matrix.compose(puff.position, this.quaternion, this.scale.setScalar(size)))
      const heat = red ? 0.55 * (1 - THREE.MathUtils.smoothstep(k, 0.25, 1)) : 1 - THREE.MathUtils.smoothstep(puff.age, 0.01, 0.06)
      attribute.setXYZW(i, puff.tone, THREE.MathUtils.smoothstep(k, 0.4, 1), puff.seed, heat)
    })
    finish(mesh, list.length, 'puff')
  }

  private remove(flight: Flight) {
    flight.flame.removeFromParent()
    disposeGun(flight.model)
    this.flights.splice(this.flights.indexOf(flight), 1)
  }

  clear() {
    for (const flight of [...this.flights]) this.remove(flight)
    this.puffs = []; this.redPuffs = []
    finish(this.smoke, 0, 'puff'); finish(this.redSmoke, 0, 'puff')
  }

  dispose() {
    this.clear()
    release(this.smoke); release(this.redSmoke)
    this.flameGeometry.dispose(); this.flameMaterial.dispose(); this.redFlameMaterial.dispose()
  }
}
