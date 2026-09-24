import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CollisionWorld } from '../src/player/collision'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { setDoorOpen } from '../src/world/doors'
import { CRAWL, ZombieDirector, type Zombie, type ZombieTarget } from '../src/game/zombies/director'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { zombieHealth } from '../src/game/zombies/rules'
import { GRENADE } from '../src/game/zombies/grenades'
import { InkRockets, ROCKET, rocketLoad, type RocketBurst } from '../src/game/zombies/rockets'
import { DEADLINE_ROUND, roundDamage, selfBlast } from '../src/game/zombies/blasts'
import { BOX_WEIGHTS, ROCKET_RESERVE, freshWeapon, rollBox, spareAmmo, startingPistol } from '../src/game/zombies/economy'
import { WEAPON_RULES, startingLoadout } from '../src/game/balance'
import { PACKED_NAMES, pierceOf, weaponRules } from '../src/game/loot'
import { firingHand, isAkimbo } from '../src/game/akimbo'
import { FirstPersonWeapons } from '../src/game/weapons'
import { seeded } from '../src/game/shared/random'
import type { Shot, SoundEvent, WeaponFrame, WeaponItem } from '../src/game/types'

/**
 * Dead Ink's weapons: explosives with a fixed damage (a frag kills a pack on round 3 and leaves crawlers on
 * round 8), the crawler cap, the Ink Rocket (its flight, its burst, its reload) and the Deadline (two
 * Magnums taking turns, explosive rounds). Runs on the real compound, zombies and weapon system.
 */

// Load the real stickman from disk (the loader normally fetches it over HTTP).
const bytes = readFileSync('public/models/stickman.glb')
GLTFLoader.prototype.loadAsync = async function () {
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
}
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const results: string[] = []
const pass = (label: string) => { results.push(label); console.log(`PASS ${label}`) }

const scene = new THREE.Scene()
const compound = createCompound(), mission = createMissionWorld(compound)
prepareCompound(compound)
scene.add(compound, mission.root)
const doors: THREE.Group[] = []
scene.traverse(o => { if (o.userData.kind === 'door') doors.push(o as THREE.Group) })
for (const door of doors) { door.userData.missionLocked = false; setDoorOpen(door, true, true) }
const world = new CollisionWorld(scene)
world.refresh()
const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
const director = new ZombieDirector({ scene, world, doors, graph, emit: () => {}, damagePlayer: () => {} })
await director.init(16)
const run = (seconds: number, targets: ZombieTarget[]) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) director.update(1 / 60, targets) }

// The mess yard, open ground round the spawn; a frag lies on the floor there (grenades.ts leaves it 6 cm up).
const yard = graph.point(graph.nearest(v(-30, 0, -25), 4))
const frag = yard.clone().setY(yard.y + 0.06)
/** A pack round the frag: four close in, four out toward the edge of its blast. [metres out, angle] */
const RING: [number, number][] = [[0.8, 0.3], [1.2, 2.4], [2.0, 4.1], [2.4, 5.5], [3.6, 1.1], [4.2, 3.0], [4.6, 4.8], [5.1, 0.2]]
function pack(round: number) {
  director.clear()
  const zombies = RING.map(([d, a]) => director.spawn(yard.clone().add(v(Math.cos(a) * d, 0, Math.sin(a) * d)), zombieHealth(round), 'walk', 0))
  assert(zombies.every(Boolean), 'the whole pack stands on the yard')
  run(0.1, [])
  return zombies as Zombie[]
}
const crawling = () => director.zombies.filter(z => z.state === 'chase' && z.crawler)

// ---- 1. A frag's damage is fixed: a pack dies early, the edges live later and some crawl ----------------
{
  director.random = seeded(3)
  const early = pack(3)
  const hits = director.blast(frag, GRENADE.radius, GRENADE.damage)
  assert.equal(hits.length, early.length, `the frag reaches the whole pack (${hits.length})`)
  assert(early.every(z => z.state === 'dead'), 'round 3: a frag kills the whole pack')
  const five = pack(5)
  director.blast(frag, GRENADE.radius, GRENADE.damage)
  assert(five.every(z => z.state === 'dead'), 'round 5: still the whole pack, out to the edge')
  const six = pack(6)
  director.blast(frag, GRENADE.radius, GRENADE.damage)
  assert(six.slice(0, 7).every(z => z.state === 'dead') && six[7].state === 'chase', 'round 6: only the one at the very edge lives')
  pass('A frag kills a whole pack through round 5; on round 6 the edge of its blast starts to live')

  let crawlers = 0, survivors = 0
  for (let trial = 0; trial < 6; trial++) {
    director.random = seeded(80 + trial)
    const late = pack(8)
    director.blast(frag, GRENADE.radius, GRENADE.damage)
    assert(late.slice(0, 4).every(z => z.state === 'dead'), `round 8: the four close in die (trial ${trial})`)
    assert(late.slice(4).every(z => z.state === 'chase'), `round 8: the four out at the edge live (trial ${trial})`)
    survivors += late.filter(z => z.state === 'chase').length
    crawlers += crawling().length
    assert(crawling().every(z => late.slice(4).includes(z)), 'only survivors crawl')
  }
  // Each survivor loses its legs about 45% of the time (GORE_ODDS.blastCrawl): 24 survivors, ~11 crawlers.
  assert(crawlers >= 5 && crawlers <= 18, `round 8: frags leave crawlers (${crawlers} of ${survivors} survivors)`)
  pass(`Round 8: the frag kills the middle of the pack and leaves the edges alive, ${crawlers} of ${survivors} of them crawling`)

  const eleven = pack(11)
  director.blast(frag, GRENADE.radius, GRENADE.damage)
  assert(eleven.every(z => z.state === 'chase'), 'round 11: a frag alone no longer kills')
  director.random = Math.random
  pass('Round 11: a frag on its own no longer kills')
}

// ---- 2. Crawlers still come for you, and never too many at once ----------------------------------------
{
  director.random = () => 0
  const late = pack(8)
  director.blast(frag, GRENADE.radius, GRENADE.damage)
  director.random = Math.random
  const crawlers = crawling()
  assert.equal(crawlers.length, 4, 'every survivor crawls when the dice say so')
  const player: ZombieTarget = { id: 'p1', feet: yard.clone().add(v(-7, 0, 0)), alive: true }
  player.feet.y = world.floor(player.feet.clone().setY(player.feet.y + 0.6), 1, 1.5, 0.28)
  let t = 0
  const gap = (z: Zombie) => Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z)
  while (t < 20 && crawlers.some(z => gap(z) > CRAWL.attack.range + 0.3 && !z.stranded)) { run(0.25, [player]); t += 0.25 }
  assert(crawlers.every(z => gap(z) <= CRAWL.attack.range + 0.3), `the crawlers reach the player (${crawlers.map(z => gap(z).toFixed(1)).join(', ')} m after ${t} s)`)
  assert(late.slice(4).every(z => z.state === 'chase'), 'crawling all the way')
  pass(`Crawlers made by a frag crawl on to the player (all there in ${t} s)`)

  // A big pack late on, the dice always saying legs: at most CRAWL.most crawl at once, the rest lose an arm.
  director.clear()
  director.random = () => 0
  const crowd: Zombie[] = []
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2, d = 1.5 + (i % 3) * 0.7
    const z = director.spawn(yard.clone().add(v(Math.cos(a) * d, 0, Math.sin(a) * d)), zombieHealth(20), 'walk', 0)
    if (z) crowd.push(z)
  }
  run(0.1, [])
  director.blast(frag, GRENADE.radius, GRENADE.damage)
  director.blast(frag, GRENADE.radius, GRENADE.damage)
  director.random = Math.random
  assert(crowd.length >= 10 && crowd.every(z => z.state === 'chase'), 'round 20: two frags kill none of them')
  assert.equal(crawling().length, CRAWL.most, `never more than ${CRAWL.most} crawling at once (${crawling().length})`)
  assert(crowd.filter(z => !z.crawler).every(z => z.lost.L || z.lost.R), 'the rest lose an arm instead')
  director.clear()
  pass(`Crawlers are capped at ${CRAWL.most} at once: past that a blast takes an arm, not the legs`)
}

// ---- 3. The Ink Rocket: its numbers, its flight, its burst ----------------------------------------------
{
  const plain = rocketLoad({ name: 'rocket' }), ram = rocketLoad({ name: 'rocket', packed: true, packLevel: 1 })
  assert(plain.radius > GRENADE.radius && ram.radius > plain.radius, 'a rocket out-blasts a frag, and the Press Ram a rocket')
  assert(plain.damage === ROCKET.damage && ram.damage === ROCKET.damage * 2 && ram.packed && !plain.packed, 'the Press Ram hits twice as hard')
  assert(Math.abs(rocketLoad({ name: 'rocket', rarity: 'legendary' }).damage - ROCKET.damage * 1.2) < 1e-9, 'rarity lifts the burst as it lifts a bullet')
  assert.equal(PACKED_NAMES.rocket, 'Press Ram')
  assert.equal(weaponRules({ name: 'rocket' }).capacity, 1, 'one rocket to a load')
  assert.equal(weaponRules({ name: 'rocket', packed: true }).capacity, 2, 'the Press Ram loads two')
  assert.equal(weaponRules({ name: 'rocket', packed: true }).label, 'Press Ram')
  // Round 10: a rocket clears a pack out to its edge; round 14: the edge lives, and some of it crawls.
  director.random = seeded(10)
  const ten = pack(10)
  director.blast(frag, plain.radius, plain.damage)
  assert(ten.every(z => z.state === 'dead'), 'round 10: a rocket kills the whole pack')
  let crawlers = 0
  for (let trial = 0; trial < 4; trial++) {
    director.random = seeded(140 + trial)
    const late = pack(14)
    director.blast(frag, plain.radius, plain.damage)
    assert(late.slice(0, 4).every(z => z.state === 'dead') && late.slice(6).every(z => z.state === 'chase'), `round 14: the middle dies, the edge lives (trial ${trial})`)
    crawlers += crawling().length
  }
  assert(crawlers >= 2, `round 14: rockets leave crawlers too (${crawlers})`)
  director.random = Math.random
  pass(`A rocket clears a pack on round 10; on round 14 its edge lives and crawls (${crawlers} crawlers in 4 shots)`)

  // Flight, in the real compound: fired down the longest open line from the yard at a wall.
  const eye = yard.clone().setY(yard.y + 1.5)
  let aim = v(), wall = 0
  for (let i = 0; i < 32; i++) {
    const yaw = i / 32 * Math.PI * 2, dir = v(-Math.sin(yaw), 0, -Math.cos(yaw))
    const hit = world.raySurface(eye, dir, 70)
    if (hit && hit.distance > wall && hit.distance < 60) { wall = hit.distance; aim = dir }
  }
  assert(wall > 12, `a wall to fire at (${wall.toFixed(1)} m)`)
  director.clear()
  const rockets = new InkRockets(scene, world, (o, d, max) => director.aimDistance(o, d, max))
  rockets.fire(eye, aim, plain)
  assert.equal(rockets.count, 1)
  const first = rockets.inFlight[0].position.clone()
  const flown: RocketBurst[] = []
  let t = 0, top = 0, puffs = 0, mid: THREE.Vector3 | null = null
  while (!flown.length && t < ROCKET.life + 0.5) {
    flown.push(...rockets.update(1 / 60)); t += 1 / 60
    if (rockets.count) { top = Math.max(top, rockets.inFlight[0].speed); puffs = Math.max(puffs, rockets.trailPuffs) }
    if (!mid && t >= 0.2 && rockets.count) mid = rockets.inFlight[0].position.clone()
  }
  assert.equal(flown.length, 1, 'the rocket bursts')
  const burst = flown[0]
  assert(mid && mid.distanceTo(first) > 3 && mid.distanceTo(first) < 9, `it is in flight a moment, visible (${mid?.distanceTo(first).toFixed(1)} m in 0.2 s)`)
  assert(top > ROCKET.speed + 10, `its motor speeds it up (${top.toFixed(0)} m/s)`)
  const flewTo = burst.at.distanceTo(eye)
  assert(flewTo < wall && flewTo > wall - 0.4, `it bursts on the near side of the wall (${flewTo.toFixed(2)} of ${wall.toFixed(2)} m)`)
  assert(puffs >= 10, `it trails smoke (${puffs} puffs)`)
  assert.equal(rockets.count, 0)
  let models = 0
  scene.traverse(o => { if (o.name === 'Ink Rocket rocket') models++ })
  assert.equal(models, 0, 'and is gone from the scene')
  // At a zombie in the way: it bursts on the body, not the wall behind it.
  const target = director.spawn(yard.clone().addScaledVector(aim, 9), 5000, 'walk', 0)!
  run(0.1, [])
  const chest = target.position.clone().setY(target.position.y + 1.2)
  rockets.fire(eye, chest.clone().sub(eye).normalize(), ram)
  flown.length = 0
  for (let i = 0; i < 120 && !flown.length; i++) flown.push(...rockets.update(1 / 60))
  assert(flown.length === 1 && flown[0].at.distanceTo(chest) < 0.9 && flown[0].packed, `a rocket bursts on the zombie it hits (${flown[0]?.at.distanceTo(chest).toFixed(2)} m from its chest)`)
  rockets.update(1.6)
  rockets.dispose()
  director.clear()
  pass(`The Ink Rocket flies (up to ${top.toFixed(0)} m/s), trails ink smoke and bursts on the first wall or zombie it touches`)
}

// ---- 4. Your own blast: a round at your feet hurts, one across the yard does not ------------------------
{
  const feet = yard.clone(), eye = feet.clone().setY(feet.y + 1.7)
  const close = selfBlast(world, feet.clone().add(v(0.4, 0.05, 0)), feet, eye, DEADLINE_ROUND.selfRadius, DEADLINE_ROUND.selfDamage)
  assert(close > DEADLINE_ROUND.selfDamage * 0.5, `a Deadline round at your feet hurts (${close.toFixed(0)})`)
  assert.equal(selfBlast(world, feet.clone().add(v(6, 0.05, 0)), feet, eye, DEADLINE_ROUND.selfRadius, DEADLINE_ROUND.selfDamage), 0, 'one 6 m off does not')
  const rocket = selfBlast(world, feet.clone().add(v(1, 0.05, 0)), feet, eye, ROCKET.radius * ROCKET.selfRadius, ROCKET.selfDamage)
  assert(rocket > 50 && rocket < 100, `a rocket at your feet takes most of your health (${rocket.toFixed(0)} of 100)`)
  pass(`Your own blast hurts you close up: ${close.toFixed(0)} from a Deadline round at your feet, ${rocket.toFixed(0)} from a rocket`)
}

// ---- 5. The Deadline: two Magnums taking turns, explosive rounds ------------------------------------------
{
  const deadline: WeaponItem = { id: 'deadline', name: 'magnum', magazine: 12, reserve: 96, packed: true, packLevel: 1 }
  assert(isAkimbo(deadline) && !isAkimbo({ name: 'magnum' }) && !isAkimbo({ name: 'ak', packed: true }), 'only the upgraded Magnum is held akimbo')
  const rules = weaponRules(deadline)
  assert(rules.capacity === 12 && rules.interval < WEAPON_RULES.magnum.interval && rules.label === 'Deadline', 'twelve rounds, six a gun, and quicker between shots')
  assert.equal(weaponRules({ name: 'magnum' }).capacity, 6, 'a plain Magnum is untouched')
  assert.equal(pierceOf(deadline), 1, 'its rounds burst in the first body')
  assert.equal(pierceOf({ name: 'magnum' }), 2, 'a plain Magnum still goes through one')
  assert(firingHand(12, 12) === 'right' && firingHand(11, 12) === 'left' && firingHand(10, 12) === 'right', 'right, left, right')
  assert.equal(roundDamage(deadline), DEADLINE_ROUND.damage)
  assert(roundDamage({ ...deadline, packLevel: 3 }) > roundDamage(deadline), 'more with each upgrade')
  assert(DEADLINE_ROUND.radius <= 2 && DEADLINE_ROUND.radius >= 1.5 && DEADLINE_ROUND.damage < GRENADE.damage / 2, 'a small splash, a fraction of a frag')
  // Its burst on round 2 takes the zombie it struck and the one beside it, and nothing 2.6 m off.
  director.clear()
  director.random = seeded(5)
  const at = yard.clone().add(v(2, 0, 2))
  const struck = director.spawn(at, zombieHealth(2), 'walk', 0)!, beside = director.spawn(at.clone().add(v(0.8, 0, 0)), zombieHealth(2), 'walk', 0)!
  const apart = director.spawn(at.clone().add(v(-2.6, 0, 0)), zombieHealth(2), 'walk', 0)!
  run(0.1, [])
  director.blast(struck.position.clone().setY(struck.position.y + 1.1), DEADLINE_ROUND.radius, roundDamage(deadline))
  assert(struck.state === 'dead' && beside.state === 'dead', 'a round bursts on its zombie and takes the one beside it')
  assert(apart.state === 'chase' && apart.health === zombieHealth(2), 'and nothing 2.6 m off')
  director.random = Math.random
  director.clear()
  pass('The Deadline: 12 rounds, the hands take turns, each round bursts in a small splash in the first body it strikes')
}

// ---- 6. In the real weapon system: two guns firing in turn, and the launcher's reload --------------------
{
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, 200)
  const fpScene = new THREE.Scene()
  camera.position.set(0, 1.7, 0); fpScene.add(camera)
  const fpWorld = new CollisionWorld(fpScene), shots: Shot[] = [], sounds: SoundEvent[] = []
  const weapons = new FirstPersonWeapons({ scene: fpScene, camera, world: fpWorld, onShot: s => shots.push(s), emit: e => sounds.push(e) })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: v() }
  const step = (seconds: number) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) weapons.update(1 / 60, frame) }
  const fire = () => { weapons.trigger(true); step(1 / 60); weapons.trigger(false) }
  const findLeft = () => { let found: THREE.Object3D | null = null; camera.traverse(o => { if (o.name === 'Left hand revolver') found = o }); return found as THREE.Object3D | null }
  // A plain Magnum: one gun.
  weapons.restore({ slots: [{ id: 'm', name: 'magnum', magazine: 6, reserve: 24 }, null], selected: 0, pickups: [], nextId: 1 })
  step(0.5)
  assert.equal(findLeft(), null, 'a plain Magnum is one gun')
  // The Deadline: two, the left the right's mirror image, firing in turn from either side of the view.
  weapons.restore({ slots: [{ id: 'd', name: 'magnum', magazine: 12, reserve: 96, packed: true, packLevel: 1 }, null], selected: 0, pickups: [], nextId: 1 })
  step(0.5)
  const left = findLeft()
  assert(left && left.visible && left.getObjectByName('Left hand mitten')!.scale.x < 0, 'the Deadline puts a second Magnum in the left hand, held by a left hand')
  const side = (shot: Shot) => camera.worldToLocal(shot.origin.clone()).x
  for (let i = 0; i < 4; i++) { fire(); step(weaponRules({ name: 'magnum', packed: true }).interval + 0.05) }
  assert.equal(shots.length, 4, `four shots (${shots.length})`)
  const sides = shots.map(side)
  assert(sides[0] > 0.05 && sides[1] < -0.05 && sides[2] > 0.05 && sides[3] < -0.05, `right, left, right, left (${sides.map(x => x.toFixed(2)).join(', ')})`)
  assert.equal(weapons.current!.magazine, 8, 'the magazine counts both guns')
  // Empty both, reload: twelve again, both guns still there.
  for (let i = 0; i < 8; i++) { fire(); step(0.35) }
  assert.equal(weapons.current!.magazine, 0)
  assert(weapons.reload(), 'reload')
  let t = 0
  while (weapons.reloading && t < 6) { step(1 / 60); t += 1 / 60 }
  assert(weapons.current!.magazine === 12 && weapons.current!.reserve === 84 && findLeft()?.visible, `both reloaded: ${weapons.current!.magazine}/${weapons.current!.reserve}`)
  // Swapped away, the left gun goes with it.
  weapons.restore({ slots: [{ id: 'a', name: 'ak', magazine: 30, reserve: 90 }, null], selected: 0, pickups: [], nextId: 1 })
  step(0.5)
  assert.equal(findLeft(), null, 'no second gun with anything else')
  pass('In hand, the Deadline is two Magnums: shots alternate right and left, both reload, and it goes away with the gun')

  // The Ink Rocket: fire, the warhead is gone, the launcher reloads itself and the warhead slides back in.
  shots.length = 0; sounds.length = 0
  weapons.restore({ slots: [{ ...freshWeapon('r', 'rocket') }, null], selected: 0, pickups: [], nextId: 1 })
  step(0.5)
  const warhead = weapons.heldModel!.userData.parts.warhead
  assert(warhead && warhead.visible, 'a loaded launcher shows its warhead')
  fire()
  assert(shots.length === 1 && shots[0].weapon === 'rocket' && weapons.current!.magazine === 0, 'one shot empties it')
  assert(sounds.some(s => s.kind === 'shot-rocket'), 'with its own launch sound')
  step(0.1)
  assert(!warhead.visible, 'the warhead has gone')
  step(WEAPON_RULES.rocket.interval)
  assert(weapons.reloading, 'it reloads by itself once the rocket is away')
  step(WEAPON_RULES.rocket.reload * 0.3)
  const sliding = warhead.visible ? warhead.position.clone() : null
  step(WEAPON_RULES.rocket.reload * 0.75)
  assert(!weapons.reloading && weapons.current!.magazine === 1 && weapons.current!.reserve === ROCKET_RESERVE.fresh - 1, `loaded again: ${weapons.current!.magazine}/${weapons.current!.reserve}`)
  assert(sliding && sliding.distanceTo(warhead.position) > 0.05 && warhead.visible, 'a fresh warhead slides in during the reload')
  weapons.dispose(); fpWorld.dispose()
  pass('In hand, the Ink Rocket fires once, reloads by itself, and a fresh warhead slides into its mouth')
}

// ---- 7. Ammo, the box, and the hostage mission never sees the launcher ------------------------------------
{
  assert.equal(freshWeapon('r', 'rocket').reserve, ROCKET_RESERVE.fresh, 'a rocket launcher comes with ten spare')
  assert.equal(spareAmmo({ name: 'rocket', packed: true }), ROCKET_RESERVE.packed)
  assert(spareAmmo({ name: 'ak' }) === 120 && spareAmmo({ name: 'ak', packed: true }) === 240, 'other guns keep their four magazines')
  assert.equal(spareAmmo({ name: 'magnum', packed: true }), 96, 'the Deadline, twice its fuller load')
  assert.equal(BOX_WEIGHTS.rocket, Math.min(...Object.values(BOX_WEIGHTS)), 'the rocket is the rarest box gun')
  const random = seeded(7), held = [startingPistol(), null]
  let rockets = 0
  for (let i = 0; i < 20000; i++) if (rollBox(random, held).name === 'rocket') rockets++
  const expected = 0.95 * BOX_WEIGHTS.rocket / Object.entries(BOX_WEIGHTS).filter(([name]) => name !== 'pistol').reduce((sum, [, w]) => sum + w, 0)
  assert(Math.abs(rockets / 20000 - expected) < 0.008, `the box gives it about ${(expected * 100).toFixed(1)}% of the time (${(rockets / 200).toFixed(1)}%)`)
  const carrying = [startingPistol(), freshWeapon('r', 'rocket')]
  for (let i = 0; i < 5000; i++) assert.notEqual(rollBox(random, carrying).name, 'rocket', 'never a second one')
  assert(mission.enemies.every(e => (e.weapon as string) !== 'rocket'), 'no guard in the hostage mission carries it')
  assert(startingLoadout().every(item => item.name !== 'rocket'), 'nor is it in the mission loadout')
  pass(`The box gives the Ink Rocket about ${(expected * 100).toFixed(1)}% of the time with ${ROCKET_RESERVE.fresh} spare; the hostage mission never has it`)
}

director.dispose()
world.dispose()
console.log(`zombies weapons checks passed (${results.length})`)
