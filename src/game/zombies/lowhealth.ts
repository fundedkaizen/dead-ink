import './lowhealth.css'

/**
 * Low health: below half health, red ink creeps in from the edges of the page with a slow heartbeat,
 * stronger and quicker as you near death, and draws back as you regenerate. A hit flashes the edges.
 * Under reduced motion the ink sits still at its level: no heartbeat and no flash.
 *
 * Cheap by design: one fixed layer of pre-drawn blots, and only its opacity and transform change per frame.
 */
export const LOW_HEALTH = {
  /** Health fraction where the ink starts to show. */
  threshold: 0.5,
  /** Seconds for the shown level to catch up with health (it creeps; it does not snap). */
  ease: 0.45,
  /** Heartbeat period at the threshold and at death, in seconds. */
  beatSlow: 1.25, beatFast: 0.62,
  /** A hit's flash, and how fast it fades (per second). */
  flash: 0.55, flashFade: 3.2,
} as const

export type LowHealthOptions = {
  /** Where the overlay goes (document.body by default). */
  parent?: HTMLElement
  /** Reduced motion; reads body[data-reduced-motion] by default, as the HUD sets it. */
  reducedMotion?: () => boolean
  /** Called on every first heartbeat thump with the strength (0 to 1): the place for a heartbeat sound. */
  onBeat?: (strength: number) => void
}

/** The level (0 to 1) a health fraction asks for: nothing at or above the threshold, full at zero. */
export const lowHealthLevel = (fraction: number) =>
  Math.pow(Math.min(1, Math.max(0, (LOW_HEALTH.threshold - fraction) / LOW_HEALTH.threshold)), 0.85)

/** Where in a beat the first thump peaks. */
const THUMP = 0.06
/** The heartbeat's shape over one beat (phase 0 to 1): a strong thump, then a softer one. */
export function heartbeat(phase: number) {
  const pulse = (at: number, width: number) => Math.max(0, 1 - Math.abs(phase - at) / width)
  return Math.max(pulse(THUMP, 0.08), pulse(0.26, 0.09) * 0.6)
}

/** Blots along the four edges, seeded so they sit the same way every game. */
function blots() {
  let seed = 9
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const shapes: string[] = []
  for (let i = 0; i < 44; i++) {
    const side = i % 4, t = random()
    const x = side === 0 ? t * 100 : side === 1 ? 100 : side === 2 ? t * 100 : 0
    const y = side === 0 ? 0 : side === 1 ? t * 100 : side === 2 ? 100 : t * 100
    const r = 6 + random() * 12
    shapes.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(r * (0.7 + random() * 0.6)).toFixed(1)}" ry="${(r * (0.7 + random() * 0.6)).toFixed(1)}" opacity="${(0.55 + random() * 0.45).toFixed(2)}"/>`)
  }
  // A little turbulence roughens the blots' edges into bled ink; drawn once, then only moved.
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <defs><filter id="low-health-rough" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.16" numOctaves="2" seed="4"/>
      <feDisplacementMap in="SourceGraphic" scale="5"/></filter></defs>
    <g fill="currentColor" filter="url(#low-health-rough)">${shapes.join('')}</g></svg>`
}

export class LowHealthWarning {
  readonly element = document.createElement('div')
  private level = 0
  private flashLevel = 0
  private phase = 0
  private reducedMotion: () => boolean
  private onBeat?: (strength: number) => void

  constructor(options: LowHealthOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? (() => document.body.dataset.reducedMotion === 'true')
    this.onBeat = options.onBeat
    this.element.className = 'low-health'
    this.element.setAttribute('aria-hidden', 'true')
    this.element.innerHTML = `<div class="low-health-wash"></div><div class="low-health-blots">${blots()}</div><div class="low-health-flash"></div>`
    ;(options.parent ?? document.body).append(this.element)
    this.apply(0)
  }

  /** Every frame while playing: `healthFraction` is health / max health (0 to 1). */
  update(dt: number, healthFraction: number) {
    const target = lowHealthLevel(healthFraction)
    const still = this.reducedMotion()
    // Creep toward the target; under reduced motion, go there at once and hold.
    this.level = still ? target : this.level + (target - this.level) * (1 - Math.exp(-Math.max(0, dt) / LOW_HEALTH.ease))
    if (Math.abs(this.level - target) < 0.001) this.level = target
    this.flashLevel = still ? 0 : Math.max(0, this.flashLevel - dt * LOW_HEALTH.flashFade)
    let beat = 0
    if (!still && this.level > 0.01) {
      const period = LOW_HEALTH.beatSlow + (LOW_HEALTH.beatFast - LOW_HEALTH.beatSlow) * this.level
      const before = this.phase
      this.phase = (this.phase + dt / period) % 1
      // The sound goes with the first thump's peak (phase 0.06), including when a frame wraps past it.
      const wrapped = this.phase < before
      if ((wrapped || before < THUMP) && this.phase >= THUMP) this.onBeat?.(this.level)
      beat = heartbeat(this.phase)
    } else this.phase = 0
    this.apply(beat)
  }

  /** A hit: the edges flash red at once. `strength` 0 to 1 (damage / max health is a good measure). */
  hit(strength = 0.5) {
    if (this.reducedMotion()) return
    this.flashLevel = Math.min(1, Math.max(this.flashLevel, LOW_HEALTH.flash * (0.6 + Math.min(1, Math.max(0, strength)) * 0.8)))
    this.apply(0)
  }

  /** Straight back to clear (a new game, a revive, death's own screen). */
  clear() { this.level = 0; this.flashLevel = 0; this.phase = 0; this.apply(0) }

  dispose() { this.element.remove() }

  /** Levels for checks and staging. */
  get state() { return { level: this.level, flash: this.flashLevel, phase: this.phase } }

  private apply(beat: number) {
    const level = this.level, style = this.element.style
    const shown = level > 0.001 || this.flashLevel > 0.001
    this.element.hidden = !shown
    if (!shown) return
    // The ink comes further in as health falls; each heartbeat pushes it in a little more.
    style.setProperty('--low-health', level.toFixed(3))
    style.setProperty('--low-health-beat', (beat * (0.35 + level * 0.65)).toFixed(3))
    style.setProperty('--low-health-flash', this.flashLevel.toFixed(3))
  }
}
