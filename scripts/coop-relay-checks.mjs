// node scripts/coop-relay-checks.mjs: the co-op relay pairs a host and a guest and forwards between them.
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
const host = await open('/coop')
const room = await next(host, m => m.t === 'room')
assert.equal(room.you, 'host'); assert.match(room.code, /^[A-Z2-9]{5}$/)
const guest = await open(`/coop?room=${room.code.toLowerCase()}`)
assert.equal((await next(guest, m => m.t === 'room')).you, 'guest')
assert.equal((await next(host, m => m.t === 'peer')).joined, true)
host.ws.send(JSON.stringify({ t: 'hello', n: 1 }))
assert.deepEqual(await next(guest, m => m.t === 'hello'), { t: 'hello', n: 1 })
guest.ws.send(JSON.stringify({ t: 'shot', d: [1, 2, 3] }))
assert.deepEqual((await next(host, m => m.t === 'shot')).d, [1, 2, 3])
const third = await open(`/coop?room=${room.code}`)
assert.equal((await next(third, m => m.t === 'error')).reason, 'That game is full.')
const lost = await open('/coop?room=ZZZZZ')
assert.match((await next(lost, m => m.t === 'error')).reason, /not found/)
guest.ws.close()
assert.equal((await next(host, m => m.t === 'peer')).joined, false)
for (const c of [host, third, lost]) c.ws.close()
wss.close(); server.close()
console.log('coop relay checks passed')
