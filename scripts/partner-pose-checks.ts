import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { PartnerAvatar, type PlayerState } from '../src/game/zombies/coop'
import { PARTNER_AIM_LIMITS, PARTNER_POSE_SECONDS, type PartnerPhase } from '../src/game/zombies/partner-poses'
import { BONE_NAMES } from '../src/lab/rig'
import { SHIN_LENGTH } from '../src/lab/gait'

// Co-op partner poses (src/game/zombies/partner-poses.ts) on the real stickman, at 30, 60 and 144 fps: every
// transition completes on time and blends from wherever it starts; nothing is NaN; feet, knees and hands rest
// on the floor where they should and nothing goes under it; the last stand pistol points along the look; the
// crawl plants its hand and drives its knee; the syringe shows only while reviving; bled out lies still, face
// down; the actor gets the rig back standing. At 144 fps no bone turns faster than a person can or kicks from
// one frame to the next (pops). And the poses allocate nothing per frame.
const bytes = readFileSync('public/models/stickman.glb')
GLTFLoader.prototype.loadAsync = async function () {
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
}

const GROUND = 2.5
/** The lead's last stand crawl: walking pace 4.2 m/s times the crawl's 0.22. */
const CRAWL_SPEED = 4.2 * 0.22
/** At 144 fps a pop shows as a bone turning or changing speed faster than these (rad/s). */
const MAX_TURN = 40, MAX_KICK = 35
const v = () => new THREE.Vector3()
const lookDirection = (yaw: number, pitch: number) => new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
const summary: string[] = []

class Run {
  readonly scene = new THREE.Scene()
  readonly avatar = new PartnerAvatar(this.scene)
  state: PlayerState = { id: 1, p: [3, GROUND, -1], yaw: 0.4, pitch: 0, w: 'pistol', mv: 0, dn: 0, pts: 0, kills: 0, name: 'P2' }
  time = 0
  /** Per phase: the fastest bone turn (rad/s) and the largest frame-to-frame change in a bone's turn rate. */
  readonly turn = new Map<string, [number, string]>()
  readonly kick = new Map<string, [number, string]>()
  private previous: THREE.Quaternion[] | null = null
  private rates = new Array(BONE_NAMES.length).fill(0)
  constructor(readonly dt: number, readonly label: string) {}
  get actor() { return this.avatar.actor! }
  get poses() { return this.avatar.poses }
  get bones() { return this.actor.rig.bones }
  get gun() { return this.bones['hand.R'].children.find(child => child.name.startsWith('gun:') && child !== this.actor.gun)! }
  async load() { await this.avatar.load() }

  step(seconds: number, each?: () => void) {
    for (let i = 0, n = Math.round(seconds / this.dt); i < n; i++) {
      this.time += this.dt
      this.avatar.update(this.dt, this.state)
      this.actor.root.updateMatrixWorld(true)
      this.watch()
      each?.()
    }
  }

  /** Step until the phase becomes `phase`; returns the seconds it took. */
  until(phase: PartnerPhase, limit: number) {
    const start = this.time
    while (this.poses.phase !== phase) {
      assert(this.time - start <= limit + 1e-6, `${this.label}: still ${this.poses.phase} after ${limit}s, waiting for ${phase}`)
      this.step(this.dt)
    }
    return this.time - start
  }

  /** No NaN; the fastest bone turn and turn-rate change, kept per phase. */
  private watch() {
    const q = BONE_NAMES.map(name => this.bones[name].getWorldQuaternion(new THREE.Quaternion()))
    for (let i = 0; i < q.length; i++) {
      const p = this.bones[BONE_NAMES[i]].getWorldPosition(v())
      assert(Number.isFinite(q[i].x + q[i].y + q[i].z + q[i].w + p.x + p.y + p.z), `${this.label}: NaN in ${BONE_NAMES[i]} (${this.poses.phase})`)
    }
    if (this.previous) {
      const phase = this.poses.phase, where = (bone: string) => `${bone} at ${this.poses.phase} ${this.poses.time.toFixed(3)}s`
      for (let i = 0; i < q.length; i++) {
        const rate = q[i].angleTo(this.previous[i]) / this.dt, change = Math.abs(rate - this.rates[i])
        if (rate > (this.turn.get(phase)?.[0] ?? -1)) this.turn.set(phase, [rate, where(BONE_NAMES[i])])
        if (change > (this.kick.get(phase)?.[0] ?? -1)) this.kick.set(phase, [change, where(BONE_NAMES[i])])
        this.rates[i] = rate
      }
    }
    this.previous = q
  }
  forget() { this.turn.clear(); this.kick.clear() }

  height(name: (typeof BONE_NAMES)[number], local?: THREE.Vector3) {
    return (local ? this.bones[name].localToWorld(local.clone()) : this.bones[name].getWorldPosition(v())).y - GROUND
  }
  foot(side: 'L' | 'R') { return this.height(`shin.${side}`, new THREE.Vector3(0, SHIN_LENGTH, 0)) }
  fist(side: 'L' | 'R') { return this.height(`hand.${side}`, new THREE.Vector3(0, 0.035, 0)) }
  lowest() {
    let low = Infinity
    for (const name of BONE_NAMES) low = Math.min(low, this.height(name))
    return Math.min(low, this.foot('L'), this.foot('R'), this.fist('L'), this.fist('R'))
  }
  barrel() { return new THREE.Vector3(0, 0, 1).applyQuaternion(this.gun.getWorldQuaternion(new THREE.Quaternion())) }
  muzzle() { return this.gun.localToWorld((this.gun.userData.muzzle as THREE.Vector3).clone()).y - GROUND }
}

async function scenario(fps: number) {
  const run = new Run(1 / fps, `${fps} fps`)
  await run.load()
  const { state } = run
  run.step(0.5)
  // The actor's own first frames (its spawn pose settling into the aim) are not ours to judge.
  run.forget()
  assert.equal(run.poses.phase, 'up')

  // ---- going down: a 0.6 s collapse into last stand
  state.dn = 1
  run.step(run.dt)
  assert.equal(run.poses.phase, 'fall', `${run.label}: going down did not start the collapse`)
  let fallLow = Infinity
  const fall = run.until('down', PARTNER_POSE_SECONDS.fall + 2 * run.dt)
  assert(fall >= PARTNER_POSE_SECONDS.fall - 2 * run.dt, `${run.label}: the collapse took ${fall}s`)
  run.step(1.2, () => { fallLow = Math.min(fallLow, run.lowest()) })
  // Lying: legs rest on the floor, the pistol elbow is planted, the head is up, nothing is under the floor.
  for (const side of ['L', 'R'] as const) {
    assert(run.foot(side) > 0.02 && run.foot(side) < 0.12, `${run.label}: down, ${side} foot at ${run.foot(side)}`)
    assert(run.height(`shin.${side}`) > 0.02 && run.height(`shin.${side}`) < 0.12, `${run.label}: down, ${side} knee at ${run.height(`shin.${side}`)}`)
  }
  assert(Math.abs(run.height('forearm.R') - 0.065) < 0.02, `${run.label}: down, the pistol elbow is at ${run.height('forearm.R')}, not on the floor`)
  assert(run.height('head', new THREE.Vector3(0, 0.19, 0)) > 0.4, `${run.label}: down, the head is not up`)
  assert(fallLow > 0.02, `${run.label}: lying, something is under the floor (${fallLow})`)

  // ---- last stand aim: along the look within the limits, at the limit beyond them, muzzle clear of the floor
  const aims: [number, number][] = [[0.4, 0], [0.4 - 0.6, 0.3], [0.4 + 0.45, -0.2], [0.4, 0.6], [0.4 - 0.9, 0.1], [0.4, PARTNER_AIM_LIMITS.down]]
  let worst = 0
  for (const [yaw, pitch] of aims) {
    state.yaw = yaw; state.pitch = pitch
    run.step(2)
    const error = THREE.MathUtils.radToDeg(run.barrel().angleTo(lookDirection(yaw, pitch)))
    worst = Math.max(worst, error)
    assert(error < 3, `${run.label}: the pistol misses the look by ${error.toFixed(1)} deg at yaw ${yaw}, pitch ${pitch}`)
    assert(run.muzzle() > 0.03, `${run.label}: the muzzle is in the floor (${run.muzzle().toFixed(3)}) at yaw ${yaw}, pitch ${pitch}`)
  }
  // Looking straight up: the lying arm stops at its limit and points as high as it can.
  state.pitch = 1.3
  run.step(1)
  assert(Math.abs(Math.asin(run.barrel().y) - PARTNER_AIM_LIMITS.up) < 0.05, `${run.label}: aim above the limit gave pitch ${Math.asin(run.barrel().y)}`)
  state.pitch = 0; state.yaw = 0.4
  run.step(1.5)

  // ---- crawl: a circle at crawl speed, looking ahead; the free hand plants, the top knee drives
  state.mv = 1
  const centre = new THREE.Vector3(3, GROUND, -1), radius = 1.5
  let handDown = Infinity, handUp = -Infinity, thighMin = Infinity, thighMax = -Infinity, crawlLow = Infinity
  const crawlStart = run.time
  run.step(6, () => {
    const a = (run.time - crawlStart) * CRAWL_SPEED / radius
    state.p = [centre.x + Math.sin(a) * radius, GROUND, centre.z + radius - Math.cos(a) * radius]
    // Moving along (cos a, sin a) in x and z; the camera looks down -Z at yaw 0.
    state.yaw = Math.atan2(-Math.cos(a), -Math.sin(a))
    if (run.time - crawlStart > 1) {
      handDown = Math.min(handDown, run.fist('L')); handUp = Math.max(handUp, run.fist('L'))
      const thigh = run.bones['thigh.L'].quaternion.angleTo(run.actor.rig.rest['thigh.L'].quat)
      thighMin = Math.min(thighMin, thigh); thighMax = Math.max(thighMax, thigh)
      crawlLow = Math.min(crawlLow, run.lowest())
    }
  })
  assert.equal(run.poses.phase, 'down')
  assert(run.poses.crawl > 0.95, `${run.label}: the crawl layer is at ${run.poses.crawl}`)
  assert(handDown < 0.075, `${run.label}: the crawling hand never plants (lowest ${handDown})`)
  assert(handUp - handDown > 0.06, `${run.label}: the crawling hand never lifts (${handDown}..${handUp})`)
  assert(thighMax - thighMin > 0.5, `${run.label}: the knee does not drive (${thighMin}..${thighMax})`)
  assert(crawlLow > 0.02, `${run.label}: crawling, something goes under the floor (${crawlLow})`)
  state.mv = 0
  run.step(1)
  assert(run.poses.crawl < 0.02, `${run.label}: the crawl did not settle`)

  // ---- revived: a 1.2 s get-up, then the actor takes the rig back standing
  state.dn = 0
  run.step(run.dt)
  assert.equal(run.poses.phase, 'rise')
  let riseLow = Infinity
  const rise = run.until('up', PARTNER_POSE_SECONDS.rise + 2 * run.dt)
  assert(rise >= PARTNER_POSE_SECONDS.rise - 2 * run.dt, `${run.label}: the get-up took ${rise}s`)
  run.step(0.6, () => { riseLow = Math.min(riseLow, run.foot('L'), run.foot('R')) })
  assert.equal(run.actor.posture, 'stand')
  assert.equal(run.actor.postureTransitionRemaining, 0, `${run.label}: the actor is still standing up`)
  assert(riseLow > 0.03, `${run.label}: the feet went under the floor after the get-up (${riseLow})`)
  assert(Math.abs(run.foot('L') - 0.06) < 0.03 && Math.abs(run.foot('R') - 0.06) < 0.03, `${run.label}: back up, the feet are off the floor`)
  assert(run.height('head') > 1.25, `${run.label}: back up, not standing`)

  // ---- reviving someone: kneel in 0.25 s, syringe in, plunger following the progress, stand in 0.25 s
  state.pitch = -0.95
  run.step(0.3)
  state.rv = 0.05
  run.step(run.dt)
  assert.equal(run.poses.phase, 'revive')
  run.step(PARTNER_POSE_SECONDS.kneel + 0.1)
  const syringe = run.poses.syringe!
  assert(syringe.visible, `${run.label}: no syringe while reviving`)
  assert(Math.abs(run.height('shin.R') - 0.065) < 0.03, `${run.label}: the kneeling knee is at ${run.height('shin.R')}`)
  assert(Math.abs(run.foot('L') - 0.06) < 0.03 && Math.abs(run.foot('R') - 0.06) < 0.04, `${run.label}: kneeling feet off the floor (${run.foot('L').toFixed(3)}, ${run.foot('R').toFixed(3)})`)
  // Down to a teammate's chest: propped on an elbow, it is 0.2 to 0.35 m off the floor.
  assert(run.fist('L') < 0.35, `${run.label}: the syringe hand does not reach down (${run.fist('L')})`)
  assert(run.height('head') < 1.0, `${run.label}: not kneeling`)
  const full = (syringe.userData.ink as THREE.Object3D).scale.y
  state.rv = 0.8
  run.step(0.1)
  assert((syringe.userData.ink as THREE.Object3D).scale.y < full - 0.5, `${run.label}: the plunger does not follow the revive`)
  // Told where the teammate lies (PlayerState.rt), the kneel turns to face them and reaches to them.
  const kneelAt = run.actor.root.position.clone(), h = run.poses.heading
  const aside = new THREE.Vector3(kneelAt.x + Math.cos(h) * 0.9, GROUND, kneelAt.z - Math.sin(h) * 0.9)
  run.poses.reviveAt = aside
  run.step(0.8)
  const toward = Math.atan2(aside.x - kneelAt.x, aside.z - kneelAt.z), off = Math.atan2(Math.sin(toward - run.poses.heading), Math.cos(toward - run.poses.heading))
  assert(Math.abs(off) < 0.08, `${run.label}: the kneel does not face the teammate (${off.toFixed(2)} rad off)`)
  const syringeHand = run.bones['hand.L'].localToWorld(new THREE.Vector3(0, 0.035, 0))
  assert(Math.hypot(syringeHand.x - aside.x, syringeHand.z - aside.z) < 0.3, `${run.label}: the syringe is ${Math.hypot(syringeHand.x - aside.x, syringeHand.z - aside.z).toFixed(2)} m from the teammate`)
  run.step(0.1)
  state.rv = 0
  const stand = run.until('up', PARTNER_POSE_SECONDS.kneel + 2 * run.dt)
  run.poses.reviveAt = null
  run.step(0.2)
  assert(!syringe.visible, `${run.label}: the syringe still shows after the revive`)
  run.step(0.5)
  assert(run.height('head') > 1.25, `${run.label}: did not stand after reviving`)

  // ---- down again, then bled out: face down and still, the gun gone
  state.dn = 1
  run.until('down', PARTNER_POSE_SECONDS.fall + 2 * run.dt)
  run.step(1)
  state.dn = 2
  run.step(run.dt)
  assert.equal(run.poses.phase, 'dead')
  let slumpLow = Infinity
  run.step(PARTNER_POSE_SECONDS.slump + 0.6, () => { slumpLow = Math.min(slumpLow, run.lowest()) })
  assert(!run.gun.visible, `${run.label}: the gun is still in the dead hand`)
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(run.bones.chest.getWorldQuaternion(new THREE.Quaternion()))
  assert(front.y < -0.6, `${run.label}: bled out, not face down (chest front ${front.y.toFixed(2)})`)
  const still = BONE_NAMES.map(name => run.bones[name].quaternion.toArray())
  run.step(0.5)
  const moved = Math.max(...BONE_NAMES.flatMap((name, i) => run.bones[name].quaternion.toArray().map((x, k) => Math.abs(x - still[i][k]))))
  assert(moved < 1e-6, `${run.label}: the bled out body still moves (${moved})`)
  assert(slumpLow > 0.02, `${run.label}: slumping, something goes under the floor (${slumpLow})`)
  // Back next round: up off the floor.
  state.dn = 0
  run.until('up', PARTNER_POSE_SECONDS.rise + 2 * run.dt)
  assert(run.gun.visible, `${run.label}: the gun did not come back`)

  // ---- interruptions blend from wherever they are
  state.rv = 0.2; run.step(0.15); state.dn = 1; run.step(run.dt)
  assert.equal(run.poses.phase, 'fall', `${run.label}: downed while reviving`)
  run.until('down', PARTNER_POSE_SECONDS.fall + 2 * run.dt)
  state.rv = 0
  state.dn = 0; run.step(0.5); state.dn = 1; run.step(run.dt)
  assert.equal(run.poses.phase, 'fall', `${run.label}: downed again mid get-up`)
  run.step(0.3); state.dn = 0; run.step(run.dt)
  assert.equal(run.poses.phase, 'rise', `${run.label}: revived mid-collapse`)
  run.until('up', PARTNER_POSE_SECONDS.rise + 2 * run.dt)
  state.dn = 2; run.until('dead', PARTNER_POSE_SECONDS.fall + 2 * run.dt)
  run.step(2)

  // ---- no pops (at 144 fps, where a pop cannot hide in a long frame)
  if (fps >= 144) {
    for (const [phase, [rate, where]] of run.turn) assert(rate < MAX_TURN, `${run.label}: a bone turns ${rate.toFixed(1)} rad/s in ${phase}: ${where}`)
    for (const [phase, [kick, where]] of run.kick) assert(kick < MAX_KICK, `${run.label}: a bone's turn jumps by ${kick.toFixed(1)} rad/s in one frame in ${phase}: ${where}`)
  }
  const fastest = [...run.turn].map(([phase, [rate]]) => `${phase} ${rate.toFixed(1)}`).join(', ')
  const kicks = [...run.kick].map(([phase, [kick]]) => `${phase} ${kick.toFixed(1)}`).join(', ')
  summary.push(`${String(fps).padStart(3)} fps: fall ${fall.toFixed(3)} s, get-up ${rise.toFixed(3)} s, stand from kneel ${stand.toFixed(3)} s, aim error <= ${worst.toFixed(2)} deg`
    + `\n         fastest bone turn (rad/s): ${fastest}\n         largest one-frame change (rad/s): ${kicks}`)
  run.avatar.dispose()
}

for (const fps of [30, 60, 144]) await scenario(fps)

// ---- no allocations per frame. Every function the poses run each frame is read from the source and must not
// make objects: no new, clone, closures, spreads, array or object literals, array helpers, template strings, or
// Math.hypot (V8 builds an array for its arguments). A heap profiler cannot tell these apart from the numbers
// V8 boxes between calls, which all JavaScript does. Setup and once-per-transition code is not listed.
{
  const source = readFileSync('src/game/zombies/partner-poses.ts', 'utf8')
  const perFrame = ['to', 'cap', 'smooth', 'wrap', 'dot4', 'copyFrame', 'mix', 'spline', 'sampleKeys', 'sampleLoop', 'apply', 'bodyPoint',
    'lookRotation', 'aimBone', 'groundedEnd', 'trackHeading', 'restOnFloor', 'standOn', 'under', 'addEuler', 'place', 'arc', 'frame',
    'palmDown', 'layArm', 'softReach', 'elbowAngle', 'hingeFor', 'towardDirection', 'elbowScore', 'armOffFloor', 'idle', 'pushPlunger',
    'crawl', 'aim', 'clutch', 'reach', 'breath', 'settle', 'update', 'track', 'pose', 'pushUp', 'gunOnFloor', 'handOnFloor', 'restLimb',
    'lift', 'aimPistol', 'clutchBelly', 'crawlReach', 'reviveHands', 'look', 'reviveDistance']
  // Comments and plain strings out first (template strings stay), so they can neither hide nor fake a match.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  const bodies: [string, string][] = []
  for (const name of perFrame) {
    // No backslash escapes in this pattern: the check bundler rewrites them inside template literals.
    const declaration = new RegExp('^(?:function ' + name + '[(]|const ' + name + ' = [(]|  (?:private )?(?:get )?' + name + '[(])', 'gm')
    let declared = 0
    for (const match of code.matchAll(declaration)) {
      // Past the parameter list, then the body: braces matched, or an arrow's expression to the end of its line.
      // (An indented call statement matches too; only a declaration has its body right after the parameters.)
      let i = match.index! + match[0].length, depth = 1
      while (depth > 0) { const c = code[i++]; if (c === '(') depth++; else if (c === ')') depth-- }
      const rest = code.slice(i, code.indexOf('\n', i))
      if (/^\s*=>/.test(rest)) { bodies.push([name, rest.replace(/^\s*=>/, '')]); declared++; continue }
      if (!/^\s*(?::[^{]+)?\{/.test(rest)) continue
      declared++
      const open = code.indexOf('{', i)
      let j = open + 1
      for (depth = 1; depth > 0; j++) { const c = code[j]; if (c === '{') depth++; else if (c === '}') depth-- }
      bodies.push([name, code.slice(open + 1, j - 1)])
    }
    assert(declared > 0, `per-frame function ${name} not found in partner-poses.ts`)
  }
  const patterns: [RegExp, string][] = [[/\bnew\s/, 'new'], [/\.clone\(/, 'clone'], [/=>/, 'closure'], [/\.\.\./, 'spread'],
    [/[=(,:?]\s*\[/, 'array literal'], [/(?:[=(,?]|return)\s*\{/, 'object literal'], [/`/, 'template string'], [/Math\.hypot/, 'Math.hypot'],
    [/\.(?:map|filter|slice|concat|flatMap|reduce|forEach|split|join)\(/, 'array helper'], [/Array\.from|Object\.(?:keys|values|entries)/, 'array helper']]
  const found: string[] = []
  for (const [name, body] of bodies) for (const [pattern, what] of patterns) {
    const m = pattern.exec(body)
    if (m) found.push(`${name}: ${what} near "${body.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}"`)
  }
  assert.equal(found.length, 0, `per-frame code allocates:\n${found.join('\n')}`)
  summary.push(`allocations: none in the ${perFrame.length} functions the poses run each frame (no new, clone, closures, literals, template strings, array helpers, Math.hypot)`)
}

console.log(['partner poses: ok', ...summary].join('\n'))
