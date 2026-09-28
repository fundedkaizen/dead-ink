import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import { EnemyNavigation } from '../navigation'
import { synthOutput } from '../ui-slot-sound'
import type { PlayerSense, Shot, Vec3 } from '../types'
import type { DogAnchor } from './types'

/**
 * Guard dogs. A dog walks its round and smells anyone within its reach, walls or no walls (running doubles the
 * reach, crouching shrinks it): it stops, growls, then barks and runs at them. Every bark carries: the guards
 * nearby come to see what it has found. A dog that reaches you bites until you get away or put it down (two
 * pistol rounds). Drawn in solid ink like the guards; on a co-op guest it follows the host's (rows()/follow()).
 */
export const DOG = { walk: 1.7, run: 5.6, health: 45, bite: 8, biteEvery: 0.85, reach: 1.35, alertSeconds: 1.2, barkEvery: 2.2, giveUp: 7, barkRadius: 32 } as const
export type DogState = 'patrol' | 'alert' | 'chase' | 'dead'
const STATES: DogState[] = ['patrol', 'alert', 'chase', 'dead']

type Dog = {
  anchor: DogAnchor
  position: THREE.Vector3; yaw: number; state: DogState; health: number
  waypoint: number; timer: number; target: number; lost: number; bite: number; bark: number; barks: number
  path: THREE.Vector3[]; replan: number
  mesh: THREE.Group; legs: THREE.Object3D[]; gait: number
}
export type DogSnapshot = { position: Vec3; yaw: number; state: DogState; health: number; waypoint: number; timer: number; target: number; lost: number; barks: number }[]

const ink = new THREE.MeshBasicMaterial({ color: 0x0b0b0b, toneMapped: false })

/** A lean ink dog from rounded parts: body, chest, head and muzzle, pricked ears, a tail, four jointed legs. */
function dogMesh() {
  const root = new THREE.Group()
  root.name = 'Guard dog'
  root.userData = { noCollision: true, dog: true }
  const part = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(geometry, ink)
    mesh.position.set(x, y, z); mesh.rotation.x = rx
    parent.add(mesh); return mesh
  }
  part(new THREE.CapsuleGeometry(0.13, 0.5, 4, 10), 0, 0.58, -0.02, Math.PI / 2)
  part(new THREE.SphereGeometry(0.17, 12, 8), 0, 0.62, 0.24).scale.set(0.95, 1.05, 1.1)
  part(new THREE.SphereGeometry(0.12, 12, 8), 0, 0.8, 0.44)
  part(new THREE.CapsuleGeometry(0.055, 0.14, 3, 8), 0, 0.76, 0.58, Math.PI / 2 + 0.15)
  for (const x of [-0.06, 0.06]) part(new THREE.ConeGeometry(0.04, 0.12, 6), x, 0.93, 0.42, -0.25)
  part(new THREE.CapsuleGeometry(0.025, 0.3, 3, 6), 0, 0.72, -0.45, -0.9)
  const legs: THREE.Object3D[] = []
  for (const [x, z] of [[-0.08, 0.24], [0.08, 0.24], [-0.08, -0.26], [0.08, -0.26]]) {
    const hip = new THREE.Group()
    hip.position.set(x, 0.55, z)
    part(new THREE.CapsuleGeometry(0.04, 0.24, 3, 6), 0, -0.16, 0, 0, hip)
    const knee = new THREE.Group()
    knee.position.y = -0.3
    part(new THREE.CapsuleGeometry(0.032, 0.18, 3, 6), 0, -0.1, z > 0 ? 0.02 : -0.03, 0, knee)
    hip.add(knee)
    root.add(hip); legs.push(hip)
  }
  return { root, legs }
}

/** A short, rough bark: two formant bursts falling in pitch, louder the nearer it is. */
export function barkSound(distance: number) {
  const level = Math.max(0, 1 - distance / DOG.barkRadius) * 0.8
  if (level < 0.03) return
  const output = synthOutput('effects', level)
  if (!output) return
  const { context, out } = output
  const t = context.currentTime
  for (const [start, from] of [[0, 560], [0.2, 500]] as const) {
    const osc = context.createOscillator(), filter = context.createBiquadFilter(), gain = context.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(from, t + start); osc.frequency.exponentialRampToValueAtTime(from * 0.52, t + start + 0.13)
    filter.type = 'bandpass'; filter.frequency.value = 900; filter.Q.value = 2.4
    gain.gain.setValueAtTime(0.0001, t + start); gain.gain.exponentialRampToValueAtTime(0.9, t + start + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.15)
    osc.connect(filter).connect(gain).connect(out)
    osc.start(t + start); osc.stop(t + start + 0.17)
  }
  setTimeout(() => out.disconnect(), 700)
}

export class DogPack {
  readonly dogs: Dog[] = []
  private navigation: EnemyNavigation
  /** Where a bark goes: the guards hear it (the runtime hands it to the director). */
  onBark: (position: THREE.Vector3, target: THREE.Vector3) => void = () => {}
  /** A bite on player `id` (0 the host; 90 and up a hostage). */
  onBite: (id: number, amount: number, from: THREE.Vector3) => void = () => {}
  /** The local player's ears, for the bark's loudness. */
  listener = new THREE.Vector3()
  smell = 6

  constructor(private scene: THREE.Scene, world: CollisionWorld, doors: THREE.Group[]) {
    this.navigation = new EnemyNavigation(world, doors, () => {})
  }

  /** This mission's dogs, at the start of their rounds. `smell`: the difficulty's reach. */
  setup(anchors: DogAnchor[], smell: number) {
    this.clear()
    this.smell = smell
    for (const anchor of anchors) {
      const { root, legs } = dogMesh()
      const position = new THREE.Vector3(...anchor.route[0])
      root.position.copy(position)
      this.scene.add(root)
      this.dogs.push({ anchor, position, yaw: 0, state: 'patrol', health: DOG.health, waypoint: 1 % anchor.route.length, timer: 0, target: -1, lost: 0,
        bite: 0, bark: 0, barks: 0, path: [], replan: 0, mesh: root, legs, gait: 0 })
    }
  }

  private step(dog: Dog, goal: THREE.Vector3, speed: number, dt: number) {
    dog.replan -= dt
    let next = goal
    if (!this.navigation.segment(dog.position, goal, false)) {
      if (!dog.path.length && dog.replan <= 0) { dog.replan = 1.2; dog.path = this.navigation.plan(dog.position, goal) }
      while (dog.path.length && dog.path[0].distanceTo(dog.position) < 0.4) dog.path.shift()
      next = dog.path[0] ?? goal
    } else dog.path = []
    const moved = this.navigation.step(dog.position, next, speed * dt)
    if (!moved || moved.distanceToSquared(dog.position) < 1e-6) return 0
    const distance = moved.distanceTo(dog.position)
    dog.yaw = Math.atan2(moved.x - dog.position.x, moved.z - dog.position.z)
    dog.position.copy(moved)
    return distance / Math.max(dt, 1e-4)
  }

  /** Host: sniff, patrol, chase and bite. `players`: everyone the dogs can smell (hostages included). */
  update(dt: number, players: readonly PlayerSense[]) {
    if (dt <= 0) return
    for (const dog of this.dogs) {
      if (dog.state === 'dead') { this.pose(dog, 0, dt); continue }
      let speed = 0
      dog.timer += dt; dog.bite = Math.max(0, dog.bite - dt); dog.bark -= dt
      // Smell: through walls, further for a runner, less for a crouched player.
      let scent: PlayerSense | null = null, best = Infinity
      for (const player of players) {
        if (!player.alive) continue
        const running = (player.exposure?.running ?? player.velocity.lengthSq() > 25)
        const reach = this.smell * (running ? 2 : player.exposure?.crouched ? 0.7 : 1) * (dog.state === 'chase' ? 2.5 : 1)
        const distance = player.feet.distanceTo(dog.position)
        if (distance < reach && distance < best && Math.abs(player.feet.y - dog.position.y) < 3) { best = distance; scent = player }
      }
      if (dog.state === 'patrol') {
        if (scent) { dog.state = 'alert'; dog.timer = 0; dog.target = scent.id ?? 0 }
        else {
          const route = dog.anchor.route
          const goal = new THREE.Vector3(...route[dog.waypoint % route.length])
          if (dog.position.distanceTo(goal) < 0.6) dog.waypoint = (dog.waypoint + 1) % route.length
          else speed = this.step(dog, goal, DOG.walk, dt)
        }
      } else {
        const target = players.find(player => (player.id ?? 0) === dog.target && player.alive) ?? scent
        if (target) { dog.target = target.id ?? 0; dog.lost = scent ? 0 : dog.lost + dt }
        else dog.lost += dt
        if (!target || dog.lost > DOG.giveUp) { dog.state = 'patrol'; dog.path = []; dog.lost = 0 }
        else {
          const toward = target.feet
          if (dog.state === 'alert') {
            dog.yaw = Math.atan2(toward.x - dog.position.x, toward.z - dog.position.z)
            if (dog.timer >= DOG.alertSeconds) { dog.state = 'chase'; dog.bark = 0 }
          } else {
            if (dog.position.distanceTo(toward) > DOG.reach * 0.8) speed = this.step(dog, toward, DOG.run, dt)
            else dog.yaw = Math.atan2(toward.x - dog.position.x, toward.z - dog.position.z)
            if (dog.position.distanceTo(toward) <= DOG.reach && dog.bite <= 0) { dog.bite = DOG.biteEvery; this.onBite(target.id ?? 0, DOG.bite, dog.position.clone()) }
          }
          if (dog.bark <= 0) {
            dog.bark = DOG.barkEvery; dog.barks++
            barkSound(dog.position.distanceTo(this.listener))
            this.onBark(dog.position.clone(), toward.clone())
          }
        }
      }
      this.pose(dog, speed, dt)
    }
  }

  private pose(dog: Dog, speed: number, dt: number) {
    const mesh = dog.mesh
    mesh.position.copy(dog.position)
    if (dog.state === 'dead') {
      mesh.rotation.set(0, dog.yaw, Math.PI / 2)
      mesh.position.y = dog.position.y + 0.15
      for (const leg of dog.legs) leg.rotation.x = 0
      return
    }
    mesh.rotation.set(0, dog.yaw, 0)
    dog.gait += dt * (speed > 3 ? 13 : 7) * Math.min(1, speed)
    const swing = speed > 0.05 ? Math.sin(dog.gait) * (speed > 3 ? 0.7 : 0.4) : 0
    dog.legs.forEach((leg, i) => { leg.rotation.x = (i === 0 || i === 3 ? swing : -swing) })
    // Head down while sniffing about, braced when alert.
    mesh.rotation.x = dog.state === 'alert' ? -0.08 : 0
  }

  /** A player's round against the dogs: the nearest dog it meets before `maxDistance`, which it hurts. */
  hit(shot: Shot, maxDistance: number) {
    const ray = new THREE.Ray(shot.origin, shot.direction.clone().normalize()), point = new THREE.Vector3()
    let best: Dog | null = null, distance = maxDistance
    for (const dog of this.dogs) {
      if (dog.state === 'dead') continue
      for (const along of [-0.25, 0.25]) {
        const centre = dog.position.clone().add(new THREE.Vector3(Math.sin(dog.yaw) * along, 0.6, Math.cos(dog.yaw) * along))
        if (!ray.intersectSphere(new THREE.Sphere(centre, 0.32), point)) continue
        const d = point.distanceTo(shot.origin)
        if (d < distance) { distance = d; best = dog }
      }
    }
    if (!best) return null
    best.health -= shot.damage
    if (best.health <= 0) { best.state = 'dead'; best.health = 0 }
    else if (best.state === 'patrol') { best.state = 'chase'; best.bark = 0 }
    return { distance, point: shot.origin.clone().addScaledVector(ray.direction, distance), dead: best.state === 'dead' }
  }

  /** Co-op: each dog as [state, x, y, z, yaw, barks]. */
  rows(): number[][] {
    return this.dogs.map(dog => [STATES.indexOf(dog.state), Math.round(dog.position.x * 100) / 100, Math.round(dog.position.y * 100) / 100,
      Math.round(dog.position.z * 100) / 100, Math.round(dog.yaw * 100) / 100, dog.barks])
  }

  /** Co-op guest: the dogs where the host has them, easing between snapshots; its barks heard here too. */
  follow(dt: number, rows: readonly number[][] | undefined) {
    const ease = 1 - Math.exp(-dt * 12)
    this.dogs.forEach((dog, index) => {
      const row = rows?.[index]
      if (!row) return
      const before = dog.position.clone()
      dog.state = STATES[row[0]] ?? 'patrol'
      const goal = new THREE.Vector3(row[1], row[2], row[3])
      if (dog.position.distanceToSquared(goal) > 9) dog.position.copy(goal); else dog.position.lerp(goal, ease)
      dog.yaw = row[4]
      if (row[5] > dog.barks) { dog.barks = row[5]; barkSound(dog.position.distanceTo(this.listener)) }
      this.pose(dog, before.distanceTo(dog.position) / Math.max(dt, 1e-4), dt)
    })
  }

  snapshot(): DogSnapshot {
    return this.dogs.map(dog => ({ position: dog.position.toArray() as Vec3, yaw: dog.yaw, state: dog.state, health: dog.health, waypoint: dog.waypoint,
      timer: dog.timer, target: dog.target, lost: dog.lost, barks: dog.barks }))
  }

  restore(saved: DogSnapshot | undefined) {
    this.dogs.forEach((dog, index) => {
      const entry = saved?.[index]
      if (!entry) { dog.position.set(...dog.anchor.route[0]); dog.state = 'patrol'; dog.health = DOG.health; dog.waypoint = 1 % dog.anchor.route.length; dog.timer = 0; dog.target = -1; dog.lost = 0 }
      else Object.assign(dog, { yaw: entry.yaw, state: entry.state, health: entry.health, waypoint: entry.waypoint, timer: entry.timer, target: entry.target, lost: entry.lost, barks: entry.barks }),
        dog.position.set(...entry.position)
      dog.path = []; dog.bite = 0; dog.bark = 0
      this.pose(dog, 0, 0)
    })
  }

  clear() {
    for (const dog of this.dogs) { dog.mesh.removeFromParent(); dog.mesh.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() }) }
    this.dogs.length = 0
    this.navigation.clear()
  }

  dispose() { this.clear() }
}
