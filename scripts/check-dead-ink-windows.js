// Run against a freshly loaded /?mode=zombies page, after window.__environment.mission.ready:
//   npx agent-browser eval --stdin < scripts/check-dead-ink-windows.js
// Starts in the page and returns at once (it takes about half a minute); poll window.__windowsCheck for
// { done, results, error? }.
// The mess hall's boarded windows in a real round: a zombie climbs out of the ground on the road, walks up to
// a window, swipes at you through it, rips the planks off one at a time and climbs in; you shoot it with the
// real gun and rebuild the window with real F presses, held and tapped, for 10 points a plank, up to the
// round's cap, and never for a window that is whole.
// Staged: the player is invincible; round 1 is cut to its first zombie, which is sent to one window (in play a
// share of spawns go to whichever windows are near); the cap is reached by crediting 490 points of it up front,
// and two planks are knocked out directly for that part (a zombie's tearing is checked before it). Reload after.
(() => {
const results = []
const status = window.__windowsCheck = { done: false, results }
;(async () => {
  const e = window.__environment, m = e.mission, p = e.player, cam = e.camera.active
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const V = cam.position.constructor
  const check = (ok, label, detail = '') => { results.push({ passed: !!ok, label, detail }); if (!ok) throw new Error(`${label} ${detail}`) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (test, ms, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (test()) return true; await sleep(step) } return test() }
  const key = (code, type = 'keydown') => window.dispatchEvent(new KeyboardEvent(type, { key: code.replace(/Key|Digit/, '').toLowerCase(), code, bubbles: true, cancelable: true }))
  p.fallback = true
  m.invincible = true
  document.querySelector('#walk-start').click()
  check(p.playing, 'the game starts')
  const barriers = m.barriers, list = barriers?.list ?? []
  check(list.length === 4 && list.every(b => /^Mess hall/.test(b.name)), 'four boarded windows on the mess hall', list.map(b => b.name).join('; '))
  check(list.every(b => b.boards === 6 && b.planks.length === 6), 'six planks nailed across each')
  const b = list[2]
  const inside = (into, side) => b.centre.clone().addScaledVector(b.inward, 0.07 + into).addScaledVector(b.tangent, side).setY(b.floorIn)
  const standAt = (feet, look) => { p.body.teleport(feet.clone()); p.actions.syncCamera(cam); cam.lookAt(look); e.invalidate() }
  const prompt = () => { p.actions.findTarget(cam); return p.actions.target?.label ?? '' }

  // ---- A whole window: nothing to rebuild, nothing to earn ------------------------------------------------
  m.rounds.phase = 'break'; m.rounds.timer = 9999
  standAt(inside(0.9, 0), b.point)
  await sleep(250)
  check(!/rebuild/i.test(prompt()), 'no rebuild prompt at a whole window', prompt())
  let before = m.state.points
  key('KeyF'); await sleep(800); key('KeyF', 'keyup')
  check(m.state.points === before && b.boards === 6, 'holding F at a whole window does nothing', `${before} -> ${m.state.points}`)

  // ---- Round 1: a zombie from the road, at this window -------------------------------------------------------
  let sent = false
  const pickSpawn = barriers.pickSpawn
  barriers.pickSpawn = () => sent ? null : (sent = true, { barrier: b, rise: b.rises[0] })
  // Zombie hits only: the runtime also calls damage() every frame with no fall damage.
  const hits = [], damage = m.damage
  m.damage = function (amount, cause, ...rest) { if (cause === 'zombie' && amount > 0) hits.push(performance.now()); return damage.call(this, amount, cause, ...rest) }
  m.rounds.timer = 0.01
  check(await until(() => m.director.aliveCount === 1, 8000), 'round 1 sends its first zombie')
  m.rounds.toSpawn = 0
  const z = m.director.zombies.find(zombie => zombie.state === 'chase')
  check(z.window?.slot === b, 'it comes from the road, for the window')
  check(!b.inside(z.position) && z.position.distanceTo(b.rises[0]) < 0.1, 'climbing out of the ground outside it')
  // You stand at the window inside: it swipes at you through it.
  standAt(inside(0.45, 0), b.point)
  check(await until(() => z.window?.stage === 'tear', 20000), 'it walks up to the window and climbs the step')
  check(await until(() => hits.length > 0, 6000), 'at the window, it swipes you through it', `${hits.length} hits`)
  // Step back and off to one side, out of its reach: it tears the planks off instead, one at a time.
  standAt(inside(1.4, 1.1), b.point)
  await sleep(1300)
  const hitsAside = hits.length, torn = []
  let last = b.boards
  const watch = setInterval(() => { if (b.boards !== last) { last = b.boards; torn.push([b.boards, performance.now()]) } }, 20)
  await until(() => z.window?.stage !== 'tear', 12000)
  clearInterval(watch)
  const gaps = torn.slice(1).map((t, i) => (t[1] - torn[i][1]) / 1000)
  check(b.boards === 0 && torn.length >= 4, 'it rips the planks off', `${torn.map(t => t[0])}`)
  check(torn.every((t, i) => i === 0 || t[0] === torn[i - 1][0] - 1), 'one at a time', `${torn.map(t => t[0])}`)
  check(gaps.every(gap => gap > 0.8 && gap < 1.35), 'about a second each', gaps.map(g => g.toFixed(2)).join(', '))
  check(hits.length === hitsAside, 'out of its reach, no swipe gets through', `${hits.length - hitsAside} hits`)
  check(z.window?.stage === 'vault', 'then it climbs through')
  check(await until(() => !z.window, 3000), 'and is in')
  check(b.inside(z.position) && Math.abs(z.position.y - b.floorIn) < 0.1, 'on its feet inside the hall')
  check(b.planks.every(plank => !b.inside(plank.position) && plank.position.y < b.sill), 'the planks lie outside, below the window')

  // ---- Shoot it with the real gun ---------------------------------------------------------------------------------
  const bot = setInterval(() => {
    if (z.state !== 'chase') return
    const w = m.weapons
    if (w.current && w.current.magazine === 0) { w.reload(); return }
    cam.lookAt(z.actor.rig.bones.head.getWorldPosition(new V()).add(new V(0, 0.05, 0)))
    w.trigger(true); setTimeout(() => w.trigger(false), 20)
  }, 110)
  check(await until(() => z.state === 'dead', 15000), 'it goes down to the real gun')
  clearInterval(bot)
  check(await until(() => m.rounds.phase === 'break', 3000), 'round 1 is over')
  m.rounds.timer = 9999

  // ---- Rebuild: hold F, a plank every 0.6 s, 10 points each -----------------------------------------------------------
  standAt(inside(0.9, 0), b.point)
  await sleep(300)
  check(prompt() === 'Hold to rebuild the barrier', 'at the torn window, a prompt to rebuild it', prompt())
  before = m.state.points
  key('KeyF')
  await sleep(1900)
  key('KeyF', 'keyup')
  const held = b.boards
  check(held >= 3 && held <= 4, 'held for two seconds, a plank goes up every 0.6 s', `${held} planks`)
  check(m.state.points === before + held * 10, '10 points a plank', `${before} -> ${m.state.points}`)
  await sleep(700)
  check(b.boards === held, 'let go of F and it stops')
  // Tapping faster does not rebuild faster.
  const tapFrom = b.boards
  for (let i = 0; i < 6; i++) { key('KeyF'); await sleep(40); key('KeyF', 'keyup'); await sleep(110) }
  check(b.boards - tapFrom <= 2, 'tapping F cannot beat 0.6 s a plank', `${b.boards - tapFrom} planks in 0.9 s`)
  key('KeyF')
  check(await until(() => b.boards === 6, 5000), 'held again, the window is whole')
  key('KeyF', 'keyup')
  check(m.state.points === before + 60, 'six planks the zombie tore off, 60 points', `${before} -> ${m.state.points}`)
  await sleep(400)
  check(b.planks.every(plank => plank.motion === 'none' && plank.position.distanceTo(plank.nailed.position) < 1e-3), 'every plank back where it was nailed')
  check(!/rebuild/i.test(prompt()), 'the prompt goes once it is whole', prompt())
  before = m.state.points
  key('KeyF'); await sleep(800); key('KeyF', 'keyup')
  check(m.state.points === before, 'and F there earns nothing more')

  // ---- The cap: 500 points of rebuilding a round, then planks for nothing ------------------------------------------------
  const round = m.rounds.round
  barriers.ledger.take('p1', round, 490 - barriers.ledger.paidBy('p1', round))
  b.tear(); b.tear()
  await sleep(600)
  check(prompt() === 'Hold to rebuild the barrier', 'with 10 points of the cap left, the prompt is plain', prompt())
  before = m.state.points
  key('KeyF')
  check(await until(() => b.boards === 6, 3000), 'both planks go back up')
  key('KeyF', 'keyup')
  check(m.state.points === before + 10, 'the first pays 10, the second nothing: 500 a round', `${before} -> ${m.state.points}`)
  check(barriers.ledger.paidBy('p1', round) === 500, 'the round\'s 500 is reached')
  b.tear()
  await sleep(300)
  check(prompt() === 'Hold to rebuild the barrier · no more points this round', 'the prompt says so', prompt())

  barriers.pickSpawn = pickSpawn
  m.damage = damage
  m.invincible = false
  return { points: m.state.points, swipes: hits.length }
})().then(summary => Object.assign(status, summary, { done: true }), error => Object.assign(status, { done: true, error: String(error) }))
return 'started'
})()
