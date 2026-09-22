// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-powerups.js
// Starts in the page and returns at once; poll window.__powerupCheck for { done, results, error? }.
// Each power-up is dropped at the player's feet and taken by walking into it, through the real game
// loop; then its effect is checked on the real systems (weapon, director, points, HUD).
(() => {
const results = []
const status = window.__powerupCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  m.rounds.timer = 9999; m.rounds.phase = 'break'
  const feet = () => p.body.position.clone()
  const take = async kind => {
    const before = m.powerups.count
    m.powerups.spawn(kind, feet().add(new V(3, 0, 0)))
    check(m.powerups.count === before + 1, `a ${kind} drop appears`)
    await sleep(100)
    m.powerups.spawn(kind, feet())
    return until(() => m.powerups.count === before + 1, 1500)
  }
  const ahead = (metres) => {
    const forward = cam.getWorldDirection(new V()).setY(0).normalize()
    return m.graph.point(m.graph.nearest(feet().addScaledVector(forward, metres), 4))
  }

  // Max Ammo refills what you carry.
  const gun = m.weapons.current
  gun.reserve = 0
  check(await take('maxAmmo'), 'walking into Max Ammo takes it')
  check(gun.reserve > 0, 'Max Ammo refills the reserve', `${gun.reserve}`)
  check(/Max Ammo/.test(document.querySelector('.dead-ink-banner')?.textContent || ''), 'and says so')

  // Nuke: every zombie dies, 400 points.
  for (let i = 0; i < 3; i++) m.director.spawn(ahead(6 + i * 2), 5000, 'walk', 0)
  await sleep(100)
  const alive = m.director.aliveCount, points = m.state.points
  check(alive === 3, 'three zombies are standing', `${alive}`)
  check(await take('nuke'), 'walking into the Nuke takes it')
  check(m.director.aliveCount === 0, 'the Nuke kills every zombie')
  check(m.state.points === points + 400, 'and pays 400', `${points} -> ${m.state.points}`)

  // Insta-Kill: a 5000-health zombie dies to one pistol round.
  check(await take('instaKill'), 'walking into Insta-Kill takes it')
  check(m.timers.instaKill > 25, 'Insta-Kill runs for 30 seconds', `${m.timers.instaKill}`)
  const tank = m.director.spawn(ahead(6), 5000, 'walk', 0)
  await sleep(150)
  cam.lookAt(tank.actor.rig.bones.chest.getWorldPosition(new V()))
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  check(await until(() => tank.state === 'dead', 1000), 'one round kills a 5000-health zombie under Insta-Kill', tank.state)

  // Double Points.
  check(await take('doublePoints'), 'walking into Double Points takes it')
  const beforeHit = m.state.points
  const next = m.director.spawn(ahead(6), 5000, 'walk', 0)
  m.timers.instaKill = 0.01
  await sleep(200)
  cam.lookAt(next.actor.rig.bones.chest.getWorldPosition(new V()))
  await sleep(300)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  check(await until(() => m.state.points > beforeHit, 1000), 'a hit pays under Double Points')
  check(m.state.points - beforeHit === 20, 'a hit pays 20 instead of 10', `${m.state.points - beforeHit}`)
  m.director.clear()

  // The HUD shows running power-ups with their seconds.
  const cells = [...document.querySelectorAll('.dead-ink-powerup')]
  check(cells.length >= 1 && cells.every(c => /\d+/.test(c.textContent)), 'running power-ups show on the HUD with seconds left', `${cells.length}`)

  // Death Machine: your guns go away for a minigun, and come back after.
  const own = m.weapons.slots.map(s => s?.name ?? null)
  check(await take('deathMachine'), 'walking into the Death Machine takes it')
  check(m.weapons.current?.special === 'deathMachine', 'you hold the Death Machine')
  check(m.weapons.label === 'Death Machine', 'labelled Death Machine')
  const model = m.weapons.model
  check(!!model?.userData.parts.barrels, 'with its barrel cluster')
  status.deathMachineShot = true
  await sleep(1200)
  m.timers.deathMachine = 0.05
  await sleep(300)
  check(!m.weapons.current?.special, 'when it runs out, your own guns come back')
  check(JSON.stringify(m.weapons.slots.map(s => s?.name ?? null)) === JSON.stringify(own), 'the same guns as before', JSON.stringify(m.weapons.slots.map(s => s?.name ?? null)))

  // Uncollected drops blink out after 30 s.
  m.powerups.spawn('nuke', feet().add(new V(8, 0, 0)))
  const drops = m.powerups.active
  drops[drops.length - 1].age // exists
  m.powerups.update(29.9, null)
  check(m.powerups.count >= 1, 'a drop is still there just before 30 s')
  m.powerups.update(0.2, null)
  check(m.powerups.count === 0, 'and gone after 30 s')
  m.invincible = false
  return { points: m.state.points }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
