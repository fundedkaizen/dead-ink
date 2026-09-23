import type { WeaponName } from '../../types'
import type { ChallengeCamoId } from './catalogue'

/**
 * Dead Ink's camo grind, after Call of Duty's: every gun has four tiers, each paying a camo for that gun;
 * finishing Tier 4 on every gun unlocks Diamond for all of them. Account challenges pay Ink.
 *
 * Pure data and pure functions over a ChallengeState: no storage, no DOM. profile.ts keeps the state and
 * progression.ts is the API the runtime calls.
 *
 * The goals are meant to take many games. A solo game to round 15 is about 430 kills across two or three
 * guns, to round 20 about 690; headshots are roughly a quarter of kills for a careful player.
 */
export const CHALLENGE_WEAPONS: readonly WeaponName[] = ['pistol', 'smg', 'ak', 'shotgun', 'sniper', 'magnum', 'lmg']
export const WEAPON_LABELS: Record<WeaponName, string> = {
  pistol: 'Pistol', smg: 'SMG', ak: 'AK', shotgun: 'Shotgun', sniper: 'Sniper', magnum: 'Magnum', lmg: 'LMG',
}

/** What a gun's tier counts. */
export type WeaponMetric = 'kills' | 'headshots' | 'packedKills' | 'deepKills'
/** Kills from this round on count as deep kills (Tier 4). */
export const DEEP_ROUND = 20
export type WeaponTier = { tier: 1 | 2 | 3 | 4; metric: WeaponMetric; goal: number; camo: ChallengeCamoId; label: (goal: number) => string }

/**
 * The same four tiers for every gun, so the grid reads at a glance. A tier completes only after the one
 * before it, as in Call of Duty; progress still counts toward every tier from the first kill.
 */
export const WEAPON_TIERS: readonly WeaponTier[] = [
  { tier: 1, metric: 'kills', goal: 300, camo: 'crosshatch', label: n => `${n.toLocaleString('en-GB')} kills` },
  { tier: 2, metric: 'headshots', goal: 100, camo: 'blueprint', label: n => `${n.toLocaleString('en-GB')} headshot kills` },
  { tier: 3, metric: 'packedKills', goal: 250, camo: 'red-ink', label: n => `${n.toLocaleString('en-GB')} kills while Pack-a-Punched` },
  { tier: 4, metric: 'deepKills', goal: 200, camo: 'black-gold', label: n => `${n.toLocaleString('en-GB')} kills at round ${DEEP_ROUND} or later` },
]

export type AccountMetric = 'bestRound' | 'bruteKills' | 'storms' | 'kills' | 'headshots' | 'editions'
export type AccountChallenge = { id: string; metric: AccountMetric; goal: number; ink: number; title: string; label: string }
export const ACCOUNT_CHALLENGES: readonly AccountChallenge[] = [
  { id: 'round-10', metric: 'bestRound', goal: 10, ink: 250, title: 'Double Digits', label: 'Reach round 10' },
  { id: 'round-20', metric: 'bestRound', goal: 20, ink: 750, title: 'Deep Water', label: 'Reach round 20' },
  { id: 'round-30', metric: 'bestRound', goal: 30, ink: 2000, title: 'The Long Night', label: 'Reach round 30' },
  { id: 'brute-10', metric: 'bruteKills', goal: 10, ink: 500, title: 'Brute Force', label: 'Kill the Brute 10 times' },
  { id: 'storm-5', metric: 'storms', goal: 5, ink: 500, title: 'Storm Chaser', label: 'Survive 5 Ink Storms' },
  { id: 'headshots-1000', metric: 'headshots', goal: 1000, ink: 1000, title: 'Headhunter', label: '1,000 headshot kills' },
  { id: 'kills-5000', metric: 'kills', goal: 5000, ink: 1500, title: 'Marathon', label: '5,000 kills' },
  { id: 'last-edition', metric: 'editions', goal: 1, ink: 2000, title: 'The Last Edition', label: 'Finish the main quest' },
]

export type WeaponStats = Record<WeaponMetric, number>
export type ChallengeState = {
  weapons: Record<WeaponName, WeaponStats>
  account: Record<AccountMetric, number>
  /** Completed challenge ids: 'ak:1' .. 'ak:4', 'diamond', 'account:round-10'. Rewards pay once. */
  done: string[]
}

export type ChallengeUnlock = {
  id: string
  kind: 'camo' | 'diamond' | 'account'
  /** Short, for a toast: "AK Tier 2 · Blueprint camo". */
  title: string
  detail: string
  weapon?: WeaponName
  tier?: number
  camo?: ChallengeCamoId
  ink?: number
}

const zeroStats = (): WeaponStats => ({ kills: 0, headshots: 0, packedKills: 0, deepKills: 0 })
export function freshChallenges(): ChallengeState {
  return {
    weapons: Object.fromEntries(CHALLENGE_WEAPONS.map(name => [name, zeroStats()])) as Record<WeaponName, WeaponStats>,
    account: { bestRound: 0, bruteKills: 0, storms: 0, kills: 0, headshots: 0, editions: 0 },
    done: [],
  }
}

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
const KNOWN_IDS = new Set([
  ...CHALLENGE_WEAPONS.flatMap(name => WEAPON_TIERS.map(t => `${name}:${t.tier}`)), 'diamond',
  ...ACCOUNT_CHALLENGES.map(c => `account:${c.id}`),
])

/** Stored data is untrusted: unknown ids drop, counts are whole and never negative. */
export function sanitizeChallenges(raw: unknown): ChallengeState {
  const state = freshChallenges()
  if (!raw || typeof raw !== 'object') return state
  const data = raw as Record<string, unknown>
  const weapons = (data.weapons ?? {}) as Record<string, Record<string, unknown>>
  for (const name of CHALLENGE_WEAPONS) {
    const stats = weapons[name]
    if (stats && typeof stats === 'object') for (const metric of Object.keys(state.weapons[name]) as WeaponMetric[]) state.weapons[name][metric] = count(stats[metric])
  }
  const account = (data.account ?? {}) as Record<string, unknown>
  for (const metric of Object.keys(state.account) as AccountMetric[]) state.account[metric] = count(account[metric])
  if (Array.isArray(data.done)) state.done = [...new Set(data.done.filter((id): id is string => typeof id === 'string' && KNOWN_IDS.has(id)))]
  // A tier only counts as done if the one before it is: repair anything stored out of order.
  state.done = state.done.filter(id => {
    const [name, tier] = id.split(':')
    return !CHALLENGE_WEAPONS.includes(name as WeaponName) || Number(tier) === 1 || state.done.includes(`${name}:${Number(tier) - 1}`)
  })
  return state
}

export const tierDone = (state: ChallengeState, weapon: WeaponName, tier: number) => tier <= 0 || state.done.includes(`${weapon}:${tier}`)
export const weaponMastered = (state: ChallengeState, weapon: WeaponName) => tierDone(state, weapon, WEAPON_TIERS.length)
export const masteredCount = (state: ChallengeState) => CHALLENGE_WEAPONS.filter(name => weaponMastered(state, name)).length
export const diamondUnlocked = (state: ChallengeState) => state.done.includes('diamond')

/** A challenge camo is worn per gun: the tier's camo on that gun once the tier is done; Diamond on any gun. */
export function challengeCamoUnlocked(state: ChallengeState, camo: ChallengeCamoId, weapon: WeaponName) {
  if (camo === 'diamond') return diamondUnlocked(state)
  const tier = WEAPON_TIERS.find(t => t.camo === camo)
  return !!tier && tierDone(state, weapon, tier.tier)
}

/** How far along a tier is, for the Armory: the count, the goal, and whether the tier before blocks it. */
export function tierProgress(state: ChallengeState, weapon: WeaponName, tier: WeaponTier) {
  const value = state.weapons[weapon]?.[tier.metric] ?? 0
  return { value: Math.min(value, tier.goal), goal: tier.goal, done: tierDone(state, weapon, tier.tier), blocked: !tierDone(state, weapon, tier.tier - 1) }
}
export const accountProgress = (state: ChallengeState, challenge: AccountChallenge) =>
  ({ value: Math.min(state.account[challenge.metric], challenge.goal), goal: challenge.goal, done: state.done.includes(`account:${challenge.id}`) })

/**
 * Mark everything newly met as done, in order, and return what just completed. Called after every change,
 * so a kill that finishes Tier 1 and was already past Tier 2's goal completes both at once.
 */
export function settle(state: ChallengeState): ChallengeUnlock[] {
  const unlocked: ChallengeUnlock[] = []
  for (const weapon of CHALLENGE_WEAPONS) {
    for (const tier of WEAPON_TIERS) {
      const id = `${weapon}:${tier.tier}`
      if (state.done.includes(id)) continue
      if (!tierDone(state, weapon, tier.tier - 1) || state.weapons[weapon][tier.metric] < tier.goal) break
      state.done.push(id)
      unlocked.push({ id, kind: 'camo', weapon, tier: tier.tier, camo: tier.camo,
        title: `${WEAPON_LABELS[weapon]} Tier ${tier.tier} · ${CAMO_NAMES[tier.camo]} camo`, detail: tier.label(tier.goal) })
    }
  }
  if (!diamondUnlocked(state) && masteredCount(state) === CHALLENGE_WEAPONS.length) {
    state.done.push('diamond')
    unlocked.push({ id: 'diamond', kind: 'diamond', camo: 'diamond', title: 'Diamond camo unlocked', detail: 'Tier 4 on every gun. Diamond works on all of them.' })
  }
  for (const challenge of ACCOUNT_CHALLENGES) {
    const id = `account:${challenge.id}`
    if (state.done.includes(id) || state.account[challenge.metric] < challenge.goal) continue
    state.done.push(id)
    unlocked.push({ id, kind: 'account', ink: challenge.ink, title: `${challenge.title} · +${challenge.ink.toLocaleString('en-GB')} Ink`, detail: challenge.label })
  }
  return unlocked
}

/** Display names for the challenge camos (the catalogue's names), kept here so this file stays pure. */
export const CAMO_NAMES: Record<ChallengeCamoId, string> = {
  crosshatch: 'Crosshatch', blueprint: 'Blueprint', 'red-ink': 'Red Ink', 'black-gold': 'Black Gold', diamond: 'Diamond',
}

export type KillRecord = {
  /** The gun that made the kill; absent for the knife, grenades, the Nuke and other kills with no gun. */
  weapon?: WeaponName | null
  headshot?: boolean
  packed?: boolean
  packLevel?: number
  round: number
  /** Wonder weapons and the Death Machine count toward account totals only. */
  special?: boolean
}

/** Count one kill into the state. Returns nothing; call settle() for unlocks. */
export function countKill(state: ChallengeState, kill: KillRecord) {
  state.account.kills++
  if (kill.headshot) state.account.headshots++
  const weapon = kill.weapon
  if (!weapon || kill.special || !state.weapons[weapon]) return
  const stats = state.weapons[weapon]
  stats.kills++
  if (kill.headshot) stats.headshots++
  if (kill.packed) stats.packedKills++
  if (kill.round >= DEEP_ROUND) stats.deepKills++
}
