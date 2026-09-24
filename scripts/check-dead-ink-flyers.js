// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-flyers.js
// Starts in the page and returns at once; poll window.__flyersCheck for { done, results, error? }.
// The Ink Storm's Inkwings (flyers.ts) in the real game: round 6 has none, round 7 is a storm and they come out of it
// on streaks of ink, circle, dive and hurt you, are shot down for points (a guest's shot too, worked out here on the
// host), and the round ends with a Max Ammo where the last one fell. Invincibility is not used: health is topped up.
(() => {
const results = []
const status = window.__flyersCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const d = m.director, flyers = d.flyers
  const inkwings = () => d.zombies.filter(z => flyers.owns(z) && z.state === 'chase')
  p.fallback = true
  document.querySelector('#walk-start').click()
  await sleep(300)
  // Hurt as it comes, never down: health topped back up after each hit.
  const hurt = []
  const damage = m.damage.bind(m)
  m.damage = (amount, cause, source) => { const before = m.state.health; damage(amount, cause, source); hurt.push({ amount, cause, took: before - m.state.health }); m.state.health = Math.max(m.state.health, 250) }
  const heard = []
  const play = m.audio.play.bind(m.audio)
  m.audio.play = event => { heard.push(event.kind); return play(event) }
  // The mess yard, open ground.
  p.body.teleport(new V(-30, 0, -25)); p.actions.syncCamera(cam); e.invalidate()

  // Round 6: an ordinary round, no Inkwings.
  m.rounds.round = 5; m.rounds.phase = 'break'; m.rounds.timer = 0.01
  check(await until(() => m.rounds.round === 6, 2000), 'round 6 starts')
  await until(() => d.aliveCount >= 3, 8000)
  check(!m.storm && inkwings().length === 0 && d.aliveCount >= 3, 'round 6 is an ordinary round: zombies, no Inkwings', `${d.aliveCount} alive`)
  d.killAll(); m.rounds.toSpawn = 0
  check(await until(() => m.rounds.phase === 'break', 4000), 'round 6 ends')

  // Round 7: the Ink Storm, and out of it the Inkwings.
  m.rounds.timer = 0.01
  check(await until(() => m.rounds.round === 7, 2000), 'round 7 starts')
  check(m.storm && document.body.dataset.deadInkStorm === 'true', 'it is an Ink Storm, the light gone')
  check(await until(() => inkwings().length >= 2, 8000), 'Inkwings come out of the storm', `${inkwings().length}`)
  check(heard.includes('inkwing-arrive'), 'each on a streak of ink, heard landing')
  check(await until(() => inkwings().some(z => flyers.get(z).mode === 'fly'), 3000), 'they form and fly')
  const draw = e.stats().drawCalls
  check(flyers.drawCalls <= 6, `the whole flock is ${flyers.drawCalls} draw calls`, `scene ${draw}`)

  // They circle, tell, dive and hurt a player standing in the open.
  check(await until(() => heard.includes('inkwing-tell'), 15000), 'one screeches its tell')
  check(await until(() => hurt.some(h => h.cause === 'zombie' && h.amount === 40), 15000), 'and its dive hurts', hurt.filter(h => h.amount > 0).map(h => h.amount).join(','))
  check(heard.includes('inkwing-dive') && heard.includes('inkwing-hit'), 'the dive and the bite are heard')

  // Shot down: points like a zombie kill, and it bursts.
  const target = inkwings().find(z => flyers.get(z).arrived)
  check(target, 'one to shoot')
  const pointsBefore = m.state.points, killsBefore = m.state.kills
  target.health = 1
  const eye = cam.position.clone()
  m.shot({ origin: eye, direction: target.position.clone().sub(eye).normalize(), range: 200, damage: 34, weapon: 'ak' })
  check(target.state === 'dead' && m.state.kills === killsBefore + 1, 'a shot brings it down')
  check(m.state.points - pointsBefore >= 60, 'for a kill\'s points', `${m.state.points - pointsBefore}`)
  check(await until(() => heard.includes('inkwing-death'), 1000), 'it bursts into ink')

  // A co-op guest's shot, worked out here on the host: the kill, the hit marker and the points go to the guest.
  const sent = []
  const realSend = m.coop.send.bind(m.coop), realRole = m.coop.role
  m.coop.peers.add(1); m.coop.role = 'host'
  m.coop.send = (message, route) => sent.push({ message, route })
  check(await until(() => inkwings().some(z => flyers.get(z).arrived), 8000), 'another to shoot')
  const other = inkwings().find(z => flyers.get(z).arrived)
  other.health = 1
  const from = cam.position.clone().add(new V(1, 0, 1)), dir = other.position.clone().sub(from).normalize()
  m.coopMessage({ t: 'shot', o: [from.x, from.y, from.z], d: [dir.x, dir.y, dir.z], range: 200, damage: 34, weapon: 'ak', scale: 3.5, pierce: 4, from: 1 })
  check(other.state === 'dead', 'a guest\'s shot kills it on the host')
  check(sent.some(s => s.message.t === 'hit' && s.message.lethal && s.route?.to === 1), 'the guest gets its hit marker')
  check(sent.some(s => s.message.t === 'award' && s.message.n >= 60 && s.message.k === 1 && s.route?.to === 1), 'and the kill\'s points')
  const rows = d.snapshot().filter(row => row[9] & (1 << 19))
  check(rows.length > 0 && rows.every(row => (row[9] & ~(0x1f << 19)) === 0), 'Inkwing rows use snapshot flag bits 19 to 23 only')
  m.coop.send = realSend; m.coop.role = realRole; m.coop.peers.delete(1)

  // Clear the storm: the last one leaves a Max Ammo where it fell, and the light comes back.
  let lastKill = null
  for (let i = 0; i < 400 && (m.rounds.toSpawn > 0 || d.aliveCount > 0); i++) {
    for (const z of d.zombies.filter(z => z.state === 'chase' && (!flyers.owns(z) || flyers.get(z).arrived))) {
      z.health = 1
      // A zombie's body is where its hit volumes are (a swipe lunges it off its feet).
      const aim = flyers.owns(z) ? z.position.clone() : z.actor.hitVolumes.volumes().find(v => v.zone === 'torso').a.clone()
      const origin = aim.clone().add(new V(0, 0.1, 2.5))
      m.shot({ origin, direction: aim.clone().sub(origin).normalize(), range: 20, damage: 34, weapon: 'ak' })
      if (m.lastKillAt) lastKill = m.lastKillAt.clone()
    }
    await sleep(100)
  }
  check(await until(() => m.rounds.phase === 'break', 5000), 'the storm round ends')
  const maxAmmo = () => m.powerups.active.find(drop => drop.kind === 'maxAmmo' && lastKill && Math.hypot(drop.position.x - lastKill.x, drop.position.z - lastKill.z) < 0.3)
  check(await until(() => maxAmmo() || m.grenadeCount === 4, 2000), 'with a Max Ammo where the last one fell', `${m.powerups.active.map(d => d.kind).join(',')}`)
  const drop = maxAmmo()
  if (drop) {
    const ground = p.world.floor(drop.position.clone().setY(drop.position.y + 0.5), 0.1, 3)
    check(Math.abs(drop.position.y - ground) < 0.05, 'on the ground', `${drop.position.y.toFixed(2)} over ${ground.toFixed(2)}`)
  }
  check(!m.storm && document.body.dataset.deadInkStorm === undefined, 'and the light comes back')
  m.damage = damage; m.audio.play = play
  return { hurt: hurt.filter(h => h.amount > 0).length, heard: [...new Set(heard.filter(k => k.startsWith('inkwing')))].join(' ') }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
