// The rescue campaign's rules, in Node: the unlock order and the saved progress (and that a save code carries
// it), difficulty scaling, seeded runs, objectives and stages, the noise and sight rules, gradual detection and
// takedowns on a real director, and the follow escort (following, footprints round a wall, waiting, taking
// cover, boarding) with the hostage's health, going down, revive and death.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnemyDirector } from '../src/game/ai'
import type { EnemyActor } from '../src/game/actors'
import { CollisionWorld } from '../src/player/collision'
import type { PlayerSense, SoundEvent } from '../src/game/types'
import { CampaignStore, CAMPAIGN_KEY, sanitizeProgress, formatTime } from '../src/game/campaign/progress'
import { MAPS, MISSIONS, MISSION_IDS, mapFor, missionById } from '../src/game/campaign/missions'
import { DIFFICULTY, missionReward, rulesFor } from '../src/game/campaign/difficulty'
import { createRun, resolveGuards, updateObjectives, currentStage, objectiveLine, hurtHostage, bleedHostage, reviveHostage, HOSTAGE_BLEED_SECONDS } from '../src/game/campaign/run'
import { NOISE, detectionRate, footstepRadius, shotRadius, starsFor, stealthRating, SUSPECT_AT, type RunStats } from '../src/game/campaign/stealth'
import { exportSave, importSave } from '../src/game/save-transfer'
import { FollowEscort } from '../src/game/campaign/escort'
import type { HostageActor } from '../src/game/hostage-actor'
import { DIFFICULTIES, type MapModule, type MissionDef } from '../src/game/campaign/types'
import { initialMission } from '../src/game/mission'

let passed = 0
function test(name: string, check: () => void | Promise<void>) {
  const result = check()
  if (result instanceof Promise) return result.then(() => { console.log(`PASS ${name}`); passed++ })
  console.log(`PASS ${name}`); passed++
}
const memoryStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } }
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)

test('the campaign opens in order: one mission at first, each finish opens the next, never a jump ahead', () => {
  const store = new CampaignStore(MISSION_IDS, memoryStore())
  assert.equal(MISSIONS.length >= 5, true)
  assert.deepEqual(MISSIONS.map(m => m.number), MISSIONS.map((_, i) => i + 1))
  assert(store.isUnlocked(MISSION_IDS[0]))
  for (const id of MISSION_IDS.slice(1)) assert(!store.isUnlocked(id), `${id} starts locked`)
  assert.equal(store.current().id, MISSION_IDS[0])
  // Finishing mission 1 opens mission 2 only; finishing it again opens nothing more.
  const first = store.complete(MISSION_IDS[0], 'normal', 1500, [true, false, true])
  assert.equal(first.unlocked, MISSION_IDS[1]); assert(first.best)
  assert(store.isUnlocked(MISSION_IDS[1])); assert(!store.isUnlocked(MISSION_IDS[2]))
  assert.equal(store.complete(MISSION_IDS[0], 'hard', 1700, [false, true, false]).unlocked, null)
  assert(!store.isUnlocked(MISSION_IDS[2]))
  // A locked mission cannot be recorded into opening the one after it.
  assert.equal(store.current().id, MISSION_IDS[1], 'the newest open mission is the default')
  // Best time is the lowest; stars are every star ever earned on that difficulty.
  const again = store.complete(MISSION_IDS[0], 'normal', 1800, [false, true, false])
  assert(!again.best)
  assert.deepEqual(store.best(MISSION_IDS[0], 'normal'), { time: 1500, completions: 2, stars: [true, true, true] })
  assert.equal(store.starCount(MISSION_IDS[0]), 4)
  for (let i = 1; i < MISSION_IDS.length; i++) store.complete(MISSION_IDS[i], 'normal', 2000, [false, false, false])
  assert(MISSION_IDS.every(id => store.isUnlocked(id)))
  store.select(MISSION_IDS[2], 'nightmare')
  assert.deepEqual(store.current(), { id: MISSION_IDS[2], difficulty: 'nightmare' })
  assert.equal(formatTime(1500), '25:00'); assert.equal(formatTime(3725), '1:02:05')
})

test('stored progress is untrusted: junk falls back, counts are clamped, and a save code carries it to a new address', () => {
  assert.deepEqual(sanitizeProgress('nope', 5), sanitizeProgress(null, 5))
  const odd = sanitizeProgress({ unlocked: 99, difficulty: 'impossible', best: { 'safe-return': { normal: { time: -4 }, hard: { time: 90, stars: [1, true] } } } }, 5)
  assert.equal(odd.unlocked, 5); assert.equal(odd.difficulty, 'normal')
  assert.equal(odd.best['safe-return']?.normal, undefined)
  assert.deepEqual(odd.best['safe-return']?.hard?.stars, [false, true, false])
  const from = memoryStore(), to = memoryStore()
  const store = new CampaignStore(MISSION_IDS, from)
  store.complete(MISSION_IDS[0], 'hard', 1234, [true, true, false])
  store.select(MISSION_IDS[1], 'hard')
  const code = exportSave(from)
  assert(importSave(code, to))
  assert.equal(to.getItem(CAMPAIGN_KEY), from.getItem(CAMPAIGN_KEY))
  const moved = new CampaignStore(MISSION_IDS, to)
  assert(moved.isUnlocked(MISSION_IDS[1]))
  assert.deepEqual(moved.best(MISSION_IDS[0], 'hard'), { time: 1234, completions: 1, stars: [true, true, false] })
  assert.deepEqual(moved.current(), { id: MISSION_IDS[1], difficulty: 'hard' })
})

test('harder difficulties bring more guards, sharper and quicker ones, more reinforcements, a frailer hostage and bigger rewards', () => {
  for (const [easier, harder] of [['normal', 'hard'], ['hard', 'nightmare']] as const) {
    const a = DIFFICULTY[easier], b = DIFFICULTY[harder]
    assert(b.accuracy > a.accuracy && b.alertness > a.alertness && b.reinforcements > a.reinforcements && b.smell > a.smell)
    assert(b.cameraDwell < a.cameraDwell && b.secondWave < a.secondWave && b.hostageHealth < a.hostageHealth && b.reward > a.reward)
    assert(missionReward(3, 2, harder).ink > missionReward(3, 2, easier).ink && missionReward(3, 2, harder).xp > missionReward(3, 2, easier).xp)
  }
  const worldGuards = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, name: 'W', position: [0, 0, 0] as [number, number, number], patrol: [], weapon: 'ak' as const }))
  for (const mission of MISSIONS) {
    const map = mapFor(mission)
    const counts = DIFFICULTIES.map(d => resolveGuards(mission, map, createRun(mission, map, d, 7), worldGuards).length)
    assert(counts[0] < counts[1] && counts[1] < counts[2], `${mission.id} guard counts grow: ${counts}`)
    const run = createRun(mission, map, 'nightmare', 7)
    assert(run.hostages.every(h => h.health === rulesFor('nightmare').hostageHealth))
  }
  // Later missions are bigger: more stages and more guards than the first.
  const size = (id: string) => { const m = missionById(id)!; return resolveGuards(m, mapFor(m), createRun(m, mapFor(m), 'normal', 1), worldGuards).length }
  assert(size(MISSION_IDS[4]) > size(MISSION_IDS[0]))
  assert(MISSIONS.at(-1)!.stages.length >= MISSIONS[0].stages.length && MISSIONS.every(m => m.stages.length >= 6))
  assert(MISSIONS.filter(m => mapFor(m).extractions[m.extraction].kind !== 'jeep' || m.id !== 'safe-return').length >= 2)
})

test('runs are seeded: the same seed picks the same cell, way in, keycard spot and patrols; other seeds vary them', () => {
  for (const mission of MISSIONS) {
    const map = mapFor(mission)
    assert.deepEqual(createRun(mission, map, 'hard', 42), createRun(mission, map, 'hard', 42))
    const cells = new Set(Array.from({ length: 40 }, (_, seed) => createRun(mission, map, 'normal', seed).cells.join()))
    assert(cells.size >= Math.min(3, mission.cells.length), `${mission.id}: the hostage moves between runs (${cells.size})`)
    const run = createRun(mission, map, 'normal', 3)
    assert.equal(run.cells.length, mission.hostages)
    assert.equal(new Set(run.cells).size, mission.hostages, 'two hostages never share a cell')
    for (const card of mission.keycards) assert(card.at.includes(run.cards[card.id]))
  }
  const routed = MISSIONS.find(m => m.guards.some(id => mapFor(m).guards[id]?.routes?.length))!
  const variants = new Set(Array.from({ length: 30 }, (_, seed) => JSON.stringify(createRun(routed, mapFor(routed), 'nightmare', seed).routes)))
  assert(variants.size > 1, 'guard patrols change between runs')
})

test('objectives complete in any order and the stage moves on; the helicopter mission needs the call, the landing and the boarding', () => {
  const mission = missionById('cold-storage')!, map = mapFor(mission)
  const run = createRun(mission, map, 'normal', 5)
  const cell = map.cells[run.cells[0]]
  const facts = (over: Partial<Parameters<typeof updateObjectives>[3]> = {}) => ({ players: [[0, 0, 0]], hostages: [{ freed: false, loaded: false, position: cell.hostage }], complete: false, ...over })
  assert.equal(currentStage(mission, run).id, 'dark')
  // Freeing her first (a team that stumbled on her) counts once they get there.
  const early = updateObjectives(mission, map, run, facts({ players: [cell.hostage], hostages: [{ freed: true, loaded: false, position: cell.hostage }] }))
  assert.deepEqual(early.map(o => o.id).sort(), ['find', 'free'])
  assert.equal(run.stage, 0, 'the power stage is still open')
  run.used.push('fuse-west', 'intel-admin')
  updateObjectives(mission, map, run, facts({ hostages: [{ freed: true, loaded: false, position: cell.hostage }] }))
  assert.equal(currentStage(mission, run).id, 'call', 'power, intel and the rescue are done: call the helicopter')
  assert.match(objectiveLine(mission, run), /radio/)
  run.called = true
  updateObjectives(mission, map, run, facts({ hostages: [{ freed: true, loaded: false, position: cell.hostage }] }))
  assert.equal(currentStage(mission, run).id, 'hold')
  run.arrived = true
  const heli = map.extractions[mission.extraction]
  updateObjectives(mission, map, run, facts({ hostages: [{ freed: true, loaded: false, position: heli.board }] }))
  assert(run.done.includes('escort'))
  updateObjectives(mission, map, run, facts({ complete: true, hostages: [{ freed: true, loaded: true, position: heli.board }] }))
  assert.equal(run.stage, mission.stages.length, 'every stage done')
  // The classic state still reads its own objectives; a campaign state reads the stage's.
  const state = initialMission()
  assert.match(objectiveLine(mission, createRun(mission, map, 'normal', 5)), /power/)
  assert.equal(state.run, undefined)
})

test('noise and sight: crouching is quiet, running loud, suppressed pistols quiet; closer, standing and moving is seen sooner', () => {
  assert(footstepRadius(3, true) < footstepRadius(3, false) && footstepRadius(3, false) < footstepRadius(6, false))
  assert.equal(footstepRadius(3, false), 6); assert.equal(footstepRadius(6, false), 15)
  assert(shotRadius('pistol', true) < shotRadius('pistol') && shotRadius('pistol') < shotRadius('ak'))
  assert(NOISE.stone > NOISE.walk && NOISE.breach > NOISE.rifle)
  assert.equal(detectionRate(2, {}), Infinity, 'point blank is instant')
  assert(detectionRate(5, { moving: true }) > detectionRate(15, { moving: true }))
  assert(detectionRate(10, { moving: true }) > detectionRate(10, { moving: true, crouched: true }))
  assert(detectionRate(10, { moving: true, running: true }) > detectionRate(10, { moving: true }))
  assert(detectionRate(10, { moving: true }) > detectionRate(10, {}))
  assert(detectionRate(10, { moving: true }) > detectionRate(10, { moving: true, leaning: true }))
  assert(detectionRate(10, { moving: true }, 1.6) > detectionRate(10, { moving: true }, 0.8))
  const stats: RunStats = { time: 900, par: 1200, alarms: 0, detections: 0, kills: 0, takedowns: 0, shots: 0, loudShots: 0, hostageDamage: 0, hostageDowned: 0, bodiesFound: 0 }
  assert.deepEqual(starsFor(stats), [true, true, true]); assert.equal(stealthRating(stats), 'Ghost')
  assert.deepEqual(starsFor({ ...stats, time: 1300, alarms: 1, hostageDamage: 5 }), [false, false, false])
  assert.equal(stealthRating({ ...stats, kills: 3, takedowns: 3, bodiesFound: 1 }), 'Silent')
  assert.equal(stealthRating({ ...stats, alarms: 3, loudShots: 90 }), 'Loud')
})

// A director on flat ground, as the AI checks build one.
const fakeActor = async () => {
  const root = new THREE.Group()
  return { root, reactionRemaining: 0, animationTime: 0, deathClip: 'dieBody', update() {}, shoot() {}, restore() {}, react() {}, dispose() {}, muzzle: () => root.position.clone().add(v(0, 1.4, 0.3)) } as unknown as EnemyActor
}
async function guardFixture(options: Partial<EnemyDirector['options']> = {}) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 0.4), new THREE.MeshBasicMaterial())
  wall.userData.doorHinge = true; wall.position.set(500, 3, 0); scene.add(wall)
  const world = new CollisionWorld(scene), events: SoundEvent[] = []
  const ai = new EnemyDirector({ scene, world, doors: [], specs: [{ id: 'g', name: 'Guard', position: [0, 0, 0], patrol: [], weapon: 'ak', facing: 0 },
    { id: 'h', name: 'Second', position: [30, 0, -30], patrol: [], weapon: 'ak', facing: Math.PI }], emit: e => events.push(e), damagePlayer() {}, dropWeapon() {} }, fakeActor)
  await ai.init()
  ai.options = { accuracy: 1, alertness: 1, sight: 1, gradual: true, ...options }
  return { ai, world, wall, events, guard: ai.enemies[0], dispose() { ai.dispose(); world.dispose() } }
}
const sense = (z: number, crouched = false): PlayerSense => ({ feet: v(0, 0, z), eye: v(0, crouched ? 1.05 : 1.65, z), velocity: v(0.5, 0, 0), alive: true, radioEnabled: true, exposure: { crouched, moving: true } })
const run = (ai: EnemyDirector, player: PlayerSense, seconds: number) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) ai.update(1 / 60, player) }

await test('gradual detection: a guard looks before he shoots; crouching at range buys time; a wall breaks it; far is slower than near', async () => {
  const f = await guardFixture()
  const player = sense(14)
  run(f.ai, player, 0.3)
  assert(f.guard.awareness > 0 && f.guard.awareness < 1, `awareness builds (${f.guard.awareness})`)
  assert.notEqual(f.guard.state, 'combat', 'not sure yet')
  run(f.ai, player, 0.6)
  assert(f.guard.awareness >= SUSPECT_AT)
  assert.equal(f.guard.state, 'suspicious', 'he stops to look')
  run(f.ai, player, 2)
  assert.equal(f.guard.state, 'combat', 'then he is sure')
  f.dispose()
  const timeTo = async (z: number, crouched: boolean) => {
    const g = await guardFixture(), p = sense(z, crouched)
    let t = 0
    while (g.guard.state !== 'combat' && t < 20) { run(g.ai, p, 0.05); t += 0.05 }
    g.dispose(); return t
  }
  const near = await timeTo(6, false), far = await timeTo(18, false), crouchedFar = await timeTo(18, true)
  assert(near < far && far < crouchedFar, `near ${near} < far ${far} < crouched ${crouchedFar}`)
  // Breaking line of sight lets it fade.
  const h = await guardFixture(), p = sense(16)
  run(h.ai, p, 0.4)
  const partly = h.guard.awareness
  h.wall.position.set(0, 3, 5); h.world.refresh()
  run(h.ai, p, 3)
  assert(h.guard.awareness < partly, 'awareness fades behind cover')
  assert.notEqual(h.guard.state, 'combat')
  h.dispose()
  // Classic mode (the checks, the old mission): sight is contact at once.
  const c = await guardFixture({ gradual: false })
  run(c.ai, sense(14), 0.3)
  assert.equal(c.guard.state, 'combat')
  c.dispose()
})

await test('takedowns: only an unaware guard, silently; a sure guard cannot be taken down; the body can be found', async () => {
  const f = await guardFixture()
  const behind = sense(-1.2)
  run(f.ai, { ...behind, alive: false }, 0.1)
  assert(f.ai.takedown(f.guard, v(0, 0, 1)))
  assert.equal(f.guard.state, 'dead'); assert.equal(f.guard.health, 0)
  assert(!f.events.some(e => e.kind === 'enemy-pain'), 'no cry')
  assert(f.events.some(e => e.kind === 'enemy-down' && (e.radius ?? 99) <= NOISE.takedown))
  assert(!f.ai.takedown(f.guard, v(0, 0, 1)), 'only once')
  // The second guard walks past and finds the body.
  const second = f.ai.enemies[1]
  second.position.set(0, 0, -8); second.yaw = 0
  run(f.ai, { ...behind, alive: false, feet: v(80, 0, 80), eye: v(80, 1.65, 80) }, 0.5)
  assert(second.noticedBodies.includes('g'), 'the body is found')
  f.dispose()
  const g = await guardFixture()
  run(g.ai, sense(4), 3)
  assert.equal(g.guard.state, 'combat')
  assert(!g.ai.takedown(g.guard, v(0, 0, 1)), 'a guard in a fight cannot be taken down')
  g.dispose()
})

await test('difficulty reaches the guards: accuracy scales hits, sight scales range', async () => {
  const f = await guardFixture({ sight: 0.5 })
  run(f.ai, sense(14), 2)
  assert.equal(f.guard.awareness, 0, 'half sight does not reach 14 m')
  f.dispose()
})

// The follow escort, with stand-in hostage actors on a floor with a wall to walk round.
function escortFixture() {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 0.2, 200), new THREE.MeshBasicMaterial())
  floor.position.y = -0.1; scene.add(floor)
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 12), new THREE.MeshBasicMaterial())
  wall.position.set(5, 1.5, 0); scene.add(wall)
  const world = new CollisionWorld(scene)
  const escort = new FollowEscort(scene, world, [])
  const actor = () => {
    const root = new THREE.Group()
    return { root, canWalk: true, advanceRelease() {}, restore() {}, animate() {}, dispose() {} } as unknown as HostageActor
  }
  escort.actors.push(actor())
  const extraction = { id: 'x', kind: 'helicopter' as const, label: 'Out', board: [40, 0, 0] as [number, number, number], seats: [[40, 0.9, 0]] as [number, number, number][],
    route: [[40, 0, 0], [40, 10, 0]] as [number, number, number][], camera: { target: [40, 1, 0] as [number, number, number], offset: [5, 5, 5] as [number, number, number] },
    zone: { x: 40, z: 0, r: 8 }, park: [40, 0, 0] as [number, number, number], heading: 0 }
  ;(escort as unknown as { extraction: unknown; travel: unknown[]; spots: unknown[] }).extraction = extraction
  ;(escort as unknown as { travel: unknown[] }).travel = [{ crumb: -1, trail: -1, detour: [], replanAfter: 0, stalled: 0, cover: null, coverFrom: null, boardingFrom: null, boardingTime: 0, seated: false }]
  const state = { ...initialMission(), hostages: [{ id: 'h', status: 'following' as const, position: [0, 0.02, 0] as [number, number, number], routeIndex: 0 }] }
  state.run = { hostages: [{ health: 100, max: 100, down: 0, bleed: 0, waiting: false, leader: 0 }], arrived: false } as never
  const step = (feet: THREE.Vector3, seconds: number, danger = false, record = true) => {
    for (let i = 0; i < Math.ceil(seconds * 30); i++) {
      if (record) escort.record(0, feet, true)
      escort.players = [{ id: 0, feet, up: true }]
      escort.update(1 / 30, state, feet, danger)
    }
  }
  const at = () => new THREE.Vector3(...state.hostages[0].position)
  return { escort, state, step, at, wall, world }
}

test('escort: he follows the nearest player and stops beside them; waits when told; follows footprints round a wall', () => {
  const f = escortFixture()
  const leader = v(0, 0.02, 12)
  f.step(leader, 8)
  assert(f.at().distanceTo(leader) < 3.2, `he caught up (${f.at().distanceTo(leader).toFixed(2)} m)`)
  assert(f.at().distanceTo(leader) > 1.5, 'but keeps a step back')
  // Wait here: he stays while the player walks off.
  ;(f.state.run as unknown as { hostages: { waiting: boolean }[] }).hostages[0].waiting = true
  const before = f.at()
  f.step(v(-10, 0.02, 12), 4)
  assert(f.at().distanceTo(before) < 0.05, 'waiting means waiting')
  ;(f.state.run as unknown as { hostages: { waiting: boolean }[] }).hostages[0].waiting = false
  // Round the wall: the player walks round its end to the far side; he walks their footprints, never through it.
  const route = [v(-2, 0.02, 12), v(3, 0.02, 7), v(3, 0.02, -7.5), v(8, 0.02, -7.5), v(8, 0.02, 0)]
  // The player walks it (at walking pace, so their footprints are continuous).
  const walker = v(-10, 0.02, 12)
  for (const point of route) while (walker.distanceTo(point) > 0.05) { walker.add(point.clone().sub(walker).clampLength(0, 4 / 30)); f.step(walker, 1 / 30) }
  f.step(route.at(-1)!, 6)
  assert(f.at().x > 5.2, `he is past the wall (${f.at().toArray().map(n => n.toFixed(1))})`)
  assert(f.at().distanceTo(route.at(-1)!) < 3.5)
})

test('escort: shot at, he takes cover out of the shooter\'s sight; near the landed helicopter he boards by himself', () => {
  const f = escortFixture()
  // The shooter stands east of the wall (x = 5, z from -6 to 6); he stands just past its end, in the open.
  f.state.hostages[0].position = [3, 0.02, 8]
  const threat = v(20, 0, 0), eye = v(20, 1.5, 0)
  const exposed = () => f.world.visible(eye, f.at().setY(0.9), new THREE.Object3D())
  assert(exposed(), 'he starts in the shooter sight line')
  f.escort.threat = threat
  f.step(v(3, 0.02, 8), 4, true)
  assert(!exposed(), `he took cover behind the wall (${f.at().toArray().map(n => n.toFixed(1))})`)
  f.escort.threat = null
  // Boarding: once it has arrived and he is in the landing zone.
  f.state.hostages[0].position = [36, 0.02, 0]
  ;(f.state.run as unknown as { arrived: boolean }).arrived = false
  f.step(v(34, 0.02, 0), 2)
  assert.equal(f.state.hostages[0].status, 'following', 'not before it lands')
  ;(f.state.run as unknown as { arrived: boolean }).arrived = true
  f.step(v(34, 0.02, 0), 4)
  assert.equal(f.state.hostages[0].status, 'loaded', 'aboard')
})

test('the hostage goes down at no health, bleeds out unless revived, and a revive gives half his health back', () => {
  const vitals = { health: 60, max: 60, down: 0 as 0 | 1 | 2, bleed: 0, waiting: false, leader: 0 }
  assert(hurtHostage(vitals, 25)); assert.equal(vitals.health, 35); assert.equal(vitals.down, 0)
  assert(hurtHostage(vitals, 50)); assert.equal(vitals.down, 1); assert.equal(vitals.bleed, HOSTAGE_BLEED_SECONDS)
  assert(!hurtHostage(vitals, 10), 'a downed hostage is not hurt again')
  assert(!bleedHostage(vitals, HOSTAGE_BLEED_SECONDS - 1))
  assert(reviveHostage(vitals)); assert.equal(vitals.health, 30); assert.equal(vitals.down, 0)
  hurtHostage(vitals, 100)
  assert(bleedHostage(vitals, HOSTAGE_BLEED_SECONDS + 1), 'bled out: the mission fails')
  assert.equal(vitals.down, 2)
  assert(!reviveHostage(vitals), 'the dead stay dead')
})

test('a new map plugs in as a module: its anchors drive the same runs, guards and objectives, with no logic changes', () => {
  // A stand-in for the location maps to come (Balluta Bay, Valletta, Mdina, Marsaxlokk): a harbour with a boat out.
  const harbour: MapModule = {
    id: 'test-harbour', name: 'A test harbour', place: 'Nowhere in particular',
    spawns: { quay: { id: 'quay', label: 'The quay', position: [0, 0, 0], lookAt: [0, 1.6, 10] } },
    cells: { store: { id: 'store', label: 'The net store', area: 'the net store', hostage: [10, 0, 10], facing: 0, lock: { position: [10, 0, 10.8], facing: Math.PI }, zone: { x: 10, z: 10, r: 4 }, chair: true },
      tower: { id: 'tower', label: 'The watchtower', area: 'the old tower', hostage: [30, 0, 5], facing: 0, lock: { position: [30, 0, 5.8], facing: Math.PI }, zone: { x: 30, z: 5, r: 4 }, chair: true } },
    extractions: { boat: { id: 'boat', kind: 'boat', label: 'A boat at the slipway', board: [0, 0, 40], seats: [[0, 0.5, 42]], route: [[0, 0, 42], [0, 0, 90]], camera: { target: [0, 1, 42], offset: [8, 5, -6] },
      zone: { x: 0, z: 40, r: 8 }, call: { position: [3, 0, 38], facing: 0 }, eta: 60, park: [0, 0, 42], heading: 0 } },
    cameras: {}, panels: { fuse: { id: 'fuse', kind: 'power', label: 'Cut the power', position: [5, 0, 5], facing: 0 } }, boosts: {},
    zones: { village: { id: 'village', label: 'The village', x: 15, z: 10, r: 20 } },
    guards: { quay: { id: 'quay', name: 'Quay watch', position: [5, 0, 20], patrol: [[5, 0, 20], [15, 0, 20]], weapon: 'ak' },
      extra: { id: 'extra', name: 'Night watch', position: [20, 0, 20], patrol: [[20, 0, 20]], weapon: 'smg', tier: 'hard' } },
    dogs: {}, preview: { buildings: [[10, 10, 6, 4]], bounds: { minX: -10, maxX: 40, minZ: -5, maxZ: 50 } },
  }
  MAPS[harbour.id] = harbour
  const mission: MissionDef = { id: 'harbour-test', number: 99, name: 'Harbour', briefing: '', estimate: '', map: harbour.id, spawns: ['quay'], cells: ['store', 'tower'], hostages: 1, hostageName: 'Test',
    extraction: 'boat', cameras: [], panels: ['fuse'], lockedDoors: [], keycards: [], boosts: [], guards: ['quay', 'extra'], dogs: [], alarmLocks: [],
    stages: [{ id: 'in', title: 'In', objectives: [{ id: 'in', kind: 'reach', zone: 'village', text: 'Reach the village' }] },
      { id: 'free', title: 'Free', objectives: [{ id: 'find', kind: 'find', text: 'Find' }, { id: 'free', kind: 'free', text: 'Free' }] },
      { id: 'out', title: 'Out', objectives: [{ id: 'call', kind: 'call', text: 'Call the boat' }, { id: 'defend', kind: 'defend', text: 'Hold' }, { id: 'escort', kind: 'escort', text: 'Aboard' }] }],
    par: { normal: 600, hard: 700, nightmare: 800 }, tools: { pebbles: 1, charges: 0, drone: false } }
  assert.equal(mapFor(mission), harbour)
  const run = createRun(mission, harbour, 'normal', 9)
  assert(['store', 'tower'].includes(run.cells[0]))
  assert.deepEqual(resolveGuards(mission, harbour, run, []).map(g => g.id), ['quay'])
  assert.deepEqual(resolveGuards(mission, harbour, createRun(mission, harbour, 'hard', 9), []).map(g => g.id), ['quay', 'extra'])
  const cell = harbour.cells[run.cells[0]]
  updateObjectives(mission, harbour, run, { players: [[15, 0, 10]], hostages: [{ freed: false, loaded: false, position: cell.hostage }], complete: false })
  assert.equal(run.stage, 1)
  updateObjectives(mission, harbour, run, { players: [cell.hostage], hostages: [{ freed: true, loaded: false, position: cell.hostage }], complete: false })
  assert.equal(run.stage, 2)
  run.called = true; run.arrived = true
  updateObjectives(mission, harbour, run, { players: [[0, 0, 40]], hostages: [{ freed: true, loaded: false, position: [0, 0, 40] }], complete: false })
  assert.equal(run.stage, 3, 'the boat run completes like the helicopter one')
  delete MAPS[harbour.id]
})

console.log(`${passed} rescue campaign checks passed`)
