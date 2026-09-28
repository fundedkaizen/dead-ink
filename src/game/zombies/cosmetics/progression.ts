import type { WeaponName } from '../../types'
import { awardsFor, type AwardStats, type AwardValues, type PlayerAwards } from '../../shared/awards'
import { countKill, settle, type ChallengeUnlock, type KillRecord } from './challenges'
import { XP, levelOf, xpForRound, type LevelInfo } from './career'
import { awardGame, grantXp, inkForGame, inkMultiplier, loadProfile, submitRecords, updateProfile } from './profile'
import { recordKey, type Placing, type RecordMode } from './records'

/**
 * The API the Dead Ink runtime calls as a game goes: kills, rounds, the Brute, Ink Storms and game over.
 * Every `record*` returns the challenges it just completed, for a toast.
 *
 * Kills change the profile in memory only (a kill can come every frame); the profile is saved at the start
 * of every round and at game over, so closing the tab mid-round loses at most that round's progress. Kills
 * and rounds also earn XP toward the Career (career.ts); a level-up shows its toast at once.
 */

export type GameEnd = {
  round: number; kills: number; headshots: number
  /** Trigger pulls (a shotgun blast is one) and pulls that hit at least one zombie. */
  shotsFired?: number; shotsHit?: number
  /** Seconds survived. */
  elapsed?: number
  /** For the Ink multiplier and the high scores: the difficulty, solo or co-op, and the map. */
  difficulty?: string; mode?: RecordMode; map?: string
  /** This player's numbers for the end-of-game awards (awards.ts), and name and colour to show them with. */
  stats?: AwardValues; name?: string; color?: string; player?: number
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
  /** XP this game earned, and the level before and after it. */
  xp?: { earned: number; before: LevelInfo; after: LevelInfo; prestige: number }
  /** Top-ten places this game took in the high scores (records.ts), and which table. */
  records?: Placing[]; recordKey?: string
  /** Every player's awards (in co-op, as the host sent them). */
  awards?: PlayerAwards[]
}

let game = { kills: new Map<WeaponName, number>(), unlocked: [] as ChallengeUnlock[], bonusInk: 0, xp: 0, xpBefore: levelOf(0), reached10: null as number | null, reached20: null as number | null }
let report: GameReport | null = null
const reportListeners = new Set<(report: GameReport) => void>()

/** A new game starts: forget the last game's per-gun kills and unlocks. Call on every start and restart. */
export function beginGame() {
  game = { kills: new Map(), unlocked: [], bonusInk: 0, xp: 0, xpBefore: levelOf(loadProfile().xp), reached10: null, reached20: null }
}

function earn(amount: number, reason: string, save: boolean) {
  const grant = grantXp(amount, reason, save)
  game.xp += grant.xp
}

/** Pay account-challenge Ink (and any cosmetic it unlocks) at once, and remember the unlocks for the summary. */
function settleNow(save: boolean) {
  const profile = loadProfile()
  const unlocked = settle(profile.challenges)
  const ink = unlocked.reduce((sum, unlock) => sum + (unlock.ink ?? 0), 0)
  const rewards = unlocked.flatMap(unlock => unlock.reward && !profile.owned.includes(unlock.reward) ? [unlock.reward] : [])
  game.unlocked.push(...unlocked)
  game.bonusInk += ink
  if (ink || unlocked.length || save) updateProfile(p => ({ ...p, ink: p.ink + ink, owned: rewards.length ? [...p.owned, ...rewards] : p.owned }))
  if (unlocked.length) earn(XP.challenge * unlocked.length, 'Challenges', true)
  return unlocked
}

/** One kill by the player. `weapon` is the gun that made it (none for the knife, grenades or the Nuke). */
export function recordKill(kill: KillRecord): ChallengeUnlock[] {
  countKill(loadProfile().challenges, kill)
  if (kill.weapon && !kill.special) game.kills.set(kill.weapon, (game.kills.get(kill.weapon) ?? 0) + 1)
  earn(XP.kill + (kill.headshot ? XP.headshot : 0) + (kill.knife ? XP.knife : 0), 'Kills', false)
  return settleNow(false)
}

/**
 * A round starts (round `n` reached). Saves the profile. `elapsed`: seconds into the game, for the fastest-to
 * round 10 and 20 records. Every round reached after the first pays XP.
 */
export function recordRound(n: number, elapsed?: number): ChallengeUnlock[] {
  const round = Math.floor(n) || 0
  const account = loadProfile().challenges.account
  account.bestRound = Math.max(account.bestRound, round)
  if (round === 10 && game.reached10 === null && Number.isFinite(elapsed)) game.reached10 = elapsed!
  if (round === 20 && game.reached20 === null && Number.isFinite(elapsed)) game.reached20 = elapsed!
  if (round > 1) earn(xpForRound(round - 1), `Round ${round - 1} survived`, false)
  return settleNow(true)
}

export function recordBruteKill(): ChallengeUnlock[] {
  loadProfile().challenges.account.bruteKills++
  return settleNow(true)
}

/** The main quest finished: the Editor is dead. */
export function recordQuestComplete(): ChallengeUnlock[] {
  loadProfile().challenges.account.editions++
  return settleNow(true)
}

export function recordStormSurvived(): ChallengeUnlock[] {
  loadProfile().challenges.account.storms++
  return settleNow(true)
}

/**
 * Game over: pay the game's Ink (round x10 + kills + headshots x2, times the difficulty's and prestige's
 * multiplier), the game's XP, put it in the high scores, work out this player's awards (a co-op host sends
 * everyone's later: setAwards), save, and build the summary report. The report stays available through
 * lastReport() for the menu.
 */
export function recordGameEnd(end: GameEnd): GameReport {
  const whole = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  const round = whole(end.round), kills = whole(end.kills), headshots = whole(end.headshots)
  const shotsFired = whole(end.shotsFired), shotsHit = Math.min(whole(end.shotsHit), shotsFired)
  const previousBest = loadProfile().bestRound
  settleNow(false)
  const bonus = game.bonusInk
  const multiplier = inkMultiplier(end.difficulty ?? 'normal')
  const base = inkForGame({ round, kills, headshots })
  const earned = awardGame({ round, kills, headshots }, bonus, multiplier)
  earn(XP.gameEnd, 'Game played', true)
  let best: GameReport['bestWeapon'] = null
  for (const [weapon, count] of game.kills) if (!best || count > best.kills) best = { weapon, kills: count }
  const inkLines: InkLine[] = [
    { label: 'Rounds', detail: `${round} × 10`, ink: round * 10 },
    { label: 'Kills', detail: `${kills} × 1`, ink: kills },
    { label: 'Headshots', detail: `${headshots} × 2`, ink: headshots * 2 },
    ...(earned !== base ? [{ label: 'Difficulty and prestige', detail: `× ${multiplier.toFixed(2)}`, ink: earned - base }] : []),
    ...game.unlocked.filter(u => u.ink).map(u => ({ label: u.title.split(' · ')[0], detail: u.detail, ink: u.ink! })),
  ]
  const key = recordKey(end.map ?? 'compound', end.mode ?? 'solo', end.difficulty ?? 'normal')
  const records = submitRecords(key, { round, kills, reached10: game.reached10, reached20: game.reached20 })
  const me: AwardStats = { player: end.player ?? 0, name: end.name ?? 'You', color: end.color, values: { kills, headshots, ...(end.stats ?? {}) } }
  const profile = loadProfile()
  report = {
    round, kills, headshots, shotsFired, shotsHit, accuracy: shotsFired ? shotsHit / shotsFired : null,
    elapsed: Math.max(0, end.elapsed ?? 0), bestWeapon: best,
    inkLines, inkTotal: earned + bonus,
    challenges: [...game.unlocked], previousBest, newRecord: round > previousBest,
    xp: { earned: game.xp, before: game.xpBefore, after: levelOf(profile.xp), prestige: profile.prestige },
    records, recordKey: key,
    awards: awardsFor([me]),
  }
  beginGame()
  for (const listener of reportListeners) listener(report)
  return report
}

/** Co-op: the host's awards for every player arrived; the summary shows them in place of this player's own. */
export function setAwards(awards: PlayerAwards[]) {
  if (!report) return
  report = { ...report, awards }
  for (const listener of reportListeners) listener(report)
}

/** Called when the report changes (a game ends, the host's awards arrive). Returns an unsubscribe function. */
export function onReport(listener: (report: GameReport) => void) { reportListeners.add(listener); return () => { reportListeners.delete(listener) } }

/** The last finished game's report, for the game-over page; null before any game ended this session. */
export const lastReport = () => report
/** Checks and staging only: show a made-up report on the game-over page. */
export function setReport(next: GameReport | null) { report = next }
