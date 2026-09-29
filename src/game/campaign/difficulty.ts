import type { Difficulty } from './types'

/**
 * What a harder rescue changes. Guards: more of them (the map's Hard and Nightmare guards join), better aim,
 * quicker to notice you, and more reinforcements when the alarm sounds. Cameras catch you sooner, dogs smell
 * you from further off, and the hostage has less health. The rewards grow with it.
 */
export type DifficultyRules = {
  /** Guards' chance to hit, times this. */
  accuracy: number
  /** How fast a guard that sees you becomes sure of it, times this. */
  alertness: number
  /** A guard's sight distance before contact, times this. */
  sight: number
  /** Seconds a camera must hold you before the alarm. */
  cameraDwell: number
  /** Reserves the alarm can send in all. */
  reinforcements: number
  /** Seconds until the alarm's second wave. */
  secondWave: number
  /** Dogs smell you within this many metres (walking; running doubles it). */
  smell: number
  hostageHealth: number
  /** Ink and XP for a finished mission, times this. */
  reward: number
  /** The map's guards of these tiers join. */
  tiers: ('hard' | 'nightmare')[]
}

export const DIFFICULTY: Record<Difficulty, DifficultyRules> = {
  normal: { accuracy: 0.85, alertness: 0.8, sight: 0.9, cameraDwell: 1.0, reinforcements: 4, secondWave: 16, smell: 6, hostageHealth: 100, reward: 1, tiers: [] },
  hard: { accuracy: 1.05, alertness: 1.15, sight: 1, cameraDwell: 0.75, reinforcements: 6, secondWave: 12, smell: 8, hostageHealth: 80, reward: 1.6, tiers: ['hard'] },
  nightmare: { accuracy: 1.25, alertness: 1.6, sight: 1.15, cameraDwell: 0.5, reinforcements: 8, secondWave: 9, smell: 10.5, hostageHealth: 60, reward: 2.5, tiers: ['hard', 'nightmare'] },
}

export const rulesFor = (difficulty: Difficulty) => DIFFICULTY[difficulty] ?? DIFFICULTY.normal

/** Ink and XP for a finished mission: the mission's base, its stars, and the difficulty. */
export function missionReward(number: number, stars: number, difficulty: Difficulty) {
  const scale = rulesFor(difficulty).reward
  const ink = Math.round((60 + number * 25 + stars * 30) * scale)
  const xp = Math.round((400 + number * 150 + stars * 150) * scale)
  return { ink, xp }
}
