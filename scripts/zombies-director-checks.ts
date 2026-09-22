import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CollisionWorld } from '../src/player/collision'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { setDoorOpen } from '../src/world/doors'
import { ATTACK, CORPSE, RISE, ZombieDirector, type ZombieTarget } from '../src/game/zombies/director'
import { PLAYER_HEALTH, ZOMBIE_DAMAGE_SCALE } from '../src/game/zombies/rules'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { pickSpawn } from '../src/game/zombies/spawn'
import { seeded } from '../src/game/shared/random'
import type { Shot, SoundEvent } from '../src/game/types'

// Load the real stickman from disk (the loader normally fetches it over HTTP).
const bytes = readFileSync('public/models/stickman.glb')
GLTFLoader.prototype.loadAsync = async function () {
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
}
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)

// The real compound, built as the game builds it, every door open as Dead Ink opens them.
const scene = new THREE.Scene()
const compound = createCompound(), mission = createMissionWorld(compound)
prepareCompound(compound)
scene.add(compound, mission.root)
const doors: THREE.Group[] = []
scene.traverse(o => { if (o.userData.kind === 'door') doors.push(o as THREE.Group) })
for (const door of doors) { door.userData.missionLocked = false; setDoorOpen(door, true, true) }
const world = new CollisionWorld(scene)
world.refresh()

const sounds: SoundEvent[] = [], swipes: { id: string; amount: number }[] = [], rises: THREE.Vector3[] = []
const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
const director = new ZombieDirector({ scene, world, doors, graph, emit: e => sounds.push(e),
  damagePlayer: (id, amount) => swipes.push({ id, amount }), onRise: p => rises.push(p) })
const started = performance.now()
await director.init(24)
const loadSeconds = (performance.now() - started) / 1000
assert.equal(director.capacity, 24)

const run = (seconds: number, targets: ZombieTarget[], fps = 60) => {
  for (let i = 0; i < Math.ceil(seconds * fps); i++) director.update(1 / fps, targets)
}

// ---- 1. The look -------------------------------------------------------------------------------
{
  const z = director.spawn(v(-34, 0, -29), 150, 'walk', 0)!
  assert(z, 'a zombie spawns on the yard floor')
  run(0.2, [])
  assert.equal(z.actor.gun.visible, false, 'a zombie never holds a gun')
  const forward = v(Math.sin(z.yaw), 0, Math.cos(z.yaw))
  const eyes: THREE.Object3D[] = []
  z.actor.root.traverse(o => { if (o.name === 'Zombie eye') eyes.push(o) })
  assert.equal(eyes.length, 2, 'two eyes')
  const head = z.actor.rig.bones.head.getWorldPosition(v())
  for (const eye of eyes) {
    const p = eye.getWorldPosition(v())
    assert(p.y > 1.45 && p.y < 1.8, `eye at head height (${p.y.toFixed(2)} m)`)
    assert(p.clone().sub(head).setY(0).dot(forward) > 0.03, 'eyes are on the front of the face, not the back')
  }
  const [a, b] = eyes.map(e => e.getWorldPosition(v()))
  assert(Math.abs(a.clone().sub(b).dot(v(Math.cos(z.yaw), 0, -Math.sin(z.yaw)))) > 0.05, 'the eyes sit side by side')
  // Arms reach forward: both hands are well in front of the chest.
  const chest = z.actor.rig.bones.chest.getWorldPosition(v())
  for (const side of ['L', 'R'] as const) {
    const hand = z.actor.rig.bones[`hand.${side}`].getWorldPosition(v())
    assert(hand.clone().sub(chest).setY(0).dot(forward) > 0.35, `${side} hand reaches forward (${hand.clone().sub(chest).setY(0).dot(forward).toFixed(2)} m)`)
  }
  director.clear()
}

// ---- 2. Chase across the mess yard and swipe ------------------------------------------------
{
  swipes.length = 0
  const player: ZombieTarget = { id: 'p1', feet: v(-23, 0, -29), alive: true }
  const floor = world.floor(player.feet.clone().setY(0.5), 1, 1.5, 0.28)
  player.feet.y = floor
  const z = director.spawn(v(-42, 0, -21), 5000, 'run', 0)!
  const start = z.position.distanceTo(player.feet)
  let t = 0
  while (t < 20 && Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z) > ATTACK.range) { run(0.25, [player]); t += 0.25 }
  assert(Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z) <= ATTACK.range + 0.1, `the zombie reached the player (from ${start.toFixed(1)} m in ${t.toFixed(1)} s)`)
  run(3, [player])
  assert(swipes.length >= 1, 'a zombie beside you swipes')
  assert(swipes.every(s => s.id === 'p1' && s.amount === PLAYER_HEALTH.zombieHit), 'each swipe deals a zombie hit')
  assert(swipes.length <= Math.ceil(3 / (ATTACK.swing + ATTACK.recover)) + 1, 'swipes have a rhythm, not every frame')
  // Step away beyond reach mid-swipe: the swipe whiffs.
  swipes.length = 0
  z.swing = ATTACK.swing; z.swingLanded = false
  player.feet.x += 6
  run(ATTACK.windup + 0.05, [player])
  assert.equal(swipes.length, 0, 'backing off during the wind-up dodges the swipe')
  // A dead player is not chased or hit.
  swipes.length = 0
  player.alive = false
  run(3, [player])
  assert.equal(swipes.length, 0, 'nobody swipes at a downed player')
  director.clear()
}

// ---- 3. Long chase: reach the player, or ask to be moved ---------------------------------------
// A baked map graph can promise a way through that a body cannot actually take. A zombie must never
// end up shuffling forever: it either arrives, or reports itself stranded so the game relocates it,
// which is what Call of Duty does with zombies that cannot path to you.
{
  const player: ZombieTarget = { id: 'p1', feet: v(-40, 0.15, -62.3), alive: true }   // the mission insertion point
  player.feet.y = world.floor(player.feet.clone().setY(0.6), 1, 1.5, 0.28)
  const from = v(-34, 0, -29)
  const z = director.spawn(from, 5000, 'run', 0)!
  const startGap = Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z)
  let t = 0, arrived = false
  while (t < 45 && !arrived && !z.stranded) {
    run(0.5, [player]); t += 0.5
    arrived = Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z) <= 2
  }
  const gap = Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z)
  assert(arrived || z.stranded, `a zombie either arrives or asks to be moved (gap ${gap.toFixed(1)} m of ${startGap.toFixed(1)} after ${t} s)`)
  assert(gap < startGap - 5 || arrived, 'it covered real ground on the way')
  // Relocating a stranded zombie puts it back in play, and then it arrives.
  if (!arrived) {
    graph.flow([player.feet])
    const spot = pickSpawn(graph, world, { near: 10, far: 25, eyes: [player.feet.clone().setY(player.feet.y + 1.7)] }, seeded(11))
    assert(spot && director.relocate(z, spot), 'a stranded zombie can be relocated')
    assert.equal(z.stranded, false, 'and is back in play')
    let s2 = 0
    while (s2 < 30 && Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z) > ATTACK.range + 0.2) { run(0.5, [player]); s2 += 0.5 }
    assert(Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z) <= ATTACK.range + 0.2,
      `after relocating it reaches the player (${s2} s)`)
  }
  director.clear()
}

// ---- 4. Damage, death, the corpse, and a clean revival ----------------------------------------
{
  const z = director.spawn(v(-34, 0, -29), 150, 'walk', 0)!
  run(0.2, [])
  const eye = z.actor.rig.bones.head.getWorldPosition(v()).add(v(Math.sin(z.yaw) * 5, 0, Math.cos(z.yaw) * 5))
  const shotAt = (point: THREE.Vector3, damage = 34, weapon: Shot['weapon'] = 'ak'): Shot =>
    ({ origin: eye.clone(), direction: point.clone().sub(eye).normalize(), range: 120, damage, weapon })
  const headPoint = z.actor.rig.bones.head.getWorldPosition(v()).add(v(0, 0.08, 0))
  const chestPoint = z.actor.rig.bones.chest.getWorldPosition(v())
  const bodyHit = director.hit(shotAt(chestPoint, 10), 120, ZOMBIE_DAMAGE_SCALE)!
  assert(bodyHit && bodyHit.zombie === z && !bodyHit.lethal, 'a body shot hits and does not kill')
  const headHit = director.hit(shotAt(headPoint, 10), 120, ZOMBIE_DAMAGE_SCALE)!
  assert(headHit && headHit.reaction.zone === 'head', `a shot at the head is a headshot (${headHit?.reaction.zone})`)
  assert(headHit.dealt > bodyHit.dealt, `a headshot does more damage (${headHit.dealt} vs ${bodyHit.dealt})`)
  assert.equal(director.hit(shotAt(chestPoint.clone().add(v(0, 3, 0))), 120, ZOMBIE_DAMAGE_SCALE), null, 'a shot over its head misses')
  const lethal = director.hit(shotAt(chestPoint, 500), 120, ZOMBIE_DAMAGE_SCALE)!
  assert(lethal.lethal && z.state === 'dead' && z.health === 0, 'a lethal hit kills')
  assert.equal(director.hit(shotAt(chestPoint, 500), 120, ZOMBIE_DAMAGE_SCALE), null, 'a corpse takes no more hits')
  run(CORPSE.lie + CORPSE.sink + 0.1, [])
  assert.equal(z.state, 'idle', 'the body vanishes back into the pool')
  assert.equal(z.actor.root.visible, false)
  const again = director.spawn(v(-23, 0, -21), 250, 'walk', 0)!
  assert(again, 'the pool revives a used actor')
  run(0.1, [])
  assert.equal(again.actor.gun.visible, false, 'a revived zombie still holds no gun')
  assert(again.health === 250 && again.state === 'chase')
  // Insta-kill: any hit is lethal.
  const insta = director.hit(shotAt(again.actor.rig.bones.chest.getWorldPosition(v()).clone(), 1), 120, 1, true)
  assert(!insta || insta.lethal, 'insta-kill makes any hit lethal')
  director.clear()
}

// ---- 5. Knife and Nuke -----------------------------------------------------------------------
{
  const z = director.spawn(v(-34, 0, -29), 400, 'walk', 0)!
  run(0.1, [])
  const eye = z.position.clone().add(v(0, 1.6, 1.2)), towardZombie = z.position.clone().sub(eye).setY(0).normalize()
  assert(director.knife(eye, towardZombie, 2, 150), 'a knife swipe at a zombie in front hits')
  assert.equal(director.knife(eye, towardZombie.clone().negate(), 2, 150), null, 'a knife swipe the other way misses')
  assert.equal(director.knife(eye.clone().add(towardZombie.clone().multiplyScalar(-5)), towardZombie, 2, 150), null, 'out of reach, it misses')
  director.spawn(v(-23, 0, -21), 400, 'walk', 0); director.spawn(v(-42, 0, -21), 400, 'walk', 0)
  assert.equal(director.killAll(), 3, 'a Nuke kills every living zombie')
  assert.equal(director.aliveCount, 0)
  director.clear()
}

// ---- 5b. Two players: each zombie goes for whoever is closer ON FOOT ---------------------------
{
  const west: ZombieTarget = { id: 'west', feet: v(-50, 0, -17), alive: true }
  const east: ZombieTarget = { id: 'east', feet: v(20, 0, 8), alive: true }
  for (const t of [west, east]) t.feet.y = world.floor(t.feet.clone().setY(0.5), 1, 1.5, 0.28)
  const nearWest = director.spawn(v(-42, 0, -21), 5000, 'run', 0)!
  const nearEast = director.spawn(v(40, 0, 8), 5000, 'run', 0)!
  const startWest = nearWest.position.distanceTo(west.feet), startEast = nearEast.position.distanceTo(east.feet)
  run(6, [west, east])
  assert(nearWest.position.distanceTo(west.feet) < startWest - 3, 'the western zombie closed on the western player')
  assert(nearEast.position.distanceTo(east.feet) < startEast - 3, 'the eastern zombie closed on the eastern player')
  assert(nearWest.position.distanceTo(west.feet) < nearWest.position.distanceTo(east.feet), 'it chose the nearer player')
  director.clear()
}

// ---- 5c. Spawning: reachable, far enough, out of sight -----------------------------------------
{
  const player: ZombieTarget = { id: 'p1', feet: v(-34, 0, -29), alive: true }
  player.feet.y = world.floor(player.feet.clone().setY(0.5), 1, 1.5, 0.28)
  graph.flow([player.feet])
  const eye = player.feet.clone().setY(player.feet.y + 1.7)
  const random = seeded(4242)
  let picked = 0
  // The pool holds 24; spawn fewer so the last call is not simply an exhausted pool.
  for (let i = 0; i < 20; i++) {
    const spot = pickSpawn(graph, world, { near: 18, far: 55, eyes: [eye] }, random)
    assert(spot, 'a spawn spot was found')
    const node = graph.nearest(spot!)
    const walk = graph.distance(node)
    assert(Number.isFinite(walk), 'spawns only where a zombie can walk to the player')
    assert(walk >= 18 - graph.cell && walk <= 55 + graph.cell, `spawn ${walk.toFixed(1)} m away by foot`)
    assert(!world.visible(eye, spot!.clone().setY(spot!.y + 1.5), new THREE.Object3D()), 'spawns out of sight')
    assert(director.spawn(spot!, 150, 'walk', 0), 'a zombie fits where it spawns')
    picked++
  }
  assert.equal(picked, 20)
  director.clear()
}

// ---- 5d. Climbing out of the ground --------------------------------------------------------------
{
  swipes.length = 0
  const z = director.spawn(v(-34, 0, -29), 150, 'run', 0, true)!
  assert(z && rises.length === 1 && rises[0].distanceTo(z.position) < 0.01, 'a rising spawn is announced where it happens')
  assert(z.actor.root.position.y < z.position.y - RISE.depth + 0.01, 'it starts under the ground')
  // Standing right next to the hole: no swipe until it is out.
  const beside: ZombieTarget = { id: 'p1', feet: z.position.clone().add(v(0.9, 0, 0)), alive: true }
  run(RISE.seconds * 0.5, [beside])
  const halfway = z.actor.root.position.y
  assert(halfway > z.position.y - RISE.depth && halfway < z.position.y - 0.2, `halfway out (${(halfway - z.position.y).toFixed(2)} m)`)
  assert.equal(swipes.length, 0, 'it cannot swipe while climbing out')
  // Its head is above ground by now and can be shot.
  const head = z.actor.rig.bones.head.getWorldPosition(v())
  assert(head.y > z.position.y + 0.1, `its head is out of the ground (${(head.y - z.position.y).toFixed(2)} m)`)
  run(RISE.seconds * 0.5 + 0.1, [beside])
  assert(Math.abs(z.actor.root.position.y - z.position.y) < 0.01 && z.rise === 0, 'then it stands on the ground')
  run(2, [beside])
  assert(swipes.length >= 1, 'and swipes')
  director.clear()
}

// ---- 5e. Ladders, towers and ledges: nowhere you can stand is safe --------------------------------
// The observation tower and the water tower are reached by ladder (and zip line); the long warehouse
// and the southwest stores stand on 0.6 m slabs a player hops up and a zombie must vault.
{
  const reach = (label: string, goal: THREE.Vector3, from: THREE.Vector3, seconds: number) => {
    const node = graph.nearest(goal)
    assert(node >= 0, `${label}: the goal is on the graph`)
    const player: ZombieTarget = { id: 'p1', feet: graph.point(node), alive: true }
    const z = director.spawn(graph.point(graph.nearest(from, 6)), 5000, 'run', 0)!
    assert(z, `${label}: the zombie spawns`)
    let t = 0, climbed = false
    const close = () => Math.hypot(z.position.x - player.feet.x, z.position.z - player.feet.z) <= ATTACK.range + 0.2 && Math.abs(z.position.y - player.feet.y) < 1.3
    while (t < seconds && !close()) {
      run(0.25, [player]); t += 0.25
      climbed ||= !!z.climb
      if (z.stranded) break
    }
    assert(close(), `${label}: the zombie reached the player (still ${z.position.distanceTo(player.feet).toFixed(1)} m away after ${t} s${z.stranded ? ', stranded' : ''})`)
    assert(climbed, `${label}: it climbed on the way`)
    director.clear()
    return t
  }
  const times = [
    reach('observation tower deck', v(-50.4, 6.8, 16.5), v(-44, 0, 27), 40),
    reach('water tower deck', v(10.9, 12.6, -31), v(20, 0, -24), 45),
    reach('inside the long warehouse', v(25.5, 0.7, -6), v(25.5, 0, 7), 30),
    reach('inside the southwest stores', v(-57, 0.7, 64), v(-42, 0, 71), 30),
  ]
  // And down again: from the observation tower deck to a player on the ground.
  const deck = graph.point(graph.nearest(v(-50.4, 6.8, 16.5)))
  const ground: ZombieTarget = { id: 'p1', feet: graph.point(graph.nearest(v(-44, 0, 27), 6)), alive: true }
  const down = director.spawn(deck, 5000, 'run', 0)!
  let t = 0
  while (t < 40 && Math.hypot(down.position.x - ground.feet.x, down.position.z - ground.feet.z) > ATTACK.range + 0.2) { run(0.25, [ground]); t += 0.25 }
  assert(Math.abs(down.position.y - ground.feet.y) < 1.3 && Math.hypot(down.position.x - ground.feet.x, down.position.z - ground.feet.z) <= ATTACK.range + 0.2,
    `a zombie on the tower climbs down to a player below (${t} s)`)
  director.clear()
  // Shot off the ladder: the body drops to the ground, not left hanging in the air.
  const climber = director.spawn(ground.feet.clone(), 5000, 'run', 0)!
  const top: ZombieTarget = { id: 'p1', feet: deck.clone(), alive: true }
  t = 0
  while (t < 40 && !(climber.climb && climber.position.y > deck.y - 4 && climber.position.y < deck.y - 1.5)) { run(1 / 30, [top]); t += 1 / 30 }
  assert(climber.climb, 'caught a zombie halfway up the ladder')
  director.killAll()
  const below = world.floor(climber.position.clone(), 0.2, 40)
  assert(Math.abs(climber.position.y - below) < 0.05 && climber.position.y < 1, `its body lies on the ground (${climber.position.y.toFixed(2)} m)`)
  director.clear()
  console.log(`  climbing: tower ${times[0]} s, water tower ${times[1]} s, warehouse ${times[2]} s, stores ${times[3]} s, back down ${t.toFixed(1)} s`)
}

// ---- 6. Cost of a full crowd -----------------------------------------------------------------
{
  const player: ZombieTarget = { id: 'p1', feet: v(-23, 0, -29), alive: true }
  player.feet.y = world.floor(player.feet.clone().setY(0.5), 1, 1.5, 0.28)
  const posts = mission.enemies.map(e => new THREE.Vector3(...e.position))
  let spawned = 0
  for (const post of posts) if (spawned < 24 && director.spawn(post, 5000, spawned % 3 === 0 ? 'sprint' : 'run', 0)) spawned++
  run(1, [player])
  const frames = 180, t0 = performance.now()
  run(frames / 60, [player])
  const ms = (performance.now() - t0) / frames
  console.log(`zombies director checks passed: pool of 24 loaded in ${loadSeconds.toFixed(1)} s; ${spawned} chasing zombies cost ${ms.toFixed(2)} ms per frame in Node`)
}
director.dispose()
world.dispose()
