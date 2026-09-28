import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { FirstPersonWeapons } from '../src/game/weapons'
import { BURST_FIRE, WEAPON_RULES } from '../src/game/balance'
import { PACKED_NAMES, pierceOf, weaponRules } from '../src/game/loot'
import { createMissionGun } from '../src/game/weapon-models'
import { BOX_WEIGHTS, freshWeapon, spareAmmo, startingPistol, wallOffer } from '../src/game/zombies/economy'
import { PRICES } from '../src/game/zombies/rules'
import { CHALLENGE_WEAPONS, WEAPON_LABELS } from '../src/game/zombies/cosmetics/challenges'
import type { GuardWeapon, Shot, WeaponFrame, WeaponName } from '../src/game/types'

/** Dead Ink's newer guns: the burst pistol, the PDW and the lever rifle. Their numbers, models, walls and box. */
let passed = 0
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`) }
const NEW: WeaponName[] = ['burst', 'pdw', 'lever']
const dps = (name: WeaponName) => {
  const r = WEAPON_RULES[name], burst = BURST_FIRE[name]
  return burst ? r.damage * burst.count / (r.interval + burst.gap * (burst.count - 1)) : r.damage / r.interval
}

test('Each fits the arsenal: the burst pistol above the pistol, the PDW beside the SMG, the lever rifle heavy and piercing', () => {
  assert(dps('burst') > dps('pistol') * 1.4 && dps('burst') < dps('ak'), `burst ${dps('burst').toFixed(0)} vs pistol ${dps('pistol').toFixed(0)}`)
  assert(Math.abs(dps('pdw') - dps('smg')) / dps('smg') < 0.2, `PDW ${dps('pdw').toFixed(0)} vs SMG ${dps('smg').toFixed(0)}`)
  assert(WEAPON_RULES.pdw.capacity > WEAPON_RULES.smg.capacity && WEAPON_RULES.pdw.damage < WEAPON_RULES.smg.damage, 'a longer magazine, a lighter round')
  assert(WEAPON_RULES.lever.damage > WEAPON_RULES.magnum.damage && WEAPON_RULES.lever.damage < WEAPON_RULES.sniper.damage * 2)
  assert(WEAPON_RULES.lever.interval < WEAPON_RULES.sniper.interval, 'quicker than the bolt rifle')
  assert.equal(pierceOf({ name: 'lever' }), 2, 'through two bodies')
  assert.equal(pierceOf({ name: 'lever', packed: true, packLevel: 1 }), 3)
  assert.equal(WEAPON_RULES.pdw.automatic, true)
  assert.equal(WEAPON_RULES.burst.automatic, false)
})

test('Pack-a-Punch names and handling; labels, walls, box weights and camo challenges for each', () => {
  assert.deepEqual(NEW.map(n => PACKED_NAMES[n]), ['Ellipsis', 'Typewriter', 'Signature'])
  for (const name of NEW) {
    const packed = weaponRules({ name, packed: true, packLevel: 1 })
    assert.equal(packed.label, PACKED_NAMES[name])
    assert.equal(packed.damage, WEAPON_RULES[name].damage * 2)
    assert(packed.capacity > WEAPON_RULES[name].capacity, `${name} holds more upgraded`)
    assert(PRICES.wall[name as keyof typeof PRICES.wall] > 0, `${name} is on a wall`)
    assert(BOX_WEIGHTS[name] > 0, `${name} is in the box`)
    assert(CHALLENGE_WEAPONS.includes(name), `${name} has camo challenges`)
    assert(WEAPON_LABELS[name])
    assert.equal(spareAmmo({ name }), WEAPON_RULES[name].capacity * 4)
    assert.equal(wallOffer(name, PRICES.wall[name as keyof typeof PRICES.wall], [null, null]).kind, 'buy')
  }
  assert(PRICES.wall.burst < PRICES.wall.pdw && PRICES.wall.pdw < PRICES.wall.lever, 'dearer as they get stronger')
  // The hostage mission's guards never carry them (a compile-time fact; this only reads the list).
  const guard: GuardWeapon[] = ['pistol', 'ak', 'smg', 'shotgun', 'sniper', 'magnum', 'lmg']
  assert(!guard.includes('burst' as GuardWeapon))
})

test('Each has its own model: a muzzle ahead of the grip, moving parts where the hands need them', () => {
  for (const name of NEW) {
    const model = createMissionGun(name)
    assert(model.userData.muzzle.z > 0.15, `${name} muzzle`)
    assert.equal(new THREE.Box3().setFromObject(model).isEmpty(), false)
    assert(model.children.length > 0)
  }
  assert(createMissionGun('burst').userData.parts.slide && createMissionGun('burst').userData.parts.magazine)
  assert(createMissionGun('pdw').userData.parts.magazine)
  assert(createMissionGun('lever').userData.parts.lever && createMissionGun('lever').userData.parts.loadingPort)
  assert(createMissionGun('lever').userData.support, 'held in both hands')
})

test('The burst pistol fires three rounds a pull, then waits; the PDW fires while held; the lever rifle works its lever', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, 100)
  camera.position.set(0, 1.7, 0); scene.add(camera)
  const shots: Shot[] = [], sounds: string[] = []
  const weapons = new FirstPersonWeapons({ scene, camera, world: new CollisionWorld(scene), onShot: shot => shots.push(shot), emit: event => sounds.push(event.kind) })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: new THREE.Vector3() }
  const step = (seconds: number) => { for (let t = 0; t < seconds - 1e-8; t += 1 / 120) weapons.update(1 / 120, frame) }
  weapons.restore({ slots: [freshWeapon('b', 'burst'), freshWeapon('p', 'pdw'), freshWeapon('l', 'lever')], selected: 0, pickups: [], nextId: 1 })
  step(0.5)
  weapons.trigger(true); step(0.25); weapons.trigger(false)
  assert.equal(shots.length, 3, 'one pull, three rounds')
  step(0.6)
  assert.equal(shots.length, 3, 'and no more until the next pull')
  assert.equal(weapons.current!.magazine, WEAPON_RULES.burst.capacity - 3)
  weapons.trigger(true); step(0.05); weapons.trigger(false); step(0.4)
  assert.equal(shots.length, 6, 'a tap still fires the whole burst')
  assert(sounds.filter(s => s === 'shot-burst').length === 6)
  assert.equal(startingPistol('burst').magazine, WEAPON_RULES.burst.capacity)
  // The PDW: automatic.
  weapons.switchSlot(1); step(0.5); shots.length = 0
  weapons.trigger(true); step(0.5); weapons.trigger(false)
  assert(shots.length >= 6, `${shots.length} rounds in half a second`)
  assert(weapons.canAim, 'the PDW aims')
  // The lever rifle: one round a pull, the lever worked (its clack) between.
  weapons.switchSlot(2); step(0.5); shots.length = 0; sounds.length = 0
  weapons.trigger(true); step(0.1); weapons.trigger(false); step(0.8)
  assert.equal(shots.length, 1)
  assert(sounds.includes('shot-lever') && sounds.includes('weapon-pump'), sounds.join(','))
  assert(weapons.canAim, 'the lever rifle aims down its sights')
})

console.log(`new weapons checks passed (${passed})`)
