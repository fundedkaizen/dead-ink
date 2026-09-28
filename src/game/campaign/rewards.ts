import { updateProfile } from '../zombies/cosmetics/profile'
import type { RunStats, StealthRating } from './stealth'

/**
 * What a finished rescue pays, through the profile Dead Ink keeps (Ink). Local stand-ins until the shared
 * progression lands (the zombies side's grantReward, grantXp and awardsFor): the Ink goes into the same
 * profile; XP has nowhere to go yet and is only reported on the summary.
 */
export function grantReward(ink: number, _reason: string) {
  if (!(ink > 0)) return
  updateProfile(profile => ({ ...profile, ink: profile.ink + Math.floor(ink) }))
}

export function grantXp(_amount: number, _reason: string) { /* no XP store yet */ }

export type RescueAwardStats = RunStats & { mode: 'rescue'; mission: string; difficulty: string; rating: StealthRating }

/** Named awards for a finished rescue. */
export function awardsFor(stats: RescueAwardStats): string[] {
  const awards: string[] = []
  if (stats.rating === 'Ghost') awards.push('Ghost: never seen')
  if (stats.hostageDamage <= 0 && stats.hostageDowned === 0) awards.push('Not a scratch on them')
  if (stats.takedowns >= 3) awards.push(`Quiet hands: ${stats.takedowns} takedowns`)
  if (stats.time <= stats.par * 0.6) awards.push('In and out')
  if (stats.alarms === 0 && stats.difficulty === 'nightmare') awards.push('Nightmare, undetected')
  if (stats.loudShots >= 60) awards.push('Loud and proud')
  if (stats.kills === 0) awards.push('Nobody had to die')
  return awards
}
