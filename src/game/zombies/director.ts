import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'
import { EnemyActor } from '../actors'
import { EnemyNavigation } from '../navigation'
import { rayCapsuleDistance, reactionClipName, type HitReaction, type HitZone } from '../hit-reactions'
import { hitDamage, shotgunDamageMultiplier } from '../balance'
import type { BoneName } from '../../lab/rig'
import type { EmitSound, Shot } from '../types'
import { zombieEyeMaterial } from '../../render/ink'
import type { NavGraph } from './navgraph'
import { PLAYER_HEALTH } from './rules'

/**
 * Dead Ink's zombies. They reuse the game's stickman (rig, walk and run animations, death falls,
 * animated hit zones), with the gun hidden, arms reaching forward and red eyes. The brain is simple
 * on purpose: find the nearest living player, path to them, swipe when close.
 *
 * Actors are pooled: loading one takes time, so the director builds them once and revives them each
 * spawn. A zombie is 'idle' in the pool, 'chase' while alive, and 'dead' while its body lies there.
 */
export type ZombieGait = 'walk' | 'run' | 'sprint'
/** Metres per second. Players walk at 4.2 and sprint at 7.6, so a sprint outruns even a sprinter. */
export const ZOMBIE_SPEED: Record<ZombieGait, number> = { walk: 1.1, run: 3.6, sprint: 5.2 }

export const ATTACK = {
  /** Start a swipe within this horizontal distance of the target. */
  range: 1.35,
  /** The swipe connects this long after it starts, if the target is still close. Dodgeable. */
  windup: 0.3,
  /** A landed swipe needs the target within this distance at the moment of impact. */
  reach: 1.7,
  /** Whole swipe duration, then a short recovery before the next one. */
  swing: 0.6, recover: 0.45,
} as const
/**
 * A body lies this long, then sinks into the ink and goes back to the pool. Sinking, not vanishing:
 * a body that blinks out of existence reads as a bug.
 */
export const CORPSE = { lie: 6, sink: 2.2, depth: 0.8 } as const
/** Clawing up out of the ground, as Call of Duty's zombies do outdoors: how long, and how deep it starts. */
export const RISE = { seconds: 1.7, depth: 1.9 } as const
/** Metres per second on ladders and ledges. Walkers are slower, as on the ground. */
export const CLIMB_SPEED = { up: 1.8, down: 3, across: 2.2 } as const
/**
 * A zombie asks to respawn when it cannot reach anyone, is too far from everyone, or simply stops
 * getting closer. The last one matters: a baked map graph can promise a way through that a body cannot
 * actually take, and a chaser would otherwise shuffle in place forever. Call of Duty does the same,
 * moving zombies that cannot path to you back into play near you.
 */
export const STRANDED = { seconds: 7, distance: 75, noProgressSeconds: 6, progressMetres: 1.5 } as const
/** How often the shared flow field is recomputed. */
export const FLOW_INTERVAL = 0.35

export type Zombie = {
  id: string
  actor: EnemyActor
  position: THREE.Vector3
  yaw: number
  health: number
  maxHealth: number
  gait: ZombieGait
  state: 'idle' | 'chase' | 'dead'
  stuck: number
  unreachable: number
  swing: number
  swingLanded: boolean
  recover: number
  stagger: number
  deadFor: number
  stranded: boolean
  footstep: number
  /** Waypoints being followed along one graph link (stairs keep their real route). */
  route: THREE.Vector3[]
  routeTimer: number
  /** The graph spot the current route leads to, one to avoid, and how long to keep avoiding it. */
  routeNode: number
  routeFrom: number
  blocked: number
  avoidTimer: number
  /** How long this zombie has failed to step along its current link. */
  edgeFail: number
  /** A link whose first step keeps being refused, and how many times in a row. */
  probeFail: number
  probeFails: number
  /** The closest this zombie has come to a player (walking distance), and how long since it improved. */
  bestDistance: number
  noProgress: number
  /** Seconds left climbing out of the ground. */
  rise: number
  /** A ladder or ledge being climbed: a fixed path, no collision. */
  climb: Climb | null
  /** Seconds until it next groans (or screams, if it sprints). */
  voice: number
}

type Climb = { points: THREE.Vector3[]; index: number; key: string; travelled: number; wall: THREE.Vector3 }

export type ZombieTarget = { id: string; feet: THREE.Vector3; alive: boolean }

export type ZombieContext = {
  scene: THREE.Scene
  world: CollisionWorld
  doors: THREE.Group[]
  emit: EmitSound
  /** A swipe landed on a player. */
  damagePlayer: (targetId: string, amount: number, source: THREE.Vector3) => void
  onHit?: (hit: HitReaction) => void
  /** A zombie started climbing out of the ground here. */
  onRise?: (position: THREE.Vector3) => void
  /** Load one actor; checks substitute a stub. Defaults to the real stickman. */
  actorFactory?: () => Promise<EnemyActor>
  /** The map-wide walking graph. Without one, zombies only chase what they can walk to in a straight line. */
  graph?: NavGraph
}

export type ZombieHit = { zombie: Zombie; reaction: HitReaction; dealt: number; lethal: boolean }

const UP = new THREE.Vector3(0, 1, 0)
const BODY_CENTRE = new THREE.Vector3(0, 0.75, 0)
const scratch = { q: new THREE.Quaternion(), p: new THREE.Quaternion(), d: new THREE.Vector3(), v: new THREE.Vector3() }

export class ZombieDirector {
  readonly zombies: Zombie[] = []
  readonly navigation: EnemyNavigation
  private disposed = false
  private flowTimer = 0
  /** Fine route plans, for the rare zombie the flow field cannot step along (a narrow gate, a doorway edge). */
  private plans = new Map<Zombie, Generator<void, THREE.Vector3[]>>()

  constructor(private context: ZombieContext) {
    this.navigation = new EnemyNavigation(context.world, context.doors, context.emit)
  }

  /** Build the pool. Sequential loads, as the mission's AI does, so the rig initialises in order. */
  async init(size: number) {
    for (let i = this.zombies.length; i < size; i++) {
      const actor = await (this.context.actorFactory ?? (() => EnemyActor.create('pistol')))()
      if (this.disposed) { actor.dispose(); return }
      actor.root.name = `Zombie ${i + 1}`
      actor.root.visible = false
      addEyes(actor)
      this.context.scene.add(actor.root)
      this.zombies.push({
        id: `zombie-${i + 1}`, actor, position: new THREE.Vector3(), yaw: 0, health: 0, maxHealth: 0, gait: 'walk',
        state: 'idle', stuck: 0, unreachable: 0, swing: 0, swingLanded: false,
        recover: 0, stagger: 0, deadFor: 0, stranded: false, footstep: 0, route: [], routeTimer: 0, routeNode: -1, routeFrom: -1, blocked: -1, avoidTimer: 0, edgeFail: 0, probeFail: -1, probeFails: 0, bestDistance: Infinity, noProgress: 0,
        rise: 0, climb: null, voice: 0,
      })
    }
  }

  get alive() { return this.zombies.filter(z => z.state === 'chase') }
  get aliveCount() { let n = 0; for (const z of this.zombies) if (z.state === 'chase') n++; return n }
  get capacity() { return this.zombies.length }

  /**
   * Revive a pooled actor at `position`, climbing out of the ground when `rise` is set. Null when the
   * pool is exhausted or there is no floor there.
   */
  spawn(position: THREE.Vector3, health: number, gait: ZombieGait, facing = 0, rise = false): Zombie | null {
    const zombie = this.zombies.find(z => z.state === 'idle')
    if (!zombie) return null
    const floor = this.navigation.floor(position)
    if (!floor) return null
    zombie.position.copy(floor)
    zombie.yaw = facing
    zombie.health = zombie.maxHealth = health
    zombie.gait = gait
    zombie.state = 'chase'
    zombie.stuck = 0; zombie.unreachable = 0
    zombie.swing = 0; zombie.swingLanded = false; zombie.recover = 0; zombie.stagger = 0; zombie.deadFor = 0
    zombie.stranded = false; zombie.footstep = 0
    zombie.route = []; zombie.routeTimer = 0; zombie.routeNode = -1; zombie.routeFrom = -1; zombie.blocked = -1; zombie.avoidTimer = 0; zombie.edgeFail = 0; zombie.probeFail = -1; zombie.probeFails = 0
    zombie.bestDistance = Infinity; zombie.noProgress = 0
    zombie.rise = rise ? RISE.seconds : 0; zombie.climb = null
    zombie.voice = 1 + Math.random() * 3
    this.plans.delete(zombie)
    const { actor } = zombie
    actor.root.position.copy(zombie.position)
    if (rise) actor.root.position.y -= RISE.depth
    actor.root.rotation.set(0, zombie.yaw, 0)
    actor.restore('patrol')
    // restore() puts the guard's gun back in its hand; a zombie never carries one.
    actor.gun.visible = false
    actor.root.visible = true
    if (rise) this.context.onRise?.(zombie.position.clone())
    return zombie
  }

  /** Move a living zombie somewhere else (a stranded one, back into play). Keeps its health. */
  relocate(zombie: Zombie, position: THREE.Vector3) {
    const floor = this.navigation.floor(position)
    if (!floor || zombie.state !== 'chase') return false
    zombie.position.copy(floor)
    zombie.actor.root.position.copy(floor)
    zombie.stuck = 0; zombie.unreachable = 0; zombie.stranded = false
    zombie.route = []; zombie.routeTimer = 0; zombie.routeNode = -1; zombie.blocked = -1
    zombie.bestDistance = Infinity; zombie.noProgress = 0; zombie.probeFail = -1; zombie.probeFails = 0
    zombie.rise = 0; zombie.climb = null
    zombie.actor.root.rotation.set(0, zombie.yaw, 0)
    this.plans.delete(zombie)
    return true
  }

  update(dt: number, targets: readonly ZombieTarget[]) {
    // One flow field for the whole crowd, a few times a second: walking distance from everywhere to
    // the nearest player. Every zombie then just walks downhill on it.
    this.flowTimer -= dt
    const graph = this.context.graph
    if (graph && this.flowTimer <= 0) {
      const sources = targets.filter(t => t.alive).map(t => t.feet)
      if (sources.length) graph.flow(sources)
      this.flowTimer = FLOW_INTERVAL
    }
    this.advanceFinePlans()
    for (const zombie of this.zombies) {
      if (zombie.state === 'idle') continue
      if (zombie.state === 'dead') {
        zombie.deadFor += dt
        zombie.actor.update(dt, 'dead', false)
        const sinking = zombie.deadFor - CORPSE.lie
        if (sinking > 0) zombie.actor.root.position.y = zombie.position.y - CORPSE.depth * Math.min(1, sinking / CORPSE.sink)
        if (sinking >= CORPSE.sink) { zombie.state = 'idle'; zombie.actor.root.visible = false }
        continue
      }
      const target = this.nearest(zombie, targets)
      if (zombie.rise > 0) { this.rise(zombie, target, dt); continue }
      zombie.voice -= dt
      if (zombie.voice <= 0) {
        // Groans carry; sprinters scream, and more often.
        const sprint = zombie.gait === 'sprint'
        zombie.voice = sprint ? 2.5 + Math.random() * 3 : 3.5 + Math.random() * 5
        this.context.emit({ kind: sprint ? 'zombie-scream' : 'zombie-groan', position: zombie.position.clone().setY(zombie.position.y + 1.6), radius: 32 })
      }
      if (zombie.climb) { this.climbStep(zombie, dt); continue }
      let moving = false
      zombie.stagger = Math.max(0, zombie.stagger - dt)
      zombie.recover = Math.max(0, zombie.recover - dt)
      zombie.avoidTimer = Math.max(0, zombie.avoidTimer - dt)
      if (zombie.avoidTimer <= 0 && zombie.blocked >= 0 && zombie.stuck <= 0) zombie.blocked = -1
      if (target) {
        const dx = target.feet.x - zombie.position.x, dz = target.feet.z - zombie.position.z
        const flat = Math.hypot(dx, dz), level = Math.abs(target.feet.y - zombie.position.y) < 1.3
        if (zombie.swing > 0) {
          zombie.swing -= dt
          this.face(zombie, target.feet, dt, 10)
          const elapsed = ATTACK.swing - zombie.swing
          if (!zombie.swingLanded && elapsed >= ATTACK.windup) {
            zombie.swingLanded = true
            const now = Math.hypot(target.feet.x - zombie.position.x, target.feet.z - zombie.position.z)
            if (target.alive && now <= ATTACK.reach && Math.abs(target.feet.y - zombie.position.y) < 1.3)
              this.context.damagePlayer(target.id, PLAYER_HEALTH.zombieHit, zombie.position.clone().add(new THREE.Vector3(0, 1.3, 0)))
            this.context.emit({ kind: 'zombie-swipe', position: zombie.position.clone(), radius: 10 })
          }
          if (zombie.swing <= 0) zombie.recover = ATTACK.recover
        } else if (flat <= ATTACK.range && level && zombie.recover <= 0 && zombie.stagger <= 0) {
          zombie.swing = ATTACK.swing; zombie.swingLanded = false
          this.context.emit({ kind: 'zombie-snarl', position: zombie.position.clone().setY(zombie.position.y + 1.6), radius: 14 })
        } else if (zombie.stagger <= 0) {
          moving = this.chase(zombie, target.feet, flat, dt)
        }
        zombie.unreachable = moving || flat < 3 ? 0 : zombie.unreachable + dt
        // Getting closer is what counts, not moving: a zombie shuffling against a fence is going nowhere.
        const graph = this.context.graph
        const walking = graph ? graph.distance(graph.nearest(zombie.position)) : flat
        const progress = Number.isFinite(walking) ? walking : flat
        if (progress < zombie.bestDistance - STRANDED.progressMetres) { zombie.bestDistance = progress; zombie.noProgress = 0 }
        else zombie.noProgress += dt
        zombie.stranded = zombie.unreachable > STRANDED.seconds || flat > STRANDED.distance
          || (flat > 4 && zombie.noProgress > STRANDED.noProgressSeconds)
      }
      zombie.actor.root.position.copy(zombie.position)
      zombie.actor.root.rotation.set(0, zombie.yaw, 0)
      zombie.actor.update(dt, 'patrol', moving, undefined, moving ? ZOMBIE_SPEED[zombie.gait] : 0)
      zombie.actor.gun.visible = false
      reachArms(zombie)
    }
  }

  /** Clawing out of the ground: it cannot walk or swipe until it is out, but it can be shot. */
  private rise(zombie: Zombie, target: ZombieTarget | null, dt: number) {
    zombie.rise = Math.max(0, zombie.rise - dt)
    if (target) this.face(zombie, target.feet, dt, 3)
    const t = 1 - zombie.rise / RISE.seconds, out = t * t * (3 - 2 * t)
    const { actor } = zombie
    actor.root.position.copy(zombie.position)
    actor.root.position.y -= RISE.depth * (1 - out)
    // Hunched over the hole, straightening as it comes out.
    actor.root.rotation.set(0.5 * (1 - out), zombie.yaw, 0, 'YXZ')
    actor.update(dt, 'patrol', false, undefined, 0)
    actor.gun.visible = false
    // Both hands claw at the ground above, one after the other.
    const claw = THREE.MathUtils.lerp(1.5, -0.28, out)
    poseArms(zombie, claw + 0.45 * Math.sin(t * 17) * (1 - out), claw + 0.45 * Math.sin(t * 17 + Math.PI) * (1 - out))
  }

  /**
   * A ladder or ledge that starts right here or one spot ahead, when this zombie can see its first
   * rung from where it stands. Then it climbs from here rather than walking to the exact spot first:
   * tower legs and bracing can box that spot in, and a zombie would shuffle at the foot of the ladder.
   */
  private climbFoot(graph: NavGraph, zombie: Zombie, here: number) {
    let best: { from: number; to: number; points: THREE.Vector3[] } | null = null, bestDistance = graph.distance(here)
    const around: number[] = []
    for (const from of [here, ...graph.neighbours(here, around)]) {
      const to = graph.downhill(from)
      if (to < 0 || graph.distance(to) >= bestDistance || graph.linkKind(from, to) !== 'climb') continue
      if (zombie.position.distanceTo(graph.point(from)) > 3) continue
      const points = graph.route(from, to).points.slice(1)
      const first = points[0]
      let clear = true
      for (const lift of [0.5, 1.3]) {
        if (!this.context.world.visible(zombie.position.clone().setY(zombie.position.y + lift), first.clone().setY(Math.min(first.y, zombie.position.y + 1.4) + lift), zombie.actor.root)) clear = false
      }
      if (!clear) continue
      best = { from, to, points }; bestDistance = graph.distance(to)
    }
    return best
  }

  /** Start up a ladder or over a ledge, unless someone is just ahead on the same one. */
  private startClimb(zombie: Zombie, from: number, to: number, points: THREE.Vector3[]) {
    const key = from < to ? `${from}:${to}` : `${to}:${from}`
    if (this.zombies.some(z => z !== zombie && z.state === 'chase' && z.climb?.key === key && z.climb.travelled < 1.6)) return false
    const path = [zombie.position.clone()]
    for (const point of points) {
      const last = path[path.length - 1]
      const rise = point.y - last.y, flat = Math.hypot(point.x - last.x, point.z - last.z)
      // A ledge is climbed up then crossed, or crossed then dropped: never cut through its corner.
      if (Math.abs(rise) > 0.3 && flat > 0.4) path.push(rise > 0 ? last.clone().lerp(point, 0.45).setY(point.y) : last.clone().lerp(point, 0.55).setY(last.y))
      path.push(point.clone())
    }
    // Climbing, a body faces the ladder or the wall: from the lowest point toward the highest.
    const low = path.reduce((a, b) => (b.y < a.y ? b : a)), high = path.reduce((a, b) => (b.y > a.y ? b : a))
    const wall = new THREE.Vector3(high.x - low.x, 0, high.z - low.z)
    if (wall.lengthSq() < 1e-4) wall.set(Math.sin(zombie.yaw), 0, Math.cos(zombie.yaw))
    zombie.climb = { points: path, index: 1, key, travelled: 0, wall: wall.normalize() }
    zombie.route.length = 0
    this.plans.delete(zombie)
    return true
  }

  /** Along the climb's fixed path. */
  private climbStep(zombie: Zombie, dt: number) {
    const climb = zombie.climb!
    const pace = zombie.gait === 'walk' ? 0.7 : zombie.gait === 'sprint' ? 1.25 : 1
    let budget = dt, vertical = false
    while (budget > 1e-6 && climb.index < climb.points.length) {
      const goal = climb.points[climb.index]
      const dx = goal.x - zombie.position.x, dy = goal.y - zombie.position.y, dz = goal.z - zombie.position.z
      const flat = Math.hypot(dx, dz), length = Math.hypot(flat, dy)
      vertical = Math.abs(dy) > flat
      const speed = pace * (vertical ? (dy > 0 ? CLIMB_SPEED.up : CLIMB_SPEED.down) : CLIMB_SPEED.across)
      this.face(zombie, vertical ? zombie.position.clone().add(climb.wall) : goal, dt, 9)
      if (length <= speed * budget) {
        zombie.position.copy(goal); climb.index++; climb.travelled += length; budget -= length / speed
      } else {
        const step = speed * budget
        zombie.position.x += dx / length * step; zombie.position.y += dy / length * step; zombie.position.z += dz / length * step
        climb.travelled += step; budget = 0
      }
    }
    if (climb.index >= climb.points.length) {
      zombie.climb = null
      zombie.route.length = 0; zombie.routeTimer = 0; zombie.stuck = 0; zombie.edgeFail = 0
    }
    const { actor } = zombie
    actor.root.position.copy(zombie.position)
    actor.root.rotation.set(0, zombie.yaw, 0)
    actor.update(dt, 'patrol', true, undefined, vertical ? 1.2 : CLIMB_SPEED.across * pace)
    actor.gun.visible = false
    if (vertical) {
      // Hand over hand: each arm reaches up in turn.
      const phase = climb.travelled * 4.2
      poseArms(zombie, 2.2 + 1.4 * Math.sin(phase), 2.2 + 1.4 * Math.sin(phase + Math.PI))
    } else reachArms(zombie)
  }

  private nearest(zombie: Zombie, targets: readonly ZombieTarget[]) {
    let best: ZombieTarget | null = null, bestDistance = Infinity
    for (const target of targets) {
      if (!target.alive) continue
      const distance = target.feet.distanceToSquared(zombie.position)
      if (distance < bestDistance) { best = target; bestDistance = distance }
    }
    return best
  }

  private face(zombie: Zombie, point: THREE.Vector3, dt: number, rate = 6) {
    const desired = Math.atan2(point.x - zombie.position.x, point.z - zombie.position.z)
    const delta = Math.atan2(Math.sin(desired - zombie.yaw), Math.cos(desired - zombie.yaw))
    zombie.yaw += Math.sign(delta) * Math.min(Math.abs(delta), rate * dt)
    return Math.abs(delta)
  }

  /** Straight at the target when the way is clear and close; otherwise downhill on the flow field. */
  private chase(zombie: Zombie, goal: THREE.Vector3, flat: number, dt: number) {
    const graph = this.context.graph
    let waypoint: THREE.Vector3 | undefined
    let stopShort = 0
    if (flat < 12 && Math.abs(goal.y - zombie.position.y) < 1.2 && this.navigation.segment(zombie.position, goal)) {
      waypoint = goal
      stopShort = 0.8
      zombie.route.length = 0
    } else if (graph) {
      zombie.routeTimer -= dt
      while (zombie.route.length && zombie.position.distanceTo(zombie.route[0]) < 0.45) zombie.route.shift()
      if (!zombie.route.length || zombie.routeTimer <= 0) {
        const here = graph.nearest(zombie.position)
        const foot = here >= 0 ? this.climbFoot(graph, zombie, here) : null
        if (foot) {
          if (this.startClimb(zombie, foot.from, foot.to, foot.points)) return true
          zombie.routeTimer = 0.25
          return false
        }
        const next = here >= 0 ? this.pickNeighbour(graph, zombie, here) : -1
        if (next >= 0) {
          zombie.routeNode = next
          zombie.routeFrom = here
          const { points, kind } = graph.route(here, next)
          if (kind === 'climb') {
            if (this.startClimb(zombie, here, next, points)) return true
            // Someone is on it just ahead: wait at the bottom.
            zombie.route.length = 0
            zombie.routeTimer = 0.25
            return false
          }
          // Drop leading waypoints already behind the zombie, then take a shortcut to the farthest
          // one it can walk straight to, so it does not weave between grid spots.
          zombie.route = points.filter(p => zombie.position.distanceTo(p) > 0.45)
          for (let i = 0; i < 2 && zombie.route.length > 1; i++) {
            if (!this.navigation.segment(zombie.position, zombie.route[1])) break
            zombie.route.shift()
          }
          zombie.routeTimer = 0.5
        } else {
          zombie.route.length = 0
          zombie.routeTimer = 0.3
        }
      }
      waypoint = zombie.route[0]
    }
    if (!waypoint) return false
    const remaining = Math.hypot(waypoint.x - zombie.position.x, waypoint.z - zombie.position.z)
    if (remaining <= stopShort) return false
    const turn = this.face(zombie, waypoint, dt, zombie.gait === 'walk' ? 4 : 7)
    // The walk and run clips only travel forward: finish a sharp turn before moving.
    if (turn > 0.7) return false
    const step = Math.min(ZOMBIE_SPEED[zombie.gait] * dt, Math.max(0.01, remaining - stopShort))
    // Movement allows a slightly slimmer body than planning does. Stepping into that margin wedges a
    // zombie somewhere no plan can start from, so only move where planning clearance also holds.
    const candidate = this.navigation.step(zombie.position, waypoint, step)
    const next = candidate && this.navigation.floor(candidate) ? candidate : null
    if (!next || !this.clearOfOthers(zombie, next)) {
      zombie.stuck += dt
      // Only the step itself failing counts against the link; a neighbour in the way is not its fault.
      if (!next && this.context.graph && zombie.routeFrom >= 0 && zombie.routeNode >= 0) {
        zombie.edgeFail += dt
        if (zombie.edgeFail > 1) {
          this.context.graph.blockEdge(zombie.routeFrom, zombie.routeNode)
          this.flowTimer = 0
          zombie.edgeFail = 0; zombie.route.length = 0; zombie.routeTimer = 0
          zombie.routeNode = -1; zombie.routeFrom = -1; zombie.blocked = -1
          return false
        }
      }
      // Briefly blocked: try another direction. Properly stuck: ask the guards' fine planner for the
      // awkward few metres (a gate, a doorway edge), which the coarse graph cannot express.
      // Already wedged (spawned into a gap, or shoved by the crowd): one bigger step frees it.
      if (zombie.stuck > 0.35 && !this.navigation.floor(zombie.position.clone())) {
        const shove = this.navigation.step(zombie.position, waypoint, 0.8)
        if (shove && this.navigation.floor(shove.clone())) {
          zombie.position.copy(shove)
          zombie.stuck = 0
          return true
        }
      }
      if (zombie.stuck > 0.5 && !this.plans.has(zombie) && this.context.graph) {
        zombie.blocked = zombie.routeNode
        const ahead = this.lookAhead(this.context.graph, zombie, 3)
        const from = this.navigation.floor(zombie.position.clone()), to = this.navigation.floor(ahead.clone())
        if (from && to) this.plans.set(zombie, this.navigation.createPlan(from, to))
      }
      if (zombie.stuck > 1.2) { zombie.route.length = 0; zombie.routeTimer = 0; zombie.stuck = 0 }
      return false
    }
    zombie.blocked = -1
    zombie.edgeFail = 0
    zombie.stuck = 0
    zombie.footstep += zombie.position.distanceTo(next)
    zombie.position.copy(next)
    if (zombie.footstep > 0.9) { zombie.footstep = 0; this.context.emit({ kind: 'enemy-footstep', position: zombie.position.clone(), radius: 6 }) }
    return true
  }

  /**
   * Which neighbouring spot to walk to. Normally the one nearest a player, but it must be a spot this
   * zombie can actually take a step toward: a body fits through a gap the coarse graph thinks is open,
   * yet not always from where the zombie is standing. When every improving direction is blocked (a
   * local dead end, which is what wedges a chaser forever), it accepts a step that is briefly WORSE and
   * refuses to walk straight back, so it works its way around instead of grinding against a fence.
   */
  private pickNeighbour(graph: NavGraph, zombie: Zombie, here: number) {
    const options = graph.neighbours(here)
      .map(index => ({ index, distance: graph.distance(index) }))
      .filter(option => Number.isFinite(option.distance) && option.index !== zombie.blocked)
      .sort((a, b) => a.distance - b.distance)
    if (!options.length) return -1
    const current = graph.distance(here)
    const point = new THREE.Vector3()
    for (const option of options) {
      // A ladder or a ledge is not walked, so a first step toward it proves nothing.
      if (graph.linkKind(here, option.index) === 'climb') { zombie.probeFail = -1; zombie.probeFails = 0; return option.index }
      graph.point(option.index, point)
      const probe = this.navigation.step(zombie.position, point, 0.35)
      if (!probe || !this.navigation.floor(probe.clone())) {
        // A link toward the player that keeps refusing the first step is not really there: after a few
        // tries, delete it so the flow field routes everyone around instead of shuffling on the spot.
        if (option.distance < current) {
          zombie.probeFails = zombie.probeFail === option.index ? zombie.probeFails + 1 : 1
          zombie.probeFail = option.index
          if (zombie.probeFails >= 3) {
            graph.blockEdge(here, option.index)
            this.flowTimer = 0
            zombie.probeFail = -1; zombie.probeFails = 0; zombie.blocked = -1
            return -1
          }
        }
        continue
      }
      zombie.probeFail = -1; zombie.probeFails = 0
      // Taking a step away from the player is an escape: do not turn straight back next time.
      if (option.distance >= current) { zombie.blocked = here; zombie.avoidTimer = 3 }
      return option.index
    }
    return options[0].index
  }

  /** A point a few flow-field steps further on, to plan toward when stuck. */
  private lookAhead(graph: NavGraph, zombie: Zombie, steps: number) {
    let node = graph.nearest(zombie.position)
    for (let i = 0; i < steps && node >= 0; i++) {
      const next = graph.downhill(node)
      if (next < 0) break
      node = next
    }
    return node >= 0 ? graph.point(node) : zombie.position.clone()
  }

  /** Advance fine plans a few milliseconds per frame, as the mission AI does. */
  private advanceFinePlans() {
    if (!this.plans.size) return
    const deadline = performance.now() + 2
    for (const [zombie, job] of this.plans) {
      if (zombie.state !== 'chase') { this.plans.delete(zombie); continue }
      let result = job.next()
      while (!result.done && performance.now() < deadline) result = job.next()
      if (!result.done) { if (performance.now() >= deadline) return; continue }
      this.plans.delete(zombie)
      if (result.value.length) {
        zombie.route = result.value
        zombie.routeTimer = 2
        zombie.stuck = 0
      } else zombie.unreachable += 0.5
    }
  }

  /**
   * Zombies may crowd, but not merge: a step is refused only when another living zombie stands
   * close AND in the direction of travel. Ones behind or beside do not block, so a queue forms in
   * a corridor instead of a deadlock.
   */
  private clearOfOthers(zombie: Zombie, next: THREE.Vector3) {
    const dirX = next.x - zombie.position.x, dirZ = next.z - zombie.position.z
    const length = Math.hypot(dirX, dirZ) || 1
    for (const other of this.zombies) {
      if (other === zombie || other.state !== 'chase') continue
      const ox = other.position.x - next.x, oz = other.position.z - next.z
      const gap = Math.hypot(ox, oz)
      if (gap < 0.5 && Math.abs(other.position.y - next.y) < 1 && (ox * dirX + oz * dirZ) / (gap * length || 1) > 0.2) return false
    }
    return true
  }

  // ---------------------------------------------------------------- damage

  private bodyHit(zombie: Zombie, origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    const centre = zombie.position.clone().add(BODY_CENTRE)
    if (rayCapsuleDistance(origin, direction, centre, centre, 1.9) > maxDistance) return null
    return zombie.actor.hitVolumes.raycast(origin, direction, maxDistance)
  }

  private nearestHit(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    const normalized = direction.clone().normalize()
    let nearest: Zombie | undefined, best: ReturnType<ZombieDirector['bodyHit']> = null, distance = maxDistance
    for (const zombie of this.zombies) {
      if (zombie.state !== 'chase') continue
      const hit = this.bodyHit(zombie, origin, normalized, distance)
      if (hit && hit.distance < distance) { nearest = zombie; best = hit; distance = hit.distance }
    }
    return { nearest, best, distance, normalized }
  }

  /** Distance to the nearest zombie body along a ray, for the weapon's aim convergence. */
  aimDistance(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    return this.nearestHit(origin, direction, maxDistance).distance
  }

  /**
   * A player's bullet. `scale` converts the weapon's damage to Dead Ink's scale; `instaKill` makes
   * any hit lethal. Returns what happened, or null for a miss.
   */
  hit(shot: Shot, maxDistance: number, scale: number, instaKill = false): ZombieHit | null {
    const { nearest, best, normalized } = this.nearestHit(shot.origin, shot.direction, Math.min(maxDistance, shot.range))
    if (!nearest || !best) return null
    const falloff = shot.weapon === 'shotgun' ? shotgunDamageMultiplier(best.distance) : 1
    const damage = instaKill ? nearest.health : hitDamage(shot.weapon, best.zone, shot.damage * scale) * falloff
    return this.applyHit(nearest, damage, best.zone, best.point, normalized, best.bone, shot.weapon)
  }

  /** A knife swipe: the nearest living zombie in front of `origin`, within `range`. */
  knife(origin: THREE.Vector3, forward: THREE.Vector3, range: number, damage: number, instaKill = false): ZombieHit | null {
    const flatForward = forward.clone().setY(0).normalize()
    let best: Zombie | null = null, bestDistance = range
    for (const zombie of this.zombies) {
      if (zombie.state !== 'chase') continue
      const to = zombie.position.clone().add(new THREE.Vector3(0, 1.1, 0)).sub(origin)
      const distance = Math.hypot(to.x, to.z)
      if (distance > bestDistance || Math.abs(to.y) > 1.4) continue
      if (to.setY(0).normalize().dot(flatForward) < Math.cos(THREE.MathUtils.degToRad(40))) continue
      if (!this.context.world.visible(origin, zombie.position.clone().add(new THREE.Vector3(0, 1.1, 0)), zombie.actor.root)) continue
      best = zombie; bestDistance = distance
    }
    if (!best) return null
    const point = best.position.clone().add(new THREE.Vector3(0, 1.15, 0))
    return this.applyHit(best, instaKill ? best.health : damage, 'torso', point, flatForward, undefined, undefined)
  }

  private applyHit(zombie: Zombie, damage: number, zone: HitZone, point: THREE.Vector3, direction: THREE.Vector3,
    bone: BoneName | undefined, weapon: Shot['weapon']): ZombieHit {
    const before = zombie.health
    // Whole points, as in Call of Duty: fractional damage left zombies on 0.3 health, and the shot that
    // finished them showed "0".
    const amount = damage > 0 ? Math.max(1, Math.round(damage)) : 0
    zombie.health = Math.max(0, zombie.health - amount)
    const lethal = zombie.health === 0
    const reaction: HitReaction = { zone, point: point.clone(), direction: direction.clone(), lethal, bone, weapon, targetId: zombie.id }
    const fromBehind = direction.x * Math.sin(zombie.yaw) + direction.z * Math.cos(zombie.yaw) > 0.25
    if (lethal) {
      zombie.actor.react(reactionClipName(reaction, fromBehind), true, direction)
      this.kill(zombie)
    } else {
      // Call of Duty zombies barely flinch: a short stagger, no full reaction pause.
      zombie.stagger = Math.max(zombie.stagger, 0.12)
    }
    this.context.onHit?.(reaction)
    this.context.emit({ kind: 'enemy-hit', position: point.clone(), radius: 14, zone })
    return { zombie, reaction, dealt: before - zombie.health, lethal }
  }

  private kill(zombie: Zombie) {
    if (zombie.climb) {
      // Shot off a ladder or a ledge: the body drops to whatever is below.
      const below = this.context.world.floor(zombie.position.clone(), 0.2, 40)
      if (Number.isFinite(below)) zombie.position.y = below
      zombie.actor.root.position.copy(zombie.position)
      zombie.climb = null
    }
    // Shot while climbing out: it falls back where it was, half in the ground.
    if (zombie.rise > 0) { zombie.position.y = zombie.actor.root.position.y; zombie.rise = 0 }
    zombie.actor.root.rotation.set(0, zombie.yaw, 0)
    zombie.state = 'dead'
    zombie.deadFor = 0
    zombie.swing = 0
    zombie.route.length = 0
    zombie.actor.update(0, 'dead', false)
    this.context.emit({ kind: 'enemy-down', position: zombie.position.clone(), radius: 5 })
  }

  /** Every living zombie dies at once (the Nuke power-up). Returns how many. */
  killAll() {
    let count = 0
    for (const zombie of this.zombies) {
      if (zombie.state !== 'chase') continue
      zombie.health = 0
      zombie.actor.react(reactionClipName({ zone: 'torso', lethal: true }, false), true, new THREE.Vector3(-Math.sin(zombie.yaw), 0, -Math.cos(zombie.yaw)))
      this.kill(zombie)
      count++
    }
    return count
  }

  /** Back to an empty field: every actor to the pool. */
  clear() {
    this.plans.clear()
    for (const zombie of this.zombies) { zombie.state = 'idle'; zombie.actor.root.visible = false }
  }

  dispose() {
    this.disposed = true
    this.plans.clear()
    for (const zombie of this.zombies) { zombie.actor.root.removeFromParent(); zombie.actor.dispose() }
    this.zombies.length = 0
  }
}

// ---------------------------------------------------------------- the zombie look

/**
 * Point a bone's +Y axis (glTF bones run along +Y) toward `direction` in world space, keeping the rest
 * of the skeleton, and refresh its children so the next bone in the chain sees the new pose.
 */
export function aimBone(bone: THREE.Object3D, direction: THREE.Vector3) {
  bone.updateWorldMatrix(true, false)
  const world = bone.getWorldQuaternion(scratch.q)
  const current = scratch.d.copy(UP).applyQuaternion(world).normalize()
  const delta = new THREE.Quaternion().setFromUnitVectors(current, scratch.v.copy(direction).normalize())
  const target = delta.multiply(world)
  const parent = bone.parent ? bone.parent.getWorldQuaternion(scratch.p).invert() : new THREE.Quaternion()
  bone.quaternion.copy(parent.multiply(target))
  bone.updateMatrixWorld(true)
}

/** Arms out in front, slightly down; the right arm chops down through a swipe. */
function reachArms(zombie: Zombie) {
  const swingPhase = zombie.swing > 0 ? 1 - zombie.swing / ATTACK.swing : -1
  // Raise, then chop down past horizontal as the swipe lands.
  const right = swingPhase >= 0 ? (swingPhase < ATTACK.windup / ATTACK.swing ? 0.9 : -1.1) : -0.28
  poseArms(zombie, -0.28, right)
}

/** Both arms toward the facing direction, each lifted by its own amount (0 level, positive up). */
function poseArms(zombie: Zombie, left: number, right: number) {
  const bones = zombie.actor.rig.bones
  const forward = new THREE.Vector3(Math.sin(zombie.yaw), 0, Math.cos(zombie.yaw))
  for (const [side, drop] of [['L', left], ['R', right]] as const) {
    aimBone(bones[`upper_arm.${side}`], forward.clone().setY(drop).normalize())
    aimBone(bones[`forearm.${side}`], forward.clone().setY(drop - 0.1).normalize())
  }
}

/**
 * Two small red eyes on the front of the head. The heads are solid black, so the eyes are the one
 * colour on a zombie: red, which means danger. Placed from the head's own vertices in the bind pose,
 * so they sit on the face regardless of how the head bone is oriented.
 */
function addEyes(actor: EnemyActor) {
  const mesh = actor.rig.mesh as THREE.SkinnedMesh
  const bones = mesh.skeleton.bones, head = actor.rig.bones.head
  const headIndex = bones.indexOf(head)
  if (headIndex < 0) return
  const inverse = mesh.skeleton.boneInverses[headIndex]
  const position = mesh.geometry.getAttribute('position'), skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight')
  // Head-bound vertices, in the head bone's local space.
  const local: THREE.Vector3[] = []
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    let weight = 0
    for (let k = 0; k < 4; k++) if (skinIndex.getComponent(i, k) === headIndex) weight += skinWeight.getComponent(i, k)
    if (weight < 0.6) continue
    local.push(v.fromBufferAttribute(position, i).applyMatrix4(inverse).clone())
  }
  if (local.length < 8) return
  // The character faces +Z and stands along +Y in its bind pose; express those in head space.
  const rotation = new THREE.Matrix4().extractRotation(inverse)
  const forward = new THREE.Vector3(0, 0, 1).applyMatrix4(rotation).normalize()
  const up = new THREE.Vector3(0, 1, 0).applyMatrix4(rotation).normalize()
  const right = new THREE.Vector3().crossVectors(up, forward).normalize()
  const centre = local.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(local.length)
  const front = Math.max(...local.map(p => p.clone().sub(centre).dot(forward)))
  const top = Math.max(...local.map(p => p.clone().sub(centre).dot(up)))
  const material = zombieEyeMaterial()
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), material)
    eye.name = 'Zombie eye'
    eye.scale.set(1, 0.72, 0.5)
    eye.position.copy(centre).addScaledVector(forward, front + 0.004).addScaledVector(up, top * 0.28).addScaledVector(right, side * 0.045)
    eye.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward)
    eye.userData.noCollision = true
    head.add(eye)
  }
}
