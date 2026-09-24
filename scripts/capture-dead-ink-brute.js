// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/capture-dead-ink-brute.js
// Defines window.__bruteStage(name) for the Brute's screenshots: 'front', 'side', 'charge', 'slam', 'burrow'.
// Each stages the moment, then freezes the zombies (their update is stubbed) so the pose holds while
// `npx agent-browser screenshot artifacts/brute-<name>.png` is taken; __bruteStage resolves to a summary
// once frozen. Reload the page afterwards. Staged, not played: the player is invincible and placed.
(() => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 16) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const update = m.director.update.bind(m.director)
  let started = false, brute = null
  const freeze = () => { m.director.update = () => {} }
  const thaw = () => { m.director.update = update }
  const place = (at, look, height = 1.6) => { p.body.teleport(at.clone()); p.actions.syncCamera(cam); cam.lookAt(look.x, look.y + height, look.z); e.invalidate() }
  const allow = (...open) => { const b = brute.brute; for (const k of ['slam', 'charge', 'throw', 'burrow']) b.cool[k] = open.includes(k) ? 0 : 999; b.cool.gap = 0 }
  const straight = (from, yaw, most) => {
    let y = from.y
    for (let d = 0.45; d <= most; d += 0.45) {
      const q = m.director.navigation.floor(new V(from.x + Math.sin(yaw) * d, y, from.z + Math.cos(yaw) * d))
      if (!q) return d - 0.45
      y = q.y
    }
    return most
  }
  const ahead = (from, yaw, d, side = 0) => {
    const q = from.clone().add(new V(Math.sin(yaw) * d + Math.cos(yaw) * side, 0, Math.cos(yaw) * d - Math.sin(yaw) * side))
    return m.director.navigation.floor(q) ?? q
  }
  async function setup() {
    if (started) return
    started = true
    p.fallback = true
    m.invincible = true
    document.querySelector('#walk-start').click()
    await sleep(300)
    for (const gate of m.zones?.gates ?? []) m.zones.open(gate)
    m.rounds.round = 5; m.rounds.phase = 'break'; m.rounds.timer = 9999
    const yard = m.graph.point(m.graph.nearest(new V(-30, 0, -25), 4))
    m.brute = brute = m.director.spawn(yard, 30000, 'run', 0, false, true)
    // The runtime's zombies: nobody else about.
    for (const z of m.director.zombies) if (z !== brute && z.state === 'chase') { z.state = 'idle'; z.actor.root.visible = false }
  }
  /** The longest clear straight line from the Brute, as a yaw. */
  const lane = () => { let yaw = 0, best = 0; for (let a = 0; a < 48; a++) { const r = straight(brute.position, a / 48 * Math.PI * 2, 18); if (r > best) { best = r; yaw = a / 48 * Math.PI * 2 } } return yaw }

  window.__bruteStage = async name => {
    thaw()
    await setup()
    allow()
    brute.brute.move = null; brute.swing = 0; brute.rise = 0
    if (name === 'front' || name === 'side') {
      const yaw = lane()
      brute.yaw = yaw
      // Its stance, with nobody to go for (it neither walks nor swings); then turned a quarter for its side.
      m.director.update = dt => update(dt, [])
      const at = ahead(brute.position, yaw, 3.1)
      place(at, brute.position, 1.15)
      await sleep(900)
      freeze()
      if (name === 'side') { brute.actor.root.rotation.y += Math.PI / 2; brute.actor.root.updateMatrixWorld(true) }
      return { name, yaw: brute.yaw.toFixed(2) }
    }
    if (name === 'charge') {
      const yaw = lane()
      brute.yaw = yaw
      // The player it runs at, 14 m down its line; the camera watching from the side of its run.
      const target = ahead(brute.position, yaw, 14)
      const watch = ahead(brute.position, yaw, 7.5, 3.4)
      place(target, brute.position)
      allow('charge')
      await until(() => brute.brute.move === 'charge', 3000)
      await until(() => brute.brute.run > 4, 3000)
      place(watch, brute.position, 1.3)
      await until(() => brute.brute.run > 5.5, 1000)
      freeze()
      return { name, move: brute.brute.move, run: brute.brute.run.toFixed(1) }
    }
    if (name === 'slam') {
      const yaw = lane()
      brute.yaw = yaw
      place(ahead(brute.position, yaw, 3), brute.position)
      allow('slam')
      await until(() => brute.brute.move === 'slam', 3000)
      await until(() => brute.brute.struck, 2000)
      place(ahead(brute.position, yaw + 0.5, 8.5), brute.position, 0.9)
      await sleep(220)
      freeze()
      return { name, waves: m.director.brutes.waves.count }
    }
    if (name === 'burrow') {
      const yaw = lane()
      place(ahead(brute.position, yaw, 7.5), brute.position, 0.9)
      allow('burrow')
      brute.brute.best = 0; brute.brute.stall = 99; brute.brute.idle = 99
      // Far from anyone it could walk to: stuck, it burrows.
      const far = ahead(brute.position, yaw, 30)
      m.director.update = (dt) => update(dt, [{ id: 'p1', feet: far, alive: true }])
      await until(() => brute.brute.move === 'burrow', 3000)
      await until(() => brute.brute.t > 0.95, 2000)
      freeze()
      return { name, t: brute.brute.t.toFixed(2) }
    }
    throw new Error(`no stage ${name}`)
  }
  return 'ready'
})()
