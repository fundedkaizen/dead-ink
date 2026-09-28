import assert from 'node:assert/strict'
import * as THREE from 'three'
import { DOUBLE_PING, PINGS, createPings, pingText, type PingMessage, type Pings, type PingTarget } from '../src/game/shared/pings'

/**
 * Pings (src/game/shared/pings.ts), headless: what a ping sends, a teammate receiving it, a double ping turning
 * into a danger ping on every screen, the host passing a guest's ping on to the other guests, expiry, the cap
 * per player, following a moving target, and hostile messages ignored.
 */
let passed = 0
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`) }

/** A little co-op: players 0 (the host) to n-1, each with their own Pings, linked through the host like the relay. */
function team(n: number, pick?: (id: number) => PingTarget | null, resolve?: (id: string) => THREE.Vector3 | null) {
  let clock = 100
  const players: { pings: Pings; inbox: PingMessage[] }[] = []
  const deliver = (to: number, message: PingMessage) => { players[to].inbox.push(message) }
  for (let id = 0; id < n; id++) {
    const camera = new THREE.PerspectiveCamera()
    const pings = createPings({ camera, parent: null, sound: false, me: () => id, now: () => clock, resolve,
      pick: () => pick ? pick(id) : { kind: 'spot', position: new THREE.Vector3(id, 0, -5) },
      // A guest's go to the host; the host's to every guest.
      send: message => { if (id === 0) for (let g = 1; g < n; g++) deliver(g, message); else deliver(0, { ...message, from: id } as PingMessage) } })
    players.push({ pings, inbox: [] })
  }
  /** Deliver everything waiting; the host passes a guest's ping on to the others, as the Dead Ink runtime does. */
  const flush = () => {
    for (let round = 0; round < 3; round++) players.forEach((player, id) => {
      const inbox = player.inbox.splice(0)
      for (const raw of inbox) {
        const { from, ...message } = raw as PingMessage & { from?: number }
        if (id === 0 && from !== undefined) { message.by = from; for (let g = 1; g < n; g++) if (g !== from) deliver(g, message) }
        player.pings.receive(message)
      }
    })
  }
  return { players, flush, tick: (seconds: number) => { clock += seconds; for (const p of players) p.pings.update(seconds) } }
}

test('A ping says who, what and where, and a teammate draws it', () => {
  const t = team(2, () => ({ kind: 'item', label: 'Mystery Box', position: new THREE.Vector3(3, 1, -8) }))
  const message = t.players[0].pings.ping()!
  assert.deepEqual({ t: message.t, by: message.by, n: message.n, k: message.k, p: message.p, l: message.l }, { t: 'ping', by: 0, n: 1, k: 'item', p: [3, 1, -8], l: 'Mystery Box' })
  t.flush()
  const seen = t.players[1].pings.active
  assert.equal(seen.length, 1)
  assert.equal(seen[0].by, 0)
  assert.equal(seen[0].label, 'Mystery Box')
  assert.equal(seen[0].kind, 'item')
  assert(seen[0].position.equals(new THREE.Vector3(3, 1, -8)))
  assert.equal(t.players[0].pings.active.length, 1, 'your own ping shows for you too')
})

test('A guest\'s ping reaches the host and, through the host, every other guest, marked as the guest\'s', () => {
  const t = team(4)
  t.players[2].pings.ping()
  t.flush()
  for (const id of [0, 1, 3]) {
    const seen = t.players[id].pings.active
    assert.equal(seen.length, 1, `player ${id} sees it`)
    assert.equal(seen[0].by, 2, `player ${id} sees it as player 2's`)
  }
  assert.equal(t.players[2].pings.active.length, 1, 'the guest does not get its own ping back twice')
})

test('Ping twice quickly and it becomes a double ping, on every screen; slower, it is a second ping', () => {
  const t = team(3)
  t.players[1].pings.ping(); t.tick(0.2); t.players[1].pings.ping()
  t.flush()
  for (const p of t.players) {
    assert.equal(p.pings.active.length, 1, 'still one ping')
    assert.equal(p.pings.active[0].danger, true, 'now a double ping')
    assert.equal(pingText(p.pings.active[0]), 'Go here', 'on the ground it says where to go, not danger')
    assert.equal(p.pings.active[0].life, PINGS.dangerLife)
  }
  t.tick(PINGS.doubleTap + 0.3)
  t.players[1].pings.ping()
  t.flush()
  assert.equal(t.players[0].pings.active.length, 2, 'a slower second press is a second ping')
  assert.equal(t.players[0].pings.active[1].danger, false)
})

test('A double ping fits its target: red danger only on an enemy; on an item what to do with it; on the ground, go here', () => {
  const at = new THREE.Vector3(0, 1, -6)
  const cases: [PingTarget, string, 'danger' | 'use' | 'go'][] = [
    [{ kind: 'enemy', label: 'The Brute', position: at }, 'Danger: The Brute', 'danger'],
    [{ kind: 'item', label: 'Mystery Box', urge: 'Hit the box', position: at }, 'Hit the box', 'use'],
    [{ kind: 'item', label: 'Quick Dip', urge: 'Drink this', position: at }, 'Drink this', 'use'],
    [{ kind: 'item', label: 'Hostage', position: at }, 'Get this: Hostage', 'use'],
    [{ kind: 'spot', position: at }, 'Go here', 'go'],
  ]
  for (const [target, text, look] of cases) {
    let clock = 0
    const shared: PingMessage[] = []
    const host = createPings({ camera: new THREE.PerspectiveCamera(), parent: null, sound: false, me: () => 0, now: () => clock, pick: () => target, send: m => shared.push(m) })
    const guest = createPings({ camera: new THREE.PerspectiveCamera(), parent: null, sound: false, me: () => 1, now: () => clock })
    host.ping(); clock += 0.2; host.ping()
    for (const m of shared) guest.receive(m)
    for (const pings of [host, guest]) {
      const ping = pings.active[0]
      assert.equal(pingText(ping), text, `${target.label ?? target.kind} reads "${text}" on both screens`)
      assert.equal(DOUBLE_PING[ping.kind].look, look)
    }
    assert.equal(pingText(guest.active[0]).includes('Danger'), target.kind === 'enemy', 'danger only for an enemy')
    assert(pingText(guest.active[0]).length <= 24, 'short')
  }
  // A single ping just names it.
  assert.equal(pingText({ kind: 'item', label: 'Mystery Box', urge: 'Hit the box', danger: false }), 'Mystery Box')
})

test('Pings last about five seconds (danger a little longer), then go', () => {
  const t = team(2)
  t.players[0].pings.ping(); t.flush()
  t.tick(PINGS.life - 0.1)
  assert.equal(t.players[1].pings.active.length, 1)
  t.tick(0.2)
  assert.equal(t.players[1].pings.active.length, 0)
  assert(PINGS.life >= 4.5 && PINGS.life <= 5.5)
})

test('A player has at most three pings up: the oldest makes way', () => {
  const t = team(2)
  for (let i = 0; i < 5; i++) { t.players[0].pings.ping(); t.tick(1) }
  t.flush()
  assert.equal(t.players[0].pings.active.length, PINGS.perPlayer)
  assert.equal(t.players[1].pings.active.length, PINGS.perPlayer)
  assert.deepEqual(t.players[1].pings.active.map(p => p.n), [3, 4, 5])
})

test('An enemy ping follows the enemy, and stays where it was last seen once it is gone', () => {
  const zombie = new THREE.Vector3(0, 1.9, -10)
  let alive = true
  const t = team(2, () => ({ kind: 'enemy', id: 'zombie-7', label: 'Zombie', position: zombie.clone() }), id => id === 'zombie-7' && alive ? zombie.clone() : null)
  t.players[0].pings.ping(); t.flush()
  zombie.set(4, 1.9, -6)
  t.tick(0.1)
  assert(t.players[1].pings.active[0].position.equals(zombie), 'the marker moved with it')
  alive = false
  t.tick(0.1)
  zombie.set(50, 0, 50)
  t.tick(0.1)
  assert(t.players[1].pings.active[0].position.equals(new THREE.Vector3(4, 1.9, -6)), 'it stays where the zombie was')
})

test('Nothing to ping sends nothing; malformed or own messages are ignored', () => {
  const t = team(2, () => null)
  assert.equal(t.players[0].pings.ping(), null)
  t.flush()
  assert.equal(t.players[1].pings.active.length, 0)
  const pings = t.players[1].pings
  for (const bad of [null, {}, { t: 'ping', by: 0, n: 1, k: 'spot', p: [1, 2] }, { t: 'ping', by: 0, n: 1, k: 'spot', p: [1, NaN, 2] }, { t: 'ping', by: 1, n: 1, k: 'spot', p: [1, 2, 3] }])
    pings.receive(bad as unknown as PingMessage)
  assert.equal(pings.active.length, 0)
  pings.receive({ t: 'ping', by: 0, n: 9, k: 'weird' as 'spot', p: [1, 2, 3], l: 'x'.repeat(200) })
  assert.equal(pings.active[0].kind, 'spot', 'an unknown kind is a spot')
  assert.equal(pings.active[0].label.length, 32, 'labels are cut short')
})

test('Clearing takes every ping down (a new game)', () => {
  const t = team(2)
  t.players[0].pings.ping(); t.flush()
  t.players[1].pings.clear()
  assert.equal(t.players[1].pings.active.length, 0)
})

console.log(`ping sync checks passed (${passed})`)
