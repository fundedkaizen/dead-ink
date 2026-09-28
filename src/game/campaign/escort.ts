import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import { EnemyNavigation } from '../navigation'
import { BOARD_SECONDS, HostageActor } from '../hostage-actor'
import { HOSTAGE_RUN_SPEED } from '../balance'
import type { HostageMotion } from '../hostages'
import type { MissionState } from '../mission'
import type { Vec3 } from '../types'
import { insideZone, type CampaignRun } from './run'
import type { ExtractionAnchor } from './types'

/**
 * The campaign's escort: a freed hostage follows the nearest player (or whoever last told him "follow me"),
 * walking the path that player actually walked (a trail of footprints: stairs, doorways and corners he could
 * never plan through himself), cutting straight across whenever the way is clear. "Wait here" keeps him put.
 * Shot at, he drops and crawls behind the nearest cover and stays low until it is quiet. Guards shoot him too
 * (the runtime adds him to what they can see); at no health he goes down and bleeds out unless a player gets
 * him up. Once the way out is ready and he is near it, he runs aboard by himself.
 *
 * Same surface as HostageEscort (the classic route escort), so the runtime, the escape and co-op guests treat
 * both alike.
 */
export const FOLLOW = {
  /** He stops this close to whoever he follows. */
  near: 2.4,
  /** Footprints are this far apart; a jump further than `teleport` (a zip line, a boost) starts a new trail. */
  crumb: 0.8, teleport: 4, trail: 160,
  /** He runs to catch up past this. */
  far: 9, farSpeed: 4.1,
  /** Seconds he stays low after the shooting stops. */
  calm: 2.2,
  /** He boards on his own within this of the vehicle once it is ready. */
  board: 12,
} as const

export type EscortPlayer = { id: number; feet: THREE.Vector3; up: boolean }

type Travel = { crumb: number; trail: number; detour: THREE.Vector3[]; replanAfter: number; stalled: number; cover: THREE.Vector3 | null; coverFrom: THREE.Vector3 | null
  boardingFrom: THREE.Vector3 | null; boardingTime: number; seated: boolean }

const ignore = new THREE.Object3D()

export class FollowEscort {
  readonly actors: HostageActor[] = []
  readonly motion: HostageMotion[] = []
  /** The vehicle's travel from where it waited, and its turn, during the escape (the seats ride along). */
  readonly jeepOffset = new THREE.Vector3()
  readonly jeepRotation = new THREE.Quaternion()
  /** Set by the runtime each frame: every player and where the shooting is. */
  players: EscortPlayer[] = []
  threat: THREE.Vector3 | null = null
  private navigation: EnemyNavigation
  private spots: { position: Vec3; facing: number }[] = []
  private extraction: ExtractionAnchor | null = null
  private travel: Travel[] = []
  private trails = new Map<number, { points: THREE.Vector3[]; revision: number }>()
  private calmFor = 0
  private disposed = false
  private loading: Promise<void> = Promise.resolve()

  constructor(private scene: THREE.Scene, private world: CollisionWorld, doors: THREE.Group[]) {
    this.navigation = new EnemyNavigation(world, doors, () => {})
  }

  /** The classic API's init: the hostages come with the mission (setup). */
  init() { return this.loading }

  /** This mission's hostages: one actor per cell, seated there; and the way out they will board. */
  setup(spots: { position: Vec3; facing: number }[], extraction: ExtractionAnchor | null) {
    this.spots = spots
    this.extraction = extraction
    this.loading = (async () => {
      while (this.actors.length > spots.length) this.actors.pop()!.dispose()
      while (this.actors.length < spots.length) {
        const actor = await HostageActor.create()
        if (this.disposed) { actor.dispose(); return }
        this.scene.add(actor.root)
        this.actors.push(actor)
      }
      this.travel = spots.map(() => this.fresh())
      this.motion.length = spots.length
    })()
    return this.loading
  }

  private fresh(): Travel {
    return { crumb: -1, trail: -1, detour: [], replanAfter: 0, stalled: 0, cover: null, coverFrom: null, boardingFrom: null, boardingTime: 0, seated: false }
  }

  sync(state: Pick<MissionState, 'hostages'>) {
    this.jeepOffset.set(0, 0, 0)
    this.jeepRotation.identity()
    this.calmFor = FOLLOW.calm
    this.navigation.clear()
    this.trails.clear()
    state.hostages.forEach((hostage, index) => {
      const actor = this.actors[index]
      if (!actor) return
      this.travel[index] = this.fresh()
      actor.root.position.fromArray(hostage.position)
      actor.root.rotation.set(0, this.spots[index]?.facing ?? Math.PI / 2, 0)
      actor.restore(hostage.status === 'captive', hostage.status === 'loaded')
      actor.animate(0, false, false, hostage.status === 'loaded', hostage.status === 'captive')
    })
  }

  /** The classic API's regroup: here, forget any stuck detour. */
  rally() { this.travel.forEach(travel => { travel.detour = []; travel.stalled = 0 }) }

  /** Where player `id` walked this frame (host, every player): the footprints the hostage follows. */
  record(id: number, feet: THREE.Vector3, onFoot: boolean) {
    let trail = this.trails.get(id)
    if (!trail) { trail = { points: [], revision: 0 }; this.trails.set(id, trail) }
    const last = trail.points[trail.points.length - 1]
    if (!onFoot) return
    if (last && last.distanceTo(feet) > FOLLOW.teleport) { trail.points = []; trail.revision++ }
    if (!last || trail.points.length === 0 || last.distanceTo(feet) >= FOLLOW.crumb) {
      trail.points.push(feet.clone())
      if (trail.points.length > FOLLOW.trail) { trail.points.shift(); trail.revision++ }
    }
  }

  /** Whom hostage `index` follows: his leader while up and not far off, otherwise the nearest player up. */
  leaderFor(position: THREE.Vector3, preferred: number) {
    const up = this.players.filter(player => player.up)
    const chosen = up.find(player => player.id === preferred && player.feet.distanceTo(position) < 30)
    if (chosen) return chosen
    let best: EscortPlayer | null = null
    for (const player of up) if (!best || player.feet.distanceToSquared(position) < best.feet.distanceToSquared(position)) best = player
    return best
  }

  /** A place near him the threat cannot see, if there is one he can walk to. */
  private coverFrom(position: THREE.Vector3, threat: THREE.Vector3) {
    const eye = threat.clone().setY(threat.y + 1.5)
    const start = Math.atan2(position.x - threat.x, position.z - threat.z)
    for (const radius of [1.6, 3, 4.5, 6]) for (let i = 0; i < 10; i++) {
      const angle = start + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.55
      const candidate = this.navigation.floor(new THREE.Vector3(position.x + Math.sin(angle) * radius, position.y, position.z + Math.cos(angle) * radius))
      if (!candidate || this.world.visible(eye, candidate.clone().setY(candidate.y + 0.9), ignore)) continue
      if (this.navigation.segment(position, candidate, false)) return candidate
    }
    return null
  }

  /** The next point toward `leader`: straight at him if the way is clear, otherwise along his footprints. */
  private nextPoint(position: THREE.Vector3, leader: EscortPlayer, travel: Travel, dt: number) {
    if (Math.abs(leader.feet.y - position.y) < 0.4 && leader.feet.distanceTo(position) < 14 && this.navigation.segment(position, leader.feet, false)) {
      travel.crumb = -1; travel.detour = []
      return leader.feet
    }
    const trail = this.trails.get(leader.id)
    if (trail?.points.length) {
      if (travel.trail !== trail.revision || travel.crumb < 0 || travel.crumb >= trail.points.length) {
        // Pick up the trail at the footprint nearest him that he can walk to.
        travel.trail = trail.revision; travel.crumb = -1
        let best = Infinity
        trail.points.forEach((point, i) => {
          const distance = point.distanceTo(position)
          if (distance < best && distance < 12 && Math.abs(point.y - position.y) < 1.2 && this.navigation.segment(position, point, false)) { best = distance; travel.crumb = i }
        })
      }
      if (travel.crumb >= 0) {
        // Skip ahead along footprints he can reach directly.
        while (travel.crumb + 1 < trail.points.length && trail.points[travel.crumb].distanceTo(position) < 0.45) travel.crumb++
        let look = Math.min(trail.points.length - 1, travel.crumb + 6)
        while (look > travel.crumb && !(Math.abs(trail.points[look].y - position.y) < 0.35 && this.navigation.segment(position, trail.points[look], false))) look--
        travel.crumb = look
        return trail.points[travel.crumb]
      }
    }
    // No trail to walk: plan on his own level, now and then.
    travel.replanAfter -= dt
    if (!travel.detour.length && travel.replanAfter <= 0) {
      travel.replanAfter = 2
      travel.detour = this.navigation.plan(position, leader.feet)
    }
    while (travel.detour.length && travel.detour[0].distanceTo(position) < 0.4) travel.detour.shift()
    return travel.detour[0] ?? null
  }

  /**
   * Host: move every hostage. `danger`: shooting near the hostages this frame. The run carries each hostage's
   * vitals (down, waiting, leader); a classic state without a run treats him as always following.
   */
  update(dt: number, state: Pick<MissionState, 'hostages' | 'jeep'> & { run?: CampaignRun }, leaders: THREE.Vector3 | readonly THREE.Vector3[], danger: boolean) {
    const elapsed = Math.max(0, Math.min(dt, 0.1))
    if (!this.players.length) {
      const list = Array.isArray(leaders) ? leaders : [leaders as THREE.Vector3]
      this.players = list.map((feet, id) => ({ id, feet, up: true }))
    }
    this.calmFor = danger ? 0 : this.calmFor + elapsed
    const run = state.run
    const extraction = this.extraction
    state.hostages.forEach((hostage, index) => {
      const actor = this.actors[index], travel = this.travel[index]
      if (!actor || !travel) return
      const vitals = run?.hostages[index]
      const position = new THREE.Vector3(...hostage.position)
      const captive = hostage.status === 'captive', loaded = hostage.status === 'loaded'
      actor.advanceRelease(elapsed, captive)
      let moving = false, speed = 0
      let cowering = !captive && !loaded && (this.calmFor < FOLLOW.calm || !!vitals?.down)
      if (loaded) this.seat(index, travel, position, elapsed)
      else if (!captive && actor.canWalk && !vitals?.down) {
        let goal: THREE.Vector3 | null = null
        let near: number = FOLLOW.near
        const ready = extraction && (run?.arrived ?? true) && insideZone({ ...extraction.zone, r: FOLLOW.board }, hostage.position)
        if (ready && extraction) {
          // The way out is here: run aboard.
          goal = new THREE.Vector3(...extraction.board); near = 0.2
          if (position.distanceTo(goal) < 0.3) {
            hostage.status = 'loaded'
            if (state.jeep === 'waiting') state.jeep = 'boarding'
            travel.boardingFrom = position.clone(); travel.boardingTime = 0
            this.motion[index] = [0, 0, 0, actor.root.rotation.y]
            actor.animate(elapsed, false, false, true, false)
            return
          }
          cowering = false
        } else if (cowering && this.threat) {
          // Shot at: find cover from the shooting and stay low there.
          if (!travel.cover || !travel.coverFrom || travel.coverFrom.distanceTo(this.threat) > 5) {
            travel.cover = this.coverFrom(position, this.threat); travel.coverFrom = this.threat.clone()
          }
          if (travel.cover && travel.cover.distanceTo(position) > 0.35) { goal = travel.cover; near = 0.3 }
        } else if (!vitals?.waiting) {
          travel.cover = null
          const leader = this.leaderFor(position, vitals?.leader ?? 0)
          if (leader && leader.feet.distanceTo(position) > FOLLOW.near) goal = this.nextPoint(position, leader, travel, elapsed)
          if (leader && leader.feet.distanceTo(position) > FOLLOW.far) speed = FOLLOW.farSpeed
        }
        if (goal && goal.distanceTo(position) > near) {
          const stepped = this.navigation.step(position, goal, elapsed * (speed || HOSTAGE_RUN_SPEED) * (cowering ? 0.8 : 1))
          if (stepped && stepped.distanceToSquared(position) > 1e-6) {
            actor.root.rotation.y = Math.atan2(stepped.x - position.x, stepped.z - position.z)
            speed = Math.hypot(stepped.x - position.x, stepped.z - position.z) / Math.max(elapsed, 1e-4)
            position.copy(stepped)
            moving = true; travel.stalled = 0
            cowering = false
          } else if ((travel.stalled += elapsed) > 1.5) {
            travel.stalled = 0; travel.crumb = -1; travel.detour = []; travel.cover = null
          }
        }
      }
      hostage.position = position.toArray() as Vec3
      actor.root.position.copy(position)
      actor.animate(elapsed, moving, cowering && !moving, loaded, captive, speed || HOSTAGE_RUN_SPEED)
      this.motion[index] = [moving ? 1 : 0, cowering && !moving ? 1 : 0, speed, actor.root.rotation.y]
    })
    this.players = []
  }

  /** A loaded hostage: sitting down into his seat from where he boarded, then riding with the vehicle. */
  private seat(index: number, travel: Travel, position: THREE.Vector3, elapsed: number) {
    const extraction = this.extraction
    const seat = new THREE.Vector3(...(extraction?.seats[index] ?? extraction?.seats[0] ?? position.toArray() as Vec3))
    const origin = new THREE.Vector3(...(extraction?.park ?? position.toArray() as Vec3))
    if (travel.boardingFrom) {
      travel.boardingTime = Math.min(BOARD_SECONDS, travel.boardingTime + elapsed)
      const t = travel.boardingTime / BOARD_SECONDS
      position.copy(travel.boardingFrom).lerp(seat, t * t * (3 - 2 * t))
      if (t === 1) travel.boardingFrom = null
    } else position.copy(seat)
    position.sub(origin).applyQuaternion(this.jeepRotation).add(origin).add(this.jeepOffset)
    const actor = this.actors[index]
    actor.root.rotation.set(0, (extraction?.heading ?? 0) + Math.PI / 2, 0)
    actor.root.quaternion.premultiply(this.jeepRotation)
  }

  /** Co-op guest: draw each hostage where the host has him, easing between snapshots. */
  follow(dt: number, state: Pick<MissionState, 'hostages'>, motion: readonly (readonly number[])[]) {
    const elapsed = Math.max(0, Math.min(dt, 0.1))
    const ease = 1 - Math.exp(-elapsed * 14)
    state.hostages.forEach((hostage, index) => {
      const actor = this.actors[index], travel = this.travel[index]
      if (!actor || !travel) return
      const [moving = 0, cowering = 0, speed = 0, yaw = Math.PI / 2] = motion[index] ?? []
      const loaded = hostage.status === 'loaded', captive = hostage.status === 'captive'
      actor.advanceRelease(elapsed, captive)
      const position = actor.root.position
      if (loaded) {
        if (!travel.seated) { travel.seated = true; travel.boardingFrom = position.clone(); travel.boardingTime = 0 }
        this.seat(index, travel, position, elapsed)
      } else {
        travel.seated = false
        const goal = new THREE.Vector3(...hostage.position)
        if (position.distanceToSquared(goal) > 9) position.copy(goal)
        else position.lerp(goal, ease)
        if (!captive) actor.root.rotation.set(0, yaw, 0)
      }
      actor.animate(elapsed, !!moving && !loaded, !!cowering, loaded, captive, speed || HOSTAGE_RUN_SPEED)
    })
  }

  dispose() {
    this.disposed = true
    for (const actor of this.actors) actor.dispose()
    this.actors.length = 0
    this.navigation.clear()
  }
}
