import { RARITIES, type Rarity } from '../../loot'
import type { WeaponName } from '../../types'
import { CAMOS, CATALOGUE, CHARMS, GLOVES, KNIVES, NO_COSMETICS, STARTING_ITEMS, WATCHES, cosmeticById, cosmeticKey, isChallengeCamo,
  type CamoId, type CharmId, type CosmeticItem, type EquippedCosmetics, type GloveId, type KnifeId, type WatchId } from './catalogue'
import { ACCOUNT_CHALLENGES, CHALLENGE_WEAPONS, challengeCamoUnlocked, freshChallenges, sanitizeChallenges, settle, type ChallengeState } from './challenges'
import { MAX_LEVEL, MAX_PRESTIGE, MAX_XP, PRESTIGE, STARTING_PISTOLS, canPrestige, levelOf, pistolsFor, prestigeMultiplier, titlesFor, unlockedBy, unlocksBetween,
  type LevelUnlock, type StartingPistol } from './career'
import { sanitizeRecords, submitRun, type Placing, type RecordRun, type RecordTable } from './records'
import { showLevelUp } from './career-toast'

/**
 * The player's meta-progression, kept in this browser: Ink (the currency), what they own, what they
 * wear, and their last and best games. Storage can be missing, full or blocked (private windows,
 * sandboxed previews), so every access is guarded and the profile still works for the session in memory.
 */
export type GameResult = { round: number; kills: number; headshots: number }
export type Profile = {
  /** Stored format. 1 had no field (no challenges); 2 added `challenges`; 3 the Career, records, the Shop and gloves. */
  version: number
  ink: number; owned: string[]; equipped: EquippedCosmetics
  games: number; bestRound: number; opened: number
  last: (GameResult & { ink: number }) | null
  /** Per-gun camo challenges and account challenges. Challenge camos are owned through this, per gun. */
  challenges: ChallengeState
  /** The Career (career.ts): XP in this prestige, the prestige, the highest level ever reached, and all XP ever. */
  xp: number; prestige: number; peakLevel: number; lifetimeXp: number
  /** What a game starts with: the pistol, and the calling card title shown with your name. */
  loadout: { pistol: StartingPistol; title: string | null }
  /** High scores (records.ts). */
  records: RecordTable
  /** Items bought in the Shop. */
  purchases: number
  /** The last few rewards paid (Ink and XP), newest first, with what they were for. */
  rewards: { reason: string; ink: number; xp: number; at: number }[]
}

const KEY = 'dead-ink-profile'
export const PROFILE_VERSION = 3
/** Enough for one case, so a new player sees the Armory work before earning anything. */
const WELCOME_INK = 250
/** Every gun a camo can go on (the Magnum and LMG were missing here, so their camos did not survive a reload). */
const GUNS: readonly WeaponName[] = CHALLENGE_WEAPONS

/** Ink per game: rounds are the achievement, kills and headshots the texture. */
export const inkForGame = ({ round, kills, headshots }: GameResult) =>
  Math.max(0, Math.floor(round) * 10 + Math.floor(kills) + Math.floor(headshots) * 2)

const fresh = (): Profile => ({ version: PROFILE_VERSION, ink: WELCOME_INK, owned: [...STARTING_ITEMS], equipped: { ...NO_COSMETICS, camos: {} },
  games: 0, bestRound: 0, opened: 0, last: null, challenges: freshChallenges(),
  xp: 0, prestige: 0, peakLevel: 1, lifetimeXp: 0, loadout: { pistol: 'pistol', title: null }, records: {}, purchases: 0, rewards: [] })

/**
 * Ink by difficulty: harder games pay more. Rescue missions can pass their own difficulty names (easy, medium,
 * hard, extreme); anything unknown pays as Normal.
 */
export const DIFFICULTY_INK: Record<string, number> = { casual: 0.75, normal: 1, hardcore: 1.35, realistic: 1.75, easy: 0.75, medium: 1, hard: 1.35, extreme: 1.75 }
export const difficultyMultiplier = (difficulty?: string | null) => DIFFICULTY_INK[difficulty ?? 'normal'] ?? 1
/** Everything Ink is multiplied by for this player: the difficulty, and 5% a prestige. */
export const inkMultiplier = (difficulty?: string | null, profile: Pick<Profile, 'prestige'> = loadProfile()) =>
  difficultyMultiplier(difficulty) * prestigeMultiplier(profile.prestige)

const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
const pick = <T extends string>(list: readonly T[], value: unknown): T | null => list.includes(value as T) ? value as T : null

/** A challenge camo is owned per gun through the challenges; every other item through `owned`. */
export function ownsCamo(profile: Profile, camo: CamoId, gun: WeaponName) {
  return isChallengeCamo(camo) ? challengeCamoUnlocked(profile.challenges, camo, gun) : profile.owned.includes(`camo:${camo}`)
}

/**
 * Stored data is untrusted: anything unknown or malformed falls back to the fresh value.
 * Migration: a version 1 profile (before challenges) keeps its Ink, items, equipment and records, starts
 * its challenges fresh, and is paid at once for any round challenge its best round already met.
 */
export function sanitizeProfile(raw: unknown): Profile {
  const base = fresh()
  if (!raw || typeof raw !== 'object') return base
  const data = raw as Record<string, unknown>
  // Challenge camos are never in `owned`: they come from the challenges.
  const owned = Array.isArray(data.owned) ? data.owned.filter((id): id is string => typeof id === 'string' && !!cosmeticById(id) && !cosmeticById(id)!.challenge) : []
  const profile: Profile = { ...base, ink: number(data.ink, base.ink), games: number(data.games), bestRound: number(data.bestRound),
    opened: number(data.opened), owned: [...new Set([...STARTING_ITEMS, ...owned])], challenges: sanitizeChallenges(data.challenges) }
  const stored = number(data.version, 1)
  profile.challenges.account.bestRound = Math.max(profile.challenges.account.bestRound, profile.bestRound)
  if (stored < 2) for (const unlock of settle(profile.challenges)) profile.ink += unlock.ink ?? 0
  // The Career, records and Shop (version 3); an older profile starts them fresh.
  profile.prestige = Math.min(MAX_PRESTIGE, number(data.prestige))
  profile.xp = Math.min(number(data.xp), MAX_XP)
  profile.lifetimeXp = Math.max(number(data.lifetimeXp), profile.xp)
  profile.peakLevel = Math.max(1, Math.min(MAX_LEVEL, Math.max(number(data.peakLevel, 1), levelOf(profile.xp).level, profile.prestige > 0 ? MAX_LEVEL : 1)))
  profile.records = sanitizeRecords(data.records)
  profile.purchases = number(data.purchases)
  profile.rewards = Array.isArray(data.rewards) ? data.rewards.slice(0, 10).flatMap(r => r && typeof r === 'object' && typeof (r as Record<string, unknown>).reason === 'string'
    ? [{ reason: String((r as Record<string, unknown>).reason).slice(0, 60), ink: number((r as Record<string, unknown>).ink), xp: number((r as Record<string, unknown>).xp), at: number((r as Record<string, unknown>).at) }] : []) : []
  // Everything a level or a finished challenge unlocks is owned, even if storage lost it.
  for (const unlock of unlockedBy(profile.peakLevel)) if (unlock.kind === 'item' && !profile.owned.includes(unlock.item)) profile.owned.push(unlock.item)
  for (const challenge of ACCOUNT_CHALLENGES) if (challenge.reward && profile.challenges.done.includes(`account:${challenge.id}`) && !profile.owned.includes(challenge.reward)) profile.owned.push(challenge.reward)
  const loadout = (data.loadout ?? {}) as Record<string, unknown>
  const pistol = pistolsFor(profile.peakLevel).find(p => p.id === loadout.pistol)
  profile.loadout = { pistol: pistol?.id ?? 'pistol', title: typeof loadout.title === 'string' && titlesFor(profile.peakLevel, profile.prestige).includes(loadout.title) ? loadout.title : null }
  const last = data.last as Record<string, unknown> | null
  if (last && typeof last === 'object') profile.last = { round: number(last.round), kills: number(last.kills), headshots: number(last.headshots), ink: number(last.ink) }
  const equipped = (data.equipped ?? {}) as Record<string, unknown>
  const has = (kind: string, id: string | null) => !!id && profile.owned.includes(`${kind}:${id}`)
  const watch = pick(WATCHES, equipped.watch), charm = pick(CHARMS, equipped.charm), knife = pick(KNIVES, equipped.knife), gloves = pick(GLOVES, equipped.gloves)
  profile.equipped.gloves = has('gloves', gloves) ? gloves : null
  profile.equipped.watch = has('watch', watch) ? watch : null
  profile.equipped.charm = has('charm', charm) ? charm : null
  profile.equipped.knife = knife && has('knife', knife) ? knife : 'combat'
  const camos = (equipped.camos ?? {}) as Record<string, unknown>
  for (const gun of GUNS) {
    const camo = pick(CAMOS, camos[gun])
    if (camo && ownsCamo(profile, camo, gun)) profile.equipped.camos[gun] = camo
  }
  return profile
}

let memory: Profile | null = null
const listeners = new Set<(profile: Profile) => void>()

export function loadProfile(): Profile {
  if (memory) return memory
  let raw: unknown = null
  try { const text = localStorage.getItem(KEY); raw = text ? JSON.parse(text) : null } catch { /* storage unavailable or corrupt */ }
  memory = sanitizeProfile(raw)
  return memory
}

function commit(profile: Profile) {
  memory = { ...profile, version: PROFILE_VERSION }
  try { localStorage.setItem(KEY, JSON.stringify(memory)) } catch { /* storage unavailable: the session keeps it in memory */ }
  for (const listener of listeners) listener(memory)
}

/** Replace the profile with a changed copy, save it and tell the listeners (progression.ts's way in). */
export function updateProfile(change: (profile: Profile) => Profile) { commit(change(loadProfile())) }

/** Called whenever Ink, ownership, equipment or the last game changes. Returns an unsubscribe function. */
export function onProfileChange(listener: (profile: Profile) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Game over: pay out Ink and remember the game. Returns the Ink earned. `bonus` is Ink already paid during
 * the game (challenge rewards), counted into the last game's total but not paid again.
 */
export function awardGame(result: GameResult, bonus = 0, multiplier = 1): number {
  const profile = loadProfile()
  const earned = Math.round(inkForGame(result) * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1))
  const round = number(result.round), kills = number(result.kills), headshots = number(result.headshots)
  commit({ ...profile, ink: profile.ink + earned, games: profile.games + 1, bestRound: Math.max(profile.bestRound, round),
    last: { round, kills, headshots, ink: earned + number(bonus) } })
  return earned
}

export const equippedCosmetics = (): EquippedCosmetics => {
  const { equipped } = loadProfile()
  return { ...equipped, camos: { ...equipped.camos } }
}

/**
 * Wear an owned item. Watches, charms and knives replace the one worn; a camo goes on one gun type.
 * Equipping the item already worn takes it off again (the knife always keeps a skin). False if not owned.
 */
export function toggleEquip(id: string, gun?: WeaponName): boolean {
  const profile = loadProfile(), entry = cosmeticById(id)
  // A camo goes on one gun; it may be a challenge camo that gun earned.
  if (entry?.kind === 'camo') return !!gun && toggleCamo(cosmeticKey(id) as CamoId, gun)
  if (!entry || !profile.owned.includes(id)) return false
  const key = cosmeticKey(id)
  const equipped: EquippedCosmetics = { ...profile.equipped, camos: { ...profile.equipped.camos } }
  if (entry.kind === 'watch') equipped.watch = equipped.watch === key ? null : key as WatchId
  if (entry.kind === 'charm') equipped.charm = equipped.charm === key ? null : key as CharmId
  if (entry.kind === 'knife') equipped.knife = key as KnifeId
  if (entry.kind === 'gloves') equipped.gloves = equipped.gloves === key ? null : key as GloveId
  return commitEquip(profile, equipped)
}

/** Wear a camo on a gun; a challenge camo only on a gun that earned it (Diamond on any once unlocked). */
export function toggleCamo(camo: CamoId, gun: WeaponName): boolean {
  const profile = loadProfile()
  if (!ownsCamo(profile, camo, gun)) return false
  const equipped: EquippedCosmetics = { ...profile.equipped, camos: { ...profile.equipped.camos } }
  equipped.camos[gun] = equipped.camos[gun] === camo ? null : camo
  return commitEquip(profile, equipped)
}

function commitEquip(profile: Profile, equipped: EquippedCosmetics) {
  commit({ ...profile, equipped })
  return true
}

// ---------------------------------------------------------------- cases

/**
 * One case holds every item except the starting knife. Weights are relative (they sum to 100.4): roughly
 * one case in sixty is legendary, which keeps a gold item worth showing off, and one in about 250 is
 * Mythic, the pink top of the ladder.
 */
export const CASE = { name: 'Ink Case', price: 250, duplicateRefund: 75 } as const
export const CASE_WEIGHTS: Record<Rarity, number> = { common: 50, uncommon: 28, rare: 14, epic: 6.4, legendary: 1.6, mythic: 0.4 }
export const casePool = () => CATALOGUE.filter(entry => !STARTING_ITEMS.includes(entry.id) && !entry.challenge && !entry.source)

/** Each rarity's share of a case (0..1), rarest last, for the odds line under the case. */
export function caseOdds() {
  const pool = casePool()
  const present = RARITIES.filter(rarity => pool.some(entry => entry.rarity === rarity))
  const total = present.reduce((sum, rarity) => sum + CASE_WEIGHTS[rarity], 0)
  return present.map(rarity => ({ rarity, share: CASE_WEIGHTS[rarity] / total }))
}

/** `random` returns [0, 1); pass a seeded one in checks. */
export function rollCaseItem(random: () => number = Math.random): CosmeticItem {
  const pool = casePool()
  const rarities = RARITIES.filter(rarity => pool.some(entry => entry.rarity === rarity))
  const total = rarities.reduce((sum, rarity) => sum + CASE_WEIGHTS[rarity], 0)
  let roll = random() * total, rarity = rarities[rarities.length - 1]
  for (const candidate of rarities) { roll -= CASE_WEIGHTS[candidate]; if (roll < 0) { rarity = candidate; break } }
  const options = pool.filter(entry => entry.rarity === rarity)
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))]
}

/** The strip the case spins: weighted filler with the won item placed where the strip stops. */
export const STRIP_LENGTH = 46, STRIP_WIN_INDEX = 38
export function caseStrip(winner: CosmeticItem, random: () => number = Math.random) {
  const strip = Array.from({ length: STRIP_LENGTH }, () => rollCaseItem(random))
  strip[STRIP_WIN_INDEX] = winner
  return strip
}

export type CaseOpening = { item: CosmeticItem; duplicate: boolean; refund: number; strip: CosmeticItem[]; winIndex: number }

/** Spend Ink on a case. Null when the player cannot afford one. The item is saved before the strip spins. */
export function openCase(random: () => number = Math.random): CaseOpening | null {
  return openCases(1, random)?.[0] ?? null
}

/**
 * Open `count` cases in one go, all or nothing: null (and nothing spent) unless the player can afford every
 * one. The Ink is spent and the items saved in a single commit. An item already owned, or won earlier in
 * the same batch, is a duplicate and refunds as usual.
 */
export function openCases(count: number, random: () => number = Math.random): CaseOpening[] | null {
  const profile = loadProfile()
  if (!Number.isInteger(count) || count < 1 || profile.ink < CASE.price * count) return null
  const owned = [...profile.owned]
  const openings = Array.from({ length: count }, (): CaseOpening => {
    const item = rollCaseItem(random)
    const duplicate = owned.includes(item.id)
    if (!duplicate) owned.push(item.id)
    return { item, duplicate, refund: duplicate ? CASE.duplicateRefund : 0, strip: caseStrip(item, random), winIndex: STRIP_WIN_INDEX }
  })
  const refunds = openings.reduce((sum, opening) => sum + opening.refund, 0)
  commit({ ...profile, ink: profile.ink - CASE.price * count + refunds, opened: profile.opened + count, owned })
  return openings
}

// ---------------------------------------------------------------- rewards, the Career and records

/**
 * Pay Ink for something done outside a Dead Ink game's own tally (a rescue mission, a challenge). `ink` is paid
 * as given, whole and never negative; work out difficulty and prestige with inkMultiplier first:
 *
 * ```ts
 * grantReward(Math.round(300 * inkMultiplier(difficulty)), 'Hostage rescued')
 * ```
 * Returns the Ink paid. Saved at once.
 */
export function grantReward(ink: number, reason: string): number {
  const amount = Math.max(0, Math.floor(Number.isFinite(ink) ? ink : 0))
  if (!amount) return 0
  updateProfile(p => ({ ...p, ink: p.ink + amount, rewards: [{ reason: String(reason).slice(0, 60), ink: amount, xp: 0, at: Date.now() }, ...p.rewards].slice(0, 10) }))
  return amount
}

export type XpGrant = { xp: number; before: number; after: number; levelUps: number; unlocks: LevelUnlock[]; refund: number }
const levelListeners = new Set<(grant: XpGrant) => void>()
/** Called after every level-up, with what it unlocked. Returns an unsubscribe function. */
export function onLevelUp(listener: (grant: XpGrant) => void) { levelListeners.add(listener); return () => { levelListeners.delete(listener) } }

/**
 * Earn XP toward the next level (both modes: kills, rounds, rescues). Crossing a level unlocks its items (one
 * already owned from a case pays back as a duplicate would), shows the level-up toast, and tells onLevelUp's
 * listeners. XP stops at level 55 until you prestige. `save` false keeps it in memory (every kill of a game);
 * the game saves at the next round.
 */
export function grantXp(amount: number, reason: string, save = true): XpGrant {
  const profile = loadProfile()
  const xp = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0))
  const before = levelOf(profile.xp).level
  const room = Math.max(0, MAX_XP - profile.xp)
  const gained = Math.min(xp, room)
  profile.xp += gained
  profile.lifetimeXp += gained
  const after = levelOf(profile.xp).level
  const unlocks = after > profile.peakLevel ? unlocksBetween(profile.peakLevel, after) : []
  let refund = 0
  for (const unlock of unlocks) if (unlock.kind === 'item') {
    if (profile.owned.includes(unlock.item)) refund += CASE.duplicateRefund
    else profile.owned.push(unlock.item)
  }
  profile.ink += refund
  profile.peakLevel = Math.max(profile.peakLevel, after)
  const grant: XpGrant = { xp: gained, before, after, levelUps: after - before, unlocks, refund }
  if (save || after > before) commit({ ...profile, rewards: gained && save ? [{ reason: String(reason).slice(0, 60), ink: 0, xp: gained, at: Date.now() }, ...profile.rewards].slice(0, 10) : profile.rewards })
  if (after > before) {
    showLevelUp(grant, loadProfile())
    for (const listener of levelListeners) listener(grant)
  }
  return grant
}
/** Take a prestige: level 1 again, everything kept, a badge, a title and Ink. False unless at level 55 below prestige 10. */
export function prestigeNow(): boolean {
  const profile = loadProfile()
  if (!canPrestige(profile.xp, profile.prestige)) return false
  const prestige = profile.prestige + 1
  commit({ ...profile, prestige, xp: 0, peakLevel: MAX_LEVEL, ink: profile.ink + PRESTIGE.ink,
    rewards: [{ reason: `Prestige ${prestige}`, ink: PRESTIGE.ink, xp: 0, at: Date.now() }, ...profile.rewards].slice(0, 10) })
  return true
}

/** Change the loadout: a starting pistol or calling card you have unlocked (null title shows none). False if locked. */
export function setLoadout(change: Partial<Profile['loadout']>): boolean {
  const profile = loadProfile()
  if (change.pistol && !pistolsFor(profile.peakLevel).some(p => p.id === change.pistol)) return false
  if (change.title && !titlesFor(profile.peakLevel, profile.prestige).includes(change.title)) return false
  commit({ ...profile, loadout: { ...profile.loadout, ...change } })
  return true
}
export const startingPistolOf = (profile: Pick<Profile, 'loadout' | 'peakLevel'> = loadProfile()): StartingPistol =>
  STARTING_PISTOLS.find(p => p.id === profile.loadout.pistol && p.level <= profile.peakLevel)?.id ?? 'pistol'

/** Put a finished game into the high scores; returns every top-ten place it took. Saved at once. */
export function submitRecords(key: string, run: RecordRun): Placing[] {
  const profile = loadProfile()
  const { table, placed } = submitRun(profile.records, key, run)
  commit({ ...profile, records: table })
  return placed
}

/** Checks only: forget the cached profile so the next load reads storage again. */
export function resetProfileCache() { memory = null }
