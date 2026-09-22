// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink.js
// It takes about a minute of real play, longer than one eval may block, so it starts in the page and
// returns at once. Poll until done:
//   npx agent-browser eval "JSON.stringify(window.__deadInkCheck)"
// window.__deadInkCheck is { done, results, error?, stats, points, kills, headshots, offer }.
// Plays Dead Ink through real systems: a bot aims the real camera at zombie heads and pulls the real
// trigger; the wall gun and the Mystery Box are used with a real F key press, with the player standing
// in front of them. Staged: the player is invincible (so the run is deterministic), pointer lock uses the
// fallback, and the box test tops points up, because round 1 does not pay enough for both purchases.
(() => {
const results = []
const status = window.__deadInkCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 100) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const pressKey = code => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.replace('Key', '').toLowerCase(), code, bubbles: true, cancelable: true }))
  const standAt = (stand, look) => { p.body.teleport(stand.clone()); p.actions.syncCamera(cam); cam.lookAt(look); e.invalidate() }

  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  check(p.playing, 'the game starts')
  check(m.state.points === 500 && m.weapons.current?.name === 'pistol', 'you start with a pistol and 500 points', `${m.weapons.current?.name} ${m.state.points}`)
  check(m.wallBuys.length === 4 && !!m.box, 'four wall guns and a Mystery Box were placed', `${m.wallBuys.length} walls`)

  // ---- Round 1, played by a bot through the real weapon ----------------------------------------
  const startPoints = m.state.points
  let shots = 0
  const bot = setInterval(() => {
    if (m.state.phase !== 'active') return
    const w = m.weapons
    if (w.current && w.current.magazine === 0) { w.reload(); return }
    const eye = cam.getWorldPosition(new V())
    let best = null, bestDistance = 70
    for (const z of m.director.zombies) {
      if (z.state !== 'chase') continue
      const head = z.actor.rig.bones.head.getWorldPosition(new V()).add(new V(0, 0.06, 0))
      const d = head.distanceTo(eye)
      if (d < bestDistance && p.world.visible(eye, head, z.actor.root)) { best = head; bestDistance = d }
    }
    if (!best) return
    cam.lookAt(best)
    w.trigger(true); setTimeout(() => w.trigger(false), 20)
    shots++
  }, 90)
  const round1 = await until(() => m.state.round >= 1, 12000)
  check(round1, 'round 1 starts after the opening delay')
  const cleared = await until(() => m.rounds.phase === 'break' && m.state.round === 1, 90000, 250)
  clearInterval(bot)
  check(cleared, 'the bot cleared round 1', `kills ${m.state.kills}, alive ${m.director.aliveCount}, shots ${shots}`)
  check(m.state.kills === 6, 'round 1 had exactly 6 zombies (solo)', `${m.state.kills}`)
  check(m.state.points > startPoints, 'killing zombies earns points', `${startPoints} -> ${m.state.points}`)
  // Points follow the rule exactly: 10 per non-lethal hit, 60 / 100 per kill.
  check((m.state.points - startPoints) >= 6 * 60, 'at least 60 points per kill', `${m.state.points - startPoints}`)
  check(m.state.headshots >= 1, 'the bot landed headshots', `${m.state.headshots}`)
  check(/Round 1 survived/.test(document.querySelector('.dead-ink-banner')?.textContent || ''), 'the end of round 1 is announced')
  const round2 = await until(() => m.state.round === 2, 14000)
  check(round2, 'round 2 starts after the break')

  // ---- Buy the nearest wall gun with a real F press ---------------------------------------------
  const wall = m.wallBuys[0]
  m.state.points = Math.max(m.state.points, wall.price + 10)
  const before = m.state.points
  standAt(wall.spot.stand.clone(), wall.point.clone())
  await sleep(250)
  pressKey('KeyF')
  await sleep(250)
  check(m.weapons.slots.some(s => s?.name === wall.weapon), `pressing F at the wall buys the ${wall.weapon}`, JSON.stringify(m.weapons.slots.map(s => s?.name)))
  check(m.state.points === before - wall.price, 'and costs its price', `${before} -> ${m.state.points}`)
  check(m.weapons.current?.name === wall.weapon, 'the bought gun goes into your hands')
  check(m.weapons.slots.length === 2, 'you carry two guns, as in Call of Duty')

  // ---- The Mystery Box ----------------------------------------------------------------------------
  const box = m.box
  m.state.points += 2000
  const beforeBox = m.state.points
  standAt(box.spot.stand.clone(), box.point.clone())
  await sleep(250)
  pressKey('KeyF')
  await sleep(200)
  check(box.state === 'spinning', 'pressing F at the box spins it')
  check(m.state.points === beforeBox - 950, 'the box costs 950', `${beforeBox} -> ${m.state.points}`)
  const offered = await until(() => box.state === 'offering', 6000)
  check(offered, 'the box stops on a gun')
  const offer = { ...box.offer }
  check(offer.rarity && offer.rarity !== 'common', 'box guns are never grey', offer.rarity)
  check(!m.weapons.slots.some(s => s?.name === offer.name), 'the box never offers a gun you carry', offer.name)
  pressKey('KeyF')
  await sleep(250)
  check(m.weapons.current?.name === offer.name && m.weapons.current?.rarity === offer.rarity, `taking it puts the ${offer.rarity} ${offer.name} in your hands`)
  check(box.state === 'idle', 'the box closes')

  // ---- The frame budget with a round in progress ---------------------------------------------------
  await sleep(4000)
  const stats = e.stats()
  m.invincible = false
  return { stats: { fps: stats.fps && +stats.fps.toFixed(1), frameP95: stats.frameP95 && +stats.frameP95.toFixed(1), drawCalls: stats.drawCalls, alive: m.director.aliveCount }, points: m.state.points, kills: m.state.kills, headshots: m.state.headshots, offer }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
