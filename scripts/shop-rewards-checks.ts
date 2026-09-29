import assert from 'node:assert/strict'
import { cosmeticById } from '../src/game/zombies/cosmetics/catalogue'
import { DIFFICULTY_INK, awardGame, casePool, difficultyMultiplier, grantReward, grantXp, inkMultiplier, loadProfile, prestigeNow, resetProfileCache, updateProfile } from '../src/game/zombies/cosmetics/profile'
import { MAX_XP } from '../src/game/zombies/cosmetics/career'
import { DAILY_OFFERS, FEATURED_OFF, PERMANENT_OFFERS, SHOP_PRICES, buyOffer, dailyOffers, msUntilRefresh, permanentOffers, shopDay } from '../src/game/zombies/cosmetics/shop'
import { beginGame, recordGameEnd } from '../src/game/zombies/cosmetics/progression'
import { DIFFICULTY } from '../src/game/zombies/rules'

/** The Shop (shop.ts), rewards and the Ink multipliers (profile.ts). */
let passed = 0
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`) }
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }) })
const fresh = () => { store.clear(); resetProfileCache() }
const day = new Date(Date.UTC(2026, 8, 29, 15, 30))

test('A day has six offers, the same all day, a new set the next; the first is featured and cheaper', () => {
  const offers = dailyOffers(shopDay(day))
  assert.equal(offers.length, DAILY_OFFERS)
  assert.deepEqual(offers.map(o => o.item.id), dailyOffers(shopDay(new Date(Date.UTC(2026, 8, 29, 23, 59)))).map(o => o.item.id), 'the same all day')
  const tomorrow = dailyOffers(shopDay(new Date(Date.UTC(2026, 8, 30, 0, 1))))
  assert.notDeepEqual(offers.map(o => o.item.id), tomorrow.map(o => o.item.id), 'a new set the next day')
  assert.equal(new Set(offers.map(o => o.item.id)).size, offers.length, 'never twice the same')
  assert(offers[0].featured && ['epic', 'legendary', 'mythic'].includes(offers[0].item.rarity))
  assert(offers[0].price < SHOP_PRICES[offers[0].item.rarity] && offers[0].price >= SHOP_PRICES[offers[0].item.rarity] * (1 - FEATURED_OFF) - 50)
  const pool = casePool().map(item => item.id)
  for (const offer of offers) assert(pool.includes(offer.item.id), `${offer.item.id} is a case item`)
  // Over a month every kind turns up, and most offers are affordable ones.
  const month = Array.from({ length: 30 }, (_, i) => dailyOffers(shopDay(new Date(Date.UTC(2026, 9, i + 1))))).flat()
  for (const kind of ['watch', 'charm', 'camo', 'knife']) assert(month.some(o => o.item.kind === kind), `${kind} on offer this month`)
  assert(month.filter(o => !o.featured && (o.item.rarity === 'common' || o.item.rarity === 'uncommon' || o.item.rarity === 'rare')).length > month.length * 0.45)
  assert(msUntilRefresh(day) === (8 * 60 + 30) * 60 * 1000)
})

test('The permanent shelf sells the shop-only items, never found in cases', () => {
  assert.deepEqual(permanentOffers().map(o => o.item.id), [...PERMANENT_OFFERS])
  for (const id of PERMANENT_OFFERS) {
    assert.equal(cosmeticById(id)!.source, 'shop')
    assert(!casePool().some(item => item.id === id), `${id} is not in cases`)
  }
})

test('Buying spends the Ink and the item is yours; short of Ink, owned or not on offer, nothing happens', () => {
  fresh()
  const offer = dailyOffers(shopDay(day)).find(o => !o.featured)!
  const start = loadProfile().ink
  assert.deepEqual(buyOffer(offer.item.id, day), { ok: false, reason: 'ink' })
  assert.equal(loadProfile().ink, start)
  updateProfile(p => ({ ...p, ink: 20000 }))
  const bought = buyOffer(offer.item.id, day)
  assert(bought.ok)
  assert.equal(loadProfile().ink, 20000 - offer.price)
  assert(loadProfile().owned.includes(offer.item.id))
  assert.equal(loadProfile().purchases, 1)
  assert.deepEqual(buyOffer(offer.item.id, day), { ok: false, reason: 'owned' })
  const notToday = casePool().find(item => !dailyOffers(shopDay(day)).some(o => o.item.id === item.id))!
  assert.deepEqual(buyOffer(notToday.id, day), { ok: false, reason: 'not-offered' })
  assert.deepEqual(buyOffer('camo:diamond', day), { ok: false, reason: 'not-offered' }, 'challenge camos are never for sale')
  assert(buyOffer('camo:love-letter', day).ok, 'the permanent shelf sells any day')
  resetProfileCache()
  assert(loadProfile().owned.includes('camo:love-letter'), 'saved')
})

test('Harder games pay more Ink, and so does every prestige', () => {
  assert.equal(difficultyMultiplier('normal'), 1)
  assert.equal(difficultyMultiplier('casual'), 0.75)
  assert.equal(difficultyMultiplier('hardcore'), 1.35)
  assert.equal(difficultyMultiplier('realistic'), 1.75)
  assert.equal(difficultyMultiplier('hard'), 1.35, 'rescue names work too')
  assert.equal(difficultyMultiplier('nonsense'), 1)
  assert.equal(difficultyMultiplier(undefined), 1)
  for (const key of Object.keys(DIFFICULTY)) assert(key in DIFFICULTY_INK, `${key} has a multiplier`)
  const order = Object.keys(DIFFICULTY).map(key => difficultyMultiplier(key))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'harder pays more')
  fresh()
  assert.equal(inkMultiplier('hardcore'), 1.35)
  grantXp(MAX_XP, 'max'); assert(prestigeNow())
  assert.equal(Math.round(inkMultiplier('hardcore') * 10000) / 10000, Math.round(1.35 * 1.05 * 10000) / 10000)
})

test('A game on Realistic pays 1.75 times, shown as its own line', () => {
  fresh()
  beginGame()
  const report = recordGameEnd({ round: 10, kills: 100, headshots: 20, difficulty: 'realistic' })
  const base = 10 * 10 + 100 + 20 * 2
  assert.equal(report.inkTotal, Math.round(base * 1.75))
  assert.equal(report.inkLines.find(line => line.label === 'Difficulty and prestige')?.ink, Math.round(base * 1.75) - base)
  assert.equal(awardGame({ round: 1, kills: 0, headshots: 0 }, 0, 2), 20)
})

test('grantReward pays whole Ink for a reason, remembers it, and refuses nonsense', () => {
  fresh()
  const start = loadProfile().ink
  assert.equal(grantReward(300, 'Hostage rescued'), 300)
  assert.equal(grantReward(Math.round(300 * inkMultiplier('hard')), 'Hostage rescued on Hard'), 405)
  assert.equal(grantReward(-50, 'bad'), 0)
  assert.equal(grantReward(NaN, 'bad'), 0)
  assert.equal(grantReward(12.9, 'fraction'), 12)
  assert.equal(loadProfile().ink, start + 300 + 405 + 12)
  assert.equal(loadProfile().rewards[0].reason, 'fraction')
  assert.equal(loadProfile().rewards[2].reason, 'Hostage rescued')
  resetProfileCache()
  assert.equal(loadProfile().ink, start + 717, 'saved at once')
})

console.log(`shop and rewards checks passed (${passed})`)
