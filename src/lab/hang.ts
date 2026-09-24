import type { Pose } from './clip'

/**
 * Arms hanging at the sides with a slightly bent elbow. Reuse as the base for standing poses. Its own module,
 * free of clips, so the game's own code (postures, guns) can use it without importing clips/idle, which builds
 * its clip on load and must only load after loadStickman().
 */
export const hang: Pose = {
  'upper_arm.L': [-78, 0, 0], 'upper_arm.R': [-78, 0, 0],
  'forearm.L': [0, 0, -10], 'forearm.R': [0, 0, 10],
}
