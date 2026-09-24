// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-brute.js
// Starts in the page and returns at once; poll window.__bruteCheck for { done, results, error? }.
// The Brute in the real game: it arrives on round 5 with its health bar, the round ends with it alive and it
// hunts on into round 6 with a line saying so; it charges, slams (the ink wave runs out), throws a chunk,
// loses its mask to head shots in stages, enrages below its threshold, and dies to a frag for its points and a Max Ammo.
// Staged: rounds are hurried (their timers shortened, the round's own zombies cleared), the player is put
// where each attack fits and its other attacks are held back, and hits on the player are recorded with the
// health topped up so nobody dies. The attacks themselves are the Brute's own choice once allowed.
(() => {
const results = []
const status = window.__bruteCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const sounds = [], hits = []
  const emit = m.emit.bind(m)
  m.emit = event => { sounds.push(event.kind); return emit(event) }
  const damage = m.damage.bind(m)
  m.damage = (n, cause, source, knock) => { if (n > 0 && cause === 'zombie') hits.push({ n, knock: knock ? knock.length() : 0 }); m.state.health = 1000; return damage(n, cause, source, knock) }
  p.fallback = true
  m.invincible = false
  document.querySelector('#walk-start').click()
  await sleep(300)
  for (const gate of m.zones?.gates ?? []) m.zones.open(gate)
  const bar = () => document.querySelector('.dead-ink-boss')
  const caption = () => document.querySelector('#mission-caption')?.textContent ?? ''
  const clearZombies = () => { m.rounds.toSpawn = 0; for (const z of m.director.zombies) if (z.state === 'chase' && !z.boss) { z.health = 0; z.state = 'dead'; z.deadFor = 99; z.actor.root.visible = false } }
  const place = (at, face) => { p.body.teleport(at.clone()); p.actions.syncCamera(cam); cam.lookAt(face.x, face.y + 1.6, face.z); e.invalidate() }
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  /** Metres of standing room straight along `yaw` from `from` (as the charge measures it). */
  const straight = (from, yaw, most) => {
    let y = from.y
    for (let d = 0.45; d <= most; d += 0.45) {
      const q = m.director.navigation.floor(new V(from.x + Math.sin(yaw) * d, y, from.z + Math.cos(yaw) * d))
      if (!q) return d - 0.45
      y = q.y
    }
    return most
  }
  /** Hold every special attack but `open`. */
  const allow = (...open) => { const b = m.brute.brute; for (const k of ['slam', 'charge', 'throw', 'burrow']) b.cool[k] = open.includes(k) ? 0 : 999; b.cool.gap = 0; b.move = null; m.brute.swing = 0 }

  // ---- It arrives on round 5, with its health bar and its track.
  m.rounds.round = 4; m.rounds.phase = 'break'; m.rounds.timer = 0.2
  check(await until(() => m.rounds.round === 5, 3000), 'round 5 starts')
  clearZombies()
  m.bruteTimer = 0.2
  check(await until(() => m.brute && m.brute.state === 'chase', 4000), 'the Brute climbs out of the ground')
  const brute = m.brute
  check(brute.boss && brute.brute && brute.maxHealth >= 15000, 'with a boss\'s health', `${brute.maxHealth}`)
  check(await until(() => bar() && !bar().hidden && bar().textContent.includes('THE BRUTE'), 1500), 'its health bar shows')
  check(sounds.includes('boss-roar'), 'and it roars')
  const look = brute.actor.root.userData.brute
  check(look?.mask.visible && look.outfit.visible, 'masked and dressed')
  allow()

  // ---- The round ends with it alive; it hunts on into round 6.
  clearZombies()
  check(await until(() => m.rounds.phase === 'break' && m.rounds.round === 5, 4000), 'round 5 ends with the Brute alive', `${m.rounds.phase} ${m.rounds.round}`)
  check(brute.state === 'chase' && m.brute === brute, 'the Brute is still up')
  m.rounds.timer = 0.3
  check(await until(() => m.rounds.round === 6, 3000), 'round 6 starts')
  check(await until(() => /still hunting you/.test(caption()), 1500), 'a line says it is still hunting you', caption())
  check(brute.state === 'chase' && m.brute === brute && !bar().hidden, 'the same Brute, bar and all')
  m.bruteTimer = -1
  clearZombies()
  m.rounds.timer = 9999

  // ---- The charge: a clear straight line, 12 m.
  let yaw = 0, best = 0
  for (let a = 0; a < 48; a++) { const r = straight(brute.position, a / 48 * Math.PI * 2, 18); if (r > best) { best = r; yaw = a / 48 * Math.PI * 2 } }
  check(best >= 14, 'room for a charge', `${best.toFixed(1)} m`)
  const lane = d => { const q = brute.position.clone().add(new V(Math.sin(yaw) * d, 0, Math.cos(yaw) * d)); return m.director.navigation.floor(q) ?? q }
  place(lane(12), brute.position)
  brute.yaw = yaw
  hits.length = 0
  allow('charge')
  check(await until(() => brute.brute.move === 'charge', 3000), 'it plants itself to charge')
  check(await until(() => sounds.includes('brute-snort'), 500), 'snorting')
  const from = brute.position.clone()
  check(await until(() => flat(brute.position, from) > 4, 3000), 'then runs at you', `${flat(brute.position, from).toFixed(1)} m`)
  check(await until(() => hits.some(h => h.n >= 70), 2500), 'and runs you down', JSON.stringify(hits.map(h => h.n)))
  check(hits.find(h => h.n >= 70).knock >= 7, 'throwing you')
  await until(() => brute.brute.move !== 'charge', 3000)

  // ---- The slam: close by.
  allow('slam')
  place(brute.position.clone().add(new V(Math.sin(brute.yaw + 0.3) * 3, 0, Math.cos(brute.yaw + 0.3) * 3)), brute.position)
  hits.length = 0
  check(await until(() => brute.brute.move === 'slam', 3000), 'close by, it raises its fists to slam')
  check(await until(() => brute.brute.struck, 2000), 'and brings them down')
  check(m.director.brutes.waves.count >= 1, 'an ink wave runs out along the ground')
  check(await until(() => hits.length > 0, 1000), 'it hurts you', JSON.stringify(hits.map(h => h.n)))
  await until(() => brute.brute.move !== 'slam', 3000)

  // ---- The throw: out of reach, in plain sight.
  let spot = null
  for (let a = 0; a < 48 && !spot; a++) {
    const y = a / 48 * Math.PI * 2, d = 17
    const q = m.director.navigation.floor(brute.position.clone().add(new V(Math.sin(y) * d, 0, Math.cos(y) * d)))
    if (q && Math.abs(q.y - brute.position.y) < 0.3 && m.player.world.visible(brute.position.clone().setY(brute.position.y + 2.6), q.clone().setY(q.y + 1.2), brute.actor.root)) spot = q
  }
  check(spot, 'a spot out of its reach in plain sight')
  place(spot, brute.position)
  allow('throw')
  check(await until(() => brute.brute.move === 'throw', 3000), 'out of reach, it tears a chunk out of the ground')
  check(await until(() => m.director.brutes.debris.flying.length > 0, 2500), 'and throws it')
  check(await until(() => m.director.brutes.debris.flying.length === 0 && sounds.includes('debris-crash'), 4000), 'the chunk lands and bursts')
  await until(() => brute.brute.move !== 'throw', 3000)

  // ---- Head shots work its mask loose in stages until it breaks off; then the head is a weak spot.
  allow()
  const b = brute.brute, wears = new Set()
  const headShot = () => {
    const face = brute.actor.rig.bones.head.localToWorld(new V(0, 0.18, 0))
    const from = face.clone().add(new V(Math.sin(brute.yaw) * 8, 0.3, Math.cos(brute.yaw) * 8))
    return m.director.hit({ origin: from, direction: face.clone().sub(from).normalize(), range: 60, damage: 40, weapon: 'ak' }, 60, 1)
  }
  let shots = 0, clangs = 0
  while (b.mask > 0 && shots < 300) {
    const hit = headShot(); shots++
    if (hit?.reaction.zone === 'head') clangs++
    wears.add(b.wear); brute.health = brute.maxHealth
    if (shots % 10 === 0) await sleep(16)
  }
  check(clangs > 0 && sounds.includes('brute-clang'), 'head shots clang off its mask', `${clangs}/${shots}`)
  check(wears.has(1) && wears.has(2), 'it works loose in stages', [...wears].join(','))
  check(b.mask <= 0 && !look.mask.visible && sounds.includes('brute-mask-break'), 'and breaks off', `${shots} shots`)
  check(b.move === 'stun' && b.cause === 'mask', 'it reels')
  await until(() => b.move !== 'stun', 3000)
  const bare = brute.health, bareHit = headShot()
  check(bareHit?.reaction.zone === 'head' && bare - brute.health > 40, 'its bare head is a weak spot', `${bare - brute.health}`)
  brute.health = brute.maxHealth

  // ---- Enraged below a third of its health.
  allow()
  brute.health = Math.floor(brute.maxHealth * 0.3)
  check(await until(() => brute.brute.enraged && brute.brute.move === 'roar', 3000), 'hurt enough, it roars and enrages')
  check(await until(() => look.halo.visible && bar().classList.contains('enraged'), 1000), 'its eyes flare and its bar throbs')
  check(sounds.includes('brute-enrage'), 'a roar heard across the map')

  // ---- It dies to a frag, pays and leaves a Max Ammo.
  await until(() => brute.brute.move !== 'roar', 3000)
  const points = m.state.points
  brute.health = 1
  place(lane(10), brute.position)
  m.grenadeBlast(brute.position.clone())
  check(await until(() => brute.state === 'dead' && !m.brute, 1500), 'a frag finishes it')
  check(m.state.points - points >= 500, 'it pays', `+${m.state.points - points}`)
  check(m.powerups.active.some(d => d.kind === 'maxAmmo' && flat(d.position, brute.position) < 3), 'and leaves a Max Ammo where it fell')
  check(await until(() => bar().hidden, 1500), 'its health bar goes')
  m.emit = emit; m.damage = damage
  return { hits: hits.length }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
