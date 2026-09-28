import assert from 'node:assert/strict'
import { LEVEL_UNLOCKS, MAX_LEVEL, MAX_PRESTIGE, MAX_XP, PRESTIGE, XP, canPrestige, levelOf, nextUnlock, pistolsFor, prestigeBadge, prestigeMultiplier, rankBadge, rankName,
  titlesFor, unlocksBetween, xpForLevel, xpForRound, xpToNext } from '../src/game/zombies/cosmetics/career'
import { CASE, grantXp, loadProfile, onLevelUp, prestigeNow, resetProfileCache, setLoadout, startingPistolOf, updateProfile } from '../src/game/zombies/cosmetics/profile'
import { beginGame, recordGameEnd, recordKill, recordRound } from '../src/game/zombies/cosmetics/progression'
import { startingPistol } from '../src/game/zombies/economy'

/** The Career (career.ts, profile.ts): XP and level maths, ranks, unlocks, prestige, and XP from a game. */
let passed = 0
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`) }
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }) })
const fresh = () => { store.clear(); resetProfileCache() }

test('Levels run 1 to 55; each takes 90 XP more than the last, 161,190 XP in all', () => {
  assert.equal(xpToNext(1), 600)
  assert.equal(xpToNext(2), 690)
  assert.equal(xpToNext(54), 600 + 90 * 53)
  assert.equal(xpForLevel(1), 0)
  assert.equal(xpForLevel(2), 600)
  assert.equal(xpForLevel(3), 1290)
  assert.equal(MAX_XP, 161190)
  assert.deepEqual(levelOf(0), { level: 1, into: 0, needed: 600, fraction: 0, max: false })
  assert.equal(levelOf(599).level, 1)
  assert.equal(levelOf(600).level, 2)
  assert.equal(levelOf(1289).level, 2)
  assert.equal(levelOf(1290).level, 3)
  assert.equal(levelOf(MAX_XP - 1).level, 54)
  assert.equal(levelOf(MAX_XP).level, MAX_LEVEL)
  assert.equal(levelOf(MAX_XP).max, true)
  assert.equal(levelOf(10 ** 9).level, MAX_LEVEL)
  assert.equal(levelOf(-50).level, 1)
  assert.equal(levelOf(NaN).level, 1)
  // Every level's XP band is continuous: the XP at the start of each level is that level.
  for (let level = 1; level <= MAX_LEVEL; level++) assert.equal(levelOf(xpForLevel(level)).level, level)
})

test('Ranks: eleven names of five levels, numbered I to V', () => {
  assert.equal(rankName(1), 'Scribbler I')
  assert.equal(rankName(5), 'Scribbler V')
  assert.equal(rankName(6), 'Doodler I')
  assert.equal(rankName(13), 'Sketcher III')
  assert.equal(rankName(55), 'Master Inker V')
  assert.equal(new Set(Array.from({ length: 55 }, (_, i) => rankName(i + 1))).size, 55, 'every level has its own name')
  assert(rankBadge(1).includes('<svg') && rankBadge(55).includes('Master Inker V'))
  assert.equal(prestigeBadge(0), '')
  assert(prestigeBadge(10).includes('Prestige 10'))
})

test('Unlocks: starting pistols, charms, camos, gloves and calling cards, in level order', () => {
  const kinds = new Set(LEVEL_UNLOCKS.map(u => u.kind === 'item' ? u.item.split(':')[0] : u.kind))
  for (const kind of ['pistol', 'charm', 'camo', 'gloves', 'title']) assert(kinds.has(kind), `levels unlock a ${kind}`)
  assert.deepEqual(LEVEL_UNLOCKS.map(u => u.level), [...LEVEL_UNLOCKS.map(u => u.level)].sort((a, b) => a - b))
  assert.deepEqual(unlocksBetween(9, 10).map(u => u.kind), ['pistol'])
  assert.equal(nextUnlock(1)?.level, 2)
  assert.equal(nextUnlock(55), null)
  assert.deepEqual(pistolsFor(1).map(p => p.id), ['pistol'])
  assert.deepEqual(pistolsFor(30).map(p => p.id), ['pistol', 'burst', 'magnum'])
  assert(titlesFor(8, 0).includes('Page Turner') && !titlesFor(7, 0).includes('Page Turner'))
  assert(titlesFor(1, 2).includes('Second Draft') && titlesFor(1, 2).includes('Third Coat'))
  assert.equal(startingPistol('burst').name, 'burst')
  assert.equal(startingPistol('magnum').reserve, 12)
})

test('XP crosses levels: the toast listeners hear it, the unlocked items are owned, one already owned pays back', () => {
  fresh()
  const heard: number[] = []
  const stop = onLevelUp(grant => heard.push(grant.after))
  updateProfile(p => ({ ...p, owned: [...p.owned, 'charm:dice'] }))
  const ink = loadProfile().ink
  const grant = grantXp(xpForLevel(7), 'test')
  stop()
  assert.equal(grant.before, 1)
  assert.equal(grant.after, 7)
  assert.equal(grant.levelUps, 6)
  assert.deepEqual(heard, [7])
  assert(loadProfile().owned.includes('gloves:work'), 'level 4 gloves')
  assert.equal(loadProfile().ink, ink + CASE.duplicateRefund, 'the level 6 charm was already owned: refunded')
  assert.equal(loadProfile().peakLevel, 7)
  resetProfileCache()
  assert.equal(loadProfile().xp, xpForLevel(7), 'saved')
})

test('XP stops at level 55 until a prestige; prestige resets the level, keeps unlocks and pays', () => {
  fresh()
  assert.equal(canPrestige(loadProfile().xp, 0), false)
  assert.equal(prestigeNow(), false, 'not before level 55')
  grantXp(MAX_XP + 5000, 'lots')
  assert.equal(loadProfile().xp, MAX_XP, 'no XP past level 55')
  assert.equal(levelOf(loadProfile().xp).level, 55)
  const owned = [...loadProfile().owned], ink = loadProfile().ink
  assert(owned.includes('gloves:midas'))
  assert(prestigeNow())
  const after = loadProfile()
  assert.equal(after.prestige, 1)
  assert.equal(after.xp, 0)
  assert.equal(levelOf(after.xp).level, 1)
  assert.equal(after.ink, ink + PRESTIGE.ink)
  assert.deepEqual(after.owned, owned, 'unlocks kept')
  assert.equal(after.peakLevel, 55, 'level unlocks stay open')
  assert(setLoadout({ pistol: 'magnum' }), 'the Magnum is still yours to start with')
  assert.equal(startingPistolOf(), 'magnum')
  assert(setLoadout({ title: 'Second Draft' }))
  assert.equal(prestigeMultiplier(after.prestige), 1.05)
  // Up to prestige 10, not past it.
  for (let p = 2; p <= MAX_PRESTIGE; p++) { grantXp(MAX_XP, 'again'); assert(prestigeNow(), `prestige ${p}`) }
  grantXp(MAX_XP, 'again')
  assert.equal(prestigeNow(), false, 'no prestige 11')
  assert.equal(loadProfile().prestige, MAX_PRESTIGE)
  assert.equal(prestigeMultiplier(MAX_PRESTIGE), 1.5)
  assert(titlesFor(55, 10).includes('Ink Immortal'))
})

test('Locked loadout choices are refused; a stored locked choice falls back', () => {
  fresh()
  assert.equal(setLoadout({ pistol: 'magnum' }), false)
  assert.equal(setLoadout({ title: 'Master Inker' }), false)
  store.set('dead-ink-profile', JSON.stringify({ version: 3, xp: 0, loadout: { pistol: 'magnum', title: 'Master Inker' } }))
  resetProfileCache()
  assert.equal(loadProfile().loadout.pistol, 'pistol')
  assert.equal(loadProfile().loadout.title, null)
  assert.equal(startingPistolOf(), 'pistol')
})

test('A game pays XP: kills, headshots, rounds and the end; the report shows the level before and after', () => {
  fresh()
  beginGame()
  for (let i = 0; i < 40; i++) recordKill({ weapon: 'ak', headshot: i < 10, round: 3 })
  recordRound(2, 60); recordRound(3, 120)
  const report = recordGameEnd({ round: 3, kills: 40, headshots: 10, elapsed: 150 })
  const expected = 40 * XP.kill + 10 * XP.headshot + xpForRound(1) + xpForRound(2) + XP.gameEnd
  assert.equal(report.xp!.earned, expected)
  assert.equal(loadProfile().xp, expected)
  assert.equal(report.xp!.before.level, 1)
  assert.equal(report.xp!.after.level, levelOf(expected).level)
})

console.log(`career checks passed (${passed})`)
