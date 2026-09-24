import * as THREE from 'three'
import type { Enemy } from './ai'
import type { Posture } from '../lab/postures'
import type { MissionState } from './mission'
import type { PlayerState } from './shared/coop'
import type { HostageMotion } from './hostages'
import type { HitZone } from './hit-reactions'
import type { PlayerBulletHit, PlayerHitRegion } from './player-hit-reactions'
import type { EnemyState, Vec3, WeaponItem, WeaponName } from './types'

/**
 * The hostage rescue in co-op (rescue-coop.ts): the rules and the messages, kept apart from the game so they
 * can be checked in Node (scripts/rescue-coop-checks.ts).
 *
 * The host's game is the mission: the guards, the cameras and alarm, the doors, the hostage, the checkpoint
 * and the escape. Fifteen times a second it sends a tick: every guard as a row of numbers, the mission's world
 * state, which doors stand open, every player, and how the hostage moves. A guest draws that world (its guards
 * are puppets, guard-puppets.ts) and owns only its player: where it stands, its guns and its health. A
 * guest's shots and uses (panels, cells, doors) go to the host, which works them out; a guard's round that hits
 * a guest is sent to that guest.
 */

/** Revive reach and time, time on the floor, health once revived, send rate, and how near a guest must be to use a panel or count as at the jeep. */
export const RESCUE_COOP = { reviveReach: 2.2, reviveSeconds: 3, bleedSeconds: 45, reviveHealth: 50, sendRate: 15, useReach: 3.8, jeepReach: 8 } as const

type V = Vec3

/** The world part of the mission that guests mirror: everything but each player's own health, shots and kills. */
export type MissionMirror = Omit<MissionState, 'health' | 'shots' | 'kills'>

/** A guard's round that struck a player: where, and how it came in. */
export type HurtHit = { r: PlayerHitRegion; sd: -1 | 0 | 1; p: V; d: V; w?: WeaponName }

export type RescueMessage =
  // host -> guests
  | { t: 'sync'; m: MissionMirror; d: string; pickups: WeaponItem[]; begun: 0 | 1 }
  | { t: 'tick'; g: GuardRow[]; m: MissionMirror; d: string; players: PlayerState[]; h: HostageMotion[] }
  /** A guard struck: the reaction it played (`c`), lethal, the round's direction, its shotgun travel, zone, point, weapon, bone. */
  | { t: 'react'; g: number; c: string; l: 0 | 1; d: V; tr: number; z: HitZone; p: V; w?: WeaponName; b?: string }
  /** Your round struck a guard (the hit marker), and whether it killed him. */
  | { t: 'hit'; p: V; z: HitZone; l: 0 | 1 }
  /** A guard's round struck you: damage, where it came from, and where it hit. */
  | { t: 'hurt'; n: number; s?: V; h?: HurtHit }
  /** A sound from the host's world (a guard's callout, the alarm horn, a guard reloading, the bell), with its caption. */
  | { t: 'snd'; k: string; p?: V; r?: number; x?: string; v?: string; s?: number; w?: WeaponName }
  /** A line for the caption (what a panel did, who freed the hostage). */
  | { t: 'note'; x: string; s?: number }
  /** A gun lies on the floor (a guard's, as he falls), or was taken by someone. */
  | { t: 'drop'; item: WeaponItem }
  | { t: 'taken'; id: string }
  /** You used a field dressing (the host keeps which are used). */
  | { t: 'heal' }
  | { t: 'start' }
  | { t: 'escape' }
  | { t: 'fail' }
  | { t: 'reset'; kind: 'retry' | 'restart' }
  // either way
  /** A shot to see and hear: a player's (as Dead Ink's co-op), or a guard's (`g`, its number) with its muzzle flash. */
  | { t: 'fire'; o: V; e: V; w: string; g?: number }
  | { t: 'door'; i: number; o: 0 | 1 }
  | { t: 'revive'; target?: number; by?: string }
  | { t: 'down'; dn: 0 | 1 | 2 }
  // guest -> host
  | { t: 'me'; me: PlayerState }
  | { t: 'shot'; o: V; d: V; range: number; damage: number; weapon: WeaponName; pellet?: number }
  | { t: 'use'; id: string }
  /** A sound a guard might hear: footsteps, a ladder, a dropped gun. */
  | { t: 'noise'; k: string; p: V; r: number }
  | { t: 'take'; id: string }
  /** Try again, or start the mission over (after a failure, or once it is won). */
  | { t: 'again'; kind: 'retry' | 'restart' }

/** A message as it arrives: the relay marks a guest's messages to the host with who sent them. */
export type RescueIncoming = RescueMessage & { from?: number }

const round = (n: number) => Math.round(n * 100) / 100
const tuple = (v: THREE.Vector3): V => [round(v.x), round(v.y), round(v.z)]

/** The invite link for a room: this page, the hostage rescue, joining that room. */
export function rescueInviteLink(code: string) {
  const url = new URL(location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('join', code)
  return url.toString()
}

// ---------------------------------------------------------------- the mission

export function mirrorMission(state: MissionState): MissionMirror {
  const { health: _health, shots: _shots, kills: _kills, ...world } = state
  return { ...world, elapsed: round(world.elapsed), alarmElapsed: round(world.alarmElapsed), silencedElapsed: round(world.silencedElapsed),
    escapeProgress: round(world.escapeProgress),
    hostages: world.hostages.map(hostage => ({ ...hostage, position: hostage.position.map(round) as V })),
    supplies: [...world.supplies], alarmPosition: world.alarmPosition ? world.alarmPosition.map(round) as V : null }
}

/** A guest takes the host's world, keeping its own health, shots and kills. */
export function applyMirror(state: MissionState, mirror: MissionMirror) {
  const { health, shots, kills } = state
  Object.assign(state, structuredClone(mirror), { health, shots, kills })
}

/** Which doors stand open, one character each (`1` open), in the order the player's door list has them. */
export const doorBits = (doors: readonly THREE.Object3D[]) => doors.map(door => door.userData.open ? '1' : '0').join('')

// ---------------------------------------------------------------- the guards

export const GUARD_STATES: readonly EnemyState[] = ['idle', 'patrol', 'guard', 'suspicious', 'investigate', 'combat', 'search', 'dead', 'reserve']
export const POSTURES: readonly Posture[] = ['stand', 'crouch', 'kneel', 'prone']

/**
 * One guard, as a guest's puppet needs it: [number, state, x, y, z, heading, speed, posture, aiming (0 or 1),
 * aim x, y, z, scan (the look round after a near miss, 0 to 1, or -1)]. A reserve still in the barracks is only
 * [number, state]; a body [number, state, x, y, z, heading].
 */
export type GuardRow = number[]

export function guardRows(enemies: readonly Enemy[]): GuardRow[] {
  return enemies.map((enemy, index) => {
    const state = Math.max(0, GUARD_STATES.indexOf(enemy.state)), p = enemy.position
    if (enemy.state === 'reserve') return [index, state]
    if (enemy.state === 'dead') return [index, state, round(p.x), round(p.y), round(p.z), round(enemy.yaw)]
    const aim = enemy.canSee && enemy.lastKnown ? enemy.lastKnown : null
    const scan = enemy.actor.root.userData.alertScan
    return [index, state, round(p.x), round(p.y), round(p.z), round(enemy.yaw), round(enemy.moveSpeed), Math.max(0, POSTURES.indexOf(enemy.actor.posture ?? 'stand')),
      aim ? 1 : 0, aim ? round(aim.x) : 0, aim ? round(aim.y + 1.65) : 0, aim ? round(aim.z) : 0,
      typeof scan === 'number' && Number.isFinite(scan) ? round(scan) : -1]
  })
}

/** A guard's round that struck a player, for the message to them, and back. */
export function encodeHurt(hit: PlayerBulletHit): HurtHit {
  return { r: hit.region, sd: hit.side, p: tuple(hit.point), d: tuple(hit.direction), w: hit.weapon }
}
export function decodeHurt(hit: HurtHit): PlayerBulletHit {
  return { region: hit.r, side: hit.sd, point: new THREE.Vector3(...hit.p), direction: new THREE.Vector3(...hit.d), weapon: hit.w }
}

// ---------------------------------------------------------------- players

/** Everyone in the game is down or out: the rescue has failed for all. */
export function everyoneDown(downs: readonly number[]) {
  return downs.length > 0 && downs.every(down => down > 0)
}

/** A revive needs you up, and a teammate down (not bled out) within reach. */
export function canRevive(reviver: { dn: number; feet: THREE.Vector3 }, downed: { dn: number; feet: THREE.Vector3 }) {
  return reviver.dn === 0 && downed.dn === 1 && reviver.feet.distanceTo(downed.feet) < RESCUE_COOP.reviveReach
}

/**
 * Who the hostage follows: whoever freed him while they are up, and the nearest player who is up. He runs on
 * along the rescue route while either is ahead of him, so any player can lead him on.
 */
export function escortLeaders(hostage: readonly number[], by: number | undefined, players: readonly { id: number; feet: THREE.Vector3; up: boolean }[]) {
  const at = new THREE.Vector3(hostage[0], hostage[1], hostage[2])
  const up = players.filter(player => player.up)
  const leaders: THREE.Vector3[] = []
  const freer = up.find(player => player.id === by)
  if (freer) leaders.push(freer.feet)
  let nearest: THREE.Vector3 | null = null
  for (const player of up) if (!nearest || player.feet.distanceToSquared(at) < nearest.distanceToSquared(at)) nearest = player.feet
  if (nearest && nearest !== freer?.feet) leaders.push(nearest)
  return leaders
}

/** The jeep can go: every player still up is at it. */
export function escapeReady(players: readonly { feet: THREE.Vector3; up: boolean }[], jeep: THREE.Vector3) {
  return players.every(player => !player.up || Math.hypot(player.feet.x - jeep.x, player.feet.z - jeep.z) <= RESCUE_COOP.jeepReach)
}

/** Where a guest starts, beside the host at the insertion point (the host is 0). */
export const GUEST_OFFSETS: readonly V[] = [[0, 0, 0], [0, 0, 1.2], [0, 0, -1.2], [1.2, 0, 0]]

/** Your own last stand: up (0), down and bleeding out (1), or out of this attempt (2). */
export class LastStand {
  down: 0 | 1 | 2 = 0
  bleed = 0

  /** Knocked down; false if you already were. */
  fall() {
    if (this.down) return false
    this.down = 1
    this.bleed = RESCUE_COOP.bleedSeconds
    return true
  }

  /** Time on the floor; true the moment you bleed out. */
  step(dt: number) {
    if (this.down !== 1) return false
    this.bleed = Math.max(0, this.bleed - Math.max(0, dt))
    if (this.bleed > 0) return false
    this.down = 2
    return true
  }

  /** Picked up by a teammate: only while down, never once bled out. */
  revive() {
    if (this.down !== 1) return false
    this.down = 0
    this.bleed = 0
    return true
  }

  reset() { this.down = 0; this.bleed = 0 }
}

/** Reviving a teammate: F held the whole time; letting go, moving off or going down yourself stops it. */
export class ReviveHold {
  target = -1
  elapsed = 0

  get active() { return this.target >= 0 }
  get fraction() { return this.active ? Math.min(1, this.elapsed / RESCUE_COOP.reviveSeconds) : 0 }

  start(target: number) { this.target = target; this.elapsed = 0 }
  stop() { this.target = -1; this.elapsed = 0 }

  /** `holding`: still holding F, within reach, and up. */
  step(dt: number, holding: boolean): 'idle' | 'holding' | 'stopped' | 'done' {
    if (!this.active) return 'idle'
    if (!holding) { this.stop(); return 'stopped' }
    this.elapsed += Math.max(0, dt)
    if (this.elapsed < RESCUE_COOP.reviveSeconds) return 'holding'
    this.stop()
    return 'done'
  }
}
