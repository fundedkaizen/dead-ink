import { WebSocketServer } from 'ws'

/**
 * Dead Ink's co-op relay. Browsers never talk to each other directly: each opens a WebSocket to /coop on
 * the same server that serves the game, and the relay passes messages between them. The host's game is
 * the authority (it runs the zombies and the round); the relay only groups people by room code and
 * forwards. Up to four players: the host and three guests, each guest numbered 1 to 3 (the host is 0).
 *
 * Plain JavaScript on purpose: the Vite dev server loads it as a plugin, and the same file can run on
 * its own next to a built copy of the game (`node server/coop-relay.mjs` with PORT set).
 *
 * Protocol (JSON text frames):
 *   connect  /coop                    -> { t: 'room', code, you: 'host', id: 0 }        (a new room)
 *   connect  /coop?room=CODE          -> { t: 'room', code, you: 'guest', id: 1..3 }    (joined), or { t: 'error', reason }
 *   when someone joins or leaves:     the host gets { t: 'peer', joined, id }; a new guest gets
 *                                     { t: 'peer', joined: true, id: 0 } (the host is there); if the host
 *                                     leaves, every guest gets { t: 'peer', joined: false, id: 0, hostLeft: true }
 *   a guest's message goes to the host only, with `from` set to the guest's number
 *   a host's message goes to one guest (`to`), to every guest but one (`skip`), or to every guest
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_MESSAGE = 256 * 1024
const GUESTS = [1, 2, 3]
const rooms = new Map()

function newCode() {
  for (;;) {
    let code = ''
    for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    if (!rooms.has(code)) return code
  }
}

const send = (socket, message) => { if (socket && socket.readyState === 1) socket.send(typeof message === 'string' ? message : JSON.stringify(message)) }

/** Handle WebSocket upgrades on /coop for an existing Node HTTP server. */
export function attachRelay(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE })
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay')
    if (url.pathname !== '/coop') return
    wss.handleUpgrade(request, socket, head, ws => join(ws, url.searchParams.get('room')))
  })
  // Keep connections alive through proxies and tunnels, and drop dead ones.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.alive === false) { ws.terminate(); continue }
      ws.alive = false
      ws.ping()
    }
  }, 15000)
  wss.on('close', () => clearInterval(beat))
  return wss
}

function join(ws, requested) {
  ws.alive = true
  ws.on('pong', () => { ws.alive = true })
  // A bad frame (too large, malformed) must close that one socket, never crash the relay.
  ws.on('error', () => { try { ws.terminate() } catch { /* already gone */ } })
  let room, id
  if (requested) {
    const code = requested.toUpperCase()
    room = rooms.get(code)
    if (!room) { send(ws, { t: 'error', reason: 'That game was not found. Ask for a new link.' }); ws.close(); return }
    id = GUESTS.find(n => !room.guests.has(n))
    if (id === undefined) { send(ws, { t: 'error', reason: 'That game is full (four players).' }); ws.close(); return }
    room.guests.set(id, ws)
    send(ws, { t: 'room', code, you: 'guest', id })
    send(room.host, { t: 'peer', joined: true, id })
    send(ws, { t: 'peer', joined: true, id: 0 })
  } else {
    const code = newCode()
    room = { code, host: ws, guests: new Map() }
    rooms.set(code, room)
    id = 0
    send(ws, { t: 'room', code, you: 'host', id: 0 })
  }
  ws.on('message', (data, binary) => {
    if (binary) return
    const text = data.toString()
    if (id !== 0) {
      // A guest talks to the host only, and the relay says which guest it is.
      let message
      try { message = JSON.parse(text) } catch { return }
      if (!message || typeof message !== 'object') return
      message.from = id
      send(room.host, message)
      return
    }
    // From the host: most messages (the ticks) go to every guest, so only parse the few that are routed.
    let to, skip
    if (text.includes('"to":') || text.includes('"skip":')) {
      try { const message = JSON.parse(text); to = message.to; skip = message.skip } catch { return }
    }
    if (typeof to === 'number') { send(room.guests.get(to), text); return }
    for (const [guest, socket] of room.guests) if (guest !== skip) send(socket, text)
  })
  ws.on('close', () => {
    if (id === 0) {
      for (const guest of room.guests.values()) { send(guest, { t: 'peer', joined: false, id: 0, hostLeft: true }); guest.close() }
      rooms.delete(room.code)
    } else if (room.guests.get(id) === ws) {
      room.guests.delete(id)
      send(room.host, { t: 'peer', joined: false, id })
    }
  })
}

/** Run on its own: serve nothing but the relay (put it behind the same domain as the built game). */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('coop-relay.mjs')) {
  const { createServer } = await import('node:http')
  const port = Number(process.env.PORT ?? 8787)
  const server = createServer((_, response) => { response.writeHead(404); response.end() })
  attachRelay(server)
  // HOST=127.0.0.1 behind a reverse proxy (nginx), so the relay is reached only through it.
  const host = process.env.HOST ?? '0.0.0.0'
  server.listen(port, host, () => console.log(`Dead Ink co-op relay on ${host}:${port}/coop`))
}
