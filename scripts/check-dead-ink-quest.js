// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-quest.js
// Starts in the page and returns at once; poll window.__questCheck for { done, results, error? }.
// The main quest from the power to the Editor's death, with real F presses and real blasts.
(() => {
const results = []
const status = window.__questCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const pressKey = code => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.replace(/Key|Digit/, '').toLowerCase(), code, bubbles: true, cancelable: true }))
  const press = async () => { await sleep(250); pressKey('KeyF'); await sleep(150) }
  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  await sleep(300)
  m.rounds.timer = 9999; m.rounds.phase = 'break'
  for (const gate of m.zones?.gates ?? []) m.zones.open(gate)
  const quest = () => document.querySelector('.dead-ink-quest')?.textContent ?? ''

  check(m.questStep === 'power' && m.wells.length === 3 && m.wells.every(w => !w.awake), 'the quest starts at the power, three inkwells asleep')
  check(/power switch/i.test(quest()), 'the quest line says to find the power switch', quest())
  m.setPower(true, false)
  await sleep(100)
  check(m.questStep === 'pack', 'with the power on, the next step is the Pack-a-Punch')
  m.completeBuild('pack')
  await sleep(100)
  check(m.questStep === 'wells' && m.wells.every(w => w.awake), 'the Pack-a-Punch built, the inkwells wake up')

  // A zombie killed by a well sends its ink into it.
  const well = m.wells[0]
  well.souls = 14
  const z = m.director.spawn(well.root.position.clone().add(new V(2.5, 0, 0)), 100, 'walk', 0)
  check(!!z, 'a zombie beside the first well')
  await sleep(100)
  m.grenadeBlast(z.position.clone())
  check(await until(() => well.full, 2500), 'its ink flies into the well and fills it', `${well.souls}`)
  check(well.bottleWaiting, 'a full well leaves a bottle of ink')
  for (const other of m.wells.slice(1)) { other.souls = 14; other.addSoul() }
  // Take the three bottles.
  for (const w of m.wells) {
    const node = m.graph.nearest(w.root.position.clone().add(new V(1.2, 0, 0)), 3)
    p.body.teleport(m.graph.point(node)); p.actions.syncCamera(cam); cam.lookAt(w.point); e.invalidate()
    await press()
  }
  check(m.questStep === 'pour', 'three bottles taken: pour them', `${m.questStep}`)
  // Pour at the Pack-a-Punch.
  p.body.teleport(m.pack.spot.stand.clone()); p.actions.syncCamera(cam); cam.lookAt(m.pack.point); e.invalidate()
  await press()
  check(m.questStep === 'editor', 'pouring the ink starts the press')
  check(await until(() => !!m.editor, 5000), 'the Editor climbs out')
  check(await until(() => document.querySelector('.dead-ink-boss span')?.textContent === 'THE EDITOR', 1000), 'its health bar says THE EDITOR')
  check(m.editor.maxHealth >= 3 * 2000, 'with at least three times the Brute’s health', `${m.editor.maxHealth}`)
  // Kill it.
  m.editor.health = 1
  m.grenadeBlast(m.editor.position.clone())
  check(await until(() => m.questStep === 'done', 1500), 'killing the Editor finishes the quest')
  check(m.perks.size === 5, 'and every perk is yours', `${m.perks.size}`)
  check(await until(() => !quest(), 1000), 'the quest line goes away', quest())
  m.invincible = false
  return { step: m.questStep }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
