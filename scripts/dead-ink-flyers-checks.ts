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
  run(1.5, [target], 60, () => { while (arrivals.length < sounds.filter(s => s.kind === 'inkwing-arrive').length) arrivals.push(clock) })
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

/** A flyer of a fresh group round the yard, formed and flying. */
function oneFlyer(health = 1e6) {
  reset()
  const target = player(yard.clone())
  run(0.4, [target])
  assert.equal(flyers.arrive(1, [target], health, seeded(41), 1), 1)
  run(INKWING.form + 0.3, [target])
  const flyer = inkwings()[0]
  assert.equal(flyers.get(flyer)!.mode, 'fly')
  return { flyer, target }
}
const shot = (from: THREE.Vector3, to: THREE.Vector3, damage: number): Shot =>
  ({ origin: from.clone(), direction: to.clone().sub(from).normalize(), range: 200, damage, weapon: 'ak' })

// ---- 7. Fighting them: bullets (headshots count), blasts, the knife, the Nuke, the Ink Doll -----------------------
{
  const { flyer } = oneFlyer()
  const c = flyer.position.clone(), f = flyers.get(flyer)!
  const forward = v(Math.sin(flyer.yaw) * Math.cos(f.pitch), -Math.sin(f.pitch), Math.cos(flyer.yaw) * Math.cos(f.pitch))
  const side = v(Math.cos(flyer.yaw), 0, -Math.sin(flyer.yaw))
  const body = director.hit(shot(c.clone().addScaledVector(side, 12), c, 10), 200, 1)
  assert(body && body.zombie === flyer && body.reaction.zone === 'torso' && !body.lethal, 'a shot in flight hits the body')
  const graze = director.hit(shot(c.clone().addScaledVector(side, 12).addScaledVector(forward, -0.4).setY(c.y + 0.1), c.clone().addScaledVector(forward, -0.4).setY(c.y + 0.1), 10), 200, 1)
  assert(graze?.zombie === flyer, 'a generous body: 0.4 m off its middle still hits')
  const head = c.clone().addScaledVector(forward, 0.2).setY(c.y + 0.05 + 0.2 * forward.y)
  const headshot = director.hit(shot(head.clone().addScaledVector(forward, 10), head, 10), 200, 1)
  assert.equal(headshot?.reaction.zone, 'head', 'headshots count')
  assert(!director.hit(shot(c.clone().addScaledVector(side, 12).setY(c.y + 1.5), c.clone().setY(c.y + 1.5), 10), 200, 1), 'a clean miss over it misses')
  assert(director.aimDistance(c.clone().addScaledVector(side, 12), side.clone().negate(), 50) < 12.5, 'rockets and Ray Gun bolts find it in flight')
  // Killed: it bursts, and its place drops to the floor under it (where a Max Ammo from it lands).
  sounds.length = 0
  flyer.health = 5
  const killing = director.hit(shot(c.clone().addScaledVector(side, 12), c, 10), 200, 1)
  assert(killing?.lethal && flyer.state === 'dead', 'a lethal shot kills it')
  assert(sounds.some(s => s.kind === 'inkwing-death' && s.position), 'with its burst heard where it was')
  assert(director.gore.counts.drops > 20 && director.gore.counts.chunks > 3, 'the ink bursts out and falls')
  assert(Math.abs(flyer.position.y - w.world.floor(c, 0.2, 20)) < 0.01, `its place is the floor under it (${f1(flyer.position.y)} m, it died ${f1(c.y)} m up)`)
  run(INKWING.dead + 0.1, [])
  assert(flyer.state === 'idle' && !flyers.owns(flyer), 'and its body goes back to the pool')
}
{
  const { flyer } = oneFlyer()
  const hits = director.blast(flyer.position.clone().add(v(1.5, -0.5, 0)), 3, 1e7)
  assert(hits.some(h => h.zombie === flyer && h.lethal), 'a blast (a frag, a rocket, a Ray Gun bolt) kills it in the air')
}
{
  const { flyer } = oneFlyer()
  const c = flyer.position.clone(), out = v(1, 0, 0)
  const hit = director.knife(c.clone().addScaledVector(out, 1.5), out.clone().negate(), 2.1, 1e7)
  assert(hit?.zombie === flyer && hit.lethal, 'the knife gets one close by')
}
{
  reset()
  const target = player(yard.clone())
  run(0.4, [target])
  flyers.arrive(3, [target], 1e6, seeded(43), 1)
  run(1.2, [target])
  assert.equal(director.killAll(), 3, 'the Nuke takes them too')
}
{
  // The Ink Doll: they circle it, close enough to go with it, and leave everyone alone meanwhile.
  reset()
  const target = player(yard.clone())
  run(0.4, [target])
  flyers.arrive(3, [target], 1e6, seeded(47), 1)
  run(1.5, [target])
  const doll: ZombieTarget = { id: 'doll-0', feet: yard.clone().add(v(6, 0, 4)), alive: true }
  doll.feet.y = w.world.floor(doll.feet.clone().setY(1), 1, 2)
  hurt.length = 0
  let near = 0, frames = 0
  run(DECOY.lure, [doll], 30, () => {
    frames++
    if (clock > 4 && inkwings().every(z => z.position.distanceTo(doll.feet) < DECOY.radius - 1)) near++
  })
  assert.equal(hurt.length, 0, 'nobody is hurt while they circle the doll')
  assert(near > frames * 0.5, `they circle it, in its blast (${near} of ${frames} frames all within ${DECOY.radius - 1} m)`)
  const blast = director.blast(doll.feet, DECOY.radius, 1e7)
  assert.equal(blast.filter(h => h.lethal && flyers.owns(h.zombie)).length, 3, 'and go up with it')
}

// ---- 8. Co-op: the host's snapshot draws them on a guest, and its shots and kills show there -------------------
{
  reset()
  const guestSounds: SoundEvent[] = []
  const guest = new ZombieDirector({ scene: w.scene, world: w.world, doors: w.doors, graph: w.graph, emit: e => guestSounds.push(e), damagePlayer: () => {} })
  await guest.init(director.capacity)
  const target = player(yard.clone())
  run(0.4, [target])
  flyers.arrive(3, [target], 1e6, seeded(53), 1)
  const zombie = director.spawn(pickSpawn(w.graph, w.world, { near: 14, far: 30, eyes: [] }, seeded(3))!, 1e6, 'run', 0)!
  assert(zombie, 'a zombie as well, in the same rows')
  let rows: ZombieSnap[] = [], send = 0, worst = 0, worstAt = '', flagsOk = true, frames = 0
  const step = () => {
    director.update(1 / 60, [target]); clock += 1 / 60
    if ((send -= 1 / 60) <= 0) {
      send = 1 / 15
      rows = director.snapshot()
      for (const row of rows) if (row[9] & FLYER_ROW.flag && (row[9] & ~(0x1f << 19))) flagsOk = false
    }
    guest.puppet(1 / 60, rows, target.feet)
    frames++
    for (let i = 0; i < director.zombies.length; i++) {
      const host = director.zombies[i]
      // A dive is 16 m/s: its first snapshot after it ends comes a tick late, by design (15 a second).
      if (!flyers.owns(host) || host.state !== 'chase' || !flyers.get(host)!.arrived || flyers.get(host)!.mode === 'dive' || guest.flyers.get(guest.zombies[i])?.mode === 'dive') continue
      const gap = host.position.distanceTo(guest.zombies[i].position)
      if (gap > worst) { worst = gap; worstAt = `${flyers.get(host)!.mode} at ${f1(clock)} s, guest ${guest.flyers.get(guest.zombies[i])?.mode}` }
    }
  }
  for (let i = 0; i < 60 * 10; i++) step()
  assert(flagsOk, 'Inkwing rows use snapshot flag bits 19 to 23 only')
  assert.equal(guest.zombies.filter(z => guest.flyers.owns(z)).length, 3, 'the guest has the three Inkwings')
  assert(guest.zombies[director.zombies.indexOf(zombie)].state === 'chase' && !guest.flyers.owns(guest.zombies[director.zombies.indexOf(zombie)]), 'and the zombie, as a zombie')
  assert(worst < 1.2, `smoothly where the host has them, out of a dive (${worst.toFixed(2)} m at worst, ${worstAt})`)
  const heard = (kind: string) => guestSounds.filter(s => s.kind === kind).length, told = (kind: string) => sounds.filter(s => s.kind === kind).length
  assert(heard('inkwing-arrive') === 3, 'the guest sees and hears them come out of the storm')
  assert(told('inkwing-tell') > 0 && heard('inkwing-tell') >= told('inkwing-tell') - 1, `and hears each tell (${heard('inkwing-tell')} of ${told('inkwing-tell')})`)
  assert(heard('inkwing-dive') >= told('inkwing-dive') - 1, 'and each dive')
  assert(guest.flyers.drawCalls >= 3, 'drawn there')
  // A guest's shot: the host works it out against its own (runtime.partnerShot) and the kill shows on the guest.
  const i = director.zombies.findIndex(z => flyers.owns(z) && z.state === 'chase')
  const victim = director.zombies[i], eye = target.feet.clone().setY(target.feet.y + 1.6)
  assert(guest.aimDistance(eye, guest.zombies[i].position.clone().sub(eye).normalize(), 80) < 80, 'the guest\'s own aim finds the puppet (its rockets and bolts burst on it)')
  // (Through any other in the way: a round that pierces, as the sniper's does.)
  const hit = director.hitAll(shot(eye, victim.position, 1e7), 200, 1, false, 4)
  assert(hit.some(h => h.zombie === victim && h.lethal), 'the guest\'s shot, on the host, kills it')
  guestSounds.length = 0
  for (let k = 0; k < 20; k++) step()
  assert(guestSounds.some(s => s.kind === 'inkwing-death'), 'the guest sees it burst')
  for (let k = 0; k < 60; k++) step()
  assert(guest.zombies[i].state === 'idle' && !guest.flyers.owns(guest.zombies[i]), 'and its body is free there again')
  guest.dispose()
}

// ---- 9. A whole storm round, as the runtime runs it: only its Inkwings and sprinters, and the Max Ammo ---------
{
  reset()
  const feet = yard.clone(), target = player(feet), random = seeded(61), pack = new StormPack()
  const state = newGame()
  state.round = 5; state.timer = 0.01
  const seen = new Map<number, { flyers: number; sprinters: number; others: number }>()
  let lastKill: THREE.Vector3 | null = null, kill = 0, storm = false
  const spawnOne = () => {
    const tally = seen.get(state.round)!
    if (storm) {
      const group = pack.next(random, 1 + Math.min(state.toSpawn, MAX_ALIVE - 1 - director.aliveCount))
      if (group) {
        // runtime.spawnInkwings
        state.toSpawn -= group - 1
        const placed = flyers.arrive(group, [target], inkwingHealth(state.round, 1), random, stormNumber(state.round))
        if (placed < group) { pack.back(group - placed); state.toSpawn += group - placed - (placed ? 0 : 1) }
        tally.flyers += placed
        return placed > 0
      }
    }
    const spot = pickSpawn(w.graph, w.world, { near: 14, far: 42, eyes: [] }, random)
    const zombie = spot && director.spawn(spot, zombieHealth(state.round) * (storm ? STORM.health : 1), storm ? 'sprint' : 'run', 0, true)
    if (zombie) { if (storm) tally.sprinters++; else tally.others++ }
    return !!zombie
  }
  for (let t = 0; t < 900 && state.round < 9; t += 1 / 30) {
    const events = stepRounds(state, 1 / 30, director.aliveCount, 1, storm ? STORM.spawnDelay : 1)
    if (events.roundStarted) {
      storm = isStormRound(events.roundStarted)
      seen.set(events.roundStarted, { flyers: 0, sprinters: 0, others: 0 })
      if (storm) state.toSpawn = Math.max(0, pack.begin(events.roundStarted, 1) - events.spawn)
    }
    let failed = 0
    for (let i = 0; i < events.spawn; i++) if (!spawnOne()) failed++
    returnSpawns(state, failed)
    if (events.roundEnded === 7) break
    director.update(1 / 30, [target])
    clock += 1 / 30
    // A player who kills one every half second, the nearest first.
    if ((kill -= 1 / 30) <= 0) {
      kill = 0.5
      const alive = director.zombies.filter(z => z.state === 'chase' && (!flyers.owns(z) || flyers.get(z)!.arrived))
      const next = alive.sort((a, b) => a.position.distanceTo(feet) - b.position.distanceTo(feet))[0]
      if (next) {
        const hit = director.blast(next.position.clone().add(v(0, flyers.owns(next) ? 0 : 1.1, 0)), 0.3, 1e8).find(h => h.zombie === next)
        if (hit?.lethal) lastKill = next.position.clone()
      }
    }
  }
  const pack7 = stormPack(7, 1)
  assert.equal(seen.get(6)?.flyers, 0, 'no Inkwings in round 6')
  assert.equal(seen.get(6)?.others, zombiesInRound(6, 1), 'round 6 is an ordinary round')
  assert.equal(state.phase, 'break', 'the storm round ends')
  assert.deepEqual(seen.get(7), { flyers: pack7.flyers, sprinters: pack7.sprinters, others: 0 }, `round 7 brings its pack: ${pack7.flyers} Inkwings and ${pack7.sprinters} sprinters`)
  assert(lastKill && Math.abs(lastKill.y - w.world.floor(lastKill.clone().setY(lastKill.y + 2.2), 0.1, 3)) < 0.01,
    'the last one fell where the Max Ammo drops, on the ground (runtime.stormReward drops it at the last kill)')
  assert.equal(flyers.alive, 0, 'none left over')
}
{
  // After the storm: round 8 has no Inkwings (the runtime's pack only runs on storm rounds).
  for (let round = 1; round <= 40; round++) if (!isStormRound(round)) assert(![7, 14, 21, 28].includes(round), `round ${round}`)
}

// ---- 10. Twenty-four at once, and what they cost -----------------------------------------------------------
let cost = ''
{
  reset()
  const target = player(yard.clone())
  run(0.4, [target])
  let placed = 0
  for (let g = 0; g < 8; g++) placed += flyers.arrive(3, [target], 1e6, seeded(70 + g), 1)
  assert.equal(placed, 24, 'twenty-four come out')
  run(2, [target])
  const t0 = performance.now()
  run(6, [target])
  const ms = (performance.now() - t0) / (6 * 60)
  assert.equal(flyers.alive, 24)
  assert(flyers.drawCalls <= 6, `drawn in ${flyers.drawCalls} draw calls, all of them`)
  assert(ms < 6, `a frame's thinking for 24 costs ${ms.toFixed(2)} ms`)
  cost = `24 alive: ${ms.toFixed(2)} ms a frame, ${flyers.drawCalls} draw calls`
}

// ---- 11. Tuning: a storm against a scripted player -------------------------------------------------------------
// The mess yard, an AK (Dead Ink's damage scale; Pack-a-Punched once by round 14 and twice by round 21, as a player
// who has got that far has it), and a player who shoots the nearest thing in sight (hitting
// less often the further and faster it is), reloads, gets health back after 3 s unhurt, and sidesteps a share
// (`dodge`) of the dives it sees coming. Thick Ink or not. The storm must be a real threat and still fair.
type Fight = { damage: number; downs: number; seconds: number; dives: number; dive: number; snap: number; swipe: number }
function storm(round: number, dodge: number, thickInk: boolean, moving: boolean, seed: number): Fight {
  const gun = round >= 21 ? 3.2 : round >= 14 ? 2 : 1
  reset()
  const random = seeded(seed), anchor = yard.clone(), feet = yard.clone(), target = player(feet)
  const most = thickInk ? 250 : 100, eye = v(), step = v()
  let health = most, lastHurt = -10, downs = 0, damage = 0, magazine = 30, reload = 0, cooldown = 0, stepLeft = 0, dives = 0, t = 0
  const by = { dive: 0, snap: 0, swipe: 0 }
  const state = newGame(), pack = new StormPack(), watched = new Set<Zombie>()
  state.round = round - 1; state.timer = 0.01
  const aimAt = (z: Zombie) => flyers.owns(z) ? z.position : z.position.clone().setY(z.position.y + 1.2)
  for (; t < 240; t += 1 / 30) {
    const events = stepRounds(state, 1 / 30, director.aliveCount, 1, STORM.spawnDelay)
    if (events.roundStarted) state.toSpawn = Math.max(0, pack.begin(events.roundStarted, 1) - events.spawn)
    let failed = 0
    for (let i = 0; i < events.spawn; i++) {
      const group = pack.next(random, 1 + Math.min(state.toSpawn, MAX_ALIVE - 1 - director.aliveCount))
      if (group) {
        state.toSpawn -= group - 1
        const placed = flyers.arrive(group, [target], inkwingHealth(state.round, 1), random, stormNumber(state.round))
        if (placed < group) { pack.back(group - placed); state.toSpawn += group - placed - (placed ? 0 : 1) }
        if (!placed) failed++
      } else {
        const spot = pickSpawn(w.graph, w.world, { near: 14, far: 42, eyes: [] }, random)
        if (!spot || !director.spawn(spot, zombieHealth(state.round) * STORM.health, 'sprint', 0, true)) failed++
      }
    }
    returnSpawns(state, failed)
    if (events.roundEnded) break
    director.update(1 / 30, [target])
    clock += 1 / 30
    // Hurt: health back after 3 s unhurt; at nothing, down (counted) and straight back up to carry on.
    for (const h of hurt.splice(0)) {
      health -= h.amount; damage += h.amount; lastHurt = t
      by[h.amount === INKWING.dive.damage ? 'dive' : h.amount === INKWING.snap.damage ? 'snap' : 'swipe'] += h.amount
    }
    if (health <= 0) { downs++; health = most }
    if (t - lastHurt > 3) health = Math.min(most, health + 60 / 30)
    // Dodging: a dive at us seen coming, sidestepped as it commits.
    for (const z of director.zombies) {
      const f = flyers.get(z)
      if (!f || f.target !== 'p1') continue
      if (f.mode === 'dive' && !watched.has(z)) {
        watched.add(z); dives++
        if (random() < dodge) { step.set(-f.dir.z, 0, f.dir.x).normalize().multiplyScalar(random() < 0.5 ? 1 : -1); stepLeft = 0.45 }
      }
      if (f.mode !== 'dive') watched.delete(z)
    }
    // A player on the move walks a slow circle round the spot; one who is not stands on it.
    const round = anchor.clone().add(v(Math.cos(t * 0.6) * 3, 0, Math.sin(t * 0.6) * 3))
    const home = moving ? round : anchor
    const move = stepLeft > 0 ? step : feet.distanceTo(home) > 0.3 ? v().subVectors(home, feet).setY(0).normalize() : null
    if (move) {
      const next = feet.clone().addScaledVector(move, 4.2 / 30)
      next.y = w.world.floor(next.clone().setY(next.y + 0.4), 0.2, 0.6, 0.28)
      if (Number.isFinite(next.y)) feet.copy(next)
    }
    stepLeft -= 1 / 30
    // Shooting: the AK, 0.12 s a round, 30 to a magazine, 2.3 s to reload.
    if (reload > 0) { reload -= 1 / 30; continue }
    if ((cooldown -= 1 / 30) > 0) continue
    eye.copy(feet).setY(feet.y + 1.65)
    const seen = director.zombies.filter(z => z.state === 'chase' && (!flyers.owns(z) || flyers.get(z)!.arrived)
      && eye.distanceTo(aimAt(z)) < 45 && w.world.visible(eye, aimAt(z), z.actor.root))
    const next = seen.sort((a, b) => eye.distanceTo(aimAt(a)) - eye.distanceTo(aimAt(b)))[0]
    if (!next) continue
    cooldown = 0.12
    if (--magazine <= 0) { magazine = 30; reload = 2.3 }
    const speed = flyers.owns(next) ? flyers.get(next)!.velocity.length() : 4
    if (random() > THREE.MathUtils.clamp(0.62 - 0.012 * eye.distanceTo(aimAt(next)) - 0.02 * speed, 0.15, 0.62)) continue
    director.hit({ origin: eye.clone(), direction: aimAt(next).clone().sub(eye).normalize(), range: 170, damage: (random() < 0.15 ? 34 * 2.2 : 34) * gun, weapon: 'ak' }, 170, 3.5)
  }
  return { damage, downs, seconds: t, dives, ...by }
}
const tuning: string[] = []
{
  const cases: [string, number, number, boolean, boolean][] = [
    ['round 7, Thick Ink, moving and dodging', 7, 0.6, true, true], ['round 7, Thick Ink, standing still', 7, 0, true, false],
    ['round 7, no perks, moving and dodging', 7, 0.6, false, true], ['round 14, Thick Ink, moving and dodging', 14, 0.6, true, true],
    ['round 21, Thick Ink, moving and dodging', 21, 0.6, true, true],
  ]
  const results = new Map<string, Fight[]>()
  for (const [label, round, dodge, thick, moving] of cases) {
    const runs = [1, 2, 3, 4, 5].map(seed => storm(round, dodge, thick, moving, seed * 101))
    results.set(label, runs)
    const mean = (key: keyof Fight) => runs.reduce((sum, r) => sum + r[key], 0) / runs.length
    tuning.push(`${label}: ${Math.round(mean('damage'))} damage taken, ${mean('downs').toFixed(1)} downs, cleared in ${Math.round(mean('seconds'))} s (${Math.round(mean('dives'))} dives at them, ${Math.round(100 * mean('dive') / INKWING.dive.damage / Math.max(1, mean('dives')))}% landed; from dives ${Math.round(mean('dive'))}, snaps ${Math.round(mean('snap'))}, sprinters ${Math.round(mean('swipe'))})`)
  }
  const mean = (label: string, key: keyof Fight) => results.get(label)!.reduce((sum, r) => sum + r[key], 0) / results.get(label)!.length
  const landed = (label: string) => mean(label, 'dive') / INKWING.dive.damage / Math.max(1, mean(label, 'dives'))
  const decent = 'round 7, Thick Ink, moving and dodging', camper = 'round 7, Thick Ink, standing still'
  assert(results.get(decent)!.every(r => r.seconds < 90), 'a decent player clears the first storm')
  assert(mean(decent, 'damage') >= 100, `and it hurts them, a real threat (${Math.round(mean(decent, 'damage'))} damage)`)
  assert(landed(camper) > 0.7, `a player who never moves is hit by most dives (${Math.round(landed(camper) * 100)}%)`)
  assert(landed(decent) < landed(camper) * 0.75, `moving and dodging makes most of them miss (${Math.round(landed(decent) * 100)}% land)`)
  for (const round of [14, 21]) assert(results.get(`round ${round}, Thick Ink, moving and dodging`)!.every(r => r.seconds < 150), `round ${round}'s storm can be cleared`)
  console.log(`tuning:\n  ${tuning.join('\n  ')}`)
}

console.log(`dead ink flyers checks passed in ${f1((performance.now() - started) / 1000)} s`)
console.log(`reach: ${reach.join('; ')}`)
console.log(cost)
w.world.dispose()
