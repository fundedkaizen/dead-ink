import type { Random } from './random'

/**
 * The storm: a circle that holds, then shrinks toward a smaller circle inside it, over and over,
 * until it closes completely. Outside it you lose health every second, and the rate climbs each phase.
 *
 * Pure logic, no rendering, so the whole schedule can be checked in Node.
 */
export type Circle = { x: number; z: number; r: number }
export type StormPhase = { hold: number; shrink: number; damage: number; ratio: number }
export type Arena = { minX: number; maxX: number; minZ: number; maxZ: number }
export type StormPlan = { circles: Circle[]; phases: StormPhase[] }

/**
 * Fortnite's storm, Chapter 7 Season 4, from the community zone timer at fortnitetools.com
 * (not official Epic data; Epic retunes it most seasons). `wait` and `shrink` in seconds,
 * `damage` in health per second while outside. Kept verbatim so the reference can be checked.
 */
export const FORTNITE_STORM = [
  { wait: 150, shrink: 90, damage: 1 },
  { wait: 110, shrink: 75, damage: 2 },
  { wait: 90, shrink: 60, damage: 5 },
  { wait: 60, shrink: 50, damage: 7 },
  { wait: 45, shrink: 40, damage: 10 },
  { wait: 30, shrink: 30, damage: 12 },
  { wait: 20, shrink: 25, damage: 15 },
  { wait: 10, shrink: 20, damage: 20 },
] as const

/**
 * Fortnite's storm runs about 15 minutes for 100 players on a map roughly eight times this
 * compound. Every wait and shrink is multiplied by the same factor, so the rhythm is Fortnite's
 * exactly (each phase shorter than the last in the same proportion) and a match lasts about 7 minutes.
 * Damage is Fortnite's, unscaled.
 */
export const STORM_TIME_SCALE = 0.46

/**
 * Each circle's radius as a fraction of the previous one. The source does not give circle sizes,
 * so these are ours: tighter as the match goes on, and the last closes completely so a match always ends.
 */
export const STORM_RATIOS = [0.65, 0.62, 0.6, 0.58, 0.55, 0.5, 0.45, 0] as const

export const DEFAULT_PHASES: StormPhase[] = FORTNITE_STORM.map((phase, i) => ({
  hold: phase.wait * STORM_TIME_SCALE, shrink: phase.shrink * STORM_TIME_SCALE, damage: phase.damage, ratio: STORM_RATIOS[i],
}))

export function planStorm(arena: Arena, random: Random, phases: StormPhase[] = DEFAULT_PHASES): StormPlan {
  const cx = (arena.minX + arena.maxX) / 2, cz = (arena.minZ + arena.maxZ) / 2
  // The first circle covers the whole arena, corners included, so nobody starts in the storm.
  const r0 = Math.hypot(arena.maxX - arena.minX, arena.maxZ - arena.minZ) / 2 * 1.05
  const circles: Circle[] = [{ x: cx, z: cz, r: r0 }]
  for (const phase of phases) {
    const previous = circles[circles.length - 1]
    const r = previous.r * phase.ratio
    // The next circle sits wholly inside the current one: its centre may wander at most (R - r).
    // Keep it over playable ground by also clamping the centre to the arena.
    const slack = previous.r - r
    const angle = random() * Math.PI * 2, distance = Math.sqrt(random()) * slack
    let x = previous.x + Math.cos(angle) * distance, z = previous.z + Math.sin(angle) * distance
    x = Math.min(arena.maxX, Math.max(arena.minX, x))
    z = Math.min(arena.maxZ, Math.max(arena.minZ, z))
    // Clamping can push the centre; pull it back if that broke containment.
    const offset = Math.hypot(x - previous.x, z - previous.z)
    if (offset > slack && offset > 0) {
      x = previous.x + (x - previous.x) * slack / offset
      z = previous.z + (z - previous.z) * slack / offset
    }
    circles.push({ x, z, r })
  }
  return { circles, phases }
}

export type StormNow = {
  /** The circle right now; you are safe inside it. */
  circle: Circle
  /** Where this phase ends up. */
  target: Circle
  phase: number
  shrinking: boolean
  /** Seconds until the next change: the shrink starting, or the shrink ending. */
  nextIn: number
  /** Health per second lost while outside, during this phase. */
  damage: number
  finished: boolean
}

export function stormAt(plan: StormPlan, elapsed: number): StormNow {
  let t = Math.max(0, elapsed)
  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i], from = plan.circles[i], to = plan.circles[i + 1]
    if (t < phase.hold) return { circle: { ...from }, target: { ...to }, phase: i, shrinking: false, nextIn: phase.hold - t, damage: phase.damage, finished: false }
    t -= phase.hold
    if (t < phase.shrink) {
      const k = t / phase.shrink
      return {
        circle: { x: from.x + (to.x - from.x) * k, z: from.z + (to.z - from.z) * k, r: from.r + (to.r - from.r) * k },
        target: { ...to }, phase: i, shrinking: true, nextIn: phase.shrink - t, damage: phase.damage, finished: false,
      }
    }
    t -= phase.shrink
  }
  const last = plan.phases.length - 1
  return { circle: { ...plan.circles[last + 1] }, target: { ...plan.circles[last + 1] }, phase: last, shrinking: false,
    nextIn: 0, damage: plan.phases[last].damage, finished: true }
}

/** Metres outside the circle; zero or negative means safe. */
export const outsideBy = (circle: Circle, x: number, z: number) => Math.hypot(x - circle.x, z - circle.z) - circle.r

export const stormDuration = (plan: StormPlan) => plan.phases.reduce((sum, phase) => sum + phase.hold + phase.shrink, 0)

/**
 * Storm damage lands once per full second spent outside. Time outside accumulates across brief trips
 * back inside, so strafing across the edge cannot dodge it; it only stops growing while you are safe.
 * Returns the whole ticks due now and the carried remainder.
 */
export function advanceStormTimer(timer: number, dt: number, outside: boolean) {
  if (!outside || !(dt > 0)) return { timer, ticks: 0 }
  const total = timer + dt, ticks = Math.floor(total)
  return { timer: total - ticks, ticks }
}
