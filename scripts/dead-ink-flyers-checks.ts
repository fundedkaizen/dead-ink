// The Ink Storm's Inkwings (src/game/zombies/flyers.ts), with the real director in the compound as Dead Ink sets
// it up: the storm's rules and pack, where they come out, the tell and the dive (and dodging it), the snap, reaching
// a player anywhere, bullets, blasts, the knife and the Ink Doll, the co-op snapshot both ways, a whole storm round
// down to its Max Ammo, no flyers in other rounds, 24 at once, and a storm played out against a scripted player.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { sweepWorld, traversals } from './reach-sweep'
import { ZombieDirector, type Zombie, type ZombieSnap, type ZombieTarget } from '../src/game/zombies/director'
import { FLYER_ROW, INKWING, StormPack } from '../src/game/zombies/flyers'
import { INKWINGS, MAX_ALIVE, STORM, inkwingHealth, isBossRound, isStormRound, stormNumber, stormPack, zombieHealth, zombiesInRound } from '../src/game/zombies/rules'
import { newGame, returnSpawns, stepRounds } from '../src/game/zombies/rounds'
import { pickSpawn } from '../src/game/zombies/spawn'
import { DECOY } from '../src/game/zombies/decoy'
import { seeded, type Random } from '../src/game/shared/random'
import type { Shot, SoundEvent } from '../src/game/types'

const started = performance.now()
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const f1 = (n: number) => n.toFixed(1)
const at = (p: THREE.Vector3) => `${f1(p.x)}, ${f1(p.y)}, ${f1(p.z)}`

// ---- 1. The rules: storm rounds, what a storm brings, how tough they are --------------------------------------
{
  const storms = Array.from({ length: 60 }, (_, i) => i + 1).filter(isStormRound)
  assert.deepEqual(storms.slice(0, 4), [7, 14, 21, 28], 'storms on 7, 14, 21, 28')
  assert(!storms.some(isBossRound), 'never on a Brute round')
  assert.deepEqual(storms.slice(0, 4).map(stormNumber), [1, 2, 3, 4], 'storm numbers count the storms')
  assert.deepEqual(stormPack(7, 1), { flyers: INKWINGS.flyers, sprinters: Math.round(INKWINGS.flyers * INKWINGS.sprinters) })
  for (const round of storms.slice(0, 6)) for (let players = 1; players <= 4; players++) {
    const pack = stormPack(round, players)
    assert(pack.flyers >= 3 * pack.sprinters, `mostly Inkwings (round ${round}, ${players} players: ${pack.flyers} and ${pack.sprinters} sprinters)`)
    if (players > 1) assert(pack.flyers > stormPack(round, players - 1).flyers, `more of them for more players (round ${round})`)
    if (round > 7) assert(pack.flyers > stormPack(round - STORM.every, players).flyers, `more on each storm (round ${round})`)
    assert(inkwingHealth(round, players) > (players > 1 ? inkwingHealth(round, players - 1) : 0), 'tougher for more players')
  }
  assert.equal(inkwingHealth(7, 1), Math.round(zombieHealth(7) * INKWINGS.health), 'a share of a zombie\'s health')
  assert(inkwingHealth(14, 1) > inkwingHealth(7, 1) && inkwingHealth(21, 1) > inkwingHealth(14, 1), 'tougher each storm')
}

// ---- 2. The pack as it comes: groups of Inkwings, now and then a sprinter --------------------------------------
{
  for (const [round, players, seed] of [[7, 1, 1], [14, 2, 2], [21, 4, 3]] as const) {
    const pack = new StormPack(), random = seeded(seed)
    let units = pack.begin(round, players), flyers = 0, sprinters = 0
    const expected = stormPack(round, players), groups: number[] = []
    assert.equal(units, expected.flyers + expected.sprinters)
    while (units > 0) {
      const group = pack.next(random, units)
      if (group) { groups.push(group); flyers += group; units -= group } else { sprinters++; units-- }
    }
    assert.equal(flyers, expected.flyers, `every Inkwing of the storm comes (round ${round}, ${players} players)`)
    assert.equal(sprinters, expected.sprinters, 'and its sprinters')
    assert(groups.slice(0, -1).every(g => g >= INKWINGS.group[0] && g <= INKWINGS.group[1]), `in small groups (${groups.join(', ')})`)
  }
  const pack = new StormPack()
  pack.begin(7, 1)
  assert(pack.next(seeded(4), 1) <= 1, 'a group never overfills the room there is')
}

// ---- The compound as Dead Ink plays it, every gate open, and the real director ---------------------------------
const bytes = readFileSync('public/models/stickman.glb')
GLTFLoader.prototype.loadAsync = async function () {
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '')
}
const w = sweepWorld()
for (const gate of w.zones.gates) w.zones.open(gate)
w.zones.update(5)
w.world.refresh()
const sounds: SoundEvent[] = [], hurt: { id: string; amount: number; t: number }[] = []
let clock = 0
const director = new ZombieDirector({ scene: w.scene, world: w.world, doors: w.doors, graph: w.graph, emit: e => sounds.push(e),
  damagePlayer: (id, amount) => hurt.push({ id, amount, t: clock }) })
await director.init(26)
const flyers = director.flyers
const inkwings = () => director.zombies.filter(z => flyers.owns(z))
const stand = (x: number, y: number, z: number) => {
  const p = v(x, y, z)
  p.y = w.world.floor(p.clone().setY(p.y + 0.4), 0.2, 0.6, 0.28)
  assert(Number.isFinite(p.y), `somewhere to stand at ${x}, ${z}`)
  return p
}
const reset = () => { director.clear(); sounds.length = 0; hurt.length = 0; clock = 0 }
const run = (seconds: number, targets: ZombieTarget[], fps = 60, each?: () => boolean | void) => {
  for (let i = 0; i < Math.ceil(seconds * fps); i++) {
    director.update(1 / fps, targets)
    clock += 1 / fps
    if (each?.()) return true
  }
  return false
}
const yard = stand(-30, 0, -25)
const player = (feet: THREE.Vector3): ZombieTarget => ({ id: 'p1', feet, alive: true })

// ---- 3. Where they come out: in the open, round the player, never on top of anyone ---------------------------
const places: [string, THREE.Vector3][] = [
  ['the mess yard', yard],
  ['under the equipment shed roof', stand(-62.4, 0.28, -8)],
  ['inside the mess hall', stand(-38.4, 1.12, -51.2)],
  ['on the mess hall roof', stand(-41.6, 6.4, -51.2)],
  ['the detention guardroom', stand(113, 0.12, -8)],
  ['down the cell block stairs', stand(117, -2.1, -14.7)],
  ['the cell block corridor', stand(117, -4.2, -24)],
  ['cell 01', stand(110.5, -4.2, -20.5)],
]
const zips = traversals(w.scene, w.world).zips
assert(zips.length >= 1, 'the zip line is there')
places.push(['the zip line top', stand(zips[0].start.x, zips[0].start.y, zips[0].start.z)], ['the zip line end', stand(zips[0].end.x, zips[0].end.y, zips[0].end.z)])
{
  const random = seeded(20260924), probe = v()
  let entries = 0, inSight = 0
  for (const [label, feet] of places) {
    reset()
    const target = player(feet)
    run(0.4, [target])
    for (let i = 0; i < 12; i++) {
      const entry = flyers.entry(target, [target], random)
      assert(entry, `${label}: somewhere to come out`)
      entries++
      assert(Math.hypot(entry.x - feet.x, entry.z - feet.z) >= 5 || Math.abs(entry.y - feet.y) >= 4, `${label}: not on top of the player (${at(entry)})`)
      // In the open: a body fits there, and the air straight down to the ground graph under it is clear.
      const floor = w.world.floor(entry, 0.2, 20)
      assert(Number.isFinite(floor), `${label}: over a floor (${at(entry)})`)
      const spot = w.graph.nearest(probe.set(entry.x, floor, entry.z), 1, 0.8)
      assert(spot >= 0 && Number.isFinite(w.graph.distance(spot)), `${label}: over the zombies' ground, on a way to the player (${at(entry)})`)
      if (w.world.visible(entry, feet.clone().setY(feet.y + 1.2), new THREE.Object3D())) inSight++
    }
  }
  // Each streak must be seen: most come out where the player can see them (the rest where there is nowhere that is).
  assert(inSight >= entries * 0.7, `most come out in sight of the player (${inSight} of ${entries})`)
  // A group: spread round the player, each streak a moment after the one before.
  reset()
  const target = player(yard)
  run(0.4, [target])
  assert.equal(flyers.arrive(3, [target], 400, seeded(5), 1), 3, 'a group of three comes out')
  const group = inkwings()
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++)
    assert(Math.hypot(group[i].position.x - group[j].position.x, group[i].position.z - group[j].position.z) >= 2.5, 'spread apart')
  assert(group.every(z => z.health === 400 && z.state === 'chase' && flyers.get(z)!.mode === 'form'), 'forming, at full health')
  const arrivals: number[] = []
  run(1.5, [target], 60, () => { if (sounds.length && sounds[sounds.length - 1].kind === 'inkwing-arrive' && arrivals.length < sounds.filter(s => s.kind === 'inkwing-arrive').length) arrivals.push(clock) })
  assert.equal(arrivals.length, 3, 'each on its own streak of ink, heard where it lands')
  assert(arrivals[1] - arrivals[0] > 0.15 && arrivals[2] - arrivals[1] > 0.15, `one after another (${arrivals.map(f1).join(', ')} s)`)
  assert(sounds.filter(s => s.kind === 'inkwing-arrive').every(s => s.position), 'placed in the world')
}

// ---- 4. The tell and the dive; a sidestep or a jump at the right time dodges it -------------------------------
type Watch = { tellAt: number; diveAt: number; flyer: Zombie; fold: number; flare: number; hover: number; speed: number; dir: THREE.Vector3; from: THREE.Vector3 }
/** One Inkwing over the yard until its first dive starts; returns what the tell looked like. */
function untilDive(feet: THREE.Vector3, seed: number): Watch {
  reset()
  const target = player(feet)
  run(0.4, [target])
  assert.equal(flyers.arrive(1, [target], 1e6, seeded(seed), 1), 1)
  const flyer = inkwings()[0], f = flyers.get(flyer)!
  let tellAt = -1, hover = 0, fold = 0, flare = 0
  const dove = run(15, [target], 60, () => {
    if (f.mode === 'tell' && tellAt < 0) tellAt = clock
    if (f.mode === 'tell') { if (clock - tellAt > INKWING.dive.tell / 2) hover = Math.max(hover, f.velocity.length()); fold = f.fold; flare = f.flare }
    return f.mode === 'dive'
  })
  assert(dove && tellAt >= 0, `a lone Inkwing tells and dives within 15 s (seed ${seed})`)
  return { tellAt, diveAt: clock, flyer, fold, flare, hover, speed: f.velocity.length(), dir: f.dir.clone(), from: flyer.position.clone() }
}
{
  const dive = untilDive(yard.clone(), 7)
  const tell = sounds.find(s => s.kind === 'inkwing-tell')
  assert(tell?.position, 'the tell screeches, from where it hangs')
  assert(Math.abs(dive.diveAt - dive.tellAt - INKWING.dive.tell) < 0.05, `the tell lasts ${INKWING.dive.tell} s (${f1(dive.diveAt - dive.tellAt)})`)
  assert(dive.hover < 2.2, `it hangs in the air through the tell (${f1(dive.hover)} m/s at most)`)
  assert(dive.fold > 0.6 && dive.flare > 0.8, `wings folding in (${dive.fold.toFixed(2)}), eyes flaring (${dive.flare.toFixed(2)})`)
  assert(Math.abs(dive.speed - INKWING.dive.speed) < 0.01, 'then straight down at dive speed')
  assert(sounds.some(s => s.kind === 'inkwing-dive'), 'with a rush of air')
  const flyer = dive.flyer, target = player(yard.clone())
  run(1.2, [target], 60, () => hurt.length > 0)
  assert.equal(hurt.length, 1, 'a player standing still is hit')
  assert.deepEqual([hurt[0].id, hurt[0].amount], ['p1', INKWING.dive.damage], `for ${INKWING.dive.damage}`)
  assert(hurt[0].t - dive.diveAt < 1, `within a second of the dive (${f1(hurt[0].t - dive.diveAt)} s)`)
  assert(sounds.some(s => s.kind === 'inkwing-hit'), 'the bite is heard')
  const low = flyer.position.y
  run(0.5, [target])
  assert(flyer.position.y > low + 0.8 && ['strike', 'pull', 'fly'].includes(flyers.get(flyer)!.mode), `it pulls up after (${f1(low)} to ${f1(flyer.position.y)} m)`)
}
{
  // A sidestep as it commits: out of its line at a walk, and it passes by.
  let dodged = 0
  for (const seed of [7, 8, 9]) {
    const dive = untilDive(yard.clone(), seed)
    const feet = yard.clone(), target = player(feet), f = flyers.get(dive.flyer)!
    const side = v(-dive.dir.z, 0, dive.dir.x).normalize()
    run(1.2, [target], 60, () => { if (f.mode === 'dive') feet.addScaledVector(side, 4.2 / 60); return f.mode !== 'dive' })
    if (!hurt.length) dodged++
  }
  assert.equal(dodged, 3, 'a sidestep as it dives dodges it, every time')
  // A jump timed to be high as it arrives: it passes under.
  const dive = untilDive(yard.clone(), 11)
  const feet = yard.clone(), target = player(feet), f = flyers.get(dive.flyer)!
  const arrive = dive.from.distanceTo(feet.clone().setY(feet.y + INKWING.dive.aim)) / INKWING.dive.speed
  let t = 0
  run(1.2, [target], 60, () => {
    t += 1 / 60
    // Up at 7 m/s against 22 m/s² (the player's jump), its top as the flyer gets there.
    const air = t - (arrive - 7 / 22)
    feet.y = yard.y + (air > 0 ? Math.max(0, 7 * air - 11 * air * air) : 0)
    return f.mode !== 'dive' && air > 0.7
  })
  assert.equal(hurt.length, 0, `a jump at the right moment clears it (it arrives ${f1(arrive)} s into the dive)`)
}

// ---- 5. The snap: stand still near them and the close ones bite ------------------------------------------------
{
  reset()
  const target = player(yard.clone())
  run(0.4, [target])
  flyers.arrive(3, [target], 1e6, seeded(21), 1)
  run(12, [target], 60, () => hurt.some(h => h.amount === INKWING.snap.damage))
  const bite = hurt.find(h => h.amount === INKWING.snap.damage)
  assert(bite, 'someone standing still gets bitten up close')
  assert(sounds.some(s => s.kind === 'inkwing-snap'), 'after its wind-up is heard')
}

// ---- 6. Reach: to a player standing anywhere, under roofs, indoors, underground, on roofs, at the zip line ends --
const reach: string[] = []
{
  for (const [label, feet] of places) {
    reset()
    const target = player(feet)
    run(0.4, [target])
    const placed = flyers.arrive(3, [target], 1e6, seeded(31), 1)
    assert.equal(placed, 3, `${label}: three come out`)
    const got = run(25, [target], 30, () => hurt.length > 0)
    const again = sounds.filter(s => s.kind === 'inkwing-arrive').length - 3
    const closest = Math.min(...inkwings().map(z => z.position.distanceTo(feet)))
    assert(got, `${label}: an Inkwing gets to the player within 25 s (closest ${f1(closest)} m, ${again} came out again)`)
    reach.push(`${label} ${f1(hurt[0].t)} s${again ? ` (${again} out again)` : ''}`)
  }
}

console.log(`dead ink flyers checks: sections 1-6 passed in ${f1((performance.now() - started) / 1000)} s`)
console.log(`reach: ${reach.join('; ')}`)
w.world.dispose()
