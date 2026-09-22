import assert from 'node:assert/strict'
import * as THREE from 'three'
import { screenBearing } from '../src/game/shared/damage-indicator'
import { FirstPersonWeapons } from '../src/game/weapons'
import { CollisionWorld } from '../src/player/collision'
import { seeded } from '../src/game/shared/random'
import type { Shot, SoundEvent, WeaponFrame, WeaponItem } from '../src/game/types'

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

// ---- Damage arc direction ------------------------------------------------------------------------
// Hand-checked cardinal cases at yaw 0 (camera looking down -Z).
const eye = { x: 0, z: 0 }
assert(near(screenBearing(eye, 0, { x: 0, z: -10 }), 0), 'dead ahead points to the top of the ring')
assert(near(screenBearing(eye, 0, { x: 10, z: 0 }), Math.PI / 2), 'a shooter on the right points right')
assert(near(screenBearing(eye, 0, { x: -10, z: 0 }), -Math.PI / 2), 'a shooter on the left points left')
assert(near(Math.abs(screenBearing(eye, 0, { x: 0, z: 10 })), Math.PI), 'a shooter behind points to the bottom')

// The decisive check: agree with Three.js's own camera, not with our assumptions about it. For random
// camera headings and shooter positions, the arc must point right exactly when the shooter is to the
// camera's right, and toward the top exactly when the shooter is in front.
{
  const random = seeded(31), camera = new THREE.PerspectiveCamera()
  for (let i = 0; i < 2000; i++) {
    const yaw = (random() - 0.5) * Math.PI * 4
    camera.position.set((random() - 0.5) * 100, 1.7, (random() - 0.5) * 100)
    camera.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'))
    camera.updateMatrixWorld(true)
    const source = new THREE.Vector3(camera.position.x + (random() - 0.5) * 80, 1.2, camera.position.z + (random() - 0.5) * 80)
    const local = source.clone().applyMatrix4(camera.matrixWorldInverse)   // camera space: +x right, -z forward
    if (Math.abs(local.x) < 1e-6 || Math.abs(local.z) < 1e-6) continue
    const bearing = screenBearing(camera.position, yaw, source)
    assert.equal(Math.sign(bearing), Math.sign(local.x), `case ${i}: arc points ${bearing > 0 ? 'right' : 'left'} but the shooter is ${local.x > 0 ? 'right' : 'left'}`)
    assert.equal(Math.abs(bearing) < Math.PI / 2, local.z < 0, `case ${i}: front/back disagrees with the camera`)
    assert(near(bearing, Math.atan2(local.x, -local.z), 1e-6), `case ${i}: angle ${bearing} vs camera ${Math.atan2(local.x, -local.z)}`)
  }
}

// ---- Mouse-wheel weapon cycling ------------------------------------------------------------------
function fixture(slots: (WeaponItem | null)[], selected: number) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, 200)
  camera.position.set(0, 1.7, 0); scene.add(camera)
  const world = new CollisionWorld(scene), shots: Shot[] = [], sounds: SoundEvent[] = []
  const weapons = new FirstPersonWeapons({ scene, camera, world, onShot: s => shots.push(s), emit: e => sounds.push(e) })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: new THREE.Vector3() }
  const step = (seconds: number) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) weapons.update(1 / 60, frame) }
  weapons.restore({ slots, selected, pickups: [], nextId: 1 })
  step(0.5)
  return { weapons, step, dispose() { weapons.dispose(); world.dispose() } }
}
const gun = (id: string, name: WeaponItem['name']): WeaponItem => ({ id, name, magazine: 5, reserve: 5 })
{
  const f = fixture([gun('a', 'pistol'), null, gun('c', 'ak'), null], 0)
  assert(f.weapons.cycle(1)); f.step(0.3)
  assert.equal(f.weapons.selectedSlot, 2, 'wheel down skips the empty slot')
  assert(f.weapons.cycle(1)); f.step(0.3)
  assert.equal(f.weapons.selectedSlot, 0, 'and wraps around, skipping empty slots')
  assert(f.weapons.cycle(-1)); f.step(0.3)
  assert.equal(f.weapons.selectedSlot, 2, 'wheel up goes the other way')
  f.dispose()
}
{
  const f = fixture([null, gun('b', 'smg'), null, null], 1)
  assert.equal(f.weapons.cycle(1), false, 'one weapon: nothing to switch to')
  assert.equal(f.weapons.selectedSlot, 1)
  f.dispose()
}
{
  const f = fixture([null, null, null, null], 0)
  assert.equal(f.weapons.cycle(1), false, 'empty hands: the wheel does nothing')
  assert.equal(f.weapons.cycle(-1), false)
  f.dispose()
}
{
  // Selected slot empty (e.g. you just dropped your gun): the wheel still finds a weapon.
  const f = fixture([gun('a', 'shotgun'), null, null, gun('d', 'sniper')], 1)
  assert(f.weapons.cycle(1)); f.step(0.3)
  assert.equal(f.weapons.selectedSlot, 3)
  f.dispose()
}

console.log('hud checks passed')
