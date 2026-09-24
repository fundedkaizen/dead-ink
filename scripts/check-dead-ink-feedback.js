// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-feedback.js
// Starts in the page and returns at once; poll window.__feedbackCheck for { done, results, error? }.
// The owner's feedback of 24 Sep: the mini map top right, the upgraded-gun layer, the zip line's sound, E throws an Ink Doll.
(() => {
window.__feedbackCheck = { done: false, results: [] }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active, V = cam.position.constructor
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const check = (ok, label, detail = '') => window.__feedbackCheck.results.push({ passed: !!ok, label, detail })
  p.fallback = true
  document.querySelector('#walk-start').click()
  await sleep(600)
  m.invincible = true; m.rounds.timer = 9999; m.rounds.phase = 'break'
  // The mini map sits in the top right corner.
  const map = document.querySelector('.dead-ink-minimap')
  const box = map?.getBoundingClientRect()
  check(box && box.right > innerWidth - 40 && box.top < 40, 'the mini map is in the top right', JSON.stringify(box && { left: box.left, right: box.right, top: box.top }))
  // Upgraded shots play the Pack-a-Punch layer.
  const played = []
  const play = m.audio.play.bind(m.audio)
  m.audio.play = event => { played.push(event); return play(event) }
  let zaps = 0
  const zap = m.audio.zap.bind(m.audio)
  m.audio.zap = event => { zaps++; return zap(event) }
  m.weapons.restore({ slots: [{ id: 'z-ak', name: 'ak', magazine: 30, reserve: 90, packed: true, packLevel: 1 }, null], selected: 0, pickups: [], nextId: 5 })
  await sleep(700)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  await sleep(200)
  check(zaps >= 1, 'an upgraded shot plays the Pack-a-Punch layer', `${zaps} zaps; ${played.filter(e => e.kind.startsWith('shot')).map(e => e.kind + ':' + e.packed).join(',')}`)
  // The zip line: its sound, for the length of the ride.
  const a = p.actions, z = a.ziplines[0]
  const start = a.ziplinePoint(z, false), end = a.ziplinePoint(z, true)
  const along = end.clone().sub(start).setY(0).normalize()
  p.body.teleport(start.clone().addScaledVector(along, -0.8).setY(start.y + 0.05)); a.syncCamera(cam)
  await sleep(250)
  a.syncCamera(cam); cam.lookAt(start.clone().add(new V(0, 1.3, 0)).addScaledVector(along, 2)); e.invalidate()
  await sleep(250)
  played.length = 0
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', bubbles: true, cancelable: true }))
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', key: 'f', bubbles: true, cancelable: true }))
  await sleep(300)
  const ride = played.find(e => e.kind === 'zipline')
  check(!!a.riding && ride && ride.duration > 2, 'riding the zip line plays its sound for the ride', ride ? `${ride.duration.toFixed(1)} s` : played.map(e => e.kind).join(','))
  for (let i = 0; i < 40 && a.riding; i++) await sleep(250)
  // E throws an Ink Doll (not scoped).
  m.dollCount = 3
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true, cancelable: true }))
  await sleep(300)
  check(m.dollCount === 2, 'E throws an Ink Doll', `${m.dollCount}`)
  m.audio.play = play; m.audio.zap = zap
})().catch(err => { window.__feedbackCheck.error = String(err?.stack ?? err) }).finally(() => { window.__feedbackCheck.done = true })
})()
