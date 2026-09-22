// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-perks.js
// Starts in the page and returns at once; poll window.__perkCheck for { done, results, error? }.
// Buys every perk at its machine with a real F press and checks what it does; then the Pack-a-Punch.
(() => {
const results = []
const status = window.__perkCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const pressKey = code => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.replace(/Key|Digit/, '').toLowerCase(), code, bubbles: true, cancelable: true }))
  const standAt = (stand, look) => { p.body.teleport(stand.clone()); p.actions.syncCamera(cam); cam.lookAt(look); e.invalidate() }
  p.fallback = true
  document.querySelector('#walk-start').click()
  m.rounds.timer = 9999; m.rounds.phase = 'break'
  check(m.perkMachines.length === 5 && !!m.pack, 'five perk machines and a Pack-a-Punch were placed', `${m.perkMachines.length}`)
  const machine = kind => m.perkMachines.find(x => x.kind === kind)
  const buy = async kind => {
    const at = machine(kind)
    m.state.points = Math.max(m.state.points, 5000)
    const before = m.state.points
    standAt(at.spot.stand.clone(), at.point.clone())
    await sleep(250)
    pressKey('KeyF')
    await sleep(100)
    const paid = before - m.state.points
    await until(() => m.perks.has(kind), 2500)
    return paid
  }

  // Thick Ink: health goes past 100.
  const paid = await buy('thickInk')
  check(paid === 2500, 'Thick Ink costs 2500', `${paid}`)
  check(m.perks.has('thickInk'), 'drinking Thick Ink gives it')
  check(await until(() => m.state.health > 150, 4000), 'with Thick Ink health climbs past 100', `${m.state.health.toFixed(0)}`)
  check(document.querySelectorAll('.dead-ink-perks img').length === 1, 'its badge shows on the HUD')

  await buy('quickDip')
  check(m.weapons.reloadScale === 0.5, 'Quick Dip halves reload time')
  await buy('doubleLine')
  check(m.weapons.fireScale === 0.75, 'Double Line fires faster')
  await buy('spareNib')
  check(m.weapons.slots.length === 3, 'Spare Nib adds a third weapon slot')
  check([...document.querySelectorAll('.hud-slot')].filter(c => !c.hidden).length === 3, 'and the hotbar shows three slots')

  // The perk limit: a fifth is refused and costs nothing.
  m.state.points = 5000
  const beforeFifth = m.state.points
  await buy('secondDraft')
  check(!m.perks.has('secondDraft') && m.state.points === beforeFifth, 'a fifth perk is refused, as in Call of Duty', `${m.state.points}`)

  // Going down with Second Draft: drop Double Line to make room, buy Second Draft, then take a lethal hit.
  m.perks.delete('doubleLine')
  await buy('secondDraft')
  check(m.perks.has('secondDraft'), 'Second Draft bought')
  m.damage(10000, 'zombie', p.body.position.clone().add(new V(1, 1.3, 0)))
  check(m.state.phase === 'active' && m.state.health > 0, 'Second Draft gets you back up instead of dying', `${m.state.phase} ${m.state.health}`)
  check(m.perks.size === 0, 'and costs every perk you had')
  check(m.weapons.slots.length === 2, 'including Spare Nib\'s third slot')
  m.damage(10000, 'zombie', p.body.position.clone().add(new V(1, 1.3, 0)))
  check(m.state.phase === 'active', 'a moment of grace right after getting up')

  // Pack-a-Punch.
  m.invincible = true
  const pack = m.pack
  const gun = m.weapons.current
  check(gun && !gun.packed, 'holding an ordinary gun', gun?.name)
  m.state.points = 6000
  standAt(pack.spot.stand.clone(), pack.point.clone())
  await sleep(250)
  pressKey('KeyF')
  await sleep(150)
  check(pack.state === 'working', 'the Pack-a-Punch takes the gun')
  check(m.state.points === 1000, 'for 5000 points', `${m.state.points}`)
  check(await until(() => pack.state === 'ready', 5000), 'and works on it')
  status.packReady = true
  await sleep(600)
  pressKey('KeyF')
  await sleep(250)
  const packed = m.weapons.current
  check(packed?.packed && packed.name === gun.name, 'you take back the upgraded gun', packed?.name)
  check(m.weapons.label === { pistol: 'Fountain Pen', smg: 'Inkjet', ak: 'Blotter', shotgun: 'Splatter', sniper: 'Quill' }[gun.name], 'with its new name', m.weapons.label)
  await sleep(300)
  let tinted = false
  m.weapons.heldModel?.traverse(o => { if (o.isMesh && o.material?.color && o.material.color.getHexString() !== 'fbfaf5' && o.material.color.r < 0.99 && !o.material.map && o.material.polygonOffset) tinted = true })
  check(tinted, 'and it wears the shimmering camo')
  status.packed = true
  await sleep(800)
  m.invincible = false
  return { perks: [...m.perks] }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
