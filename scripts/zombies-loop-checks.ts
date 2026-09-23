import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { MAX_ALIVE, POWERUPS, ROUND_BREAK, isBossRound, isStormRound, zombiesInRound } from '../src/game/zombies/rules'
import { DROPPED_KINDS, PowerupDropper } from '../src/game/zombies/powerups'
import { FIRST_ROUND_DELAY, newGame, returnSpawns, stepRounds } from '../src/game/zombies/rounds'
import { BOX_WEIGHTS, RESERVE_MAGAZINES, WALL_WEAPONS, ZOMBIE_SLOTS, freshWeapon, pointsForHit, rollBox, startingPistol, wallOffer } from '../src/game/zombies/economy'
import { SHEET, findWallSpots } from '../src/game/zombies/placement'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { seeded } from '../src/game/shared/random'
import { FirstPersonWeapons } from '../src/game/weapons'
import { WEAPON_RULES } from '../src/game/balance'
import { RARITIES, weaponRules } from '../src/game/loot'
import { CollisionWorld } from '../src/player/collision'
import type { WeaponFrame, WeaponName } from '../src/game/types'
import { buildNavScene } from './nav-scene'

// ---- 1. The round loop ---------------------------------------------------------------------------
/** Simulate a round, killing zombies at `killRate` per second, with a zombie cap of MAX_ALIVE. */
function playRound(players: number, killRate = 3, fps = 30) {
  const state = newGame()
  let alive = 0, spawned = 0, peak = 0, t = 0, killTimer = 0
  const log: string[] = []
  while (t < 600) {
    const events = stepRounds(state, 1 / fps, alive, players)
    if (events.roundStarted) log.push(`start ${events.roundStarted}`)
    alive += events.spawn; spawned += events.spawn
    peak = Math.max(peak, alive)
    killTimer += 1 / fps
    while (killTimer >= 1 / killRate && alive > 0) { alive--; killTimer -= 1 / killRate }
    if (events.roundEnded) { log.push(`end ${events.roundEnded}`); break }
    t += 1 / fps
  }
  return { state, spawned, peak, t, log }
}
{
  const solo = playRound(1)
  assert.deepEqual(solo.log, ['start 1', 'end 1'], 'round 1 starts and ends')
  assert.equal(solo.spawned, zombiesInRound(1, 1), 'round 1 sends exactly its zombie count')
  assert.equal(solo.state.phase, 'break')
  assert.equal(solo.state.timer, ROUND_BREAK, 'then a break before round 2')
  assert(solo.t >= FIRST_ROUND_DELAY, 'round 1 waits for the opening delay')
}
{
  // A late round with a slow killer: the cap must hold, and every zombie of the round must still come.
  const state = newGame()
  state.round = 19; state.timer = 0.01
  let alive = 0, spawned = 0, peak = 0, killTimer = 0
  for (let i = 0; i < 30 * 900; i++) {
    const e = stepRounds(state, 1 / 30, alive, 2)
    alive += e.spawn; spawned += e.spawn; peak = Math.max(peak, alive)
    killTimer += 1 / 30
    while (killTimer >= 0.5 && alive > 0) { alive--; killTimer -= 0.5 }
    if (e.roundEnded) break
  }
  assert.equal(state.round, 20)
  assert.equal(spawned, zombiesInRound(20, 2), `round 20 duo sends ${zombiesInRound(20, 2)} zombies in total`)
  assert(peak <= MAX_ALIVE, `never more than ${MAX_ALIVE} alive at once (peak ${peak})`)
}
{
  // Spawns that could not be placed come back: the round does not end short.
  const state = newGame()
  state.timer = 0.01
  let alive = 0, placed = 0
  for (let i = 0; i < 30 * 120; i++) {
    const e = stepRounds(state, 1 / 30, alive, 1)
    const failed = i % 3 === 0 ? e.spawn : 0      // every third batch fails to find a spot
    returnSpawns(state, failed)
    alive += e.spawn - failed; placed += e.spawn - failed
    if (alive > 0 && i % 20 === 0) alive--
    if (e.roundEnded) break
  }
  assert.equal(placed, zombiesInRound(1, 1), 'failed spawns are retried until the whole round has come')
}
{
  // Frame rate does not change the round.
  const counts = [15, 30, 60, 144].map(fps => playRound(1, 3, fps).spawned)
  assert(counts.every(c => c === zombiesInRound(1, 1)), `every frame rate spawns the same round (${counts})`)
}

// Difficulty's spawn speed: a faster setting feeds the same round in sooner.
{
  const spawnedAfter = (scale: number) => {
    const state = newGame()
    let spawned = 0
    for (let t = 0; t < FIRST_ROUND_DELAY + 6; t += 1 / 30) spawned += stepRounds(state, 1 / 30, 0, 1, scale).spawn
    return spawned
  }
  assert(spawnedAfter(0.5) > spawnedAfter(1) && spawnedAfter(1) >= spawnedAfter(1.5), 'a faster difficulty spawns sooner')
}

// ---- 2. Points and the wall ----------------------------------------------------------------------
assert.equal(pointsForHit({ lethal: false, zone: 'torso' }), 10)
assert.equal(pointsForHit({ lethal: false, zone: 'head' }), 10, 'a headshot that does not kill is still a hit')
assert.equal(pointsForHit({ lethal: true, zone: 'torso' }), 60)
assert.equal(pointsForHit({ lethal: true, zone: 'head' }), 100)
assert.equal(pointsForHit({ lethal: true, zone: 'torso', knife: true }), 130)
assert.equal(pointsForHit({ lethal: true, zone: 'head' }, true), 200, 'double points')

const start = startingPistol()
assert.equal(start.name, 'pistol')
assert.equal(start.rarity, undefined, 'the starting pistol is plain')
{
  const ak = WALL_WEAPONS.find(w => w.name === 'ak')!
  assert.equal(wallOffer('ak', ak.price, [start, null]).kind, 'buy')
  assert.equal(wallOffer('ak', ak.price, [start, null]).cost, ak.price)
  const worn = { ...freshWeapon('x', 'ak'), magazine: 3, reserve: 10 }
  const ammo = wallOffer('ak', ak.price, [start, worn])
  assert.equal(ammo.kind, 'ammo'); assert.equal(ammo.cost, Math.ceil(ak.price / 2), 'ammo is half price')
  assert.equal(wallOffer('ak', ak.price, [start, freshWeapon('y', 'ak')]).kind, 'full', 'a full gun is not sold ammo')
  // Owning a coloured version still buys ammo, not a second gun.
  assert.equal(wallOffer('ak', ak.price, [start, { ...worn, rarity: 'legendary' }]).kind, 'ammo')
}
assert.equal(freshWeapon('z', 'smg').reserve, WEAPON_RULES.smg.capacity * RESERVE_MAGAZINES)

// ---- 3. The Mystery Box --------------------------------------------------------------------------
{
  const random = seeded(90210)
  const held = [start, freshWeapon('h', 'ak')]
  const names: Record<string, number> = {}, rarities: Record<string, number> = {}
  const draws = 20000
  for (let i = 0; i < draws; i++) {
    const roll = rollBox(random, held)
    // The Ink Ray is its own weapon, whatever handling it borrows.
    const kind = roll.special ?? roll.name
    names[kind] = (names[kind] ?? 0) + 1
    rarities[roll.rarity] = (rarities[roll.rarity] ?? 0) + 1
  }
  assert(!names.pistol && !names.ak, 'the box never gives a gun you are carrying')
  const rays = names.rayGun ?? 0
  assert(rays > draws * 0.03 && rays < draws * 0.07, `the Ink Ray is a rare draw (${(rays / draws * 100).toFixed(1)}%)`)
  assert(!rarities.common, 'the box never gives grey')
  // Ordinary guns: gold is rare among them, and each comes up in proportion to its weight.
  const ordinary = draws - rays, gold = rarities.legendary - rays
  assert(gold > 0 && gold < ordinary * 0.12, `gold is rare (${gold} of ${ordinary})`)
  const pool = (['smg', 'shotgun', 'sniper', 'magnum', 'lmg'] as WeaponName[]), total = pool.reduce((s, n) => s + BOX_WEIGHTS[n], 0)
  for (const n of pool) assert(Math.abs(names[n] / ordinary - BOX_WEIGHTS[n] / total) < 0.015, `${n} share`)
  for (const r of Object.keys(rarities)) assert(RARITIES.includes(r as never))
}

// ---- 4. Giving and refilling weapons -------------------------------------------------------------
{
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.06, 200)
  camera.position.set(0, 1.7, 0); scene.add(camera)
  const world = new CollisionWorld(scene)
  const weapons = new FirstPersonWeapons({ scene, camera, world, onShot: () => {}, emit: () => {} })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: new THREE.Vector3() }
  const step = (s: number) => { for (let i = 0; i < Math.ceil(s * 60); i++) weapons.update(1 / 60, frame) }
  weapons.restore({ slots: [startingPistol(), null], selected: 0, pickups: [], nextId: 1 })
  step(0.3)
  assert.equal(weapons.slots.length, ZOMBIE_SLOTS, 'two slots, as in Call of Duty')
  assert.equal(weapons.give(freshWeapon('smg-1', 'smg')), 1, 'a bought gun goes into the empty slot')
  step(0.3)
  assert.equal(weapons.current?.name, 'smg', 'and is put in your hands')
  weapons.switchSlot(0); step(0.3)
  assert.equal(weapons.give(freshWeapon('box-1', 'shotgun', 'epic')), 0, 'with both slots full it replaces the gun in your hands')
  step(0.3)
  assert.deepEqual(weapons.slots.map(s => s?.name), ['shotgun', 'smg'])
  assert.equal(weapons.slots[0]?.rarity, 'epic', 'rarity comes with it')
  weapons.slots[1]!.magazine = 2; weapons.slots[1]!.reserve = 5
  assert(weapons.refill('smg', 999, 96), 'refilling a carried gun works')
  assert.equal(weapons.slots[1]!.magazine, WEAPON_RULES.smg.capacity, 'magazine never exceeds capacity')
  assert.equal(weapons.slots[1]!.reserve, 96)
  assert.equal(weapons.refill('sniper', 5, 20), false, 'refilling a gun you do not carry does nothing')
  weapons.dispose(); world.dispose()
}

// ---- 4b. Power-up drops ---------------------------------------------------------------------------
{
  // Kills worth 60 each: the first guaranteed drop comes once 2000 points are earned.
  const never = () => 0.999
  const dropper = new PowerupDropper(never)
  let earned = 0, first = -1
  for (let kill = 1; kill <= 40 && first < 0; kill++) { earned += 60; if (dropper.onKill(earned)) first = earned }
  assert(first >= POWERUPS.firstThreshold && first < POWERUPS.firstThreshold + 60, `first drop at ${first} points earned`)
  // The next one needs 14% more on top.
  let second = -1
  for (let kill = 1; kill <= 80 && second < 0; kill++) { earned += 60; if (dropper.onKill(earned)) second = earned }
  const gap = second - first
  assert(gap >= POWERUPS.firstThreshold * POWERUPS.thresholdGrowth - 60 && gap <= POWERUPS.firstThreshold * POWERUPS.thresholdGrowth + 60, `the next drop needs ${gap} more`)
  // At most four a round, however lucky.
  const lucky = new PowerupDropper(() => 0)
  let dropped = 0
  for (let kill = 0; kill < 50; kill++) if (lucky.onKill(0)) dropped++
  assert.equal(dropped, POWERUPS.maxPerRound, 'never more than four drops a round')
  lucky.newRound()
  assert(lucky.onKill(0), 'a new round allows drops again')
  // The bag: every kind once before any repeats.
  const bag = new PowerupDropper(seeded(9))
  const kinds: string[] = []
  for (let round = 0; round < 3; round++) { bag.newRound(); for (let i = 0; i < 4; i++) { const k = bag.onKill(1e9 * (round * 4 + i + 1)); if (k) kinds.push(k) } }
  assert.deepEqual([...kinds.slice(0, DROPPED_KINDS.length)].sort(), [...DROPPED_KINDS].sort(), `every power-up once before a repeat (${kinds.join(', ')})`)
  assert(!DROPPED_KINDS.includes('carpenter'), 'no Carpenter while the map has no barricades')
  // The Death Machine: a minigun on the AK's handling.
  const dm = weaponRules({ name: 'ak', special: 'deathMachine' })
  assert(dm.label === 'Death Machine' && dm.automatic && dm.interval < WEAPON_RULES.ak.interval / 2 && dm.damage > WEAPON_RULES.ak.damage, 'the Death Machine fires fast and hits hard')
}

// ---- 5. Wall spots on the real compound -----------------------------------------------------------
{
  const { world } = buildNavScene()
  const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
  const spawn = new THREE.Vector3(-30, 0, -25)
  spawn.y = world.floor(spawn.clone().setY(0.6), 1, 1.5, 0.28)
  graph.flow([spawn])
  const spots = findWallSpots(graph, world, seeded(5), { count: 5, near: 6, far: 70, spacing: 9 })
  assert.equal(spots.length, 5, 'found five wall spots within reach of the spawn')
  for (const spot of spots) {
    assert(Number.isFinite(spot.walk) && spot.walk <= 70, 'reachable on foot from the spawn')
    assert(Math.abs(spot.normal.y) < 1e-6 && Math.abs(spot.normal.length() - 1) < 1e-6, 'wall normal is flat and unit length')
    const toWall = spot.wall.clone().sub(spot.stand).setY(0)
    assert(toWall.length() < 1.4 && toWall.normalize().dot(spot.normal) < -0.7, 'the wall faces the standing spot, within reach')
    // The standing spot really has floor and room for a body.
    const floor = world.floor(spot.stand.clone().setY(spot.stand.y + 0.4), 0.6, 1, 0.25)
    assert(Number.isFinite(floor) && Math.abs(floor - spot.stand.y) < 0.15, 'floor under the standing spot')
    // The sheet's whole face is plain wall (no window, sill or corner), checked on a denser grid than
    // the placement code uses, so the check does not merely repeat the implementation.
    const into = spot.normal.clone().negate(), tangent = new THREE.Vector3(spot.normal.z, 0, -spot.normal.x)
    const depth = spot.wall.clone().sub(spot.stand).dot(into)
    for (let a = -SHEET.halfWidth; a <= SHEET.halfWidth + 1e-9; a += SHEET.halfWidth / 4) for (let h = SHEET.bottom; h <= SHEET.top + 1e-9; h += (SHEET.top - SHEET.bottom) / 6) {
      const hit = world.raySurface(spot.stand.clone().addScaledVector(tangent, a).setY(spot.stand.y + h), into, depth + 0.3)
      assert(hit && Math.abs(hit.distance - depth) < 0.08, `sheet area at ${a.toFixed(2)}, ${h.toFixed(2)} is plain wall`)
    }
  }
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++)
    assert(spots[i].stand.distanceTo(spots[j].stand) >= 9 - 1e-6, 'spots are spread out')
  assert.deepEqual(findWallSpots(graph, world, seeded(5), { count: 5, near: 6, far: 70, spacing: 9 }).map(s => s.wall.toArray()),
    spots.map(s => s.wall.toArray()), 'the same seed gives the same layout')
  console.log(`zombies loop checks passed; wall spots at walking distances ${spots.map(s => s.walk.toFixed(0)).join(', ')} m`)
  world.dispose()
}

// Ink Storm rounds: round 7 and every seventh after, never a Brute round.
{
  const storms = Array.from({ length: 50 }, (_, i) => i + 1).filter(isStormRound)
  assert.deepEqual(storms.slice(0, 4), [7, 14, 21, 28], `storms on ${storms.slice(0, 4)}`)
  assert(!storms.some(isBossRound), 'a storm never lands on a Brute round')
  assert(!storms.includes(35), 'round 35 is the Brute round')
}
