import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { FirstPersonWeapons, CHARGE_TIME } from '../src/game/weapons'
import { INK_CANNON, InkBlobs, InkPools, cannonDamage, cannonShot, launchVelocity } from '../src/game/zombies/ink-cannon'
import { INK_CANNON_AMMO, INK_CANNON_CHANCE, RAY_GUN_CHANCE, freshWeapon, rollBox, spareAmmo } from '../src/game/zombies/economy'
import { PACKED_NAMES, weaponRules } from '../src/game/loot'
import { DIFFICULTY, zombieHealth } from '../src/game/zombies/rules'
import { seeded } from '../src/game/shared/random'
import type { Shot, WeaponFrame, WeaponItem } from '../src/game/types'

/** The Ink Cannon (ink-cannon.ts): its damage, burst, flight, the Deluge's pool, charging in the hands, the box. */
let passed = 0
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`) }

test('A charged shot flies faster, bursts wider and hits harder; the Deluge wider still and twice as hard', () => {
  const tap = cannonShot(0), full = cannonShot(1), packed = cannonShot(1, true)
  assert(full.speed > tap.speed && full.radius > tap.radius && full.healths > tap.healths)
  assert(packed.radius > full.radius * 1.3)
  assert.equal(packed.healths, full.healths * INK_CANNON.packedDamage)
  assert.deepEqual(cannonShot(5), full, 'charge stops at full')
  assert.deepEqual(cannonShot(-1), tap)
  assert.deepEqual(cannonShot(NaN), tap)
})

test('Its burst kills anything ordinary at any round and difficulty: a tap at its centre, a full charge to its edge', () => {
  for (const round of [1, 5, 10, 20, 35, 50]) {
    for (const difficulty of Object.values(DIFFICULTY)) {
      const health = zombieHealth(round) * difficulty.health
      // The director's falloff: half damage at the burst's edge. A tap kills at its centre; a full charge everywhere in it.
      assert(cannonDamage(health, 0) >= health, `a tap kills at the centre, round ${round}`)
      assert(cannonDamage(health, 1) * 0.5 >= health, `a full charge kills to the edge, round ${round}`)
      assert(cannonDamage(health, 1, true) * 0.5 >= health * 2, `the Deluge overkills, round ${round}`)
    }
  }
  assert.equal(cannonDamage(10, 0), INK_CANNON.floor, 'never less than its floor')
})

test('A blob lobs in an arc and bursts where it lands, further the more it was charged', () => {
  const scene = new THREE.Scene()
  // A flat floor at y 0 and nothing else.
  const world = { raySurface: (from: THREE.Vector3, dir: THREE.Vector3, max: number) => {
    if (dir.y >= 0) return null
    const t = from.y / -dir.y
    return t <= max ? { distance: t } : null
  }, floor: () => 0 } as unknown as CollisionWorld
  const land = (charge: number) => {
    const blobs = new InkBlobs(scene, world, (_o, _d, max) => max)
    blobs.fire(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, -1), charge)
    for (let i = 0; i < 400; i++) {
      const bursts = blobs.update(1 / 60)
      if (bursts.length) { blobs.dispose(); return bursts[0] }
    }
    throw new Error('never landed')
  }
  const near = land(0), far = land(1)
  assert(Math.abs(near.at.y) < 0.2 && Math.abs(far.at.y) < 0.2, 'on the floor')
  assert(-far.at.z > -near.at.z + 5, `a full charge flies further (${(-near.at.z).toFixed(1)} m vs ${(-far.at.z).toFixed(1)} m)`)
  assert(-near.at.z > 4, 'even a tap is a lob, not a drop at your feet')
  assert.equal(far.radius, cannonShot(1).radius)
  // It stops at a zombie in the way.
  const blobs = new InkBlobs(scene, world, (origin, _d, max) => origin.z < -3 ? 0.05 : max)
  blobs.fire(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, -1), 1)
  let hit = null
  for (let i = 0; i < 60 && !hit; i++) hit = blobs.update(1 / 60)[0] ?? null
  assert(hit && hit.at.z < -3 && hit.at.z > -5 && hit.at.y > 0.8, 'it bursts on the zombie')
  assert(launchVelocity(new THREE.Vector3(0, 0, -1), 1).length() - INK_CANNON.speed.full < 1e-9)
})

test('The Deluge\'s pool holds zombies to a crawl inside it, while it lasts', () => {
  const pools = new InkPools(null)
  pools.add(new THREE.Vector3(10, 0, 10), 3)
  assert.equal(pools.slowAt(new THREE.Vector3(11, 0, 10)), INK_CANNON.pool.slow)
  assert.equal(pools.slowAt(new THREE.Vector3(14, 0, 10)), 1, 'outside it')
  assert.equal(pools.slowAt(new THREE.Vector3(11, 3, 10)), 1, 'not on the floor above')
  pools.update(INK_CANNON.pool.seconds + 0.1)
  assert.equal(pools.slowAt(new THREE.Vector3(11, 0, 10)), 1, 'dried up')
  assert.equal(pools.pools.length, 0)
})

test('In the hands: holding charges (the tank fills), letting go fires once with the charge', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, 100)
  camera.position.set(0, 1.7, 0); scene.add(camera)
  const shots: Shot[] = [], sounds: string[] = []
  const weapons = new FirstPersonWeapons({ scene, camera, world: new CollisionWorld(scene), onShot: shot => shots.push(shot), emit: event => sounds.push(event.kind) })
  const cannon: WeaponItem = { ...freshWeapon('c', 'cannon', 'legendary'), special: 'inkCannon' }
  weapons.restore({ slots: [cannon, null], selected: 0, pickups: [], nextId: 1 })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: new THREE.Vector3() }
  const step = (seconds: number) => { for (let t = 0; t < seconds - 1e-8; t += 1 / 60) weapons.update(1 / 60, frame) }
  step(0.5)
  weapons.trigger(true)
  step(CHARGE_TIME * 0.5)
  assert.equal(shots.length, 0, 'nothing fires while held')
  assert(weapons.chargeLevel > 0.4 && weapons.chargeLevel < 0.6, `half charged (${weapons.chargeLevel.toFixed(2)})`)
  assert(sounds.includes('cannon-charge'), 'the ink bubbles up')
  step(CHARGE_TIME)
  assert.equal(weapons.chargeLevel, 1, 'full, and no further')
  weapons.trigger(false)
  step(0.05)
  assert.equal(shots.length, 1)
  assert.equal(shots[0].charge, 1)
  assert.equal(weapons.current!.magazine, INK_CANNON_AMMO.magazine - 1)
  assert(sounds.includes('shot-cannon'))
  // A tap: a weak shot at once.
  step(1)
  weapons.trigger(true); step(1 / 60); weapons.trigger(false); step(0.05)
  assert.equal(shots.length, 2)
  assert(shots[1].charge! < 0.1)
})

test('Obtained like the Ink Ray: a rare, gold box roll, never while you carry one; Max Ammo refills it; upgraded once', () => {
  const random = seeded(31337)
  let cannons = 0, rays = 0
  const draws = 60000
  for (let i = 0; i < draws; i++) {
    const roll = rollBox(random, [freshWeapon('p', 'pistol'), null])
    if (roll.special === 'inkCannon') { cannons++; assert.equal(roll.rarity, 'legendary'); assert.equal(roll.name, 'cannon') }
    if (roll.special === 'rayGun') rays++
  }
  assert(Math.abs(cannons / draws - INK_CANNON_CHANCE) < 0.004, `about ${(INK_CANNON_CHANCE * 100).toFixed(1)}% (${(cannons / draws * 100).toFixed(2)}%)`)
  assert(Math.abs(rays / draws - RAY_GUN_CHANCE) < 0.005, 'the Ink Ray keeps its odds')
  const holding = [{ ...freshWeapon('c', 'cannon'), special: 'inkCannon' as const }, null]
  const again = seeded(5)
  for (let i = 0; i < 20000; i++) assert.notEqual(rollBox(again, holding).special, 'inkCannon', 'never a second one')
  assert.equal(spareAmmo({ name: 'cannon' }), INK_CANNON_AMMO.reserve)
  assert.equal(spareAmmo({ name: 'cannon', packed: true }), INK_CANNON_AMMO.packedReserve)
  const deluge = weaponRules({ name: 'cannon', special: 'inkCannon', packed: true, packLevel: 1 })
  assert.equal(deluge.label, PACKED_NAMES.cannon)
  assert.equal(deluge.capacity, 4)
  assert.equal(weaponRules({ name: 'cannon', special: 'inkCannon' }).capacity, INK_CANNON_AMMO.magazine)
})

console.log(`ink cannon checks passed (${passed})`)
