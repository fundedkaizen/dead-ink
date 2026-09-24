import * as THREE from 'three'
import { EnemyActor } from '../actors'
import { HOSTAGE_INK } from '../hostage-actor'
import { createMissionGun } from '../weapon-models'
import { disposeGun } from '../../lab/weapons/models'
import { PartnerPoses } from './partner-poses'
import type { WeaponName } from '../types'
import type { ZombieSnap } from './director'
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
 */
export type CoopRole = 'host' | 'guest'

/** Each player's colour, by number: the host blue (like the hostage), then green, orange and violet. */
export const PLAYER_COLORS: readonly number[] = [HOSTAGE_INK, 0x2e9b45, 0xe08a1e, 0x9b4fd6]
export const PLAYER_CSS: readonly string[] = PLAYER_COLORS.map(color => `#${color.toString(16).padStart(6, '0')}`)

/** One player as the others see them. */
export type PlayerState = {
  /** The player's number: the host 0, guests 1 to 3. */
  id: number
  p: [number, number, number]
  yaw: number
  pitch: number
  w: WeaponName | null
  mv: 0 | 1
  /** 0 up, 1 down (waiting for a revive), 2 bled out (back next round). */
  dn: 0 | 1 | 2
  pts: number
  kills: number
  name: string
  /** Reviving a teammate: how far it has run, 0 to 1 (0 or missing when not reviving), and whom. */
  rv?: number
  rt?: number
}

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
  | { t: 'tick'; z: ZombieSnap[]; r: number; ph: 'break' | 'active'; players: PlayerState[]; storm: boolean; pw: 0 | 1; pk: 0 | 1; w?: WorldState }
  | { t: 'shield' }
  | { t: 'award'; n: number; k?: number; h?: number }
  | { t: 'hit'; pt: [number, number, number]; dealt: number; id: string; head: 0 | 1; lethal: 0 | 1 }
  | { t: 'hurt'; n: number; s?: [number, number, number] }
  | { t: 'announce'; text: string; s: number; tone?: string }
  | { t: 'sting'; name: 'roundStart' | 'boxSpin' | 'song' }
  | { t: 'gate'; id: string }
  | { t: 'box'; a: 'spin' | 'take' | 'close' | 'move'; r?: { name: WeaponName; rarity: string; special?: 'rayGun' }; teddy?: boolean; by?: number; spot?: number }
  | { t: 'drop'; k: PowerupKind; p: [number, number, number] }
  | { t: 'grab'; k: PowerupKind; p: [number, number, number]; by: number }
  | { t: 'boom'; p: [number, number, number]; r: number }
  | { t: 'soul'; p: [number, number, number]; i: number }
  /** A teammate fired: the tracer from `o` to `e`, the gun (`raygun` for the Ink Ray) and its Pack-a-Punch level, to see and hear. */
  | { t: 'fire'; o: [number, number, number]; e: [number, number, number]; w: string; pk?: number }
  | { t: 'gameover' }
  | { t: 'start' }
  // guest -> host
  | { t: 'me'; me: PlayerState }
  | { t: 'shot'; o: [number, number, number]; d: [number, number, number]; range: number; damage: number; weapon: WeaponName; scale: number; pierce: number; pellet?: number }
  | { t: 'knife'; o: [number, number, number]; f: [number, number, number]; range: number; damage: number }
  | { t: 'blast'; p: [number, number, number]; r: number; dmg: number }
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
/** Where a host's message goes: one guest (`to`), every guest but one (`skip`), or every guest (neither). */
export type CoopRoute = { to?: number; skip?: number }

export type CoopStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'waiting'; code: string; link: string }
  | { kind: 'paired'; code: string; link: string; role: CoopRole }
  | { kind: 'alone'; code: string; link: string; role: CoopRole }
  | { kind: 'error'; reason: string }

export const vec = (v: THREE.Vector3): [number, number, number] => [round(v.x), round(v.y), round(v.z)]
export const toVector = (a: readonly number[], out = new THREE.Vector3()) => out.set(a[0], a[1], a[2])
const round = (n: number) => Math.round(n * 100) / 100

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

/** The WebSocket to the relay, and the room it is in. */
export class CoopLink {
  role: CoopRole | null = null
  /** This player's number: the host 0, guests 1 to 3. */
  id = 0
  code = ''
  link = ''
  /** Who else is connected: on the host its guests' numbers, on a guest 0 (the host) while it is there. */
  readonly peers = new Set<number>()
  private socket: WebSocket | null = null
  private closed = false

  constructor(private seed: number, private onMessage: (message: CoopIncoming) => void, private onStatus: (status: CoopStatus) => void,
    private onPeer: (id: number, joined: boolean) => void = () => {}) {}

  /** Anyone else here. */
  get paired() { return this.peers.size > 0 }

  get active() { return !!this.socket && !this.closed }

  /** Open a room as the host, or join `code` as the guest. */
  open(code?: string) {
    this.close()
    this.closed = false
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/coop${code ? `?room=${encodeURIComponent(code)}` : ''}`)
    this.socket = socket
    this.onStatus({ kind: 'connecting' })
    // No answer in a few seconds: say so instead of "Connecting..." forever.
    const timeout = setTimeout(() => {
      if (this.socket !== socket || this.role) return
      this.close()
      this.onStatus({ kind: 'error', reason: 'Could not reach the co-op server. The game server may need a restart.' })
    }, 6000)
    socket.onmessage = event => {
      let message: { t: string; [key: string]: unknown }
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.t === 'room') {
        clearTimeout(timeout)
        this.role = message.you as CoopRole
        this.id = Number(message.id ?? 0)
        this.code = String(message.code)
        this.link = inviteLink(this.code, this.seed)
        this.onStatus(this.role === 'host' ? { kind: 'waiting', code: this.code, link: this.link } : { kind: 'alone', code: this.code, link: this.link, role: 'guest' })
      } else if (message.t === 'peer') {
        const id = Number(message.id ?? 0)
        if (message.joined) this.peers.add(id); else this.peers.delete(id)
        this.onPeer(id, !!message.joined)
        this.onStatus(this.paired ? { kind: 'paired', code: this.code, link: this.link, role: this.role! }
          : message.hostLeft ? { kind: 'error', reason: 'Your friend closed the game.' }
          : this.role === 'host' ? { kind: 'waiting', code: this.code, link: this.link } : { kind: 'alone', code: this.code, link: this.link, role: 'guest' })
      } else if (message.t === 'error') {
        this.onStatus({ kind: 'error', reason: String(message.reason) })
      } else this.onMessage(message as CoopIncoming)
    }
    socket.onclose = () => {
      if (this.closed) return
      for (const id of [...this.peers]) { this.peers.delete(id); this.onPeer(id, false) }
      this.onStatus({ kind: 'error', reason: 'The connection dropped.' })
    }
    socket.onerror = () => this.onStatus({ kind: 'error', reason: 'Could not reach the game server.' })
  }

  /** Send to the host (from a guest), or from the host to the guests `route` names (all of them by default). */
  send(message: CoopMessage, route?: CoopRoute) {
    if (this.socket?.readyState === WebSocket.OPEN && this.paired) this.socket.send(JSON.stringify(route ? { ...message, ...route } : message))
  }

  close() {
    this.closed = true
    for (const id of [...this.peers]) { this.peers.delete(id); this.onPeer(id, false) }
    this.role = null
    this.id = 0
    this.socket?.close()
    this.socket = null
  }
}

/**
 * The other player in your world: a stickman with their gun, easing to where they are, facing where they
 * look, walking when they walk, on the floor when they are down.
 */
export class PartnerAvatar {
  actor: EnemyActor | null = null
  readonly feet = new THREE.Vector3()
  state: PlayerState | null = null
  private goal = new THREE.Vector3()
  private yaw = 0
  private weapon: WeaponName | null = null
  private gun: ReturnType<typeof createMissionGun> | null = null
  private loading: Promise<void> | null = null
  /** Going down, last stand, crawling, getting up, reviving, bled out (partner-poses.ts). */
  readonly poses = new PartnerPoses()

  constructor(private scene: THREE.Scene, private color: number = HOSTAGE_INK) {}

  load() {
    this.loading ??= EnemyActor.create('pistol').then(actor => {
      this.actor = actor
      actor.root.name = 'Co-op partner'
      // In their player colour (the host blue like the hostage), so a teammate stands out from every
      // black zombie at a glance.
      const body = actor.rig.mesh.material as THREE.MeshBasicMaterial
      body.color.setHex(this.color)
      actor.root.visible = false
      actor.gun.visible = false
      this.scene.add(actor.root)
    })
    return this.loading
  }

  /** The head, for the name tag. */
  head(out = new THREE.Vector3()) { return out.copy(this.feet).setY(this.feet.y + (this.state?.dn ? 0.95 : 1.95)) }

  update(dt: number, state: PlayerState | null) {
    const actor = this.actor
    this.state = state
    if (!actor) return
    actor.root.visible = !!state
    if (!state) return
    toVector(state.p, this.goal)
    if (this.feet.distanceToSquared(this.goal) > 16 || this.feet.lengthSq() === 0) this.feet.copy(this.goal)
    else this.feet.lerp(this.goal, 1 - Math.exp(-dt * 14))
    // The camera looks down -Z at yaw 0; the stickman faces +Z at rotation 0.
    const face = state.yaw + Math.PI
    this.yaw += Math.atan2(Math.sin(face - this.yaw), Math.cos(face - this.yaw)) * (1 - Math.exp(-dt * 14))
    if (state.w !== this.weapon) this.swapGun(state.w)
    actor.root.position.copy(this.feet)
    // Down, getting up, reviving or bled out: partner-poses.ts owns the stickman until they stand again.
    if (this.poses.update(dt, actor, state, this.yaw, this.gun)) return
    actor.root.rotation.set(0, this.yaw, 0, 'YXZ')
    const aim = this.feet.clone().add(new THREE.Vector3(-Math.sin(state.yaw) * Math.cos(state.pitch), 1.5 + Math.sin(state.pitch), -Math.cos(state.yaw) * Math.cos(state.pitch)).multiplyScalar(1).setLength(10)).setY(this.feet.y + 1.5 + Math.sin(state.pitch) * 10)
    actor.update(dt, state.mv ? 'patrol' : 'combat', !!state.mv, state.mv ? undefined : aim, state.mv ? 3.2 : 0)
  }

  /** Put their gun in the stickman's hand, where the guard's gun sits. */
  private swapGun(name: WeaponName | null) {
    const actor = this.actor!
    this.weapon = name
    if (this.gun) { this.gun.removeFromParent(); disposeGun(this.gun); this.gun = null }
    if (!name) return
    this.gun = createMissionGun(name)
    this.gun.position.copy(actor.gun.position)
    this.gun.quaternion.copy(actor.gun.quaternion)
    actor.gun.parent?.add(this.gun)
  }

  dispose() {
    this.poses.dispose()
    if (this.gun) disposeGun(this.gun)
    this.actor?.root.removeFromParent()
    this.actor?.dispose()
    this.actor = null
  }
}

/**
 * The partner's name over their head, as Call of Duty shows it: through walls, always, and at the edge of
 * the screen with an arrow when they are behind you or off to one side. Ink on paper, no colour.
 */
export class PartnerTag {
  readonly element = document.createElement('div')
  private label = document.createElement('span')
  private arrow = document.createElement('i')
  private projected = new THREE.Vector3()

  constructor(parent: HTMLElement, name: string, color = PLAYER_CSS[0]) {
    this.element.className = 'coop-tag'
    this.element.style.setProperty('--tag', color)
    this.element.hidden = true
    this.label.textContent = name
    this.arrow.setAttribute('aria-hidden', 'true')
    this.element.append(this.label, this.arrow)
    parent.append(this.element)
  }

  private base = 'Partner'

  name(name: string) { this.base = name || 'Partner' }

  update(camera: THREE.PerspectiveCamera, head: THREE.Vector3 | null, down: boolean) {
    this.element.hidden = !head
    if (!head) return
    const text = this.base + (down ? ' · DOWN' : '')
    if (this.label.textContent !== text) this.label.textContent = text
    this.element.classList.toggle('down', down)
    const p = this.projected.copy(head).project(camera)
    const behind = p.z > 1
    let x = p.x, y = p.y
    if (behind) { x = -x; y = -y }
    const edge = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.88
    if (edge) {
      // Pinned to the screen's edge in their direction, with the arrow pointing at them.
      const scale = 1 / Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.88, 1e-3)
      x *= scale; y *= scale
    }
    const w = window.innerWidth, h = window.innerHeight
    this.element.style.transform = `translate(${((x + 1) / 2 * w).toFixed(1)}px, ${((1 - y) / 2 * h).toFixed(1)}px)`
    this.element.classList.toggle('edge', edge)
    this.arrow.style.transform = edge ? `rotate(${Math.atan2(-y, x).toFixed(3)}rad)` : ''
  }

  dispose() { this.element.remove() }
}
