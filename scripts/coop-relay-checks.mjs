// node scripts/coop-relay-checks.mjs: the co-op relay groups a host and up to three guests and routes between them.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { attachRelay } from '../server/coop-relay.mjs'

const server = createServer()
const wss = attachRelay(server)
await new Promise(r => server.listen(0, r))
const port = server.address().port
const open = path => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const inbox = []
  ws.on('message', data => inbox.push(JSON.parse(data.toString())))
  ws.on('open', () => resolve({ ws, inbox }))
  ws.on('error', reject)
})
const next = async (client, test = () => true, ms = 2000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const i = client.inbox.findIndex(test); if (i >= 0) return client.inbox.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('timed out')
}
const none = async (client, test, ms = 200) => { await new Promise(r => setTimeout(r, ms)); assert.equal(client.inbox.findIndex(test), -1, 'nothing arrived') }

const host = await open('/coop')
const room = await next(host, m => m.t === 'room')
assert.equal(room.you, 'host'); assert.equal(room.id, 0); assert.match(room.code, /^[A-Z2-9]{5}$/)
// Three guests join and are numbered 1, 2, 3; the host hears of each, each hears the host is there.
const guests = []
for (const n of [1, 2, 3]) {
  const guest = await open(`/coop?room=${room.code.toLowerCase()}`)
  const joined = await next(guest, m => m.t === 'room')
  assert.equal(joined.you, 'guest'); assert.equal(joined.id, n)
  assert.deepEqual(await next(host, m => m.t === 'peer'), { t: 'peer', joined: true, id: n })
  assert.equal((await next(guest, m => m.t === 'peer')).id, 0)
  guests.push(guest)
}
// A fifth player is turned away.
const fifth = await open(`/coop?room=${room.code}`)
assert.equal((await next(fifth, m => m.t === 'error')).reason, 'That game is full (four players).')
// The host's broadcast reaches every guest untouched.
host.ws.send(JSON.stringify({ t: 'tick', n: 1 }))
for (const guest of guests) assert.deepEqual(await next(guest, m => m.t === 'tick'), { t: 'tick', n: 1 })
// `to` reaches one guest only; `skip` everyone but one.
host.ws.send(JSON.stringify({ t: 'award', n: 50, to: 2 }))
assert.equal((await next(guests[1], m => m.t === 'award')).n, 50)
await none(guests[0], m => m.t === 'award'); await none(guests[2], m => m.t === 'award')
host.ws.send(JSON.stringify({ t: 'boom', skip: 3 }))
await next(guests[0], m => m.t === 'boom'); await next(guests[1], m => m.t === 'boom')
await none(guests[2], m => m.t === 'boom')
// A guest's message goes to the host alone, saying who sent it.
guests[1].ws.send(JSON.stringify({ t: 'shot', d: [1, 2, 3] }))
const shot = await next(host, m => m.t === 'shot')
assert.deepEqual(shot.d, [1, 2, 3]); assert.equal(shot.from, 2)
await none(guests[0], m => m.t === 'shot')
// A guest leaving frees its number; the next one to join takes it.
guests[1].ws.close()
assert.deepEqual(await next(host, m => m.t === 'peer'), { t: 'peer', joined: false, id: 2 })
const again = await open(`/coop?room=${room.code}`)
assert.equal((await next(again, m => m.t === 'room')).id, 2)
const lost = await open('/coop?room=ZZZZZ')
assert.match((await next(lost, m => m.t === 'error')).reason, /not found/)
// The host leaving ends the game for every guest.
host.ws.close()
for (const guest of [guests[0], guests[2], again]) assert.equal((await next(guest, m => m.t === 'peer' && m.joined === false)).hostLeft, true)
for (const c of [fifth, lost]) c.ws.close()
wss.close(); server.close()
console.log('coop relay checks passed: four players, routed by to/skip, from on guest messages')
