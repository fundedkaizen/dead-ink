/**
 * Xbox and PlayStation controllers through the browser Gamepad API ("standard" mapping), laid out as Call of
 * Duty's default:
 *
 *   Left stick   move (analog: a light push walks slower)      L3 (click)   sprint (stays on while moving)
 *   Right stick  look (deadzone, curved response, no aim assist) R3 (click)   knife
 *   RT / R2      fire                                          LT / L2      aim (held)
 *   X / Square   tap: reload · hold at a prompt: use / buy     A / Cross    jump
 *   Y / Triangle switch weapon                                 RB / R1      knife
 *   LB / L1      grenade                                       B / Circle   Ink Doll (Dead Ink) · drop weapon (hostage)
 *   D-pad up/dn  scope zoom                                    View / Share mission map (hostage)
 *   Start / Options  pause; in the menus the D-pad or left stick moves, A picks, B goes back, Start resumes.
 *
 * This file only reads the pad and decides what was asked for; `PadBindings` carries it out (main.ts sends
 * the same key and mouse events the keyboard and mouse do, so both game modes work unchanged).
 */
export const PAD = {
  /** Radial deadzones for the sticks, and the trigger travel that counts as pulled. */
  moveDeadzone: 0.16, lookDeadzone: 0.13, trigger: 0.3,
  /** Look response: stick deflection (past the deadzone) raised to this power; 1 is linear. */
  curve: 2,
  /** Radians per second at full deflection and sensitivity 1. */
  yawSpeed: 3.3, pitchSpeed: 2.2,
  /** Hold X/Square this long at a prompt to use it; a shorter tap reloads. */
  holdToUse: 0.25,
  /** A stick pushed this far counts as a menu step; held, it repeats after `repeatDelay` then every `repeatEvery`. */
  menuStep: 0.6, repeatDelay: 0.4, repeatEvery: 0.14,
} as const

/** Standard-mapping button indices. */
export const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const

export type PadAction = 'fire' | 'aim' | 'reload' | 'use' | 'jump' | 'knife' | 'grenade' | 'special' | 'switch' | 'sprint' | 'zoomIn' | 'zoomOut' | 'map' | 'pause'
export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'start'

/** The part of the Gamepad API this reads; checks pass plain objects. */
export type PadLike = { connected: boolean; mapping: string; axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] }

export type PadBindings = {
  /** The player is in the game (not in a menu). */
  playing: () => boolean
  /** Left stick, -1 to 1 each way (y is forward), already past its deadzone. Called every poll while playing. */
  move: (x: number, forward: number) => void
  /** Turn the view by these radians (yaw right, pitch up). */
  look: (yaw: number, pitch: number) => void
  /** The weapon's look multiplier (a scope's slowdown, aiming down sights), over the mouse sensitivity. */
  lookScale: () => number
  /** The player's controller sensitivity and invert-Y setting. */
  settings: () => { sensitivity: number; invertY: boolean }
  /** An action pressed (true) or released (false). Fire and aim are held; the others are presses. */
  action: (action: PadAction, down: boolean) => void
  /** An interaction prompt is showing, so X/Square waits to see if it is a hold (use) or a tap (reload). */
  hasTarget: () => boolean
  /** Whether X/Square is held right now (a revive runs only while it is). */
  useHeld?: (held: boolean) => void
  menu: (action: MenuAction) => void
}

const radial = (x: number, y: number, deadzone: number) => {
  const length = Math.hypot(x, y)
  if (length <= deadzone) return [0, 0, 0] as const
  const scaled = Math.min(1, (length - deadzone) / (1 - deadzone))
  return [x / length * scaled, y / length * scaled, scaled] as const
}

/** The sticks as the game uses them: move past a radial deadzone, look past its own with a response curve. */
export function readSticks(pad: PadLike) {
  const [mx, my] = radial(pad.axes[0] ?? 0, pad.axes[1] ?? 0, PAD.moveDeadzone)
  const [lx, ly, amount] = radial(pad.axes[2] ?? 0, pad.axes[3] ?? 0, PAD.lookDeadzone)
  const curved = amount > 0 ? amount ** PAD.curve / amount : 0
  // Stick y is +1 pulled back; the game's forward and look-up are the other way.
  return { moveX: mx, moveForward: -my || 0, lookX: lx * curved, lookY: -ly * curved || 0 }
}

const pressedOf = (pad: PadLike, index: number) => {
  const button = pad.buttons[index]
  if (!button) return false
  return index === BUTTON.LT || index === BUTTON.RT ? button.value > PAD.trigger || (button.value === 0 && button.pressed) : button.pressed
}

export class GamepadInput {
  /** The pad in use, when one is. */
  pad: PadLike | null = null
  /** Something on a pad was touched since the last mouse or keyboard input. */
  active = false
  private held = new Set<number>()
  private useTimer = -1
  private sprintLatched = false
  private sprintSent = false
  private menuHeld: MenuAction | null = null
  private menuRepeat = 0
  private wasPlaying = false
  private frame = 0
  private last = 0
  private abort = new AbortController()

  constructor(private bindings: PadBindings, private source: () => readonly (PadLike | null)[] = () => navigator.getGamepads?.() ?? []) {}

  /** Poll every animation frame while a pad is connected (browsers only report pads after a button press). */
  start() {
    if (typeof window === 'undefined') return
    const options = { signal: this.abort.signal }
    const loop = (now: number) => {
      this.frame = 0
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60
      this.last = now
      if (this.poll(dt)) this.frame = requestAnimationFrame(loop)
      else this.last = 0
    }
    const wake = () => { if (!this.frame) this.frame = requestAnimationFrame(loop) }
    window.addEventListener('gamepadconnected', wake, options)
    // A mouse or keyboard hands control back: the pointer lock path again, no stale stick state.
    for (const type of ['mousedown', 'keydown'] as const) window.addEventListener(type, event => { if (event.isTrusted) this.active = false }, { ...options, capture: true })
    wake()
  }

  stop() { this.abort.abort(); cancelAnimationFrame(this.frame); this.frame = 0; this.release() }

  /** Read the pad once. Returns false when no pad is connected (the loop then sleeps until one is). */
  poll(dt: number) {
    const pad = [...this.source()].find(p => p && p.connected && p.mapping === 'standard') ?? [...this.source()].find(p => p && p.connected) ?? null
    if (!pad) { if (this.pad) this.release(); this.pad = null; return false }
    this.pad = pad
    const now = new Set<number>()
    for (let i = 0; i < pad.buttons.length; i++) if (pressedOf(pad, i)) now.add(i)
    const down = (i: number) => now.has(i) && !this.held.has(i), up = (i: number) => !now.has(i) && this.held.has(i)
    const sticks = readSticks(pad)
    if (now.size || sticks.moveX || sticks.moveForward || sticks.lookX || sticks.lookY) this.active = true
    const b = this.bindings, act = b.action, playing = b.playing()
    if (this.wasPlaying && !playing) this.release()
    this.wasPlaying = playing
    if (playing) {
      this.menuHeld = null
      b.move(sticks.moveX, sticks.moveForward)
      if (sticks.lookX || sticks.lookY) {
        const { sensitivity, invertY } = b.settings(), scale = sensitivity * b.lookScale() * dt
        b.look(sticks.lookX * PAD.yawSpeed * scale, sticks.lookY * PAD.pitchSpeed * scale * (invertY ? -1 : 1))
      }
      // Held actions follow the button; the rest fire on the press.
      if (down(BUTTON.RT)) act('fire', true)
      if (up(BUTTON.RT)) act('fire', false)
      if (down(BUTTON.LT)) act('aim', true)
      if (up(BUTTON.LT)) act('aim', false)
      if (down(BUTTON.A)) act('jump', true)
      if (down(BUTTON.Y)) act('switch', true)
      if (down(BUTTON.RB) || down(BUTTON.R3)) act('knife', true)
      if (down(BUTTON.LB)) act('grenade', true)
      if (down(BUTTON.B)) act('special', true)
      if (down(BUTTON.UP)) act('zoomIn', true)
      if (down(BUTTON.DOWN)) act('zoomOut', true)
      if (down(BUTTON.VIEW)) act('map', true)
      // Sprint, as Call of Duty: click the stick and it stays on until you stop moving.
      if (down(BUTTON.L3)) this.sprintLatched = !this.sprintLatched
      if (Math.hypot(sticks.moveX, sticks.moveForward) < 0.3) this.sprintLatched = false
      if (this.sprintLatched !== this.sprintSent) act('sprint', this.sprintSent = this.sprintLatched)
      // X / Square: a tap reloads; held at a prompt, it uses it.
      if (down(BUTTON.X)) {
        if (b.hasTarget()) this.useTimer = 0
        else act('reload', true)
      }
      if (this.useTimer >= 0) {
        if (!now.has(BUTTON.X)) { act('reload', true); this.useTimer = -1 }
        else if ((this.useTimer += dt) >= PAD.holdToUse) { act('use', true); this.useTimer = -1 }
      }
      if (down(BUTTON.START)) act('pause', true)
    } else {
      // Menus: a step on press, repeating while the stick or D-pad is held.
      const dir: MenuAction | null = now.has(BUTTON.UP) || sticks.moveForward > PAD.menuStep ? 'up'
        : now.has(BUTTON.DOWN) || sticks.moveForward < -PAD.menuStep ? 'down'
          : now.has(BUTTON.LEFT) || sticks.moveX < -PAD.menuStep ? 'left'
            : now.has(BUTTON.RIGHT) || sticks.moveX > PAD.menuStep ? 'right' : null
      if (dir !== this.menuHeld) { this.menuHeld = dir; this.menuRepeat = PAD.repeatDelay; if (dir) b.menu(dir) }
      else if (dir && (this.menuRepeat -= dt) <= 0) { this.menuRepeat = PAD.repeatEvery; b.menu(dir) }
      if (down(BUTTON.A)) b.menu('accept')
      if (down(BUTTON.B)) b.menu('back')
      if (down(BUTTON.START)) b.menu('start')
    }
    b.useHeld?.(playing && now.has(BUTTON.X))
    this.held = now
    return true
  }

  /** Let go of everything held (pausing, a pad unplugged). Buttons still down do not count as new presses. */
  private release() {
    this.releaseHeld()
    this.bindings.move(0, 0)
  }

  private releaseHeld() {
    if (this.held.has(BUTTON.RT)) this.bindings.action('fire', false)
    if (this.held.has(BUTTON.LT)) this.bindings.action('aim', false)
    if (this.sprintSent) this.bindings.action('sprint', false)
    this.sprintLatched = this.sprintSent = false
    this.useTimer = -1
    // Still held, but already answered: nothing more happens until it is let go and pressed again.
  }
}
