import type { WeaponName } from '../../types'
import { countKill, settle, type ChallengeUnlock, type KillRecord } from './challenges'
import { awardGame, inkForGame, loadProfile, updateProfile } from './profile'

/**
 * The API the Dead Ink runtime calls as a game goes: kills, rounds, the Brute, Ink Storms and game over.
 * Every `record*` returns the challenges it just completed, for a toast.
 *
 * Kills change the profile in memory only (a kill can come every frame); the profile is saved at the start
 * of every round and at game over, so closing the tab mid-round loses at most that round's progress.
 */

export type GameEnd = {
  round: number; kills: number; headshots: number
  /** Trigger pulls (a shotgun blast is one) and pulls that hit at least one zombie. */
  shotsFired?: number; shotsHit?: number
  /** Seconds survived. */
  elapsed?: number
}
export type InkLine = { label: string; detail: string; ink: number }
/** Everything the game-over summary shows. */
export type GameReport = {
  round: number; kills: number; headshots: number
  shotsFired: number; shotsHit: number
  /** 0 to 1, or null when no shot was fired. */
  accuracy: number | null
  elapsed: number
  bestWeapon: { weapon: WeaponName; kills: number } | null
  inkLines: InkLine[]; inkTotal: number
  challenges: ChallengeUnlock[]
  /** Best round before this game, and whether this game beat it. */
  previousBest: number; newRecord: boolean
}

let game = { kills: new Map<WeaponName, number>(), unlocked: [] as ChallengeUnlock[], bonusInk: 0 }
let report: GameReport | null = null

/** A new game starts: forget the last game's per-gun kills and unlocks. Call on every start and restart. */
export function beginGame() {
  game = { kills: new Map(), unlocked: [], bonusInk: 0 }
}

/** Pay account-challenge Ink at once and remember the unlocks for the summary. */
function settleNow(save: boolean) {
  const profile = loadProfile()
  const unlocked = settle(profile.challenges)
  const ink = unlocked.reduce((sum, unlock) => sum + (unlock.ink ?? 0), 0)
  game.unlocked.push(...unlocked)
  game.bonusInk += ink
  if (ink || unlocked.length || save) updateProfile(p => ({ ...p, ink: p.ink + ink }))
  return unlocked
}

/** One kill by the player. `weapon` is the gun that made it (none for the knife, grenades or the Nuke). */
export function recordKill(kill: KillRecord): ChallengeUnlock[] {
  countKill(loadProfile().challenges, kill)
  if (kill.weapon && !kill.special) game.kills.set(kill.weapon, (game.kills.get(kill.weapon) ?? 0) + 1)
  return settleNow(false)
}

/** A round starts (round `n` reached). Saves the profile. */
export function recordRound(n: number): ChallengeUnlock[] {
  const account = loadProfile().challenges.account
  account.bestRound = Math.max(account.bestRound, Math.floor(n) || 0)
  return settleNow(true)
}

export function recordBruteKill(): ChallengeUnlock[] {
  loadProfile().challenges.account.bruteKills++
  return settleNow(true)
}

export function recordStormSurvived(): ChallengeUnlock[] {
  loadProfile().challenges.account.storms++
  return settleNow(true)
}

/**
 * Game over: pay the game's Ink (round x10 + kills + headshots x2), save, and build the summary report.
 * Replaces the runtime's awardGame call. The report stays available through lastReport() for the menu.
 */
export function recordGameEnd(end: GameEnd): GameReport {
  const whole = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  const round = whole(end.round), kills = whole(end.kills), headshots = whole(end.headshots)
  const shotsFired = whole(end.shotsFired), shotsHit = Math.min(whole(end.shotsHit), shotsFired)
  const previousBest = loadProfile().bestRound
  settleNow(false)
  const bonus = game.bonusInk
  awardGame({ round, kills, headshots }, bonus)
  let best: GameReport['bestWeapon'] = null
  for (const [weapon, count] of game.kills) if (!best || count > best.kills) best = { weapon, kills: count }
  const inkLines: InkLine[] = [
    { label: 'Rounds', detail: `${round} × 10`, ink: round * 10 },
    { label: 'Kills', detail: `${kills} × 1`, ink: kills },
    { label: 'Headshots', detail: `${headshots} × 2`, ink: headshots * 2 },
    ...game.unlocked.filter(u => u.ink).map(u => ({ label: u.title.split(' · ')[0], detail: u.detail, ink: u.ink! })),
  ]
  report = {
    round, kills, headshots, shotsFired, shotsHit, accuracy: shotsFired ? shotsHit / shotsFired : null,
    elapsed: Math.max(0, end.elapsed ?? 0), bestWeapon: best,
    inkLines, inkTotal: inkForGame({ round, kills, headshots }) + bonus,
    challenges: [...game.unlocked], previousBest, newRecord: round > previousBest,
  }
  beginGame()
  return report
}

/** The last finished game's report, for the game-over page; null before any game ended this session. */
export const lastReport = () => report
/** Checks and staging only: show a made-up report on the game-over page. */
export function setReport(next: GameReport | null) { report = next }
