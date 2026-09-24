import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import type { CollisionWorld } from '../../player/collision'
import { Draft, palette, type Point } from '../../render/ink'
import { WALL_THICKNESS } from '../../world/architecture'
import { seeded, type Random } from '../shared/random'
import type { SoundEvent } from '../types'
import type { WindowSlot, Zombie } from './director'
import type { NavGraph } from './navgraph'
import { POINTS } from './rules'

/**
 * Call of Duty's barriers. The mess hall's windows on the road side, outside the compound, are boarded up
 * with six planks each. Some zombies climb out of the ground out on the road, walk up to a window, rip the
 * planks off one at a time and climb in; players rebuild them from inside, a plank at a time while F is
 * held, for points.
 *
 * Zombie mode only: the hostage mission never builds these. The windows' glass comes out (hidden, and out of
 * the collision world), a blocker that stops players but not bullets or sight fills each opening, a step
 * of two crates outside brings the sill to a zombie's hip, and the navigation graph is cut along the hall's
 * outer walls, so the road side comes in through the windows and nowhere else (the cut takes the baked
 * wall climbs that went through the north wall onto the serving counter, and the roof ladder, with it).
 * Everything is put back by dispose().
 */
export const WINDOW = {
  /** Planks on each window. */
  boards: 6,
  /** Seconds a zombie takes to rip one plank off, and between planks while a player holds F. */
  tearSeconds: 1, repairSeconds: 0.6,
  /**
   * Points for each plank a zombie tore off and a player put back, and the most one player earns from
   * rebuilding in a round. VERIFIED as far as rules.ts: 10 a board; the 500-a-round cap is from the later
   * Call of Duty games (Black Ops on).
   */
  points: POINTS.board, roundCap: 500,
  /** Seconds at the window before a zombie smashes whatever is left and climbs in anyway; the most any zombie spends on a window, waiting included. */
  giveUp: 20, stuck: 60,
  /** The climb through, in seconds. */
  vaultSeconds: 1.3,
  /**
   * Share of spawns that come from the road, through a window, while a window's inside is within
   * `activeRange` metres' walk of a player. Our own number, tuned by play: the rest still claw out of the
   * ground around you, Dead Ink's signature.
   */
  spawnShare: 0.35, activeRange: 45,
  /** Most zombies at one window: the one tearing and those waiting their turn. */
  crowd: 3,
  /** A zombie on its way to a window goes for a player out on the road with it instead, this close. */
  notice: 6,
} as const

/** The windows that get barriers, by name (their order is the co-op order): the mess hall's, facing the road. */
export const BARRIER_WINDOWS = [
  'Mess hall · west exterior wall · window 6.8',
  'Mess hall · north exterior wall · window -3.6',
  'Mess hall · north exterior wall · window 3.5',
  'Mess hall · north exterior wall · window 10.2',
] as const
/** The hall's outer walls cut from the zombies' graph (not the south one, with the yard door in it). */
const SEALED_WALLS = ['Mess hall · north exterior wall', 'Mess hall · west exterior wall', 'Mess hall · east exterior wall'] as const

/** The step outside a window: a tall crate against the wall, a low one in front; a body stands this far out on the tall one. */
const STEP = { high: 0.95, highWidth: 1.1, highDepth: 0.7, low: 0.5, lowWidth: 0.9, lowDepth: 0.55, stand: 0.35 } as const
/** A plank: its height, thickness, and how far past the opening it reaches each side to take its nails. */
const PLANK = { height: 0.17, thickness: 0.035, overhang: 0.15 } as const
/** Planks come off from the middle outward (and go back the other way). Index 0 is the lowest plank. */
const TEAR_ORDER = [2, 3, 1, 4, 0, 5] as const
/** How far out on the road zombies climb out of the ground for a window, and how far to either side. */
const RISE = { out: [3.6, 4.8, 6, 7.2], side: [-2.4, -1.2, 0, 1.2, 2.4] } as const

/** Points from rebuilding, per player and per round, never past the cap. */
export class RepairLedger {
  private round = -1
  private paid = new Map<string, number>()

  /** What `player` has earned rebuilding in `round`. */
  paidBy(player: string, round: number) { this.roll(round); return this.paid.get(player) ?? 0 }
  /** What `player` may still earn rebuilding in `round`. */
  left(player: string, round: number) { return Math.max(0, WINDOW.roundCap - this.paidBy(player, round)) }
  /** Pay up to `points` to `player` for a plank in `round`, within the cap. Returns what was paid. */
  take(player: string, round: number, points: number) {
    const pay = Math.max(0, Math.min(points, this.left(player, round)))
    this.paid.set(player, this.paidBy(player, round) + pay)
    return pay
  }
  reset() { this.round = -1; this.paid.clear() }
  private roll(round: number) { if (round !== this.round) { this.round = round; this.paid.clear() } }
}

type Plank = {
  /** Where it sits nailed up. */
  nailed: { position: THREE.Vector3; quaternion: THREE.Quaternion }
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  motion: 'none' | 'off' | 'back'
  velocity: THREE.Vector3
  spin: THREE.Vector3
  /**
   * A flight back, 0 to 1; where it started; and the point it curves through, straight out from its nails, so
   * it comes in through the opening along its own row rather than through the wall under the sill.
   */
  t: number
  from: { position: THREE.Vector3; quaternion: THREE.Quaternion }
  via: THREE.Vector3
  /** The ground outside, if it falls short of anything else. */
  ground: number
}

/** One boarded window. The director reads it as a WindowSlot; the planks are drawn by Barriers. */
export class Barrier implements WindowSlot {
  boards: number = WINDOW.boards
  /** Planks a zombie ripped off that nobody has put back yet: only these pay when rebuilt. */
  torn = 0
  /** Every plank ever ripped off here (a co-op guest times its puppet's yank to it changing). */
  ripped = 0
  occupant: Zombie | null = null
  waiting: Zombie[] = []
  vaulting: Zombie | null = null
  /** Where the prompt sits, just inside the opening; the graph spot a zombie lands on inside. */
  readonly point: THREE.Vector3
  readonly landingNode: number
  /** Where zombies climb out of the ground for this window, and wait their turn. */
  readonly rises: THREE.Vector3[] = []
  readonly queue: THREE.Vector3[] = []
  readonly foot: THREE.Vector3
  readonly steps: THREE.Vector3[]
  readonly stand: THREE.Vector3
  readonly landing: THREE.Vector3
  readonly tangent: THREE.Vector3
  readonly facing: number
  readonly planks: Plank[] = []

  constructor(readonly index: number, readonly name: string, readonly window: THREE.Object3D, readonly centre: THREE.Vector3,
    readonly inward: THREE.Vector3, readonly halfWidth: number, readonly sill: number, readonly top: number,
    readonly floorIn: number, readonly floorOut: number, graph: NavGraph, private owner: Barriers) {
    this.tangent = new THREE.Vector3(inward.z, 0, -inward.x)
    this.facing = Math.atan2(inward.x, inward.z)
    const out = (distance: number, y: number, side = 0) => centre.clone().addScaledVector(inward, -distance).addScaledVector(this.tangent, side).setY(y)
    const face = WALL_THICKNESS / 2
    this.stand = out(face + STEP.stand, floorOut + STEP.high)
    this.steps = [out(face + STEP.highDepth + STEP.lowDepth / 2, floorOut + STEP.low), this.stand]
    this.foot = out(face + STEP.highDepth + STEP.lowDepth + 0.35, floorOut)
    this.landing = out(-(face + 0.78), floorIn)
    this.point = out(-(face + 0.08), (sill + top) / 2)
    this.landingNode = graph.nearest(this.landing, 2)
  }

  /** On the room's side of the wall. */
  inside(point: THREE.Vector3) {
    return (point.x - this.centre.x) * this.inward.x + (point.z - this.centre.z) * this.inward.z > 0.05
  }

  /** The middle of the plank that comes off next, where a hand grabs it. */
  nextBoard(out: THREE.Vector3) {
    const plank = this.planks[TEAR_ORDER[Math.min(WINDOW.boards - 1, WINDOW.boards - this.boards)]]
    return out.copy(plank.nailed.position)
  }

  /** A zombie rips a plank off: it flies, with a crack of wood. False when there is none left. */
  tear() {
    if (this.boards <= 0) return false
    const plank = this.planks[TEAR_ORDER[WINDOW.boards - this.boards]]
    this.boards--
    this.torn = Math.min(WINDOW.boards, this.torn + 1)
    this.ripped++
    this.owner.flyOff(this, plank)
    return true
  }

  /** Everything left comes off at once (a zombie that waited too long). */
  smash() { while (this.boards > 0) this.tear() }

  /**
   * A plank goes back up, hammered in. 'owed' when it was one a zombie ripped off (it pays), 'free'
   * otherwise, false when nothing can go up (the window is whole, or a zombie is climbing through it).
   */
  rebuild(): 'owed' | 'free' | false {
    if (this.boards >= WINDOW.boards || this.vaulting) return false
    this.boards++
    const owed = this.torn > 0
    if (owed) this.torn--
    this.owner.flyBack(this, this.planks[TEAR_ORDER[WINDOW.boards - this.boards]])
    return owed ? 'owed' : 'free'
  }
}

/** Every barrier, the planks drawn for all of them, their colliders, and the graph cuts. */
export class Barriers {
  readonly list: Barrier[] = []
  readonly ledger = new RepairLedger()
  /** Everything drawn (never collides); the invisible colliders; the graph cuts, to undo. */
  readonly root = new THREE.Group()
  private colliders = new THREE.Group()
  private gaps: number[] = []
  private paper: THREE.InstancedMesh
  private shell: THREE.InstancedMesh
  private nails: THREE.InstancedMesh
  private frames: Draft
  private dirty = true
  private matrix = new THREE.Matrix4()
  private nailMatrix = new THREE.Matrix4()
  private nailOffsets = [new THREE.Matrix4(), new THREE.Matrix4()]
  private scratch = { q: new THREE.Quaternion(), v: new THREE.Vector3(), probe: new THREE.Vector3(), lie: new THREE.Euler() }
  private weights: number[] = []
  private static readonly unit = new THREE.Vector3(1, 1, 1)

  constructor(scene: THREE.Scene, private world: CollisionWorld, private graph: NavGraph, private emit: (event: SoundEvent) => void = () => {}) {
    this.root.name = 'Dead Ink barriers'
    this.root.userData.noCollision = true
    this.colliders.name = 'Dead Ink barriers · colliders'
    this.frames = new Draft('Dead Ink barriers · frames and steps')
    const hidden = new THREE.MeshBasicMaterial({ visible: false })
    scene.updateMatrixWorld(true)
    for (const name of BARRIER_WINDOWS) {
      const window = scene.getObjectByName(name)
      const glass = window?.children.find(child => child.name.endsWith(': glass surfaces'))
      let hall: THREE.Object3D | null = window ?? null
      while (hall && hall.userData.kind !== 'mess-hall') hall = hall.parent
      if (!window || !glass || !hall) { console.warn(`Dead Ink: no window "${name}" for a barrier`); continue }
      // The opening is exactly the glass pane; the wall runs along the pane's long side.
      const box = new THREE.Box3().setFromObject(glass), size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3())
      const inward = size.x < size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)
      if (inward.dot(hall.getWorldPosition(new THREE.Vector3()).sub(centre)) < 0) inward.negate()
      const halfWidth = Math.max(size.x, size.z) / 2, sill = box.min.y, top = box.max.y
      const floorIn = world.floor(centre.clone().addScaledVector(inward, 0.8).setY(sill), 0.3, 3)
      const floorOut = world.floor(centre.clone().addScaledVector(inward, -0.9).setY(sill), 0.3, 3)
      if (!Number.isFinite(floorIn) || !Number.isFinite(floorOut)) { console.warn(`Dead Ink: no floor either side of "${name}"`); continue }
      const barrier = new Barrier(this.list.length, name, window, centre, inward, halfWidth, sill, top, floorIn, floorOut, graph, this)
      this.list.push(barrier)
      // The glass comes out; a player blocker goes into the hole (bullets and sight pass); the step outside.
      window.visible = false
      world.removeObject(window)
      const solid = (w: number, h: number, d: number, at: THREE.Vector3, see: boolean) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), hidden)
        mesh.position.copy(at); mesh.rotation.y = barrier.facing
        mesh.userData.blocksSight = see; mesh.userData.blocksShots = see
        this.colliders.add(mesh)
      }
      solid(halfWidth * 2, top - sill, WALL_THICKNESS + 0.12, centre.clone().setY((sill + top) / 2), false)
      const face = WALL_THICKNESS / 2
      solid(STEP.highWidth, STEP.high, STEP.highDepth, centre.clone().addScaledVector(inward, -(face + STEP.highDepth / 2)).setY(floorOut + STEP.high / 2), true)
      solid(STEP.lowWidth, STEP.low, STEP.lowDepth, centre.clone().addScaledVector(inward, -(face + STEP.highDepth + STEP.lowDepth / 2)).setY(floorOut + STEP.low / 2), true)
      this.drawFrame(barrier)
      this.nailPlanks(barrier)
    }
    world.addObject(this.colliders)
    // Zombies on the road come in through the windows only.
    for (const name of SEALED_WALLS) {
      const wall = scene.getObjectByName(name)
      if (!wall) continue
      const box = new THREE.Box3().setFromObject(wall), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3())
      const [a, b] = size.x > size.z ? [{ x: box.min.x, z: mid.z }, { x: box.max.x, z: mid.z }] : [{ x: mid.x, z: box.min.z }, { x: mid.x, z: box.max.z }]
      this.gaps.push(graph.closeGap(a, b))
    }
    // Where each window's zombies climb out of the ground and wait, where a body fits and walks straight to the step.
    for (const barrier of this.list) this.placeApproach(barrier)
    const count = this.list.length * WINDOW.boards
    const board = new THREE.BoxGeometry(1, PLANK.height, PLANK.thickness)
    const outline = new THREE.BoxGeometry(1 + 0.02, PLANK.height + 0.02, PLANK.thickness + 0.02)
    const paper = new THREE.MeshBasicMaterial({ color: palette.paper, toneMapped: false })
    const ink = new THREE.MeshBasicMaterial({ color: palette.ink, toneMapped: false })
    const rim = new THREE.MeshBasicMaterial({ color: palette.ink, side: THREE.BackSide, toneMapped: false })
    // Every plank is the same length here (all four windows are one size); a plank's length rides in its x scale otherwise.
    const length = (this.list[0]?.halfWidth ?? 0.85) * 2 + PLANK.overhang * 2
    board.scale(length, 1, 1); outline.scale((length + 0.02) / 1.02, 1, 1)
    this.paper = instanced(board, paper, count, 'Dead Ink barriers · planks')
    this.shell = instanced(outline, rim, count, 'Dead Ink barriers · plank outlines')
    const nail = new THREE.CylinderGeometry(0.017, 0.017, 0.01, 8).rotateX(Math.PI / 2)
    this.nails = instanced(nail, ink, count * 2, 'Dead Ink barriers · nail heads')
    for (const [i, side] of [-1, 1].entries()) this.nailOffsets[i].makeTranslation(side * (length / 2 - 0.1), 0, PLANK.thickness / 2 + 0.004)
    this.root.add(this.frames.finish(), this.paper, this.shell, this.nails)
    scene.add(this.root)
    this.writeMatrices()
  }

  /** Board counts for the co-op snapshot, in BARRIER_WINDOWS order. */
  counts() { return this.list.map(barrier => barrier.boards) }

  /**
   * On the co-op guest: the host's counts; planks fly off and back as they change, with their sounds. A window
   * whole again with two or more planks at a stroke (a new game on the host: players put back one plank a tick)
   * snaps back silently.
   */
  apply(counts: readonly number[]) {
    counts.forEach((count, i) => {
      const barrier = this.list[i]
      if (!barrier) return
      if (count === WINDOW.boards && count - barrier.boards > 1) {
        barrier.boards = count; barrier.torn = 0
        for (const plank of barrier.planks) { plank.position.copy(plank.nailed.position); plank.quaternion.copy(plank.nailed.quaternion); plank.motion = 'none' }
        this.dirty = true
        return
      }
      for (let n = 0; n < WINDOW.boards && barrier.boards > count; n++) barrier.tear()
      for (let n = 0; n < WINDOW.boards && barrier.boards < count; n++) if (!barrier.rebuild()) break
    })
  }

  /**
   * A plank back up at `barrier`, rebuilt by `player` in `round`. Returns the points it pays (a plank a
   * zombie ripped off pays WINDOW.points, times `multiplier` under Double Points, within the round's cap),
   * 0 when it pays nothing, -1 when nothing went up.
   */
  rebuild(barrier: Barrier, player: string, round: number, multiplier = 1) {
    const result = barrier.rebuild()
    if (!result) return -1
    return result === 'owed' ? this.ledger.take(player, round, WINDOW.points * multiplier) : 0
  }

  /**
   * Maybe send this spawn in from the road: WINDOW.spawnShare of the time while a window's inside is near a
   * player on foot (the flow field must be fresh) and it has room outside, preferring the least crowded.
   */
  pickSpawn(random: Random): { barrier: Barrier; rise: THREE.Vector3 } | null {
    if (!this.list.length || random() >= WINDOW.spawnShare) return null
    let total = 0
    this.list.forEach((barrier, i) => {
      const crowd = (barrier.occupant ? 1 : 0) + barrier.waiting.length
      const walk = this.graph.distance(barrier.landingNode)
      this.weights[i] = barrier.rises.length && crowd < WINDOW.crowd && walk <= WINDOW.activeRange ? 1 / (1 + crowd) : 0
      total += this.weights[i]
    })
    if (!total) return null
    let pick = random() * total
    for (const [i, barrier] of this.list.entries()) {
      if ((pick -= this.weights[i]) >= 0 || !this.weights[i]) continue
      return { barrier, rise: barrier.rises[Math.floor(random() * barrier.rises.length) % barrier.rises.length] }
    }
    return null
  }

  /** A new game: every window whole, nobody at them, nothing paid. */
  reset() {
    for (const barrier of this.list) {
      barrier.boards = WINDOW.boards; barrier.torn = 0; barrier.ripped = 0
      barrier.occupant = null; barrier.waiting.length = 0; barrier.vaulting = null
      for (const plank of barrier.planks) { plank.position.copy(plank.nailed.position); plank.quaternion.copy(plank.nailed.quaternion); plank.motion = 'none' }
    }
    this.ledger.reset()
    this.dirty = true
    this.writeMatrices()
  }

  /** Planks in flight. */
  update(dt: number) {
    if (!(dt > 0)) return
    const { q, v, probe } = this.scratch
    for (const barrier of this.list) for (const plank of barrier.planks) {
      if (plank.motion === 'off') {
        plank.velocity.y -= 9.8 * dt
        plank.position.addScaledVector(plank.velocity, dt)
        const angle = plank.spin.length() * dt
        if (angle > 0) plank.quaternion.premultiply(q.setFromAxisAngle(v.copy(plank.spin).normalize(), angle))
        if (plank.velocity.y < 0) {
          const floor = this.world.floor(probe.copy(plank.position).setY(plank.position.y + 0.3), 0, 0.35)
          const ground = Number.isFinite(floor) ? floor : plank.ground
          if (plank.position.y <= ground + 0.03 || plank.position.y < plank.ground - 1) {
            // Down: it lies flat where it fell.
            plank.position.y = (plank.position.y < plank.ground - 1 ? plank.ground : ground) + PLANK.thickness / 2 + 0.005
            const along = v.set(1, 0, 0).applyQuaternion(plank.quaternion).setY(0)
            const yaw = along.lengthSq() > 1e-6 ? Math.atan2(-along.z, along.x) : 0
            plank.quaternion.setFromEuler(this.scratch.lie.set(-Math.PI / 2, yaw, 0, 'YXZ'))
            plank.motion = 'none'
          }
        }
        this.dirty = true
      } else if (plank.motion === 'back') {
        plank.t = Math.min(1, plank.t + dt / 0.3)
        const s = 1 - (1 - plank.t) ** 3, w = 1 - s
        // A curve from where it lay, through `via`, onto its nails: in through the opening at its own row's height.
        plank.position.copy(plank.from.position).multiplyScalar(w * w).addScaledVector(plank.via, 2 * w * s).addScaledVector(plank.nailed.position, s * s)
        plank.quaternion.slerpQuaternions(plank.from.quaternion, plank.nailed.quaternion, s)
        if (plank.t >= 1) { plank.position.copy(plank.nailed.position); plank.quaternion.copy(plank.nailed.quaternion); plank.motion = 'none' }
        this.dirty = true
      }
    }
    this.writeMatrices()
  }

  /** Put the windows back as the mission has them, and take everything of ours away. */
  dispose() {
    for (const barrier of this.list) { barrier.window.visible = true; this.world.addObject(barrier.window) }
    this.world.removeObject(this.colliders)
    for (const gap of this.gaps) this.graph.openGap(gap)
    this.gaps = []
    this.root.removeFromParent()
    this.root.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() })
    for (const mesh of [this.paper, this.shell, this.nails]) (mesh.material as THREE.Material).dispose()
    this.colliders.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() })
  }

  // ---- inside: the planks' flights, called by Barrier

  flyOff(barrier: Barrier, plank: Plank) {
    const random = Math.random
    plank.motion = 'off'
    plank.position.copy(plank.nailed.position); plank.quaternion.copy(plank.nailed.quaternion)
    // Out through the hole past the zombie that pulled it, and down onto the road.
    plank.velocity.copy(barrier.inward).multiplyScalar(-(2.6 + random() * 1.2)).addScaledVector(barrier.tangent, (random() - 0.5) * 1.4)
    plank.velocity.y = 1.4 + random() * 0.9
    plank.spin.set(random() - 0.5, random() - 0.5, random() - 0.5).normalize().multiplyScalar(5 + random() * 5)
    plank.ground = barrier.floorOut
    this.emit({ kind: 'board-tear', position: plank.nailed.position.clone(), radius: 40 })
  }

  flyBack(barrier: Barrier, plank: Plank) {
    plank.motion = 'back'
    plank.t = 0
    plank.from.position.copy(plank.position); plank.from.quaternion.copy(plank.quaternion)
    plank.via.copy(plank.nailed.position).addScaledVector(barrier.inward, -1.3)
    this.emit({ kind: 'board-hammer', position: barrier.point.clone(), radius: 30 })
  }

  // ---- building

  /** The window's frame without its glass (the centre bar knocked out with it), and the two crates outside. */
  private drawFrame(barrier: Barrier) {
    const d = this.frames, { centre, inward, tangent, halfWidth, sill, top, floorOut, facing } = barrier
    const at = (along: number, y: number, into: number): Point => [centre.x + tangent.x * along + inward.x * into, y, centre.z + tangent.z * along + inward.z * into]
    const rotation: Point = [0, facing, 0]
    const box = (w: number, h: number, depth: number, p: Point, outline: 'edge' | 'detail' = 'detail') => d.box(w, h, depth, p[0], p[1], p[2], 'paper', outline, rotation)
    for (const side of [-1, 1]) box(0.07, top - sill, 0.16, at(side * (halfWidth - 0.035), (sill + top) / 2, 0))
    for (const y of [sill, top]) box(halfWidth * 2 + 0.12, 0.075, 0.3, at(0, y, 0))
    // What the glass left behind: a few jagged shards still in the corners.
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const x = u * (halfWidth - 0.07), y = v < 0 ? sill + 0.04 : top - 0.04
      d.line([at(x, y, 0), at(x - u * (0.12 + 0.05 * (barrier.index % 2)), y, 0), at(x - u * 0.03, y - v * (0.16 + 0.04 * ((barrier.index + 1) % 2)), 0)], 'detail', true)
    }
    const face = WALL_THICKNESS / 2
    for (const [width, height, depth, out] of [[STEP.highWidth, STEP.high, STEP.highDepth, face + STEP.highDepth / 2], [STEP.lowWidth, STEP.low, STEP.lowDepth, face + STEP.highDepth + STEP.lowDepth / 2]] as const) {
      box(width, height, depth, at(0, floorOut + height / 2, -out), 'edge')
      // Slats and a brace on the face toward the road, and on each end.
      const front = -(out + depth / 2 + 0.004), bottom = floorOut + 0.02
      for (const y of [bottom + height * 0.32, bottom + height * 0.68]) d.line([at(-width / 2, y, front), at(width / 2, y, front)], 'detail')
      d.line([at(-width / 2 + 0.04, bottom + 0.03, front), at(width / 2 - 0.04, bottom + height - 0.06, front)], 'detail')
      for (const side of [-1, 1]) d.line([at(side * (width / 2 + 0.004), bottom + 0.03, -out - depth / 2 + 0.04), at(side * (width / 2 + 0.004), bottom + height - 0.06, -out + depth / 2 - 0.04)], 'detail')
    }
  }

  /** Six planks nailed across the inside of the opening, each a little off true, as a hand in a hurry nails them. */
  private nailPlanks(barrier: Barrier) {
    const random = seeded(0xB0A2D + barrier.index * 7919)
    const { centre, inward, tangent, sill, top } = barrier
    const basis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3(0, 1, 0), inward))
    for (let k = 0; k < WINDOW.boards; k++) {
      const y = sill + 0.14 + k * (top - sill - 0.28) / (WINDOW.boards - 1) + (random() - 0.5) * 0.03
      const position = centre.clone().addScaledVector(inward, WALL_THICKNESS / 2 + PLANK.thickness / 2 + 0.002 + (k % 2) * 0.006)
        .addScaledVector(tangent, (random() - 0.5) * 0.08).setY(y)
      const quaternion = basis.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (random() - 0.5) * 0.14))
      barrier.planks.push({ nailed: { position, quaternion }, position: position.clone(), quaternion: quaternion.clone(), motion: 'none',
        velocity: new THREE.Vector3(), spin: new THREE.Vector3(), t: 0, from: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
        via: new THREE.Vector3(), ground: barrier.floorOut })
    }
  }

  /**
   * The road side of a window: spots on the ground where a body fits and has a clear straight walk to the
   * foot of the step, to climb out of the ground at (RISE) and to wait a turn at.
   */
  private placeApproach(barrier: Barrier) {
    const world = this.world, capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.3), probe = new THREE.Vector3()
    const ground = (x: number, z: number, near: number) => {
      const y = world.floor(probe.set(x, near + 1, z), 0, 2.5, 0.2)
      return Number.isFinite(y) && Math.abs(y - near) < 0.5 ? y : NaN
    }
    const fits = (x: number, y: number, z: number) => {
      capsule.start.set(x, y + 0.35, z); capsule.end.set(x, y + 1.74 - 0.3, z)
      return world.fits(capsule)
    }
    const walkable = (from: THREE.Vector3, to: THREE.Vector3) => {
      const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 0.4))
      for (let i = 0; i <= steps; i++) {
        const x = from.x + (to.x - from.x) * i / steps, z = from.z + (to.z - from.z) * i / steps
        const y = ground(x, z, from.y + (to.y - from.y) * i / steps)
        if (!Number.isFinite(y) || !fits(x, y, z)) return false
      }
      return true
    }
    const spot = (out: number, side: number) => {
      const p = barrier.centre.clone().addScaledVector(barrier.inward, -out).addScaledVector(barrier.tangent, side)
      const y = ground(p.x, p.z, barrier.floorOut)
      return Number.isFinite(y) && fits(p.x, y, p.z) ? p.setY(y) : null
    }
    const foot = barrier.foot
    for (const [out, side] of [[2.4, 1.2], [2.4, -1.2], [3.3, 0], [3.4, 1.8], [3.4, -1.8]] as const) {
      const p = spot(out, side)
      if (p && walkable(p, foot)) barrier.queue.push(p)
    }
    for (const out of RISE.out) for (const side of RISE.side) {
      const p = spot(out, side)
      if (p && walkable(p, foot)) barrier.rises.push(p)
    }
    if (!barrier.queue.length) barrier.queue.push(foot.clone())
    if (!barrier.rises.length) console.warn(`Dead Ink: nowhere outside "${barrier.name}" for zombies to come from`)
  }

  private writeMatrices() {
    if (!this.dirty) return
    this.dirty = false
    let i = 0
    for (const barrier of this.list) for (const plank of barrier.planks) {
      this.matrix.compose(plank.position, plank.quaternion, Barriers.unit)
      this.paper.setMatrixAt(i, this.matrix)
      this.shell.setMatrixAt(i, this.matrix)
      for (let n = 0; n < 2; n++) this.nails.setMatrixAt(i * 2 + n, this.nailMatrix.multiplyMatrices(this.matrix, this.nailOffsets[n]))
      i++
    }
    for (const mesh of [this.paper, this.shell, this.nails]) mesh.instanceMatrix.needsUpdate = true
  }
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, count: number, name: string) {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count))
  mesh.name = name
  mesh.count = count
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.userData.noCollision = true
  return mesh
}
