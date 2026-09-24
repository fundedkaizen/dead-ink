import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { FirstPersonWeapons } from '../src/game/weapons'
import { CATALOGUE, CHALLENGE_CAMOS, cosmeticKey } from '../src/game/zombies/cosmetics/catalogue'
import { buildCharm, camoMaterial } from '../src/game/zombies/cosmetics/models'
import { metal } from '../src/lab/weapons/models/common'
import { CASE, STRIP_WIN_INDEX, awardGame, casePool, inkForGame, loadProfile, openCase, resetProfileCache, rollCaseItem, toggleEquip } from '../src/game/zombies/cosmetics/profile'
import { CHALLENGE_WEAPONS, WEAPON_TIERS, challengeCamoUnlocked, countKill, diamondUnlocked, freshChallenges, masteredCount, sanitizeChallenges, settle, type KillRecord } from '../src/game/zombies/cosmetics/challenges'
import { beginGame, lastReport, recordGameEnd, recordKill, recordRound } from '../src/game/zombies/cosmetics/progression'
import type { WeaponFrame, WeaponItem } from '../src/game/types'
import { readFileSync } from 'node:fs'
import { RARITIES } from '../src/game/loot'
import { getSettings, resetSettingsCache, setSettings, volumeFor } from '../src/game/settings'
import { REEL_WINS, playReelTick, playReelWin, synthOutput } from '../src/game/ui-slot-sound'

let failures = 0
function test(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}`, error) }
}
function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed / 2 ** 32 }
}

// Storage is a stub that can be switched off, as a private window would.
const store = new Map<string, string>()
let storageWorks = true
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
  if (!storageWorks) throw new Error('storage blocked')
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
} })

test('Ink per game is rounds x10 + kills + headshots x2, saved and remembered', () => {
  store.clear(); resetProfileCache()
  assert.equal(inkForGame({ round: 7, kills: 60, headshots: 12 }), 154)
  const start = loadProfile().ink
  assert.equal(awardGame({ round: 7, kills: 60, headshots: 12 }), 154)
  resetProfileCache()
  const profile = loadProfile()
  assert.equal(profile.ink, start + 154)
  assert.deepEqual(profile.last, { round: 7, kills: 60, headshots: 12, ink: 154 })
  assert.equal(profile.bestRound, 7)
  assert.equal(profile.games, 1)
})

test('Without storage the profile still works in memory', () => {
  storageWorks = false; resetProfileCache()
  try {
    const ink = loadProfile().ink
    assert.equal(awardGame({ round: 3, kills: 10, headshots: 0 }), 40)
    assert.equal(loadProfile().ink, ink + 40)
  } finally { storageWorks = true }
})

test('Corrupt or hostile storage falls back to a clean profile', () => {
  store.set('dead-ink-profile', '{"ink":-5,"owned":["knife:karambit","nonsense"],"equipped":{"knife":"karambit","watch":"diamond"}}')
  resetProfileCache()
  const profile = loadProfile()
  assert(profile.ink >= 0)
  assert(profile.owned.includes('knife:combat') && profile.owned.includes('knife:karambit') && !profile.owned.includes('nonsense'))
  assert.equal(profile.equipped.knife, 'karambit')
  assert.equal(profile.equipped.watch, null, 'an unowned watch cannot be worn')
  store.set('dead-ink-profile', 'not json'); resetProfileCache()
  assert.equal(loadProfile().equipped.knife, 'combat')
})

test('Cases cost Ink, pay a refund on duplicates, and legendaries are rare', () => {
  store.clear(); resetProfileCache()
  awardGame({ round: 200, kills: 0, headshots: 0 })
  const random = seeded(7)
  const counts: Record<string, number> = {}
  for (let i = 0; i < 20000; i++) { const item = rollCaseItem(random); counts[item.rarity] = (counts[item.rarity] ?? 0) + 1 }
  assert(counts.legendary / 20000 < 0.03 && counts.legendary > 0, `legendary share ${counts.legendary / 20000}`)
  assert(counts.common > counts.uncommon && counts.uncommon > counts.rare && counts.rare > counts.epic && counts.epic > counts.legendary)
  const before = loadProfile().ink
  const opening = openCase(seeded(3))!
  assert.equal(opening.strip[STRIP_WIN_INDEX].id, opening.item.id, 'the strip stops on the won item')
  assert.equal(loadProfile().ink, before - CASE.price)
  assert(loadProfile().owned.includes(opening.item.id))
  // Open until a duplicate turns up; each costs the price and a duplicate gives the refund back.
  let duplicate = null
  for (let i = 0; i < 60 && !duplicate; i++) {
    const ink = loadProfile().ink, next = openCase(seeded(100 + i))!
    if (next.duplicate) { duplicate = next; assert.equal(loadProfile().ink, ink - CASE.price + CASE.duplicateRefund) }
  }
  assert(duplicate, 'duplicates happen')
  store.clear(); resetProfileCache()
  const broke = loadProfile()
  broke.ink = 10
  assert.equal(openCase(), null, 'no case without the Ink')
})

test('Equipping needs ownership; camos are per gun and toggle off', () => {
  store.clear(); resetProfileCache()
  assert(!toggleEquip('watch:diamond'))
  const profile = loadProfile()
  profile.owned.push('watch:diamond', 'camo:gold')
  assert(toggleEquip('watch:diamond'))
  assert.equal(loadProfile().equipped.watch, 'diamond')
  assert(toggleEquip('camo:gold', 'shotgun'))
  assert.equal(loadProfile().equipped.camos.shotgun, 'gold')
  assert.equal(loadProfile().equipped.camos.ak, undefined)
  assert(toggleEquip('camo:gold', 'shotgun'))
  assert.equal(loadProfile().equipped.camos.shotgun, null)
  assert.equal(CATALOGUE.filter(item => item.kind === 'watch').length, 5)
})

// ---------------------------------------------------------------- viewmodel

function rig(slots: (WeaponItem | null)[]) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, 100)
  camera.position.set(0, 1.7, 0)
  scene.add(camera)
  const world = new CollisionWorld(scene)
  const weapons = new FirstPersonWeapons({ scene, camera, world, onShot() {}, emit() {} })
  weapons.restore({ slots, selected: 0, pickups: [], nextId: 1 })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: new THREE.Vector3() }
  const step = (seconds: number, patch: Partial<WeaponFrame> = {}) => {
    Object.assign(frame, patch)
    for (let t = 0; t < seconds - 1e-8; t += 1 / 60) weapons.update(1 / 60, frame)
  }
  const mount = scene.getObjectByName('Firing hand grip mount')!
  const gun = () => mount.children.find(child => child.name.startsWith('gun:'))!
  return { scene, camera, world, weapons, frame, step, mount, gun }
}
const materials = (object: THREE.Object3D) => {
  const found = new Set<THREE.Material>()
  object.traverse(child => { if (child instanceof THREE.Mesh && !Array.isArray(child.material)) found.add(child.material) })
  return [...found]
}

test('Cosmetics dress the arms: watch, charm, camo on plain guns only', () => {
  const r = rig([{ id: 'a', name: 'ak', magazine: 30, reserve: 90 }, { id: 'b', name: 'shotgun', magazine: 6, reserve: 12, packed: true }])
  r.step(0.2)
  const plain = materials(r.gun()).length
  r.weapons.setCosmetics({ watch: 'diver', charm: 'skull', camos: { ak: 'gold', shotgun: 'gold' }, knife: 'combat' })
  r.step(0.2)
  assert(r.scene.getObjectByName('Watch: diver')?.visible, 'watch on the left wrist')
  assert(r.gun().getObjectByName('Gun charm: skull'), 'charm hangs from the gun')
  assert(materials(r.gun()).some(m => m.customProgramCacheKey().includes('dead-ink-camo:gold')), 'camo painted')
  assert(r.weapons.switchSlot(1)); r.step(0.6)
  assert(!materials(r.gun()).some(m => m.customProgramCacheKey().includes('dead-ink-camo')), 'an upgraded gun keeps its own camo')
  assert(r.gun().getObjectByName('Gun charm: skull'))
  r.weapons.setCosmetics(null)
  assert(!r.scene.getObjectByName('Watch: diver'))
  assert(r.weapons.switchSlot(0)); r.step(0.6)
  assert.equal(materials(r.gun()).length, plain, 'undressed AK is back to paper')
  r.weapons.dispose(); r.world.dispose()
})

test('Switching drops the old gun out before the new one rises and settles exactly at rest', () => {
  const r = rig([{ id: 'a', name: 'ak', magazine: 30, reserve: 90 }, { id: 'p', name: 'pistol', magazine: 12, reserve: 36 }])
  r.step(0.3)
  assert(r.weapons.switchSlot(1))
  r.step(0.05)
  const guns = r.mount.children.filter(child => child.name.startsWith('gun:'))
  assert.equal(guns.length, 2, 'both guns exist while the old one drops')
  assert(guns.find(g => g.name === 'gun:ak')!.visible && !guns.find(g => g.name === 'gun:pistol')!.visible)
  r.step(0.1)
  assert.deepEqual(r.mount.children.filter(child => child.name.startsWith('gun:')).map(g => g.name), ['gun:pistol'])
  r.step(0.6)
  const rest = r.mount.position.clone()
  r.step(0.5)
  assert(r.mount.position.distanceTo(rest) < 1e-9, 'settle ends exactly at rest')
  r.weapons.dispose(); r.world.dispose()
})

test('The knife slash shows the knife, hides the gun and brings it back', () => {
  const r = rig([{ id: 'a', name: 'ak', magazine: 30, reserve: 90 }])
  r.weapons.setCosmetics({ watch: null, charm: null, camos: {}, knife: 'karambit' })
  r.step(0.2)
  assert(r.weapons.knifeSwing())
  r.step(0.15)
  const hand = r.scene.getObjectByName('Knife hand')!
  assert(hand.visible && hand.getObjectByName('Knife: karambit'), 'the equipped skin is in the hand')
  assert(!r.gun().visible)
  r.weapons.trigger(true); r.step(1 / 60); r.weapons.trigger(false)
  assert.equal(r.weapons.current!.magazine, 30, 'no shot mid-slash')
  r.step(0.4)
  assert(!hand.visible && r.gun().visible)
  r.weapons.trigger(true); r.step(1 / 60); r.weapons.trigger(false)
  assert.equal(r.weapons.current!.magazine, 29)
  r.weapons.dispose(); r.world.dispose()
})

test('Idle flourish only when dressed, after ten still seconds, and any input stops it', () => {
  const r = rig([{ id: 'a', name: 'ak', magazine: 30, reserve: 90 }])
  r.step(11)
  const rest = r.mount.position.clone()
  r.step(1)
  assert(r.mount.position.distanceTo(rest) < 1e-9, 'the hostage mission never flourishes')
  r.weapons.setCosmetics({ watch: 'tactical', charm: 'dice', camos: {}, knife: 'butterfly' })
  r.step(10.5)
  assert(r.mount.position.distanceTo(rest) > 0.01, 'the inspect has started')
  r.step(0.1, { moving: 1 })
  r.step(0.6, { moving: 0 })
  assert(r.mount.position.distanceTo(rest) < 0.01, 'moving put the gun back')
  // Second flourish is the knife.
  r.step(10.8)
  assert(r.scene.getObjectByName('Knife hand')!.visible, 'the knife flourish is playing')
  r.weapons.trigger(true); r.step(1 / 60); r.weapons.trigger(false)
  assert(!r.scene.getObjectByName('Knife hand')!.visible && r.gun().visible, 'the trigger interrupts it at once')
  r.weapons.dispose(); r.world.dispose()
})

test('An upgraded shotgun loads four shells per cycle; a plain one loads one', () => {
  for (const packed of [false, true]) {
    const r = rig([{ id: 's', name: 'shotgun', magazine: 1, reserve: 20, packed }])
    r.step(0.2)
    assert(r.weapons.reload())
    let cycles = 0, last = 1
    for (let i = 0; i < 600 && r.weapons.reloading; i++) {
      r.step(1 / 60)
      if (r.weapons.current!.magazine !== last) { cycles++; last = r.weapons.current!.magazine }
    }
    assert.equal(r.weapons.current!.magazine, 6)
    assert.equal(r.weapons.current!.reserve, 15)
    assert.equal(cycles, packed ? 2 : 5)
    r.weapons.dispose(); r.world.dispose()
  }
})

test('Camera shake is a roll that never moves the aim and returns exactly to level', () => {
  const r = rig([{ id: 's', name: 'sniper', magazine: 5, reserve: 0 }])
  r.step(0.3)
  const forward = r.camera.getWorldDirection(new THREE.Vector3())
  r.weapons.trigger(true); r.step(1 / 60); r.weapons.trigger(false)
  r.step(0.05)
  const roll = new THREE.Euler().setFromQuaternion(r.camera.quaternion, 'YXZ').z
  assert(Math.abs(roll) > 0.001, 'the view rolls with the shot')
  r.step(1.5)
  assert(Math.abs(new THREE.Euler().setFromQuaternion(r.camera.quaternion, 'YXZ').z) < 1e-9)
  assert(forward.y < r.camera.getWorldDirection(new THREE.Vector3()).y, 'the kick still climbs the aim')
  r.weapons.dispose(); r.world.dispose()
})

test('The charm swings on gently when you stop a sprint, never far enough to reach the gun', () => {
  const r = rig([{ id: 'a', name: 'ak', magazine: 30, reserve: 90 }])
  r.weapons.setCosmetics({ watch: null, charm: 'dice', camos: {}, knife: 'combat' })
  r.step(0.5)
  const charm = r.gun().getObjectByName('Gun charm: dice')!
  const hang = () => new THREE.Vector3(0, -1, 0).applyQuaternion(charm.getWorldQuaternion(new THREE.Quaternion())).angleTo(new THREE.Vector3(0, -1, 0))
  assert(hang() < 0.01, 'at rest it hangs straight down')
  // Sprint (7.6 m/s) forward, then stop dead: the charm carries on forward.
  for (let i = 0; i < 40; i++) { r.camera.position.z -= 7.6 / 60; r.step(1 / 60, { moving: 7.6 }) }
  r.step(1 / 60, { moving: 0 })
  r.step(3 / 60)
  // Moving mostly with the hand, it swings on a little (the owner found the full pendulum flung it through
  // the gun), and never past its limit.
  const swing = hang()
  assert(swing > 0.05, `it still swings on after a sprint stop (${swing})`)
  assert(swing <= 0.45 + 1e-6, `but never past its limit, clear of the gun (${swing})`)
  r.step(3)
  assert(hang() < 0.02, 'and settles')
  r.weapons.dispose(); r.world.dispose()
})

test('Charms keep their own paper, so the Pack-a-Punch shimmer and camos never paint them', () => {
  const charm = buildCharm('skull')
  let meshes = 0
  charm.traverse(object => { if (object instanceof THREE.Mesh) { meshes++; assert.notEqual(object.material, metal) } })
  assert(meshes > 0)
})

test('A roll lost under a camera overlay that restores the view is levelled out afterwards', () => {
  const r = rig([{ id: 's', name: 'sniper', magazine: 5, reserve: 0 }])
  r.step(0.3)
  const overlay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3)
  // As Second Draft's revive does while you get up: tip the view, update, put the view back as it was.
  const frame = () => { const saved = r.camera.quaternion.clone(); r.camera.quaternion.multiply(overlay); r.step(1 / 60); r.camera.quaternion.copy(saved) }
  for (let i = 0; i < 10; i++) frame()
  r.weapons.trigger(true); frame(); r.weapons.trigger(false)
  for (let i = 0; i < 2; i++) frame()
  r.step(2)
  assert(Math.abs(new THREE.Euler().setFromQuaternion(r.camera.quaternion, 'YXZ').z) < 1e-9, 'the view ends level')
  r.weapons.dispose(); r.world.dispose()
})

// ---------------------------------------------------------------- challenges and progression

test('Challenge camos are never in a case and are owned per gun, not outright', () => {
  assert(casePool().every(item => !item.challenge), 'no challenge camo in the case pool')
  assert.equal(CATALOGUE.filter(item => item.challenge).map(item => cosmeticKey(item.id)).join(), CHALLENGE_CAMOS.join())
  store.clear(); resetProfileCache()
  const profile = loadProfile()
  profile.owned.push('camo:crosshatch')
  assert(!toggleEquip('camo:crosshatch', 'ak'), 'putting a challenge camo in `owned` does not unlock it')
  profile.challenges.done.push('ak:1')
  assert(toggleEquip('camo:crosshatch', 'ak'))
  assert.equal(loadProfile().equipped.camos.ak, 'crosshatch')
  assert(!toggleEquip('camo:crosshatch', 'smg'), 'only on the gun that earned it')
})

test('Tiers count from the first kill but complete in order, and many games are needed', () => {
  const state = freshChallenges()
  const kill = (patch: Partial<KillRecord> = {}) => countKill(state, { weapon: 'ak', round: 5, ...patch })
  for (let i = 0; i < 120; i++) kill({ headshot: true })
  assert.deepEqual(settle(state), [], '120 headshot kills: Tier 2 goal met but Tier 1 is not done')
  for (let i = 0; i < 179; i++) kill()
  assert.deepEqual(settle(state), [])
  kill()
  const unlocked = settle(state).map(u => u.id)
  assert.deepEqual(unlocked, ['ak:1', 'ak:2'], 'the 300th kill completes Tier 1 and the waiting Tier 2 at once')
  assert(challengeCamoUnlocked(state, 'blueprint', 'ak') && !challengeCamoUnlocked(state, 'blueprint', 'smg'))
  assert.equal(state.weapons.smg.kills, 0, 'kills count only for the gun that made them')
  // Scale: a solo game to round 15 is about 430 kills; one gun's four tiers need at least 750 of its own kills.
  const minimumKills = WEAPON_TIERS.filter(t => t.metric !== 'headshots').reduce((sum, t) => sum + t.goal, 0)
  assert(minimumKills >= 750 && CHALLENGE_WEAPONS.length * minimumKills >= 5000, `${minimumKills} kills per gun`)
})

test('Special weapons, the knife, Pack-a-Punch and deep-round kills count where they should', () => {
  const state = freshChallenges()
  countKill(state, { weapon: 'ak', special: true, round: 30, headshot: true })
  countKill(state, { weapon: null, round: 3 })
  countKill(state, { weapon: 'lmg', packed: true, packLevel: 2, round: 21 })
  assert.equal(state.account.kills, 3); assert.equal(state.account.headshots, 1)
  assert.equal(state.weapons.ak.kills, 0, 'a wonder weapon or Death Machine kill is not the AK’s')
  assert.deepEqual(state.weapons.lmg, { kills: 1, headshots: 0, packedKills: 1, deepKills: 1 })
})

test('Diamond unlocks once every gun has Tier 4, and then works on every gun', () => {
  const state = freshChallenges()
  for (const weapon of CHALLENGE_WEAPONS.slice(0, -1)) state.done.push(`${weapon}:1`, `${weapon}:2`, `${weapon}:3`, `${weapon}:4`)
  assert.deepEqual(settle(state), [])
  assert(!diamondUnlocked(state) && masteredCount(state) === CHALLENGE_WEAPONS.length - 1)
  const last = CHALLENGE_WEAPONS[CHALLENGE_WEAPONS.length - 1]
  state.weapons[last] = { kills: 300, headshots: 100, packedKills: 250, deepKills: 200 }
  const unlocked = settle(state).map(u => u.id)
  assert.deepEqual(unlocked, [`${last}:1`, `${last}:2`, `${last}:3`, `${last}:4`, 'diamond'])
  assert(CHALLENGE_WEAPONS.every(w => challengeCamoUnlocked(state, 'diamond', w)))
  // Out-of-order stored progress is repaired: Tier 3 without Tier 2 does not count; junk is dropped.
  const repaired = sanitizeChallenges({ done: ['smg:1', 'smg:3', 'nonsense'], weapons: { smg: { kills: -4, headshots: 2.7 } } })
  assert.deepEqual(repaired.done, ['smg:1'])
  assert.deepEqual(repaired.weapons.smg, { kills: 0, headshots: 2, packedKills: 0, deepKills: 0 })
})

test('Diamond is its own animated camo, and it paints a plain gun', () => {
  const material = camoMaterial('diamond')
  assert.equal(material.customProgramCacheKey(), 'dead-ink-camo:diamond')
  assert.equal(material.defines!.CAMO, 9)
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' }
  material.onBeforeCompile(shader as never, undefined as never)
  assert('camoTime' in shader.uniforms && shader.fragmentShader.includes('uniform float camoTime'), 'a time uniform drives the glints')
  const time = shader.uniforms.camoTime as { value: number }
  const before = time.value
  material.onBeforeRender(undefined as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never)
  assert.notEqual(time.value, before, 'drawing Diamond advances its clock')
  const r = rig([{ id: 'a', name: 'ak', magazine: 30, reserve: 90 }])
  r.weapons.setCosmetics({ watch: null, charm: null, camos: { ak: 'diamond' }, knife: 'combat' })
  r.step(0.2)
  assert(materials(r.gun()).includes(material), 'the AK wears Diamond')
  r.weapons.dispose(); r.world.dispose()
})

test('A version 1 profile keeps its Ink, items and equipment, gains challenges and is paid for past rounds', () => {
  store.set('dead-ink-profile', JSON.stringify({ ink: 1234, owned: ['knife:combat', 'watch:diver', 'camo:gold'], games: 9, bestRound: 22, opened: 4,
    equipped: { watch: 'diver', charm: null, knife: 'combat', camos: { lmg: 'gold', magnum: 'gold' } }, last: { round: 22, kills: 500, headshots: 90, ink: 790 } }))
  resetProfileCache()
  const profile = loadProfile()
  assert.equal(profile.version, 2)
  assert.equal(profile.ink, 1234 + 250 + 750, 'the round 10 and round 20 challenges pay out on migration')
  assert.deepEqual(profile.owned, ['knife:combat', 'watch:diver', 'camo:gold'])
  assert.deepEqual([profile.games, profile.bestRound, profile.opened], [9, 22, 4])
  assert.equal(profile.equipped.watch, 'diver')
  assert.equal(profile.equipped.camos.lmg, 'gold', 'LMG and Magnum camos survive a reload')
  assert.equal(profile.equipped.camos.magnum, 'gold')
  assert(profile.challenges.done.includes('account:round-20') && !profile.challenges.done.includes('account:round-30'))
  // Saved as version 2; loading it again does not pay twice.
  toggleEquip('watch:diver'); resetProfileCache()
  assert.equal(loadProfile().ink, 1234 + 1000)
  assert.equal(JSON.parse(store.get('dead-ink-profile')!).version, 2)
})

test('A game reports rounds, kills, accuracy, best weapon, Ink line by line and new records', () => {
  store.clear(); resetProfileCache()
  const start = loadProfile().ink
  beginGame()
  assert.deepEqual(recordRound(1), [])
  for (let i = 0; i < 40; i++) recordKill({ weapon: 'smg', round: 4, headshot: i % 4 === 0 })
  for (let i = 0; i < 25; i++) recordKill({ weapon: 'shotgun', round: 6 })
  recordKill({ weapon: null, round: 6 })
  const round10 = recordRound(10)
  assert.equal(round10.length, 1); assert.equal(round10[0].ink, 250)
  assert.equal(loadProfile().ink, start + 250, 'account challenge Ink is paid when it completes')
  const report = recordGameEnd({ round: 10, kills: 66, headshots: 10, shotsFired: 200, shotsHit: 150, elapsed: 754.2 })
  assert.equal(report.accuracy, 0.75)
  assert.deepEqual(report.bestWeapon, { weapon: 'smg', kills: 40 })
  assert.deepEqual(report.inkLines.map(line => line.ink), [100, 66, 20, 250])
  assert.equal(report.inkTotal, 436)
  assert(report.newRecord && report.previousBest === 0)
  assert.deepEqual(report.challenges.map(c => c.id), ['account:round-10'])
  assert.equal(loadProfile().ink, start + 436, 'Ink paid once: the game’s at the end plus the challenge’s during the game')
  assert.equal(loadProfile().last!.ink, 436)
  assert.equal(lastReport(), report)
  resetProfileCache()
  assert.equal(loadProfile().challenges.weapons.smg.kills, 40, 'progress is saved')
  beginGame()
  const second = recordGameEnd({ round: 4, kills: 0, headshots: 0 })
  assert(!second.newRecord && second.previousBest === 10 && second.accuracy === null && second.bestWeapon === null)
})

test('The case reel ticks and wins in sound, at the saved effects volume, silent when muted', () => {
  // A stand-in Web Audio: counts the nodes a sound makes and remembers the output level.
  let nodes = 0
  const outs: number[] = []
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} })
  const node = () => { nodes++; return { connect: (next: unknown) => next, disconnect() {}, start() {}, stop() {}, frequency: param(), detune: param(), Q: param(), gain: param(), type: '', buffer: null } }
  class FakeContext {
    state = 'running'; currentTime = 0; sampleRate = 8000; destination = {}
    resume() { return Promise.resolve() }
    createGain() { const gain = node(); return gain }
    createOscillator() { return node() }
    createBiquadFilter() { return node() }
    createBufferSource() { return node() }
    createBuffer(_channels: number, length: number) { return { sampleRate: 8000, getChannelData: () => new Float32Array(length) } }
  }
  const realWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { AudioContext: FakeContext }
  try {
    store.clear(); resetSettingsCache()
    setSettings({ masterVolume: 50, effectsVolume: 80, muted: false })
    const settings = getSettings()
    const out = synthOutput('effects', 0.5)!
    outs.push(out.out.gain.value)
    assert(Math.abs(outs[0] - volumeFor(settings, 'effects') * 0.5) < 1e-9, 'sound plays at master x effects')
    nodes = 0; playReelTick(1)
    assert(nodes > 0, 'a tile passing the marker clicks')
    const sizes = RARITIES.map(rarity => { nodes = 0; playReelWin(rarity); return nodes })
    for (let i = 1; i < sizes.length; i++) assert(sizes[i] >= sizes[i - 1], `a rarer win is fuller (${RARITIES[i]}: ${sizes[i]} voices)`)
    for (let i = 1; i < RARITIES.length; i++) {
      const a = REEL_WINS[RARITIES[i - 1]], b = REEL_WINS[RARITIES[i]]
      assert(b.notes.length >= a.notes.length && b.hold > a.hold && b.bright > a.bright, `${RARITIES[i]} wins bigger and brighter than ${RARITIES[i - 1]}`)
    }
    assert(sizes[RARITIES.indexOf('legendary')] > sizes[0] * 3, 'gold is a fanfare next to grey')
    setSettings({ muted: true })
    nodes = 0; playReelTick(0.5); playReelWin('legendary')
    assert.equal(nodes, 0, 'muted plays nothing')
    setSettings({ muted: false, effectsVolume: 0 })
    nodes = 0; playReelTick(0.5); playReelWin('epic')
    assert.equal(nodes, 0, 'effects at zero plays nothing')
  } finally {
    ;(globalThis as { window?: unknown }).window = realWindow
    store.delete('stickman-settings'); resetSettingsCache()
  }
  // The Armory drives it: ticks while the strip moves, the win when it stops, all from the Open click.
  const armory = readFileSync('src/game/zombies/cosmetics/armory.ts', 'utf8')
  assert(/synthContext\(\)/.test(armory) && /playReelTick\(/.test(armory) && /playReelWin\(item\.rarity\)/.test(armory), 'the Armory reel is wired to its sounds')
})

test('Mythic never turns up in a case', () => {
  assert(!CATALOGUE.some(item => item.rarity === 'mythic'), 'no cosmetic is Mythic')
  const random = seeded(11)
  for (let i = 0; i < 5000; i++) assert.notEqual(rollCaseItem(random).rarity, 'mythic')
})

if (failures) { console.error(`${failures} cosmetics check(s) failed`); process.exit(1) }
console.log('All cosmetics checks passed.')
