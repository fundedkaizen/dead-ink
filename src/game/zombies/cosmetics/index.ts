/** Dead Ink cosmetics and meta-progression: the one import the zombies runtime needs. */
export { ARMORY_PAGE, applyDeadInkMenuSkin, deadInkHome, installCosmetics } from './armory'
export { awardGame, equippedCosmetics, inkForGame, loadProfile, onProfileChange } from './profile'
export { beginGame, lastReport, recordBruteKill, recordGameEnd, recordKill, recordRound, recordStormSurvived, type GameEnd, type GameReport } from './progression'
export type { ChallengeUnlock, KillRecord } from './challenges'
export type { EquippedCosmetics } from './catalogue'
