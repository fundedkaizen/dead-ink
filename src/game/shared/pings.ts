import * as THREE from 'three'
import { synthOutput } from '../ui-slot-sound'
import './pings.css'

/**
 * Pings, for both game modes (Dead Ink and the hostage rescue), solo and co-op.
 *
 * Press the ping button (middle mouse, Z, the pad's D-pad right, or the small ping button on a phone) and
 * whatever you are looking at gets an ink marker in your colour: a zombie or guard (the marker follows it),
 * an item or station (a perk machine, the box, a door, a wall gun, a power-up), or a spot on the ground. It
 * shows through walls with how far away it is, lasts about five seconds, and lands with a soft ink tick.
 * Ping twice quickly and it becomes a danger ping: red, with an exclamation mark.
 *
 * The module owns the markers, the timing and the messages; the mode owns what a ping can point at
 * (`pick`), how to find a moving target again (`resolve`) and the link (`send`, `receive`).
 *
 * ```ts
 * const pings = createPings({
 *   camera, parent: hudRoot, me: () => link.id,
 *   pick: (origin, direction) => whatIsThere(origin, direction),   // a PingTarget, or null for nothing
 *   resolve: id => enemies.get(id)?.head ?? null,                   // keeps an enemy ping on the enemy
 *   send: message => link.send(message),                            // co-op; leave out when solo
 *   colorOf: player => PLAYER_CSS[player], nameOf: player => names[player],
 * })
 * const unbind = pings.bind(canvas, () => playing)                  // mouse, key and phone button
 * // every frame:           pings.update(dt)
 * // a PingMessage arrives: pings.receive(message)  (a host passes a guest's on to the other guests)
 * // new game / leaving:    pings.clear(); unbind(); pings.dispose()
 * ```
 *
 * With `parent: null` it draws nothing (checks, or a headless host): the pings still time out and send.
 */

export type PingKind = 'enemy' | 'item' | 'spot'
/** What a ping points at. `id` names a moving target (an enemy) that `resolve` can find again. */
export type PingTarget = { kind: PingKind; position: THREE.Vector3; label?: string; id?: string }
/**
 * A ping on the wire. `by`: the player's number; `n`: that player's ping count (a double ping resends the
 * same `n` with `d: 1`, turning the marker into a danger ping); `k`, `p`, `l`, `id`: the target.
 */
export type PingMessage = { t: 'ping'; by: number; n: number; k: PingKind; p: [number, number, number]; l?: string; id?: string; d?: 1 }

export type PingsOptions = {
  camera: THREE.Camera
  /** Where the markers go (the HUD root); null draws nothing. */
  parent?: HTMLElement | null
  /** This player's number: 0 solo or for the host, guests 1 to 3. */
  me: () => number
  /** A player's marker colour (CSS). */
  colorOf?: (player: number) => string
  /** A player's name, for the marker's line ("Ana: Zombie"). */
  nameOf?: (player: number) => string
  /** What the player is looking at from `origin` along `direction`; null when there is nothing to ping. */
  pick?: (origin: THREE.Vector3, direction: THREE.Vector3) => PingTarget | null
  /** Where a moving target is now (an enemy's head), or null once it is gone (the marker then stays put). */
  resolve?: (id: string) => THREE.Vector3 | null
  /** Send a ping to the other players (co-op). */
  send?: (message: PingMessage) => void
  /** Play the ink tick (default true; off in checks). */
  sound?: boolean
  /** Called when any ping lands (yours or a teammate's), e.g. to show it on a mini map. */
  onPing?: (ping: Ping) => void
  /** Real time in seconds, for the double ping (default performance.now); checks pass their own clock. */
  now?: () => number
}

export type Ping = {
  by: number; n: number; kind: PingKind; danger: boolean; label: string
  position: THREE.Vector3; id?: string
  /** Seconds since it landed, and how long it lasts. */
  age: number; life: number
  element: HTMLElement | null
}

export const PINGS = {
  /** Seconds a ping lasts; a danger ping a little longer. */
  life: 5, dangerLife: 6.5,
  /** A second press within this many seconds makes the last ping a danger ping. */
  doubleTap: 0.45,
  /** Pings a player can have up at once; the oldest goes. */
  perPlayer: 3,
  /** How far a ping reaches. */
  range: 120,
  danger: '#d4332a',
} as const

const LABELS: Record<PingKind, string> = { enemy: 'Enemy', item: 'Item', spot: 'Here' }
const ICONS: Record<PingKind | 'danger', string> = {
  // A skull for an enemy, a hand for an item, a dot for a spot, an exclamation mark for danger.
  enemy: '<path d="M12 6.2c-3 0-5 2-5 4.6 0 1.6.8 2.7 1.8 3.3v1.7h6.4v-1.7c1-.6 1.8-1.7 1.8-3.3 0-2.6-2-4.6-5-4.6z" fill="#fff"/><circle cx="10" cy="11" r="1.1"/><circle cx="14" cy="11" r="1.1"/>',
  item: '<path d="M12 6.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L12 14.6l-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z" fill="#fff"/>',
  spot: '<circle cx="12" cy="11" r="3" fill="#fff"/>',
  danger: '<path d="M11 6.5h2l-.4 6.2h-1.2z" fill="#fff"/><circle cx="12" cy="15" r="1.1" fill="#fff"/>',
}

const round2 = (n: number) => Math.round(n * 100) / 100
const escapeHtml = (text: string) => text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

/** A soft ink tick: a short damped knock with a drop of noise, quieter for a teammate's ping. */
function inkTick(danger: boolean, mine: boolean) {
  const output = synthOutput('effects', mine ? 0.5 : 0.38)
  if (!output) return
  const { context, out } = output, t = context.currentTime
  const knock = context.createOscillator(), gain = context.createGain()
  knock.type = 'sine'
  knock.frequency.setValueAtTime(danger ? 1250 : 880, t); knock.frequency.exponentialRampToValueAtTime(danger ? 620 : 420, t + 0.09)
  gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.5, t + 0.004); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  knock.connect(gain).connect(out)
  knock.start(t); knock.stop(t + 0.18)
  if (danger) {
    // Danger: the tick twice, the second a little higher.
    const again = context.createOscillator(), second = context.createGain()
    again.type = 'sine'
    again.frequency.setValueAtTime(1500, t + 0.11); again.frequency.exponentialRampToValueAtTime(760, t + 0.2)
    second.gain.setValueAtTime(0.0001, t + 0.11); second.gain.exponentialRampToValueAtTime(0.45, t + 0.115); second.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
    again.connect(second).connect(out)
    again.start(t + 0.11); again.stop(t + 0.3)
  }
  setTimeout(() => out.disconnect(), 500)
}

export class Pings {
  readonly active: Ping[] = []
  private serial = 0
  private lastLocal: { ping: Ping; at: number } | null = null
  private projected = new THREE.Vector3()
  private phoneButton: HTMLButtonElement | null = null

  constructor(private options: PingsOptions) {}

  private now() { return this.options.now?.() ?? performance.now() / 1000 }

  /**
   * Ping `target`, or whatever the player is looking at (through `pick`). A second ping soon after the last
   * turns that one into a danger ping instead of adding another. Returns the message sent, or null when
   * there was nothing to ping.
   */
  ping(target?: PingTarget | null): PingMessage | null {
    const me = this.options.me()
    const last = this.lastLocal
    if (last && this.now() - last.at <= PINGS.doubleTap && this.active.includes(last.ping) && !last.ping.danger) {
      this.makeDanger(last.ping)
      this.lastLocal = null
      const message = this.message(last.ping)
      this.options.send?.(message)
      return message
    }
    const aim = target ?? this.look()
    if (!aim) return null
    const ping = this.add({ by: me, n: ++this.serial, kind: aim.kind, label: aim.label ?? LABELS[aim.kind], position: aim.position.clone(), id: aim.id, danger: false })
    this.lastLocal = { ping, at: this.now() }
    const message = this.message(ping)
    this.options.send?.(message)
    return message
  }

  /**
   * Mark a spot for this player only, in the ping style (the game pointing somewhere: the workbench a part
   * belongs to). Not sent, not a double ping; it lasts `life` seconds.
   */
  show(target: PingTarget, life: number = PINGS.life) {
    for (const old of this.active.filter(p => p.n < 0 && p.label === (target.label ?? LABELS[target.kind]))) this.remove(old)
    const ping = this.add({ by: this.options.me(), n: -1, kind: target.kind, label: target.label ?? LABELS[target.kind], position: target.position.clone(), id: target.id, danger: false })
    ping.life = life
    return ping
  }

  /** A teammate's ping (or their double ping, which upgrades the one with the same number). */
  receive(message: PingMessage) {
    if (message?.t !== 'ping' || !Array.isArray(message.p) || message.p.length !== 3 || !message.p.every(Number.isFinite)) return
    if (message.by === this.options.me()) return
    const kind: PingKind = message.k === 'enemy' || message.k === 'item' ? message.k : 'spot'
    const existing = this.active.find(p => p.by === message.by && p.n === message.n)
    if (existing) { if (message.d && !existing.danger) this.makeDanger(existing); return }
    const ping = this.add({ by: message.by, n: message.n, kind, label: typeof message.l === 'string' ? message.l.slice(0, 32) : LABELS[kind],
      position: new THREE.Vector3(...message.p), id: typeof message.id === 'string' ? message.id : undefined, danger: !!message.d })
    if (ping.danger) this.makeDanger(ping)
  }

  /** Age the pings, follow moving targets, and place every marker on screen. */
  update(dt: number) {
    for (const ping of [...this.active]) {
      ping.age += Math.max(0, dt)
      if (ping.age >= ping.life) { this.remove(ping); continue }
      if (ping.id && this.options.resolve) {
        const at = this.options.resolve(ping.id)
        if (at) ping.position.copy(at); else ping.id = undefined
      }
      this.place(ping)
    }
  }

  /**
   * Listen for the ping inputs: middle mouse on `element`, the Z key, and (on a touch screen) a small ping
   * button in the corner. `enabled` says whether the game is being played right now. Returns an unbind.
   */
  bind(element: HTMLElement, enabled: () => boolean) {
    const abort = new AbortController(), options = { signal: abort.signal }
    element.addEventListener('mousedown', event => {
      if (event.button !== 1 || !enabled()) return
      event.preventDefault()
      this.ping()
    }, options)
    // Middle click would start the browser's autoscroll.
    element.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault() }, options)
    window.addEventListener('keydown', event => {
      if (event.code !== 'KeyZ' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || !enabled()) return
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]')) return
      event.preventDefault()
      this.ping()
    }, options)
    const parent = this.options.parent
    // A touch screen (a phone, a tablet): there is no middle button, so a small ping button in the corner.
    if (parent && typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ping-button'
      button.setAttribute('aria-label', 'Ping what you are looking at (tap twice for danger)')
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c3.9 0 7 3 7 6.8 0 4.6-5.4 9.6-7 11.2-1.6-1.6-7-6.6-7-11.2C5 6 8.1 3 12 3z" fill="currentColor"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>'
      button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); if (enabled()) this.ping() }, options)
      parent.append(button)
      this.phoneButton = button
    }
    return () => { abort.abort(); this.phoneButton?.remove(); this.phoneButton = null }
  }

  /** Take every ping down (a new game, leaving co-op). */
  clear() { for (const ping of [...this.active]) this.remove(ping); this.lastLocal = null }

  dispose() { this.clear(); this.phoneButton?.remove() }

  private look() {
    const camera = this.options.camera
    camera.updateMatrixWorld()
    const origin = camera.getWorldPosition(new THREE.Vector3()), direction = camera.getWorldDirection(new THREE.Vector3())
    return this.options.pick?.(origin, direction) ?? null
  }

  private message(ping: Ping): PingMessage {
    return { t: 'ping', by: ping.by, n: ping.n, k: ping.kind, p: [round2(ping.position.x), round2(ping.position.y), round2(ping.position.z)],
      ...(ping.label !== LABELS[ping.kind] ? { l: ping.label } : {}), ...(ping.id ? { id: ping.id } : {}), ...(ping.danger ? { d: 1 as const } : {}) }
  }

  private add(fields: Omit<Ping, 'age' | 'life' | 'element'>) {
    const mine = fields.by === this.options.me()
    // A player's oldest pings make way.
    const theirs = this.active.filter(p => p.by === fields.by)
    for (const old of theirs.slice(0, Math.max(0, theirs.length - PINGS.perPlayer + 1))) this.remove(old)
    const ping: Ping = { ...fields, age: 0, life: fields.danger ? PINGS.dangerLife : PINGS.life, element: null }
    const parent = this.options.parent
    if (parent) {
      const element = document.createElement('div')
      element.className = `ping ping-${ping.kind}${mine ? ' mine' : ''}`
      element.style.setProperty('--ping', this.options.colorOf?.(ping.by) ?? '#2878d0')
      element.setAttribute('role', 'status')
      parent.append(element)
      ping.element = element
      this.draw(ping)
    }
    this.active.push(ping)
    if (this.options.sound !== false) inkTick(ping.danger, mine)
    this.options.onPing?.(ping)
    return ping
  }

  private makeDanger(ping: Ping) {
    ping.danger = true
    ping.age = 0
    ping.life = PINGS.dangerLife
    if (ping.element) { ping.element.classList.add('danger'); this.draw(ping) }
    if (this.options.sound !== false) inkTick(true, ping.by === this.options.me())
  }

  /** The teammate's name on a marker ("Ana: "), empty for your own. */
  private who(ping: Ping) { return this.options.nameOf && ping.by !== this.options.me() && ping.n >= 0 ? `${this.options.nameOf(ping.by)}: ` : '' }

  private draw(ping: Ping) {
    const element = ping.element
    if (!element) return
    const who = this.who(ping)
    element.dataset.who = who
    const label = ping.danger ? `Danger${ping.kind === 'spot' ? '' : `: ${ping.label}`}` : ping.label
    element.innerHTML = `<svg class="ping-drop" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 29c-1.4-2.3-9.5-10-9.5-17A9.5 9.5 0 0 1 12 2.5 9.5 9.5 0 0 1 21.5 12c0 7-8.1 14.7-9.5 17z" fill="var(--ping-fill)" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/>${ICONS[ping.danger ? 'danger' : ping.kind]}</svg>
      <span class="ping-text"><b>${escapeHtml(who + label)}</b><small class="ping-distance"></small></span><i class="ping-arrow" aria-hidden="true"></i>`
  }

  /** On screen over the target, or pinned to the edge (with an arrow) when it is behind or off to a side. */
  private place(ping: Ping) {
    const element = ping.element
    if (!element) return
    const camera = this.options.camera
    const eye = camera.getWorldPosition(new THREE.Vector3())
    const distance = eye.distanceTo(ping.position)
    // A teammate's name can arrive after their first ping: draw it again once it does.
    if (element.dataset.who !== this.who(ping)) this.draw(ping)
    const text = `${Math.round(distance)} m`
    const small = element.querySelector<HTMLElement>('.ping-distance')
    if (small && small.textContent !== text) small.textContent = text
    const p = this.projected.copy(ping.position).project(camera)
    const behind = p.z > 1
    let x = p.x, y = p.y
    if (behind) { x = -x; y = -y }
    const edge = behind || Math.abs(x) > 0.9 || Math.abs(y) > 0.86
    if (edge) { const scale = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.86, 1e-3); x *= scale; y *= scale }
    const w = window.innerWidth, h = window.innerHeight
    element.style.transform = `translate(${((x + 1) / 2 * w).toFixed(1)}px, ${((1 - y) / 2 * h).toFixed(1)}px)`
    element.classList.toggle('edge', edge)
    const arrow = element.querySelector<HTMLElement>('.ping-arrow')
    if (arrow) arrow.style.transform = edge ? `rotate(${Math.atan2(-y, x).toFixed(3)}rad)` : ''
    // Fade in its last second.
    element.style.opacity = String(Math.min(1, (ping.life - ping.age) / 1))
  }

  private remove(ping: Ping) {
    ping.element?.remove()
    const index = this.active.indexOf(ping)
    if (index >= 0) this.active.splice(index, 1)
  }
}

/** Make the pings for a mode. See the module comment for the whole API. */
export function createPings(options: PingsOptions) { return new Pings(options) }
