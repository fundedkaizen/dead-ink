import * as THREE from 'three'
import { EnemyActor } from '../actors'
import { HOSTAGE_INK } from '../hostage-actor'
import { createMissionGun } from '../weapon-models'
import { disposeGun } from '../../lab/weapons/models'
import { PartnerPoses } from '../zombies/partner-poses'
import type { WeaponName } from '../types'
import './coop.css'

/**
 * Co-op for both modes (Dead Ink and the hostage rescue): up to four players, each in their own browser,
 * talking through the relay (server/coop-relay.mjs). Players are numbered: the host 0, guests 1 to 3.
 *
 * The host's game is the world and sends a snapshot fifteen times a second with every player's state. A
 * guest's game draws that world and owns only its player: where it stands, its guns and its health. Each mode
 * has its own messages (zombies/coop.ts, rescue-coop-rules.ts); the link, the players' colours, the teammate's
 * stickman and name tag, and the lobby on the menu are shared and live here.
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
  /** 0 up, 1 down (waiting for a revive), 2 bled out (Dead Ink: back next round; the rescue: out of this attempt). */
  dn: 0 | 1 | 2
  pts: number
  kills: number
  name: string
  /** Reviving a teammate: how far it has run, 0 to 1 (0 or missing when not reviving), and whom. */
  rv?: number
  rt?: number
  /** The rescue: this player has the menu open (the guards leave a paused player alone). */
  ps?: 0 | 1
  /** Dead Ink: off the ground (a jump), so the Brute's slam wave passes under them. */
  air?: 1
}

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

/** Your co-op name, remembered in this browser; both modes share it. */
const NAME_KEY = 'dead-ink-name'
export function savedName(fallback: string) {
  try { return (localStorage.getItem(NAME_KEY) ?? '').trim().slice(0, 16) || fallback } catch { return fallback }
}
export function saveName(name: string) {
  try { localStorage.setItem(NAME_KEY, name.trim().slice(0, 16)) } catch { /* private window */ }
}

/** Every message names its kind in `t`. */
export type CoopEnvelope = { t: string }

/**
 * The WebSocket to the relay, and the room it is in. `Out` is what this mode sends; `In` what arrives (a
 * guest's messages reach the host marked with `from`). `linkFor` makes the invite link for a room code.
 */
export class CoopLink<Out extends CoopEnvelope, In extends CoopEnvelope = Out & { from?: number }> {
  role: CoopRole | null = null
  /** This player's number: the host 0, guests 1 to 3. */
  id = 0
  code = ''
  link = ''
  /** Who else is connected: on the host its guests' numbers, on a guest 0 (the host) while it is there. */
  readonly peers = new Set<number>()
  private socket: WebSocket | null = null
  private closed = false

  constructor(private linkFor: (code: string) => string, private onMessage: (message: In) => void, private onStatus: (status: CoopStatus) => void,
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
        this.link = this.linkFor(this.code)
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
      } else this.onMessage(message as unknown as In)
    }
    socket.onclose = () => {
      if (this.closed) return
      for (const id of [...this.peers]) { this.peers.delete(id); this.onPeer(id, false) }
      this.onStatus({ kind: 'error', reason: 'The connection dropped.' })
    }
    socket.onerror = () => this.onStatus({ kind: 'error', reason: 'Could not reach the game server.' })
  }

  /** Send to the host (from a guest), or from the host to the guests `route` names (all of them by default). */
  send(message: Out, route?: CoopRoute) {
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

/** The last stand's bar under the crosshair: reviving, being revived, or bleeding out. */
export class StandBar {
  readonly element = document.createElement('div')
  private label = document.createElement('span')
  private fill = document.createElement('i')

  constructor(parent: HTMLElement) {
    this.element.className = 'coop-stand'
    this.element.setAttribute('role', 'status')
    const bar = document.createElement('div')
    bar.append(this.fill)
    this.element.append(this.label, bar)
    this.element.hidden = true
    parent.append(this.element)
  }

  /** `null` hides it. */
  show(label: string | null, fraction = 0, tone: 'revive' | 'bleed' = 'revive') {
    this.element.hidden = !label
    if (!label) return
    if (this.label.textContent !== label) this.label.textContent = label
    this.element.dataset.tone = tone
    this.fill.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction)).toFixed(3)})`
  }

  dispose() { this.element.remove() }
}

/** What the lobby shows: the link's state, your name, and who is here. */
export type LobbyView = {
  status: CoopStatus
  name: string
  role: CoopRole | null
  /** Guests connected (on the host), whether or not they have said their name yet. */
  peers: number
  players: { id: number; name: string; me: boolean }[]
}

/**
 * The co-op page on the menu: invite a friend, the link to send, the players in their colours with the host
 * first, and Start (the host) or Jump in (a guest). Both press the menu's own start button, which takes the mouse.
 */
export class CoopLobby {
  readonly panel = document.createElement('div')
  private key = ''

  constructor(slot: HTMLElement, private view: () => LobbyView, private actions: { invite: (join?: string) => void; cancel: () => void; rename: (name: string) => void }) {
    this.panel.className = 'coop-panel'
    slot.append(this.panel)
    this.render()
  }

  /** Draw it again for a new link state. */
  render() {
    const panel = this.panel, view = this.view(), s = view.status
    const escapeHtml = (text: string) => text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
    const name = `<label class="coop-name">Your name <input maxlength="16" value="${escapeHtml(view.name)}" aria-label="Your name"></label>`
    let body: string
    if (s.kind === 'idle') body = '<button type="button" class="coop-invite">Play with a friend</button><p>Send them a link: they play in their browser, nothing to install.</p>'
    else if (s.kind === 'connecting') body = '<p>Connecting…</p>'
    else if (s.kind === 'waiting') body = `<p><strong>Send this link to your friend:</strong></p><div class="coop-link"><input readonly value="${escapeHtml(s.link)}" aria-label="Invite link"><button type="button" class="coop-copy">Copy</button></div><p>Waiting for them to open it… <button type="button" class="coop-cancel">Cancel</button></p>`
    else if (s.kind === 'paired') body = s.role === 'host'
      ? `<div class="coop-link"><input readonly value="${escapeHtml(s.link)}" aria-label="Invite link"><button type="button" class="coop-copy">Copy</button></div><div class="coop-players"></div><p>Up to four players. Start when everyone is here.</p><button type="button" class="coop-start">Start</button>`
      : '<div class="coop-players"></div><p class="coop-wait">Waiting for the host to start.</p><button type="button" class="coop-start">Jump in</button>'
    else if (s.kind === 'alone') body = '<p>Joined. Waiting for your friend\'s game…</p>'
    else body = `<p class="coop-error">${escapeHtml(s.reason)}</p><button type="button" class="coop-invite">Try again</button>`
    panel.innerHTML = `<h3>Co-op</h3>${name}${body}`
    this.key = ''
    this.refresh()
    panel.querySelector<HTMLInputElement>('.coop-name input')?.addEventListener('change', event => this.actions.rename((event.target as HTMLInputElement).value))
    panel.querySelector('.coop-invite')?.addEventListener('click', () => {
      const join = new URLSearchParams(location.search).get('join')
      this.actions.invite(s.kind === 'error' && join ? join : undefined)
    })
    panel.querySelector('.coop-start')?.addEventListener('click', () => document.querySelector<HTMLElement>('#walk-start')?.click())
    panel.querySelector('.coop-cancel')?.addEventListener('click', () => this.actions.cancel())
    panel.querySelector('.coop-copy')?.addEventListener('click', event => {
      const input = panel.querySelector<HTMLInputElement>('.coop-link input')!
      void navigator.clipboard?.writeText(input.value).catch(() => { input.select(); document.execCommand('copy') })
      ;(event.target as HTMLButtonElement).textContent = 'Copied'
    })
  }

  /** The players list: who is here, in their colours, the host first. Cheap when nothing changed. */
  refresh() {
    const list = this.panel.querySelector<HTMLElement>('.coop-players')
    if (!list) return
    const view = this.view()
    const players = [...view.players].sort((a, b) => a.id - b.id)
    const key = players.map(player => `${player.id}:${player.name}`).join('|') + `|${view.peers}`
    if (key === this.key) return
    this.key = key
    const clean = (text: string) => text.replace(/[<>&"]/g, '')
    // Guests who joined but have not said their name yet still count.
    const waiting = view.role === 'host' ? Math.max(0, view.peers - (players.length - 1)) : 0
    list.innerHTML = `<strong>Players ${players.length + waiting} of 4</strong><ul>${players.map(player =>
      `<li style="--tag: ${PLAYER_CSS[player.id] ?? PLAYER_CSS[0]}">${clean(player.name)}${player.id === 0 ? ' (host)' : ''}${player.me ? ' · you' : ''}</li>`).join('')}${
      Array.from({ length: waiting }, () => '<li class="joining">Joining…</li>').join('')}</ul>`
  }

  /** A guest's lobby once the host has started: Jump in calls for the click the page needs. */
  started(on = true) { this.panel.classList.toggle('started', on) }

  dispose() { this.panel.remove() }
}
