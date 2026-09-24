// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-minimap.js
// It starts in the page and returns at once. Poll until done:
//   npx agent-browser eval "JSON.stringify(window.__minimapCheck)"
// (artifacts/run-browser-check.sh scripts/check-dead-ink-minimap.js __minimapCheck does both.)
// window.__minimapCheck is { done, results, error?, size, buildMs, drawMs, redraws }. Run it at 1280x720
// and at 800x600 (agent-browser set viewport).
// The mini map through the real runtime: it shows in a game; perk icons sit at their true bearing and
// distance, worked out from the camera itself rather than from the map's own maths, and far ones are
// pinned to the rim; buildable parts show where they lie and leave the map when picked up; the box icon
// follows the box; the Pack-a-Punch appears once built; the power switch's bolt goes when the power
// comes on; a co-op partner is a blue arrow; the Settings toggle hides the map; nothing in Dead Ink's
// HUD overlaps it.
// Staged: invincible player, pointer-lock fallback, round 1 held back (no zombies); the box is moved,
// the Pack-a-Punch built and the power turned on directly; the co-op partner is faked (no relay); the
// HUD is filled in by hand for the overlap test. Reload the page afterwards.
(() => {
const results = []
const status = window.__minimapCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const map = document.querySelector('.dead-ink-minimap'), mm = m.minimap
  check(map && mm, 'the mini map is on the page')

  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  m.rounds.timer = 1e6
  await sleep(400)
  check(p.playing && !map.hidden && map.getClientRects().length > 0, 'the map shows in a game')
  const rect = map.getBoundingClientRect(), dpr = map.width / rect.width
  const size = Math.round(rect.width), perMetre = rect.width / 2 / 35
  const wide = innerWidth > 900 && innerHeight > 700
  check(wide ? size === 180 : size < 180 && size >= 110, `it is ${wide ? '180' : 'smaller than 180'} px across here`, `${size} px at ${innerWidth}x${innerHeight}`)
  check(rect.left < 30 && rect.top < 30, 'in the top-left corner', `${rect.left},${rect.top}`)
  status.size = size
  status.buildMs = Math.round(mm.buildMs)

  // Stand somewhere, facing `yaw` (level), and give the map time to redraw.
  const stand = async (x, z, yaw) => {
    const node = m.graph.nearest(new V(x, 0, z), 4)
    p.body.teleport(node >= 0 ? m.graph.point(node) : new V(x, 0, z))
    p.actions.syncCamera(cam)
    cam.lookAt(cam.position.x - Math.sin(yaw) * 10, cam.position.y, cam.position.z - Math.cos(yaw) * 10)
    e.invalidate()
    await sleep(250)
    cam.updateMatrixWorld(true)
  }
  // Where a world point must appear on the map: straight from camera space (x right, z back = down).
  const expected = at => { const local = at.clone().applyMatrix4(cam.matrixWorldInverse); return { x: local.x * perMetre, y: local.z * perMetre } }
  const icon = kind => mm.icons().find(i => i.kind === kind)
  const pixels = map.getContext('2d')
  // The canvas colour at a point given in CSS pixels from the map's middle.
  const colour = (x, y) => { const d = pixels.getImageData(Math.round((rect.width / 2 + x) * dpr), Math.round((rect.height / 2 + y) * dpr), 1, 1).data; return [d[0], d[1], d[2]] }
  const near = (rgb, css, tolerance = 70) => { const n = parseInt(css.slice(1), 16); return Math.abs(rgb[0] - (n >> 16)) + Math.abs(rgb[1] - (n >> 8 & 255)) + Math.abs(rgb[2] - (n & 255)) < tolerance }
  // How many of 16 points on a ring round (x, y) have this colour.
  const ring = (x, y, radius, css) => { let n = 0; for (let i = 0; i < 16; i++) if (near(colour(x + Math.cos(i / 16 * Math.PI * 2) * radius, y + Math.sin(i / 16 * Math.PI * 2) * radius), css)) n++; return n }

  // ---- You, in the middle, as an ink arrow; the rim in ink ----------------------------------------
  await stand(-30, -25, 0.7)
  check(colour(0, 0).every(v => v < 90), 'you are the ink arrow in the middle', colour(0, 0).join(','))
  const rimInk = Math.min(...[0.4, 0.9, 1.4].map(d => Math.max(...colour(-(rect.width / 2 - d), 0))))
  check(rimInk < 90, 'the rim is ink', `${rimInk}`)

  // ---- Perk machines: bearing and distance from the camera; far ones pinned to the rim ------------
  const eye = () => new V(cam.position.x, 0, cam.position.z)
  const byDistance = [...m.perkMachines].sort((a, b) => a.root.position.distanceTo(eye()) - b.root.position.distanceTo(eye()))
  const closest = byDistance[0]
  // Stand 14 m out from the nearest machine and turn 50 degrees away from it, so its bearing is not trivial.
  const out = closest.root.position.clone().addScaledVector(closest.spot.normal, 14)
  await stand(out.x, out.z, Math.atan2(closest.spot.normal.x, closest.spot.normal.z) + 0.87)
  const wantPerk = expected(closest.root.position), gotPerk = icon(closest.kind)
  check(gotPerk && !gotPerk.pinned, `the ${closest.kind} machine 14 m away is on the map`, JSON.stringify(gotPerk))
  check(Math.abs(gotPerk.x - wantPerk.x) < 1.5 && Math.abs(gotPerk.y - wantPerk.y) < 1.5, 'at its true bearing and distance',
    `map ${gotPerk.x.toFixed(1)},${gotPerk.y.toFixed(1)} camera ${wantPerk.x.toFixed(1)},${wantPerk.y.toFixed(1)}`)
  const perkCss = { thickInk: '#c8322b', quickDip: '#2e9b45', doubleLine: '#e08a1e', secondDraft: '#2f6fd0', spareNib: '#1f9a93', longStroke: '#d9a51e' }[closest.kind]
  const iconRadius = rect.width * 0.05
  check(ring(gotPerk.x, gotPerk.y, iconRadius * 0.62, perkCss) >= 4, `drawn there in its own colour (${perkCss})`, `${ring(gotPerk.x, gotPerk.y, iconRadius * 0.62, perkCss)} of 16`)
  const far = m.perkMachines.filter(machine => machine.root.position.distanceTo(eye()) > 45)
  check(far.length >= 2, 'some machines are far off', `${far.length}`)
  for (const machine of far) {
    const got = icon(machine.kind), want = expected(machine.root.position)
    const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(got.x, -got.y) - Math.atan2(want.x, -want.y)), Math.cos(Math.atan2(got.x, -got.y) - Math.atan2(want.x, -want.y))))
    check(got.pinned && Math.hypot(got.x, got.y) > rect.width / 2 - iconRadius * 1.6 && turn < 0.035, `the far ${machine.kind} machine is pinned to the rim in its direction`,
      `pinned ${got.pinned}, ${Math.hypot(got.x, got.y).toFixed(1)} px out, ${(turn * 180 / Math.PI).toFixed(1)} deg off`)
  }

  // ---- Buildable parts: ink cogs where they lie, pinned when far, gone once picked up ------------------
  check(m.parts.length >= 5, 'the buildable parts lie about', `${m.parts.length}`)
  const part = m.parts.find(each => each.root.position.y < 1) ?? m.parts[0]
  await stand(part.root.position.x + 7, part.root.position.z - 5, 0.3)
  const gotPart = icon(part.id), wantPart = expected(part.root.position)
  check(gotPart && !gotPart.pinned && Math.abs(gotPart.x - wantPart.x) < 1.5 && Math.abs(gotPart.y - wantPart.y) < 1.5, `the ${part.id} is on the map where it lies`,
    `${JSON.stringify(gotPart)} want ${wantPart.x.toFixed(1)},${wantPart.y.toFixed(1)}`)
  check(ring(gotPart.x, gotPart.y, rect.width * 0.02, '#111111') >= 10, 'as an ink cog', `${ring(gotPart.x, gotPart.y, rect.width * 0.02, '#111111')} of 16`)
  const farParts = m.parts.filter(each => each.root.position.distanceTo(eye()) > 45)
  check(farParts.length >= 1, 'some parts are far off', `${farParts.length}`)
  for (const each of farParts) {
    const got = icon(each.id), want = expected(each.root.position)
    const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(got.x, -got.y) - Math.atan2(want.x, -want.y)), Math.cos(Math.atan2(got.x, -got.y) - Math.atan2(want.x, -want.y))))
    check(got.pinned && turn < 0.035, `the far ${each.id} is pinned to the rim in its direction`, `${(turn * 180 / Math.PI).toFixed(1)} deg off`)
  }
  m.takePart(part, false)
  await sleep(250)
  check(!icon(part.id) && !m.parts.includes(part), 'picked up, it leaves the map')

  // ---- The Mystery Box: its icon follows it when it moves ----------------------------------------
  const box = m.box
  const boxAt = async () => { const spot = box.root.position; await stand(spot.x + box.spot.normal.x * 12, spot.z + box.spot.normal.z * 12, 0.4) }
  await boxAt()
  let gotBox = icon('box'), wantBox = expected(box.root.position)
  check(gotBox && !gotBox.pinned && Math.abs(gotBox.x - wantBox.x) < 1.5 && Math.abs(gotBox.y - wantBox.y) < 1.5, 'the box icon sits on the box',
    `${JSON.stringify(gotBox)} want ${wantBox.x.toFixed(1)},${wantBox.y.toFixed(1)}`)
  check(ring(gotBox.x, gotBox.y, iconRadius * 0.55, '#111111') >= 4, 'drawn as an ink box')
  const from = box.root.position.clone()
  box.place(m.boxSpots.find(spot => spot !== box.spot))
  await sleep(250)
  gotBox = icon('box'); wantBox = expected(box.root.position)
  check(box.root.position.distanceTo(from) > 20, 'the box moved', `${from.distanceTo(box.root.position).toFixed(0)} m`)
  const turnBox = Math.abs(Math.atan2(gotBox.x, -gotBox.y) - Math.atan2(wantBox.x, -wantBox.y))
  check(gotBox && (gotBox.pinned ? Math.min(turnBox, Math.PI * 2 - turnBox) < 0.035 : Math.abs(gotBox.x - wantBox.x) < 1.5 && Math.abs(gotBox.y - wantBox.y) < 1.5),
    'and its icon went with it', `${JSON.stringify(gotBox)} want ${wantBox.x.toFixed(1)},${wantBox.y.toFixed(1)}`)
  await boxAt()
  gotBox = icon('box'); wantBox = expected(box.root.position)
  check(!gotBox.pinned && Math.abs(gotBox.x - wantBox.x) < 1.5 && Math.abs(gotBox.y - wantBox.y) < 1.5, 'standing by its new place, the icon is on it')

  // ---- The Pack-a-Punch: only once it is built ----------------------------------------------------
  check(!m.packBuilt && !icon('pack'), 'no Pack-a-Punch on the map before it is built')
  m.completeBuild('pack')
  await sleep(250)
  const gotPack = icon('pack'), wantPack = expected(m.pack.root.position)
  const turnPack = Math.abs(Math.atan2(gotPack?.x ?? 0, -(gotPack?.y ?? 0)) - Math.atan2(wantPack.x, -wantPack.y))
  check(m.packBuilt && gotPack && Math.min(turnPack, Math.PI * 2 - turnPack) < 0.035, 'built, it appears, in its direction', JSON.stringify(gotPack))

  // ---- The power switch: its bolt while the power is off -------------------------------------------
  const power = m.powerSwitch.point
  await stand(power.x + 6, power.z + 6, 0)
  check(!m.power && icon('power'), 'the power switch shows its bolt while the power is off')
  m.setPower(true)
  await sleep(250)
  check(!icon('power'), 'and it is gone once the power is on')

  // ---- A co-op partner: a blue arrow where they stand --------------------------------------------
  await stand(-30, -25, 0)
  const mate = new V(cam.position.x + 8, 0, cam.position.z - 6)
  m.coop.paired = true
  m.partnerState = { p: [mate.x, 0, mate.z], yaw: 1.2, pitch: 0, w: 'pistol', mv: 0, dn: 0, pts: 1500, kills: 3, name: 'Tester' }
  m.partner.feet.copy(mate)
  await sleep(250)
  const gotMate = icon('mate'), wantMate = expected(mate)
  check(gotMate && Math.abs(gotMate.x - wantMate.x) < 1.5 && Math.abs(gotMate.y - wantMate.y) < 1.5, 'the partner is on the map where they stand', JSON.stringify(gotMate))
  check(ring(gotMate.x, gotMate.y, 2, '#2878d0') >= 3 || near(colour(gotMate.x, gotMate.y), '#2878d0'), 'as a blue arrow')

  // ---- Nothing in the HUD overlaps the map -----------------------------------------------------------
  m.zombieHud.perks(['thickInk', 'quickDip', 'doubleLine', 'secondDraft'])
  m.zombieHud.parts(['lever', 'gear', 'crank handle'])
  m.zombieHud.shield(0.7)
  m.timers.instaKill = 25; m.timers.doublePoints = 25
  m.hud.notify('The Mystery Box has moved. Follow its light.', 6, true)
  m.zombieHud.announce('Round 12', 6)
  await sleep(200)
  // The game sets these every frame: set them and measure before the next one (round 4: a full tally).
  m.zombieHud.boss(0.6, 'THE BRUTE')
  m.zombieHud.quest('Kill zombies near the inkwells to fill them (12 of 36)')
  m.zombieHud.update(0, 4, m.state.points)
  const mapBox = map.getBoundingClientRect()
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  for (const [name, selector] of [['round', '.dead-ink-round'], ['quest line', '.dead-ink-quest'], ['points', '.dead-ink-points'], ['perks', '.dead-ink-perks'],
    ['power-up timers', '.dead-ink-powerups'], ['parts list', '.dead-ink-parts'], ['shield', '.dead-ink-shield'], ['co-op scoreboard', '.dead-ink-scores'],
    ['boss bar', '.dead-ink-boss'], ['round banner', '.dead-ink-banner.show'], ['notify line', '#mission-caption.visible-notice'], ['health', '.mission-vitals'],
    ['magazine', '.mission-weapon'], ['weapon slots', '.hud-hotbar']]) {
    const element = document.querySelector(selector)
    check(element && element.getClientRects().length > 0, `the ${name} is showing`)
    check(!overlaps(mapBox, element.getBoundingClientRect()), `the map clears the ${name}`, JSON.stringify(element.getBoundingClientRect()))
  }
  const round = document.querySelector('.dead-ink-round').getBoundingClientRect()
  check(round.top >= mapBox.bottom && round.left < mapBox.right, 'the round tally sits under the map', `${round.top} vs ${mapBox.bottom}`)
  m.coop.paired = false; m.partnerState = null
  m.timers = {}

  // ---- Redraws: at most 30 a second, and cheap ----------------------------------------------------
  const draw = mm.draw
  let redraws = 0
  mm.draw = function (...args) { redraws++; return draw.apply(this, args) }
  await sleep(1000)
  delete mm.draw
  check(redraws <= 31 && redraws >= 5, 'the map redraws at most 30 times a second', `${redraws} in 1 s`)
  status.redraws = redraws
  const yaw = new cam.rotation.constructor().setFromQuaternion(cam.quaternion, 'YXZ').y
  const t0 = performance.now()
  for (let i = 0; i < 200; i++) mm.draw(p.body.position, yaw + i * 0.01, m, m.parts, [])
  status.drawMs = +((performance.now() - t0) / 200).toFixed(3)

  // ---- The Settings toggle hides it ---------------------------------------------------------------
  const tally = () => document.querySelector('.dead-ink-round').getBoundingClientRect().top
  p.pause()
  await sleep(200)
  document.querySelector('[data-menu-open="settings"]').click()
  const toggle = document.querySelector('#settings-minimap')
  check(toggle && toggle.checked && toggle.getClientRects().length > 0, 'Settings has a Mini map toggle, on')
  toggle.click()
  check(!toggle.checked, 'switched off')
  document.querySelector('[data-menu-back]').click()
  document.querySelector('#walk-start').click()
  await sleep(300)
  check(p.playing && map.hidden && map.getClientRects().length === 0, 'the map is gone in play')
  check(tally() < 40, 'and the round tally is back in the corner', `${tally()}`)
  p.pause()
  await sleep(200)
  document.querySelector('[data-menu-open="settings"]').click()
  toggle.click()
  document.querySelector('[data-menu-back]').click()
  document.querySelector('#walk-start').click()
  await sleep(300)
  check(toggle.checked && !map.hidden && map.getClientRects().length > 0, 'switched back on, it shows again')
  p.pause()
  await sleep(200)
  check(!p.playing && document.querySelector('#mission-hud').hidden, 'paused, the HUD and the map are hidden')
  m.invincible = false
  m.rounds.timer = 5
  return {}
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
