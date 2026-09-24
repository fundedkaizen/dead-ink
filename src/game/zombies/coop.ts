import { CoopLink as SharedCoopLink, type CoopStatus, type PlayerState } from '../shared/coop'
import type { WeaponName } from '../types'
import type { ZombieSnap } from './director'
import type { BlastKind } from './blasts'
import type { PowerupKind } from './rules'

/**
 * Dead Ink co-op: up to four players, each in their own browser, talking through the relay
 * (server/coop-relay.mjs). Players are numbered: the host 0, guests 1 to 3.
 *
 * The host's game is the world: it runs the zombies, the rounds, the doors, the box and the power-ups, and
 * sends a snapshot fifteen times a second with every player's state. A guest's game draws that world (its
 * zombies are puppets) and owns only its player: where it stands, its guns, points and perks. A guest's
 * shots go to the host, which works out the hits and sends the points back to that guest alone. Each
 * player owns their own health; a zombie's swipe at a guest is sent to that guest.
 *
 * The link, the players' colours, the teammate's stickman and name tag are shared with the hostage rescue's
 * co-op and live in ../shared/coop.ts; this file keeps Dead Ink's own messages and invite link.
 */
export { PLAYER_COLORS, PLAYER_CSS, PartnerAvatar, PartnerTag, toVector, vec } from '../shared/coop'
export type { CoopRole, CoopRoute, CoopStatus, PlayerState } from '../shared/coop'

/** The host's buildables, traps and quest, as the guest needs them (sent with every tick). */
export type WorldState = {
  /** Parts still lying about: id and where. */
  parts: [string, number, number, number][]
  /** Parts the team carries (shared, as in Black Ops 3). */
  carried: string[]
  /** Parts already fitted at each build site. */
  placed: Record<string, string[]>
  power: 'broken' | 'ready' | 'on'
  shieldOnBench: 0 | 1
  traps: ['idle' | 'active' | 'cooling', number][]
  quest: string
  /** Each inkwell: awake, souls, bottle taken. */
  wells: [0 | 1, number, 0 | 1][]
  bottles: number
  /** Boarded windows (windows.ts): planks up at each, and each player's rebuild points this round, by number (it has a cap). */
  win?: number[]
  wp?: number[]
}

export type CoopMessage =
  // host -> guest
  | { t: 'sync'; gates: string[]; power: boolean; box: number; seed: number; difficulty: string }
  // `bd`: the Brute's chunks in flight, [id, origin x y z, launch velocity x y z, age] (brute.ts).
  | { t: 'tick'; z: ZombieSnap[]; r: number; ph: 'break' | 'active'; players: PlayerState[]; storm: boolean; pw: 0 | 1; pk: 0 | 1; w?: WorldState; bd?: number[][] }
  | { t: 'shield' }
  | { t: 'award'; n: number; k?: number; h?: number }
  | { t: 'hit'; pt: [number, number, number]; dealt: number; id: string; head: 0 | 1; lethal: 0 | 1 }
  // `k`: a shove to add to their speed (the Brute's blows throw a player), m/s.
  | { t: 'hurt'; n: number; s?: [number, number, number]; k?: [number, number, number] }
  | { t: 'announce'; text: string; s: number; tone?: string }
  | { t: 'sting'; name: 'roundStart' | 'boxSpin' | 'song' }
  | { t: 'gate'; id: string }
  | { t: 'box'; a: 'spin' | 'take' | 'close' | 'move'; r?: { name: WeaponName; rarity: string; special?: 'rayGun' }; teddy?: boolean; by?: number; spot?: number }
  | { t: 'drop'; k: PowerupKind; p: [number, number, number] }
  | { t: 'grab'; k: PowerupKind; p: [number, number, number]; by: number }
  // `k`: how it looks and sounds (a rocket's, a Deadline round's); a frag's when missing.
  | { t: 'boom'; p: [number, number, number]; r: number; k?: BlastKind }
  | { t: 'soul'; p: [number, number, number]; i: number }
  /** A teammate fired: the tracer from `o` to `e`, the gun (`raygun` for the Ink Ray) and its Pack-a-Punch level, to see and hear. */
  | { t: 'fire'; o: [number, number, number]; e: [number, number, number]; w: string; pk?: number }
  | { t: 'gameover' }
  | { t: 'start' }
  // guest -> host
  | { t: 'me'; me: PlayerState }
  | { t: 'shot'; o: [number, number, number]; d: [number, number, number]; range: number; damage: number; weapon: WeaponName; scale: number; pierce: number; pellet?: number }
  | { t: 'knife'; o: [number, number, number]; f: [number, number, number]; range: number; damage: number }
  | { t: 'blast'; p: [number, number, number]; r: number; dmg: number; k?: BlastKind }
  | { t: 'use'; what: 'gate'; id: string }
  | { t: 'use'; what: 'box'; guns: WeaponName[] }
  | { t: 'use'; what: 'box-take' }
  | { t: 'use'; what: 'part'; id: string }
  | { t: 'use'; what: 'site'; build: string }
  | { t: 'use'; what: 'power' }
  | { t: 'use'; what: 'trap'; index: number }
  | { t: 'use'; what: 'bottle'; index: number }
  | { t: 'use'; what: 'pour' }
  | { t: 'use'; what: 'window'; index: number }
  | { t: 'lure'; p: [number, number, number]; s: number }
  // either way (a guest reviving another guest goes through the host: `target`)
  | { t: 'revive'; target?: number; by?: string }
  | { t: 'down'; dn: 0 | 1 | 2 }

/** A message as it arrives: the relay marks a guest's messages to the host with who sent them. */
export type CoopIncoming = CoopMessage & { from?: number }

/** The invite link for a room: this page, in Dead Ink, joining that room, with the host's world seed. */
export function inviteLink(code: string, seed: number) {
  const url = new URL(location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('mode', 'zombies')
  url.searchParams.set('join', code)
  url.searchParams.set('seed', String(seed))
  return url.toString()
}

/** Dead Ink's link to the relay: its invite joins Dead Ink, with the host's world seed. */
export class CoopLink extends SharedCoopLink<CoopMessage, CoopIncoming> {
  constructor(seed: number, onMessage: (message: CoopIncoming) => void, onStatus: (status: CoopStatus) => void,
    onPeer?: (id: number, joined: boolean) => void) {
    super(code => inviteLink(code, seed), onMessage, onStatus, onPeer)
  }
}
