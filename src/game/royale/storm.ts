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
 * Tuned for the ~290 m x 155 m compound and a match of roughly seven minutes. `ratio` is the next
 * circle's radius as a fraction of the current one; the last phase closes to nothing, so a match
 * always ends. The first hold is the grace period to land and loot.
 */
export const DEFAULT_PHASES: StormPhase[] = [
  { hold: 60, shrink: 45, damage: 1, ratio: 0.62 },
  { hold: 45, shrink: 35, damage: 2, ratio: 0.62 },
  { hold: 40, shrink: 30, damage: 5, ratio: 0.58 },
  { hold: 30, shrink: 25, damage: 8, ratio: 0.52 },
  { hold: 25, shrink: 20, damage: 10, ratio: 0.4 },
  { hold: 20, shrink: 30, damage: 15, ratio: 0 },
]

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
