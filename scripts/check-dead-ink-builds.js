// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-builds.js
// Starts in the page and returns at once; poll window.__buildCheck for { done, results, error? }.
// The power switch, the buildable parts and the three builds, all with real F presses.
(() => {
const results = []
const status = window.__buildCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const pressKey = code => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.replace(/Key|Digit/, '').toLowerCase(), code, bubbles: true, cancelable: true }))
  const press = async () => { await sleep(250); pressKey('KeyF'); await sleep(150) }
  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  await sleep(300)
  m.rounds.timer = 9999; m.rounds.phase = 'break'
  for (const gate of m.zones?.gates ?? []) m.zones.open(gate)
  const standFacing = (spot, look) => { p.body.teleport(spot.stand.clone()); p.actions.syncCamera(cam); cam.lookAt(look); e.invalidate() }

  check(!m.power && !m.packBuilt, 'the power starts off and the Pack-a-Punch unbuilt')
  check(m.parts.length === 7, 'seven parts lie about the compound', `${m.parts.map(x => x.id)}`)
  check(!!m.powerSwitch && m.sites.has('pack') && m.sites.has('shield'), 'the power switch, the Pack-a-Punch site and the shield bench were placed')

  // A dark machine refuses you.
  const machine = m.perkMachines.find(x => x.kind !== 'secondDraft')
  m.state.points = 5000
  standFacing(machine.spot, machine.point.clone())
  await press()
  check(m.state.points === 5000 && m.perks.size === 0, 'with no power a perk machine takes nothing', `${m.state.points}`)
  // Alone, Second Draft is the exception: it sells without power, as solo Quick Revive does.
  const draft = m.perkMachines.find(x => x.kind === 'secondDraft')
  standFacing(draft.spot, draft.point.clone())
  await press()
  check(await new Promise(r => setTimeout(() => r(m.perks.has('secondDraft') || m.state.points < 5000), 2500)), 'solo, Second Draft sells without power', `${m.state.points}`)
  m.perks.clear(); m.state.points = 5000

  const take = async id => {
    const part = m.parts.find(x => x.id === id)
    check(!!part, `the ${id} is somewhere`)
    // Standing over it (it may be up a tower, where a step aside is a fall), looking down at it.
    p.body.teleport(part.root.position.clone().add(new V(0, 0.05, 0))); p.actions.syncCamera(cam); cam.lookAt(part.point.clone().add(new V(0.2, 0, 0.2))); e.invalidate()
    await press()
    check(m.carried.has(id) && !m.parts.includes(part), `F picks up the ${id}`)
  }

  // The power: find the lever, put it back, pull it.
  await take('lever')
  standFacing(m.powerSwitch.spot, m.powerSwitch.point.clone())
  await press()
  check(m.powerSwitch.state === 'ready' && !m.carried.has('lever'), 'the lever goes back on the switch')
  await press()
  check(m.power && m.powerSwitch.state === 'on', 'pulling it turns the power on')
  check(m.perkMachines.every(x => x.powered), 'every perk machine has power')
  // With the power on, every machine sells: buy one of each (up to the limit) with real presses.
  const bought = []
  for (const kind of ['thickInk', 'longStroke', 'doubleLine']) {
    const at = m.perkMachines.find(x => x.kind === kind)
    m.state.points = 9000
    standFacing(at.spot, at.point.clone())
    await press()
    await new Promise(r => setTimeout(r, 2200))
    bought.push(`${kind}:${m.perks.has(kind)}:${m.state.points}:${document.querySelector('.interaction-prompt, .hud-prompt, [class*=prompt]')?.textContent ?? ''}`)
    check(m.perks.has(kind), `with the power on, ${kind} can be bought`, bought.join(' | '))
  }
  m.perks.clear(); m.state.points = 5000

  // An ink trap: pay at its switch, zombies in the jets die (no points), you get hurt in them.
  const trap = m.traps[0]
  check(m.traps.length === 2, 'two ink traps were placed', `${m.traps.map(t => t.spec.id)}`)
  m.state.points = 3000
  p.body.teleport(trap.point.clone().setY(trap.centre.y).add(new V(0.9, 0, 0.9))); p.actions.syncCamera(cam); cam.lookAt(trap.point); e.invalidate()
  if (!trap.inside(p.body.position)) {
    await press()
  }
  check(trap.state === 'active' && m.state.points === 2000, 'F at the switch starts the trap for 1000', `${trap.state} ${m.state.points}`)
  const victim = m.director.spawn(trap.centre.clone(), 400, 'walk', 0)
  const kills = m.state.kills
  await sleep(800)
  check(victim.state !== 'chase' && m.state.kills === kills + 1 && m.state.points === 2000, 'a zombie in the jets dies, and pays nothing', `${victim.state} ${m.state.points}`)
  m.invincible = false
  const before = m.state.health
  p.body.teleport(trap.centre.clone().setY(trap.centre.y + 0.05)); p.actions.syncCamera(cam); e.invalidate()
  await sleep(700)
  check(m.state.health < before, 'standing in the jets hurts', `${before} -> ${m.state.health}`)
  m.invincible = true
  m.state.health = 100
  m.director.clear()

  // The shield: three parts to the bench, then take it.
  for (const id of ['panel', 'strap', 'grip']) await take(id)
  const bench = m.sites.get('shield')
  standFacing(bench.spot, bench.point.clone())
  await press()
  check(bench.complete, 'the three parts build the ink shield')
  await press()
  check(m.shield && m.shield.health === 1500, 'F takes the shield onto your back')
  check(!document.querySelector('.dead-ink-shield').hidden, 'the HUD shows the shield')
  // A hit from behind lands on the shield; a hit from the front lands on you.
  m.invincible = false
  const yaw = new (cam.rotation.constructor)().setFromQuaternion(cam.quaternion, 'YXZ').y
  const behind = p.body.position.clone().add(new V(Math.sin(yaw) * 1.2, 1.3, Math.cos(yaw) * 1.2))
  const ahead = p.body.position.clone().add(new V(-Math.sin(yaw) * 1.2, 1.3, -Math.cos(yaw) * 1.2))
  const health = m.state.health
  m.damage(50, 'zombie', behind)
  check(m.state.health === health && m.shield.health === 1450, 'a hit from behind lands on the shield', `${m.state.health} ${m.shield?.health}`)
  m.damage(20, 'zombie', ahead)
  check(m.state.health === health - 20, 'a hit from the front still lands on you', `${m.state.health}`)
  m.invincible = true

  // The Pack-a-Punch: three parts, far apart.
  for (const id of ['gear', 'plate', 'tank']) await take(id)
  const site = m.sites.get('pack')
  standFacing(m.pack.spot, site.point.clone())
  await press()
  check(m.packBuilt && m.pack.root.visible, 'the three parts build the Pack-a-Punch')
  m.invincible = false
  return { power: m.power }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
