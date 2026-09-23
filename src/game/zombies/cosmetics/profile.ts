import { RARITIES, type Rarity } from '../../loot'
import type { WeaponName } from '../../types'
import { CAMOS, CATALOGUE, CHARMS, KNIVES, NO_COSMETICS, STARTING_ITEMS, WATCHES, cosmeticById, cosmeticKey,
  type CamoId, type CharmId, type CosmeticItem, type EquippedCosmetics, type KnifeId, type WatchId } from './catalogue'

/**
 * The player's meta-progression, kept in this browser: Ink (the currency), what they own, what they
 * wear, and their last and best games. Storage can be missing, full or blocked (private windows,
 * sandboxed previews), so every access is guarded and the profile still works for the session in memory.
 */
export type GameResult = { round: number; kills: number; headshots: number }
export type Profile = {
  ink: number; owned: string[]; equipped: EquippedCosmetics
  games: number; bestRound: number; opened: number
  last: (GameResult & { ink: number }) | null
}

const KEY = 'dead-ink-profile'
/** Enough for one case, so a new player sees the Armory work before earning anything. */
const WELCOME_INK = 250
const GUNS: WeaponName[] = ['pistol', 'smg', 'ak', 'shotgun', 'sniper']

/** Ink per game: rounds are the achievement, kills and headshots the texture. */
export const inkForGame = ({ round, kills, headshots }: GameResult) =>
  Math.max(0, Math.floor(round) * 10 + Math.floor(kills) + Math.floor(headshots) * 2)

const fresh = (): Profile => ({ ink: WELCOME_INK, owned: [...STARTING_ITEMS], equipped: { ...NO_COSMETICS, camos: {} },
  games: 0, bestRound: 0, opened: 0, last: null })

const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
const pick = <T extends string>(list: readonly T[], value: unknown): T | null => list.includes(value as T) ? value as T : null

/** Stored data is untrusted: anything unknown or malformed falls back to the fresh value. */
function sanitize(raw: unknown): Profile {
  const base = fresh()
  if (!raw || typeof raw !== 'object') return base
  const data = raw as Record<string, unknown>
  const owned = Array.isArray(data.owned) ? data.owned.filter((id): id is string => typeof id === 'string' && !!cosmeticById(id)) : []
  const profile: Profile = { ...base, ink: number(data.ink, base.ink), games: number(data.games), bestRound: number(data.bestRound),
    opened: number(data.opened), owned: [...new Set([...STARTING_ITEMS, ...owned])] }
  const last = data.last as Record<string, unknown> | null
  if (last && typeof last === 'object') profile.last = { round: number(last.round), kills: number(last.kills), headshots: number(last.headshots), ink: number(last.ink) }
  const equipped = (data.equipped ?? {}) as Record<string, unknown>
  const has = (kind: string, id: string | null) => !!id && profile.owned.includes(`${kind}:${id}`)
  const watch = pick(WATCHES, equipped.watch), charm = pick(CHARMS, equipped.charm), knife = pick(KNIVES, equipped.knife)
  profile.equipped.watch = has('watch', watch) ? watch : null
  profile.equipped.charm = has('charm', charm) ? charm : null
  profile.equipped.knife = knife && has('knife', knife) ? knife : 'combat'
  const camos = (equipped.camos ?? {}) as Record<string, unknown>
  for (const gun of GUNS) {
    const camo = pick(CAMOS, camos[gun])
    if (camo && has('camo', camo)) profile.equipped.camos[gun] = camo
  }
  return profile
}

let memory: Profile | null = null
const listeners = new Set<(profile: Profile) => void>()

export function loadProfile(): Profile {
  if (memory) return memory
  let raw: unknown = null
  try { const text = localStorage.getItem(KEY); raw = text ? JSON.parse(text) : null } catch { /* storage unavailable or corrupt */ }
  memory = sanitize(raw)
  return memory
}

function commit(profile: Profile) {
  memory = profile
  try { localStorage.setItem(KEY, JSON.stringify(profile)) } catch { /* storage unavailable: the session keeps it in memory */ }
  for (const listener of listeners) listener(profile)
}

/** Called whenever Ink, ownership, equipment or the last game changes. Returns an unsubscribe function. */
export function onProfileChange(listener: (profile: Profile) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Game over: pay out Ink and remember the game. Returns the Ink earned. */
export function awardGame(result: GameResult): number {
  const profile = loadProfile()
  const earned = inkForGame(result)
  const round = number(result.round), kills = number(result.kills), headshots = number(result.headshots)
  commit({ ...profile, ink: profile.ink + earned, games: profile.games + 1, bestRound: Math.max(profile.bestRound, round),
    last: { round, kills, headshots, ink: earned } })
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
  if (!entry || !profile.owned.includes(id)) return false
  const key = cosmeticKey(id)
  const equipped: EquippedCosmetics = { ...profile.equipped, camos: { ...profile.equipped.camos } }
  if (entry.kind === 'watch') equipped.watch = equipped.watch === key ? null : key as WatchId
  if (entry.kind === 'charm') equipped.charm = equipped.charm === key ? null : key as CharmId
  if (entry.kind === 'knife') equipped.knife = key as KnifeId
  if (entry.kind === 'camo') {
    if (!gun) return false
    equipped.camos[gun] = equipped.camos[gun] === key ? null : key as CamoId
  }
  commit({ ...profile, equipped })
  return true
}

// ---------------------------------------------------------------- cases

/**
 * One case holds every item except the starting knife. Weights are relative: roughly one case in sixty
 * is legendary, which keeps a gold item worth showing off.
 */
export const CASE = { name: 'Ink Case', price: 250, duplicateRefund: 75 } as const
export const CASE_WEIGHTS: Record<Rarity, number> = { common: 50, uncommon: 28, rare: 14, epic: 6.4, legendary: 1.6 }
export const casePool = () => CATALOGUE.filter(entry => !STARTING_ITEMS.includes(entry.id))

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
  const profile = loadProfile()
  if (profile.ink < CASE.price) return null
  const item = rollCaseItem(random)
  const duplicate = profile.owned.includes(item.id)
  const refund = duplicate ? CASE.duplicateRefund : 0
  commit({ ...profile, ink: profile.ink - CASE.price + refund, opened: profile.opened + 1,
    owned: duplicate ? profile.owned : [...profile.owned, item.id] })
  return { item, duplicate, refund, strip: caseStrip(item, random), winIndex: STRIP_WIN_INDEX }
}

/** Checks only: forget the cached profile so the next load reads storage again. */
export function resetProfileCache() { memory = null }
