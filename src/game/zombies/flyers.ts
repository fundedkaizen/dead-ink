import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { CollisionWorld } from '../../player/collision'
import type { ActorHit } from '../hit-reactions'
import type { EmitSound } from '../types'
import { penPalette } from '../../render/ballpoint'
import { zombieEyeMaterial } from '../../render/ink'
import type { Random } from '../shared/random'
import type { InkGore } from './gore'
import type { NavGraph } from './navgraph'
import type { Zombie, ZombieSnap, ZombieTarget } from './director'
import { INKWINGS, stormPack } from './rules'

/**
 * The Inkwings: Dead Ink's flyers, the Ink Storm's answer to Call of Duty's hellhounds. Each comes out of the
 * storm on a streak of ink from the sky (or the ceiling), forms where it splashes down, and hunts one player:
 * it circles them, and now and then it screeches, hangs in the air with its wings folding in and its eyes
 * flaring, and dives straight at where they will be. A sidestep or a jump at the right moment and it misses and
 * pulls up; stand still and the ones close by snap at you too. Out of sight of its player it follows the zombies'
 * ground graph at body height, through doors, down stairs and along corridors; one that stops getting anywhere
 * comes out of the storm again near its player.
 *
 * An Inkwing takes an idle body's place in the director's pool, so everything that finds, hurts and pays for a
 * zombie finds, hurts and pays for it too (bullets, blasts, the knife, the Nuke, a co-op guest's shots, the round
 * count). Its stickman stays hidden; this file moves and draws it. A kill bursts it into ink that falls to the
 * ground, and the body's place drops to the floor under it, so what the kill drops lands there.
 *
 * Drawn with instancing: every Inkwing's body, wings, eyes and ink outlines are six draw calls in all.
 */
export const INKWING = {
  /** Its body against walls (m), and the generous spheres a bullet has to pass through: the body and wings, and the head. */
  radius: 0.22, hit: { body: 0.5, head: 0.21 },
  /**
   * Its entrance: seconds for its streak of ink to fall from the sky, then to form out of the splash (the whole
   * entrance `form`), and the gap between a group's streaks.
   */
  fall: 0.45, form: 1, stagger: 0.22,
  /** Circling and on its way (m/s), how hard it turns (m/s²), how far out and how high over its player's feet it circles, its body over the floor. */
  fly: { speed: 6.5, chase: 8.5, accel: 18, orbit: [3.8, 6.2], lift: [1.9, 3.1], body: 1.25 },
  /**
   * The dive: the tell (seconds hovering, wings folding in, eyes flaring), its speed, how near and how far it dives
   * from, the height it aims at over the feet (the thighs, so a jump at the right moment clears it), how much of the
   * player's run it leads, how far it carries on past, its damage, the pull-up after, and the wait before the next.
   */
  dive: { tell: 0.6, speed: 16, min: 3, max: 11, aim: 0.65, lead: 0.7, past: 2.2, damage: 40, pull: 0.5, cooldown: [2.6, 4.2] },
  /** Someone standing still: after `still` seconds of it, one within `range` winds up and bites (`reach` from its body). */
  snap: { still: 1, range: 2.3, windup: 0.32, reach: 1.05, damage: 20, cooldown: 1.8, near: 2 },
  /** Dives at one player at once, and the least time between two starting on them, by storm (the first, the second, the third on). */
  slots: [1, 2, 2], gap: [1.1, 0.8, 0.6],
  /** Seconds a burst Inkwing stays dead in the pool, so a co-op guest sees it go. */
  dead: 0.6,
  /** No closer for `stuck` seconds out of sight of its player, or unable to move for `blocked`: it comes out of the storm again. */
  stuck: 7, blocked: 1.6,
} as const

/** Co-op: an Inkwing's row in the director's snapshot has this flag, and its mode in the four bits over it (bits 19 to 23 in all). */
export const FLYER_ROW = { flag: 1 << 19, shift: 20, mask: 15 } as const
const MODES = ['form', 'fly', 'tell', 'dive', 'strike', 'pull', 'snap'] as const
export type InkwingMode = typeof MODES[number]

/** A player's body, for a dive or a bite: feet to shoulders, and its radius; and the chest a flyer looks for. */
const PLAYER = { low: 0.3, high: 1.5, radius: 0.3, chest: 1.2 } as const

export type Inkwing = {
  zombie: Zombie
  mode: InkwingMode
  /** Seconds in this mode; below zero while a group's later streaks wait their turn. */
  clock: number
  /** Its streak has started down from the sky; it has landed (it is there, and can be hit). */
  struck: boolean
  arrived: boolean
  velocity: THREE.Vector3
  /** Whom it hunts (a target id). */
  target: string
  /** Its circle: which way round, where on it, and how far out and how high it likes it; `close`: no circle there, it holds close by. */
  side: 1 | -1
  angle: number
  radius: number
  lift: number
  close: boolean
  goal: THREE.Vector3
  /** A clear line to its player, and seconds until it looks again; seconds until it picks its way on again. */
  sight: boolean
  look: number
  routed: number
  /** Seconds before it may attack again. */
  cooldown: number
  /** The dive: which way, metres left, whether it bit, and the dive slot it holds (its target's id). */
  dir: THREE.Vector3
  left: number
  bit: boolean
  slot: string | null
  /** Getting nowhere: the closest it came out of sight of its player, how long ago, how long it could not move. */
  best: number
  since: number
  blocked: number
  /** The floor under it. */
  floor: number
  /** How it looks: the wingbeat, wings folded in (0 to 1), eyes flaring (0 to 1), the bank and pitch of its body, its size forming. */
  flap: number
  fold: number
  flare: number
  bank: number
  pitch: number
  size: number
  /** Seconds to its next drop of ink and its next heard wingbeat. */
  drip: number
  beat: number
  /** Where it burst, and where the last hit came from. */
  burst: THREE.Vector3
  hitFrom: THREE.Vector3
  deadFor: number
  /** A co-op guest's puppet: where the host last put it, and its velocity then. */
  row: THREE.Vector3
  rowVelocity: THREE.Vector3
  rowYaw: number
}

export type InkwingContext = {
  scene: THREE.Object3D
  world: CollisionWorld
  gore: InkGore
  emit: EmitSound
  /** A dive or a bite landed on a player. */
  damagePlayer: (targetId: string, amount: number, source: THREE.Vector3) => void
  /** The director's pool: an Inkwing takes an idle body's place in it. */
  pool: readonly Zombie[]
  graph?: NavGraph
  /** The director's door push: a shut door on its way opens, as it does for a zombie. */
  pushDoors?: (zombie: Zombie, toward: THREE.Vector3) => void
}

const UP = new THREE.Vector3(0, 1, 0)
const NO_ONE = new THREE.Object3D()
/** Where its tail's drip hangs, and its eyes, in its own space (it faces +Z). */
const TAIL_TIP = new THREE.Vector3(0, -0.29, -0.36)
const EYES = new THREE.Vector3(0, 0.07, 0.235)
/** Ways to slide along what blocked a move: level, up or down, then along each axis. */
const SLIDES: readonly [number, number, number][] = [[1, 0, 1], [0, 1, 0], [1, 0, 0], [0, 0, 1]]
/** Ways out when caught inside something: level first, then up and down. */
const OUTS: readonly [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.71, 0, 0.71], [-0.71, 0, 0.71],
  [0.71, 0, -0.71], [-0.71, 0, -0.71], [0, 1, 0], [0, -1, 0]]
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
const between = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0])
const r2 = (n: number) => Math.round(n * 100) / 100
const s = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), line: new THREE.Line3() }

/** Entry distance of a ray into a sphere (0 from inside), or Infinity. */
function sphereEntry(origin: THREE.Vector3, direction: THREE.Vector3, centre: THREE.Vector3, radius: number) {
  const along = s.a.subVectors(centre, origin).dot(direction)
  const miss = s.a.lengthSq() - along * along
  if (miss > radius * radius) return Infinity
  const entry = along - Math.sqrt(radius * radius - miss)
  return entry >= 0 ? entry : along >= 0 ? 0 : Infinity
}

export class Inkwings {
  private flock = new Map<Zombie, Inkwing>()
  private look: InkwingLook
  private time = 0
  private capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), INKWING.radius)
  /** Each player as the flock sees them: their velocity (for a dive's lead) and how long they have stood still. */
  private watched = new Map<string, { last: THREE.Vector3; velocity: THREE.Vector3; still: number }>()
  /** Dives on each player now, and when the last one started. */
  private diving = new Map<string, number>()
  private dived = new Map<string, number>()
  /** Which storm this is (the dives' pace). */
  storm = 1
  /** A guest's last rows from the host, and how long ago they came. */
  private rows: readonly ZombieSnap[] | null = null
  private rowAge = 0
  private held = new Set<Zombie>()
  private chest = new THREE.Vector3()
  private probe = new THREE.Vector3()
  private over = new THREE.Vector3()
  private top = new THREE.Vector3()

  constructor(private context: InkwingContext) {
    this.look = new InkwingLook(context.scene)
  }

  /** Whether this pooled body is an Inkwing now. */
  owns(zombie: Zombie) { return this.flock.has(zombie) }
  /** Its Inkwing state (for checks). */
  get(zombie: Zombie) { return this.flock.get(zombie) }
  /** Inkwings in the air. */
  get alive() { let n = 0; for (const f of this.flock.values()) if (f.zombie.state === 'chase') n++; return n }
  /** Draw calls the flock costs (for checks). */
  get drawCalls() { return this.look.drawCalls }

  /**
   * A group of `count` Inkwings out of the storm (the host), round the player with the fewest after them: each on
   * its own streak a moment after the one before, spread round them, in the open, never on top of anyone. Returns
   * how many came.
   */
  arrive(count: number, targets: readonly ZombieTarget[], health: number, random: Random, storm = this.storm) {
    this.storm = storm
    const players = targets.filter(t => t.alive && !t.id.startsWith('doll-'))
    if (!players.length) return 0
    const target = players.reduce((best, t) => (this.hunters(t.id) < this.hunters(best.id) ? t : best))
    const taken: THREE.Vector3[] = []
    let placed = 0
    for (let i = 0; i < count; i++) {
      const at = this.entry(target, players, random, taken)
      const zombie = at && this.context.pool.find(z => z.state === 'idle')
      if (!at || !zombie) break
      const f = this.adopt(zombie, at, health)
      f.target = target.id
      f.clock = -i * INKWING.stagger
      taken.push(at)
      placed++
    }
    return placed
  }

  /**
   * Where an Inkwing may come out near `target`: in the air straight over a spot of the ground graph that leads to
   * the players (so never in a closed zone or a wall), as high as the room over it allows, 5 m or more from every
   * player, apart from the rest of its group, and in sight of its player if anywhere is. Null when nowhere is.
   */
  entry(target: ZombieTarget, players: readonly ZombieTarget[], random: Random, taken: readonly THREE.Vector3[] = []) {
    const graph = this.context.graph, world = this.context.world
    if (!graph) return null
    const chest = s.d.copy(target.feet).setY(target.feet.y + PLAYER.chest)
    const passes = [{ near: 7, far: 22, see: true }, { near: 5, far: 32, see: false }, { near: 4, far: 60, see: false }]
    const spots: number[] = []
    for (let i = 0; i < graph.size; i++) {
      const d = graph.distance(i)
      if (d >= 4 && d <= 60 && graph.walkable(i)) spots.push(i)
    }
    if (!spots.length) return null
    const point = new THREE.Vector3(), air = new THREE.Vector3()
    for (const pass of passes) for (let attempt = 0; attempt < 90; attempt++) {
      const spot = spots[Math.floor(random() * spots.length)]
      const walk = graph.distance(spot)
      if (walk < pass.near || walk > pass.far) continue
      graph.point(spot, point)
      if (Math.hypot(point.x - target.feet.x, point.z - target.feet.z) > pass.far + 6) continue
      if (players.some(p => Math.hypot(point.x - p.feet.x, point.z - p.feet.z) < 5 && Math.abs(point.y - p.feet.y) < 4)) continue
      if (taken.some(t => Math.hypot(point.x - t.x, point.z - t.z) < 2.5)) continue
      // As high as the air straight over the spot goes: never through a floor into the room over it (a ray too, as a
      // one-sided surface stops a body only from its front). A player up high (a roof, the tower) has them come out
      // level with them, where the air allows.
      const up = target.feet.y - point.y
      for (const lift of up > 2 ? [up + 2.2, up + 1.2, 3.1, 2.3, 1.5, 1.2] : [3.1, 2.3, 1.5, 1.2]) {
        air.copy(point).setY(point.y + lift)
        const base = s.c.copy(point).setY(point.y + 0.5)
        if (players.some(p => Math.hypot(air.x - p.feet.x, air.z - p.feet.z) < 5 && Math.abs(air.y - p.feet.y) < 4)) continue
        if (!this.passable(base, air, 0.3) || world.raySurface(base, UP, lift - 0.15)) continue
        if (pass.see && !world.visible(air, chest, NO_ONE)) continue
        return air.clone()
      }
    }
    return null
  }

  /** A pooled body becomes an Inkwing at `at`: whole, hidden (this file draws it), forming. */
  private adopt(zombie: Zombie, at: THREE.Vector3, health: number): Inkwing {
    zombie.state = 'chase'
    zombie.position.copy(at)
    zombie.yaw = Math.random() * Math.PI * 2
    zombie.health = zombie.maxHealth = health
    zombie.gait = 'sprint'; zombie.moving = false; zombie.stranded = false
    zombie.rise = 0; zombie.climb = null; zombie.window = null; zombie.route.length = 0
    zombie.boss = false; zombie.blot = false; zombie.crawler = false; zombie.gibbed = false
    zombie.lost.head = zombie.lost.L = zombie.lost.R = false
    zombie.swing = 0; zombie.stagger = 0; zombie.flinch = 0; zombie.deadFor = 0
    // Its stickman lies still and unseen in the pool, marked dead so no reaction ever plays on it.
    zombie.actor.restore('dead')
    zombie.actor.root.visible = false
    const f: Inkwing = {
      zombie, mode: 'form', clock: 0, struck: false, arrived: false, velocity: new THREE.Vector3(), target: '',
      side: Math.random() < 0.5 ? 1 : -1, angle: Math.random() * Math.PI * 2, radius: between(INKWING.fly.orbit), lift: between(INKWING.fly.lift), close: false,
      goal: at.clone(), sight: false, look: Math.random() * 0.2, routed: 0, cooldown: 0.8 + Math.random(),
      dir: new THREE.Vector3(0, 0, 1), left: 0, bit: false, slot: null, best: Infinity, since: 0, blocked: 0, floor: at.y - 3,
      flap: Math.random() * Math.PI * 2, fold: 0, flare: 0, bank: 0, pitch: 0, size: 0, drip: Math.random(), beat: Math.random() * 0.5,
      burst: new THREE.Vector3(), hitFrom: new THREE.Vector3(), deadFor: 0,
      row: at.clone(), rowVelocity: new THREE.Vector3(), rowYaw: zombie.yaw,
    }
    this.flock.set(zombie, f)
    return f
  }

  /** Back to the pool, free for anything. */
  private release(f: Inkwing) {
    this.releaseSlot(f)
    f.zombie.state = 'idle'
    this.flock.delete(f.zombie)
  }

  // ---------------------------------------------------------------- the host

  update(dt: number, targets: readonly ZombieTarget[]) {
    this.time += dt
    this.watch(dt, targets)
    for (const f of this.flock.values()) {
      if (f.zombie.state === 'dead') {
        if ((f.deadFor += dt) >= INKWING.dead) this.release(f)
        continue
      }
      this.think(f, dt, targets)
    }
    this.spread(dt)
    this.draw(dt)
  }

  /** How each player moves: their velocity for a dive's lead, and how long they have stood still. */
  private watch(dt: number, targets: readonly ZombieTarget[]) {
    if (!(dt > 0)) return
    for (const t of targets) {
      let w = this.watched.get(t.id)
      if (!w) this.watched.set(t.id, w = { last: t.feet.clone(), velocity: new THREE.Vector3(), still: 0 })
      const v = s.a.subVectors(t.feet, w.last).divideScalar(dt)
      // A teleport (a respawn, the edge of the map) is not a run.
      if (v.lengthSq() > 400) v.set(0, 0, 0)
      w.velocity.lerp(v, 1 - Math.exp(-dt * 10))
      w.last.copy(t.feet)
      w.still = Math.hypot(w.velocity.x, w.velocity.z) < 0.8 ? w.still + dt : 0
    }
  }

  private think(f: Inkwing, dt: number, targets: readonly ZombieTarget[]) {
    const z = f.zombie
    this.tick(f, dt)
    f.cooldown -= dt
    if (f.mode === 'form') {
      f.velocity.multiplyScalar(Math.exp(-dt * 6))
      if (f.clock >= INKWING.form) this.setMode(f, 'fly')
      return
    }
    const target = this.pick(f, targets)
    if (!target) {
      f.velocity.multiplyScalar(Math.exp(-dt * 3))
      this.move(f, dt)
      return
    }
    const lure = target.id.startsWith('doll-')
    const chest = this.chest.copy(target.feet).setY(target.feet.y + (lure ? 0.4 : PLAYER.chest))
    // It looks for its player a few times a second: a clear line, and a circle round them where it keeps them in sight.
    if ((f.look -= dt) <= 0) {
      f.look = 0.2 + Math.random() * 0.12
      f.sight = this.context.world.visible(z.position, chest, NO_ONE)
      const floor = this.context.world.floor(z.position, 0.2, 40)
      f.floor = Number.isFinite(floor) ? floor : z.position.y - 40
      if (f.sight) this.circle(f, target, chest, lure)
    }
    switch (f.mode) {
      case 'fly': this.fly(f, target, chest, lure, dt); break
      case 'tell': this.tell(f, target, dt); break
      case 'dive': this.dive(f, targets, dt); break
      case 'strike': case 'pull': this.pull(f, dt); break
      case 'snap': this.snap(f, target, chest, dt); break
    }
    if (f.mode !== 'dive') this.move(f, dt)
    this.face(f, chest, dt)
    // Getting nowhere out of sight of its player (or boxed in): out of the storm again, near them.
    const gap = z.position.distanceTo(chest)
    if (f.sight || f.mode !== 'fly' || gap < f.best - 1) { f.best = Math.min(f.best, gap); f.since = 0 }
    else f.since += dt
    if (f.sight && f.mode === 'fly') f.best = gap
    if (f.since > INKWING.stuck || f.blocked > INKWING.blocked || gap > 75) this.again(f, target)
  }

  /** Its player: the one it hunts while they are up, else the nearest (a thrown Ink Doll draws it off to that). */
  private pick(f: Inkwing, targets: readonly ZombieTarget[]) {
    let current = targets.find(t => t.id === f.target && t.alive) ?? null
    if (!current) {
      let bestDistance = Infinity
      for (const t of targets) {
        if (!t.alive) continue
        const d = t.feet.distanceToSquared(f.zombie.position)
        if (d < bestDistance) { current = t; bestDistance = d }
      }
      if (current) { f.target = current.id; f.best = Infinity; f.since = 0 }
    }
    return current
  }

  private fly(f: Inkwing, target: ZombieTarget, chest: THREE.Vector3, lure: boolean, dt: number) {
    const z = f.zombie, p = z.position
    // Someone standing still with three or more after them: the two nearest close in to snap, the rest keep diving.
    const still = !lure && (this.watched.get(target.id)?.still ?? 0) >= INKWING.snap.still && this.nearer(f, target) < 2 && this.hunters(target.id) > 2
    if (f.sight) {
      // Round its player, out of reach but for its dive; round a doll close in; close in on someone standing still.
      const radius = lure ? Math.min(f.radius, 3) * 0.75 : still ? INKWING.snap.near : f.radius
      f.angle += f.side * INKWING.fly.speed / Math.max(1.5, radius) * dt
      if (f.close) f.goal.copy(p).sub(chest).setY(0).normalize().multiplyScalar(2).add(chest)
      else f.goal.set(target.feet.x + Math.cos(f.angle) * radius, target.feet.y + (lure || still ? Math.min(f.lift, 1.7) : f.lift),
        target.feet.z + Math.sin(f.angle) * radius)
      this.steer(f, f.goal, INKWING.fly.speed, dt)
    } else {
      // Out of sight: along the ground graph at body height, through doors and down stairs (straight at them where it gives out).
      if ((f.routed -= dt) <= 0 || p.distanceToSquared(f.goal) < 0.36) { f.routed = 0.3 + Math.random() * 0.15; this.route(f, chest) }
      this.context.pushDoors?.(z, f.goal)
      this.steer(f, f.goal, INKWING.fly.chase, dt)
    }
    if (lure || f.cooldown > 0 || !f.sight || !target.alive) return
    const distance = p.distanceTo(chest)
    if (distance >= INKWING.dive.min && distance <= INKWING.dive.max && this.slotFree(target.id)) {
      // The tell: it hangs in the air, rearing back a little, and screeches.
      f.slot = target.id
      this.diving.set(target.id, (this.diving.get(target.id) ?? 0) + 1)
      this.dived.set(target.id, this.time)
      f.goal.copy(p).addScaledVector(s.a.subVectors(p, chest).setY(0).normalize(), 0.35).setY(p.y + 0.3)
      this.setMode(f, 'tell')
    } else if (still && distance <= INKWING.snap.range) this.setMode(f, 'snap')
  }

  /**
   * The next stretch of its circle, checked: in the open and in sight of its player. Otherwise further round,
   * lower or closer in, whichever is; failing all of them it holds close by, still in sight.
   */
  private circle(f: Inkwing, target: ZombieTarget, chest: THREE.Vector3, lure: boolean) {
    if (f.mode !== 'fly') return
    const world = this.context.world, feet = target.feet, point = s.b
    const radius = lure ? Math.min(f.radius, 3) * 0.75 : f.radius
    const tries: [number, number, number][] = [[f.lift, radius, 0], [f.lift, radius, 1], [f.lift, radius, 2], [1.5, radius, 0],
      [1.5, radius * 0.65, 0], [1.5, radius * 0.65, 2], [1.1, Math.max(1.8, radius * 0.5), 1], [1.1, 1.8, 3]]
    for (const [lift, out, turn] of tries) {
      const angle = f.angle + f.side * (0.7 + turn * 0.9)
      point.set(feet.x + Math.cos(angle) * out, feet.y + lift, feet.z + Math.sin(angle) * out)
      if (!this.passable(point, point, 0.3) || !world.visible(point, chest, NO_ONE)) continue
      f.angle = angle - f.side * 0.7
      f.close = false
      if (lift !== f.lift || out !== radius) { f.lift = lift; f.radius = out }
      return
    }
    f.close = true
  }

  /**
   * Its way on out of sight of its player: downhill on the zombies' flow field, at body height over the floor (stairs
   * keep their steps), to the farthest point of the next few links it can fly straight to.
   */
  private route(f: Inkwing, chest: THREE.Vector3) {
    const world = this.context.world, p = f.zombie.position
    f.goal.copy(chest)
    // A player under the open sky (a yard, a roof, the top of the tower): up where the sky is open over it, high
    // enough to cross clear of whatever stands between (a water tank, a roof edge), over to them, and down in sight.
    // Caught under something (a catwalk, an eave) it first slips out from under it. Under a roof, the ground graph.
    if (!world.raySurface(chest, UP, 30)) {
      if (world.raySurface(p, UP, 3)) { if (this.outFromUnder(f, chest)) return }
      else for (const rise of [2.4, 4.5, 7, 10]) {
        const high = chest.y + rise, over = this.over.set(chest.x, high, chest.z), top = this.top.set(p.x, Math.max(p.y, high), p.z)
        if (top.y > p.y + 0.3 && (world.raySurface(p, UP, top.y - p.y + 0.4) || !this.passable(p, top, INKWING.radius))) break
        if (!this.passable(top, over, INKWING.radius)) continue
        f.goal.copy(p.y < high - 0.6 ? top : over)
        return
      }
    }
    this.along(f)
  }

  /** Out from under what is over it: the nearest place close by it can fly straight to with open sky over it. */
  private outFromUnder(f: Inkwing, chest: THREE.Vector3) {
    const world = this.context.world, p = f.zombie.position, toward = Math.atan2(chest.x - p.x, chest.z - p.z)
    for (const out of [1.6, 3.2]) for (let i = 0; i < 8; i++) {
      // Toward its player first, then round both ways.
      const angle = toward + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 4
      const q = this.top.set(p.x + Math.sin(angle) * out, p.y, p.z + Math.cos(angle) * out)
      if (!this.passable(p, q, INKWING.radius) || world.raySurface(q, UP, 3)) continue
      f.goal.copy(q)
      return true
    }
    return false
  }

  /**
   * Along the zombies' ground graph at body height, downhill on their flow field toward its player (stairs keep
   * their steps), from a spot it can fly straight to, to the farthest point of the next few links it can reach
   * straight from where it is.
   */
  private along(f: Inkwing) {
    const graph = this.context.graph, p = f.zombie.position
    if (!graph) return
    const ground = f.floor > p.y - 6 ? f.floor : p.y - INKWING.fly.body
    let node = graph.nearest(this.probe.set(p.x, ground, p.z), 2, 2.2)
    // Never a spot behind a wall from it (the nearest can be the other side of one): the nearest it can reach.
    const reachable = (spot: number) => this.passable(p, graph.point(spot, this.over).setY(this.over.y + INKWING.fly.body), INKWING.radius)
    const usable = (spot: number) => Number.isFinite(graph.distance(spot)) && reachable(spot)
    if (node >= 0 && !reachable(node)) node = graph.neighbours(node).find(usable) ?? -1
    // None close by it can get to (hard up against a wall): the nearest further off that it can.
    if (node < 0) { node = graph.nearest(this.probe, 5, 4, usable); if (node >= 0 && !usable(node)) node = -1 }
    if (node < 0 || !Number.isFinite(graph.distance(node))) return
    let best = graph.point(node).setY(graph.height(node) + INKWING.fly.body)
    outer: for (let hop = 0; hop < 4; hop++) {
      const next = graph.downhill(node)
      if (next < 0) break
      for (const point of graph.route(node, next).points) {
        point.y += INKWING.fly.body
        if (!this.passable(p, point, INKWING.radius)) break outer
        best = point
      }
      node = next
    }
    f.goal.copy(best)
  }

  private tell(f: Inkwing, target: ZombieTarget, dt: number) {
    const z = f.zombie, p = z.position
    // It brakes hard and hangs there, drawing back a little.
    f.velocity.multiplyScalar(Math.exp(-dt * 9))
    this.steer(f, f.goal, 2, dt)
    if (f.clock < INKWING.dive.tell) return
    if (!target.alive || target.id.startsWith('doll-')) { this.endAttack(f, 0.6); return }
    // Locked on where they will be, at their hips, a little ahead of their run: it does not turn once it goes.
    const aim = s.b.copy(target.feet).setY(target.feet.y + INKWING.dive.aim)
    const run = this.watched.get(target.id)?.velocity
    if (run) aim.addScaledVector(s.a.set(run.x, 0, run.z), INKWING.dive.lead * aim.distanceTo(p) / INKWING.dive.speed)
    f.dir.subVectors(aim, p)
    const toAim = f.dir.length()
    f.dir.divideScalar(toAim || 1)
    // Never into a wall: all the way clear, or at least as far as its prey.
    let length = toAim + INKWING.dive.past
    if (!this.passable(p, s.c.copy(p).addScaledVector(f.dir, length), INKWING.radius)) {
      length = this.passable(p, s.c.copy(p).addScaledVector(f.dir, toAim), INKWING.radius) ? toAim : 0
    }
    if (length < INKWING.dive.min * 0.8 || toAim > INKWING.dive.max + 2) { this.endAttack(f, 0.6); return }
    f.left = length
    f.bit = false
    f.velocity.copy(f.dir).multiplyScalar(INKWING.dive.speed)
    this.setMode(f, 'dive')
  }

  /** Straight on at dive speed: a player it passes through is hit (once), and it pulls up at the end or at a wall. */
  private dive(f: Inkwing, targets: readonly ZombieTarget[], dt: number) {
    const p = f.zombie.position
    const step = Math.min(f.left, INKWING.dive.speed * dt)
    const to = s.c.copy(p).addScaledVector(f.dir, step)
    if (!this.passable(p, to, INKWING.radius)) { this.pullUp(f, 'pull'); return }
    const bitten = f.bit ? null : this.contact(p, to, targets, PLAYER.radius + INKWING.radius)
    p.copy(to)
    f.left -= step
    if (bitten) {
      f.bit = true
      this.context.damagePlayer(bitten.id, INKWING.dive.damage, p.clone())
      this.pullUp(f, 'strike')
      return
    }
    if (f.left <= 1e-3) this.pullUp(f, 'pull')
  }

  /** The dive is over: it swoops up at once, carrying on the way it went. */
  private pullUp(f: Inkwing, mode: 'strike' | 'pull') {
    this.releaseSlot(f)
    f.cooldown = between(INKWING.dive.cooldown)
    f.velocity.set(f.velocity.x * 0.55, Math.max(3.5, -f.velocity.y * 0.4), f.velocity.z * 0.55)
    this.setMode(f, mode)
  }

  /** Up and away after a dive or a bite, a heavy wingbeat, then back to circling. */
  private pull(f: Inkwing, dt: number) {
    const p = f.zombie.position
    const away = s.a.set(f.dir.x, 0, f.dir.z)
    if (away.lengthSq() < 1e-4) away.set(Math.sin(f.zombie.yaw), 0, Math.cos(f.zombie.yaw))
    this.steer(f, s.b.copy(p).addScaledVector(away.normalize(), 3).setY(p.y + 2.5), 7, dt)
    if (f.clock >= INKWING.dive.pull) this.setMode(f, 'fly')
  }

  /** Close to someone standing still: a short wind-up, eyes flaring, then in at their chest with a bite. */
  private snap(f: Inkwing, target: ZombieTarget, chest: THREE.Vector3, dt: number) {
    const z = f.zombie, p = z.position, snap = INKWING.snap
    if (f.clock < snap.windup) { f.velocity.multiplyScalar(Math.exp(-dt * 8)); return }
    this.steer(f, chest, 9, dt)
    if (!f.bit && target.alive && this.contact(p, p, [target], snap.reach)) {
      f.bit = true
      this.context.damagePlayer(target.id, snap.damage, p.clone())
    }
    if (f.clock < snap.windup + 0.22) return
    f.dir.subVectors(p, chest).setY(0).normalize()
    f.cooldown = snap.cooldown
    this.setMode(f, f.bit ? 'strike' : 'pull')
    f.bit = false
  }

  /** The attack is off (no clear dive, its prey gone): its slot back, a short wait, and back to circling. */
  private endAttack(f: Inkwing, wait: number) {
    this.releaseSlot(f)
    f.cooldown = wait
    this.setMode(f, 'fly')
  }

  /** How many hunt this player. */
  private hunters(id: string) {
    let n = 0
    for (const f of this.flock.values()) if (f.target === id && f.zombie.state === 'chase') n++
    return n
  }

  /** How many others hunting the same player are nearer to them than this one. */
  private nearer(f: Inkwing, target: ZombieTarget) {
    const mine = f.zombie.position.distanceToSquared(target.feet)
    let n = 0
    for (const other of this.flock.values()) {
      if (other !== f && other.target === f.target && other.zombie.state === 'chase' && other.zombie.position.distanceToSquared(target.feet) < mine) n++
    }
    return n
  }

  /** Whether a dive may start on this player: a free slot, and long enough since the last one started. */
  private slotFree(id: string) {
    const k = Math.min(INKWING.slots.length, Math.max(1, this.storm)) - 1
    return (this.diving.get(id) ?? 0) < INKWING.slots[k] && this.time - (this.dived.get(id) ?? -Infinity) >= INKWING.gap[k]
  }

  private releaseSlot(f: Inkwing) {
    if (!f.slot) return
    this.diving.set(f.slot, Math.max(0, (this.diving.get(f.slot) ?? 1) - 1))
    f.slot = null
  }

  /** A player whose body passes within `reach` of the way from `from` to `to`. */
  private contact(from: THREE.Vector3, to: THREE.Vector3, targets: readonly ZombieTarget[], reach: number) {
    const line = s.line
    for (const t of targets) {
      if (!t.alive || t.id.startsWith('doll-')) continue
      line.start.set(t.feet.x, t.feet.y + PLAYER.low, t.feet.z)
      line.end.set(t.feet.x, t.feet.y + PLAYER.high, t.feet.z)
      for (let i = 0; i <= 4; i++) {
        const point = s.a.lerpVectors(from, to, i / 4)
        if (line.closestPointToPoint(point, true, s.b).distanceToSquared(point) <= reach * reach) return t
      }
    }
    return null
  }

  /** Toward `goal` at up to `speed`, easing off as it gets there, turning no harder than it can. */
  private steer(f: Inkwing, goal: THREE.Vector3, speed: number, dt: number) {
    const want = s.a.subVectors(goal, f.zombie.position)
    const distance = want.length()
    if (distance > 1e-4) want.multiplyScalar(Math.min(speed, distance * 2.5) / distance)
    const change = want.sub(f.velocity)
    const most = INKWING.fly.accel * dt
    if (change.lengthSq() > most * most) change.setLength(most)
    f.velocity.add(change)
  }

  /** Where its velocity takes it this frame, never into anything: sliding along what is in the way, or held. */
  private move(f: Inkwing, dt: number) {
    const p = f.zombie.position, v = f.velocity
    if (v.lengthSq() < 1e-8) { f.blocked = 0; return }
    // Nothing flies it faster than a dive.
    if (v.lengthSq() > INKWING.dive.speed ** 2) v.setLength(INKWING.dive.speed)
    const to = s.c
    // Caught inside something (a door swung shut on it): out the nearest way that is clear.
    if (!this.passable(p, p, INKWING.radius)) {
      for (const out of [0.25, 0.5, 0.8]) for (const [x, y, z] of OUTS) {
        to.set(p.x + x * out, p.y + y * out, p.z + z * out)
        if (!this.passable(to, to, INKWING.radius)) continue
        p.copy(to)
        f.blocked = 0
        return
      }
    }
    for (let i = -1; i < SLIDES.length; i++) {
      const [x, y, z] = i < 0 ? [1, 1, 1] : SLIDES[i]
      to.set(p.x + v.x * x * dt, p.y + v.y * y * dt, p.z + v.z * z * dt)
      if (!this.passable(p, to, INKWING.radius)) continue
      p.copy(to)
      if (i >= 0) v.set(v.x * (x || 0.5), v.y * (y || 0.5), v.z * (z || 0.5))
      f.blocked = 0
      return
    }
    v.multiplyScalar(0.3)
    f.blocked += dt
  }

  /** A body of `radius` fits all the way from `a` to `b`. */
  private passable(a: THREE.Vector3, b: THREE.Vector3, radius: number) {
    this.capsule.start.copy(a)
    this.capsule.end.copy(b)
    this.capsule.radius = radius
    return this.context.world.fits(this.capsule)
  }

  /** Heading: along its flight, or at its prey while it hangs in the air; banking into its turns. */
  private face(f: Inkwing, chest: THREE.Vector3, dt: number) {
    const z = f.zombie, v = f.velocity, flat = Math.hypot(v.x, v.z)
    const hover = f.mode === 'tell' || f.mode === 'snap' || flat < 0.8
    const toward = hover ? Math.atan2(chest.x - z.position.x, chest.z - z.position.z) : Math.atan2(v.x, v.z)
    const delta = wrap(toward - z.yaw), turn = Math.sign(delta) * Math.min(Math.abs(delta), 8 * dt)
    z.yaw = wrap(z.yaw + turn)
    const bank = THREE.MathUtils.clamp(turn / Math.max(dt, 1e-3) * 0.14, -0.7, 0.7)
    f.bank += (bank - f.bank) * (1 - Math.exp(-dt * 6))
  }

  /** Inkwings do not pile into one another. */
  private spread(dt: number) {
    const list = [...this.flock.values()].filter(f => f.zombie.state === 'chase' && f.arrived && f.mode !== 'dive')
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i].zombie.position, b = list[j].zombie.position
      const away = s.a.subVectors(a, b), d = away.length()
      if (d > 1.1 || d < 1e-4) continue
      away.multiplyScalar((1.1 - d) * 5 * dt / d)
      list[i].velocity.add(away)
      list[j].velocity.sub(away)
    }
  }

  /** Stuck, or too far off: its body melts into ink, and it comes out of the storm again near its player. */
  private again(f: Inkwing, target: ZombieTarget) {
    f.since = 0
    f.blocked = 0
    f.best = Infinity
    const at = this.entry(target, [target], Math.random)
    if (!at) return
    this.releaseSlot(f)
    this.context.gore.pop(f.zombie.position, 0.6)
    f.zombie.position.copy(at)
    f.velocity.set(0, 0, 0)
    f.fold = 0; f.flare = 0
    f.mode = 'form'
    f.clock = 0
    f.struck = false
    f.arrived = false
  }

  /**
   * Into a mode, with its sound (inkwing-sounds.ts): the screech of the tell and the hiss before a snap (each as long
   * as its wind-up), the rush of the dive, the bite landing.
   */
  private setMode(f: Inkwing, mode: InkwingMode) {
    f.mode = mode
    f.clock = 0
    const kind = mode === 'tell' ? 'inkwing-tell' : mode === 'dive' ? 'inkwing-dive' : mode === 'strike' ? 'inkwing-hit' : mode === 'snap' ? 'inkwing-snap' : null
    const duration = mode === 'tell' ? INKWING.dive.tell : mode === 'snap' ? INKWING.snap.windup : undefined
    if (kind) this.context.emit({ kind, position: f.zombie.position.clone(), radius: mode === 'tell' ? 48 : mode === 'dive' ? 30 : 20, duration })
  }

  /** Its clock: the moment its streak starts down from the sky, and the moment it lands and the Inkwing forms. */
  private tick(f: Inkwing, dt: number) {
    f.clock += dt
    if (f.mode !== 'form' || f.clock < 0) return
    const at = f.zombie.position
    if (!f.struck) {
      f.struck = true
      // The streak of ink falling from the sky (or from the ceiling) to where it will form.
      const top = this.context.world.raySurface(at, UP, 40)
      this.look.streak(at, top ? top.point : s.a.copy(at).setY(at.y + 40))
      this.context.emit({ kind: 'inkwing-arrive', position: at.clone(), radius: 50 })
    }
    if (f.arrived || f.clock < INKWING.fall) return
    // It lands: the splash, and the Inkwing forms out of it.
    f.arrived = true
    const floor = this.context.world.floor(at, 0.1, 40)
    this.context.gore.pop(at, 1.05, 0.3)
    this.context.gore.spray(at, UP, 16, Number.isFinite(floor) ? floor : at.y - 3, 2.4)
  }

  // ---------------------------------------------------------------- hits

  /** Where a bullet meets it: generous spheres for its body and wings and for its head. Null for a miss. */
  bodyHit(zombie: Zombie, origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): ActorHit | null {
    const f = this.flock.get(zombie)
    if (!f || zombie.state !== 'chase' || !f.arrived) return null
    const size = Math.max(0.4, f.size), c = zombie.position
    const head = s.c.set(Math.sin(zombie.yaw) * Math.cos(f.pitch), -Math.sin(f.pitch), Math.cos(zombie.yaw) * Math.cos(f.pitch))
      .multiplyScalar(0.2 * size).add(c).addScaledVector(UP, 0.05 * size)
    const body = sphereEntry(origin, direction, c, INKWING.hit.body * size)
    const face = sphereEntry(origin, direction, head, INKWING.hit.head * size)
    // The head counts where the shot meets it before, or hardly after, the rest of the body.
    const zone = face < Infinity && face <= body + 0.35 ? 'head' : 'torso'
    const distance = zone === 'head' ? face : body
    if (distance > maxDistance) return null
    return { distance, point: origin.clone().addScaledVector(direction, distance), zone, bone: zone === 'head' ? 'head' : 'chest' }
  }

  /** Its middle, for a blast or the knife (null for anything but an Inkwing). */
  centre(zombie: Zombie) { return this.flock.has(zombie) ? zombie.position.clone() : null }

  /** A hit: where it came from (a kill bursts that way), and a jolt through the air if it lives. */
  wound(zombie: Zombie, lethal: boolean, direction: THREE.Vector3) {
    const f = this.flock.get(zombie)
    if (!f) return
    f.hitFrom.copy(direction).normalize()
    if (!lethal) f.velocity.addScaledVector(f.hitFrom, 2.2)
  }

  /**
   * Killed: it bursts into ink where it was, the ink and its torn wings fall to the ground, and its place drops to
   * the floor under it, so a Max Ammo or a power-up from this kill lands where it fell.
   */
  kill(zombie: Zombie) {
    const f = this.flock.get(zombie)
    if (!f) return
    this.releaseSlot(f)
    zombie.state = 'dead'
    zombie.deadFor = 0
    zombie.swing = 0
    f.deadFor = 0
    f.burst.copy(zombie.position)
    const at = f.burst, floor = this.context.world.floor(at, 0.1, 40), ground = Number.isFinite(floor) ? floor : at.y - 3
    const out = f.hitFrom.lengthSq() > 0 ? s.a.copy(f.hitFrom).setY(0) : s.a.set(Math.random() - 0.5, 0, Math.random() - 0.5)
    if (out.lengthSq() < 1e-4) out.set(0, 0, 1)
    out.normalize()
    const gore = this.context.gore
    gore.pop(at, 1.3, 0.34)
    gore.fling(at, out, 7, ground, 1.1, 3.2, 1)
    gore.spray(at, out, 34, ground, 3.4)
    if (f.arrived) this.look.shed(f, ground)
    this.context.emit({ kind: 'inkwing-death', position: at.clone(), radius: 45 })
    zombie.position.y = ground
  }

  // ---------------------------------------------------------------- co-op

  /** The host's row for an Inkwing: [pool index, state, x, y, z, yaw, velocity x y z, flags, seconds left forming, health]. */
  row(zombie: Zombie, index: number): ZombieSnap {
    const f = this.flock.get(zombie)!, dead = zombie.state === 'dead'
    const p = dead ? f.burst : zombie.position, v = f.velocity
    return [index, dead ? 2 : 1, r2(p.x), r2(p.y), r2(p.z), r2(zombie.yaw), r2(v.x), r2(v.y), r2(v.z),
      FLYER_ROW.flag | MODES.indexOf(f.mode) << FLYER_ROW.shift, f.mode === 'form' ? r2(INKWING.form - f.clock) : 0,
      zombie.maxHealth > 0 ? r2(zombie.health / zombie.maxHealth) : 0]
  }

  /**
   * A co-op guest: the host's Inkwing rows drive the flock here (no thinking of its own), easing each one to where
   * the host has it, carried on by its velocity between snapshots. Returns every other row, for the zombies.
   */
  puppet(dt: number, rows: readonly ZombieSnap[]): ZombieSnap[] {
    this.time += dt
    if (rows !== this.rows) { this.rows = rows; this.rowAge = 0 } else this.rowAge += dt
    const rest: ZombieSnap[] = [], held = this.held
    held.clear()
    for (const row of rows) {
      const flags = row[9]
      if (!(flags & FLYER_ROW.flag)) { rest.push(row); continue }
      const zombie = this.context.pool[row[0]]
      if (!zombie) continue
      held.add(zombie)
      const mode = MODES[(flags >> FLYER_ROW.shift) & FLYER_ROW.mask] ?? 'fly'
      let f = this.flock.get(zombie)
      if (!f) {
        if (row[1] !== 1) continue
        // A body still sinking here that the host has already reused: it goes.
        if (zombie.state !== 'idle') zombie.state = 'idle'
        f = this.adopt(zombie, s.a.set(row[2], row[3], row[4]), 1)
        f.mode = mode
        f.struck = f.arrived = mode !== 'form'
        f.size = f.arrived ? 1 : 0
      } else if (mode !== f.mode && zombie.state === 'chase') this.setMode(f, mode)
      if (mode === 'form' && this.rowAge === 0) f.clock = INKWING.form - row[10]
      f.row.set(row[2], row[3], row[4])
      f.rowVelocity.set(row[6], row[7], row[8])
      f.rowYaw = row[5]
      zombie.health = row[11] * zombie.maxHealth
      if (row[1] === 2 && zombie.state === 'chase') { zombie.position.copy(f.row); this.kill(zombie) }
    }
    // Inkwings the host no longer has are gone (a dead one has burst already).
    for (const f of this.flock.values()) if (!held.has(f.zombie)) this.release(f)
    // Each flies on at the host's velocity, and what it is off from the host's place (carried on since that row) is
    // taken up over a few frames: no lag behind a fast one, no jump when a row comes.
    const ease = 1 - Math.exp(-dt * 12), ahead = Math.min(this.rowAge, 0.2)
    for (const f of this.flock.values()) {
      const z = f.zombie
      if (z.state !== 'chase') continue
      this.tick(f, dt)
      const goal = s.b.copy(f.row).addScaledVector(f.rowVelocity, ahead)
      if (z.position.distanceToSquared(goal) > 16) z.position.copy(goal)
      else z.position.addScaledVector(f.rowVelocity, this.rowAge < 0.2 ? dt : 0).lerp(goal, ease)
      f.velocity.copy(f.rowVelocity)
      z.yaw = wrap(z.yaw + wrap(f.rowYaw - z.yaw) * ease)
    }
    this.draw(dt)
    return rest
  }

  // ---------------------------------------------------------------- the look

  /** Wings, eyes, body pose and drips from each one's mode and flight, then every instance drawn. */
  private draw(dt: number) {
    for (const f of this.flock.values()) {
      if (f.zombie.state !== 'chase') continue
      this.animate(f, dt)
      if (!f.arrived || f.mode === 'dive') continue
      if ((f.drip -= dt) <= 0) {
        f.drip = 0.45 + Math.random() * 0.5
        this.look.drip(f, f.floor)
      }
      // A wingbeat heard now and then (never oftener than every 0.4 s each), and only near: a flock must not flood the voices.
      if (f.mode !== 'tell' && f.mode !== 'snap' && (f.beat -= dt) <= 0) {
        f.beat = 0.42 + Math.random() * 0.2
        this.context.emit({ kind: 'inkwing-flap', position: f.zombie.position.clone(), radius: 25 })
      }
    }
    this.look.draw(this.flock.values(), dt)
  }

  private animate(f: Inkwing, dt: number) {
    const v = f.velocity, speed = v.length(), mode = f.mode, tell = INKWING.dive.tell
    const rate = mode === 'form' ? 9 : mode === 'strike' || mode === 'pull' ? 7.5 : mode === 'tell' ? 3.5 : mode === 'dive' ? 0 : 4.6 + speed * 0.18
    f.flap += dt * Math.PI * 2 * rate
    const fold = mode === 'tell' ? 0.85 * THREE.MathUtils.smoothstep(f.clock, 0, tell) : mode === 'dive' ? 1 : mode === 'snap' ? 0.45 : 0
    f.fold += (fold - f.fold) * (1 - Math.exp(-dt * (mode === 'dive' ? 22 : 10)))
    const flare = mode === 'tell' ? 0.3 + 0.7 * THREE.MathUtils.smoothstep(f.clock, 0, tell) : mode === 'dive' || mode === 'snap' ? 1 : mode === 'strike' ? 0.6 : 0
    f.flare += (flare - f.flare) * (1 - Math.exp(-dt * 12))
    if (mode === 'form') {
      const t = THREE.MathUtils.clamp((f.clock - INKWING.fall) / (INKWING.form - INKWING.fall), 0, 1)
      f.size = f.arrived ? 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2 : 0
    } else f.size = 1
    const flat = Math.hypot(v.x, v.z)
    const pitch = mode === 'tell' ? -0.5 : mode === 'dive' ? Math.atan2(-v.y, Math.max(flat, 0.01))
      : THREE.MathUtils.clamp(Math.atan2(-v.y, Math.max(flat, 2)) * 0.8, -0.7, 0.7)
    f.pitch += (pitch - f.pitch) * (1 - Math.exp(-dt * (mode === 'dive' ? 20 : 8)))
  }

  clear() {
    for (const f of this.flock.values()) f.zombie.state = 'idle'
    this.flock.clear()
    this.diving.clear(); this.dived.clear(); this.watched.clear()
    this.rows = null
    this.look.clear()
  }

  dispose() {
    this.clear()
    this.look.dispose()
  }
}

// ---------------------------------------------------------------- the storm's pack

/**
 * The Ink Storm's pack as it comes: the runtime asks it what each arrival is, a group of Inkwings out of the storm
 * or a sprinter, in about the shares rules.ts gives. The round's own count stays in charge of how many come in all.
 */
export class StormPack {
  flyers = 0
  sprinters = 0

  /** A storm starts: its pack for the round and the players. Returns how many come in all. */
  begin(round: number, players: number) {
    const pack = stormPack(round, players)
    this.flyers = pack.flyers
    this.sprinters = pack.sprinters
    return pack.flyers + pack.sprinters
  }

  /** The next arrival: a group of Inkwings (how many, at most `room`), or 0 for a sprinter. */
  next(random: Random, room: number) {
    const [low, high] = INKWINGS.group
    const groups = this.flyers / ((low + high) / 2)
    if (this.flyers <= 0 || (this.sprinters > 0 && random() < this.sprinters / (this.sprinters + groups))) {
      this.sprinters = Math.max(0, this.sprinters - 1)
      return 0
    }
    const size = Math.max(1, Math.min(this.flyers, room, low + Math.floor(random() * (high - low + 1))))
    this.flyers -= size
    return size
  }

  /** Inkwings that found nowhere to come out come later. */
  back(flyers: number) { this.flyers += flyers }
}

// ---------------------------------------------------------------- how they look

/** Pieces of a body merged into one geometry: position and normal only. */
function merged(parts: THREE.BufferGeometry[]) {
  const flat = parts.map(part => {
    part.deleteAttribute('uv')
    const out = part.index ? part.toNonIndexed() : part
    if (out !== part) part.dispose()
    return out
  })
  const geometry = mergeGeometries(flat)!
  flat.forEach(part => part.dispose())
  geometry.computeBoundingSphere()
  return geometry
}

const place = (geometry: THREE.BufferGeometry, position: readonly number[], rotation: readonly number[] = [0, 0, 0], scale: readonly number[] = [1, 1, 1]) =>
  geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])), new THREE.Vector3(...scale)))

/**
 * Its body, facing +Z: a lean ink body and a head with a hooked beak, two ragged horns, a crest of tufts down its back,
 * and the drip of ink hanging off its tail, about 0.65 m from beak to drop.
 */
function bodyGeometry() {
  const parts = [
    place(new THREE.SphereGeometry(1, 14, 10), [0, 0, -0.03], [0, 0, 0], [0.1, 0.095, 0.2]),
    place(new THREE.SphereGeometry(1, 12, 9), [0, 0.045, 0.17], [0, 0, 0], [0.078, 0.075, 0.085]),
    place(new THREE.ConeGeometry(0.036, 0.13, 7), [0, 0.03, 0.29], [Math.PI / 2 + 0.25, 0, 0]),
    place(new THREE.ConeGeometry(0.05, 0.3, 8), [0, -0.16, -0.26], [-2.5, 0, 0]),
    place(new THREE.SphereGeometry(0.038, 8, 6), [TAIL_TIP.x, TAIL_TIP.y, TAIL_TIP.z], [0, 0, 0], [1, 1.25, 1]),
  ]
  for (const side of [-1, 1]) parts.push(place(new THREE.ConeGeometry(0.02, 0.1, 5), [side * 0.04, 0.115, 0.14], [-0.7, 0, -side * 0.35]))
  for (let i = 0; i < 3; i++) parts.push(place(new THREE.ConeGeometry(0.018, 0.07, 4), [0, 0.09 - i * 0.012, 0.03 - i * 0.08], [-0.95, 0, 0]))
  return merged(parts)
}

/**
 * One wing, the left (+X), hinged at the origin: a ragged membrane, torn into points along its trailing edge, with a
 * little thickness so its edge takes the ink outline. The right is the same, mirrored.
 */
function wingGeometry() {
  const edge: [number, number][] = [
    [0, 0.08], [0.14, 0.13], [0.3, 0.15], [0.46, 0.12], [0.6, 0.06], [0.7, -0.02],
    [0.61, -0.06], [0.58, -0.01], [0.52, -0.16], [0.45, -0.08], [0.39, -0.24], [0.31, -0.12],
    [0.24, -0.27], [0.17, -0.13], [0.1, -0.22], [0.04, -0.1], [0, -0.11],
  ]
  const extruded = new THREE.ExtrudeGeometry(new THREE.Shape(edge.map(([x, z]) => new THREE.Vector2(x, z))), { depth: 0.014, bevelEnabled: false })
  // The shape's plane onto the ground plane (its y becomes +Z), its thickness downward, then centred.
  extruded.rotateX(Math.PI / 2)
  extruded.translate(0, 0.007, 0)
  extruded.deleteAttribute('uv')
  extruded.deleteAttribute('normal')
  // One vertex per corner, so the normals are smooth and the outline shell has no cracks at the edges.
  const geometry = mergeVertices(extruded)
  extruded.dispose()
  geometry.clearGroups()
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/** The two red eyes, round the point between them. */
function eyeGeometry() {
  return merged([-1, 1].map(side => place(new THREE.SphereGeometry(0.021, 8, 6), [side * 0.038, 0, 0], [0, 0, 0], [1, 0.75, 0.6])))
}

/** A streak of ink falling from the sky: thin at the top, thicker where it lands, 1 m long downward from its origin. */
function streakGeometry() {
  const geometry = new THREE.CylinderGeometry(0.018, 0.075, 1, 6, 1, true)
  geometry.translate(0, -0.5, 0)
  geometry.deleteAttribute('uv')
  return geometry
}

/** A soft red glow for eyes flaring. Red: the one colour on them, and it means danger. */
function glowTexture() {
  const size = 32, data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2), a = Math.max(0, 1 - d) ** 2
    data.set([212, 51, 42, Math.round(a * 255)], (y * size + x) * 4)
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/**
 * The ink outline, as the stickman has it (lab/rig.ts): back faces pushed out a fixed number of screen pixels along
 * their normals, for instanced bodies. Every Inkwing's outline is one draw call per part.
 */
function outlineMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ink: { value: new THREE.Color(penPalette.character) }, resolution: { value: new THREE.Vector2(1, 1) }, width: { value: 1.2 } },
    vertexShader: `
      uniform vec2 resolution;
      uniform float width;
      void main() {
        vec4 local = vec4(position, 1.0);
        vec3 bent = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          bent = mat3(instanceMatrix) * bent;
        #endif
        vec4 view = modelViewMatrix * local;
        vec4 clip = projectionMatrix * view;
        vec3 n = normalize(normalMatrix * bent);
        vec4 tip = projectionMatrix * vec4(view.xyz + n, 1.0);
        vec2 direction = (tip.xy * clip.w - clip.xy * tip.w) * resolution;
        direction /= max(length(direction), 0.0001);
        clip.xy += direction * width * 2.0 / resolution * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: `
      uniform vec3 ink;
      void main() {
        gl_FragColor = vec4(ink, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide, depthWrite: false,
  })
}

type Streak = { top: THREE.Vector3; length: number; age: number }
type Drop = { position: THREE.Vector3; velocity: THREE.Vector3; floor: number; age: number }
type Torn = { position: THREE.Vector3; velocity: THREE.Vector3; rotation: THREE.Quaternion; spin: THREE.Vector3; side: 1 | -1; floor: number; age: number }

const MOST = { flyers: 40, streaks: 16, drops: 90, torn: 24, glows: 8 } as const
/** The streak falls as long as the Inkwing's entrance says, lingers a moment, and dries away. */
const STREAK = { grow: INKWING.fall, hold: 0.1, fade: 0.35 } as const
const TORN = { life: 3.2, melt: 0.8 } as const

class InkwingLook {
  readonly root = new THREE.Group()
  private fill = new THREE.MeshBasicMaterial({ color: penPalette.character, toneMapped: false })
  private wingFill = new THREE.MeshBasicMaterial({ color: penPalette.character, toneMapped: false, side: THREE.DoubleSide })
  private outline = outlineMaterial()
  private bodies: THREE.InstancedMesh
  private bodyLines: THREE.InstancedMesh
  private wings: THREE.InstancedMesh
  private wingLines: THREE.InstancedMesh
  private eyes: THREE.InstancedMesh
  private streaks: THREE.InstancedMesh
  private drops: THREE.InstancedMesh
  private glows: THREE.Sprite[] = []
  private glowTexture = glowTexture()
  private streakList: Streak[] = []
  private dropList: Drop[] = []
  private tornList: Torn[] = []
  private m = new THREE.Matrix4()
  private body = new THREE.Matrix4()
  private local = new THREE.Matrix4()
  private step = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private p = new THREE.Vector3()
  private k = new THREE.Vector3()
  private viewport = new THREE.Vector4()

  constructor(scene: THREE.Object3D) {
    this.root.name = 'Inkwings'
    this.root.userData.noCollision = true
    const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number, name: string) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count)
      mesh.name = name
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      mesh.userData.noCollision = true
      this.root.add(mesh)
      return mesh
    }
    const body = bodyGeometry(), wing = wingGeometry()
    this.bodies = instanced(body, this.fill, MOST.flyers, 'Inkwing bodies')
    this.wings = instanced(wing, this.wingFill, MOST.flyers * 2 + MOST.torn, 'Inkwing wings')
    // The outlines share their parts' geometry and instance matrices.
    this.bodyLines = instanced(body, this.outline, MOST.flyers, 'Inkwing body outlines')
    this.wingLines = instanced(wing, this.outline, MOST.flyers * 2 + MOST.torn, 'Inkwing wing outlines')
    this.bodyLines.instanceMatrix = this.bodies.instanceMatrix
    this.wingLines.instanceMatrix = this.wings.instanceMatrix
    this.bodyLines.renderOrder = this.wingLines.renderOrder = 1
    const resolution = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => {
      renderer.getViewport(this.viewport)
      const viewport = (camera as THREE.PerspectiveCamera).viewport
      const xr = renderer.xr.isPresenting && viewport
      this.outline.uniforms.resolution.value.set(xr ? viewport.z : this.viewport.z, xr ? viewport.w : this.viewport.w)
    }
    this.bodyLines.onBeforeRender = (renderer, _scene, camera) => resolution(renderer, camera)
    this.eyes = instanced(eyeGeometry(), zombieEyeMaterial(), MOST.flyers, 'Inkwing eyes')
    this.streaks = instanced(streakGeometry(), new THREE.MeshBasicMaterial({ color: penPalette.ink, toneMapped: false, side: THREE.DoubleSide }), MOST.streaks, 'Inkwing streaks')
    this.drops = instanced(new THREE.SphereGeometry(1, 5, 4), new THREE.MeshBasicMaterial({ color: penPalette.ink, toneMapped: false }), MOST.drops, 'Inkwing drips')
    for (let i = 0; i < MOST.glows; i++) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, transparent: true, depthWrite: false, toneMapped: false }))
      glow.name = 'Inkwing eye glow'
      glow.visible = false
      glow.renderOrder = 12
      glow.userData.noCollision = true
      this.glows.push(glow)
      this.root.add(glow)
    }
    scene.add(this.root)
  }

  /** Draw calls for the whole flock in flight (bodies, wings, eyes and their outlines). */
  get drawCalls() { return [this.bodies, this.bodyLines, this.wings, this.wingLines, this.eyes].filter(mesh => mesh.count > 0).length }

  /** The streak of ink an Inkwing comes down on, from `top` to `at`. */
  streak(at: THREE.Vector3, top: THREE.Vector3) {
    this.streakList.push({ top: top.clone(), length: Math.max(0.5, top.y - at.y), age: 0 })
    if (this.streakList.length > MOST.streaks) this.streakList.shift()
  }

  /** A drop of ink off its tail, falling to the floor. */
  drip(f: Inkwing, floor: number) {
    this.bodyMatrix(f, this.body)
    this.dropList.push({ position: TAIL_TIP.clone().applyMatrix4(this.body), velocity: f.velocity.clone().multiplyScalar(0.3).setY(-0.4), floor, age: 0 })
    if (this.dropList.length > MOST.drops) this.dropList.shift()
  }

  /** Its wings torn off as it bursts: they flutter down to `floor` like scraps of paper and melt into it. */
  shed(f: Inkwing, floor: number) {
    this.bodyMatrix(f, this.body)
    for (const side of [1, -1] as const) {
      this.wingMatrix(f, side, this.m.copy(this.body))
      const position = new THREE.Vector3(), rotation = new THREE.Quaternion()
      this.m.decompose(position, rotation, this.k)
      const out = new THREE.Vector3(side, 0, 0).applyQuaternion(rotation).setY(0)
      this.tornList.push({ position, rotation, side, floor, age: 0,
        velocity: out.multiplyScalar(1.6 + Math.random()).add(f.hitFrom.clone().multiplyScalar(1.5)).setY(1.2 + Math.random()),
        spin: new THREE.Vector3(Math.random() * 6 - 3, Math.random() * 4 - 2, Math.random() * 6 - 3) })
    }
    while (this.tornList.length > MOST.torn) this.tornList.shift()
  }

  /** Where its body is and how it sits: heading, pitch and bank, bobbing with the wingbeat, grown to its size. */
  private bodyMatrix(f: Inkwing, out: THREE.Matrix4) {
    const z = f.zombie, bob = -0.03 * Math.cos(f.flap) * (1 - f.fold)
    this.p.copy(z.position).setY(z.position.y + bob)
    this.q.setFromEuler(this.e.set(f.pitch, z.yaw, f.bank, 'YXZ'))
    return out.compose(this.p, this.q, this.k.setScalar(Math.max(1e-3, f.size)))
  }

  /** A wing on `side` (1 its left, -1 its right) under its body's matrix `out`: beating, or folded back along its body. */
  private wingMatrix(f: Inkwing, side: 1 | -1, out: THREE.Matrix4) {
    const beat = f.mode === 'dive' ? 0 : Math.sin(f.flap) * 0.75 * (1 - f.fold)
    const lift = 0.12 + beat - 0.45 * f.fold
    this.local.makeTranslation(side * 0.055, 0.03, -0.01)
    this.local.multiply(this.step.makeScale(side, 1, 1))
    this.local.multiply(this.step.makeRotationZ(lift))
    this.local.multiply(this.step.makeRotationY(-1.2 * f.fold))
    this.local.multiply(this.step.makeScale(1 - 0.4 * f.fold, 1, 1))
    return out.multiply(this.local)
  }

  draw(flock: Iterable<Inkwing>, dt: number) {
    let n = 0, w = 0, g = 0
    for (const f of flock) {
      if (f.zombie.state !== 'chase' || f.size <= 1e-3 || n >= MOST.flyers) continue
      this.bodyMatrix(f, this.body)
      this.bodies.setMatrixAt(n, this.body)
      this.eyes.setMatrixAt(n, this.m.copy(this.body).multiply(this.local.compose(EYES, this.q.identity(), this.k.setScalar(1 + 1.3 * f.flare))))
      n++
      for (const side of [1, -1] as const) this.wings.setMatrixAt(w++, this.wingMatrix(f, side, this.m.copy(this.body)))
      // Eyes flaring: a red glow round them, so the tell reads from across the yard.
      if (f.flare > 0.2 && g < this.glows.length) {
        const glow = this.glows[g++]
        glow.visible = true
        glow.position.copy(EYES).applyMatrix4(this.body)
        glow.scale.setScalar(0.5 * f.flare * f.size)
        glow.material.opacity = Math.min(1, f.flare * 1.1)
      }
    }
    for (let i = g; i < this.glows.length; i++) this.glows[i].visible = false
    this.updateTorn(dt, w)
    this.finish(this.bodies, n); this.finish(this.bodyLines, n); this.finish(this.eyes, n)
    w += this.tornDrawn
    this.finish(this.wings, w); this.finish(this.wingLines, w)
    this.updateStreaks(dt)
    this.updateDrops(dt)
  }

  private tornDrawn = 0
  private updateTorn(dt: number, first: number) {
    const delta = Math.min(dt, 0.05)
    this.tornList = this.tornList.filter(t => (t.age += delta) < TORN.life)
    let w = first
    for (const t of this.tornList) {
      if (t.position.y > t.floor + 0.02) {
        // Fluttering: heavy air under it, a swing side to side.
        t.velocity.y = Math.max(-1.4, t.velocity.y - 9 * delta)
        t.velocity.x *= Math.exp(-delta * 1.5); t.velocity.z *= Math.exp(-delta * 1.5)
        t.position.addScaledVector(t.velocity, delta)
        t.position.x += Math.sin(t.age * 7 + t.side) * 0.6 * delta
        t.rotation.multiply(this.q.setFromEuler(this.e.set(t.spin.x * delta, t.spin.y * delta, t.spin.z * delta)))
        if (t.position.y <= t.floor + 0.02) {
          t.position.y = t.floor + 0.02
          // Down flat on the floor.
          const heading = new THREE.Vector3(0, 0, 1).applyQuaternion(t.rotation).setY(0)
          t.rotation.setFromAxisAngle(UP, Math.atan2(heading.x, heading.z))
          t.age = Math.max(t.age, TORN.life - TORN.melt - 0.6)
        }
      }
      const melt = THREE.MathUtils.smoothstep(t.age, TORN.life - TORN.melt, TORN.life)
      this.m.compose(t.position, t.rotation, this.k.set(t.side * (1 - melt * 0.4), 1 - melt, 1 - melt * 0.3))
      this.wings.setMatrixAt(w++, this.m)
    }
    this.tornDrawn = w - first
  }

  private updateStreaks(dt: number) {
    this.streakList = this.streakList.filter(streak => (streak.age += dt) < STREAK.grow + STREAK.hold + STREAK.fade)
    this.streakList.forEach((streak, i) => {
      const grow = Math.min(1, streak.age / STREAK.grow)
      const thin = 1 - THREE.MathUtils.smoothstep(streak.age, STREAK.grow + STREAK.hold, STREAK.grow + STREAK.hold + STREAK.fade)
      this.streaks.setMatrixAt(i, this.m.compose(streak.top, this.q.identity(), this.k.set(Math.max(0.02, thin), streak.length * grow, Math.max(0.02, thin))))
    })
    this.finish(this.streaks, this.streakList.length)
  }

  private updateDrops(dt: number) {
    const delta = Math.min(dt, 0.05)
    this.dropList = this.dropList.filter(drop => {
      drop.age += delta
      drop.velocity.y -= 14 * delta
      drop.position.addScaledVector(drop.velocity, delta)
      return drop.position.y > drop.floor && drop.age < 2
    })
    this.dropList.forEach((drop, i) => {
      const stretch = 1 + Math.min(1.6, -drop.velocity.y * 0.25)
      this.drops.setMatrixAt(i, this.m.compose(drop.position, this.q.identity(), this.k.set(0.018, 0.018 * stretch, 0.018)))
    })
    this.finish(this.drops, this.dropList.length)
  }

  private finish(mesh: THREE.InstancedMesh, count: number) {
    mesh.count = count
    mesh.visible = count > 0
    mesh.instanceMatrix.needsUpdate = true
  }

  clear() {
    this.streakList = []; this.dropList = []; this.tornList = []
    for (const glow of this.glows) glow.visible = false
    for (const mesh of [this.bodies, this.bodyLines, this.wings, this.wingLines, this.eyes, this.streaks, this.drops]) this.finish(mesh, 0)
  }

  dispose() {
    this.clear()
    this.root.removeFromParent()
    for (const mesh of [this.bodies, this.wings, this.eyes, this.streaks, this.drops]) mesh.geometry.dispose()
    for (const mesh of [this.bodies, this.bodyLines, this.wings, this.wingLines, this.eyes, this.streaks, this.drops]) mesh.dispose()
    // The eyes' material is the zombies' own, shared: it stays.
    for (const material of [this.fill, this.wingFill, this.outline, this.streaks.material as THREE.Material, this.drops.material as THREE.Material]) material.dispose()
    for (const glow of this.glows) glow.material.dispose()
    this.glowTexture.dispose()
  }
}
