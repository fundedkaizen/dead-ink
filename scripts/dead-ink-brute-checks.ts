import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CollisionWorld } from '../src/player/collision'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { setDoorOpen } from '../src/world/doors'
import { ZombieDirector, type Zombie, type ZombieSnap, type ZombieTarget } from '../src/game/zombies/director'
import { BRUTE_BITS, bruteDue, bruteSpeed, bruteWindup, buried, roundAlive, waveRadius } from '../src/game/zombies/brute'
import { BOSS, ROUND_BREAK, ZOMBIE_DAMAGE_SCALE, zombieHealth } from '../src/game/zombies/rules'
import { newGame, stepRounds } from '../src/game/zombies/rounds'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { PERK_EFFECT } from '../src/game/zombies/perks'
import { HIT_MULTIPLIERS, WEAPON_RULES } from '../src/game/balance'
import { weaponRules } from '../src/game/loot'
import type { Shot, SoundEvent } from '../src/game/types'

/**
 * The Brute (brute.ts): it does not hold a round up and carries on until killed, one at a time; a boss's
 * health; each attack's damage, cooldown and telegraph; the enrage; the mask and the weak spot under it; the
 * burrow instead of being moved out of sight; and a co-op guest seeing all of it from the host's snapshot.
 * Run on the real compound, with the real stickman and the baked walking graph.
 */
const bytes = readFileSync('public/models/stickman.glb')
GLTFLoader.prototype.loadAsync = async function () {
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
}
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z)

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

let clock = 0
const sounds: (SoundEvent & { t: number })[] = [], rises: THREE.Vector3[] = [], slams: { at: THREE.Vector3; radius: number }[] = []
const hurt: { id: string; amount: number; knock?: THREE.Vector3; t: number }[] = []
let players: ZombieTarget[] = []
const director = new ZombieDirector({ scene, world, doors, graph, emit: e => sounds.push({ ...e, t: clock }),
  damagePlayer: (id, amount, _source, knock) => hurt.push({ id, amount, knock: knock?.clone(), t: clock }),
  onRise: p => rises.push(p.clone()), onSlam: (p, radius) => slams.push({ at: p.clone(), radius }), players: () => players })
await director.init(12)

const FPS = 60
/** Run the host for `seconds`, the zombies after `targets` (the players by default); `each` after every frame. */
const run = (seconds: number, targets: () => readonly ZombieTarget[] = () => players, each?: () => boolean | void) => {
  for (let i = 0; i < Math.ceil(seconds * FPS); i++) {
    director.update(1 / FPS, targets())
    clock += 1 / FPS
    if (each?.()) return true
  }
  return false
}
const until = (seconds: number, test: () => boolean, targets?: () => readonly ZombieTarget[]) => test() || run(seconds, targets, test)
const player = (id: string, feet: THREE.Vector3, extra: Partial<ZombieTarget> = {}): ZombieTarget => ({ id, feet: ground(feet), alive: true, ...extra })
function ground(p: THREE.Vector3) {
  const floor = world.floor(p.clone().setY(p.y + 0.6), 1, 2, 0.25)
  return Number.isFinite(floor) ? p.clone().setY(floor) : p.clone()
}
/** A Brute on the yard, its special attacks held back unless a test lets one go. */
function spawnBrute(at: THREE.Vector3, facing = 0, health = BOSS.health(5)) {
  const z = director.spawn(at, health, 'run', facing, false, true)!
  assert(z && z.brute, 'a Brute spawns')
  hold(z)
  return z
}
function hold(z: Zombie, open: Partial<Record<'slam' | 'charge' | 'throw' | 'burrow', number>> = {}) {
  Object.assign(z.brute!.cool, { slam: 99, charge: 99, throw: 99, burrow: 99, gap: 0 }, open)
}
const look = (z: Zombie) => z.actor.root.userData.brute as { mask: THREE.Mesh; eyes: THREE.Mesh; halo: THREE.Points; outfit: THREE.SkinnedMesh; chains: THREE.InstancedMesh }
const clear = () => { director.clear(); players = []; hurt.length = 0; sounds.length = 0; slams.length = 0; rises.length = 0 }

/** Metres of floor straight along `yaw` from `from`, a body's width all the way (as the charge measures it). */
function straight(from: THREE.Vector3, yaw: number, most: number) {
  let y = from.y
  for (let d = 0.45; d <= most; d += 0.45) {
    const p = director.navigation.floor(v(from.x + Math.sin(yaw) * d, y, from.z + Math.cos(yaw) * d))
    if (!p) return d - 0.45
    y = p.y
  }
  return most
}
/** Open ground: every point in plain sight of the centre, knee high (so a wave reaches it). */
function open(centre: THREE.Vector3, points: THREE.Vector3[]) {
  return points.every(p => world.visible(centre.clone().setY(centre.y + 0.4), p.clone().setY(p.y + 0.4), new THREE.Object3D()) && Math.abs(p.y - centre.y) < 0.3)
}
const yard = graph.point(graph.nearest(v(-30, 0, -25), 4))

// ---- 1. It does not hold the round up, and carries on into the next ---------------------------------
{
  const state = newGame()
  state.round = 4; state.timer = 0.01
  const e5 = stepRounds(state, 0.05, roundAlive(director.zombies), 1)
  assert.equal(e5.roundStarted, 5, 'round 5 starts')
  assert(bruteDue(5, false), 'round 5 is a Brute round')
  const brute = spawnBrute(yard)
  const health = brute.health
  // Every zombie of the round is killed as it comes (a Nuke, which never kills the Brute), far from the Brute.
  const elsewhere = graph.point(graph.nearest(v(-45, 0, -40), 4))
  let ended = 0, spawned = 0, t = 0
  while (!ended && t < 400) {
    const events = stepRounds(state, 0.1, roundAlive(director.zombies), 1)
    for (let k = 0; k < events.spawn; k++) if (director.spawn(elsewhere, zombieHealth(5), 'walk', 0)) spawned++
    director.killAll()
    director.update(0.1, [])
    t += 0.1
    if (events.roundEnded) ended = events.roundEnded
  }
  assert.equal(ended, 5, `the round ends with the Brute alive (${spawned} zombies came, ${t.toFixed(0)} s)`)
  assert.equal(brute.state, 'chase', 'the Brute is still up')
  assert.equal(director.aliveCount, 1, 'only the Brute is left: counting it, the round would never have ended')
  assert.equal(roundAlive(director.zombies), 0, 'and it is not counted')
  // The break, then round 6: it is still there, as it was.
  let six: number | undefined
  for (let i = 0; i < (ROUND_BREAK + 1) * 10 && !six; i++) { six = stepRounds(state, 0.1, roundAlive(director.zombies), 1).roundStarted; director.update(0.1, []) }
  assert.equal(six, 6, 'round 6 starts')
  assert(brute.state === 'chase' && brute.health === health && brute.brute, 'the Brute carries over into round 6, unhurt and the same')
  assert(!bruteDue(6, true) && !bruteDue(6, false), 'round 6 sends no Brute')
  // One at a time: round 10 sends one only if the last is dead.
  assert(!bruteDue(10, true), 'no second Brute while one is hunting')
  assert(bruteDue(10, false), 'a new one once it is dead')
  clear()
}

// ---- 2. A boss's health: many magazines, and a decent gun with perks still wins ------------------------
{
  assert.equal(BOSS.health(5), Math.round(Math.max(BOSS.least, zombieHealth(5) * BOSS.zombies)))
  assert(BOSS.health(10) > BOSS.health(5) && BOSS.health(20) > BOSS.health(10), 'it grows with the round')
  assert(BOSS.health(5, 2) === Math.round(BOSS.health(5) * (1 + BOSS.perPlayer)) && BOSS.health(5, 9) === BOSS.health(5, 4), 'and with players, up to four')
  /** Shots to kill it: `raw` a hit's damage, `head` the share of hits to the head (the mask first), 85% of shots landing. */
  const shots = (health: number, raw: number, head: number) => {
    const body = raw, bare = raw * HIT_MULTIPLIERS.head * BOSS.mask.weakSpot
    const maskHits = head ? health * BOSS.mask.share / (raw * HIT_MULTIPLIERS.head) / head : 0
    const left = health - maskHits * body
    const hits = maskHits + Math.max(0, left) / ((1 - head) * body + head * bare)
    return hits / 0.85
  }
  const ak = WEAPON_RULES.ak.damage * ZOMBIE_DAMAGE_SCALE, mag = WEAPON_RULES.ak.capacity
  const common = shots(BOSS.health(5), ak, 0) / mag
  assert(common >= 5, `round 5, a plain AK into its body: ${common.toFixed(1)} magazines (many)`)
  const mixed = shots(BOSS.health(5), ak, 1 / 3) / mag
  assert(mixed >= 3, `round 5, a plain AK, a third to the head: ${mixed.toFixed(1)} magazines`)
  // A decent gun and perks: the Blotter (the AK Pack-a-Punched) with Double Line at round 10.
  const blotter = weaponRules({ name: 'ak', packed: true, packLevel: 1 })
  const strong = shots(BOSS.health(10), blotter.damage * ZOMBIE_DAMAGE_SCALE * PERK_EFFECT.damage, 1 / 3)
  const carried = blotter.capacity * (1 + 4 * 2)
  assert(strong <= carried && strong / blotter.capacity >= 1.5,
    `round 10, the Blotter with Double Line: ${(strong / blotter.capacity).toFixed(1)} magazines, within the ${carried} rounds it carries, and not trivial`)
  console.log(`  health: round 5 ${BOSS.health(5)}, 10 ${BOSS.health(10)}, 20 ${BOSS.health(20)}; plain AK ${common.toFixed(1)} mags (body) / ${mixed.toFixed(1)} (a third to the head); Blotter + Double Line at 10: ${(strong / blotter.capacity).toFixed(1)} mags`)
}

// ---- 3a. The swing ------------------------------------------------------------------------------------
{
  const brute = spawnBrute(yard)
  players = [player('p1', yard.clone().add(v(0, 0, 1.8)))]
  run(4)
  const swings = hurt.filter(h => h.id === 'p1')
  assert(swings.length >= 1 && swings.every(h => h.amount === BOSS.attack.damage && h.knock && h.knock.length() > 1), `its swing hits for ${BOSS.attack.damage} and shoves (${swings.map(h => h.amount)})`)
  assert(swings.length <= Math.ceil(4 / (BOSS.attack.swing + BOSS.attack.recover)) + 1, 'with a rhythm, not every frame')
  // Step back during the wind-up: it misses.
  hurt.length = 0
  brute.swing = 0; brute.recover = 0
  run(0.05)
  assert(brute.swing > 0, 'it has started a swing')
  players[0].feet.z += 5
  run(BOSS.attack.windup)
  assert(!hurt.length, 'stepping back during the wind-up dodges it')
  clear()
}

// ---- 3b. The slam and its ink wave: jump it --------------------------------------------------------------
{
  const at = yard.clone()
  const inner = player('p1', at.clone().add(v(2.3, 0, 0)))
  const stand = player('p2', at.clone().add(v(0, 0, 7)))
  const jump = player('p3', at.clone().add(v(-7, 0, 0)))
  const late = player('p4', at.clone().add(v(0, 0, -7)), { lag: BOSS.slam.lag })
  const lazy = player('p5', at.clone().add(v(5, 0, -5)), { lag: BOSS.slam.lag })
  const far = player('p6', at.clone().add(v(13, 0, 0)))
  assert(open(at, [inner, stand, jump, late, lazy, far].map(p => p.feet)), 'the slam test stands on open ground')
  players = [inner, stand, jump, late, lazy, far]
  const brute = spawnBrute(at, Math.PI / 2)
  hold(brute, { slam: 0 })
  run(0.05)
  assert.equal(brute.brute!.move, 'slam', 'close by, it slams')
  assert(sounds.some(s => s.kind === 'boss-roar'), 'with a roar as it raises its fists (the telegraph)')
  const windup = bruteWindup(brute.brute!, BOSS.slam.windup)
  assert(!run(windup - 0.1, undefined, () => hurt.length > 0), 'nothing lands during the wind-up')
  // Jumpers leave the ground as the wave reaches them: p3 on time, p4 (a teammate) a moment late, as their news would be.
  let impact = -1, coolAtEnd = -1
  const centre = v()
  run(2, undefined, () => {
    if (impact < 0 && brute.brute!.struck) { impact = clock; centre.copy(brute.position) }
    if (impact >= 0 && coolAtEnd < 0 && brute.brute!.move !== 'slam') coolAtEnd = brute.brute!.cool.slam
    const age = impact < 0 ? -1 : clock - impact
    jump.air = age >= 0 && Math.abs(waveRadius(age) - 7) < 0.7
    late.air = age >= 0 && waveRadius(age - 0.2) > 6.3 && waveRadius(age - 0.2) < 7.8
  })
  const got = (id: string) => hurt.filter(h => h.id === id)
  const fists = got('p1')[0]
  assert(fists && fists.amount === Math.round(BOSS.slam.damage * (1 - 0.6 * flat(inner.feet, centre) / BOSS.slam.inner)), `its fists hurt close by at once (${fists?.amount})`)
  assert(Math.abs(fists.t - impact) < 0.05, 'the moment they land')
  const standing = got('p2')[0]
  assert(standing && standing.amount > BOSS.slam.wave * BOSS.slam.waveEdge && standing.amount < BOSS.slam.wave, `the wave hurts whoever stands in its way, less further out (${standing?.amount})`)
  const arrival = standing.t - impact
  assert(Math.abs(arrival - (flat(stand.feet, centre) - BOSS.slam.inner) / BOSS.slam.speed) < 0.1, `when it reaches them (${arrival.toFixed(2)} s after the fists)`)
  assert(!got('p3').length, 'jumping over it: unhurt')
  assert(!got('p4').length, 'a teammate whose jump reaches the host late: unhurt')
  const lazyHit = got('p5')[0]
  assert(lazyHit && lazyHit.t - impact > (flat(lazy.feet, centre) - BOSS.slam.inner) / BOSS.slam.speed + BOSS.slam.lag - 0.05, 'a teammate who never jumps is hurt once their news is in')
  assert(!got('p6').length, `nothing beyond ${BOSS.slam.radius} m`)
  assert(slams.some(s => s.radius === BOSS.slam.inner) && director.brutes.waves.count >= 0, 'the ground cracks where the fists land')
  // Its cooldown: no other slam for a while, however close you stay.
  const slamsSoFar = sounds.filter(s => s.kind === 'boss-slam').length
  assert(Math.abs(coolAtEnd - BOSS.slam.cooldown) < 0.05, `then ${BOSS.slam.cooldown} s before the next (${coolAtEnd.toFixed(2)})`)
  players = [inner]
  run(BOSS.slam.cooldown - 1)
  assert.equal(sounds.filter(s => s.kind === 'boss-slam').length, slamsSoFar, 'no second slam inside the cooldown')
  clear()
}

// ---- 3c. The charge: telegraphed, straight, through zombies, hits hard ------------------------------------
{
  // A long straight run across the yard.
  let yaw = 0, best = 0
  for (let a = 0; a < 36; a++) { const run = straight(yard, a / 36 * Math.PI * 2, 20); if (run > best) { best = run; yaw = a / 36 * Math.PI * 2 } }
  assert(best >= 16, `a straight run of ${best.toFixed(1)} m on the yard`)
  const ahead = (d: number, side = 0) => yard.clone().add(v(Math.sin(yaw) * d + Math.cos(yaw) * side, 0, Math.cos(yaw) * d - Math.sin(yaw) * side))
  const victim = player('p1', ahead(12))
  players = [victim]
  const brute = spawnBrute(yard, yaw)
  const bystander = director.spawn(ahead(6.5, 0.2), 5000, 'walk', yaw)!
  hold(brute, { charge: 0 })
  run(0.05)
  assert.equal(brute.brute!.move, 'charge', 'a player in a clear line at mid range: it charges')
  assert(sounds.some(s => s.kind === 'brute-snort'), 'with a snort as it plants itself (the telegraph)')
  const start = brute.position.clone()
  const windup = bruteWindup(brute.brute!, BOSS.charge.windup)
  run(windup - 0.1)
  assert(flat(brute.position, start) < 0.1 && !hurt.length, 'it stays planted through the wind-up')
  let thrown = 0
  const bystanderFrom = bystander.position.clone()
  run(1.6, undefined, () => { thrown = Math.max(thrown, bystander.stagger); return hurt.length > 0 && flat(brute.position, start) > 13 })
  const hit = hurt.find(h => h.id === 'p1')
  assert(hit && hit.amount === BOSS.charge.damage, `running into you hits hard (${hit?.amount})`)
  assert(hit.knock && hit.knock.length() >= BOSS.charge.knock, `and throws you (${hit.knock?.length().toFixed(1)} m/s)`)
  assert(hit.t - clock < 2 && flat(brute.position, start) >= 11, `it covered ${flat(brute.position, start).toFixed(1)} m`)
  assert(bystander.state === 'chase' && thrown > 0.5 && flat(bystander.position, bystanderFrom) > 0.4, `a zombie in its way is thrown aside, not killed (moved ${flat(bystander.position, bystanderFrom).toFixed(2)} m)`)
  assert(sounds.some(s => s.kind === 'brute-bash'), 'with a thud')
  until(3, () => brute.brute!.move !== 'charge')
  assert(Math.abs(brute.brute!.cool.charge - BOSS.charge.cooldown) < 0.5, `then ${BOSS.charge.cooldown} s before the next (${brute.brute!.cool.charge.toFixed(1)})`)
  clear()
}

// ---- 3d. A charge you sidestep ends in the wall behind you ------------------------------------------
{
  let setup: { from: THREE.Vector3; yaw: number; wall: number } | null = null
  for (const centre of [v(-30, 0, -25), v(-20, 0, -30), v(-40, 0, -20), v(-35, 0, -35), v(0, 0, 40), v(-60, 0, 45)]) {
    const from = graph.point(graph.nearest(centre, 4))
    for (let a = 0; a < 72 && !setup; a++) {
      const yaw = a / 72 * Math.PI * 2, wall = straight(from, yaw, 22)
      if (wall < 11 || wall > 20) continue
      // It stops for a wall (floor on, no room), not for a drop.
      const beyond = from.clone().add(v(Math.sin(yaw) * (wall + 0.6), 0, Math.cos(yaw) * (wall + 0.6)))
      const floor = world.floor(beyond.clone().setY(from.y + 0.5), 0.9, 1.2)
      if (Number.isFinite(floor) && Math.abs(floor - from.y) < 0.3) setup = { from, yaw, wall }
    }
    if (setup) break
  }
  assert(setup, 'a wall at the end of a straight run')
  const { from, yaw, wall } = setup
  const victim = player('p1', from.clone().add(v(Math.sin(yaw) * (wall - 3), 0, Math.cos(yaw) * (wall - 3))))
  players = [victim]
  const brute = spawnBrute(from, yaw)
  hold(brute, { charge: 0 })
  run(0.05)
  assert.equal(brute.brute!.move, 'charge', 'it charges')
  // Its line is fixed a moment before it goes: step aside after that and it runs past you, into the wall.
  until(2, () => brute.brute!.locked)
  victim.feet.add(v(Math.cos(yaw) * 3, 0, -Math.sin(yaw) * 3))
  until(4, () => brute.brute!.move === 'stun')
  assert(!hurt.length, 'stepping aside after its line is fixed: it misses')
  assert(brute.brute!.move === 'stun' && brute.brute!.cause === 'crash', `it crashes into the wall and is stunned (${brute.brute!.move}, ${brute.brute!.cause})`)
  assert(sounds.some(s => s.kind === 'brute-crash'), 'with a crash')
  assert(!run(BOSS.charge.crash - 0.2, undefined, () => brute.swing > 0 || (brute.brute!.move !== 'stun' && brute.brute!.move !== null)), 'no attacks while stunned')
  clear()
}

// ---- 3e. The throw, for a player out of reach ---------------------------------------------------------------
{
  let spot: { from: THREE.Vector3; to: THREE.Vector3 } | null = null
  for (let a = 0; a < 36 && !spot; a++) {
    const yaw = a / 36 * Math.PI * 2, to = ground(yard.clone().add(v(Math.sin(yaw) * 18, 0, Math.cos(yaw) * 18)))
    if (Math.abs(to.y - yard.y) < 0.3 && world.visible(yard.clone().setY(yard.y + 2.6), to.clone().setY(to.y + 1.2), new THREE.Object3D()) && director.navigation.floor(to.clone())) spot = { from: yard, to }
  }
  assert(spot, 'a player 18 m away in plain sight')
  const target = player('p1', spot.to)
  players = [target]
  const brute = spawnBrute(spot.from, Math.atan2(spot.to.x - spot.from.x, spot.to.z - spot.from.z))
  hold(brute, { throw: 0 })
  run(0.05)
  assert.equal(brute.brute!.move, 'throw', 'a player out of reach: it throws')
  const windup = bruteWindup(brute.brute!, BOSS.throw.windup)
  let coolAtEnd = -1
  const ended = () => { if (coolAtEnd < 0 && brute.brute!.move !== 'throw') coolAtEnd = brute.brute!.cool.throw }
  until(windup, () => { ended(); return director.brutes.debris.flying.length > 0 })
  assert(sounds.some(s => s.kind === 'brute-rip'), 'it tears a chunk out of the ground first')
  assert.equal(director.brutes.debris.flying.length, 1, 'and throws it')
  until(3, () => { ended(); return director.brutes.debris.flying.length === 0 })
  const direct = hurt.find(h => h.id === 'p1')
  assert(direct && direct.amount === BOSS.throw.damage, `standing still, it hits you (${direct?.amount})`)
  assert(sounds.some(s => s.kind === 'debris-crash'), 'and bursts')
  until(2, () => { ended(); return coolAtEnd >= 0 })
  assert(Math.abs(coolAtEnd - BOSS.throw.cooldown) < 0.05, `then ${BOSS.throw.cooldown} s before the next (${coolAtEnd.toFixed(2)})`)
  // Moving: the chunk leads you by half your pace, so running on sideways gets you out from under it.
  hurt.length = 0
  hold(brute, { throw: 0 })
  brute.brute!.cool.gap = 0
  const side = v(Math.cos(Math.atan2(spot.to.x - spot.from.x, spot.to.z - spot.from.z)), 0, -Math.sin(Math.atan2(spot.to.x - spot.from.x, spot.to.z - spot.from.z)))
  let dodged = false
  run(4, undefined, () => {
    if (brute.brute!.move === 'throw' || director.brutes.debris.flying.length) target.feet.addScaledVector(side, 5.5 / FPS)
    if (brute.brute!.released && !director.brutes.debris.flying.length) { dodged = true; return true }
  })
  assert(dodged && !hurt.some(h => h.amount === BOSS.throw.damage), `running sideways, it misses (${hurt.map(h => h.amount)})`)
  clear()
}

// ---- 4. Enraged below a third of its health ------------------------------------------------------------------
{
  const brute = spawnBrute(yard)
  players = [player('p1', yard.clone().add(v(0, 0, 3.5)))]
  run(0.2)
  assert(!brute.brute!.enraged && bruteSpeed(brute) === BOSS.speed, 'calm at full health')
  brute.health = Math.floor(brute.maxHealth * (BOSS.enrage.below - 0.01))
  brute.swing = 0
  until(1.5, () => brute.brute!.move === 'roar')
  assert(brute.brute!.move === 'roar' && brute.brute!.enraged, `below ${BOSS.enrage.below * 100}% it roars and enrages`)
  assert(sounds.some(s => s.kind === 'brute-enrage'), 'a roar you hear across the map')
  run(0.1)
  const parts = look(brute)
  assert(parts.halo.visible && (parts.eyes.material as THREE.MeshBasicMaterial).color.getHex() !== 0xd4332a, 'its eyes burn brighter')
  until(BOSS.enrage.roar + 0.2, () => brute.brute!.move !== 'roar')
  assert.equal(bruteSpeed(brute), BOSS.enragedSpeed, `faster: ${BOSS.enragedSpeed} m/s`)
  assert(Math.abs(bruteWindup(brute.brute!, BOSS.slam.windup) - BOSS.slam.windup * BOSS.enrage.windups) < 1e-9, 'shorter wind-ups')
  // An enraged slam: quicker to land, sooner again.
  players = [player('p1', yard.clone().add(v(2.35, 0, 0)))]
  hold(brute, { slam: 0 }); brute.swing = 0; brute.recover = 0
  until(1, () => brute.brute!.move === 'slam')
  const begun = clock
  until(2, () => brute.brute!.struck)
  assert(Math.abs(clock - begun - BOSS.slam.windup * BOSS.enrage.windups) < 0.05, `its fists come down after ${(clock - begun).toFixed(2)} s`)
  until(3, () => brute.brute!.move !== 'slam')
  assert(Math.abs(brute.brute!.cool.slam - BOSS.slam.cooldown * BOSS.enrage.cooldowns) < 0.5, `and it may slam again after ${brute.brute!.cool.slam.toFixed(1)} s`)
  clear()
}

// ---- 5. The mask takes head shots until it breaks off; then the head is a weak spot ----------------------------
{
  const brute = spawnBrute(yard, 0, 50000)
  players = [player('p1', yard.clone().add(v(0, 0, 14)))]
  run(0.3)
  const shotAt = () => {
    // From in front of it, where a player facing it stands.
    const face = brute.actor.rig.bones.head.localToWorld(v(0, 0.18, 0))
    const from = face.clone().add(v(Math.sin(brute.yaw) * 8, 0.3, Math.cos(brute.yaw) * 8))
    return { origin: from, direction: face.clone().sub(from).normalize(), range: 60, damage: WEAPON_RULES.ak.damage, weapon: 'ak' as const } satisfies Shot
  }
  const b = brute.brute!, body = WEAPON_RULES.ak.damage * ZOMBIE_DAMAGE_SCALE
  const mask0 = b.mask, health0 = brute.health
  const first = director.hit(shotAt(), 60, ZOMBIE_DAMAGE_SCALE)!
  assert(first && first.reaction.zone === 'head', `a shot at its head (${first?.reaction.zone} ${first?.reaction.bone}, pose ${brute.brute!.move} swing ${brute.swing.toFixed(2)} at ${brute.position.clone().sub(yard).toArray().map(n => n.toFixed(2))})`)
  assert.equal(health0 - brute.health, Math.round(body), 'while the mask holds, a head shot does a body shot\'s damage to it')
  assert(Math.abs(mask0 - b.mask - body * HIT_MULTIPLIERS.head) < 1e-6, 'and a head shot\'s to the mask')
  assert(sounds.some(s => s.kind === 'brute-clang'), 'ringing off the iron')
  let shots = 1
  while (b.mask > 0 && shots < 400) { director.hit(shotAt(), 60, ZOMBIE_DAMAGE_SCALE); shots++ }
  assert(b.mask <= 0 && !look(brute).mask.visible, `after ${shots} head shots the mask breaks off`)
  assert.equal(director.brutes.pieces.count, 1, 'and flies')
  assert(b.move === 'stun' && b.cause === 'mask', 'it reels')
  assert(sounds.some(s => s.kind === 'brute-mask-break'), 'with a clang')
  until(BOSS.mask.stagger + 0.3, () => b.move !== 'stun')
  run(0.2)
  const before = brute.health
  const bare = director.hit(shotAt(), 60, ZOMBIE_DAMAGE_SCALE)!
  assert(bare.reaction.zone === 'head' && before - brute.health === Math.round(body * HIT_MULTIPLIERS.head * BOSS.mask.weakSpot),
    `its bare head is a weak spot: ${before - brute.health} a shot (${Math.round(body)} to the body)`)
  // Bullets never hold it: a stream of fire does not stop it walking.
  hold(brute)
  players = [player('p1', yard.clone().add(v(0, 0, 12)))]
  const walkFrom = brute.position.clone()
  run(2, undefined, () => { director.hit({ ...shotAt(), direction: brute.position.clone().setY(brute.position.y + 1.5).sub(shotAt().origin).normalize() }, 60, ZOMBIE_DAMAGE_SCALE) })
  assert(flat(brute.position, walkFrom) > 2.5, `under automatic fire it keeps coming (${flat(brute.position, walkFrom).toFixed(1)} m in 2 s)`)
  clear()
}

// ---- 6. Stuck, it burrows in plain view: never moved while you could see it ---------------------------------
{
  const home = graph.point(graph.nearest(v(-45, 0, -40), 4))
  const brute = spawnBrute(home)
  const target = player('p1', graph.point(graph.nearest(v(-10, 0, -20), 4)))
  players = [target]
  // No closer for too long, not fighting: stuck.
  hold(brute, { burrow: 0 })
  brute.brute!.stall = 99; brute.brute!.idle = 99; brute.brute!.best = 0
  let jump = 0, shown = brute.actor.root.visible, last = brute.position.clone(), stranded = false
  const watch = () => {
    const visible = brute.actor.root.visible
    if (visible && shown && brute.rise <= 0) jump = Math.max(jump, brute.position.distanceTo(last))
    shown = visible; last.copy(brute.position)
    stranded ||= brute.stranded
  }
  run(0.1, undefined, watch)
  assert.equal(brute.brute!.move, 'burrow', 'stuck and far from you, it burrows')
  assert(sounds.some(s => s.kind === 'brute-sink') && director.brutes.pools.count >= 1, 'with a roar, into a pool of ink')
  const sankAt = brute.position.clone()
  until(BOSS.burrow.sink - 0.2, () => false)
  assert(brute.actor.root.visible && flat(brute.position, sankAt) < 0.01, 'it sinks where it stood, in sight')
  until(1, () => buried(brute.brute), )
  assert(!brute.actor.root.visible && brute.position.y < sankAt.y - 3, 'under the ink: gone below the ground')
  const exit = brute.brute!.exit.clone()
  assert(sounds.some(s => s.kind === 'brute-rumble') && director.brutes.pools.count >= 1, 'the ink bubbles where it will come up')
  const distance = flat(exit, target.feet)
  assert(distance >= BOSS.burrow.near - 0.01 && distance <= BOSS.burrow.far + 0.01, `near you: ${distance.toFixed(1)} m`)
  assert(world.visible(exit.clone().setY(exit.y + 1.4), target.feet.clone().setY(target.feet.y + 1.4), new THREE.Object3D()), 'in plain sight of you')
  // A bullet cannot find it under the ground.
  assert(!director.hit({ origin: exit.clone().setY(exit.y + 1.5).add(v(0, 0, 5)), direction: v(0, -0.2, -1).normalize(), range: 30, damage: 30, weapon: 'ak' }, 30, ZOMBIE_DAMAGE_SCALE), 'nothing to shoot while it is under')
  until(BOSS.burrow.under + 0.2, () => brute.rise > 0, )
  assert(brute.rise > 0 && brute.actor.root.visible && flat(brute.position, exit) < 0.01, 'it climbs out of the ground there')
  assert(rises.some(p => flat(p, exit) < 0.1) && slams.some(s => flat(s.at, exit) < 0.1), 'bursting out, with a shockwave')
  assert(sounds.some(s => s.kind === 'brute-emerge'), 'and a roar')
  run(2.5, undefined, watch)
  assert(jump < 0.5, `it never moved more than ${jump.toFixed(2)} m in a frame while it could be seen`)
  assert(!stranded, 'and never asked to be moved (the runtime skips it anyway)')
  // Unreachable for good (no way to anyone): it burrows too, rather than shuffle.
  brute.brute!.cool.burrow = 0; brute.brute!.cool.gap = 0; brute.brute!.stall = 0; brute.brute!.idle = 0
  // Up where no walking spot is: no way to them at all.
  target.feet.copy(exit).add(v(15, 40, 0))
  const lostFrom = clock
  until(BOSS.burrow.lost + 1.5, () => brute.brute!.move === 'burrow')
  assert.equal(brute.brute!.move, 'burrow', 'with no way to anyone it burrows as well')
  assert(clock - lostFrom >= BOSS.burrow.lost - 0.1, `after ${(clock - lostFrom).toFixed(1)} s without a way`)
  clear()
}

// ---- 7. Co-op: a guest sees it all from the host's snapshot ---------------------------------------------------
{
  const guestScene = new THREE.Scene()
  const guestSounds: SoundEvent[] = []
  let guestHurt = 0
  const guest = new ZombieDirector({ scene: guestScene, world, doors, graph, emit: e => guestSounds.push(e), damagePlayer: () => { guestHurt++ } })
  await guest.init(12)
  const brute = spawnBrute(yard)
  brute.brute!.editor = true
  const near = player('p1', yard.clone().add(v(2.35, 0, 0)))
  players = [near]
  const sync = (seconds = 0.2) => run(seconds, undefined, () => { guest.puppet(1 / FPS, director.snapshot()) })
  sync(0.1)
  const index = director.zombies.indexOf(brute), puppet = guest.zombies[index]
  const row = director.snapshot().find(r => r[0] === index)!
  assert.equal(row.length, 15, 'a Brute\'s row carries its own three numbers')
  assert(director.snapshot().every(r => r[0] === index || r.length === 12), 'other rows are as they were')
  const reserved = 0x3fff | (0x1f << 14)
  assert.equal(row[9] & ~reserved, 0, 'its flags stay in bits 0 to 18 (the Brute\'s own: 14 to 18)')
  assert(puppet.state === 'chase' && puppet.brute && puppet.boss, 'the guest has the Brute')
  assert(puppet.brute.editor, 'and knows it is the Editor')
  assert(look(puppet).mask.visible && look(puppet).outfit.visible, 'dressed as the host has it')
  // A slam: its move and time, and the wave, on the guest.
  hold(brute, { slam: 0 }); brute.swing = 0; brute.recover = 0
  sync(0.3)
  assert(puppet.brute.move === 'slam' && Math.abs(puppet.brute.t - brute.brute!.t) < 0.1, `the guest sees the slam begin (${puppet.brute.move})`)
  sync(bruteWindup(brute.brute!, BOSS.slam.windup))
  assert(guest.brutes.waves.count >= 1, 'and its ink wave run out')
  assert(guestSounds.some(s => s.kind === 'boss-slam'), 'and hears it')
  until(3, () => brute.brute!.move !== 'slam')
  // Enraged.
  brute.health = Math.floor(brute.maxHealth * 0.3)
  hold(brute)
  sync(0.3)
  assert(puppet.brute.enraged && puppet.brute.move === 'roar' && look(puppet).halo.visible, 'the guest sees it enrage')
  assert(guestSounds.some(s => s.kind === 'brute-enrage'), 'and hears its roar')
  sync(BOSS.enrage.roar)
  // The mask breaking.
  brute.brute!.mask = 1
  const face = brute.actor.rig.bones.head.localToWorld(v(0, 0.18, 0)), from = face.clone().add(v(Math.sin(brute.yaw) * 8, 0.3, Math.cos(brute.yaw) * 8))
  director.hit({ origin: from, direction: face.clone().sub(from).normalize(), range: 60, damage: 30, weapon: 'ak' }, 60, ZOMBIE_DAMAGE_SCALE)
  assert(brute.brute!.mask <= 0, 'the host breaks the mask')
  sync(0.2)
  assert(!look(puppet).mask.visible && guest.brutes.pieces.count === 1, 'the guest sees it fly off')
  sync(BOSS.mask.stagger)
  // A charge.
  players = [player('p1', yard.clone().add(v(0, 0, 12)))]
  let yaw = 0, best = 0
  for (let a = 0; a < 36; a++) { const r = straight(brute.position, a / 36 * Math.PI * 2, 16); if (r > best) { best = r; yaw = a / 36 * Math.PI * 2 } }
  players[0].feet.copy(ground(brute.position.clone().add(v(Math.sin(yaw) * 11, 0, Math.cos(yaw) * 11))))
  brute.yaw = yaw
  hold(brute, { charge: 0 }); brute.swing = 0; brute.recover = 0
  let charging = false
  sync(2, )
  run(0.01)
  for (let i = 0; i < 120 && !charging; i++) { director.update(1 / FPS, players); guest.puppet(1 / FPS, director.snapshot()); charging = puppet.brute.move === 'charge' && puppet.moving }
  assert(charging || hurt.some(h => h.amount === BOSS.charge.damage), 'the guest sees it charge')
  until(3, () => brute.brute!.move === null)
  // A throw: the chunk flies on the guest too, and bursts there without hurting anyone twice.
  hurt.length = 0
  brute.brute!.move = null
  director.brutes.debris.launch(brute.position.clone().setY(brute.position.y + 2.5), v(0, 3, 10), true)
  guest.brutes.debris.sync(director.brutes.debris.rows())
  assert.equal(guest.brutes.debris.flying.length, 1, 'a chunk in flight reaches the guest')
  guest.brutes.debris.sync(director.brutes.debris.rows())
  assert.equal(guest.brutes.debris.flying.length, 1, 'once')
  for (let i = 0; i < 180 && guest.brutes.debris.flying.length; i++) guest.puppet(1 / FPS, director.snapshot())
  assert(!guest.brutes.debris.flying.length && guestSounds.some(s => s.kind === 'debris-crash') && guestHurt === 0, 'it bursts on the guest, hurting nobody there')
  // The burrow.
  hold(brute, { burrow: 0 })
  brute.brute!.stall = 99; brute.brute!.idle = 99; brute.brute!.best = 0
  players = [player('p1', graph.point(graph.nearest(v(-5, 0, -20), 4)))]
  let hidden = false, rose = false
  run(BOSS.burrow.sink + BOSS.burrow.under + 1, undefined, () => {
    guest.puppet(1 / FPS, director.snapshot())
    hidden ||= !puppet.actor.root.visible && buried(puppet.brute)
    rose ||= hidden && puppet.rise > 0 && puppet.actor.root.visible
  })
  assert(hidden, 'the guest sees it go under')
  assert(rose, 'and come up again')
  assert(guestSounds.some(s => s.kind === 'brute-sink') && guestSounds.some(s => s.kind === 'brute-emerge'), 'and hears both')
  assert.equal(guestHurt, 0, 'a guest never hurts anyone itself: hits come from the host')
  guest.dispose()
  clear()
}

// ---- 8. Its look: the stickman scaled and built out, in a handful of draw calls ---------------------------------
{
  const brute = spawnBrute(yard)
  // Standing, nobody about: its chains settle and hang.
  run(2, () => [])
  const drawn: string[] = []
  brute.actor.root.traverseVisible(o => { if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) drawn.push(o.name || o.type) })
  assert(drawn.length <= 6, `${drawn.length} draw calls: ${drawn.join(', ')}`)
  const bones = brute.actor.rig.bones, scale = (b: THREE.Object3D) => b.getWorldScale(v()).x
  assert(scale(bones.head) < BOSS.scale * 0.7, 'a small head')
  assert(scale(bones['forearm.L']) > BOSS.scale * 1.2 && scale(bones['hand.R']) > BOSS.scale * 1.4, 'heavy arms, big fists')
  // The chains hang from the shackles, below the wrists.
  const chains = look(brute).chains, m = new THREE.Matrix4(), p = v()
  chains.getMatrixAt(4, m); p.setFromMatrixPosition(m).applyMatrix4(brute.actor.root.matrixWorld)
  const wrist = bones['hand.L'].getWorldPosition(v())
  assert(p.y < wrist.y && p.distanceTo(wrist) < 1.2, `the chain hangs from the left wrist (${(wrist.y - p.y).toFixed(2)} m below it)`)
  clear()
  const ordinary = director.spawn(yard, 150, 'walk', 0)!
  run(0.1)
  assert(!ordinary.brute && !look(ordinary)?.outfit.visible && Math.abs(scale(ordinary.actor.rig.bones.head) - 1) < 1e-6, 'a body that was the Brute is an ordinary zombie again')
  clear()
}

console.log(`dead ink brute checks passed (${clock.toFixed(0)} s of play simulated)`)
