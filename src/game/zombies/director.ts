import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import type { CollisionWorld } from '../../player/collision'
import { EnemyActor } from '../actors'
import { EnemyNavigation } from '../navigation'
import { rayCapsuleDistance, reactionClipName, type HitReaction, type HitZone } from '../hit-reactions'
import { hitDamage, shotgunDamageMultiplier } from '../balance'
import { BONE_NAMES, type BoneName } from '../../lab/rig'
import type { EmitSound, Shot } from '../types'
import { zombieEyeMaterial } from '../../render/ink'
import { PERCH, type NavGraph } from './navgraph'
import { setDoorOpen } from '../../world/doors'
import { BOSS, PLAYER_HEALTH } from './rules'
import { InkGore, restoreParts, setPartLost } from './gore'
import { BLOT, GasClouds, bloatCentre, bloatDripPoint, setBloat } from './gas'

/**
 * Dead Ink's zombies. They reuse the game's stickman (rig, walk and run animations, death falls,
 * animated hit zones), with the gun hidden, arms reaching forward and red eyes. The brain is simple
 * on purpose: find the nearest living player, path to them, swipe when close.
 *
 * Actors are pooled: loading one takes time, so the director builds them once and revives them each
 * spawn. A zombie is 'idle' in the pool, 'chase' while alive, and 'dead' while its body lies there.
 */
export type ZombieGait = 'walk' | 'run' | 'sprint'
const GAITS: readonly ZombieGait[] = ['walk', 'run', 'sprint']
/** One zombie in a co-op snapshot: see ZombieDirector.snapshot(). */
export type ZombieSnap = [number, number, number, number, number, number, number, number, number, number, number, number]
const round2 = (n: number) => Math.round(n * 100) / 100
/** Metres per second. Players walk at 4.2 and sprint at 7.6: a sprinter keeps up with a walking player and only a sprint gets away. */
export const ZOMBIE_SPEED: Record<ZombieGait, number> = { walk: 1.2, run: 4.4, sprint: 6.2 }

export const ATTACK = {
  /** Start a swipe within this horizontal distance of the target. */
  range: 1.45,
  /** The swipe connects this long after it starts, if the target is still close. Dodgeable. */
  windup: 0.3,
  /** A landed swipe needs the target within this distance at the moment of impact. */
  reach: 1.85,
  /** Whole swipe duration, then a short recovery before the next one. */
  swing: 0.6, recover: 0.45,
} as const
/**
 * A body lies this long, then sinks into the ink and goes back to the pool. Sinking, not vanishing:
 * a body that blinks out of existence reads as a bug.
 */
export const CORPSE = { lie: 6, sink: 2.2, depth: 0.8 } as const
/**
 * Clawing up out of the ground, as Call of Duty's zombies do: how long it takes, how deep the body starts
 * (its feet, in metres), and when each beat lands, as fractions of the whole: a hand bursts up, then the
 * other, both claw down onto the ground, the head and shoulders heave up in two pulls, a knee plants, and it
 * drags itself up to stand (handing over to its normal stance from `stand` on).
 */
export const RISE = {
  seconds: 1.9, depth: 1.62,
  beats: { firstHand: 0.04, secondHand: 0.15, plant: 0.27, knee: 0.6, stand: 0.8 },
} as const
/** Metres per second on ladders and ledges. Walkers are slower, as on the ground. */
export const CLIMB_SPEED = { up: 3.4, down: 4.5, across: 3 } as const
/**
 * A zombie asks to respawn when it cannot reach anyone, is too far from everyone, or simply stops
 * getting closer. The last one matters: a baked map graph can promise a way through that a body cannot
 * actually take, and a chaser would otherwise shuffle in place forever. Call of Duty does the same,
 * moving zombies that cannot path to you back into play near you.
 */
export const STRANDED = { seconds: 7, distance: 75, noProgressSeconds: 6, progressMetres: 1.5, near: 18 } as const
/**
 * A crawler: legs gone, it drags itself along on its arms (Call of Duty's crawlers). Slower than a walker
 * is quick, lower, a shorter swipe. `pitch` is how far the body lies forward from upright (radians); each
 * hand reaches from `back` to `front` metres ahead of its shoulder in the first `swing` of its cycle, then
 * plants and pulls, and the body moves `stride` metres per full cycle (one pull per arm).
 */
export const CRAWL = {
  speed: 1.6, fall: 0.55, pitch: 1.22, climbPace: 0.55,
  front: 0.4, back: 0.02, swing: 0.32, stride: 0.56,
  attack: { range: 1.15, windup: 0.35, reach: 1.55, swing: 0.7, recover: 0.5 },
} as const
/**
 * Gore odds, our own and tuned by play. A blast that does not kill takes the legs (a crawler) or an arm;
 * one that kills may blow the body apart, surer the closer it was. Heavy guns (shotgun pellets, sniper,
 * Magnum) can take a leg (a crawler) or tear off the arm they hit. A headshot kill always pops the head.
 */
export const GORE_ODDS = {
  blastCrawl: 0.45, blastArm: 0.25, gib: 0.6, gibEdge: 0.25, lethalArm: 0.3,
  leg: { shotgun: 0.06, sniper: 0.35, magnum: 0.3 } as Partial<Record<string, number>>,
  arm: { shotgun: 0.1, sniper: 0.5, magnum: 0.4 } as Partial<Record<string, number>>,
} as const
/**
 * The crowd around a player: a zombie that only other zombies block walks round them (up to `orbit`
 * radians off its line), and after `claw` seconds boxed in within `reach` metres beyond its swipe range, it
 * claws over them rather than standing still.
 */
export const CROWD = { claw: 0.5, reach: 1.6, orbit: [1.8, 2.3], near: 5 } as const
/** How long a bullet's jolt lasts. */
const FLINCH_SECONDS = 0.22
/** How much further a zombie reaches when it is clawing up at a player on something it cannot get onto. */
const REACH_UP = 0.8
/** How often the shared flow field is recomputed. */
export const FLOW_INTERVAL = 0.35
/** How long a link that refused a body stays out of the graph. */
export const LINK_BLOCK_SECONDS = 25

export type Zombie = {
  id: string
  actor: EnemyActor
  position: THREE.Vector3
  yaw: number
  /** Walking this frame (for co-op snapshots: the guest animates the walk from it). */
  moving: boolean
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
  /** Seconds before it looks again for standing room beside a player up on something (see perch). */
  perchTimer: number
  /** Seconds left climbing out of the ground. */
  rise: number
  /** How long only other zombies have stood in its way (the crowd around its prey). */
  crowded: number
  /** A ladder or ledge being climbed: a fixed path, no collision. */
  climb: Climb | null
  /** Seconds until it next groans (or screams, if it sprints). */
  voice: number
  /** How this one carries itself: its hunch, its lolling head, its drooping arm, its limp. */
  carriage: Carriage
  /** The side it last stepped around an obstacle on (-1, 1, or 0), and for how much longer it keeps to it. */
  sideBias: number
  sideTimer: number
  /** Whether it can walk straight at its target, and seconds until that is checked again. */
  direct: boolean
  directTimer: number
  /** The Brute: bigger, slower, harder hitting, and it slams the ground. */
  boss: boolean
  /** Seconds left winding up a ground slam (0: not slamming), and until it may slam again. */
  slam: number
  slamTimer: number
  /** Seconds left of the jolt from the last bullet, and where it came from (back, side: -1..1). */
  flinch: number
  flinchBack: number
  flinchSide: number
  /** Legs gone: it drags itself on its arms. Seconds left of falling onto its front, and metres crawled (its arm cycle). */
  crawler: boolean
  crawlFall: number
  crawled: number
  /** The crawl pose as shown, eased: body pitch forward from upright (radians) and hip height (metres). */
  pitch: number
  lift: number
  /** The Blot: swollen with ink, it bursts into poison gas when it dies. Seconds to its next drip. */
  blot: boolean
  drip: number
  /** Parts lost to gore (the legs are `crawler`), and whether a blast blew it apart. */
  lost: { head: boolean; L: boolean; R: boolean }
  gibbed: boolean
}

type Carriage = { lean: number; nod: number; tilt: number; droopL: number; droopR: number; limp: number; phase: number }

/** No two zombies walk alike: a hunch, a head lolled to one side, one arm hanging lower, maybe a limp. */
function randomCarriage(gait: ZombieGait): Carriage {
  const r = Math.random, side = r() < 0.5 ? -1 : 1
  return {
    lean: 0.32 + r() * 0.3 + (gait === 'sprint' ? 0.15 : 0),
    nod: 0.08 + r() * 0.22,
    tilt: side * (0.08 + r() * 0.3),
    droopL: r() < 0.5 ? r() * 0.55 : 0,
    droopR: r() < 0.5 ? r() * 0.55 : 0,
    limp: gait === 'walk' && r() < 0.6 ? 0.05 + r() * 0.08 : 0,
    phase: r() * Math.PI * 2,
  }
}

const bendEuler = new THREE.Euler(), bendQuaternion = new THREE.Quaternion()
/** Add a rotation in the bone's rest frame (the rig's own convention: +X leans forward, +Z tips right). */
function bend(bone: THREE.Object3D, x: number, y: number, z: number) {
  bone.quaternion.multiply(bendQuaternion.setFromEuler(bendEuler.set(x, y, z, 'ZYX')))
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
  /** The Brute's fists hit the ground here, shaking everything within `radius`. */
  onSlam?: (position: THREE.Vector3, radius: number) => void
  /** Load one actor; checks substitute a stub. Defaults to the real stickman. */
  actorFactory?: () => Promise<EnemyActor>
  /** The map-wide walking graph. Without one, zombies only chase what they can walk to in a straight line. */
  graph?: NavGraph
}

export type ZombieHit = { zombie: Zombie; reaction: HitReaction; dealt: number; lethal: boolean }

const UP = new THREE.Vector3(0, 1, 0)
const BODY_CENTRE = new THREE.Vector3(0, 0.75, 0)
const scratch = { q: new THREE.Quaternion(), p: new THREE.Quaternion(), d: new THREE.Vector3(), v: new THREE.Vector3(),
  f: new THREE.Vector3(), s: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), t: new THREE.Vector3(), e: new THREE.Vector3() }

const SIDESTEP = [0.45, 0.9, 1.35], SIDESTEP_CROWD = [...SIDESTEP, ...CROWD.orbit]
const doorFrom = new THREE.Vector3(), doorTo = new THREE.Vector3()
const reachSpot = new THREE.Vector3(), reachFrom = new THREE.Vector3(), NO_ONE = new THREE.Object3D()

/**
 * Whether a body standing at `from` may be put on graph spot `spot`: never one behind the wall it stands
 * against (a player pressed to the warehouse wall was put on the spot inside it, and the horde went in
 * there). A knee-high sight line, and only for a spot not right underfoot. The flow field starts from
 * the players' spots by this rule, and each zombie finds its own by it.
 */
export function spotInReach(graph: NavGraph, world: CollisionWorld, spot: number, from: THREE.Vector3) {
  const p = graph.point(spot, reachSpot)
  if ((p.x - from.x) ** 2 + (p.z - from.z) ** 2 < 0.36 && Math.abs(p.y - from.y) < 0.5) return true
  reachFrom.copy(from).y += 0.55
  p.y += 0.55
  return world.visible(reachFrom, p, NO_ONE)
}
/** Do the flat segments p-q and a-b cross? */
function crossesFlat(p: THREE.Vector3, q: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const side = (o: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3) => (u.x - o.x) * (v.z - o.z) - (u.z - o.z) * (v.x - o.x)
  return side(a, b, p) * side(a, b, q) < 0 && side(p, q, a) * side(p, q, b) < 0
}
/** Knee to sole in the rest pose (the rig has no foot bone). */
const SHIN_LENGTH = 0.405
/** The climb out of the ground hands over to the normal stance through these, blended bone by bone. */
const RISE_BONES = BONE_NAMES
const risePose = { quaternions: RISE_BONES.map(() => new THREE.Quaternion()), hips: new THREE.Vector3(), root: new THREE.Vector3(), rotation: new THREE.Quaternion() }
const rs = { shoulder: new THREE.Vector3(), target: new THREE.Vector3(), point: new THREE.Vector3(), pole: new THREE.Vector3() }

export class ZombieDirector {
  readonly zombies: Zombie[] = []
  readonly navigation: EnemyNavigation
  private disposed = false
  private stepCapsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.27)
  private flowTimer = 0
  private time = 0
  /** Fine route plans, for the rare zombie the flow field cannot step along (a narrow gate, a doorway edge). */
  private plans = new Map<Zombie, Generator<void, THREE.Vector3[]>>()
  /** Each door's opening, hinge to latch at its floor, for pushDoors. */
  private openings = new Map<THREE.Group, { a: THREE.Vector3; b: THREE.Vector3; centre: THREE.Vector3; reach: number }>()
  /** Whether a body at `from` may be put on graph spot `spot` (see spotInReach). */
  private inReach = (spot: number, from: THREE.Vector3) => spotInReach(this.context.graph!, this.context.world, spot, from)
  /** Links taken out of the graph for refusing a body, and when each goes back in (see blockLink). */
  private blockedLinks: { key: number; until: number }[] = []
  /** Ink chunks, drops, splats and torn-off limbs; the Blots' poison clouds. Both updated with the zombies. */
  readonly gore: InkGore
  readonly gas: GasClouds
  /** Dice for gore; checks swap in their own. */
  random: () => number = Math.random

  constructor(private context: ZombieContext) {
    this.navigation = new EnemyNavigation(context.world, context.doors, context.emit)
    this.gore = new InkGore(context.scene)
    this.gas = new GasClouds(context.scene)
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
        id: `zombie-${i + 1}`, actor, position: new THREE.Vector3(), yaw: 0, moving: false, health: 0, maxHealth: 0, gait: 'walk',
        state: 'idle', stuck: 0, unreachable: 0, swing: 0, swingLanded: false,
        recover: 0, stagger: 0, deadFor: 0, stranded: false, footstep: 0, route: [], routeTimer: 0, routeNode: -1, routeFrom: -1, blocked: -1, avoidTimer: 0, edgeFail: 0, probeFail: -1, probeFails: 0, bestDistance: Infinity, noProgress: 0, perchTimer: 0,
        rise: 0, crowded: 0, climb: null, voice: 0, carriage: randomCarriage('walk'), flinch: 0, flinchBack: 0, flinchSide: 0,
        boss: false, slam: 0, slamTimer: 0, direct: false, directTimer: 0, sideBias: 0, sideTimer: 0,
        crawler: false, crawlFall: 0, crawled: 0, pitch: 0, lift: 0.82, blot: false, drip: 0, lost: { head: false, L: false, R: false }, gibbed: false,
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
  spawn(position: THREE.Vector3, health: number, gait: ZombieGait, facing = 0, rise = false, boss = false, blot = false): Zombie | null {
    const zombie = this.zombies.find(z => z.state === 'idle')
    if (!zombie) return null
    const floor = this.navigation.floor(position)
    if (!floor) return null
    this.wake(zombie, floor, health, gait, facing, rise, boss, blot)
    if (rise) this.context.onRise?.(zombie.position.clone())
    return zombie
  }

  /** Bring a pooled body into play at `at`, whole and fresh (spawn, and co-op puppets on the guest). */
  private wake(zombie: Zombie, at: THREE.Vector3, health: number, gait: ZombieGait, facing: number, rise: boolean, boss: boolean, blot: boolean) {
    zombie.position.copy(at)
    zombie.yaw = facing
    zombie.moving = false
    zombie.health = zombie.maxHealth = health
    zombie.gait = gait
    zombie.state = 'chase'
    zombie.stuck = 0; zombie.unreachable = 0
    zombie.swing = 0; zombie.swingLanded = false; zombie.recover = 0; zombie.stagger = 0; zombie.deadFor = 0
    zombie.stranded = false; zombie.footstep = 0
    zombie.route = []; zombie.routeTimer = 0; zombie.routeNode = -1; zombie.routeFrom = -1; zombie.blocked = -1; zombie.avoidTimer = 0; zombie.edgeFail = 0; zombie.probeFail = -1; zombie.probeFails = 0
    zombie.bestDistance = Infinity; zombie.noProgress = 0; zombie.perchTimer = 0
    zombie.rise = rise ? RISE.seconds : 0; zombie.climb = null; zombie.crowded = 0
    zombie.voice = 1 + Math.random() * 3
    zombie.carriage = randomCarriage(gait); zombie.flinch = 0
    zombie.boss = boss; zombie.slam = 0; zombie.slamTimer = BOSS.slam.every * 0.6
    zombie.direct = false; zombie.directTimer = 0; zombie.sideBias = 0; zombie.sideTimer = 0
    if (boss) zombie.carriage.lean += 0.15
    // Whole again, whatever happened to this body last time.
    zombie.crawler = false; zombie.crawlFall = 0; zombie.crawled = 0; zombie.pitch = 0; zombie.lift = 0.82
    zombie.lost.head = zombie.lost.L = zombie.lost.R = false; zombie.gibbed = false
    zombie.blot = blot && !boss; zombie.drip = 0.5
    if (zombie.blot) {
      // Weighed down by its belly: a heavy lean, a limp, both arms hanging low.
      const c = zombie.carriage
      c.lean += 0.12; c.limp = 0.12 + Math.random() * 0.04; c.droopL = 0.3 + Math.random() * 0.2; c.droopR = 0.3 + Math.random() * 0.2
    }
    this.plans.delete(zombie)
    const { actor } = zombie
    actor.root.scale.setScalar(boss ? BOSS.scale : 1)
    setSpikes(actor, boss)
    restoreParts(actor)
    setBloat(actor, zombie.blot)
    actor.root.position.copy(zombie.position)
    if (rise) actor.root.position.y -= RISE.depth
    actor.root.rotation.set(0, zombie.yaw, 0)
    actor.restore('patrol')
    // restore() puts the guard's gun back in its hand; a zombie never carries one.
    actor.gun.visible = false
    actor.root.visible = true
  }

  /** Move a living zombie somewhere else (a stranded one, back into play). Keeps its health. */
  relocate(zombie: Zombie, position: THREE.Vector3) {
    const floor = this.navigation.floor(position)
    if (!floor || zombie.state !== 'chase') return false
    zombie.position.copy(floor)
    zombie.actor.root.position.copy(floor)
    zombie.stuck = 0; zombie.unreachable = 0; zombie.stranded = false
    zombie.route = []; zombie.routeTimer = 0; zombie.routeNode = -1; zombie.blocked = -1
    zombie.bestDistance = Infinity; zombie.noProgress = 0; zombie.probeFail = -1; zombie.probeFails = 0; zombie.perchTimer = 0
    zombie.rise = 0; zombie.climb = null
    zombie.actor.root.rotation.set(0, zombie.yaw, 0)
    this.plans.delete(zombie)
    return true
  }

  update(dt: number, targets: readonly ZombieTarget[]) {
    this.time += dt
    this.restoreLinks()
    // One flow field for the whole crowd, a few times a second: walking distance from everywhere to
    // the nearest player. Every zombie then just walks downhill on it.
    this.flowTimer -= dt
    const graph = this.context.graph
    if (graph && this.flowTimer <= 0) {
      const sources = targets.filter(t => t.alive).map(t => t.feet)
      // Only restart the clock on a real refresh: with every player down there is nothing to flow to, and
      // the first update after a revive must not judge progress on the old field.
      if (sources.length) { graph.flow(sources, this.inReach); this.flowTimer = FLOW_INTERVAL }
    }
    this.advanceFinePlans()
    this.gore.update(dt)
    this.gas.update(dt)
    for (const zombie of this.zombies) {
      if (zombie.state === 'idle') continue
      if (zombie.state === 'dead') {
        zombie.deadFor += dt
        // A crawler has no death clip: it slumps flat where it lies.
        if (zombie.crawler) this.crawlPose(zombie, dt, 'dead')
        else zombie.actor.update(dt, 'dead', false)
        const sinking = zombie.deadFor - CORPSE.lie
        if (sinking > 0) zombie.actor.root.position.y = (zombie.crawler ? zombie.actor.root.position.y : zombie.position.y) - CORPSE.depth * Math.min(1, sinking / CORPSE.sink)
        if (sinking >= CORPSE.sink) { zombie.state = 'idle'; zombie.actor.root.visible = false }
        continue
      }
      const target = this.nearest(zombie, targets)
      if (zombie.rise > 0) { this.rise(zombie, target, dt); continue }
      zombie.voice -= dt
      if (zombie.voice <= 0) {
        // Groans carry; sprinters scream, and more often.
        const sprint = zombie.gait === 'sprint' && !zombie.boss && !zombie.crawler && !zombie.blot
        zombie.voice = sprint ? 2.5 + Math.random() * 3 : 3.5 + Math.random() * 5
        this.context.emit({ kind: zombie.boss ? 'boss-growl' : zombie.blot ? 'blot-gurgle' : sprint ? 'zombie-scream' : 'zombie-groan',
          position: zombie.position.clone().setY(zombie.position.y + (zombie.crawler ? 0.4 : 1.6)), radius: zombie.boss ? 70 : 32 })
      }
      if (zombie.blot && (zombie.drip -= dt) <= 0) {
        // Ink dripping off the belly leaves a trail of spots behind it.
        zombie.drip = 0.14 + this.random() * 0.2
        this.gore.drip(bloatDripPoint(zombie.actor, scratch.t), zombie.position.y)
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
        const attack = attackOf(zombie)
        // A player up on a desk or a crate, with the chairs or the edge keeping this one from getting
        // closer: it claws up at them from where it stands, as Call of Duty's zombies do.
        const up = target.feet.y - zombie.position.y
        const extra = up > 0.4 && up < 1.5 && !zombie.moving && !zombie.crawler ? REACH_UP : 0
        if (zombie.boss) {
          zombie.slamTimer -= dt
          if (zombie.slam > 0) {
            zombie.slam -= dt
            this.face(zombie, target.feet, dt, 3)
            if (zombie.slam <= 0) this.slamDown(zombie, targets)
          } else if (zombie.slamTimer <= 0 && zombie.swing <= 0 && flat < BOSS.slam.radius * 0.8 && level) {
            zombie.slam = BOSS.slam.windup
            this.context.emit({ kind: 'boss-roar', position: zombie.position.clone().setY(zombie.position.y + 3), radius: 90 })
          }
        }
        if (zombie.slam > 0) {
          // Winding up the slam: planted, fists raised.
        } else if (zombie.swing > 0) {
          zombie.swing -= dt
          this.face(zombie, target.feet, dt, zombie.boss ? 5 : 10)
          const elapsed = attack.swing - zombie.swing
          if (!zombie.swingLanded && elapsed >= attack.windup) {
            zombie.swingLanded = true
            const now = Math.hypot(target.feet.x - zombie.position.x, target.feet.z - zombie.position.z)
            // Only if nothing solid stands between them: no swipes through walls or windows.
            if (target.alive && now <= attack.reach + extra && Math.abs(target.feet.y - zombie.position.y) < 1.5 && this.canTouch(zombie, target.feet))
              this.context.damagePlayer(target.id, attack.damage, zombie.position.clone().add(new THREE.Vector3(0, zombie.crawler ? 0.4 : 1.3, 0)))
            this.context.emit({ kind: 'zombie-swipe', position: zombie.position.clone(), radius: 10 })
          }
          if (zombie.swing <= 0) zombie.recover = attack.recover
        } else if (flat <= attack.range + extra && (level || extra > 0) && zombie.recover <= 0 && zombie.stagger <= 0) {
          zombie.swing = attack.swing; zombie.swingLanded = false
          this.context.emit({ kind: zombie.boss ? 'boss-growl' : 'zombie-snarl', position: zombie.position.clone().setY(zombie.position.y + 1.6), radius: 14 })
        } else if (zombie.crowded > CROWD.claw && flat <= attack.range + CROWD.reach && level && zombie.recover <= 0 && zombie.stagger <= 0 && !zombie.crawler) {
          // Behind the front row with no way round: it claws at its prey over the others instead of
          // standing there. Out of reach, so it cannot land, and quiet, or a crowd would never stop snarling.
          zombie.swing = attack.swing; zombie.swingLanded = false; zombie.crowded = 0
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
        // Never one close by: a crowd jammed around the player (or around the Brute) is making no
        // walking progress, yet moving it away would make it vanish from the fight.
        zombie.stranded = flat > STRANDED.near && (zombie.unreachable > STRANDED.seconds || flat > STRANDED.distance
          || zombie.noProgress > STRANDED.noProgressSeconds)
      }
      zombie.moving = moving
      zombie.flinch = Math.max(0, zombie.flinch - dt)
      if (zombie.crawler) {
        zombie.crawlFall = Math.max(0, zombie.crawlFall - dt)
        // The clips only keep the actor's bookkeeping going: the crawl pose owns every bone that shows.
        zombie.actor.update(dt, 'patrol', false, undefined, 0)
        zombie.actor.gun.visible = false
        this.crawlPose(zombie, dt, 'crawl', target?.feet)
        continue
      }
      zombie.actor.root.position.copy(zombie.position)
      // A limp rocks the whole body in step with the walk.
      const roll = moving ? zombie.carriage.limp * Math.sin(this.time * 5.2 + zombie.carriage.phase) : 0
      zombie.actor.root.rotation.set(0, zombie.yaw, roll, 'YXZ')
      zombie.actor.update(dt, 'patrol', moving, undefined, moving ? speedOf(zombie) : 0)
      zombie.actor.gun.visible = false
      this.carry(zombie, moving)
      reachArms(zombie, moving ? this.time : -1)
    }
  }

  /**
   * Co-op, the host's side: every body in play as a row of numbers for the guest (see ZombieSnap):
   * [pool index, state (1 up, 2 dead), x, y, z, yaw, gait, moving, swing left, flags, rise left, health].
   */
  snapshot(): ZombieSnap[] {
    const rows: ZombieSnap[] = []
    this.zombies.forEach((z, i) => {
      if (z.state === 'idle') return
      const flags = (z.crawler ? 1 : 0) | (z.blot ? 2 : 0) | (z.boss ? 4 : 0) | (z.lost.head ? 8 : 0) | (z.lost.L ? 16 : 0) | (z.lost.R ? 32 : 0)
        | (z.gibbed ? 64 : 0) | (z.climb ? 128 : 0) | (z.slam > 0 ? 256 : 0)
      // Climbing out of the ground is posed from where it stands, so the guest needs that spot, not the body's.
      const p = z.climb ? z.actor.root.position : z.position
      rows.push([i, z.state === 'dead' ? 2 : 1, round2(p.x), round2(p.y), round2(p.z), round2(z.yaw), GAITS.indexOf(z.gait),
        z.moving ? 1 : 0, round2(z.swing), flags, round2(z.rise), z.maxHealth > 0 ? round2(z.health / z.maxHealth) : 0])
    })
    return rows
  }

  /**
   * Co-op, the guest's side: no thinking at all. Each body goes where the host's snapshot says, eases
   * toward it between snapshots, and is drawn exactly as the host draws it: the walk, the swipe, the climb
   * out of the ground, the crawl, the Blot's belly, the Brute, heads and arms coming off, and death.
   */
  puppet(dt: number, rows: readonly ZombieSnap[], look?: THREE.Vector3) {
    this.time += dt
    this.gore.update(dt)
    this.gas.update(dt)
    const seen = new Set<number>()
    const follow = 1 - Math.exp(-dt * 14)
    for (const row of rows) {
      const [index, state, x, y, z, yaw, gait, moving, swing, flags, rise, health] = row
      const zombie = this.zombies[index]
      if (!zombie) continue
      seen.add(index)
      const goal = scratch.t.set(x, y, z)
      if (zombie.state === 'idle') {
        if (state !== 1) continue
        this.wake(zombie, goal, 1, GAITS[gait] ?? 'walk', yaw, rise > 0, !!(flags & 4), !!(flags & 2))
        zombie.rise = rise
      }
      if (zombie.state === 'chase') {
        const away = scratch.v.set(-Math.sin(zombie.yaw), 0, -Math.cos(zombie.yaw))
        if (flags & 1 && !zombie.crawler) this.makeCrawler(zombie, away)
        if (flags & 16) this.loseArm(zombie, 'L', away)
        if (flags & 32) this.loseArm(zombie, 'R', away)
        if (flags & 64 && !zombie.gibbed) this.gib(zombie, away)
        else if (flags & 8 && !zombie.lost.head) this.popHead(zombie, away)
        if (state === 2) { zombie.position.copy(goal); this.kill(zombie) }
      }
      if (zombie.state === 'dead') { this.lieDead(zombie, dt); continue }
      // Ease toward the host's place; a big jump (a relocated body) snaps.
      if (zombie.position.distanceToSquared(goal) > 9) zombie.position.copy(goal)
      else zombie.position.lerp(goal, follow)
      const turn = Math.atan2(Math.sin(yaw - zombie.yaw), Math.cos(yaw - zombie.yaw))
      zombie.yaw += turn * follow
      zombie.gait = GAITS[gait] ?? zombie.gait
      zombie.health = health * zombie.maxHealth
      const swingStarted = swing > 0 && zombie.swing <= 0
      zombie.swing = swing
      zombie.slam = flags & 256 ? 1 : 0
      if (swingStarted) this.context.emit({ kind: zombie.boss ? 'boss-growl' : 'zombie-snarl', position: zombie.position.clone().setY(zombie.position.y + 1.6), radius: 14 })
      zombie.voice -= dt
      if (zombie.voice <= 0) {
        const sprint = zombie.gait === 'sprint' && !zombie.boss && !zombie.crawler && !zombie.blot
        zombie.voice = sprint ? 2.5 + Math.random() * 3 : 3.5 + Math.random() * 5
        this.context.emit({ kind: zombie.boss ? 'boss-growl' : zombie.blot ? 'blot-gurgle' : sprint ? 'zombie-scream' : 'zombie-groan',
          position: zombie.position.clone().setY(zombie.position.y + (zombie.crawler ? 0.4 : 1.6)), radius: zombie.boss ? 70 : 32 })
      }
      if (rise > 0) { const before = zombie.rise; zombie.rise = rise; this.rise(zombie, null, 0, before > rise ? before : rise); continue }
      zombie.rise = 0
      if (zombie.crawler) {
        zombie.crawlFall = Math.max(0, zombie.crawlFall - dt)
        zombie.actor.update(dt, 'patrol', false, undefined, 0)
        zombie.actor.gun.visible = false
        this.crawlPose(zombie, dt, flags & 128 ? 'climb' : 'crawl', look)
        continue
      }
      const walking = moving === 1 || !!(flags & 128)
      zombie.moving = walking
      zombie.actor.root.position.copy(zombie.position)
      const roll = walking ? zombie.carriage.limp * Math.sin(this.time * 5.2 + zombie.carriage.phase) : 0
      zombie.actor.root.rotation.set(0, zombie.yaw, roll, 'YXZ')
      zombie.actor.update(dt, 'patrol', walking, undefined, walking ? speedOf(zombie) : 0)
      zombie.actor.gun.visible = false
      this.carry(zombie, walking)
      reachArms(zombie, walking ? this.time : -1)
    }
    // Bodies the host no longer has: the dead finish sinking here, anything else is gone.
    this.zombies.forEach((zombie, index) => {
      if (seen.has(index) || zombie.state === 'idle') return
      if (zombie.state === 'dead') this.lieDead(zombie, dt)
      else { zombie.state = 'idle'; zombie.actor.root.visible = false }
    })
  }

  /** A clear line from the zombie's chest to the target's chest: its claws can reach, no wall between. */
  private canTouch(zombie: Zombie, feet: THREE.Vector3) {
    const chest = zombie.position.clone().setY(zombie.position.y + (zombie.crawler ? 0.4 : 1.2) * (zombie.boss ? BOSS.scale : 1))
    return this.context.world.visible(chest, feet.clone().setY(feet.y + 1.2), zombie.actor.root)
  }

  /** A body on the ground: its death pose, then it sinks into the paper and goes back to the pool. */
  private lieDead(zombie: Zombie, dt: number) {
    zombie.deadFor += dt
    if (zombie.crawler) this.crawlPose(zombie, dt, 'dead')
    else zombie.actor.update(dt, 'dead', false)
    const sinking = zombie.deadFor - CORPSE.lie
    if (sinking > 0) zombie.actor.root.position.y = (zombie.crawler ? zombie.actor.root.position.y : zombie.position.y) - CORPSE.depth * Math.min(1, sinking / CORPSE.sink)
    if (sinking >= CORPSE.sink) { zombie.state = 'idle'; zombie.actor.root.visible = false }
  }

  /**
   * Clawing out of the ground (see RISE): it cannot walk or swipe until it is out, but it can be shot. The
   * pose is a pure function of the time left, so a co-op guest draws exactly what the host does; `before`
   * is the time left last frame, for the bursts of dirt as each beat passes.
   */
  private rise(zombie: Zombie, target: ZombieTarget | null, dt: number, before = zombie.rise) {
    zombie.rise = Math.max(0, zombie.rise - dt)
    const u = 1 - zombie.rise / RISE.seconds, beats = RISE.beats
    // It turns toward its prey while it can; once both hands are planted it only shifts a little.
    if (target) this.face(zombie, target.feet, dt, u < beats.plant ? 2.5 : 1)
    this.riseDirt(zombie, 1 - before / RISE.seconds, u)
    const { actor } = zombie, bones = actor.rig.bones
    // Its normal stance, which the climb hands over to from `stand` on.
    const blend = THREE.MathUtils.smoothstep(u, beats.stand, 1)
    actor.root.position.copy(zombie.position)
    actor.root.rotation.set(0, zombie.yaw, 0)
    actor.update(dt, 'patrol', false, undefined, 0)
    actor.gun.visible = false
    if (blend >= 1) { this.carry(zombie, false); reachArms(zombie); return }
    if (blend > 0) {
      this.carry(zombie, false); reachArms(zombie)
      for (let i = 0; i < RISE_BONES.length; i++) risePose.quaternions[i].copy(bones[RISE_BONES[i]].quaternion)
      risePose.hips.copy(bones.hips.position)
      risePose.root.copy(actor.root.position); risePose.rotation.copy(actor.root.quaternion)
    }
    this.climbOut(zombie, u)
    if (blend > 0) {
      for (let i = 0; i < RISE_BONES.length; i++) bones[RISE_BONES[i]].quaternion.slerp(risePose.quaternions[i], blend)
      bones.hips.position.lerp(risePose.hips, blend)
      actor.root.position.lerp(risePose.root, blend)
      actor.root.quaternion.slerp(risePose.rotation, blend)
    }
    actor.root.updateMatrixWorld(true)
  }

  /**
   * The climb itself at `u` (0 to 1 of RISE), posed from the rest pose each frame: where the hips are, how
   * far the body pitches over the hole, and where each hand, knee and foot is put, the limbs solved to reach.
   */
  private climbOut(zombie: Zombie, u: number) {
    const { actor } = zombie, bones = actor.rig.bones, rest = actor.rig.rest, c = zombie.carriage, b = RISE.beats
    const s = zombie.boss ? BOSS.scale : 1, ground = zombie.position.y, hole = zombie.position
    const ease = (from: number, to: number) => THREE.MathUtils.smoothstep(u, from, to)
    const forward = scratch.f.set(Math.sin(zombie.yaw), 0, Math.cos(zombie.yaw))
    const left = scratch.s.set(Math.cos(zombie.yaw), 0, -Math.sin(zombie.yaw))
    // Two heaves between planting the hands and the knee: each pull jerks the body up, then it hangs a beat.
    const pullT = THREE.MathUtils.clamp((u - b.plant) / (b.knee - b.plant), 0, 1)
    const pulled = pullT - Math.sin(pullT * Math.PI * 4) / (Math.PI * 4)
    const pulling = u > b.plant && u < b.knee ? Math.sin(pullT * Math.PI * 4) : 0
    // Straining against the ground: a tremor through the body until it is up.
    const strain = u < b.stand ? (Math.sin(u * 83) * 0.6 + Math.sin(u * 51 + c.phase) * 0.4) * (1 - ease(b.knee, b.stand)) : 0
    // Hips height above the ground (negative is still under it) and how far the whole body pitches forward.
    // Bent double in the hole, head tucked, so the hands break the surface before the head does.
    const hipsHeight = -0.95 + 0.26 * ease(0, b.firstHand + 0.08) + 0.08 * ease(b.secondHand, b.plant) + 0.61 * pulled
      + 0.44 * ease(b.knee, b.knee + 0.12) + 0.4 * ease(b.stand, 1) + 0.012 * strain
    const pitch = 0.6 + 0.15 * pulled - 0.3 * ease(b.knee, b.stand) - 0.45 * ease(b.stand, 1) + 0.05 * pulling
    const hips = scratch.b.copy(hole).addScaledVector(forward, (0.04 + 0.14 * pulled - 0.18 * ease(b.knee, 1)) * s)
    hips.y = ground + hipsHeight * s
    actor.rig.resetPose()
    actor.root.rotation.set(pitch, zombie.yaw, 0.04 * strain + 0.05 * pulling, 'YXZ')
    actor.root.position.copy(hips).sub(scratch.a.copy(rest.hips.pos).multiplyScalar(s).applyEuler(actor.root.rotation))
    // The back rounds over the hole and the chest heaves with each pull; the head cranes up at its prey once
    // it is out, against the pitch of the body.
    const out = ease(b.plant, b.knee)
    bend(bones.spine, 0.12 * out + 0.06 * pulling, 0, 0.05 * strain)
    bend(bones.chest, 0.1 * out - 0.12 * pulling * out, 0.12 * pulling, 0)
    const tuck = 0.8 * (1 - ease(b.plant - 0.04, b.plant + 0.12))
    const lookUp = (pitch + 0.2) * ease(b.plant, b.plant + 0.15) * (1 - ease(b.stand, 1))
    bend(bones.neck, (tuck - lookUp) * 0.45, 0, 0)
    bend(bones.head, (tuck - lookUp) * 0.55 + c.nod * ease(b.knee, 1), 0.1 * strain, c.tilt * ease(b.knee, 1))
    actor.root.updateMatrixWorld(true)
    // The hands: each bursts up through the ground, claws the air, slams down ahead of the hole, scrapes
    // back with its pull, and lets go as the body comes up onto its knee.
    for (const [key, sign, burst, slam] of [['R', -1, b.firstHand, b.plant], ['L', 1, b.secondHand - 0.02, b.plant + 0.06]] as const) {
      if (zombie.lost[key]) continue
      const upper = bones[`upper_arm.${key}`]
      const shoulder = upper.getWorldPosition(rs.shoulder)
      // Straight up from the shoulder, through the ground.
      const target = rs.target.copy(shoulder).addScaledVector(left, sign * 0.06 * s)
      target.y = ground + (-0.3 + 0.8 * ease(burst, burst + 0.08) + 0.06 * Math.sin(u * 40 + sign)) * s
      // Down onto the ground, a forearm's length ahead, then dragged back toward the body with each pull.
      const planted = ease(slam - 0.04, slam)
      const scrape = key === 'R' ? Math.max(0, pulling) : Math.max(0, -pulling)
      target.lerp(rs.point.copy(hole).addScaledVector(forward, (0.5 - 0.14 * scrape) * s).addScaledVector(left, sign * 0.26 * s)
        .setY(ground + 0.03 * s + 0.05 * s * scrape), planted)
      // Letting go: the arm comes up into the zombie's reach.
      const release = ease(b.knee + 0.06, b.stand + 0.08)
      if (release > 0) target.lerp(rs.point.copy(shoulder).addScaledVector(forward, 0.42 * s).setY(shoulder.y - 0.12 * s), release)
      const pole = rs.pole.copy(left).multiplyScalar(sign * 0.8).addScaledVector(UP, 0.4).addScaledVector(forward, -0.3)
      // A fist punching up points up; a claw on the ground points ahead and down.
      solveArm(upper, bones[`forearm.${key}`], bones[`hand.${key}`], target, pole, forward, (1 - planted) * (1 - release) > 0.5 ? UP : undefined)
    }
    // The legs: dangling in the hole, then the right knee plants in front and the left foot beside it, and
    // both straighten as it stands.
    const knee = ease(b.knee - 0.04, b.knee + 0.1), stand = ease(b.stand, 1)
    for (const [key, sign] of [['R', -1], ['L', 1]] as const) {
      const thigh = bones[`thigh.${key}`]
      const hip = thigh.getWorldPosition(rs.shoulder)
      const foot = rs.target.copy(hip).addScaledVector(forward, 0.05 * s).setY(hip.y - 0.78 * s)
      const pole = rs.pole.copy(forward)
      if (key === 'R') {
        // Kneeling: the knee on the ground just ahead of the hips, the shin back along the ground.
        foot.lerp(rs.point.copy(hole).addScaledVector(forward, -0.34 * s).addScaledVector(left, -0.12 * s).setY(ground + 0.05 * s), knee)
        pole.addScaledVector(UP, -0.9 * knee)
      } else {
        // Its other foot planted beside the hole, knee up, ready to push.
        foot.lerp(rs.point.copy(hole).addScaledVector(forward, 0.26 * s).addScaledVector(left, 0.14 * s).setY(ground + 0.02 * s), knee)
        pole.addScaledVector(UP, 0.3 * knee)
      }
      // Standing: feet under the hips.
      foot.lerp(rs.point.copy(hole).addScaledVector(left, sign * 0.11 * s).setY(ground + 0.02 * s), stand)
      solveLeg(thigh, bones[`shin.${key}`], foot, pole.normalize(), s)
    }
  }

  /** Earth thrown up as each beat of the climb lands: the hands bursting through, the knee, tearing free. */
  private riseDirt(zombie: Zombie, from: number, to: number) {
    if (to <= from) return
    const b = RISE.beats, s = zombie.boss ? BOSS.scale : 1, ground = zombie.position.y
    const passed = (beat: number) => from < beat && to >= beat
    const at = (forwardBy: number, side: number) => scratch.t.copy(zombie.position)
      .addScaledVector(scratch.f.set(Math.sin(zombie.yaw), 0, Math.cos(zombie.yaw)), forwardBy * s)
      .addScaledVector(scratch.s.set(Math.cos(zombie.yaw), 0, -Math.sin(zombie.yaw)), side * s).setY(ground + 0.04)
    const burst = (point: THREE.Vector3, drops: number, clods: number, speed: number) => {
      this.gore.spray(point, UP, drops, ground, speed, false)
      if (clods) this.gore.fling(point, UP, clods, ground, 0.55 * s, 1.3, 1.2)
    }
    if (passed(b.firstHand + 0.03)) burst(at(0.12, -0.2), 10, 3, 2.2)
    if (passed(b.secondHand + 0.03)) burst(at(0.12, 0.2), 10, 3, 2.2)
    if (passed(b.plant)) burst(at(0.5, -0.26), 4, 0, 1.2)
    if (passed(b.plant + 0.06)) burst(at(0.5, 0.26), 4, 0, 1.2)
    if (passed(b.knee + 0.06)) burst(at(0.1, -0.12), 6, 2, 1.6)
    if (passed(b.stand)) burst(at(0, 0), 8, 3, 2)
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
  private startClimb(zombie: Zombie, from: number, to: number, points: THREE.Vector3[], key = from < to ? `${from}:${to}` : `${to}:${from}`) {
    if (this.zombies.some(z => z !== zombie && z.state === 'chase' && z.climb?.key === key && z.climb.travelled < 0.9)) return false
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
    // A crawler pulls itself up hand over hand, slowly; the Blot is slow too.
    const pace = zombie.crawler ? CRAWL.climbPace : zombie.blot ? 0.75 : zombie.gait === 'walk' ? 0.85 : zombie.gait === 'sprint' ? 1.25 : 1
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
    if (zombie.crawler) {
      if (!vertical) zombie.crawled += CLIMB_SPEED.across * pace * dt
      actor.update(dt, 'patrol', false, undefined, 0)
      actor.gun.visible = false
      this.crawlPose(zombie, dt, vertical ? 'climb' : 'crawl')
      return
    }
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

  /**
   * The zombie posture over the walk cycle: hunched and head lolling, thrown forward into a swipe, and
   * jolted back by a bullet.
   */
  private carry(zombie: Zombie, moving: boolean) {
    const c = zombie.carriage, bones = zombie.actor.rig.bones
    const swingPhase = zombie.swing > 0 ? 1 - zombie.swing / attackOf(zombie).swing : -1
    // The lunge peaks as the claw comes down.
    const lunge = swingPhase >= 0 ? Math.sin(Math.PI * Math.min(1, swingPhase / 0.75)) : 0
    const jolt = zombie.flinch > 0 ? Math.sin(Math.PI * zombie.flinch / FLINCH_SECONDS) : 0
    const sway = moving ? Math.sin(this.time * 2.6 + c.phase) * 0.06 : Math.sin(this.time * 1.3 + c.phase) * 0.04
    bend(bones.spine, c.lean * 0.5 + lunge * 0.13 - jolt * zombie.flinchBack * 0.28, 0, sway - jolt * zombie.flinchSide * 0.2)
    bend(bones.chest, c.lean * 0.5 + lunge * 0.15 - jolt * zombie.flinchBack * 0.22, lunge * 0.3, 0)
    bend(bones.head, c.nod - lunge * 0.45 - jolt * zombie.flinchBack * 0.4, sway * 1.5, c.tilt + sway)
    if (lunge > 0) zombie.actor.root.position.addScaledVector(scratch.v.set(Math.sin(zombie.yaw), 0, Math.cos(zombie.yaw)), lunge * 0.3)
  }

  /**
   * A crawler's whole body, every frame. Flat on its front with the chest propped up, it drags itself
   * along: each hand reaches out ahead, plants, and pulls the body up to it while the other reaches, the
   * chest heaving and rolling with each pull, head craned up at its prey. `climb` hangs it upright from
   * its hands on a ladder; `dead` lets it slump flat. Posed absolutely (from the rest pose), so nothing
   * accumulates frame to frame.
   */
  private crawlPose(zombie: Zombie, dt: number, mode: 'crawl' | 'climb' | 'dead', prey?: THREE.Vector3) {
    const { actor } = zombie, bones = actor.rig.bones, rest = actor.rig.rest, c = zombie.carriage
    const scale = zombie.boss ? BOSS.scale : 1
    const forward = scratch.f.set(Math.sin(zombie.yaw), 0, Math.cos(zombie.yaw))
    // The character's left (.L bones), whichever way it faces.
    const left = scratch.s.set(Math.cos(zombie.yaw), 0, -Math.sin(zombie.yaw))
    const attack = attackOf(zombie)
    const swingPhase = mode === 'crawl' && zombie.swing > 0 ? 1 - zombie.swing / attack.swing : -1
    const lunge = swingPhase >= 0 ? Math.sin(Math.PI * Math.min(1, swingPhase / 0.75)) : 0
    const jolt = zombie.flinch > 0 ? Math.sin(Math.PI * zombie.flinch / FLINCH_SECONDS) : 0
    const cycle = zombie.crawled / CRAWL.stride
    // One pull per arm per cycle: the chest heaves up with each pull and rolls toward the pulling arm.
    const crawling = mode === 'crawl' && zombie.crawlFall <= 0
    const heave = crawling ? 0.5 - 0.5 * Math.cos(cycle * Math.PI * 4) : 0
    const roll = crawling ? 0.1 * Math.sin(cycle * Math.PI * 2) : 0
    let pitch = CRAWL.pitch - 0.07 * heave - 0.28 * lunge - 0.15 * jolt, lift = 0.11 + 0.035 * heave + 0.08 * lunge
    if (mode === 'climb') { pitch = 0; lift = 0.82 }
    if (mode === 'dead') { pitch = Math.PI / 2 - 0.03; lift = 0.085 }
    if (mode === 'crawl' && zombie.crawlFall > 0) {
      // Dropping onto its front as the legs go: falls like a weight, pitching forward as it drops.
      const fall = 1 - zombie.crawlFall / CRAWL.fall, drop = fall * fall
      zombie.pitch = THREE.MathUtils.lerp(0, pitch, Math.min(1, fall * 1.3))
      zombie.lift = THREE.MathUtils.lerp(0.82, lift, drop)
    } else {
      const k = 1 - Math.exp(-dt * (mode === 'dead' ? 6 : 12))
      zombie.pitch += (pitch - zombie.pitch) * k
      zombie.lift += (lift - zombie.lift) * k
    }
    // The hips (the stump) trail a little behind where it stands; the chest is over that point.
    const behind = 0.22 * Math.min(1, zombie.pitch / CRAWL.pitch) - 0.05 * heave - 0.14 * lunge
    const hips = scratch.b.copy(zombie.position).addScaledVector(forward, -behind * scale)
    hips.y = zombie.position.y + zombie.lift * scale
    actor.root.rotation.set(zombie.pitch, zombie.yaw, roll, 'YXZ')
    actor.root.position.copy(hips).sub(scratch.a.copy(rest.hips.pos).multiplyScalar(scale).applyEuler(actor.root.rotation))
    // The torso from its rest pose: the clips' walk and look never show on a crawler.
    bones.hips.position.copy(rest.hips.pos)
    for (const name of ['hips', 'spine', 'chest', 'neck', 'head'] as const) bones[name].quaternion.copy(rest[name].quat)
    bend(bones.spine, 0, 0, roll * 0.6)
    // The thigh stumps drag behind, a little apart, twitching with each pull.
    for (const [key, sign] of [['L', 1], ['R', -1]] as const) {
      bones[`thigh.${key}`].quaternion.copy(rest[`thigh.${key}`].quat)
      bend(bones[`thigh.${key}`], 0.25 + (crawling ? 0.12 * Math.sin(cycle * Math.PI * 4 + sign) : 0), 0, -0.2 * sign)
    }
    bend(bones.chest, -0.1 * heave - 0.12 * lunge, crawling ? 0.16 * Math.sin(cycle * Math.PI * 2) : 0, 0)
    // Head up at its prey: the face points `pitch` below level before the neck bends, so crane it back.
    let raise = 0.35, turn = 0
    if (mode === 'dead') { raise = 0.25; turn = c.tilt > 0 ? 0.9 : -0.9 }
    else if (mode === 'crawl') {
      const head = scratch.t.copy(hips).addScaledVector(forward, 0.62 * scale * Math.sin(zombie.pitch)).setY(hips.y + 0.62 * scale * Math.cos(zombie.pitch))
      let look = -0.1
      if (prey) {
        look = Math.atan2(prey.y + 1.5 - head.y, Math.max(0.3, Math.hypot(prey.x - head.x, prey.z - head.z)))
        const toward = Math.atan2(prey.x - head.x, prey.z - head.z)
        turn = THREE.MathUtils.clamp(Math.atan2(Math.sin(toward - zombie.yaw), Math.cos(toward - zombie.yaw)), -0.6, 0.6)
      }
      raise = Math.min(1.5, zombie.pitch + look - 0.25 * lunge)
    }
    bend(bones.neck, -raise * 0.45, turn * 0.4, 0)
    bend(bones.head, -raise * 0.55 + c.nod * 0.25, turn * 0.6, c.tilt * 0.5)
    actor.root.updateMatrixWorld(true)
    if (mode === 'climb') {
      // Hand over hand, as a climbing walker does.
      const phase = zombie.climb ? zombie.climb.travelled * 4.2 : 0
      poseArms(zombie, 2.2 + 1.4 * Math.sin(phase), 2.2 + 1.4 * Math.sin(phase + Math.PI))
      return
    }
    // The arms, each hand placed on the ground (or in the air) and the arm solved to reach it.
    const ground = zombie.position.y + 0.05 * scale
    const striker: 'L' | 'R' | null = !zombie.lost.R ? 'R' : !zombie.lost.L ? 'L' : null
    for (const [key, sign, offset] of [['L', 1, 0], ['R', -1, 0.5]] as const) {
      if (zombie.lost[key]) continue
      const upper = bones[`upper_arm.${key}`]
      const shoulder = upper.getWorldPosition(scratch.a)
      const target = scratch.e.set(shoulder.x, ground, shoulder.z).addScaledVector(left, sign * 0.07 * scale)
      let reach: number, up = 0
      if (mode === 'dead') { reach = 0.3; target.addScaledVector(left, sign * 0.14 * scale) }
      else if (zombie.crawlFall > 0) {
        // Thrown out ahead to break the fall.
        reach = 0.36; up = 0.35 * zombie.crawlFall / CRAWL.fall
      } else {
        const u = ((cycle + offset) % 1 + 1) % 1
        if (u < CRAWL.swing) {
          const t = u / CRAWL.swing, s = t * t * (3 - 2 * t)
          reach = CRAWL.back + (CRAWL.front - CRAWL.back) * s; up = Math.sin(Math.PI * t) * 0.2
        } else reach = CRAWL.front - (CRAWL.front - CRAWL.back) * (u - CRAWL.swing) / (1 - CRAWL.swing)
      }
      target.addScaledVector(forward, reach * scale).y += up * scale
      if (key === striker && swingPhase >= 0) {
        // The swipe: the arm rears up over the shoulder, then claws down at the feet in front.
        const windup = attack.windup / attack.swing
        const high = scratch.t.copy(shoulder).addScaledVector(forward, 0.16 * scale).setY(shoulder.y + 0.42 * scale)
        if (swingPhase < windup) target.lerp(high, THREE.MathUtils.smoothstep(swingPhase / windup, 0, 1))
        else {
          const strike = target.set(shoulder.x, ground, shoulder.z).addScaledVector(forward, 0.52 * scale)
          strike.lerpVectors(high, strike, Math.min(1, (swingPhase - windup) / 0.18))
        }
      }
      solveArm(upper, bones[`forearm.${key}`], bones[`hand.${key}`], target, left.clone().multiplyScalar(sign * 0.8).addScaledVector(UP, 0.55).addScaledVector(forward, -0.25), forward)
    }
  }

  /** The Brute's fists come down: everyone close is hurt, the nearer the worse. */
  private slamDown(zombie: Zombie, targets: readonly ZombieTarget[]) {
    zombie.slamTimer = BOSS.slam.every + Math.random() * 3
    zombie.recover = 0.6
    for (const target of targets) {
      if (!target.alive || Math.abs(target.feet.y - zombie.position.y) > 1.3) continue
      const distance = Math.hypot(target.feet.x - zombie.position.x, target.feet.z - zombie.position.z)
      if (distance > BOSS.slam.radius) continue
      const amount = Math.round(BOSS.slam.damage * (1 - distance / BOSS.slam.radius) ** 0.7)
      if (amount > 0) this.context.damagePlayer(target.id, amount, zombie.position.clone().add(new THREE.Vector3(0, 0.5, 0)))
    }
    this.context.emit({ kind: 'boss-slam', position: zombie.position.clone(), radius: 90 })
    this.context.onSlam?.(zombie.position.clone(), BOSS.slam.radius)
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
    // The straight-line test sweeps a body every 16 cm: the costliest thing a zombie does. A few times a
    // second is enough, spread across the crowd; a step into a wall is still refused, frame by frame.
    zombie.directTimer -= dt
    const near = flat < 12 && Math.abs(goal.y - zombie.position.y) < 1.2
    if (!near) zombie.direct = false
    else if (zombie.directTimer <= 0) {
      zombie.direct = this.navigation.segment(zombie.position, goal)
      zombie.directTimer = (flat < 3 ? 0.1 : 0.22) + Math.random() * 0.1
    }
    if (near && zombie.direct) {
      waypoint = goal
      stopShort = 0.8
      zombie.route.length = 0
    } else if (graph) {
      zombie.routeTimer -= dt
      while (zombie.route.length && zombie.position.distanceTo(zombie.route[0]) < 0.45) zombie.route.shift()
      if (!zombie.route.length || zombie.routeTimer <= 0) {
        const here = graph.nearest(zombie.position, 3, 2.2, this.inReach)
        // Up on something the graph does not reach (a fence rail it climbed after a player who has left):
        // down to the nearest spot below.
        if (here < 0 && this.offPerch(graph, zombie)) return true
        // Where the flow field starts (or a stride from it), as close as the graph gets to the player, yet no
        // straight way to them: up or down to them if they are on something, else the fine planner for the
        // last metres.
        if (here >= 0 && this.atFlowEnd(graph, here, zombie.position)) {
          if (this.perch(zombie, goal, dt)) return true
          return this.lastMetres(zombie, goal, dt)
        }
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
    const turn = this.face(zombie, waypoint, dt, zombie.crawler ? 3.5 : zombie.gait === 'walk' || zombie.blot ? 4 : 7)
    // The walk and run clips only travel forward: finish a sharp turn before moving.
    if (turn > 0.7) return false
    const step = Math.min(speedOf(zombie) * dt, Math.max(0.01, remaining - stopShort))
    this.pushDoors(zombie, waypoint)
    // Movement allows a slightly slimmer body than planning does. Stepping into that margin wedges a
    // zombie somewhere no plan can start from, so only move where planning clearance also holds.
    const candidate = this.navigation.step(zombie.position, waypoint, step)
    const stepped = candidate && this.navigation.fitsPlanned(candidate) ? candidate : this.stepOver(zombie.position, waypoint, step)
    // Chairs, table corners, a doorframe, another zombie: slide around it rather than stall against it.
    // Near its prey with only the crowd in the way, it may also go a long way round the others.
    const crowd = !!stepped && flat < CROWD.near
    const next = stepped && this.clearOfOthers(zombie, stepped) ? stepped : this.sidestep(zombie, waypoint, step, crowd)
    zombie.sideTimer = Math.max(0, zombie.sideTimer - dt)
    if (zombie.sideTimer <= 0) zombie.sideBias = 0
    if (!next && stepped) {
      // Only other zombies in the way: no fine planning (there is no way through a body), and update()
      // has it claw over them if this goes on.
      zombie.crowded += dt
      return false
    }
    zombie.crowded = 0
    if (!next) {
      zombie.stuck += dt
      // Only the step itself failing counts against the link; a neighbour in the way is not its fault.
      if (!stepped && this.context.graph && zombie.routeFrom >= 0 && zombie.routeNode >= 0) {
        zombie.edgeFail += dt
        if (zombie.edgeFail > 1) {
          this.blockLink(this.context.graph, zombie.routeFrom, zombie.routeNode)
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
        if (shove && this.navigation.fitsPlanned(shove)) {
          zombie.position.copy(shove)
          zombie.stuck = 0
          return true
        }
      }
      if (zombie.stuck > 0.5 && !this.plans.has(zombie) && this.context.graph) {
        zombie.blocked = zombie.routeNode
        const ahead = this.lookAhead(this.context.graph, zombie, 3, goal)
        const from = this.navigation.floor(zombie.position.clone()), to = this.navigation.floor(ahead.clone())
        if (from && to) this.plans.set(zombie, this.navigation.createPlan(from, to))
      }
      if (zombie.stuck > 1.2) { zombie.route.length = 0; zombie.routeTimer = 0; zombie.stuck = 0 }
      return false
    }
    zombie.blocked = -1
    zombie.edgeFail = 0
    zombie.stuck = 0
    const travelled = zombie.position.distanceTo(next)
    zombie.footstep += travelled
    if (zombie.crawler) zombie.crawled += travelled
    zombie.position.copy(next)
    if (zombie.footstep > (zombie.crawler ? CRAWL.stride / 2 : 0.9)) { zombie.footstep = 0; this.context.emit({ kind: 'enemy-footstep', position: zombie.position.clone(), radius: zombie.crawler ? 4 : 6 }) }
    return true
  }

  /**
   * Zombies push shut doors open. The graph is baked with every door open, so a route may run through a
   * doorway the player has shut since; a zombie about to walk through one opens it, with the door's
   * sound, and carries on as it would through an open one. Sealed exits are not in the director's list.
   */
  private pushDoors(zombie: Zombie, toward: THREE.Vector3) {
    const p = zombie.position
    const dx = toward.x - p.x, dz = toward.z - p.z, length = Math.hypot(dx, dz)
    if (length < 1e-3) return
    for (const door of this.context.doors) {
      if (door.userData.open || door.userData.missionLocked) continue
      let opening = this.openings.get(door)
      if (!opening) {
        // Doors never move, only their leaves swing: the opening, hinge to latch at its floor, once.
        const half = (door.userData.width ?? 1.35) / 2
        opening = { a: door.localToWorld(new THREE.Vector3(-half, 0, 0)), b: door.localToWorld(new THREE.Vector3(half, 0, 0)),
          centre: door.getWorldPosition(new THREE.Vector3()), reach: half + 1.5 }
        this.openings.set(door, opening)
      }
      const c = opening.centre
      if (Math.abs(c.y - p.y) > 1.5 || (c.x - p.x) ** 2 + (c.z - p.z) ** 2 > opening.reach ** 2) continue
      // Its way from just behind it to a stride and a half ahead: does that pass through the opening?
      doorFrom.set(p.x - dx / length * 0.3, p.y, p.z - dz / length * 0.3)
      doorTo.set(p.x + dx / length * 1.3, p.y, p.z + dz / length * 1.3)
      if (!crossesFlat(doorFrom, doorTo, opening.a, opening.b)) continue
      setDoorOpen(door, true)
      this.context.emit({ kind: 'door', position: c.clone(), radius: 8 })
    }
  }

  /**
   * Over something ankle-high (a rail, a kerb, a pipe): the guards' step refuses anything the lower body
   * touches, but a zombie lifts its feet. The body is tested from knee height, and the ground under the
   * new spot may be up to half a metre up or down.
   */
  private stepOver(from: THREE.Vector3, goal: THREE.Vector3, distance: number) {
    const dx = goal.x - from.x, dz = goal.z - from.z, flat = Math.hypot(dx, dz)
    if (flat < 1e-4) return null
    const next = scratch.v.set(from.x + dx / flat * distance, from.y + 0.55, from.z + dz / flat * distance)
    const floor = this.context.world.floor(next, 0.05, 1.1, 0.2)
    if (!Number.isFinite(floor) || Math.abs(floor - from.y) > 0.5) return null
    this.stepCapsule.start.set(next.x, floor + 0.35 + 0.27, next.z)
    this.stepCapsule.end.set(next.x, floor + 1.74 - 0.27, next.z)
    return this.context.world.fits(this.stepCapsule) ? new THREE.Vector3(next.x, floor + 0.024, next.z) : null
  }

  /**
   * A step at an angle to the way it wants to go, for when that way is blocked by something small. It
   * keeps to the side it last chose, so it works around an obstacle instead of dithering in front of it.
   */
  private sidestep(zombie: Zombie, goal: THREE.Vector3, step: number, crowd = false) {
    const base = Math.atan2(goal.x - zombie.position.x, goal.z - zombie.position.z)
    const side = zombie.sideBias || (Math.random() < 0.5 ? 1 : -1)
    const target = scratch.d
    for (const angle of crowd ? SIDESTEP_CROWD : SIDESTEP) for (const turn of [side, -side]) {
      const a = base + turn * angle
      target.set(zombie.position.x + Math.sin(a) * 0.6, zombie.position.y, zombie.position.z + Math.cos(a) * 0.6)
      const candidate = this.navigation.step(zombie.position, target, step * 0.85)
      if (!candidate || !this.navigation.fitsPlanned(candidate) || !this.clearOfOthers(zombie, candidate)) continue
      zombie.sideBias = turn; zombie.sideTimer = 0.6
      return candidate
    }
    return null
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
      if (!probe || !this.navigation.fitsPlanned(probe)) {
        // A link toward the player that keeps refusing the first step is not really there: after a few
        // tries, delete it so the flow field routes everyone around instead of shuffling on the spot.
        if (option.distance < current) {
          zombie.probeFails = zombie.probeFail === option.index ? zombie.probeFails + 1 : 1
          zombie.probeFail = option.index
          if (zombie.probeFails >= 3) {
            this.blockLink(graph, here, option.index)
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

  /**
   * A player up on something no graph spot reaches (balanced on a fence rail, on a sill) or down in a
   * hole, right over or under this zombie: it clambers up the face as it climbs a wall, or drops down,
   * onto standing room beside them, and swipes from there. Only from the end of the flow field, and only
   * where there is room to stand next to them (not in mid-air beside a rail).
   */
  private perch(zombie: Zombie, goal: THREE.Vector3, dt: number) {
    const rise = goal.y - zombie.position.y, flat = Math.hypot(goal.x - zombie.position.x, goal.z - zombie.position.z)
    zombie.perchTimer -= dt
    // Up to them as up a wall; down to them off whatever it stands on (a counter top the flow ends on,
    // with the player in the kitchen behind it), which walking will not do.
    const up = rise > 1.2 && rise <= PERCH.up && flat <= PERCH.beside
    const down = rise < -0.6 && rise >= -PERCH.down && flat <= PERCH.beside + 1
    if (!(up || down) || zombie.perchTimer > 0) return false
    const beside = this.besidePerch(goal, zombie.position)
    // Nowhere to stand beside them, or something in the way: look again in a moment (they may move along).
    if (!beside || !this.clearClimb(zombie.position, beside)) { zombie.perchTimer = 0.8; return false }
    return this.startClimb(zombie, -1, -1, [beside], `perch:${Math.round(beside.x * 2)},${Math.round(beside.z * 2)}`)
  }

  /** Whether spot `here` is where the flow field starts, or the next spot on is and the zombie is all but on it. */
  private atFlowEnd(graph: NavGraph, here: number, position: THREE.Vector3) {
    if (!Number.isFinite(graph.distance(here))) return false
    const next = graph.downhill(here)
    return next < 0 || (graph.downhill(next) < 0 && graph.point(next, reachSpot).distanceToSquared(position) < 0.8 * 0.8)
  }

  /**
   * A climb from `from` to `to` has no collision, so it must not pass through anything: up then across, or
   * across then down (as startClimb lays it out), chest-high lines clear all the way.
   */
  private clearClimb(from: THREE.Vector3, to: THREE.Vector3) {
    const up = to.y > from.y
    const corner = up ? from.clone().lerp(to, 0.45).setY(to.y) : from.clone().lerp(to, 0.55).setY(from.y)
    const chest = (p: THREE.Vector3) => p.clone().setY(p.y + 1.1)
    if (!this.context.world.visible(chest(from), chest(corner), NO_ONE) || !this.context.world.visible(chest(corner), chest(to), NO_ONE)) return false
    // The body too, along the level leg (wire fences let sight lines through, not bodies).
    const [a, b] = up ? [corner, to] : [from, corner]
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.2)
    for (let i = 1; i <= steps; i++) if (!this.navigation.fitsPlanned(a.clone().lerp(b, i / steps).setY(a.y + 0.05))) return false
    return true
  }

  /** Standing room for a zombie at `goal`'s height, 0.7 to 1.05 m from it, nothing between; the one nearest `from`. */
  private besidePerch(goal: THREE.Vector3, from: THREE.Vector3) {
    let best: THREE.Vector3 | null = null, bestDistance = Infinity
    for (const out of [0.7, 1.05]) for (let i = 0; i < 12; i++) {
      const angle = i / 12 * Math.PI * 2
      const point = this.navigation.floor(new THREE.Vector3(goal.x + Math.sin(angle) * out, goal.y, goal.z + Math.cos(angle) * out))
      if (!point || Math.abs(point.y - goal.y) > 0.35) continue
      const distance = point.distanceToSquared(from)
      if (distance >= bestDistance) continue
      if (!this.context.world.visible(point.clone().setY(point.y + 1.1), goal.clone().setY(goal.y + 1.1), NO_ONE)) continue
      best = point; bestDistance = distance
    }
    return best
  }

  /** A zombie off the graph (left up on a perch): straight down onto the nearest spot below. */
  private offPerch(graph: NavGraph, zombie: Zombie) {
    const below = graph.nearest(zombie.position, 3, PERCH.down, this.inReach)
    if (below < 0) return false
    const spot = graph.point(below)
    if (zombie.position.y - spot.y < 1) return false
    return this.startClimb(zombie, -1, below, [spot], `down:${below}`)
  }

  /**
   * The end of the flow field: the zombie is on the spot the field starts from, and the player is not
   * straight ahead of it (round a table, in a gap the coarse grid misses, off the graph altogether). The
   * fine planner works out the last few metres to them, or to the nearest place a body fits beside them;
   * until it has, the zombie turns to face them rather than wandering about the spot.
   */
  private lastMetres(zombie: Zombie, goal: THREE.Vector3, dt: number) {
    zombie.route.length = 0
    zombie.routeTimer = 0.4
    zombie.routeNode = -1; zombie.routeFrom = -1
    if (!this.plans.has(zombie)) {
      const from = this.navigation.floor(zombie.position.clone()), to = this.besideTarget(zombie.position, goal)
      if (from && to && Math.hypot(to.x - from.x, to.z - from.z) > 0.3) this.plans.set(zombie, this.navigation.createPlan(from, to))
    }
    this.face(zombie, goal, dt, 4)
    return false
  }

  /** Where a zombie can stand at `goal`, or failing that the nearest such place on the way back toward `from`. */
  private besideTarget(from: THREE.Vector3, goal: THREE.Vector3) {
    const at = this.navigation.floor(goal.clone())
    if (at) return at
    const dx = from.x - goal.x, dz = from.z - goal.z, length = Math.hypot(dx, dz)
    if (length < 0.1) return null
    for (let back = 0.3; back <= 1.5 && back < length; back += 0.3) {
      const point = this.navigation.floor(new THREE.Vector3(goal.x + dx / length * back, goal.y, goal.z + dz / length * back))
      if (point) return point
    }
    return null
  }

  /**
   * A link that keeps refusing a body comes out of the graph and the flow field routes round it. Only for
   * a while (LINK_BLOCK_SECONDS): what stopped the body may pass (a door leaf mid-swing, a shove from the
   * crowd), and a doorway taken out for good would send the whole horde the long way round all game.
   */
  private blockLink(graph: NavGraph, a: number, b: number) {
    this.blockedLinks.push({ key: graph.blockEdge(a, b), until: this.time + LINK_BLOCK_SECONDS })
    this.flowTimer = 0
  }

  /** Links whose time out of the graph is up go back in; all of them at once when `all`. */
  private restoreLinks(all = false) {
    const graph = this.context.graph
    while (graph && this.blockedLinks.length && (all || this.blockedLinks[0].until <= this.time)) {
      graph.openGap(this.blockedLinks.shift()!.key)
      this.flowTimer = 0
    }
  }

  /** A point a few flow-field steps further on, to plan toward when stuck. */
  private lookAhead(graph: NavGraph, zombie: Zombie, steps: number, goal?: THREE.Vector3) {
    let node = graph.nearest(zombie.position, 3, 2.2, this.inReach)
    for (let i = 0; i < steps && node >= 0; i++) {
      const next = graph.downhill(node)
      // The field starts here: what is further on is the player (see lastMetres).
      if (next < 0) return goal && Number.isFinite(graph.distance(node)) ? this.besideTarget(zombie.position, goal) ?? graph.point(node) : graph.point(node)
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
    const length = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1
    for (const other of this.zombies) {
      if (other === zombie || other.state !== 'chase') continue
      const ox = other.position.x - next.x, oz = other.position.z - next.z, gap2 = ox * ox + oz * oz
      if (gap2 >= 0.25) continue
      const gap = Math.sqrt(gap2)
      if (Math.abs(other.position.y - next.y) < 1 && (ox * dirX + oz * dirZ) / (gap * length || 1) > 0.2) return false
    }
    return true
  }

  // ---------------------------------------------------------------- damage

  private bodyHit(zombie: Zombie, origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    const scale = zombie.boss ? BOSS.scale : 1
    const centre = zombie.position.clone().addScaledVector(BODY_CENTRE, scale)
    if (rayCapsuleDistance(origin, direction, centre, centre, 1.9 * scale) > maxDistance) return null
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
    return this.hitAll(shot, maxDistance, scale, instaKill, 1)[0] ?? null
  }

  /**
   * A bullet that can pass through bodies: the first `pierce` zombies along the ray are hit, nearest
   * first, each for full damage (a sniper round goes through a line of them, as in Call of Duty).
   */
  hitAll(shot: Shot, maxDistance: number, scale: number, instaKill = false, pierce = 1): ZombieHit[] {
    const normalized = shot.direction.clone().normalize(), range = Math.min(maxDistance, shot.range)
    const struck: { zombie: Zombie; hit: NonNullable<ReturnType<ZombieDirector['bodyHit']>> }[] = []
    for (const zombie of this.zombies) {
      if (zombie.state !== 'chase') continue
      const hit = this.bodyHit(zombie, shot.origin, normalized, range)
      if (hit) struck.push({ zombie, hit })
    }
    struck.sort((a, b) => a.hit.distance - b.hit.distance)
    return struck.slice(0, Math.max(1, pierce)).map(({ zombie, hit }) => {
      const falloff = shot.weapon === 'shotgun' ? shotgunDamageMultiplier(hit.distance) : 1
      // Insta-Kill does not one-shot the Brute, as it does not Call of Duty's bosses.
      const damage = instaKill && !zombie.boss ? zombie.health : hitDamage(shot.weapon, hit.zone, shot.damage * scale) * falloff
      return this.applyHit(zombie, damage, hit.zone, hit.point, normalized, hit.bone, shot.weapon)
    })
  }

  /**
   * A blast (a grenade, an upgraded gun's ink burst): every living zombie within `radius` that the
   * blast can see takes `damage`, less toward the edge, and a kill is thrown outward.
   */
  blast(centre: THREE.Vector3, radius: number, damage: number): ZombieHit[] {
    const hits: ZombieHit[] = [], from = centre.clone().setY(centre.y + 0.4)
    for (const zombie of this.zombies) {
      if (zombie.state !== 'chase') continue
      const chest = zombie.position.clone().setY(zombie.position.y + 1.1 * (zombie.boss ? BOSS.scale : 1))
      const distance = chest.distanceTo(centre)
      if (distance > radius || !this.context.world.visible(from, chest, zombie.actor.root)) continue
      const outward = chest.clone().sub(centre).setY(0.3).normalize()
      hits.push(this.applyHit(zombie, damage * (1 - 0.5 * distance / radius), 'torso', chest, outward, undefined, 'shotgun', distance / radius))
    }
    return hits
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
    return this.applyHit(best, instaKill && !best.boss ? best.health : damage, 'torso', point, flatForward, undefined, undefined)
  }

  /** `blast`: for a blast, how far out this zombie was (0 at the centre, 1 at the edge). */
  private applyHit(zombie: Zombie, damage: number, zone: HitZone, point: THREE.Vector3, direction: THREE.Vector3,
    bone: BoneName | undefined, weapon: Shot['weapon'], blast?: number): ZombieHit {
    const before = zombie.health
    // Whole points, as in Call of Duty: fractional damage left zombies on 0.3 health, and the shot that
    // finished them showed "0".
    const amount = damage > 0 ? Math.max(1, Math.round(damage)) : 0
    zombie.health = Math.max(0, zombie.health - amount)
    const lethal = zombie.health === 0
    const reaction: HitReaction = { zone, point: point.clone(), direction: direction.clone(), lethal, bone, weapon, targetId: zombie.id }
    const fromBehind = direction.x * Math.sin(zombie.yaw) + direction.z * Math.cos(zombie.yaw) > 0.25
    this.wound(zombie, lethal, zone, direction, bone, weapon, blast)
    if (lethal) {
      zombie.actor.react(reactionClipName(reaction, fromBehind), true, direction)
      this.kill(zombie)
    } else {
      // Call of Duty zombies barely flinch: a short stagger, no full reaction pause, and a jolt of the
      // upper body away from the bullet.
      zombie.stagger = Math.max(zombie.stagger, 0.12)
      zombie.flinch = FLINCH_SECONDS
      zombie.flinchBack = direction.x * Math.sin(zombie.yaw) + direction.z * Math.cos(zombie.yaw) < 0 ? 1 : -1
      zombie.flinchSide = direction.x * Math.cos(zombie.yaw) - direction.z * Math.sin(zombie.yaw)
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
    // Shot while climbing out: it falls back where it was, half in the ground, unless it was already up on its knee.
    if (zombie.rise > 0) {
      if (1 - zombie.rise / RISE.seconds < RISE.beats.knee) zombie.position.y = Math.min(zombie.position.y, zombie.actor.root.position.y)
      zombie.rise = 0
    }
    if (!zombie.crawler) zombie.actor.root.rotation.set(0, zombie.yaw, 0)
    zombie.state = 'dead'
    zombie.deadFor = 0
    zombie.swing = 0
    zombie.route.length = 0
    if (!zombie.crawler) zombie.actor.update(0, 'dead', false)
    this.context.emit({ kind: 'enemy-down', position: zombie.position.clone(), radius: 5 })
    if (zombie.blot) {
      // The belly bursts: a pop of ink, a shower of it, and the poison cloud where it fell.
      zombie.blot = false
      const actor = zombie.actor
      actor.root.updateMatrixWorld(true)
      const belly = bloatCentre(actor)
      if (zombie.gibbed) belly.copy(zombie.position).setY(zombie.position.y + 0.9)
      setBloat(actor, false)
      this.gore.pop(belly, 1.4, 0.4)
      this.gore.fling(belly, UP, 10, zombie.position.y, 1.2, 2.6, 1.3)
      this.gore.spray(belly, UP, 36, zombie.position.y, 3.4)
      this.gore.splat(zombie.position.clone(), 1)
      this.gas.emit(zombie.position.clone())
      this.context.emit({ kind: 'gas-burst', position: belly, radius: 45 })
    }
  }

  // ---------------------------------------------------------------- gore

  /** The floor under a zombie, even one shot off a ladder or halfway out of the ground. */
  private groundUnder(zombie: Zombie) {
    if (!zombie.climb && zombie.rise <= 0) return zombie.position.y
    const below = this.context.world.floor(zombie.position.clone().setY(zombie.position.y + 0.3), 0.3, 40)
    return Number.isFinite(below) ? below : zombie.position.y
  }

  /**
   * What a hit does to the body: heads pop on a killing headshot, heavy guns tear arms and legs off, blasts
   * take the legs or blow the body apart. Runs before the death clip is chosen, so a body that loses its
   * legs falls as a crawler.
   */
  private wound(zombie: Zombie, lethal: boolean, zone: HitZone, direction: THREE.Vector3, bone: BoneName | undefined, weapon: Shot['weapon'], blast?: number) {
    const roll = this.random, heavy = weapon ? GORE_ODDS.arm[weapon] : undefined
    const side: 'L' | 'R' = bone?.endsWith('.L') ? 'L' : 'R'
    if (blast !== undefined) {
      if (zombie.boss) return
      if (lethal) {
        if (roll() < (blast < 0.6 ? GORE_ODDS.gib : GORE_ODDS.gibEdge)) { this.gib(zombie, direction); return }
        if (roll() < GORE_ODDS.lethalArm) this.loseArm(zombie, roll() < 0.5 ? 'L' : 'R', direction)
        return
      }
      if (!zombie.crawler && zombie.rise <= 0 && !zombie.climb && roll() < GORE_ODDS.blastCrawl) this.makeCrawler(zombie, direction)
      else if (roll() < GORE_ODDS.blastArm) this.loseArm(zombie, roll() < 0.5 ? 'L' : 'R', direction)
      return
    }
    if (lethal && zone === 'head') { this.popHead(zombie, direction); return }
    if (zombie.boss) return
    if (zone === 'arm' && heavy && roll() < (lethal ? Math.max(heavy, GORE_ODDS.lethalArm) : heavy)) this.loseArm(zombie, side, direction)
    const leg = weapon ? GORE_ODDS.leg[weapon] : undefined
    if (!lethal && zone === 'leg' && leg && !zombie.crawler && zombie.rise <= 0 && !zombie.climb && roll() < leg) this.makeCrawler(zombie, direction)
  }

  /** The legs go: they fly off, and the zombie drops onto its front and crawls on. */
  makeCrawler(zombie: Zombie, direction: THREE.Vector3) {
    if (zombie.crawler || zombie.state !== 'chase') return
    const { actor } = zombie, bones = actor.rig.bones, floor = zombie.position.y
    const away = direction.clone().setY(0)
    if (away.lengthSq() < 1e-4) away.set(-Math.sin(zombie.yaw), 0, -Math.cos(zombie.yaw))
    away.normalize()
    for (const [key, sign] of [['L', 1], ['R', -1]] as const) {
      const out = new THREE.Vector3(Math.cos(zombie.yaw), 0, -Math.sin(zombie.yaw)).multiplyScalar(sign * 1.2)
      this.gore.limb('leg', bones[`shin.${key}`], away.clone().multiplyScalar(2 + this.random() * 1.5).add(out).setY(2.4 + this.random() * 1.5), floor, 0.75)
    }
    setPartLost(actor, 'legs', true)
    zombie.crawler = true
    zombie.crawlFall = CRAWL.fall
    zombie.pitch = 0; zombie.lift = 0.82
    zombie.stagger = Math.max(zombie.stagger, CRAWL.fall + 0.1)
    zombie.swing = 0; zombie.recover = 0.3
    this.gore.spray(zombie.position.clone().setY(floor + 0.75), away, 22, floor, 3)
    this.gore.splat(zombie.position.clone(), 0.6)
    this.context.emit({ kind: 'gore-rip', position: zombie.position.clone().setY(floor + 0.7), radius: 30 })
  }

  /** An arm torn off at the shoulder, thrown along `direction`. */
  loseArm(zombie: Zombie, side: 'L' | 'R', direction: THREE.Vector3) {
    if (zombie.lost[side] || zombie.gibbed) return
    const bone = zombie.actor.rig.bones[`upper_arm.${side}`]
    // Out to its own side as much as along the hit, so it spins off clear of the body where you can see it.
    const out = new THREE.Vector3(Math.cos(zombie.yaw), 0, -Math.sin(zombie.yaw)).multiplyScalar(side === 'L' ? 1 : -1)
    const away = direction.clone().setY(0).normalize().multiplyScalar(1 + this.random()).addScaledVector(out, 1.8 + this.random() * 1.2).setY(2.4 + this.random() * 1.2)
    this.gore.limb('arm', bone, away, this.groundUnder(zombie), zombie.boss ? BOSS.scale : 1)
    setPartLost(zombie.actor, side === 'L' ? 'arm.L' : 'arm.R', true)
    zombie.lost[side] = true
    this.context.emit({ kind: 'gore-rip', position: bone.getWorldPosition(new THREE.Vector3()), radius: 30 })
  }

  /** A killing headshot: the head bursts in ink and is gone. The wet pop plays for the shooter, not in the world. */
  private popHead(zombie: Zombie, direction: THREE.Vector3) {
    if (zombie.lost.head) return
    const { head, neck } = zombie.actor.rig.bones
    const scale = zombie.boss ? BOSS.scale : 1
    head.updateWorldMatrix(true, false)
    const centre = head.localToWorld(new THREE.Vector3(0, 0.2, 0))
    this.gore.headPop(centre, direction.clone().normalize(), this.groundUnder(zombie), neck, scale)
    setPartLost(zombie.actor, 'head', true)
    zombie.lost.head = true
    this.context.emit({ kind: 'headshot-pop', radius: 60 })
  }

  /** A body blown apart by a blast: limbs flung out, the rest a shower of ink chunks. */
  private gib(zombie: Zombie, direction: THREE.Vector3) {
    const { actor } = zombie, bones = actor.rig.bones, floor = this.groundUnder(zombie)
    actor.root.updateMatrixWorld(true)
    const centre = bones.chest.getWorldPosition(new THREE.Vector3())
    const out = direction.clone().setY(0)
    if (out.lengthSq() < 1e-4) out.set(0, 0, 1)
    out.normalize()
    const throwOut = (spread: number) => out.clone().multiplyScalar(3 + this.random() * 3)
      .add(new THREE.Vector3(this.random() - 0.5, 0, this.random() - 0.5).multiplyScalar(spread)).setY(3 + this.random() * 3.5)
    for (const side of ['L', 'R'] as const) if (!zombie.lost[side]) this.gore.limb('arm', bones[`upper_arm.${side}`], throwOut(6), floor)
    if (!zombie.crawler) for (const side of ['L', 'R'] as const) this.gore.limb('leg', bones[`thigh.${side}`], throwOut(5), floor)
    if (!zombie.lost.head) this.gore.fling(bones.head.localToWorld(new THREE.Vector3(0, 0.2, 0)), out, 5, floor, 1.6, 4.5)
    this.gore.gib(centre, out, floor)
    zombie.gibbed = true
    zombie.lost.head = zombie.lost.L = zombie.lost.R = true
    actor.root.visible = false
    this.context.emit({ kind: 'gib', position: centre, radius: 50 })
  }

  /** Zombies near `centre` stagger and stop swiping for a moment (Second Draft getting you back up). */
  shove(centre: THREE.Vector3, radius: number, seconds: number) {
    for (const zombie of this.zombies) {
      if (zombie.state !== 'chase' || zombie.position.distanceTo(centre) > radius) continue
      zombie.stagger = Math.max(zombie.stagger, seconds)
      zombie.swing = 0
    }
  }

  /** Every living zombie dies at once (the Nuke power-up), except the Brute. Returns how many. */
  killAll() {
    let count = 0
    for (const zombie of this.zombies) {
      if (zombie.state !== 'chase' || zombie.boss) continue
      zombie.health = 0
      zombie.actor.react(reactionClipName({ zone: 'torso', lethal: true }, false), true, new THREE.Vector3(-Math.sin(zombie.yaw), 0, -Math.cos(zombie.yaw)))
      this.kill(zombie)
      count++
    }
    return count
  }

  /** Back to an empty field: every actor to the pool, and the graph whole again (before any gate shuts). */
  clear() {
    this.plans.clear()
    this.restoreLinks(true)
    for (const zombie of this.zombies) { zombie.state = 'idle'; zombie.actor.root.visible = false }
    this.gore.clear()
    this.gas.clear()
  }

  dispose() {
    this.disposed = true
    this.plans.clear()
    this.gore.dispose()
    this.gas.dispose()
    for (const zombie of this.zombies) { zombie.actor.root.removeFromParent(); zombie.actor.dispose() }
    this.zombies.length = 0
  }
}

// ---------------------------------------------------------------- the zombie look

/**
 * Point a bone's +Y axis (glTF bones run along +Y) toward `direction` in world space, keeping the rest
 * of the skeleton, and refresh its children so the next bone in the chain sees the new pose.
 */
export function aimBone(bone: THREE.Object3D, direction: THREE.Vector3, parentFresh = false) {
  // The parent's world rotation, once: the bone's own is that times its local one (the rig scales evenly).
  const parent = scratch.p.identity()
  if (bone.parent) {
    if (!parentFresh) bone.parent.updateWorldMatrix(true, false)
    bone.parent.matrixWorld.decompose(scratch.e, parent, scratch.a)
  }
  const world = scratch.q.copy(parent).multiply(bone.quaternion)
  const current = scratch.d.copy(UP).applyQuaternion(world).normalize()
  const target = aimDelta.setFromUnitVectors(current, scratch.v.copy(direction).normalize()).multiply(world)
  bone.quaternion.copy(parent.invert().multiply(target))
  bone.updateMatrixWorld(true)
}
const aimDelta = new THREE.Quaternion()

/**
 * Arms out in front, one often hanging lower; bouncing with the stride while it moves. Through a swipe
 * the right arm goes up high and chops down past horizontal, the left comes up with it.
 */
function reachArms(zombie: Zombie, time = -1) {
  const c = zombie.carriage, attack = attackOf(zombie)
  if (zombie.slam > 0) {
    // Both fists raised overhead, shaking with the effort.
    const shake = Math.sin(zombie.slam * 40) * 0.12
    poseArms(zombie, 3.2 + shake, 3.2 - shake)
    return
  }
  const swingPhase = zombie.swing > 0 ? 1 - zombie.swing / attack.swing : -1
  const bounce = time >= 0 ? Math.sin(time * (zombie.gait === 'walk' ? 5.2 : 10.5) + c.phase) * (zombie.gait === 'walk' ? 0.08 : 0.22) : 0
  let left = -0.28 - c.droopL + bounce, right = -0.28 - c.droopR - bounce
  if (swingPhase >= 0) {
    const windup = attack.windup / attack.swing
    right = swingPhase < windup ? THREE.MathUtils.lerp(right, 1.6, swingPhase / windup) : THREE.MathUtils.lerp(1.6, -1.2, Math.min(1, (swingPhase - windup) / 0.25))
    left = Math.max(left, swingPhase < windup ? 0.3 : -0.1)
  }
  // Right arm torn off: the left one swipes.
  if (zombie.lost.R && !zombie.lost.L) [left, right] = [right, left]
  poseArms(zombie, left, right)
}

/** Swipe numbers for this zombie: the Brute's are slower, longer and heavier; a crawler's shorter. */
function attackOf(zombie: Zombie) {
  return zombie.boss ? BOSS.attack : { ...(zombie.crawler ? CRAWL.attack : ATTACK), damage: PLAYER_HEALTH.zombieHit }
}

function speedOf(zombie: Zombie) {
  return zombie.boss ? BOSS.speed : zombie.crawler ? CRAWL.speed : zombie.blot ? BLOT.speed : ZOMBIE_SPEED[zombie.gait]
}

/**
 * The Brute's crown of ink spikes, so it reads as something else from across the yard. Made once per
 * pooled actor, shown only while it is the Brute.
 */
function setSpikes(actor: EnemyActor, on: boolean) {
  let spikes = actor.root.userData.spikes as THREE.Group | undefined
  if (!spikes && !on) return
  if (!spikes) {
    spikes = new THREE.Group()
    spikes.name = 'Brute spikes'
    const material = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
    const cone = new THREE.ConeGeometry(0.045, 0.2, 8)
    for (let i = 0; i < 5; i++) {
      const angle = (i - 2) * 0.45
      const spike = new THREE.Mesh(cone, material)
      spike.position.set(Math.sin(angle) * 0.14, 0.36 + Math.cos(angle) * 0.04, -0.02)
      spike.rotation.z = -angle * 0.9
      spike.userData.noCollision = true
      spikes.add(spike)
    }
    actor.rig.bones.head.add(spikes)
    actor.root.userData.spikes = spikes
  }
  spikes.visible = on
}

/**
 * Two-bone reach: the upper arm and forearm placed so the wrist lands on `target` (or as near as the arm
 * reaches), the elbow bending out toward `pole`, the fist pointing along `forward` and down.
 */
function solveArm(upper: THREE.Bone, fore: THREE.Bone, hand: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3, forward: THREE.Vector3, handDirection?: THREE.Vector3) {
  const shoulder = upper.getWorldPosition(new THREE.Vector3())
  const a = shoulder.distanceTo(fore.getWorldPosition(scratch.d)), b = scratch.d.distanceTo(hand.getWorldPosition(scratch.v))
  const toward = target.clone().sub(shoulder)
  const distance = THREE.MathUtils.clamp(toward.length(), Math.abs(a - b) + 1e-3, (a + b) * 0.995)
  toward.normalize()
  const cos = (a * a + distance * distance - b * b) / (2 * a * distance), sin = Math.sqrt(Math.max(0, 1 - cos * cos))
  const out = pole.clone().addScaledVector(toward, -pole.dot(toward)).normalize()
  const elbow = shoulder.clone().addScaledVector(toward, a * cos).addScaledVector(out, a * sin)
  aimBone(upper, elbow.clone().sub(shoulder))
  const wrist = shoulder.addScaledVector(toward, distance)
  aimBone(fore, wrist.sub(fore.getWorldPosition(scratch.d)))
  aimBone(hand, handDirection ?? forward.clone().setY(-0.7))
}

/** Thigh and shin placed so the foot lands on `target` (or as near as the leg reaches), the knee bending toward `pole`. */
function solveLeg(thigh: THREE.Bone, shin: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3, scale: number) {
  const hip = thigh.getWorldPosition(new THREE.Vector3())
  const a = hip.distanceTo(shin.getWorldPosition(scratch.d)), b = SHIN_LENGTH * scale
  const toward = target.clone().sub(hip)
  const distance = THREE.MathUtils.clamp(toward.length(), Math.abs(a - b) + 1e-3, (a + b) * 0.995)
  toward.normalize()
  const cos = (a * a + distance * distance - b * b) / (2 * a * distance), sin = Math.sqrt(Math.max(0, 1 - cos * cos))
  const out = pole.clone().addScaledVector(toward, -pole.dot(toward)).normalize()
  const knee = hip.clone().addScaledVector(toward, a * cos).addScaledVector(out, a * sin)
  aimBone(thigh, knee.clone().sub(hip))
  const ankle = hip.addScaledVector(toward, distance)
  aimBone(shin, ankle.sub(shin.getWorldPosition(scratch.d)))
}

/** Both arms toward the facing direction, each lifted by its own amount (0 level, positive up). */
function poseArms(zombie: Zombie, left: number, right: number) {
  const bones = zombie.actor.rig.bones
  // The chest's world matrix once, each shoulder under it, then each bone under the one just posed: no
  // bone's chain is walked twice.
  bones.chest.updateWorldMatrix(true, false)
  const forward = armForward.set(Math.sin(zombie.yaw), 0, Math.cos(zombie.yaw))
  for (let i = 0; i < 2; i++) {
    const side = i ? 'R' : 'L', drop = i ? right : left
    bones[`shoulder.${side}`].updateMatrixWorld(true)
    aimBone(bones[`upper_arm.${side}`], armDirection.copy(forward).setY(drop).normalize(), true)
    aimBone(bones[`forearm.${side}`], armDirection.copy(forward).setY(drop - 0.1).normalize(), true)
  }
}
const armForward = new THREE.Vector3(), armDirection = new THREE.Vector3()

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
