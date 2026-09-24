// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-weapons.js
// Starts in the page and returns at once; poll window.__weaponsCheck for { done, results, error? }.
// Dead Ink's weapons in the real game: a frag dropped on a pack kills it on round 3 and leaves crawlers on
// round 8; the Ink Rocket taken from the Mystery Box flies, bursts, reloads itself, hurts you point blank
// and becomes the Press Ram; the Magnum becomes the Deadline, two guns firing in turn, rounds that burst.
// Staged: the pack is held still (a long stagger) so the blast meets it where it was placed, the player is
// invincible except where self-damage is measured, the box's landing gun is set to the launcher, and the
// gore dice are seeded so the round 8 frag is repeatable.
(() => {
const results = []
const status = window.__weaponsCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const pressKey = code => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.replace(/Key|Digit/, '').toLowerCase(), code, bubbles: true, cancelable: true }))
  const health = round => round < 10 ? 150 + 100 * (round - 1) : Math.floor(950 * 1.1 ** (round - 9))
  const seeded = seed => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  const sounds = []
  const emit = m.emit.bind(m)
  m.emit = event => { sounds.push(event.kind); return emit(event) }
  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  await sleep(300)
  m.rounds.timer = 9999; m.rounds.phase = 'break'
  for (const gate of m.zones?.gates ?? []) if (gate.state === 'closed') m.zones.open(gate)

  // Stand in the yard facing down an open line, with a patch of level yard out along it for the pack: every
  // spot of the ring on level floor in clear view of its middle (the yard has junk lying about).
  const home = new V(-30, 0.05, -25)
  p.body.teleport(home.clone()); p.actions.syncCamera(cam)
  const RING = [[0.8, 0.3], [1.2, 2.4], [2.0, 4.1], [2.4, 5.5], [3.6, 1.1], [4.2, 3.0], [4.6, 4.8], [5.1, 0.2]]
  const lines = []
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2, dir = new V(-Math.sin(a), 0, -Math.cos(a))
    lines.push([p.world.raySurface(cam.position.clone(), dir, 60)?.distance ?? 60, a])
  }
  lines.sort((a, b) => b[0] - a[0])
  let centre = null, yaw = 0, open = 0
  for (const [length, a] of lines) {
    if (length < 20 || centre) continue
    const along = new V(-Math.sin(a), 0, -Math.cos(a))
    for (let d = 8; d <= Math.min(14, length - 7) && !centre; d += 0.5) {
      const at = home.clone().addScaledVector(along, d)
      const floor = p.world.floor(at.clone().setY(at.y + 0.6), 1, 1.5)
      if (!Number.isFinite(floor)) continue
      at.y = floor
      const clear = RING.every(([r, b]) => {
        const spot = at.clone().add(new V(Math.cos(b) * r, 0, Math.sin(b) * r))
        const ground = p.world.floor(spot.clone().setY(floor + 0.6), 1, 1.5)
        return Number.isFinite(ground) && Math.abs(ground - floor) < 0.08 && p.world.visible(at.clone().setY(floor + 0.46), spot.setY(floor + 1.1), cam)
      })
      if (clear) { centre = at; yaw = a; open = length }
    }
  }
  check(!!centre, 'a patch of level, open yard for the pack', centre ? `${home.distanceTo(centre).toFixed(1)} m out along a ${open.toFixed(0)} m line` : 'none')
  const ahead = new V(-Math.sin(yaw), 0, -Math.cos(yaw))
  const face = () => { p.body.teleport(home.clone()); p.actions.syncCamera(cam); cam.rotation.set(0, yaw, 0, 'YXZ'); e.invalidate() }
  face()
  const pack = (round, ring = RING, at = centre) => {
    m.director.clear()
    const zombies = ring.map(([d, a]) => m.director.spawn(at.clone().add(new V(Math.cos(a) * d, 0, Math.sin(a) * d)), health(round), 'walk', 0))
    for (const z of zombies) if (z) z.stagger = 999
    return zombies
  }
  // A frag dropped from just above the pack's middle: it falls, settles and goes off on its fuse.
  const dropFrag = async () => {
    m.grenades.throw(centre.clone().setY(centre.y + 1.2), new V(0, -1, 0))
    return until(() => m.grenades.count === 0, 5000)
  }

  // ---- 1. The frag: round 3 a pack dies, round 8 the edge lives and crawls ------------------------------
  m.rounds.round = 3
  let zombies = pack(3)
  check(zombies.every(Boolean), 'a pack of eight on the yard')
  await sleep(300)
  const kills = m.state.kills
  check(await dropFrag(), 'the frag goes off')
  await sleep(100)
  check(zombies.every(z => z.state === 'dead'), 'round 3: a frag kills the whole pack', zombies.map(z => z.state).join(','))
  check(m.state.kills === kills + 8, 'eight kills counted', `${m.state.kills - kills}`)
  check(sounds.includes('grenade-blast'), 'with the frag\'s boom')
  await sleep(1500)
  m.rounds.round = 8
  m.director.random = seeded(20260924)
  zombies = pack(8)
  await sleep(300)
  check(await dropFrag(), 'the second frag goes off')
  await sleep(100)
  const inner = zombies.slice(0, 4), outer = zombies.slice(4)
  const crawlers = outer.filter(z => z.state === 'chase' && z.crawler)
  check(inner.every(z => z.state === 'dead'), 'round 8: the frag kills the middle of the pack', inner.map(z => z.state).join(','))
  check(outer.every(z => z.state === 'chase'), 'round 8: the edge lives', outer.map(z => `${z.state} ${z.health}`).join(','))
  check(crawlers.length >= 1, 'round 8: and some of it crawls', `${crawlers.length} of 4 crawling`)
  m.director.random = Math.random
  status.crawlers = crawlers.length
  // Let go of them: the crawlers come for you.
  for (const z of crawlers) z.stagger = 0
  const gap = z => Math.hypot(z.position.x - p.body.position.x, z.position.z - p.body.position.z)
  const start = crawlers.map(gap)
  await sleep(3000)
  check(crawlers.every((z, i) => z.state === 'chase' && gap(z) < start[i] - 2), 'the crawlers crawl toward you', crawlers.map((z, i) => `${start[i].toFixed(1)} -> ${gap(z).toFixed(1)}`).join(', '))
  m.director.clear()

  // ---- 2. The Ink Rocket from the Mystery Box --------------------------------------------------------
  const box = m.box
  m.state.points = 5000
  p.body.teleport(box.spot.stand.clone()); p.actions.syncCamera(cam); cam.lookAt(box.point); e.invalidate()
  await sleep(400)
  pressKey('KeyF')
  check(await until(() => box.state === 'spinning', 1500), 'the box spins for 950', `${box.state} ${m.state.points}`)
  box.offer = { name: 'rocket', rarity: 'rare' }
  check(await until(() => box.state === 'offering', 8000), 'and lands', box.state)
  const label = p.actions.findTarget(cam)?.label ?? 'none'
  check(/Ink Rocket/.test(label), 'it offers the Ink Rocket', label)
  pressKey('KeyF')
  await sleep(700)
  let held = m.weapons.current
  check(held?.name === 'rocket' && held.magazine === 1 && held.reserve === 10, 'taken: one in the tube, ten spare', JSON.stringify(held))
  check([...document.querySelectorAll('.hud-slot-name')].some(n => n.textContent === 'Ink Rocket'), 'the hotbar calls it the Ink Rocket')
  const warhead = m.weapons.heldModel?.userData.parts.warhead
  check(warhead?.visible, 'its warhead sits in the mouth of the tube')

  // Fired at a round-10 pack: it flies, bursts on the first zombie, and the pack is gone.
  face(); await sleep(300)
  m.rounds.round = 10
  zombies = pack(10, RING.slice(0, 7))
  await sleep(300)
  cam.lookAt(zombies[0].actor.rig.bones.chest.getWorldPosition(new V())); e.invalidate()
  sounds.length = 0
  const before = m.state.kills
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  check(await until(() => m.rockets.count === 1, 500), 'a rocket leaves the tube', `${m.rockets.count}`)
  check(!warhead.visible, 'the tube is empty')
  const launched = m.rockets.inFlight[0].position.clone()
  let far = 0, puffs = 0, frames = 0
  const t0 = performance.now()
  while (m.rockets.count && performance.now() - t0 < 3000) {
    far = Math.max(far, m.rockets.inFlight[0].position.distanceTo(launched)); puffs = Math.max(puffs, m.rockets.trailPuffs); frames++
    await sleep(8)
  }
  check(m.rockets.count === 0, 'it bursts')
  check(far > 2 && frames > 2, 'it flies, fast but seen', `${far.toFixed(1)} m seen in flight over ${frames} polls`)
  check(puffs > 3, 'with an ink smoke trail', `${puffs} puffs`)
  await sleep(100)
  check(zombies.every(z => z.state === 'dead'), 'round 10: a rocket kills the whole pack', zombies.map(z => z.state).join(','))
  check(m.state.kills === before + 7, 'seven kills counted', `${m.state.kills - before}`)
  check(sounds.includes('shot-rocket') && sounds.includes('rocket-boom'), 'its own launch and boom', sounds.filter(k => /rocket/.test(k)).join(','))
  check(await until(() => m.weapons.reloading, 1500), 'it reloads by itself')
  check(await until(() => !m.weapons.reloading && m.weapons.current.magazine === 1, 4000), 'and is loaded again', JSON.stringify(m.weapons.current))
  check(m.weapons.current.reserve === 9 && warhead.visible, 'a fresh warhead in the mouth, nine spare')

  // Point blank at the floor: it hurts.
  m.director.clear()
  m.invincible = false
  m.state.health = 100
  face()
  cam.rotation.set(-1.45, yaw, 0, 'YXZ'); e.invalidate()
  await sleep(200)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  check(await until(() => m.rockets.count === 0 && sounds.filter(k => k === 'rocket-boom').length >= 2, 1500), 'a rocket into your own feet goes off')
  const hurt = 100 - m.state.health
  m.invincible = true
  check(hurt >= 30 && m.state.phase === 'active', 'and hurts you', `${hurt} damage`)
  await sleep(400)
  m.state.health = 100

  // The Pack-a-Punch makes it the Press Ram: two to a load, a bigger blast, red smoke.
  m.setPower(true); m.completeBuild('pack')
  m.state.points = 20000
  const machine = m.pack
  const upgrade = async () => {
    p.body.teleport(machine.spot.stand.clone()); p.actions.syncCamera(cam); cam.lookAt(machine.point); e.invalidate()
    await sleep(400)
    pressKey('KeyF')
    await sleep(300)
    const took = machine.state === 'working'
    await until(() => machine.state === 'ready', 6000)
    pressKey('KeyF')
    await sleep(800)
    return took
  }
  check(await upgrade(), 'the Pack-a-Punch takes the launcher')
  held = m.weapons.current
  check(held?.name === 'rocket' && held.packed && held.magazine === 2 && held.reserve === 16, 'out comes the Press Ram: two loaded, sixteen spare', JSON.stringify(held))
  check([...document.querySelectorAll('.hud-slot-name')].some(n => n.textContent === 'Press Ram'), 'the hotbar calls it the Press Ram')
  face(); await sleep(300)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  check(await until(() => m.rockets.count === 1, 500), 'the Press Ram fires')
  check(m.rockets.inFlight[0].packed, 'a Press Ram rocket')
  const named = name => { let found = null; m.scene.traverse(o => { if (o.name === name) found = o }); return found }
  check(named('Rocket flame')?.material.color.getHex() === 0xd4332a, 'its flame burns red, as upgraded shots do')
  await sleep(150)
  check(named('Press Ram trail')?.count > 0 && named('Ink Rocket trail')?.count === 0, 'and its smoke trail is tinted red', `${named('Press Ram trail')?.count} red puffs`)
  await sleep(900)
  check(!m.weapons.reloading && m.weapons.current.magazine === 1, 'with one still loaded after the first', JSON.stringify(m.weapons.current))
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  check(await until(() => m.weapons.current.magazine === 0, 1500), 'and fires a second without a reload')
  await until(() => m.rockets.count === 0, 4000)

  // ---- 3. The Deadline: the Magnum Pack-a-Punched is two, firing in turn, rounds that burst ---------------
  m.weapons.restore({ slots: [{ id: 'magnum-test', name: 'magnum', magazine: 6, reserve: 24 }, null], selected: 0, pickups: [], nextId: 9 })
  m.state.points = 20000
  check(await upgrade(), 'the Pack-a-Punch takes the Magnum')
  held = m.weapons.current
  check(held?.name === 'magnum' && held.packed && held.magazine === 12 && held.reserve === 96, 'out comes the Deadline: twelve rounds, six a gun', JSON.stringify(held))
  check([...document.querySelectorAll('.hud-slot-name')].some(n => n.textContent === 'Deadline'), 'the hotbar calls it the Deadline')
  const findLeft = () => { let found = null; cam.traverse(o => { if (o.name === 'Left hand revolver') found = o }); return found }
  face(); await sleep(400)
  const left = findLeft()
  check(left && left.visible && left.getObjectByName('Left hand mitten')?.scale.x < 0, 'a second Magnum in the left hand, held by a left hand')
  // Two zombies side by side on round 2: one round in the first takes both.
  m.rounds.round = 2
  const target = centre.clone().addScaledVector(ahead, -4)
  zombies = pack(2, [[0, 0], [0.8, 1.2]], target)
  await sleep(300)
  const sides = []
  const shot = m.shot.bind(m)
  m.shot = s => { sides.push(cam.worldToLocal(s.origin.clone()).x); return shot(s) }
  sounds.length = 0
  cam.lookAt(zombies[0].actor.rig.bones.chest.getWorldPosition(new V())); e.invalidate()
  await sleep(100)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  await sleep(250)
  check(zombies.every(z => z.state === 'dead'), 'one round bursts in the first zombie and takes the one beside it', zombies.map(z => z.state).join(','))
  check(sounds.includes('round-burst'), 'with the round\'s own pop')
  await sleep(200)
  cam.rotation.set(0, yaw, 0, 'YXZ'); e.invalidate()
  for (let i = 0; i < 3; i++) { m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false); await sleep(400) }
  m.shot = shot
  check(sides.length === 4 && sides[0] > 0.05 && sides[1] < -0.05 && sides[2] > 0.05 && sides[3] < -0.05, 'the guns take turns: right, left, right, left', sides.map(x => x.toFixed(2)).join(', '))
  check(m.weapons.current.magazine === 8, 'the magazine counts both', `${m.weapons.current.magazine}`)
  // A reload: both hands stay on their guns.
  m.weapons.reload()
  await sleep(900)
  const arms = cam.children.find(o => o.name === 'First-person stickman arms')
  check(m.weapons.reloading && left.visible && left.parent === arms, 'both guns in hand through the reload')
  await until(() => !m.weapons.reloading, 5000)
  check(m.weapons.current.magazine === 12, 'both reloaded', `${m.weapons.current.magazine}/${m.weapons.current.reserve}`)
  // Fired at your own feet, it hurts.
  m.director.clear()
  m.invincible = false
  m.state.health = 100
  face()
  cam.rotation.set(-1.45, yaw, 0, 'YXZ'); e.invalidate()
  await sleep(200)
  m.weapons.trigger(true); await sleep(40); m.weapons.trigger(false)
  await sleep(200)
  const sting = 100 - m.state.health
  m.invincible = true
  m.state.health = 100
  check(sting >= 8 && sting <= 40, 'a round at your own feet hurts', `${sting} damage`)
  m.emit = emit
  return { crawlers: status.crawlers, rocketHurt: hurt, roundHurt: sting }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error?.stack ?? error) }))
return 'started'
})()
