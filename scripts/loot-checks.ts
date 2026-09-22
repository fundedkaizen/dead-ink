import assert from 'node:assert/strict'
import * as THREE from 'three'
import { FirstPersonWeapons } from '../src/game/weapons'
import { WEAPON_RULES } from '../src/game/balance'
import { DROP_WEIGHTS, RARITIES, RARITY_INFO, rollRarity, weaponRules, type LootSource, type Rarity } from '../src/game/loot'
import { CollisionWorld } from '../src/player/collision'
import type { Shot, SoundEvent, WeaponFrame, WeaponItem, WeaponName } from '../src/game/types'

const NAMES = Object.keys(WEAPON_RULES) as WeaponName[]
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)

// Deterministic generator so the distribution check is reproducible run to run.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// 1. THE GUARANTEE THAT PROTECTS THE ORIGINAL MISSION: grey, or no rarity at all, is the base weapon.
for (const name of NAMES) {
  assert.deepEqual(weaponRules({ name }), { ...WEAPON_RULES[name] }, `${name}: no rarity must equal the base rules exactly`)
  assert.deepEqual(weaponRules({ name, rarity: 'common' }), { ...WEAPON_RULES[name] }, `${name}: common must equal the base rules exactly`)
}

// 2. Rarity is modest and only moves damage and reload.
for (const name of NAMES) {
  let lastDamage = -Infinity, lastReload = Infinity
  for (const rarity of RARITIES) {
    const r = weaponRules({ name, rarity }), base = WEAPON_RULES[name]
    assert(r.damage >= lastDamage, `${name}: damage never drops with rarity`)
    assert(r.reload <= lastReload, `${name}: reload never slows with rarity`)
    lastDamage = r.damage; lastReload = r.reload
    for (const key of ['capacity', 'interval', 'range', 'kick', 'settle', 'automatic'] as const)
      assert.equal(r[key], base[key], `${name} ${rarity}: ${key} must not change with rarity`)
    assert(r.damage <= base.damage * 1.25 + 1e-9, `${name} ${rarity}: rarity is a modest boost, never over +25% damage`)
  }
}
assert.equal(weaponRules({ name: 'ak', rarity: 'legendary' }).label, 'Legendary AK rifle')
assert.equal(weaponRules({ name: 'ak', rarity: 'common' }).label, 'AK rifle', 'common keeps the plain name')
assert.equal(RARITY_INFO.common.beam, false, 'grey loot stays plain ink, no beam')
for (const rarity of RARITIES.slice(1)) assert.equal(RARITY_INFO[rarity].beam, true, `${rarity} shows a beam`)

// 3. Drop odds come out as specified, and sources respect their floors.
for (const source of Object.keys(DROP_WEIGHTS) as LootSource[]) {
  const weights = DROP_WEIGHTS[source], total = RARITIES.reduce((s, r) => s + weights[r], 0)
  assert(total > 0 && RARITIES.every(r => weights[r] >= 0), `${source}: weights are non-negative with a positive total`)
  const random = mulberry32(20260922), counts = Object.fromEntries(RARITIES.map(r => [r, 0])) as Record<Rarity, number>
  const draws = 200_000
  for (let i = 0; i < draws; i++) counts[rollRarity(source, random)]++
  for (const rarity of RARITIES) {
    const expected = weights[rarity] / total, observed = counts[rarity] / draws
    assert(Math.abs(observed - expected) < 0.006, `${source} ${rarity}: observed ${observed.toFixed(4)} vs expected ${expected.toFixed(4)}`)
    if (weights[rarity] === 0) assert.equal(counts[rarity], 0, `${source} can never drop ${rarity}`)
  }
}
// The DESIGN rules, stated independently of the table. The distribution check above only proves the
// dice match the table; it would happily agree with a table someone broke. These pin the intent.
const share = (source: LootSource, rarity: Rarity) =>
  DROP_WEIGHTS[source][rarity] / RARITIES.reduce((s, r) => s + DROP_WEIGHTS[source][r], 0)
for (const rarity of ['common', 'uncommon', 'rare'] as const)
  assert.equal(DROP_WEIGHTS.supply[rarity], 0, `supply drops are epic or legendary only, never ${rarity}`)
assert.equal(DROP_WEIGHTS.chest.common, 0, 'chests never contain grey loot')
assert(share('supply', 'legendary') > share('chest', 'legendary') && share('chest', 'legendary') > share('floor', 'legendary'),
  'gold gets likelier from floor, to chest, to supply drop')
assert(share('floor', 'legendary') <= 0.05, 'floor gold stays genuinely rare')
assert(RARITIES.every(r => share('floor', 'legendary') <= share('floor', r)), 'on the floor, legendary is the rarest tier')

// Floating-point edge: a random() a hair under 1 must still return a tier the source can drop.
for (const source of Object.keys(DROP_WEIGHTS) as LootSource[]) {
  const r = rollRarity(source, () => 1 - Number.EPSILON)
  assert(DROP_WEIGHTS[source][r] > 0, `${source}: edge roll returned ${r}, which it cannot drop`)
}

// 4. End to end in the real weapon system.
function fixture() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, 200)
  camera.position.set(0, 1.7, 0); scene.add(camera)
  const world = new CollisionWorld(scene), shots: Shot[] = [], sounds: SoundEvent[] = []
  const weapons = new FirstPersonWeapons({ scene, camera, world, onShot: s => shots.push(s), emit: e => sounds.push(e) })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: v() }
  const step = (seconds: number) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) weapons.update(1 / 60, frame) }
  step(1 / 60)
  return { scene, weapons, shots, sounds, step, dispose() { weapons.dispose(); world.dispose() } }
}
const holding = (rarity?: Rarity): WeaponItem => ({ id: `test-ak-${rarity ?? 'none'}`, name: 'ak', magazine: 30, reserve: 90, ...(rarity ? { rarity } : {}) })

for (const rarity of [undefined, 'legendary'] as const) {
  const f = fixture()
  f.weapons.restore({ slots: [holding(rarity), null, null, null], selected: 0, pickups: [], nextId: 1 })
  f.step(0.5)
  f.weapons.trigger(true); f.step(1 / 60); f.weapons.trigger(false)
  assert(f.shots.length > 0, 'the AK fired')
  const expected = WEAPON_RULES.ak.damage * (rarity ? RARITY_INFO[rarity].damage : 1)
  assert(Math.abs(f.shots[0].damage - expected) < 1e-9, `${rarity ?? 'unrated'} AK shot damage ${f.shots[0].damage}, expected ${expected}`)
  if (rarity) assert.equal(f.weapons.label, 'Legendary AK rifle')
  else assert.equal(f.weapons.label, 'AK rifle')
  f.dispose()
}

// Faster reload is real, not just a number: a legendary finishes before a base AK does.
{
  const reloadTime = (rarity?: Rarity) => {
    const f = fixture()
    f.weapons.restore({ slots: [{ ...holding(rarity), magazine: 5 }, null, null, null], selected: 0, pickups: [], nextId: 1 })
    f.step(0.5)
    assert(f.weapons.reload(), 'reload started')
    let t = 0
    while (f.weapons.reloading && t < 10) { f.step(1 / 60); t += 1 / 60 }
    f.dispose()
    return t
  }
  const base = reloadTime(), legendary = reloadTime('legendary')
  assert(Math.abs(base - WEAPON_RULES.ak.reload) < 0.1, `base reload ~${WEAPON_RULES.ak.reload}s, measured ${base.toFixed(2)}`)
  assert(Math.abs(legendary - WEAPON_RULES.ak.reload * 0.8) < 0.1, `legendary reload ~${(WEAPON_RULES.ak.reload * 0.8).toFixed(2)}s, measured ${legendary.toFixed(2)}`)
}

// Beams: present on coloured loot, absent on grey, never colliding, and a pickup does not break
// the shared beam material for other loot of the same colour.
{
  const f = fixture()
  const beamOf = (id: string) => {
    let found: THREE.Object3D | undefined
    f.scene.traverse(o => { if (o.name === 'Rarity beam' && o.parent?.name.endsWith(`: ${id}`)) found = o })
    return found
  }
  f.weapons.addPickup({ id: 'grey', name: 'smg', magazine: 24, reserve: 0, rarity: 'common', position: [3, 0, 0] })
  f.weapons.addPickup({ id: 'gold-a', name: 'ak', magazine: 30, reserve: 0, rarity: 'legendary', position: [-3, 0, 0] })
  f.weapons.addPickup({ id: 'gold-b', name: 'sniper', magazine: 5, reserve: 0, rarity: 'legendary', position: [0, 0, 3] })
  assert.equal(beamOf('grey'), undefined, 'grey loot has no beam')
  const a = beamOf('gold-a'), b = beamOf('gold-b')
  assert(a && b, 'legendary loot has a beam')
  assert.equal(a!.userData.noCollision, true, 'a beam never blocks movement or shots')
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(a!.getWorldQuaternion(new THREE.Quaternion()))
  assert(up.y > 0.999, 'the beam stands vertical even though the gun lies on its side')
  const label = f.weapons.pickupTargets().find(t => t.id === 'gold-a')!.label
  assert.match(label, /Legendary AK rifle/, 'the pickup prompt names the rarity')
  const materialB = (b!.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
  f.dispose()
  assert(materialB.uniforms.color.value.getHex() === RARITY_INFO.legendary.color, 'shared beam material still holds its colour after disposal')
}

console.log('loot rarity checks passed')
