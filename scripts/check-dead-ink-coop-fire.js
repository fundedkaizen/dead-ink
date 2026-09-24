// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-coop-fire.js
// Starts in the page and returns at once; poll window.__fireCheck for { done, results, error? }.
// Co-op gunfire: your shots reach teammates as a fire message; theirs draw tracers and play their report here;
// the host passes a guest's shot on to the others. The co-op link is stood in for, so one tab is enough.
(() => {
window.__fireCheck = { done: false, results: [] }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active, V = cam.position.constructor
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const check = (ok, label, detail = '') => window.__fireCheck.results.push({ passed: !!ok, label, detail })
  p.fallback = true
  document.querySelector('#walk-start').click()
  await sleep(500)
  m.invincible = true; m.rounds.timer = 9999; m.rounds.phase = 'break'
  // Pretend a guest is connected, and record what we would send.
  const sent = []
  const realSend = m.coop.send.bind(m.coop)
  m.coop.peers.add(1)
  const realRole = m.coop.role
  m.coop.role = 'host'
  m.coop.send = (message, route) => sent.push({ message, route })
  m.weapons.restore({ slots: [{ id: 'f-ak', name: 'ak', magazine: 30, reserve: 90, packed: true, packLevel: 1 }, null], selected: 0, pickups: [], nextId: 5 })
  await sleep(600)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  await sleep(200)
  const fire = sent.find(s => s.message.t === 'fire')?.message
  check(fire && fire.w === 'ak' && fire.pk === 1 && fire.o.length === 3 && fire.e.length === 3, 'our shot goes to teammates as a fire message', JSON.stringify(fire))
  // A teammate's shot arriving: its tracer and its report.
  const heard = [], drawn = []
  const play = m.audio.play.bind(m.audio), emit = m.bulletTrails.emit.bind(m.bulletTrails)
  m.audio.play = event => { heard.push(event); return play(event) }
  m.bulletTrails.emit = (...args) => { drawn.push(args); return emit(...args) }
  const o = cam.position.clone().add(new V(3, 0, -2))
  m.coopMessage({ t: 'fire', o: [o.x, o.y, o.z], e: [o.x, o.y, o.z - 30], w: 'shotgun', pk: 0, from: 1 })
  m.coopMessage({ t: 'fire', o: [o.x, o.y, o.z], e: [o.x + 10, o.y, o.z - 30], w: 'raygun', pk: 1, from: 1 })
  check(drawn.length === 2, 'each teammate shot draws its tracer', `${drawn.length}`)
  check(heard.some(h => h.kind === 'shot-shotgun') && heard.some(h => h.kind === 'shot-raygun' && h.packed === 1), 'and is heard, with its own report', heard.map(h => h.kind + ':' + (h.packed ?? '')).join(','))
  check(drawn[1] && drawn[1][5] === 0xd4332a, 'an upgraded teammate gun draws red', String(drawn[1]?.[5]))
  // As host, a guest's shot is passed on to the other guests, not back to the shooter.
  const forwarded = sent.filter(s => s.message.t === 'fire' && s.route?.skip === 1)
  check(forwarded.length === 2, 'the host passes a guest shot to the others, skipping the shooter', JSON.stringify(forwarded.map(f => f.route)))
  m.coop.send = realSend; m.coop.peers.delete(1); m.coop.role = realRole
  m.audio.play = play; m.bulletTrails.emit = emit
})().catch(err => { window.__fireCheck.error = String(err?.stack ?? err) }).finally(() => { window.__fireCheck.done = true })
})()
