// node scripts/check-player.mjs scripts/rescue-coop-link-checks.ts: two players on the hostage rescue, host and
// guest, through the real relay (server/coop-relay.mjs) over real WebSockets. Each side is the co-op controller
// on a stand-in runtime (rescue-coop-stage.ts) with real guards, so the whole exchange runs as in two browsers,
// without drawing anything: pairing, the start, the guards turning on the guest and his shot, down, revive,
// failure, the escape and starting over.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
// @ts-expect-error plain JavaScript module, shared with the dev server
import { attachRelay } from '../server/coop-relay.mjs'
import { RESCUE_COOP } from '../src/game/rescue-coop-rules'
import type { PlayerSense } from '../src/game/types'
import { guards, installFakeDom, stage, v } from './rescue-coop-stage'

const server = createServer()
const relay = attachRelay(server)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
installFakeDom(`127.0.0.1:${port}`)
Object.assign(globalThis, { WebSocket })
const until = async (test: () => unknown, label: string, ms = 4000) => {
  const start = Date.now()
  while (!test()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Each browser has its own copy of the same guards: two, on open ground, looking along +Z.
const spots: [number, number, number][] = [[0, 0, 0], [30, 0, 0]]
let host: ReturnType<typeof stage>, guest: ReturnType<typeof stage>
const hostGuards = await guards(spots, {
  damagePlayer: (amount, source, hit, id) => { if (id) host.coop.hurt(id, amount, source, hit); else host.r.damage(amount) },
  onHit: hit => host.coop.guardHit(hit),
  onFire: (guard, muzzle, end, weapon) => host.coop.guardFired(guard, muzzle, end, weapon),
})
const guestGuards = await guards(spots)
host = stage('host', 0, { fakeLink: false, ai: hostGuards.ai, name: 'Hosty' })
guest = stage('guest', 1, { fakeLink: false, ai: guestGuards.ai, name: 'Guesty' })
const hostSense: PlayerSense = { feet: host.r.player.body.position, eye: v(), velocity: v(), alive: true, radioEnabled: true }
/** A frame of the host's game: its guards (with every guest), then the co-op. */
const hostFrame = (dt = 1 / 60) => {
  hostSense.eye.copy(hostSense.feet).setY(hostSense.feet.y + 1.65)
  hostGuards.ai.update(dt, hostSense, host.coop.senses())
  host.coop.idle(dt)
}
/** A frame of the guest's game: the host's world as its puppets, then the co-op. */
const guestFrame = (dt = 1 / 60) => { guest.coop.guestStep(dt); guest.coop.idle(dt) }
const frames = async (seconds: number) => {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) {
    hostFrame(); guestFrame()
    if (i % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  await new Promise(resolve => setTimeout(resolve, 30))
}

// ---- Pairing: the host opens a room, the guest joins with its code.
host.coop.link.open()
await until(() => host.coop.status.kind === 'waiting', 'the room')
const link = host.coop.link.link
assert(link.includes(`join=${host.coop.link.code}`) && !link.includes('mode='), `the invite opens the rescue: ${link}`)
// A guest opening the invite is on the menu (the Co-op page) until Jump in.
guest.r.player.playing = false
guest.coop.link.open(new URL(link).searchParams.get('join')!)
await until(() => host.coop.paired && guest.coop.paired, 'pairing')
assert(guest.coop.isGuest && guest.coop.link.id === 1 && host.coop.hosting)
await until(() => guest.r.player.body.position.lengthSq() > 0, 'the guest placed beside the host')
guest.r.player.playing = true
console.log('PASS Pairing through the relay: the invite opens the rescue, the guest is number 1 and starts beside the host')

// ---- The host starts; both are in the mission and see each other.
host.coop.playing(true)
await until(() => guest.notes.includes('Hosty started the mission.'), 'the start')
guest.r.player.body.position.set(0, 0, 14)
host.r.player.body.position.set(0, 0, -30)
await frames(0.3)
await until(() => host.coop.senses().length === 1 && guest.coop.mates.get(0)?.state, 'each seeing the other')
assert.equal(guest.coop.mates.get(0)!.state!.name, 'Hosty'); assert.equal(host.coop.mates.get(1)!.state!.name, 'Guesty')
console.log('PASS Both players are in the mission: the start reaches the guest, each has the other\'s state and name')

// ---- A guard turns on the guest (in front of him), not the host (behind), and fires at him.
await frames(2.5)
const guard = hostGuards.ai.enemies[0]
assert.equal(guard.target, 1, 'the guard is after the guest'); assert.equal(guard.state, 'combat')
assert(guard.shots > 0, 'and fires')
await until(() => guest.hurts.length > 0, 'a round reaching the guest')
assert.equal(host.hurts.length, 0, 'the host, out of sight, is never hit')
const puppet = guestGuards.ai.enemies[0]
assert.equal(puppet.state, 'combat', 'the guest\'s puppet is in combat too')
assert(puppet.canSee, 'and aims')
assert(guest.calls.some(call => call === 'emit:enemy-shot-ak'), 'the guest hears the guard\'s gunfire')
assert(puppet.position.distanceTo(guard.position) < 0.3, 'the puppet stands where the host has the guard')
console.log('PASS A guard sees, targets and shoots the guest; the guest sees his puppet aim and fire, hears it, and takes the hits')

// ---- The guest's round kills that guard: the host works it out, the hit marker and kill go to the guest.
// (The stand-in guards have no head: every round is a body hit, so it takes two.)
const eye = v(0, 1.6, 14)
const markers = () => guest.calls.filter(call => call === 'confirm').length
for (let round = 0; round < 3 && guest.r.state.kills === 0; round++) {
  const chest = guard.position.clone().setY(guard.position.y + 1.2), before = markers()
  guest.coop.guestShot({ origin: eye, direction: chest.sub(eye).normalize(), range: 220, damage: 65, weapon: 'sniper' }, null, 220)
  await until(() => markers() > before, 'the hit marker for each round')
}
await until(() => guest.r.state.kills === 1, 'the kill reaching the guest')
assert.equal(guard.state, 'dead', 'dead on the host')
assert(guest.r.hitFlash > 0 && markers() === 2, 'the guest\'s hit markers, one a round')
assert.equal(host.r.state.kills, 0, 'the kill is not the host\'s')
await until(() => guestGuards.ai.enemies[0].state === 'dead', 'the death on the guest')
assert(guest.calls.includes('blood'), 'blood on the guest\'s screen too')
console.log('PASS The guest\'s shot kills the guard on the host; the hit marker and the kill go to the guest, and it falls on both screens')

// ---- Down and revive: the guest goes down; the host holds F over him.
guest.coop.takeHit(200); guest.coop.goDown()
await until(() => host.coop.mates.get(1)?.state?.dn === 1, 'the host seeing the guest down')
host.coop.mates.get(1)!.avatar.feet.set(0, 0, 14)
host.r.player.body.position.set(0.8, 0, 14)
const [prompt] = host.coop.reviveTargets()
assert(prompt?.label === 'Hold to revive Guesty')
prompt.use!()
host.r.player.useHeld = true
for (let i = 0; i < Math.ceil(RESCUE_COOP.reviveSeconds * 60) + 4; i++) { host.coop.frame(1 / 60); hostFrame(); guestFrame() }
await until(() => guest.coop.stand.down === 0, 'the guest back up')
assert.equal(guest.r.state.health, RESCUE_COOP.reviveHealth)
assert(guest.notes.includes('Hosty got you back up.'))
console.log('PASS Down and revive over the link: the host sees the guest down, holds F the full time, and the guest gets up')

// ---- Everyone down: the mission fails for both.
guest.coop.takeHit(200); guest.coop.goDown()
host.coop.takeHit(200); host.coop.goDown()
await until(() => host.coop.mates.get(1)?.state?.dn === 1, 'the host seeing the guest down again')
await frames(0.1)
await until(() => guest.r.failures === 1, 'the failure reaching the guest')
assert.equal(host.r.failures, 1); assert.equal(host.r.state.phase, 'dead'); assert.equal(guest.r.state.phase, 'dead')
console.log('PASS Everyone down: the mission fails on both screens')

// ---- Starting over: the host restarts, the guest follows.
host.r.state.phase = 'active'; host.coop.clear(); host.coop.resetAll('restart')
await until(() => guest.calls.includes('restart:true'), 'the guest starting over')
guest.r.state.phase = 'active'
console.log('PASS Starting over: the host\'s restart takes the guest back too')

// ---- The escape: the host says go, and the guest rides along.
host.r.beginEscape()
await until(() => guest.calls.includes('escape'), 'the escape reaching the guest')
console.log('PASS The escape: the jeep leaves for the guest too')

// ---- The guest leaves: the host is alone again, and drops the guest's stickman.
guest.coop.link.close()
await until(() => !host.coop.paired && !host.coop.mates.has(1), 'the host alone again')
console.log('PASS A guest leaving: the host plays on alone')

host.coop.dispose(); guest.coop.dispose(); hostGuards.dispose(); guestGuards.dispose()
relay.close(); server.close()
