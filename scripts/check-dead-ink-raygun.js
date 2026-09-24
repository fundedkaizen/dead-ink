// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-raygun.js
// Starts in the page and returns at once; poll window.__rayCheck for { done, results, error? }.
// The Ink Ray: its bolt flies and never bursts in your hands, its own report, and the X2 from the Pack-a-Punch.
(() => {
const results = []
const status = window.__rayCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  const V = cam.position.constructor
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const check = (ok, label, detail = '') => results.push({ passed: !!ok, label, detail })
  p.fallback = true
  document.querySelector('#walk-start').click()
  await sleep(400)
  m.rounds.timer = 9999; m.rounds.phase = 'break'
  m.weapons.restore({ slots: [{ id: 'ray', name: 'pistol', rarity: 'legendary', special: 'rayGun', magazine: 20, reserve: 160 }, null], selected: 0, pickups: [], nextId: 5 })
  await sleep(600)
  const sounds = []
  const emit = m.emit.bind(m)
  m.emit = event => { sounds.push(event.kind); return emit(event) }
  // Face down the longest open line from the spawn.
  p.body.teleport(new V(-30, 0.05, -25)); p.actions.syncCamera(cam)
  let best = 0, bestYaw = 0
  for (let i = 0; i < 16; i++) {
    const yaw = i / 16 * Math.PI * 2, dir = new V(-Math.sin(yaw), 0, -Math.cos(yaw))
    const hit = p.world.raySurface(cam.position.clone(), dir, 80)
    const d = hit?.distance ?? 80
    if (d > best) { best = d; bestYaw = yaw }
  }
  cam.rotation.set(0, bestYaw, 0, 'YXZ'); p.rotation?.set?.(0, bestYaw, 0); e.invalidate()
  const health = m.state.health
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  await sleep(60)
  const bolts = m.bolts.bolts
  const flying = bolts.length
  const at = bolts[0]?.mesh.position.clone()
  await sleep(300)
  const later = bolts[0]?.mesh.position.clone()
  await sleep(2500)
  check(sounds.includes('shot-raygun'), 'the Ink Ray makes its own Ray Gun sound', sounds.join(','))
  check(flying >= 1, 'the bolt is in flight after the shot', `${flying} bolts, open line ${best.toFixed(1)} m`)
  check(at && later && later.distanceTo(at) > 5, 'the bolt travels', `${at?.toArray().map(v => v.toFixed(1))} -> ${later?.toArray().map(v => v.toFixed(1))}`)
  check(m.state.health === health, 'firing into the open does not hurt you', `${health} -> ${m.state.health}`)
  // The Pack-a-Punch takes the Ink Ray and hands back the X2.
  m.setPower(true); m.completeBuild('pack')
  m.state.points = 20000
  const pack = m.pack
  p.body.teleport(pack.spot.stand.clone()); p.actions.syncCamera(cam); cam.lookAt(pack.point); e.invalidate()
  await sleep(400)
  const label = p.actions.findTarget(cam)?.label ?? 'none'
  const pressKey = code => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code, bubbles: true, cancelable: true }))
  pressKey('KeyF')
  await sleep(300)
  check(pack.state === 'working' && m.state.points === 15000, 'the Pack-a-Punch takes the Ink Ray for 5000', `${label} | ${pack.state} ${m.state.points}`)
  await sleep(3800)
  pressKey('KeyF')
  await sleep(900)
  const x2 = m.weapons.current
  check(x2?.special === 'rayGun' && x2.packed && x2.magazine === 40 && x2.reserve === 200, 'out comes the Ink Ray X2 with 40 and 200', JSON.stringify(x2))
  check(document.querySelector('.hud-slot-name')?.textContent?.includes('Ink Ray X2') || [...document.querySelectorAll('.hud-slot-name')].some(n => n.textContent === 'Ink Ray X2'), 'the hotbar calls it the Ink Ray X2')
  const again = p.actions.findTarget(cam)?.label ?? 'none'
  check(/fully upgraded/.test(again), 'it cannot be upgraded twice', again)
  sounds.length = 0
  cam.rotation.set(0, bestYaw, 0, 'YXZ'); e.invalidate()
  p.body.teleport(new V(-30, 0.05, -25)); p.actions.syncCamera(cam); cam.rotation.set(0, bestYaw, 0, 'YXZ'); e.invalidate()
  await sleep(300)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  await sleep(60)
  const red = m.bolts.bolts[0]?.mesh.material.color.getHex()
  check(red === 0xd4332a, 'the X2 fires red bolts', red?.toString(16))
  check(sounds.includes('shot-raygun'), 'with the Ray Gun report', sounds.join(','))
  m.emit = emit
})().catch(err => { status.error = String(err?.stack ?? err) }).finally(() => { status.done = true })
})()
