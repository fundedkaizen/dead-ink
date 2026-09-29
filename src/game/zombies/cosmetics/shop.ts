import type { Rarity } from '../../loot'
import { CATALOGUE, cosmeticById, type CosmeticItem } from './catalogue'
import { casePool, loadProfile, updateProfile } from './profile'

/**
 * The Shop: buy a cosmetic outright for Ink, next to the Armory's cases. Six offers a day, the same for every
 * player on the same day (a new set at midnight UTC), the first a featured item at a discount; and a
 * permanent shelf of items sold only here.
 *
 * Prices go by rarity. A case is 250 Ink for a random item; buying the one you want costs more.
 */
export const SHOP_PRICES: Record<Rarity, number> = { common: 300, uncommon: 600, rare: 1200, epic: 2400, legendary: 4500, mythic: 9000 }
/** How often each rarity is a daily offer (after the featured one), relative. */
const OFFER_WEIGHTS: Record<Rarity, number> = { common: 30, uncommon: 26, rare: 20, epic: 12, legendary: 6, mythic: 2 }
/** The featured offer's discount. */
export const FEATURED_OFF = 0.25
export const DAILY_OFFERS = 6
/** Items only the Shop sells, always on its shelf. */
export const PERMANENT_OFFERS = ['camo:love-letter'] as const

/** Today's shop day, "2026-09-29" (UTC). */
export const shopDay = (date = new Date()) => date.toISOString().slice(0, 10)
/** Milliseconds until the offers change. */
export function msUntilRefresh(date = new Date()) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
  return next.getTime() - date.getTime()
}

/** A small seeded generator from a day's string, so a day's offers are the same everywhere. */
function dayRandom(day: string) {
  let seed = 2166136261
  for (const c of day) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
}

export type Offer = { item: CosmeticItem; price: number; featured: boolean; permanent: boolean }

/**
 * The day's offers: one featured item (epic or better) at a discount, then five others, never twice the same,
 * spread over the kinds of cosmetic. Drawn from what cases hold, so every case item turns up in time.
 */
export function dailyOffers(day: string): Offer[] {
  const random = dayRandom(day), pool = [...casePool()]
  // Cheaper rarities turn up more often, as in a case, so most days have something to buy with a game's Ink.
  const take = (filter: (item: CosmeticItem) => boolean) => {
    const options = pool.filter(filter)
    if (!options.length) return null
    const total = options.reduce((sum, item) => sum + OFFER_WEIGHTS[item.rarity], 0)
    let roll = random() * total, item = options[options.length - 1]
    for (const option of options) { roll -= OFFER_WEIGHTS[option.rarity]; if (roll < 0) { item = option; break } }
    pool.splice(pool.indexOf(item), 1)
    return item
  }
  const offers: Offer[] = []
  const featured = take(item => item.rarity === 'epic' || item.rarity === 'legendary' || item.rarity === 'mythic')
  if (featured) offers.push({ item: featured, price: Math.round(SHOP_PRICES[featured.rarity] * (1 - FEATURED_OFF) / 50) * 50, featured: true, permanent: false })
  const kinds = ['camo', 'charm', 'watch', 'knife'] as const
  for (let i = 0; offers.length < DAILY_OFFERS && i < 20; i++) {
    const kind = kinds[i % kinds.length]
    const item = take(entry => entry.kind === kind) ?? take(() => true)
    if (!item) break
    offers.push({ item, price: SHOP_PRICES[item.rarity], featured: false, permanent: false })
  }
  return offers
}

export const permanentOffers = (): Offer[] => PERMANENT_OFFERS.map(id => cosmeticById(id)!).filter(Boolean)
  .map(item => ({ item, price: SHOP_PRICES[item.rarity], featured: false, permanent: true }))

export type Purchase = { ok: true; item: CosmeticItem; price: number } | { ok: false; reason: 'not-offered' | 'owned' | 'ink' }

/** Buy an item on offer today (or on the permanent shelf): the Ink goes, the item is yours. */
export function buyOffer(id: string, date = new Date()): Purchase {
  const offer = [...dailyOffers(shopDay(date)), ...permanentOffers()].find(o => o.item.id === id)
  if (!offer) return { ok: false, reason: 'not-offered' }
  const profile = loadProfile()
  if (profile.owned.includes(id)) return { ok: false, reason: 'owned' }
  if (profile.ink < offer.price) return { ok: false, reason: 'ink' }
  updateProfile(p => ({ ...p, ink: p.ink - offer.price, owned: [...p.owned, id], purchases: p.purchases + 1 }))
  return { ok: true, item: offer.item, price: offer.price }
}

/** Every item the shop can ever sell (checks). */
export const shopCatalogue = () => CATALOGUE.filter(item => casePool().includes(item) || (PERMANENT_OFFERS as readonly string[]).includes(item.id))
