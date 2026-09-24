// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-specials.js
// Starts in the page and returns at once; poll window.__specialCheck for { done, results, error? }.
// The Ink Doll (bought off its wall, thrown with T, draws the crowd, goes off) and an Ink Storm round.
(() => {
const results = []
const status = window.__specialCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const pressKey = code => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.replace(/Key|Digit/, '').toLowerCase(), code, bubbles: true, cancelable: true }))
  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  m.rounds.timer = 9999; m.rounds.phase = 'break'

  // The Ink Doll wall: bought with F, three dolls.
  const wall = m.dollBuy
  check(!!wall, 'the Ink Doll wall was placed')
  for (const gate of m.zones?.gates ?? []) m.zones.open(gate)
  p.body.teleport(wall.spot.stand.clone()); p.actions.syncCamera(cam); cam.lookAt(wall.point); e.invalidate()
  m.state.points = 5000
  await sleep(250)
  pressKey('KeyF')
  await sleep(100)
  check(m.dollCount === 3 && m.state.points === 2000, 'three Ink Dolls for 3000', `${m.dollCount} dolls, ${m.state.points} points`)
  check(document.querySelector('.dead-ink-grenades svg.doll'), 'the HUD shows them')

  // Thrown: lands upright, zombies go for it, it goes off.
  const zombie = m.director.spawn(p.body.position.clone().add(new V(9, 0, 0)), 999999, 'run', 0)
  check(!!zombie, 'a zombie to draw')
  cam.lookAt(p.body.position.clone().add(new V(0, 0, -6)))
  pressKey('KeyE')
  check(m.dollCount === 2, 'E throws one')
  check(await until(() => m.dolls.resting().length === 1, 3000), 'it lands and stays put')
  const doll = m.dolls.resting()[0].position.clone()
  const start = zombie.position.distanceTo(doll)
  await sleep(2500)
  check(zombie.position.distanceTo(doll) < start - 3, 'the zombie heads for the doll', `${start.toFixed(1)} -> ${zombie.position.distanceTo(doll).toFixed(1)}`)
  check(await until(() => m.dolls.resting().length === 0, 8000), 'and it goes off')
  m.director.clear()

  // A Max Ammo tops the dolls back up.
  m.powerups.spawn('maxAmmo', p.body.position.clone())
  check(await until(() => m.dollCount === 3, 4000), 'a Max Ammo refills the dolls', `${m.dollCount}`)

  // An Ink Storm round: darker page, all sprinters, fewer of them, a Max Ammo at the end.
  m.rounds.round = 6; m.rounds.phase = 'break'; m.rounds.timer = 0.01
  check(await until(() => m.rounds.round === 7, 2000), 'round 7 starts')
  check(m.storm && document.body.dataset.deadInkStorm === 'true', 'round 7 is an Ink Storm with the light gone')
  check(m.rounds.toSpawn + m.director.aliveCount <= 17, 'a smaller pack than usual', `${m.rounds.toSpawn + m.director.aliveCount}`)
  await until(() => m.director.aliveCount > 0, 4000)
  const alive = m.director.zombies.filter(z => z.state === 'chase')
  check(alive.length > 0 && alive.every(z => z.gait === 'sprint'), 'every one sprints')
  // Clear it: the last kill leaves a Max Ammo, and the light comes back.
  m.rounds.toSpawn = 0
  const before = m.powerups.count
  // No kill of ours to mark the spot, so it drops at your feet and you take it at once: check either.
  m.grenadeCount = 0
  for (const z of m.director.zombies.filter(z => z.state === 'chase')) z.health = 1
  m.director.killAll?.()
  check(await until(() => m.rounds.phase === 'break', 4000), 'the storm round ends')
  check(await until(() => m.powerups.count > before || m.grenadeCount === 4, 2000), 'a Max Ammo drops', `${m.powerups.count} drops, ${m.grenadeCount} grenades`)
  check(!m.storm && document.body.dataset.deadInkStorm === undefined, 'and the light comes back')
  m.invincible = false
  return { points: m.state.points }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
