// node scripts/rescue-coop-browser.mjs [page url]: two players on the hostage rescue in one agent-browser
// session, the host in one tab and the guest in a second, paired through the dev server's real relay (/coop).
// Checks pairing and the lobby, both players in the mission, a guard turning on the guest and firing at him,
// the guest's shot killing that guard (the hit marker and the kill are the guest's), a revive, and the escape
// for both; screenshots each in artifacts/rescue-coop/ and writes results.json there.
// Each tab's game is stepped directly, so a tab in the background (which draws nothing) still plays its part.
// Staged, not real input: positions and facing, the guard turned toward the guest, the host kept out of the
// guards' sight, the guest's shots fired through the runtime's shot path, F held through the pad's use flag,
// the guest down through the co-op's own hit, the hostage aboard and the gate open for the escape. Leaving a
// tab would pause its player (blur, visibilitychange), so both tabs are kept from pausing while they play.
// Needs a dev server (npm run dev) and WebGL. RESCUE_COOP_SESSION names the browser session (default rescue);
// the browser closes when the check ends (RESCUE_COOP_KEEP=1 keeps it open).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { runAgentBrowser } from './agent-browser.mjs'

const session = process.env.RESCUE_COOP_SESSION ?? 'rescue'
const page = process.argv[2] ?? 'http://127.0.0.1:5173/'
const directory = 'artifacts/rescue-coop'
mkdirSync(directory, { recursive: true })
const run = (...args) => runAgentBrowser(session, ...args)
/**
 * The first command starts the browser daemon, which keeps the output it inherits open: read through a pipe,
 * the call would wait out its timeout. So it writes to a file. (On Windows set AGENT_BROWSER_CLI to the
 * package's bin/agent-browser.js: npx cannot be started without a shell there.)
 */
const launch = (...args) => {
  const cli = process.env.AGENT_BROWSER_CLI ?? 'npx', log = `${directory}/browser.log`, out = openSync(log, 'w')
  try {
    execFileSync(cli.endsWith('.js') ? process.execPath : cli, [...(cli.endsWith('.js') ? [cli] : cli === 'npx' ? ['agent-browser'] : []), '--session', session, ...args], {
      stdio: ['ignore', out, out], timeout: 180000,
      env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: process.env.AGENT_BROWSER_SOCKET_DIR ?? '/tmp/stickman-browser' },
    })
  } finally { closeSync(out) }
  return readFileSync(log, 'utf8').trim()
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const check = (ok, label, detail = '') => {
  results.push({ passed: !!ok, label, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`)
  assert(ok, `${label} ${detail}`)
}
const host = 't1', guest = 't2'
let active = host

/** Run JavaScript in the active tab; the value comes back parsed. */
const evaluate = code => {
  const out = run('eval', '-b', Buffer.from(code).toString('base64'))
  return out === '' || out === 'undefined' ? undefined : JSON.parse(out)
}
/** Bring a tab to the front. A tab that should be playing (window.__play) plays again if anything paused it. */
const show = tab => {
  if (active === tab) return
  run('tab', tab)
  active = tab
  evaluate(`(() => { const p = window.__environment?.player; if (p && window.__play && !p.playing) { p.fallback = true; p.resume() } return true })()`)
}
/** Run a function body in a tab (with e, m, p and V: the environment, mission, player and Vector3). */
const inTab = (tab, body) => {
  show(tab)
  return evaluate(`(() => { const e = window.__environment, m = e.mission, p = e.player, V = e.camera.perspective.position.constructor; ${body} })()`)
}
/** Step a tab's game `seconds` at 60 fps, straight through its update. */
const step = (tab, seconds) => inTab(tab, `for (let i = 0; i < ${Math.round(seconds * 60)}; i++) m.update(1 / 60); return true`)
/** Poll a tab until a function body returns an object with `done` set (`raw`: a whole expression, for a page still loading). */
const until = async (tab, body, tries = 40, raw = false) => {
  let last = null
  for (let i = 0; i < tries; i++) {
    try { last = raw ? (show(tab), evaluate(body)) : inTab(tab, body) } catch (error) { last = { error: String(error).slice(0, 200) } }
    if (last?.done) return last
    await wait(250)
  }
  return last
}
const shot = async (tab, name, delay = 500) => {
  show(tab)
  await wait(delay)
  run('screenshot', `${directory}/${name}.png`)
}
/** A freshly loaded tab: no pausing when another tab comes to the front. */
const steady = `window.removeEventListener('blur', p.pause); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); p.fallback = true`
const loading = extra => `(() => { const m = window.__environment?.mission
  return { done: m?.ready === true${extra}, ready: m?.ready ?? null, status: m?.coop?.status.kind ?? null, placed: m?.coop?.placed ?? null, page: document.readyState,
    environment: !!window.__environment, error: document.querySelector('#mission-debrief')?.textContent || '', text: document.body?.innerText.slice(0, 160) ?? '' } })()`

try {
  // ---- The host opens a room from the menu's Co-op page.
  console.log(launch('open', page))
  const loaded = await until(host, loading(''), 240, true)
  check(loaded?.done, 'the host\'s page loads', JSON.stringify(loaded))
  inTab(host, `${steady}; m.invincible = true; Object.defineProperty(m.coop, 'name', { get: () => 'Anna' })
    document.querySelector('[data-menu-open="coop"]').click(); document.querySelector('.coop-invite').click(); return true`)
  const room = await until(host, `return { done: m.coop.status.kind === 'waiting', link: m.coop.link.link }`)
  check(room?.done && room.link.includes('join=') && !room.link.includes('mode='), 'the invite link opens the hostage rescue', room?.link)

  // ---- The guest opens the link in a second tab: it joins once its mission has loaded, on the Co-op page.
  run('tab', 'new', room.link)
  active = guest
  const joining = await until(guest, loading(' && window.__environment.mission.coop.paired && window.__environment.mission.coop.placed'), 240, true)
  check(joining?.done, 'the second tab loads and pairs', JSON.stringify(joining))
  const joined = inTab(guest, `${steady}; Object.defineProperty(m.coop, 'name', { get: () => 'Ben' })
    return { role: m.coop.link.role, id: m.coop.link.id, page: document.querySelector('.walk-card').dataset.page, at: p.body.position.toArray() }`)
  check(joined.role === 'guest' && joined.id === 1, 'the second tab joined as guest 1', JSON.stringify(joined))
  check(joined.page === 'coop', 'the invite opened on the Co-op page')
  const spawn = inTab(host, 'return p.body.position.toArray()')
  const apart = Math.hypot(joined.at[0] - spawn[0], joined.at[2] - spawn[2])
  check(apart > 0.8 && apart < 2, 'the guest starts beside the host, not inside him', `${apart.toFixed(2)} m`)
  step(guest, 0.5)
  const lobby = await until(host, `for (let i = 0; i < 10; i++) m.update(1 / 60)
    const names = [...document.querySelectorAll('.coop-players li')].map(li => li.textContent)
    return { done: names.some(name => name.includes('Anna')) && names.some(name => name.includes('Ben')), role: m.coop.link.role, names,
      start: document.querySelector('.coop-start')?.textContent }`)
  check(lobby?.done && lobby.role === 'host' && lobby.start === 'Start', 'the host\'s lobby lists both players, with Start', lobby?.names.join(' | '))
  const guestLobby = inTab(guest, `for (let i = 0; i < 10; i++) m.update(1 / 60)
    return { names: [...document.querySelectorAll('.coop-players li')].map(li => li.textContent), start: document.querySelector('.coop-start')?.textContent }`)
  check(guestLobby.start === 'Jump in' && guestLobby.names.some(name => name.includes('Anna (host)')), 'the guest\'s lobby shows the host, with Jump in', guestLobby.names.join(' | '))
  await shot(host, 'lobby')

  // ---- Start and Jump in: both in the mission.
  const started = inTab(host, `document.querySelector('.coop-start').click(); window.__play = true; return { playing: p.playing, begun: m.coop.begun }`)
  check(started.playing && started.begun, 'the host starts the mission', JSON.stringify(started))
  const jumped = inTab(guest, `document.querySelector('.coop-start').click(); window.__play = true; for (let i = 0; i < 20; i++) m.update(1 / 60)
    return { playing: p.playing, phase: m.state.phase }`)
  check(jumped.playing && jumped.phase === 'active', 'the guest jumps in', JSON.stringify(jumped))
  step(host, 0.3)
  const facing = inTab(guest, `const mate = m.coop.mates.get(0); if (!mate?.avatar.actor) return { mate: !!mate }
    p.body.teleport(mate.avatar.feet.clone().add(new V(-4, 0, 1.5))); p.actions.syncCamera(e.camera.perspective)
    e.camera.perspective.lookAt(mate.avatar.feet.clone().add(new V(0, 1.2, 0)))
    for (let i = 0; i < 20; i++) m.update(1 / 60)
    const tag = [...document.querySelectorAll('.coop-tag')].find(tag => !tag.hidden)
    return { mate: true, name: mate.state?.name, visible: mate.avatar.actor.root.visible, tag: tag?.textContent, color: mate.avatar.actor.rig.mesh.material.color.getHexString() }`)
  check(facing.mate && facing.name === 'Anna' && facing.visible && facing.tag === 'Anna' && facing.color === '2878d0',
    'the guest sees the host\'s blue stickman under his name', JSON.stringify(facing))
  step(host, 0.3)
  const seen = inTab(host, `const mate = m.coop.mates.get(1)
    return { name: mate?.state?.name, visible: !!mate?.avatar.actor?.root.visible, color: mate?.avatar.actor?.rig.mesh.material.color.getHexString() }`)
  check(seen.name === 'Ben' && seen.visible && seen.color === '2e9b45', 'the host sees the guest\'s green stickman', JSON.stringify(seen))
  await shot(guest, 'two-players')

  // ---- A guard turns on the guest: the guest stands nine metres in front of a patrol guard, in his clear view;
  // the host is kept out of the guards' sight.
  const setup = inTab(host, `const index = m.ai.enemies.findIndex(enemy => enemy.spec.id === 'yard-patrol' && enemy.state !== 'dead')
    const guard = m.ai.enemies[index], eye = guard.position.clone().add(new V(0, 1.5, 0)), world = p.world
    m.coop.hostVisible = () => false
    for (let i = 0; i < 16; i++) {
      const a = guard.yaw + i * Math.PI / 8, spot = guard.position.clone().add(new V(Math.sin(a) * 9, 0, Math.cos(a) * 9))
      const floor = world.floor(spot.clone().setY(spot.y + 1), 1.5, 3)
      if (!Number.isFinite(floor) || Math.abs(floor - guard.position.y) > 0.3) continue
      spot.y = floor
      if (!world.visible(eye, spot.clone().add(new V(0, 1.6, 0)), guard.actor.root)) continue
      guard.yaw = a; guard.actor.root.rotation.y = a
      return { index, at: guard.position.toArray(), spot: spot.toArray() }
    }
    return { index, at: guard.position.toArray(), spot: null }`)
  check(setup.index >= 0 && setup.spot, 'a guard with open ground in front of him', JSON.stringify(setup))
  inTab(guest, `window.__heard = []; const play = m.audio.play.bind(m.audio); m.audio.play = event => { window.__heard.push(event.kind); return play(event) }
    window.__hurts = 0; const damage = m.damage.bind(m); m.damage = (amount, ...rest) => { if (amount > 0) window.__hurts++; return damage(amount, ...rest) }
    m.invincible = true
    p.body.teleport(new V(${setup.spot.join(',')})); p.actions.syncCamera(e.camera.perspective)
    e.camera.perspective.lookAt(new V(${setup.at[0]}, ${setup.at[1] + 1.4}, ${setup.at[2]}))
    for (let i = 0; i < 20; i++) m.update(1 / 60); return true`)
  step(host, 2.5)
  const targeting = inTab(host, `const guard = m.ai.enemies[${setup.index}]; return { target: guard.target, state: guard.state, canSee: guard.canSee, shots: guard.shots }`)
  check(targeting.target === 1 && targeting.state === 'combat', 'a guard on the host turns on the guest', JSON.stringify(targeting))
  const puppet = inTab(guest, `for (let i = 0; i < 30; i++) m.update(1 / 60)
    const guard = m.ai.enemies[${setup.index}]
    return { state: guard.state, aiming: guard.canSee, reports: window.__heard.filter(kind => kind.startsWith('enemy-shot')).length, hurts: window.__hurts }`)
  check(puppet.state === 'combat' && puppet.aiming, 'the guest sees that guard aim at him', JSON.stringify(puppet))
  check(puppet.reports > 0 || targeting.shots === 0, 'the guest hears the guard\'s gunfire', `${puppet.reports} reports for ${targeting.shots} rounds`)
  await shot(guest, 'guard-targets-guest')

  // ---- The guest's rounds kill that guard; the hit marker and the kill are the guest's.
  // Each marker as it comes: the crosshair's flash, and which guard the host says was hit.
  const before = inTab(guest, `window.__markers = []; const confirm = m.audio.confirmHit.bind(m.audio)
    m.audio.confirmHit = hit => { window.__markers.push({ flash: m.hitFlash, crosshair: document.querySelector('.crosshair').classList.contains('confirmed-hit'), lethal: hit.lethal }); return confirm(hit) }
    window.__reacts = []; const puppets = m.coop.puppets, react = puppets.react.bind(puppets)
    puppets.react = (index, clip, lethal, ...rest) => { window.__reacts.push([index, clip, lethal]); return react(index, clip, lethal, ...rest) }
    return { kills: m.state.kills }`)
  let after = null
  for (let i = 0; i < 24; i++) {
    if (i % 4 === 0) inTab(guest, `const guard = m.ai.enemies[${setup.index}], eye = e.camera.perspective.position.clone()
      const chest = guard.actor.rig.bones.chest.getWorldPosition(new V())
      m.shot({ origin: eye, direction: chest.sub(eye).normalize(), range: 220, damage: 65, weapon: 'sniper' }); return true`)
    await wait(150)
    after = inTab(guest, `for (let i = 0; i < 6; i++) m.update(1 / 60)
      return { kills: m.state.kills, markers: window.__markers, reacts: window.__reacts, puppet: m.ai.enemies[${setup.index}].state }`)
    if (after.kills > before.kills) break
  }
  after = inTab(guest, `for (let i = 0; i < 30; i++) m.update(1 / 60)
    return { kills: m.state.kills, markers: window.__markers, reacts: window.__reacts, puppet: m.ai.enemies[${setup.index}].state }`)
  check(after.kills === before.kills + 1, 'the guest\'s shot kills the guard, and the kill is the guest\'s', JSON.stringify(after))
  check(after.markers.length > 0 && after.markers.every(marker => marker.flash > 0) && after.markers.at(-1).lethal, 'with the guest\'s hit marker for each round')
  check(after.puppet === 'dead', 'the guard falls on the guest\'s screen, and stays down')
  await shot(guest, 'guest-kill')
  const hostKill = inTab(host, `delete m.coop.hostVisible; return { dead: m.ai.enemies[${setup.index}].state, kills: m.state.kills }`)
  check(hostKill.dead === 'dead' && hostKill.kills === 0, 'dead on the host, and not the host\'s kill', JSON.stringify(hostKill))

  // ---- A revive: the guest goes down; the host comes over and holds F.
  const down = inTab(guest, `m.coop.takeHit(200); m.coop.goDown(); for (let i = 0; i < 40; i++) m.update(1 / 60)
    return { down: m.coop.stand.down, weapon: m.weapons.current?.name, crawling: p.crawling }`)
  check(down.down === 1 && down.weapon === 'pistol' && down.crawling, 'the guest goes down into a last stand with a pistol', JSON.stringify(down))
  step(host, 0.3)
  const kneel = inTab(host, `const mate = m.coop.mates.get(1), feet = mate.avatar.feet.clone()
    p.body.teleport(feet.clone().add(new V(1.1, 0, 0.7))); p.actions.syncCamera(e.camera.perspective)
    e.camera.perspective.lookAt(feet.clone().add(new V(0, 0.3, 0)))
    for (let i = 0; i < 10; i++) m.update(1 / 60)
    const [target] = m.coop.reviveTargets(); if (!target) return { prompt: null, down: mate.state?.dn }
    target.use(); p.padUse = true
    for (let i = 0; i < 90; i++) m.update(1 / 60)
    return { prompt: target.label, down: mate.state?.dn, pose: mate.avatar.poses.phase, reviving: m.coop.hold.active, fraction: m.coop.hold.fraction,
      bar: document.querySelector('.coop-stand span')?.textContent }`)
  check(kneel.prompt === 'Hold to revive Ben' && kneel.reviving && kneel.bar === 'Reviving Ben', 'the host holds F over the downed guest', JSON.stringify(kneel))
  await shot(host, 'revive')
  const held = inTab(host, 'for (let i = 0; i < 120; i++) m.update(1 / 60); p.padUse = false; return { reviving: m.coop.hold.active }')
  check(!held.reviving, 'the revive runs its full time')
  const up = await until(guest, 'for (let i = 0; i < 6; i++) m.update(1 / 60); return { done: m.coop.stand.down === 0, down: m.coop.stand.down, health: m.state.health, weapon: m.weapons.current?.name }')
  check(up?.done && up.health === 50, 'the guest is back up with half health and his guns', JSON.stringify(up))

  // ---- The guest frees the hostage: the cell's F prompt goes through the host, and the hostage follows the guest
  // (the guards are kept from seeing anyone here, so no gunfire makes him cower).
  inTab(host, 'm.coop.senses = () => []; m.coop.hostVisible = () => false; return true')
  const cell = inTab(guest, `window.__notes = []; const notify = m.hud.notify.bind(m.hud); m.hud.notify = (text, ...rest) => { window.__notes.push(text); return notify(text, ...rest) }
    const station = m.world.stations.find(station => station.kind === 'hostage'), cam = e.camera.perspective; let stood = null
    for (let i = 0; i < 24 && !stood; i++) {
      const a = i * Math.PI / 12, spot = new V(station.point.x + Math.sin(a) * 1.6, station.point.y, station.point.z + Math.cos(a) * 1.6)
      const floor = p.world.floor(spot.clone().setY(spot.y + 0.5), 1, 3); if (!Number.isFinite(floor)) continue
      spot.y = floor; p.body.teleport(spot); for (let k = 0; k < 30; k++) p.update(1 / 60)
      p.actions.syncCamera(cam); cam.lookAt(station.point)
      if (Math.abs(p.body.position.y - floor) < 0.3 && cam.position.distanceTo(station.point) < 2.5 && p.world.visible(cam.position, station.point, station.object)) stood = p.body.position.toArray()
    }
    for (let i = 0; i < 10; i++) m.update(1 / 60)
    const label = m.targets().find(target => target.object === station.object)?.label, used = m.use(station)
    for (let i = 0; i < 10; i++) m.update(1 / 60)
    return { stood, label, used }`)
  check(cell.stood && cell.used, 'the guest uses the cell lock', JSON.stringify(cell))
  const freed = inTab(host, `for (let i = 0; i < 30; i++) m.update(1 / 60); const hostage = m.state.hostages[0]; return { status: hostage.status, by: hostage.by }`)
  check(freed.status === 'following' && freed.by === 1, 'the host frees the hostage, freed by the guest', JSON.stringify(freed))
  const told = inTab(guest, `for (let i = 0; i < 10; i++) m.update(1 / 60)
    return { status: m.state.hostages[0].status, notes: window.__notes.filter(note => note.startsWith('Cell unlocked')) }`)
  check(told.status === 'following' && told.notes.length > 0, 'the guest sees him freed and hears how it went', JSON.stringify(told))
  // The guest goes on ahead, up the detention stairs; the host is far away at the insertion point.
  const start = inTab(guest, `p.body.teleport(new V(117, 0.12, -6)); p.actions.syncCamera(e.camera.perspective); for (let i = 0; i < 20; i++) m.update(1 / 60)
    return m.state.hostages[0].position`)
  const followed = inTab(host, `for (let i = 0; i < 480; i++) m.update(1 / 60); const hostage = m.state.hostages[0]
    return { from: ${JSON.stringify(start)}, at: hostage.position, moved: Math.hypot(hostage.position[0] - ${start[0]}, hostage.position[2] - ${start[2]}), host: p.body.position.toArray() }`)
  check(followed.moved > 3 && followed.at[2] > start[2], 'the hostage follows the guest who freed him, not the host far behind', JSON.stringify(followed))
  const drawn = inTab(guest, `for (let i = 0; i < 30; i++) m.update(1 / 60); const actor = m.escort.actors[0]
    return { at: actor.root.position.toArray(), status: m.state.hostages[0].status }`)
  check(Math.hypot(drawn.at[0] - followed.at[0], drawn.at[2] - followed.at[2]) < 1.5, 'and the guest sees him where the host has him', JSON.stringify(drawn))
  inTab(host, 'delete m.coop.senses; delete m.coop.hostVisible; return true')

  // The hostage aboard and the exit gate open, at once (the gate swung fully open here, not over a second or two).
  const aboard = `m.state.hostages.forEach(hostage => { hostage.status = 'loaded' }); m.state.gateOpen = true; m.syncWorld(true)`
  const gate = `const hinge = m.world.rescue.gate.children.find(child => child.userData.doorHinge); if (hinge) hinge.rotation.y = -Math.PI / 2; p.world.refresh()`
  const jeep = `const jeep = m.world.stations.find(station => station.kind === 'jeep')`
  /** Stand beside the jeep, on the ground (the body's own physics settles it) and within reach of its prompt, looking at it. */
  const atJeep = (first = 0) => `${jeep}; const cam = e.camera.perspective; let stood = null
    for (let i = ${first}; i < ${first} + 24 && !stood; i++) {
      const a = i * Math.PI / 12, spot = new V(jeep.point.x + Math.sin(a) * 1.9, 0.05, jeep.point.z + Math.cos(a) * 1.9)
      p.body.teleport(spot); for (let k = 0; k < 30; k++) p.update(1 / 60)
      p.actions.syncCamera(cam); cam.lookAt(jeep.point)
      if (p.body.position.y < 0.4 && cam.position.distanceTo(jeep.point) < 2.5 && p.world.visible(cam.position, jeep.point, jeep.object)) stood = p.body.position.toArray()
    }`
  /** Press the start button (Begin or Resume mission) and play on. */
  const play = `document.querySelector('#walk-start').click(); window.__play = true`

  // ---- The escape, the host's call: the guest is far off; the host says go and takes him along.
  inTab(guest, 'window.__play = false; return true')
  const escape = inTab(host, `window.__play = false; ${aboard}; ${gate}; ${atJeep()}
    for (let i = 0; i < 10; i++) m.update(1 / 60)
    const label = m.coop.jeepLabel(), used = m.use(jeep); return { label, used, stood, escape: m.escape.active }`)
  check(escape.escape && escape.label === 'Leave now · everyone rides along', 'the host leaves in the jeep and takes the guest along', JSON.stringify(escape))
  // The cinematic also runs on the tab's own frames (real time): about half a second in, the jeep is on its way.
  step(host, 0.3)
  await shot(host, 'escape-host', 100)
  // A tab in the background catches up at once when it comes to the front: the guest's ride is over by then.
  const ride = await until(guest, 'for (let i = 0; i < 30; i++) m.update(1 / 60); return { done: m.state.phase === "complete", escape: m.escape.active, jeep: m.state.jeep }')
  check(ride?.done && ride.escape, 'the guest rides out too, and the rescue is complete for him', JSON.stringify(ride))

  // ---- Starting over from the win: the host's Restart takes the guest back to the insertion point too.
  const again = inTab(host, `for (let i = 0; i < 150; i++) m.update(1 / 60); const phase = m.state.phase
    document.querySelector('#mission-restart').click(); return { was: phase, phase: m.state.phase, playing: p.playing }`)
  check(again.was === 'complete' && again.phase === 'active', 'the host starts the mission over from the win', JSON.stringify(again))
  const back = await until(guest, `for (let i = 0; i < 6; i++) m.update(1 / 60)
    return { done: m.state.phase === 'active' && !m.escape.active && m.state.hostages[0].status === 'captive', phase: m.state.phase, at: p.body.position.toArray(), dead: m.ai.enemies[${setup.index}].state }`)
  check(back?.done && Math.hypot(back.at[0] - spawn[0], back.at[2] - spawn[2]) < 2 && back.dead !== 'dead',
    'the guest starts over beside the host, the guard he shot back on his feet', JSON.stringify(back))

  // ---- Everyone down: the mission is lost for both; the guest asks for another go and the host takes everyone back.
  inTab(host, `${play}; for (let i = 0; i < 10; i++) m.update(1 / 60); return true`)
  inTab(guest, `${play}; for (let i = 0; i < 10; i++) m.update(1 / 60); m.coop.takeHit(200); m.coop.goDown(); window.__play = false
    for (let i = 0; i < 20; i++) m.update(1 / 60); return true`)
  const lost = inTab(host, `m.coop.takeHit(200); m.coop.goDown(); window.__play = false; for (let i = 0; i < 30; i++) m.update(1 / 60)
    return { phase: m.state.phase, dying: m.death.active }`)
  check(lost.phase === 'dead' && lost.dying, 'with everyone down the host loses the mission', JSON.stringify(lost))
  const failed = await until(guest, `for (let i = 0; i < 30; i++) m.update(1 / 60)
    return { done: m.state.phase === 'dead' && document.body.dataset.death === 'menu' && !document.querySelector('#mission-retry').hidden, phase: m.state.phase }`)
  check(failed?.done, 'and so does the guest, who gets Try again', JSON.stringify(failed))
  await shot(guest, 'mission-lost', 1200)
  const asked = inTab(guest, `document.querySelector('#mission-retry').click(); return { phase: m.state.phase }`)
  check(asked.phase === 'dead', 'the guest\'s Try again asks the host (only the host starts the mission over)')
  const retried = await until(guest, `for (let i = 0; i < 6; i++) m.update(1 / 60)
    return { done: m.state.phase === 'active' && m.coop.stand.down === 0 && m.state.health === 100, phase: m.state.phase, down: m.coop.stand.down, health: m.state.health }`)
  check(retried?.done, 'the host takes everyone back to the insertion point', JSON.stringify(retried))
  const hostBack = inTab(host, `return { phase: m.state.phase, down: m.coop.stand.down, health: m.state.health }`)
  check(hostBack.phase === 'active' && hostBack.down === 0 && hostBack.health === 100, 'the host is up again too', JSON.stringify(hostBack))

  // ---- The escape, everyone aboard: both players at the jeep, the guest boards and the jeep leaves for both.
  inTab(host, `${play}; ${aboard}; ${gate}; ${atJeep(6)}; for (let i = 0; i < 30; i++) m.update(1 / 60); return true`)
  inTab(guest, `${play}; for (let i = 0; i < 10; i++) m.update(1 / 60); ${atJeep()}; for (let i = 0; i < 20; i++) m.update(1 / 60); return stood`)
  // Here the gate opens as it does in play: the host's state says open, and it swings open over three seconds.
  const opened = await until(guest, `const gate = m.world.rescue.gate, hinge = gate.children.find(child => child.userData.doorHinge)
    return { done: !!gate.userData.open && Math.abs(hinge.rotation.y + Math.PI / 2) < 1e-6, angle: hinge.rotation.y }`)
  check(opened?.done, 'the exit gate swings open on the guest\'s screen', JSON.stringify(opened))
  step(host, 0.3)
  const board = inTab(guest, `${jeep}; for (let i = 0; i < 10; i++) m.update(1 / 60)
    const eye = e.camera.perspective.position, why = { active: m.isActive(), at: p.body.position.toArray().map(n => +n.toFixed(2)), reach: +eye.distanceTo(jeep.point).toFixed(2),
      seen: p.world.visible(eye, jeep.point, jeep.object), opening: m.gateOpening() }
    const label = m.coop.jeepLabel(), hostage = m.state.hostages[0].status, used = m.use(jeep); return { label, hostage, used, why }`)
  check(board.label === 'Board jeep' && board.used, 'with everyone at the jeep the guest can board', JSON.stringify(board))
  const leaving = await until(guest, 'return { done: m.escape.active, jeep: m.state.jeep }')
  check(leaving?.done, 'the host sends the jeep off for everyone', JSON.stringify(leaving))
  await shot(guest, 'escape-guest', 450)
  const hostRide = inTab(host, 'for (let i = 0; i < 30; i++) m.update(1 / 60); return { escape: m.escape.active, phase: m.state.phase }')
  check(hostRide.escape, 'the host rides out too', JSON.stringify(hostRide))
} finally {
  writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2) + '\n')
  const failed = results.some(result => !result.passed)
  for (const tab of [host, guest]) {
    try {
      run('tab', tab)
      console.log(`errors in ${tab}:`, run('errors') || 'none')
      if (failed) console.log(`console of ${tab}:`, run('console').split('\n').slice(-15).join('\n'))
    } catch { /* the browser may be gone */ }
  }
  // One browser at a time on a shared machine: close it as soon as the check is done.
  if (!process.env.RESCUE_COOP_KEEP) try { run('close') } catch { /* already closed */ }
}
