import type { Stars } from './progress'

/**
 * How loud things are (metres a guard hears them from in the open; through walls a little under half), and how
 * fast a guard who can see you becomes sure of it. The existing rules stay as they were: a walk is 6 m, a run
 * 15, a pistol 38, a rifle 55. The rescue campaign adds a crouched walk, a suppressed pistol, a thrown stone,
 * a takedown and a breach charge.
 */
export const NOISE = {
  crouch: 2.5, walk: 6, run: 15,
  suppressed: 11, pistol: 38, rifle: 55,
  stone: 14, takedown: 3, breach: 70, lockpick: 2, bark: 32,
} as const

/** A footstep's reach: crouched, walking, running. */
export function footstepRadius(speed: number, crouched: boolean) {
  if (crouched) return NOISE.crouch
  return speed > 5 ? NOISE.run : NOISE.walk
}

/** A player gun's report: suppressed pistols are quiet, pistols middling, everything else loud. */
export function shotRadius(weapon: string, suppressed = false) {
  if (suppressed) return NOISE.suppressed
  return weapon === 'pistol' ? NOISE.pistol : NOISE.rifle
}

/** What a watcher sees of a player: crouched, moving, running (the guard's own alertness comes in separately). */
export type Exposure = { crouched?: boolean; moving?: boolean; running?: boolean; leaning?: boolean }

/** Seen this close, a guard knows at once. */
export const POINT_BLANK = 2.5
/** Awareness at which a guard turns to look (his cone shows); 1 is certain: contact. */
export const SUSPECT_AT = 0.3

/**
 * Awareness a guard gains per second while he sees you. Close is fast (a second at ten metres standing), far
 * is slow, crouched and still is slowest; `alertness` is the difficulty's (and an alerted guard's) factor.
 */
export function detectionRate(distance: number, exposure: Exposure, alertness = 1) {
  if (distance <= POINT_BLANK) return Infinity
  let rate = 1 / (0.3 + distance * 0.06)
  if (exposure.crouched) rate *= 0.5
  if (exposure.running) rate *= 1.5
  else if (!exposure.moving) rate *= 0.7
  // Only a head and shoulders round a corner.
  if (exposure.leaning) rate *= 0.6
  return rate * alertness
}

export type RunStats = {
  time: number; par: number
  alarms: number; detections: number
  kills: number; takedowns: number; shots: number; loudShots: number
  hostageDamage: number; hostageDowned: number
  bodiesFound: number
}

/** Three stars: under par, the alarm never sounded, the hostage never hurt. */
export function starsFor(stats: RunStats): Stars {
  return [stats.time <= stats.par, stats.alarms === 0, stats.hostageDamage <= 0 && stats.hostageDowned === 0]
}

export type StealthRating = 'Ghost' | 'Silent' | 'Careful' | 'Noisy' | 'Loud'
export const STEALTH_BLURBS: Record<StealthRating, string> = {
  Ghost: 'Never seen, never heard. Nobody got hurt who did not have to.',
  Silent: 'No alarm, no loud shots. They never knew you were there.',
  Careful: 'A few close calls, but the alarm stayed quiet.',
  Noisy: 'They knew someone was in the compound.',
  Loud: 'Everyone knew. You got out anyway.',
}

/** How quietly the rescue went, from what the run counted. */
export function stealthRating(stats: RunStats): StealthRating {
  if (stats.alarms === 0 && stats.detections === 0 && stats.loudShots === 0 && stats.kills - stats.takedowns <= 0 && stats.bodiesFound === 0) return 'Ghost'
  if (stats.alarms === 0 && stats.loudShots === 0 && stats.bodiesFound <= 1) return 'Silent'
  if (stats.alarms === 0) return 'Careful'
  if (stats.alarms <= 1 && stats.loudShots < 40) return 'Noisy'
  return 'Loud'
}
