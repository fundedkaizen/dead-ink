import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { FirstPersonWeapons } from '../src/game/weapons'
import { CATALOGUE } from '../src/game/zombies/cosmetics/catalogue'
import { buildCharm } from '../src/game/zombies/cosmetics/models'
import { metal } from '../src/lab/weapons/models/common'
import { CASE, STRIP_WIN_INDEX, awardGame, inkForGame, loadProfile, openCase, resetProfileCache, rollCaseItem, toggleEquip } from '../src/game/zombies/cosmetics/profile'
import type { WeaponFrame, WeaponItem } from '../src/game/types'

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

test('The charm keeps swinging at a sprint and swings on when you stop', () => {
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
  assert(hang() > 0.15, `swing after a sprint stop ${hang()}`)
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

if (failures) { console.error(`${failures} cosmetics check(s) failed`); process.exit(1) }
console.log('All cosmetics checks passed.')
