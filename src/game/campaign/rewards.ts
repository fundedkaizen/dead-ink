import { grantReward as payInk, grantXp as payXp } from '../zombies/cosmetics/profile'
import type { RunStats, StealthRating } from './stealth'

/**
 * What a finished rescue pays, through the shared progression: Ink into the same wallet as Dead Ink's Shop and
 * cases, and XP towards the same Career levels and prestige (with its level-up toast).
 */
export function grantReward(ink: number, reason: string) {
  if (!(ink > 0)) return
  payInk(Math.floor(ink), reason)
}

export function grantXp(amount: number, reason: string) {
  if (!(amount > 0)) return
  payXp(Math.floor(amount), reason)
}

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
