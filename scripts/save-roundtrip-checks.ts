import assert from 'node:assert/strict'
import { exportSave, importSave } from '../src/game/save-transfer'
import { MAX_XP } from '../src/game/zombies/cosmetics/career'
import { grantReward, grantXp, loadProfile, prestigeNow, resetProfileCache, setLoadout, toggleEquip, updateProfile } from '../src/game/zombies/cosmetics/profile'
import { beginGame, recordGameEnd, recordRound } from '../src/game/zombies/cosmetics/progression'
import { buyOffer } from '../src/game/zombies/cosmetics/shop'

/**
 * A save code carries everything this work added to the profile: the Career (XP, prestige, peak level), the
 * loadout, camos, items bought in the Shop, rewards and the high scores, and a new browser loads it exactly.
 */
const stores = { from: new Map<string, string>(), to: new Map<string, string>() }
let current = stores.from
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ({ getItem: (k: string) => current.get(k) ?? null, setItem: (k: string, v: string) => { current.set(k, v) } }) })
const asStore = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } })

resetProfileCache()
grantXp(MAX_XP, 'play'); prestigeNow(); grantXp(20000, 'more')
setLoadout({ pistol: 'magnum', title: 'Second Draft' })
updateProfile(p => ({ ...p, ink: 50000 }))
assert(buyOffer('camo:love-letter').ok)
toggleEquip('camo:love-letter', 'pistol')
grantReward(321, 'Hostage rescued')
beginGame(); recordRound(10, 400); recordGameEnd({ round: 12, kills: 222, headshots: 40, difficulty: 'hardcore', mode: 'coop' })
// As this browser has it saved (a reload settles the account challenges' best round from the game's).
resetProfileCache()
const before = JSON.parse(JSON.stringify(loadProfile()))
assert.equal(before.prestige, 1)
assert(before.xp > 0 && before.records['compound|coop|hardcore'].round10[0].value === 400)

const code = exportSave(asStore(stores.from))
current = stores.to
resetProfileCache()
assert.equal(loadProfile().prestige, 0, 'a new browser starts empty')
assert(importSave(code, asStore(stores.to)))
resetProfileCache()
const after = JSON.parse(JSON.stringify(loadProfile()))
assert.deepEqual(after, before, 'the whole profile arrives exactly')
assert.equal(after.equipped.camos.pistol, 'love-letter')
assert.equal(after.loadout.pistol, 'magnum')
assert.equal(after.loadout.title, 'Second Draft')
assert.equal(after.peakLevel, 55)
assert.equal(after.rewards.find((r: { reason: string }) => r.reason === 'Hostage rescued').ink, 321)
console.log('PASS a save code carries the Career, loadout, camos, Shop items, rewards and records to a new browser, exactly')
