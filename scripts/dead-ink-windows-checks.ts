import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ATTACK, ZombieDirector, vaultPoint, vaultProgress, type Zombie, type ZombieSnap, type ZombieTarget } from '../src/game/zombies/director'
import { NavGraph, type NavData } from '../src/game/zombies/navgraph'
import { SEALED, ZoneGates } from '../src/game/zombies/zones'
import { BARRIER_WINDOWS, Barriers, WINDOW, type Barrier } from '../src/game/zombies/windows'
import { PLAYER_HEALTH, POINTS } from '../src/game/zombies/rules'
import { setDoorOpen } from '../src/world/doors'
import { seeded } from '../src/game/shared/random'
import type { CoopMessage, WorldState } from '../src/game/zombies/coop'
import type { SoundEvent } from '../src/game/types'
import { buildNavScene } from './nav-scene'

// Dead Ink's boarded windows (windows.ts, the director's window code): where they are, that the road side
// only comes in through them, zombies tearing the planks off and climbing in, swipes through the opening and
// only the opening, the queue, the timeouts, rebuilding for points with its cap, and the co-op round trip.
const bytes = readFileSync('public/models/stickman.glb')
GLTFLoader.prototype.loadAsync = async function () {
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
}
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const started = performance.now()

/** The compound as Dead Ink plays it: every door open but the sealed exit, every zone gate shut. */
function deadInkWorld() {
  const { scene, world, doors } = buildNavScene()
  for (const door of doors) if (SEALED.some(seal => seal.door === door.name)) { setDoorOpen(door, false, true); door.userData.missionLocked = true }
  world.refresh()
  const graph = NavGraph.fromData(JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData)
  const zones = new ZoneGates(scene as THREE.Scene, world, graph)
  zones.closeAll()
  return { scene: scene as THREE.Scene, world, doors, graph }
}
const host = deadInkWorld()
const { scene, world, graph } = host
const spawnPoint = v(-30, 0, -25)
const road = [v(-34, 0, -64), v(-52, 0, -56), v(-26, 0, -61)]
const reachable = (p: THREE.Vector3) => Number.isFinite(graph.distance(graph.nearest(p)))

// ---- 1. Before: the road already walks into the mess hall, through its north wall ---------------------
graph.flow([spawnPoint])
assert(road.every(reachable), 'before the barriers, zombies on the road can already walk in (the baked wall climbs through the north wall)')

const sounds: SoundEvent[] = []
const barriers = new Barriers(scene, world, graph, event => sounds.push(event))
const list = barriers.list

// ---- 2. Where they are, and what they are made of ------------------------------------------------------
assert.equal(list.length, 4, 'four boarded windows')
assert.deepEqual(list.map(b => b.name), [...BARRIER_WINDOWS], 'on the mess hall windows facing the road, in co-op order')
const capsule = new Capsule(v(), v(), 0.3)
for (const b of list) {
  assert.equal(b.boards, WINDOW.boards, `${b.name}: six planks`)
  assert.equal(b.planks.length, WINDOW.boards)
  assert(b.rises.length >= 4, `${b.name}: somewhere out on the road for zombies to climb out (${b.rises.length} spots)`)
  assert(b.queue.length >= 2, `${b.name}: room to wait a turn (${b.queue.length} spots)`)
  assert(b.sill - b.floorIn > 1.2 && b.stand.y - b.sill < -0.4 && b.stand.y - b.sill > -0.9, `${b.name}: the step brings the sill to a zombie's hip (${(b.sill - b.stand.y).toFixed(2)} m)`)
  // The glass is out: shots and sight go through the opening; a body does not.
  const inside = b.centre.clone().addScaledVector(b.inward, 1.2), outside = b.centre.clone().addScaledVector(b.inward, -1.2)
  assert.equal(b.window.visible, false, `${b.name}: the glass is gone`)
  assert(world.visible(inside, outside, new THREE.Object3D()), `${b.name}: you can see through the opening`)
  assert(world.rayDistance(inside, outside.clone().sub(inside).normalize(), 3) > 2.3, `${b.name}: bullets pass through the opening`)
  // A body pressing into the hole from either side meets the blocker (the capsule test sees faces it touches).
  for (const side of [1, -1]) {
    const at = b.centre.clone().addScaledVector(b.inward, side * 0.38)
    capsule.start.copy(at).setY(b.sill + 0.35); capsule.end.copy(at).setY(b.top - 0.35)
    assert.equal(world.fits(capsule), false, `${b.name}: a player cannot climb through from ${side > 0 ? 'inside' : 'outside'}`)
  }
  // Planks nailed across the inside, each a little off true, nail heads toward the room.
  for (const plank of b.planks) {
    const depth = plank.nailed.position.clone().sub(b.centre).dot(b.inward)
    assert(depth > 0.07 && depth < 0.15, `${b.name}: planks sit on the inside face (${depth.toFixed(3)} m)`)
    assert(plank.nailed.position.y > b.sill && plank.nailed.position.y < b.top, `${b.name}: planks across the opening`)
  }
}

// ---- 3. After: the road comes in through the windows only ------------------------------------------------
graph.flow([spawnPoint])
assert(road.every(p => !reachable(p)), 'the road is cut off on foot: no wall climbs through the hall, no roof ladder')
assert(reachable(v(-34, 0.28, -46)) && reachable(v(-34, 0.28, -54)), 'the mess hall is still in play, the kitchen too')
for (const b of list) assert(Number.isFinite(graph.distance(b.landingNode)), `${b.name}: inside the window is in play`)

// ---- The zombies -------------------------------------------------------------------------------------------
const swipes: { id: string; amount: number }[] = []
const director = new ZombieDirector({ scene, world, doors: host.doors, graph, emit: e => sounds.push(e), damagePlayer: (id, amount) => swipes.push({ id, amount }) })
director.random = seeded(3)
await director.init(8)
director.windows = list
const fps = 60
const step = (targets: ZombieTarget[], after?: () => void) => { director.update(1 / fps, targets); barriers.update(1 / fps); after?.() }
const run = (seconds: number, targets: ZombieTarget[], until?: () => boolean, after?: () => void) => {
  let t = 0
  for (; t < seconds && !until?.(); t += 1 / fps) step(targets, after)
  return t
}
const onFloor = (p: THREE.Vector3) => { p.y = world.floor(p.clone().setY(p.y + 0.6), 1, 1.5, 0.28); return p }
const yard: ZombieTarget = { id: 'p1', feet: onFloor(spawnPoint.clone()), alive: true }
const sendIn = (b: Barrier, gait: 'walk' | 'run' | 'sprint' = 'run', rise = 0) => {
  const z = director.spawn(b.rises[rise % b.rises.length], 5000, gait, b.facing, false)!
  assert(z, 'a zombie spawns out on the road')
  director.sendToWindow(z, b)
  return z
}
const stage = (z: Zombie) => z.window?.stage ?? 'in'

// ---- 4. Tear the planks off one at a time, climb through, and come for you ------------------------------
for (const b of list) {
  swipes.length = 0; sounds.length = 0
  const z = sendIn(b)
  const toWindow = run(15, [yard], () => stage(z) === 'tear')
  assert.equal(stage(z), 'tear', `${b.name}: a zombie walks up and climbs the step to the window (${toWindow.toFixed(1)} s)`)
  assert(z.position.distanceTo(b.stand) < 0.05, `${b.name}: it stands on the step at the window`)
  const dropped: number[] = []
  run(WINDOW.boards * WINDOW.tearSeconds + 2, [yard], () => stage(z) !== 'tear', () => { if (dropped[dropped.length - 1] !== b.boards) dropped.push(b.boards) })
  assert.deepEqual(dropped, [6, 5, 4, 3, 2, 1, 0], `${b.name}: it rips the planks off one at a time (${dropped})`)
  assert.equal(b.boards, 0, `${b.name}: it ripped every plank off`)
  assert.equal(b.torn, WINDOW.boards, `${b.name}: six planks owed`)
  assert.equal(sounds.filter(s => s.kind === 'board-tear').length, WINDOW.boards, `${b.name}: a crack of wood for each plank`)
  assert.equal(stage(z), 'vault', `${b.name}: then it climbs through`)
  assert.equal(b.vaulting, z, `${b.name}: the window knows who is in it`)
  const vault = run(WINDOW.vaultSeconds + 0.5, [yard], () => stage(z) === 'in')
  assert.equal(stage(z), 'in', `${b.name}: through in about ${WINDOW.vaultSeconds} s (${vault.toFixed(2)} s)`)
  assert(b.inside(z.position) && z.position.distanceTo(b.landing) < 0.05 && Math.abs(z.position.y - b.floorIn) < 0.05, `${b.name}: on its feet inside`)
  assert(b.occupant === null && b.vaulting === null, `${b.name}: the window is free again`)
  // The planks it tore off lie on the ground outside, below the window.
  for (const plank of b.planks) {
    assert.equal(plank.motion, 'none', `${b.name}: every plank has landed`)
    assert(!b.inside(plank.position) && plank.position.distanceTo(b.centre) < 5.5 && plank.position.y < b.sill, `${b.name}: planks lie outside, below the window (${plank.position.toArray().map(n => n.toFixed(1))})`)
  }
  const chase = run(30, [yard], () => Math.hypot(z.position.x - yard.feet.x, z.position.z - yard.feet.z) <= ATTACK.range)
  assert(Math.hypot(z.position.x - yard.feet.x, z.position.z - yard.feet.z) <= ATTACK.range + 0.1, `${b.name}: then it comes out of the hall and reaches you in the yard (${chase.toFixed(1)} s)`)
  director.clear()
  barriers.reset()
}

// ---- 5. Tearing takes about a second a plank -------------------------------------------------------------
{
  const b = list[1]
  const z = sendIn(b, 'sprint')
  run(15, [yard], () => stage(z) === 'tear')
  const times: number[] = []
  let t = 0, last = b.boards
  while (t < 10 && b.boards > 0) { step([yard]); t += 1 / fps; if (b.boards !== last) { last = b.boards; times.push(t) } }
  const gaps = times.slice(1).map((time, i) => time - times[i])
  assert(times[0] > 0.4 && times[0] < 0.9, `the first plank comes away on the first yank (${times[0].toFixed(2)} s)`)
  assert(gaps.every(gap => Math.abs(gap - WINDOW.tearSeconds) < 0.05), `then one a second (${gaps.map(g => g.toFixed(2))})`)
  director.clear(); barriers.reset()
}

// ---- 6. It hits you through the window, and only through the opening --------------------------------------
{
  const b = list[2]
  const z = sendIn(b)
  run(15, [yard], () => stage(z) === 'tear')
  const reach = (feet: THREE.Vector3) => (director as unknown as { reachThrough(z: Zombie, slot: Barrier, feet: THREE.Vector3): boolean }).reachThrough(z, b, feet)
  const inside = (into: number, side: number) => onFloor(b.centre.clone().addScaledVector(b.inward, 0.07 + into).addScaledVector(b.tangent, side).setY(b.floorIn))
  assert(reach(inside(0.45, 0)), 'standing at the window inside, you are in reach through it')
  assert(reach(inside(0.4, 0.8)), 'a little to the side of it too: the arm comes in through the hole')
  assert(!reach(inside(0.4, 2.2)), 'along the wall past the window, out of reach')
  assert(!reach(inside(2.2, 0)), 'back in the room, out of reach')
  assert(!reach(b.stand.clone().addScaledVector(b.inward, -1)), 'out on the road it is not a swipe through the window')
  // Not through the wall: another window's zombie cannot reach you at this one.
  const other = list[3]
  assert(!(director as unknown as { reachThrough(z: Zombie, slot: Barrier, feet: THREE.Vector3): boolean }).reachThrough(z, other, inside(0.45, 0)), 'the opening it swipes through is its own window\'s')
  // Real swipes, with the planks still up.
  swipes.length = 0
  const player: ZombieTarget = { id: 'p1', feet: inside(0.45, 0), alive: true }
  run(3, [player])
  assert(swipes.length >= 2 && swipes.every(s => s.id === 'p1' && s.amount === PLAYER_HEALTH.zombieHit), `a player at the window gets swiped through it (${swipes.length} swipes)`)
  assert(b.boards > 0, 'while it swipes it is not tearing')
  swipes.length = 0
  player.feet.copy(inside(0.45, 2.4))
  run(4, [player])
  assert.equal(swipes.length, 0, 'step along the wall away from the window and it cannot reach you')
  director.clear(); barriers.reset()
}

// ---- 7. One at a time at a window; the others wait their turn beside it -------------------------------------
{
  const b = list[3]
  const zombies = [sendIn(b, 'run', 0), sendIn(b, 'run', 3), sendIn(b, 'run', 7)]
  let most = 0, t = 0
  const order: number[] = []
  while (t < 60 && zombies.some(z => stage(z) !== 'in')) {
    step([yard]); t += 1 / fps
    most = Math.max(most, zombies.filter(z => stage(z) === 'tear' || stage(z) === 'vault').length)
    zombies.forEach((z, i) => { if (stage(z) === 'in' && !order.includes(i)) order.push(i) })
  }
  assert(zombies.every(z => stage(z) === 'in'), `all three came through (${t.toFixed(1)} s)`)
  assert.equal(most, 1, 'never two at the window at once')
  assert.deepEqual(order, [0, 1, 2], 'in the order they arrived')
  director.clear(); barriers.reset()
}

// ---- 8. Never stuck at a window --------------------------------------------------------------------------
{
  // Players keep nailing planks back: after WINDOW.giveUp seconds it smashes the rest and climbs in anyway.
  const b = list[0]
  const z = sendIn(b, 'sprint')
  run(15, [yard], () => stage(z) === 'tear')
  let t = 0
  while (t < WINDOW.giveUp + 5 && stage(z) === 'tear') {
    step([yard]); t += 1 / fps
    if (b.boards < WINDOW.boards - 1) barriers.rebuild(b, 'p1', 1)
  }
  assert(t > WINDOW.giveUp - 0.5, `held at the window while planks go back up (${t.toFixed(1)} s)`)
  assert.equal(stage(z), 'vault', `after ${WINDOW.giveUp} s it smashes through anyway (${t.toFixed(1)} s)`)
  assert.equal(b.boards, 0, 'every plank torn off at once')
  run(3, [yard], () => stage(z) === 'in')
  assert.equal(stage(z), 'in', 'and is inside')
  // However it was held up, none stays on a window for good: past WINDOW.stuck seconds it is put inside, and
  // the one waiting behind it moves up.
  director.clear(); barriers.reset()
  const first = sendIn(b), second = sendIn(b)
  run(1, [yard])
  first.window!.age = WINDOW.stuck - 0.05
  // (Up the step is a fixed path that always ends, so the limit applies as soon as it is up.)
  run(3, [yard], () => stage(first) === 'in')
  assert.equal(stage(first), 'in', `a zombie still on its window after ${WINDOW.stuck} s is put inside`)
  assert(b.inside(first.position), 'inside the hall')
  assert(b.occupant === second, 'and the next one moves up')
  director.clear(); barriers.reset()
}

// ---- 9. Killed at the window: it drops where it was, and the next comes up ------------------------------------
{
  const b = list[1]
  const first = sendIn(b), second = sendIn(b)
  run(15, [yard], () => stage(first) === 'tear')
  first.health = 1
  director.blast(first.position.clone().setY(first.position.y + 1.1), 1, 500)
  assert.equal(first.state, 'dead', 'the zombie at the window dies')
  assert(b.occupant === second && second.window !== null, 'the one waiting takes its place')
  run(20, [yard], () => stage(second) === 'tear')
  assert.equal(stage(second), 'tear', 'and tears at the window')
  director.clear(); barriers.reset()
}

// ---- 10. Rebuilding: points for planks zombies tore off, capped each round, never for nothing ------------------
{
  const b = list[0]
  const ledger = barriers.ledger
  ledger.reset()
  assert.equal(barriers.rebuild(b, 'p1', 1), -1, 'a whole window cannot be rebuilt')
  assert.equal(ledger.paidBy('p1', 1), 0, 'and pays nothing')
  for (let i = 0; i < 3; i++) b.tear()
  sounds.length = 0
  assert.deepEqual([1, 2, 3].map(() => barriers.rebuild(b, 'p1', 1)), [POINTS.board, POINTS.board, POINTS.board], 'each plank a zombie tore off pays 10 when put back')
  assert.equal(sounds.filter(s => s.kind === 'board-hammer').length, 3, 'a hammer for each plank')
  assert.equal(b.boards, WINDOW.boards, 'the window is whole again')
  assert.equal(barriers.rebuild(b, 'p1', 1), -1, 'then nothing more to rebuild, and nothing more to earn')
  b.tear()
  assert.equal(barriers.rebuild(b, 'p1', 1, 2), 2 * POINTS.board, 'Double Points doubles a plank')
  // A plank missing that no zombie tore off (never happens in play) goes back up for nothing.
  b.boards--
  assert.equal(barriers.rebuild(b, 'p1', 1), 0, 'only planks a zombie tore off pay')
  // The cap: 500 a round, per player; after it you can still rebuild, for nothing; a new round pays again.
  ledger.reset()
  let paid = 0, boards = 0
  for (let i = 0; i < 80; i++) {
    b.tear()
    const got = barriers.rebuild(b, 'p1', 4)
    assert(got >= 0, 'every torn plank can be rebuilt')
    paid += got; boards++
  }
  assert.equal(paid, WINDOW.roundCap, `80 planks in one round pay the ${WINDOW.roundCap} cap, no more`)
  assert.equal(ledger.left('p1', 4), 0, 'the round\'s rebuild points are spent')
  assert.equal(b.boards, WINDOW.boards, 'the planks still went up after the cap')
  b.tear()
  assert.equal(barriers.rebuild(b, 'p2', 4), POINTS.board, 'your partner has a cap of their own')
  b.tear()
  assert.equal(barriers.rebuild(b, 'p1', 5), POINTS.board, 'the next round pays again')
  // The cap counts what was paid: with Double Points it is reached in half the planks, never passed.
  ledger.reset()
  let doubled = 0
  for (let i = 0; i < 40; i++) { b.tear(); doubled += barriers.rebuild(b, 'p1', 6, 2) }
  assert.equal(doubled, WINDOW.roundCap, 'under Double Points the cap still holds')
  barriers.reset()
}

// ---- 10b. A plank flies back in through the opening, never through the wall ---------------------------------
{
  const b = list[3]
  for (let i = 0; i < WINDOW.boards; i++) b.tear()
  for (let i = 0; i < 240; i++) barriers.update(1 / 60)
  assert(b.planks.every(plank => plank.motion === 'none'), 'the torn planks have landed')
  for (let n = 0; n < WINDOW.boards; n++) {
    barriers.rebuild(b, 'p1', 9)
    const plank = b.planks.find(p => p.motion === 'back')!
    let before = plank.position.clone().sub(b.centre).dot(b.inward), crossed = false
    for (let i = 0; i < 60 && plank.motion === 'back'; i++) {
      barriers.update(1 / 144)
      const after = plank.position.clone().sub(b.centre).dot(b.inward)
      if (before < 0 && after >= 0) {
        crossed = true
        const side = plank.position.clone().sub(b.centre).dot(b.tangent)
        assert(plank.position.y > b.sill + 0.05 && plank.position.y < b.top - 0.05 && Math.abs(side) < b.halfWidth,
          `plank ${n + 1} comes in through the opening (at ${plank.position.y.toFixed(2)} m, ${side.toFixed(2)} along; sill ${b.sill.toFixed(2)}, top ${b.top.toFixed(2)})`)
      }
      before = after
    }
    assert(crossed && plank.motion === 'none', `plank ${n + 1} flew back from outside and is nailed up`)
    assert(plank.position.distanceTo(plank.nailed.position) < 1e-6, `plank ${n + 1} exactly where it was`)
  }
  barriers.reset()
}

// ---- 11. Co-op: the host's windows on the guest's screen, and the guest's rebuild on the host ------------------
{
  const guestWorld = deadInkWorld()
  const guestSounds: SoundEvent[] = []
  const guest = new Barriers(guestWorld.scene, guestWorld.world, guestWorld.graph, event => guestSounds.push(event))
  const b = list[1]
  b.tear(); b.tear(); list[3].tear()
  const state = JSON.parse(JSON.stringify({ win: barriers.counts(), wp: barriers.ledger.paidBy('p2', 2) } satisfies Partial<WorldState>)) as WorldState
  guest.apply(state.win!)
  assert.deepEqual(guest.counts(), barriers.counts(), 'the guest sees the host\'s planks')
  assert.equal(guestSounds.filter(s => s.kind === 'board-tear').length, 3, 'and hears them come off')
  assert(guest.list[1].planks.some(p => p.motion === 'off'), 'and sees them fly')
  // The guest holds F at window 1: a message to the host, which nails the plank and pays the guest.
  const use = JSON.parse(JSON.stringify({ t: 'use', what: 'window', index: 1 } satisfies CoopMessage)) as Extract<CoopMessage, { t: 'use'; what: 'window' }>
  const award = barriers.rebuild(list[use.index], 'p2', 2)
  assert.equal(award, POINTS.board, 'the host pays the guest 10 for it (sent back in an award message)')
  assert.equal(barriers.ledger.paidBy('p2', 2), POINTS.board, 'counted against the guest\'s cap, which rides in the world state')
  guestSounds.length = 0
  guest.apply(barriers.counts())
  assert.deepEqual(guest.counts(), barriers.counts(), 'and the guest sees it go back up')
  assert.equal(guestSounds.filter(s => s.kind === 'board-hammer').length, 1, 'with the hammer')
  // A new game on the host: the guest's windows are whole again at once, without a burst of hammering.
  for (let i = 0; i < 4; i++) list[0].tear()
  guest.apply(barriers.counts())
  for (let i = 0; i < 240; i++) guest.update(1 / 60)
  guestSounds.length = 0
  barriers.reset(); guest.apply(barriers.counts())
  assert.deepEqual(guest.counts(), barriers.counts(), 'a new game: the guest\'s windows are whole')
  assert.equal(guestSounds.filter(s => s.position && s.position.distanceTo(guest.list[0].point) < 0.1).length, 0, 'at once and silently')
  assert(guest.list[0].planks.every(p => p.motion === 'none' && p.position.distanceTo(p.nailed.position) < 1e-6), 'every plank back on its nails')
  // Zombies: a host zombie tearing, then climbing through, drawn on the guest from the snapshot's flags.
  const guestDirector = new ZombieDirector({ scene: guestWorld.scene, world: guestWorld.world, doors: guestWorld.doors, graph: guestWorld.graph, emit: () => {}, damagePlayer: () => {} })
  await guestDirector.init(director.capacity)
  guestDirector.windows = guest.list
  const z = sendIn(list[2], 'sprint')
  const index = director.zombies.indexOf(z)
  const snap = () => director.snapshot().find(row => row[0] === index)! as ZombieSnap
  run(15, [yard], () => stage(z) === 'tear')
  run(0.3, [yard])
  const tearing = snap()
  assert(tearing[9] & 512 && (tearing[9] >> 11 & 7) === 3, `a tearing zombie's row says so, and which window (flags ${tearing[9]})`)
  for (let i = 0; i < 30; i++) guestDirector.puppet(1 / 60, [snap()])
  const puppet = guestDirector.zombies[index]
  assert(puppet.state === 'chase' && puppet.window?.stage === 'tear', 'the guest draws it tearing at the window')
  const hands = (['L', 'R'] as const).map(side => puppet.actor.rig.bones[`hand.${side}`].getWorldPosition(v()))
  assert(hands.some(hand => hand.distanceTo(list[2].centre) < 1.3), 'with its hands at the window')
  run(WINDOW.boards * WINDOW.tearSeconds + 1, [yard], () => stage(z) === 'vault')
  run(WINDOW.vaultSeconds * 0.45, [yard])
  const climbing = snap()
  assert(climbing[9] & 1024, 'a zombie climbing through says so')
  for (let i = 0; i < 20; i++) guestDirector.puppet(1 / 60, [snap()])
  const u = vaultProgress(guest.list[2], puppet.position)
  assert(u > 0.2 && u < 0.8, `the guest reads how far through it is from where it is (${u.toFixed(2)})`)
  assert(puppet.actor.rig.bones.chest.getWorldPosition(v()).y > guest.list[2].sill, 'and draws it over the sill')
  run(3, [yard], () => stage(z) === 'in')
  for (let i = 0; i < 10; i++) guestDirector.puppet(1 / 60, [snap()])
  assert.equal(puppet.window, null, 'once it is in, the guest draws it as any other')
  guestDirector.dispose(); guest.dispose(); guestWorld.world.dispose()
  director.clear(); barriers.reset()
}

// ---- 12. The climb through: over the sill, never through the wall under it or the lintel over it --------------------
{
  const b = list[0]
  for (let i = 0; i <= 20; i++) {
    const u = i / 20, p = vaultPoint(b, u, v())
    assert(Math.abs(vaultProgress(b, p) - u) < 1e-6, 'vaultPoint and vaultProgress agree')
    const across = p.clone().sub(b.centre).dot(b.inward)
    const hips = p.y + 0.84
    if (Math.abs(across) < 0.2) assert(hips > b.sill + 0.2 && hips < b.top - 0.6, `in the hole the body is between the sill and the lintel (u ${u.toFixed(2)}, hips ${hips.toFixed(2)})`)
  }
}

// ---- 13. Dispose puts the mess hall back as the hostage mission has it ------------------------------------------
barriers.dispose()
graph.flow([spawnPoint])
assert(road.every(reachable), 'the graph cuts are undone')
for (const b of list) {
  assert.equal(b.window.visible, true, `${b.name}: the glass is back`)
  const inside = b.centre.clone().addScaledVector(b.inward, 1.2), outside = b.centre.clone().addScaledVector(b.inward, -1.2)
  assert(!world.visible(inside, outside, new THREE.Object3D()), `${b.name}: and solid again`)
}
director.dispose()
world.dispose()
console.log(`dead ink windows checks passed in ${((performance.now() - started) / 1000).toFixed(1)} s: ${list.length} windows`)
