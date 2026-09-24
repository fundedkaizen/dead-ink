// node scripts/check-player.mjs scripts/rescue-coop-checks.ts: the hostage rescue's co-op rules (rescue-coop-rules.ts),
// the guards' choice among several players (ai.ts), the guests' guard puppets (guard-puppets.ts), and the co-op
// controller (rescue-coop.ts) on a stand-in runtime: downs, revives, bleeding out, failure, shots and uses.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnemyDirector } from '../src/game/ai'
import type { EnemyActor } from '../src/game/actors'
import { CollisionWorld } from '../src/player/collision'
import { initialMission } from '../src/game/mission'
import { SecuritySystem } from '../src/game/security'
import { GuardPuppets } from '../src/game/guard-puppets'
import { GUARD_STATES, LastStand, RESCUE_COOP, ReviveHold, applyMirror, canRevive, decodeHurt, doorBits, encodeHurt, escapeReady, escortLeaders,
  everyoneDown, guardRows, mirrorMission, type RescueMessage } from '../src/game/rescue-coop-rules'
import type { PlayerSense, SoundEvent, WeaponSnapshot } from '../src/game/types'
import type { PlayerState } from '../src/game/shared/coop'

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const near = (a: THREE.Vector3, b: THREE.Vector3, tolerance = 0.02) => a.distanceTo(b) <= tolerance

/** A stand-in stickman that remembers what it was asked to play. */
type FakeActor = EnemyActor & { calls: { update: unknown[][]; posture: string[]; shots: number; reacts: unknown[][]; restores: unknown[][] } }
const fakeActor = async () => {
  const root = new THREE.Group()
  const calls = { update: [] as unknown[][], posture: [] as string[], shots: 0, reacts: [] as unknown[][], restores: [] as unknown[][] }
  let posture = 'stand'
  return { root, calls, reactionRemaining: 0, animationTime: 0, deathClip: 'dieBody',
    get posture() { return posture },
    setPosture(next: string) { posture = next; calls.posture.push(next) },
    update(...args: unknown[]) { calls.update.push(args) },
    shoot() { calls.shots++ },
    react(...args: unknown[]) { calls.reacts.push(args); if (args[1]) (this as { deathClip: string }).deathClip = String(args[0]) },
    restore(...args: unknown[]) { calls.restores.push(args) },
    dispose() {}, muzzle: () => root.position.clone().add(v(0, 1.4, 0.3)) } as unknown as FakeActor
}

function arena() {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  return { scene, world: new CollisionWorld(scene) }
}

async function guards(positions: [number, number, number][], facing = 0) {
  const { scene, world } = arena(), events: SoundEvent[] = [], hurt: { amount: number; id: number | undefined }[] = []
  const ai = new EnemyDirector({ scene, world, doors: [], specs: positions.map((position, i) => ({ id: `g${i}`, name: `Guard ${i}`, position, patrol: [], weapon: 'ak', facing })),
    emit: event => events.push(event), damagePlayer: (amount, _source, _hit, id) => hurt.push({ amount, id }), dropWeapon() {} }, fakeActor)
  await ai.init()
  return { ai, world, events, hurt, dispose() { ai.dispose(); world.dispose() } }
}

const player = (id: number, x: number, z: number): PlayerSense => ({ feet: v(x, 0, z), eye: v(x, 1.65, z), velocity: v(), alive: true, radioEnabled: true, id })

// ---------------------------------------------------------------- messages round trip
{
  const f = await guards([[0, 0, 0], [4, 0, 2]])
  const [a, b] = f.ai.enemies
  Object.assign(a, { state: 'combat', canSee: true, lastKnown: v(1, 0, 9), moveSpeed: 1.4 })
  Object.assign(b, { state: 'dead' })
  const state = initialMission()
  state.alarm = 'active'; state.alarmPosition = [10.123, 0, -4.567]; state.gateOpen = true; state.elapsed = 12.3456; state.supplies.push('guardroom-supplies')
  state.hostages[0].status = 'following'; state.hostages[0].by = 2; state.health = 37; state.kills = 4; state.shots = 9
  const doors = [{ userData: { open: true } }, { userData: { open: false } }, { userData: {} }] as unknown as THREE.Object3D[]
  assert.equal(doorBits(doors), '100')
  const players: PlayerState[] = [{ id: 0, p: [1, 0, 2], yaw: 0.5, pitch: -0.1, w: 'ak', mv: 1, dn: 0, pts: 0, kills: 3, name: 'Host', ps: 0 },
    { id: 1, p: [3, 0, 4], yaw: 1, pitch: 0, w: 'pistol', mv: 0, dn: 1, pts: 0, kills: 0, name: 'Guest', rv: 0.5, rt: 2 }]
  const hit = { region: 'arm' as const, side: -1 as const, point: v(1.234, 1.2, 3.456), direction: v(0, 0, -1), weapon: 'smg' as const }
  const messages: RescueMessage[] = [
    { t: 'sync', m: mirrorMission(state), d: doorBits(doors), pickups: [{ id: 'enemy-g1', name: 'ak', magazine: 30, reserve: 30, position: [4, 0, 2] }], begun: 1 },
    { t: 'tick', g: guardRows(f.ai.enemies), m: mirrorMission(state), d: '0101', players, h: [[1, 0, 2.6, 1.57]] },
    { t: 'react', g: 0, c: 'dieHead', l: 1, d: [0, 0, -1], tr: 1, z: 'head', p: [1, 1.6, 2], w: 'ak', b: 'head' },
    { t: 'hit', p: [1, 1.6, 2], z: 'torso', l: 0 }, { t: 'hurt', n: 9, s: [0, 1, 5], h: encodeHurt(hit) },
    { t: 'snd', k: 'callout', p: [1, 2, 3], r: 55, x: 'Contact! Open fire!', v: 'contact', s: 2 }, { t: 'note', x: 'Cell unlocked.', s: 6 },
    { t: 'drop', item: { id: 'enemy-g0', name: 'smg', magazine: 12, reserve: 24, position: [0, 0, 0] } }, { t: 'taken', id: 'enemy-g0' },
    { t: 'heal' }, { t: 'start' }, { t: 'escape' }, { t: 'fail' }, { t: 'reset', kind: 'retry' },
    { t: 'fire', o: [0, 1.5, 0], e: [0, 1.5, 30], w: 'ak', g: 0 }, { t: 'fire', o: [0, 1.5, 0], e: [0, 1.5, 30], w: 'shotgun' },
    { t: 'door', i: 3, o: 1 }, { t: 'revive', target: 2, by: 'Guest' }, { t: 'down', dn: 1 },
    { t: 'me', me: players[1] }, { t: 'shot', o: [0, 1.6, 0], d: [0.1234, 0, 0.9924], range: 170, damage: 34, weapon: 'ak', pellet: 3 },
    { t: 'use', id: 'hostage-1' }, { t: 'noise', k: 'footstep', p: [1, 0, 2], r: 6 }, { t: 'take', id: 'maintenance-smg' }, { t: 'again', kind: 'restart' },
  ]
  for (const message of messages) assert.deepEqual(JSON.parse(JSON.stringify(message)), message, `${message.t} survives the relay unchanged`)
  // The mirror carries the world and leaves each player's own health, shots and kills alone.
  const guest = initialMission()
  guest.health = 88; guest.kills = 1; guest.shots = 2
  applyMirror(guest, JSON.parse(JSON.stringify(mirrorMission(state))))
  assert.equal(guest.health, 88); assert.equal(guest.kills, 1); assert.equal(guest.shots, 2)
  assert.equal(guest.alarm, 'active'); assert.equal(guest.gateOpen, true); assert.deepEqual(guest.supplies, ['guardroom-supplies'])
  assert.equal(guest.hostages[0].status, 'following'); assert.equal(guest.hostages[0].by, 2); assert.equal(guest.elapsed, 12.35)
  assert.deepEqual(guest.alarmPosition, [10.12, 0, -4.57])
  // A guard's round that hit a player comes back as the same hit.
  const back = decodeHurt(JSON.parse(JSON.stringify(encodeHurt(hit))))
  assert.equal(back.region, 'arm'); assert.equal(back.side, -1); assert.equal(back.weapon, 'smg')
  assert(near(back.point, hit.point) && near(back.direction, hit.direction))
  // Guard rows: a live guard in full, a body in brief.
  const [live, body] = guardRows(f.ai.enemies)
  assert.equal(GUARD_STATES[live[1]], 'combat'); assert.equal(live.length, 13); assert.equal(live[8], 1); assert.deepEqual(live.slice(9, 12), [1, 1.65, 9])
  assert.equal(GUARD_STATES[body[1]], 'dead'); assert.equal(body.length, 6)
  f.dispose()
  console.log('PASS Every co-op message survives the relay; the mirror keeps each player\'s own health, shots and kills; guard rows and hits encode')
}

// ---------------------------------------------------------------- the guards choose among players
{
  // One guard at the origin looking along +Z. The host stands behind him, the guest in front.
  const f = await guards([[0, 0, 0]])
  const guard = f.ai.enemies[0]
  const host = player(0, 0, -20), guest = player(1, 0, 15)
  const step = (seconds: number, others: PlayerSense[] = [guest]) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) f.ai.update(1 / 60, host, others) }
  step(0.2)
  assert(guard.canSee, 'the guard sees the guest in front of him')
  assert.equal(guard.target, 1); assert(near(guard.lastKnown!, guest.feet))
  step(2.5)
  assert.equal(guard.state, 'combat')
  assert(guard.shots > 0, 'and shoots at the guest')
  assert(f.hurt.length > 0 && f.hurt.every(hurt => hurt.id === 1), 'every round that lands is sent to the guest, never the host')
  // The host walks out in front, nearer than the guest: the guard turns onto the nearer man.
  host.feet.set(0, 0, 6); host.eye.set(0, 1.65, 6)
  step(0.3)
  assert.equal(guard.target, 0, 'the nearer player in sight becomes the target')
  // Keeping a target: a slightly nearer second player does not make him switch back and forth.
  guest.feet.set(1, 0, 5.5); guest.eye.set(1, 1.65, 5.5)
  step(0.3)
  assert.equal(guard.target, 0, 'a guard keeps his man unless another is clearly closer')
  // A downed or paused player is left alone.
  host.alive = false; guest.alive = false
  step(0.3)
  assert(!guard.canSee, 'nobody to see when everyone in view is down')
  // A guest's round makes him the target of the guard it hit.
  host.alive = true; guest.alive = true; guard.target = 0
  assert(f.ai.hit({ origin: guest.eye.clone(), direction: guard.position.clone().setY(1.2).sub(guest.eye).normalize(), range: 100, damage: 5, weapon: 'pistol' }, 100, guest))
  assert.equal(guard.target, 1, 'a guest who shoots a guard becomes his target')
  // The checkpoint keeps who each guard is after.
  const saved = f.ai.snapshot(); f.ai.restore(saved); assert.deepEqual(f.ai.snapshot(), saved)
  f.dispose()
}
{
  // Alone, nothing changes: the only player is target 0 and gets the damage.
  const f = await guards([[0, 0, 0]])
  const solo: PlayerSense = { feet: v(0, 0, 15), eye: v(0, 1.65, 15), velocity: v(), alive: true, radioEnabled: true }
  for (let i = 0; i < 180; i++) f.ai.update(1 / 60, solo)
  assert.equal(f.ai.enemies[0].target, 0)
  assert(f.hurt.length > 0 && f.hurt.every(hurt => !hurt.id), 'solo damage goes to the player')
  f.dispose()
}
{
  // Guards keep clear of a guest's body as they do of the player's.
  const f = await guards([[0, 0, 0]])
  const guard = f.ai.enemies[0]
  const host = player(0, 50, 50), guest = player(1, 0, 1.2)
  guard.state = 'investigate'; guard.lastKnown = v(0, 0, 6); guard.suspicion = 1
  for (let i = 0; i < 240; i++) f.ai.update(1 / 60, host, [{ ...guest, alive: false }])
  assert(Math.hypot(guard.position.x - guest.feet.x, guard.position.z - guest.feet.z) > 0.5, 'the guard walks round the guest, not through him')
  f.dispose()
}
{
  // The cameras catch a guest as they catch the player, and raise the alarm.
  const { world } = arena()
  const camera = { id: 'jeep-camera', pivot: new THREE.Group(), lamp: new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()) }
  const missionWorld = { rescue: { cameras: [camera] } } as never
  const ai = { respondToAlarm: () => 0, silenceAlarm() {} } as never
  const events: SoundEvent[] = []
  const security = new SecuritySystem(world, missionWorld, ai, event => events.push(event))
  const state = initialMission()
  const hostEye = v(0, 1.65, 0)
  // Straight down the camera's first look, ten metres out.
  const yaw = -0.7, guestEye = v(160.6 + Math.sin(yaw) * 10, 1.65, 4.5 + Math.cos(yaw) * 10)
  for (let i = 0; i < 30; i++) security.update(0.05, state, [hostEye])
  assert.equal(state.alarm, 'inactive', 'no alarm while only the host, far away, is watched for')
  for (let i = 0; i < 30; i++) security.update(0.05, state, [hostEye, guestEye])
  assert.equal(state.alarm, 'active', 'a guest in the camera\'s view raises the alarm')
  assert(state.alarmPosition && Math.abs(state.alarmPosition[0] - guestEye.x) < 0.01, 'the alarm reports where the guest stood')
  world.dispose()
  console.log('PASS Guards see, target and shoot the nearest visible player, keep their man, spare the downed, turn on a shooter; cameras catch guests')
}

// ---------------------------------------------------------------- the guests' guard puppets
{
  const host = await guards([[0, 0, 0], [6, 0, 6]])
  const guest = await guards([[0, 0, 0], [6, 0, 6]])
  const events: SoundEvent[] = []
  const puppets = new GuardPuppets(guest.ai, event => events.push(event))
  const [walker, body] = host.ai.enemies
  Object.assign(walker, { state: 'combat', canSee: true, lastKnown: v(0, 0, 12), moveSpeed: 0 })
  walker.position.set(2, 0, 3); walker.yaw = 1.2
  walker.actor.setPosture?.('crouch')
  Object.assign(body, { state: 'dead' })
  const rows = JSON.parse(JSON.stringify(guardRows(host.ai.enemies)))
  for (let i = 0; i < 60; i++) puppets.update(1 / 60, rows)
  const [puppet, corpse] = guest.ai.enemies
  const actor = puppet.actor as FakeActor
  assert(near(puppet.position, walker.position) && Math.abs(puppet.yaw - walker.yaw) < 0.01, 'the puppet eases to where the host has the guard')
  assert.equal(puppet.state, 'combat'); assert.deepEqual(actor.calls.posture, ['crouch'], 'and takes his stance once')
  const [dt, drawn, moving, aim] = actor.calls.update.at(-1)!
  assert(Number(dt) > 0 && drawn === 'combat' && moving === false && near(aim as THREE.Vector3, v(0, 1.65, 12)), 'aiming where the host\'s guard aims')
  assert.equal(corpse.state, 'dead'); assert.deepEqual((corpse.actor as FakeActor).calls.restores[0], ['dead', 4, 'dieBody'], 'a body the guest never saw fall lies dead')
  // A relocation (a checkpoint) snaps instead of sliding across the map.
  walker.position.set(40, 0, 40)
  puppets.update(1 / 60, guardRows(host.ai.enemies))
  assert(near(puppet.position, walker.position), 'a big jump snaps')
  // Firing and a hit play here as on the host.
  puppets.fired(0)
  assert.equal(actor.calls.shots, 1, 'muzzle flash')
  const reaction = puppets.react(0, 'dieHead', true, v(0, 0, -1), 1, 'head', v(40, 1.6, 40), 'ak', 'head')
  assert(reaction && reaction.lethal && reaction.targetId === 'g0', 'the hit comes back for the blood')
  assert.deepEqual(actor.calls.reacts[0].slice(0, 2), ['dieHead', true], 'the same death clip')
  assert.equal(puppet.state, 'dead'); assert.equal(puppet.health, 0)
  assert(['enemy-hit', 'enemy-pain', 'enemy-down'].every(kind => events.some(event => event.kind === kind)), 'and his cry')
  assert.equal(guest.ai.aimDistance(v(40, 1.2, 30), v(0, 0, 1), 50), 50, 'the dead no longer stop a round here')
  host.dispose(); guest.dispose()
  console.log('PASS Guest puppets follow the host\'s guards: position, heading, stance, aim, bodies, snaps, flashes, hit reactions and deaths')
}

// ---------------------------------------------------------------- the rules
{
  // Everyone down or out: the mission fails; one up is enough to go on.
  assert(everyoneDown([1, 1])); assert(everyoneDown([2, 1, 2])); assert(!everyoneDown([1, 0])); assert(!everyoneDown([]))
  // Revives: you up, them down (not out), within reach.
  const at = v(0, 0, 0)
  assert(canRevive({ dn: 0, feet: at }, { dn: 1, feet: v(1.5, 0, 0) }))
  assert(!canRevive({ dn: 0, feet: at }, { dn: 1, feet: v(RESCUE_COOP.reviveReach + 0.1, 0, 0) }), 'out of reach')
  assert(!canRevive({ dn: 1, feet: at }, { dn: 1, feet: v(1, 0, 0) }), 'not while down yourself')
  assert(!canRevive({ dn: 0, feet: at }, { dn: 2, feet: v(1, 0, 0) }), 'not once they bled out')
  // The last stand: down, bleeding out; revived only before that.
  const stand = new LastStand()
  assert(stand.fall() && !stand.fall(), 'you go down once')
  assert(!stand.step(RESCUE_COOP.bleedSeconds - 1) && stand.down === 1)
  assert(stand.revive() && stand.down === 0 && !stand.revive())
  stand.fall()
  assert(stand.step(RESCUE_COOP.bleedSeconds) && stand.down === 2, 'bled out')
  assert(!stand.revive() && stand.down === 2, 'no revive once bled out')
  // Holding F: the whole revive time, or nothing.
  const hold = new ReviveHold()
  hold.start(1)
  assert.equal(hold.step(1, true), 'holding'); assert(Math.abs(hold.fraction - 1 / RESCUE_COOP.reviveSeconds) < 1e-9)
  assert.equal(hold.step(0.1, false), 'stopped'); assert(!hold.active)
  hold.start(1)
  let result = ''
  for (let i = 0; i < 400 && result !== 'done'; i++) result = hold.step(0.01, true)
  assert.equal(result, 'done'); assert(!hold.active)
  // The hostage follows whoever freed him and the nearest player up, never the downed.
  const players = [{ id: 0, feet: v(0, 0, 0), up: true }, { id: 1, feet: v(9, 0, 0), up: true }, { id: 2, feet: v(2, 0, 0), up: true }]
  assert.deepEqual(escortLeaders([3, 0, 0], 1, players).map(feet => feet.x), [9, 2])
  assert.deepEqual(escortLeaders([3, 0, 0], 1, players.map(p => ({ ...p, up: p.id !== 1 }))).map(feet => feet.x), [2])
  assert.deepEqual(escortLeaders([3, 0, 0], 2, players).map(feet => feet.x), [2], 'the freer who is also the nearest leads alone')
  assert.deepEqual(escortLeaders([3, 0, 0], 0, players.map(p => ({ ...p, up: false }))), [])
  // The jeep: everyone still up at it.
  const jeep = v(154.65, 1.05, 9.95)
  assert(escapeReady([{ feet: v(154, 0, 12), up: true }, { feet: v(150, 0, 8), up: true }], jeep))
  assert(!escapeReady([{ feet: v(154, 0, 12), up: true }, { feet: v(120, 0, 8), up: true }], jeep))
  assert(escapeReady([{ feet: v(154, 0, 12), up: true }, { feet: v(120, 0, 8), up: false }], jeep), 'a player down elsewhere rides along')
  console.log('PASS Rules: failure when everyone is down, revive reach and timing, bleeding out, the hostage\'s leaders, the jeep waits for everyone up')
}

// ---------------------------------------------------------------- the co-op controller on a stand-in runtime
type Sent = { m: RescueMessage; route?: { to?: number; skip?: number } }
function fakeElement(): Record<string, unknown> {
  const element: Record<string, unknown> = { children: [], dataset: {}, hidden: false, textContent: '', className: '', innerHTML: '',
    style: { setProperty() {}, removeProperty() {}, transform: '' }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, append(...nodes: unknown[]) { (element.children as unknown[]).push(...nodes) }, remove() {},
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }
  return element
}
Object.assign(globalThis, {
  document: { createElement: () => fakeElement(), querySelector: () => null, body: fakeElement(), hidden: false },
  location: { href: 'http://localhost:5187/', search: '', protocol: 'http:', host: 'localhost:5187' },
  localStorage: { getItem: () => null, setItem() {} },
  window: { innerWidth: 1280, innerHeight: 720 },
})
const { RescueCoop } = await import('../src/game/rescue-coop')
const { PartnerAvatar } = await import('../src/game/shared/coop')
// No stickman model in Node: the teammates' avatars stay empty.
PartnerAvatar.prototype.load = () => Promise.resolve()

function stage(role: 'host' | 'guest', id = role === 'host' ? 0 : 1) {
  const sent: Sent[] = [], notes: string[] = [], effects: { station: string; by: number }[] = []
  let weapons: WeaponSnapshot = { slots: [{ id: 'ak-1', name: 'ak', magazine: 30, reserve: 90 }, { id: 'pistol-1', name: 'pistol', magazine: 5, reserve: 12 }, null, null],
    selected: 0, pickups: [{ id: 'maintenance-smg', name: 'smg', magazine: 24, reserve: 48, position: [0, 0, 0] }], nextId: 3 }
  const camera = new THREE.PerspectiveCamera()
  const state = initialMission()
  const r = {
    state, ready: true, initialized: Promise.resolve(), interactionTime: 0, hitFlash: 0, failures: 0,
    ai: { enemies: [] as unknown[], hear() {}, nearMiss() {}, hit: (): boolean => false, aimDistance: () => Infinity, bulletTrails: { emit() {}, update() {} } },
    player: { playing: true, enabled: true, immersive: false, useHeld: false, movementLocked: false, crawling: false,
      body: { position: v(), velocity: v(), teleport(point: THREE.Vector3) { this.position.copy(point) } },
      actions: { doors: [] as THREE.Group[], disabled: false, syncCamera() {} },
      world: { floor: () => 0, fits: () => true, raySurface: () => null, visible: () => true } },
    weapons: { get current() { return weapons.slots[weapons.selected] }, snapshot: () => structuredClone(weapons), restore: (snapshot: WeaponSnapshot) => { weapons = structuredClone(snapshot) },
      addPickup() {}, removePickup: () => true },
    escort: { motion: [], follow() {} }, security: { sync() {} }, blood: { emitHit() {} }, impacts: { emit() {} }, bulletTrails: { emit() {} },
    hud: { notify: (text: string) => { notes.push(text) } }, audio: { play() {}, confirmHit() {} }, escape: { active: false },
    world: { spawn: [0, 0, 0], stations: [{ id: 'hostage-1', kind: 'hostage', point: v(110.5, -3, -21) }, { id: 'rescue-jeep', kind: 'jeep', point: v(154.65, 1.05, 9.95) }] },
    emit() {}, cancelInput() {}, beginEscape() {}, syncWorld() {}, invalidate() {}, gateOpening: () => false, retry() {}, restart() {}, damage() {},
    stationEffects: (station: { id: string }, by: number) => { effects.push({ station: station.id, by }) },
    fail() { if (this.state.phase !== 'active') return; this.state.phase = 'dead'; this.failures++; coop.failed() },
  }
  const coop = new RescueCoop(r as never, new THREE.Scene(), camera, fakeElement() as never)
  Object.assign(coop.link, { role, id })
  coop.link.peers.add(role === 'host' ? 1 : 0)
  coop.link.send = (m: RescueMessage, route?: { to?: number; skip?: number }) => { sent.push({ m, route }) }
  const message = (m: RescueMessage, from?: number) => (coop as unknown as { message: (m: unknown) => void }).message({ ...m, from })
  const me = (over: Partial<PlayerState> = {}): PlayerState => ({ id: 1, p: [1, 0, 0], yaw: 0, pitch: 0, w: 'pistol', mv: 0, dn: 0, pts: 0, kills: 0, name: 'Guest', ...over })
  return { r, coop, sent, notes, effects, message, me, weapons: () => weapons }
}
{
  // Host: what the guards see of a guest, and the mission lost when everyone is down.
  const s = stage('host')
  s.message({ t: 'me', me: s.me() }, 1)
  const [sense] = s.coop.senses()
  assert(sense && sense.id === 1 && sense.alive && near(sense.feet, v(1, 0, 0)) && Math.abs(sense.eye.y - 1.65) < 1e-9, 'a guest the guards can see')
  s.message({ t: 'me', me: s.me({ ps: 1 }) }, 1)
  assert(!s.coop.senses()[0].alive, 'a guest in the menu is left alone')
  s.message({ t: 'me', me: s.me({ dn: 1 }) }, 1)
  assert(!s.coop.senses()[0].alive && s.coop.senses()[0].eye.y < 1, 'a downed guest is low and left alone')
  assert(!Array.isArray(s.coop.eyes(v(), true)) || (s.coop.eyes(v(), true) as THREE.Vector3[]).length === 1, 'cameras skip the downed guest')
  // The host goes down too: a last stand with the pistol, then the mission is lost for all.
  assert(s.coop.takeHit(120) && s.r.state.health === 0)
  s.coop.goDown()
  assert.equal(s.coop.stand.down, 1); assert(s.r.player.crawling && s.r.player.actions.disabled)
  assert.deepEqual(s.weapons().slots.map(item => item?.id ?? null), ['pistol-1', null, null, null], 'the last stand has your pistol')
  assert(!s.coop.takeHit(10), 'a downed player takes no more')
  s.coop.idle(1 / 60)
  assert.equal(s.r.failures, 1, 'everyone down: the mission fails')
  assert(s.sent.some(each => each.m.t === 'fail' && !each.route), 'and every guest is told')
  assert(!s.r.player.crawling, 'the fall of the failure takes over from the crawl')
  // The guests hear the tick with everyone in it.
  s.r.state.phase = 'active'
  s.coop.idle(1)
  const tick = s.sent.findLast(each => each.m.t === 'tick')?.m as Extract<RescueMessage, { t: 'tick' }>
  assert(tick && tick.players.length === 2 && tick.players[0].id === 0 && tick.players[1].dn === 1)
  console.log('PASS Host: guests seen by the guards unless downed or paused; the last stand; everyone down fails the mission for all')
}
{
  // Reviving: hold F over a downed teammate for the whole time.
  const s = stage('host')
  s.message({ t: 'me', me: s.me({ dn: 1 }) }, 1)
  s.coop.mates.get(1)!.avatar.feet.set(1, 0, 0)
  const [target] = s.coop.reviveTargets()
  assert(target && target.label === 'Hold to revive Guest', 'a revive prompt over the downed guest')
  target.use!()
  assert(s.coop.hold.active && s.r.player.movementLocked)
  s.r.player.useHeld = true
  for (let i = 0; i < 90; i++) s.coop.frame(1 / 60)
  assert(s.coop.hold.active && !s.sent.some(each => each.m.t === 'revive'), 'not before the time is up')
  s.r.player.useHeld = false
  s.coop.frame(1 / 60)
  assert(!s.coop.hold.active && !s.r.player.movementLocked, 'letting go stops it')
  target.use!(); s.r.player.useHeld = true
  for (let i = 0; i < Math.ceil(RESCUE_COOP.reviveSeconds * 60) + 2; i++) s.coop.frame(1 / 60)
  const revive = s.sent.find(each => each.m.t === 'revive')
  assert(revive && revive.route?.to === 1, 'the host tells the guest they are up')
  assert.equal(s.coop.mates.get(1)!.state!.dn, 0)
  // A guest reviving another guest goes through the host.
  s.message({ t: 'me', me: s.me({ id: 2, dn: 1, name: 'Third' }) }, 2)
  s.message({ t: 'revive', target: 2, by: 'Guest' }, 1)
  assert(s.sent.some(each => each.m.t === 'revive' && each.route?.to === 2), 'passed on to the guest being revived')
  console.log('PASS Revive: the prompt, the full hold, letting go stops it, and the word reaches the revived player (through the host)')
}
{
  // Guest: down, picked up with every gun back; bleeding out; the shot and the use it asks of the host.
  const s = stage('guest')
  s.coop.takeHit(100); s.coop.goDown()
  assert(s.sent.some(each => each.m.t === 'down' && (each.m as { dn: number }).dn === 1))
  s.message({ t: 'revive', by: 'Host' }, undefined)
  assert.equal(s.coop.stand.down, 0); assert.equal(s.r.state.health, RESCUE_COOP.reviveHealth)
  assert.deepEqual(s.weapons().slots.map(item => item?.id ?? null), ['ak-1', 'pistol-1', null, null], 'back up with every gun')
  assert(s.notes.some(note => note === 'Host got you back up.'))
  s.coop.takeHit(100); s.coop.goDown()
  for (let i = 0; i < RESCUE_COOP.bleedSeconds + 1; i++) s.coop.idle(1)
  assert.equal(s.coop.stand.down, 2, 'bled out')
  assert(s.weapons().slots.every(item => !item), 'with nothing in your hands')
  assert(s.sent.some(each => each.m.t === 'down' && (each.m as { dn: number }).dn === 2))
  s.message({ t: 'revive', by: 'Host' }, undefined)
  assert.equal(s.coop.stand.down, 2, 'no revive once bled out')
  // A shot: the host works it out, so the direction goes precise enough for range.
  const g = stage('guest')
  const aimed = v(0.12345678, 0, 0.99235).normalize()
  g.coop.guestShot({ origin: v(0, 1.6, 0), direction: aimed, range: 170, damage: 34, weapon: 'ak' }, null, 170)
  const shot = g.sent.find(each => each.m.t === 'shot')!.m as Extract<RescueMessage, { t: 'shot' }>
  assert(shot && Math.abs(shot.d[0] - aimed.x) <= 5e-5 && shot.weapon === 'ak', 'four decimals on the direction')
  assert(g.sent.some(each => each.m.t === 'fire'), 'and the tracer for the others')
  // A cell lock: asked of the host, never unlocked here.
  assert(g.coop.requestUse({ id: 'hostage-1', kind: 'hostage', point: v(), label: '', object: new THREE.Object3D() }))
  assert(g.sent.some(each => each.m.t === 'use' && (each.m as { id: string }).id === 'hostage-1'))
  assert.equal(g.r.state.hostages[0].status, 'captive')
  console.log('PASS Guest: down and picked up with its guns, bleeding out for good, its shots and uses go to the host')
}
{
  // Host: a guest's round, the hit marker back to them, and the guards' reaction for everyone.
  const s = stage('host')
  s.message({ t: 'me', me: s.me() }, 1)
  s.r.ai.enemies = [{ spec: { id: 'g0' } }]
  let shooter: PlayerSense | null = null
  s.r.ai.hit = ((_shot: unknown, _distance: unknown, from: PlayerSense) => {
    shooter = from
    s.coop.guardHit({ zone: 'head', point: v(1, 1.6, 9), direction: v(0, 0, 1), lethal: true, targetId: 'g0', clip: 'dieHead', travel: 1 })
    return true
  }) as never
  s.message({ t: 'shot', o: [1, 1.6, 0], d: [0, 0, 1], range: 999, damage: 999, weapon: 'ak' }, 1)
  assert.equal((shooter as PlayerSense | null)?.id, 1, 'the guards learn who fired')
  assert(s.sent.some(each => each.m.t === 'hit' && each.route?.to === 1 && (each.m as { l: number }).l === 1), 'the hit marker (and kill) go to the guest')
  assert(s.sent.some(each => each.m.t === 'react' && (each.m as { c: string }).c === 'dieHead'), 'every guest sees the same death')
  assert.equal(s.coop.shooter, 0, 'the host\'s own rounds are the host\'s again')
  // A guest at the cells unlocks the hostage through the host; one far away cannot.
  s.message({ t: 'me', me: s.me({ p: [60, 0, 0] }) }, 1)
  s.message({ t: 'use', id: 'hostage-1' }, 1)
  assert.equal(s.r.state.hostages[0].status, 'captive', 'too far from the lock')
  s.message({ t: 'me', me: s.me({ p: [110.5, -4.2, -20] }) }, 1)
  s.message({ t: 'use', id: 'hostage-1' }, 1)
  assert.equal(s.r.state.hostages[0].status, 'following')
  assert.deepEqual(s.effects, [{ station: 'hostage-1', by: 1 }], 'with the same effects as the host\'s own use, credited to the guest')
  assert(s.sent.some(each => each.m.t === 'note' && each.route?.to === 1), 'and the guest hears how it went')
  // The jeep: waits for everyone up, unless the host says go.
  s.r.player.body.position.set(154, 0, 12)
  assert.equal(s.coop.jeepLabel(), 'Leave now · everyone rides along')
  s.coop.mates.get(1)!.avatar.feet.set(152, 0, 10)
  assert.equal(s.coop.jeepLabel(), 'Board jeep')
  console.log('PASS Host: a guest\'s shot resolved with its marker, reactions for all; panel uses checked and credited; the jeep waits or leaves')
}
