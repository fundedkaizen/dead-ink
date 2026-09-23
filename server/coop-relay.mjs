import { WebSocketServer } from 'ws'

/**
 * Dead Ink's co-op relay. Two browsers never talk to each other directly: each opens a WebSocket to
 * /coop on the same server that serves the game, and the relay passes every message from one to the
 * other. The host's game is the authority (it runs the zombies and the round); the relay only pairs
 * people up by room code and forwards.
 *
 * Plain JavaScript on purpose: the Vite dev server loads it as a plugin, and the same file can run on
 * its own next to a built copy of the game (`node server/coop-relay.mjs` with PORT set).
 *
 * Protocol (JSON text frames):
 *   connect  /coop                    -> { t: 'room', code, you: 'host' }       (a new room)
 *   connect  /coop?room=CODE          -> { t: 'room', code, you: 'guest' }      (joined), or { t: 'error', reason }
 *   either side, when the other joins or leaves: { t: 'peer', joined: true | false }
 *   anything else is forwarded to the other side untouched.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_MESSAGE = 256 * 1024
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
  let room, role
  if (requested) {
    const code = requested.toUpperCase()
    room = rooms.get(code)
    if (!room) { send(ws, { t: 'error', reason: 'That game was not found. Ask for a new link.' }); ws.close(); return }
    if (room.guest) { send(ws, { t: 'error', reason: 'That game is full.' }); ws.close(); return }
    room.guest = ws; role = 'guest'
    send(ws, { t: 'room', code, you: 'guest' })
    send(room.host, { t: 'peer', joined: true })
    send(ws, { t: 'peer', joined: true })
  } else {
    const code = newCode()
    room = { code, host: ws, guest: null }
    rooms.set(code, room)
    role = 'host'
    send(ws, { t: 'room', code, you: 'host' })
  }
  ws.on('message', (data, binary) => {
    if (binary) return
    const other = role === 'host' ? room.guest : room.host
    send(other, data.toString())
  })
  ws.on('close', () => {
    if (role === 'host') {
      send(room.guest, { t: 'peer', joined: false, hostLeft: true })
      room.guest?.close()
      rooms.delete(room.code)
    } else if (room.guest === ws) {
      room.guest = null
      send(room.host, { t: 'peer', joined: false })
    }
  })
}

/** Run on its own: serve nothing but the relay (put it behind the same domain as the built game). */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('coop-relay.mjs')) {
  const { createServer } = await import('node:http')
  const port = Number(process.env.PORT ?? 8787)
  const server = createServer((_, response) => { response.writeHead(404); response.end() })
  attachRelay(server)
  server.listen(port, () => console.log(`Dead Ink co-op relay on :${port}/coop`))
}
