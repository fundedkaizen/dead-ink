// A stand-in runtime for the hostage rescue's co-op controller (rescue-coop.ts) in Node: no DOM, no WebGL.
// Used by scripts/rescue-coop-checks.ts and scripts/rescue-coop-link-checks.ts.
import * as THREE from 'three'
import type { EnemyActor } from '../src/game/actors'
import { EnemyDirector } from '../src/game/ai'
import { CollisionWorld } from '../src/player/collision'
import { initialMission } from '../src/game/mission'
import { RescueCoop } from '../src/game/rescue-coop'
import { PartnerAvatar, type PlayerState } from '../src/game/shared/coop'
import type { RescueMessage } from '../src/game/rescue-coop-rules'
import type { AIContext, WeaponSnapshot } from '../src/game/types'

export const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
export type Sent = { m: RescueMessage; route?: { to?: number; skip?: number } }

/** A stand-in stickman that remembers what it was asked to play. */
export type FakeActor = EnemyActor & { calls: { update: unknown[][]; posture: string[]; shots: number; reacts: unknown[][]; restores: unknown[][] } }
export const fakeActor = async () => {
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

/** Guards on open ground, looking along +Z (unless `facing` says otherwise), with stand-in stickmen. */
export async function guards(positions: [number, number, number][], context: Partial<AIContext> = {}, facing = 0) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  const world = new CollisionWorld(scene)
  const ai = new EnemyDirector({ scene, world, doors: [], specs: positions.map((position, i) => ({ id: `g${i}`, name: `Guard ${i}`, position, patrol: [], weapon: 'ak', facing })),
    emit() {}, damagePlayer() {}, dropWeapon() {}, ...context }, fakeActor)
  await ai.init()
  return { ai, world, scene, dispose() { ai.dispose(); world.dispose() } }
}

function fakeElement(): Record<string, unknown> {
  const element: Record<string, unknown> = { children: [], dataset: {}, hidden: false, textContent: '', className: '', innerHTML: '',
    style: { setProperty() {}, removeProperty() {}, transform: '' }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, append(...nodes: unknown[]) { (element.children as unknown[]).push(...nodes) }, remove() {},
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }
  return element
}

/** The browser globals the controller touches. `host` is the page's host (the relay listens there). */
export function installFakeDom(host = 'localhost:5187') {
  Object.assign(globalThis, {
    document: { createElement: () => fakeElement(), querySelector: () => null, body: fakeElement(), hidden: false },
    location: { href: `http://${host}/`, search: '', protocol: 'http:', host },
    localStorage: { getItem: () => null, setItem() {} },
    window: { innerWidth: 1280, innerHeight: 720 },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  })
}

// No stickman model in Node: the teammates' avatars stay empty.
PartnerAvatar.prototype.load = () => Promise.resolve()

/**
 * A player's game: the co-op controller on a stand-in runtime that records what the controller asks of it.
 * With `fakeLink` (the default) the link is paired already and every send is recorded; without it, open the
 * link for real (a relay must be listening at the page's host).
 */
export function stage(role: 'host' | 'guest', id = role === 'host' ? 0 : 1, options: { fakeLink?: boolean; ai?: EnemyDirector; name?: string } = {}) {
  const sent: Sent[] = [], notes: string[] = [], effects: { station: string; by: number }[] = [], hurts: number[] = [], calls: string[] = []
  let weapons: WeaponSnapshot = { slots: [{ id: 'ak-1', name: 'ak', magazine: 30, reserve: 90 }, { id: 'pistol-1', name: 'pistol', magazine: 5, reserve: 12 }, null, null],
    selected: 0, pickups: [{ id: 'maintenance-smg', name: 'smg', magazine: 24, reserve: 48, position: [0, 0, 0] }], nextId: 3 }
  const camera = new THREE.PerspectiveCamera()
  const r = {
    state: initialMission(), ready: true, initialized: Promise.resolve(), interactionTime: 0, hitFlash: 0, failures: 0,
    ai: options.ai ?? { enemies: [] as unknown[], hear() {}, nearMiss() {}, hit: (): boolean => false, aimDistance: () => Infinity, bulletTrails: { emit() {}, update() {} } },
    player: { playing: true, enabled: true, immersive: false, useHeld: false, movementLocked: false, crawling: false,
      body: { position: v(), velocity: v(), teleport(point: THREE.Vector3) { this.position.copy(point) } },
      actions: { doors: [] as THREE.Group[], disabled: false, syncCamera() {} },
      world: { floor: () => 0, fits: () => true, raySurface: () => null, visible: () => true } },
    weapons: { get current() { return weapons.slots[weapons.selected] }, snapshot: () => structuredClone(weapons), restore: (snapshot: WeaponSnapshot) => { weapons = structuredClone(snapshot) },
      addPickup(item: { id: string }) { if (!weapons.pickups.some(each => each.id === item.id)) weapons.pickups.push(structuredClone(item) as never) },
      removePickup(id: string) { weapons.pickups = weapons.pickups.filter(each => each.id !== id); return true } },
    escort: { motion: [], follow() {} }, security: { sync() {} }, blood: { emitHit() { calls.push('blood') } }, impacts: { emit() {} }, bulletTrails: { emit() { calls.push('tracer') } },
    hud: { notify: (text: string) => { notes.push(text) } }, audio: { play() {}, confirmHit() { calls.push('confirm') } }, escape: { active: false },
    world: { spawn: [0, 0, 0], stations: [{ id: 'hostage-1', kind: 'hostage', point: v(110.5, -3, -21) }, { id: 'rescue-jeep', kind: 'jeep', point: v(154.65, 1.05, 9.95) }] },
    emit(event: { kind: string }) { calls.push(`emit:${event.kind}`) }, cancelInput() {}, syncWorld() {}, invalidate() {}, gateOpening: () => false,
    beginEscape() { calls.push('escape'); coop.escaping(); this.escape.active = true },
    retry(local = false) { calls.push(`retry:${local}`) }, restart(local = false) { calls.push(`restart:${local}`) },
    damage(amount: number) { hurts.push(amount) },
    stationEffects: (station: { id: string }, by: number) => { effects.push({ station: station.id, by }) },
    fail() { if (this.state.phase !== 'active') return; this.state.phase = 'dead'; this.failures++; coop.failed() },
  }
  const coop = new RescueCoop(r as never, new THREE.Scene(), camera, fakeElement() as never)
  if (options.name) Object.defineProperty(coop, 'name', { get: () => options.name })
  if (options.fakeLink !== false) {
    Object.assign(coop.link, { role, id })
    coop.link.peers.add(role === 'host' ? 1 : 0)
    coop.link.send = (m: RescueMessage, route?: { to?: number; skip?: number }) => { sent.push({ m, route }) }
  }
  const message = (m: RescueMessage, from?: number) => (coop as unknown as { message: (m: unknown) => void }).message({ ...m, from })
  const me = (over: Partial<PlayerState> = {}): PlayerState => ({ id: 1, p: [1, 0, 0], yaw: 0, pitch: 0, w: 'pistol', mv: 0, dn: 0, pts: 0, kills: 0, name: 'Guest', ...over })
  return { r, coop, sent, notes, effects, hurts, calls, message, me, weapons: () => weapons }
}
