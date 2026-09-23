// Gamepad and sprint-stamina checks, with fake pads: the stick maths, the Call of Duty layout, menus, and
// the key and mouse events the bindings send to the game modes.
import assert from 'node:assert/strict'
import { BUTTON, GamepadInput, PAD, readSticks, type MenuAction, type PadAction, type PadBindings, type PadLike } from '../src/player/gamepad'
import { SPRINT, SprintStamina } from '../src/player/stamina'

let failures = 0
function test(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}`, error) }
}

type FakePad = PadLike & { buttons: { pressed: boolean; value: number }[]; axes: number[] }
const fakePad = (): FakePad => ({ connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) })
const press = (pad: FakePad, index: number, on = true) => { pad.buttons[index] = { pressed: on, value: on ? 1 : 0 } }

function harness() {
  const pad = fakePad()
  const log: string[] = []
  const state = { playing: true, target: false, sensitivity: 1, invertY: false, scale: 1, move: [0, 0], yaw: 0, pitch: 0 }
  const bindings: PadBindings = {
    playing: () => state.playing,
    move: (x, forward) => { state.move = [x, forward] },
    look: (yaw, pitch) => { state.yaw += yaw; state.pitch += pitch },
    lookScale: () => state.scale,
    settings: () => ({ sensitivity: state.sensitivity, invertY: state.invertY }),
    action: (action: PadAction, down: boolean) => { if (action !== 'sprint' || log.at(-1) !== `sprint:${down}`) log.push(`${action}:${down}`) },
    hasTarget: () => state.target,
    menu: (action: MenuAction) => log.push(`menu:${action}`),
  }
  const input = new GamepadInput(bindings, () => [null, pad])
  const step = (seconds = 1 / 60) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) input.poll(1 / 60) }
  return { pad, log, state, input, step }
}

test('Sticks: radial deadzones, full push is full, and the look curve is gentle near the centre', () => {
  const pad = fakePad()
  pad.axes = [0.1, -0.1, 0.1, 0.05]
  assert.deepEqual(readSticks(pad), { moveX: 0, moveForward: 0, lookX: 0, lookY: 0 }, 'drift inside the deadzones is ignored')
  pad.axes = [0, -1, 1, 0]
  const full = readSticks(pad)
  assert.equal(full.moveForward, 1, 'stick pushed up walks forward at full pace')
  assert.equal(full.lookX, 1, 'full deflection turns at full speed')
  const half = PAD.lookDeadzone + (1 - PAD.lookDeadzone) * 0.5
  pad.axes = [0, 0, half, 0]
  assert(Math.abs(readSticks(pad).lookX - 0.5 ** PAD.curve) < 1e-9, 'half deflection turns at a quarter speed (curve 2): fine aim near the centre')
  pad.axes = [0.8, 0.8, 0, 0]
  const diagonal = readSticks(pad)
  assert(Math.abs(Math.hypot(diagonal.moveX, diagonal.moveForward) - 1) < 1e-9, 'a full diagonal is not faster than straight')
})

test('Triggers and face buttons: the Call of Duty layout', () => {
  const { pad, log, step } = harness()
  pad.buttons[BUTTON.RT] = { pressed: false, value: 0.2 }; step()
  assert.deepEqual(log, [], 'a trigger resting lightly does not fire')
  pad.buttons[BUTTON.RT] = { pressed: true, value: 0.9 }; step(); step()
  press(pad, BUTTON.RT, false); step()
  press(pad, BUTTON.LT); step(); press(pad, BUTTON.LT, false); step()
  for (const button of [BUTTON.A, BUTTON.Y, BUTTON.RB, BUTTON.R3, BUTTON.LB, BUTTON.B, BUTTON.START]) { press(pad, button); step(); press(pad, button, false); step() }
  assert.deepEqual(log.filter(l => !l.startsWith('sprint')), ['fire:true', 'fire:false', 'aim:true', 'aim:false', 'jump:true', 'switch:true', 'knife:true', 'knife:true', 'grenade:true', 'special:true', 'pause:true'])
})

test('X / Square: tap reloads; held at a prompt, it uses (buys)', () => {
  const { pad, log, state, step } = harness()
  press(pad, BUTTON.X); step(); press(pad, BUTTON.X, false); step()
  assert.deepEqual(log.filter(l => !l.startsWith('sprint')), ['reload:true'], 'no prompt: reload on the press')
  log.length = 0; state.target = true
  press(pad, BUTTON.X); step(0.1); press(pad, BUTTON.X, false); step()
  assert.deepEqual(log.filter(l => !l.startsWith('sprint')), ['reload:true'], 'at a prompt, a quick tap still reloads')
  log.length = 0
  press(pad, BUTTON.X); step(PAD.holdToUse + 0.05)
  assert.deepEqual(log.filter(l => !l.startsWith('sprint')), ['use:true'], 'held, it uses the prompt')
  press(pad, BUTTON.X, false); step()
  assert.deepEqual(log.filter(l => !l.startsWith('sprint')), ['use:true'], 'and letting go does not reload as well')
})

test('L3 sprint stays on while moving and drops when the stick is let go', () => {
  const { pad, log, step } = harness()
  pad.axes[1] = -1; step()
  press(pad, BUTTON.L3); step(); press(pad, BUTTON.L3, false); step(0.5)
  assert.equal(log.at(-1), 'sprint:true', 'clicking the stick sprints, and it stays on after the click')
  pad.axes[1] = 0; step()
  assert.equal(log.at(-1), 'sprint:false', 'stopping ends the sprint')
})

test('Look: speed, sensitivity, aiming slowdown and invert Y', () => {
  const { pad, state, step } = harness()
  pad.axes[2] = 1; step(1)
  assert(Math.abs(state.yaw - PAD.yawSpeed) < 0.06, `one second at full right turns ${PAD.yawSpeed} rad (${state.yaw.toFixed(2)})`)
  state.yaw = 0; state.sensitivity = 2; state.scale = 0.5; step(1)
  assert(Math.abs(state.yaw - PAD.yawSpeed) < 0.06, 'double sensitivity with a half-speed scope comes out the same')
  pad.axes = [0, 0, 0, -1]; state.sensitivity = 1; state.scale = 1; state.pitch = 0; step(0.5)
  assert(state.pitch > 0.9, 'stick up looks up')
  state.invertY = true; state.pitch = 0; step(0.5)
  assert(state.pitch < -0.9, 'inverted, stick up looks down')
})

test('Menus: D-pad and stick step (and repeat), A picks, B backs out, Start resumes; held buttons let go on pause', () => {
  const { pad, log, state, step } = harness()
  pad.buttons[BUTTON.RT] = { pressed: true, value: 1 }; step()
  state.playing = false; step()
  assert.deepEqual(log.slice(-2), ['fire:true', 'fire:false'], 'pausing with the trigger held stops the gun')
  log.length = 0
  press(pad, BUTTON.DOWN); step(); step(PAD.repeatDelay + PAD.repeatEvery + 0.02); press(pad, BUTTON.DOWN, false); step()
  assert.deepEqual(log, ['menu:down', 'menu:down', 'menu:down'], 'a step, then repeats while held')
  log.length = 0
  pad.axes[1] = -1; step(); pad.axes[1] = 0; step()
  for (const button of [BUTTON.A, BUTTON.B, BUTTON.START]) { press(pad, button); step(); press(pad, button, false); step() }
  assert.deepEqual(log, ['menu:up', 'menu:accept', 'menu:back', 'menu:start'])
})

test('No pad: nothing happens and the loop can sleep', () => {
  const input = new GamepadInput({ playing: () => true, move: () => { throw new Error('moved') }, look: () => {}, lookScale: () => 1,
    settings: () => ({ sensitivity: 1, invertY: false }), action: () => { throw new Error('acted') }, hasTarget: () => false, menu: () => {} }, () => [null, null])
  assert.equal(input.poll(1 / 60), false)
})

// ---- The bindings: the same events the keyboard and mouse send ------------------------------------
{
  type Sent = { type: string; code?: string; button?: number }
  const sent: Sent[] = []
  class FakeEvent { constructor(readonly type: string, init: Record<string, unknown> = {}) { Object.assign(this, init) } }
  const target = (label: string) => ({ dispatchEvent: (event: Sent) => { sent.push({ type: event.type, code: (event as { code?: string }).code, button: (event as { button?: number }).button }); void label; return true } })
  Object.assign(globalThis, {
    KeyboardEvent: FakeEvent, MouseEvent: FakeEvent, Event: FakeEvent,
    window: target('window'),
    document: { querySelector: () => null, activeElement: null },
    localStorage: { getItem: () => null, setItem: () => {} },
  })
  const { padBindings } = await import('../src/player/pad-bindings')
  const player = { usingPad: false, padSprint: false, padMove: { set() {} }, enabled: true, playing: true, immersive: false, actions: { target: null },
    jumps: 0, padJump() { this.jumps++ }, paused: 0, pause() { this.paused++ }, padLook() {}, lookSensitivity: () => 1 }
  const guns = [{ name: 'pistol' }, null, { name: 'sniper' }]
  const mission = { aiming: false, weapons: { slots: guns, current: guns[0] } }
  const canvas = target('canvas') as unknown as HTMLCanvasElement
  const zombie = padBindings(canvas, player as never, mission, true), hostage = padBindings(canvas, player as never, mission, false)
  const keys = () => sent.filter(e => e.type === 'keydown').map(e => e.code)

  test('Bindings: fire and aim are the mouse buttons on the canvas; aim holds over the toggle', () => {
    sent.length = 0
    zombie.action('fire', true); zombie.action('fire', false)
    assert.deepEqual(sent.map(e => `${e.type}:${e.button}`), ['mousedown:0', 'mouseup:0'])
    sent.length = 0
    zombie.action('aim', true)
    assert.deepEqual(sent.map(e => `${e.type}:${e.button}`), ['mousedown:2', 'mouseup:2'], 'LT down turns aim on')
    mission.aiming = true; sent.length = 0
    zombie.action('aim', true)
    assert.equal(sent.length, 0, 'already aiming: no toggle off by mistake')
    zombie.action('aim', false)
    assert.deepEqual(sent.map(e => `${e.type}:${e.button}`), ['mousedown:2', 'mouseup:2'], 'LT up turns it off')
    mission.aiming = false
    assert(player.usingPad, 'pad input marks the pad as in use (resume without the pointer lock)')
  })

  test('Bindings: keys per mode, and the next weapon slot', () => {
    sent.length = 0
    for (const action of ['reload', 'use', 'knife', 'grenade', 'special', 'switch'] as const) zombie.action(action, true)
    assert.deepEqual(keys(), ['KeyR', 'KeyF', 'KeyV', 'KeyG', 'KeyT', 'Digit3'], 'Dead Ink: R, F, V, G, T, and slot 3 (slot 2 is empty)')
    sent.length = 0
    for (const action of ['knife', 'grenade', 'special', 'map'] as const) hostage.action(action, true)
    assert.deepEqual(keys(), ['KeyG', 'KeyM'], 'hostage: no knife or grenade; B drops the weapon (G); View opens the map')
    sent.length = 0
    zombie.action('zoomOut', true)
    assert.deepEqual(keys(), [], 'Q is never sent unscoped in Dead Ink (it would throw a grenade)')
    mission.aiming = true; mission.weapons.current = guns[2]
    zombie.action('zoomOut', true); zombie.action('zoomIn', true)
    assert.deepEqual(keys(), ['KeyQ', 'KeyE'], 'scoped, the D-pad zooms')
    mission.aiming = false; mission.weapons.current = guns[0]
    sent.length = 0
    zombie.action('jump', true); zombie.action('sprint', true)
    assert(player.jumps === 1 && player.padSprint, 'jump and sprint go straight to the controller')
    zombie.action('pause', true)
    assert(player.paused === 1 && keys().length === 0, 'Start opens the pause menu directly')
  })
}

test('Sprint stamina: about 4.5 s, then a run until sprint is pressed again; recovers after 1 s', () => {
  const s = new SprintStamina()
  let winded = 0
  s.onWinded = () => winded++
  let t = 0
  while (s.update(1 / 60, true, true)) t += 1 / 60
  assert(Math.abs(t - SPRINT.seconds) < 0.05, `a sprint lasts ${SPRINT.seconds} s (${t.toFixed(2)} s)`)
  assert.equal(winded, 1, 'running dry is announced once')
  for (let i = 0; i < 120; i++) assert.equal(s.update(1 / 60, true, true), false, 'still holding sprint: no sprint while winded')
  s.update(1 / 60, false, true)
  assert.equal(s.update(1 / 60, true, true), true, 'let go and press again: sprints on what recovered while holding')
  const fresh = new SprintStamina()
  for (let i = 0; i < 60; i++) fresh.update(1 / 60, true, true)
  const after = fresh.left
  for (let i = 0; i < 54; i++) fresh.update(1 / 60, false, true)
  assert.equal(fresh.left, after, 'nothing comes back in the first second')
  let full = 0.9
  while (fresh.left < SPRINT.seconds) { fresh.update(1 / 60, false, true); full += 1 / 60 }
  assert(full > 1 && full < 3, `then it refills quickly (full after ${full.toFixed(1)} s)`)
  const empty = new SprintStamina()
  while (empty.update(1 / 60, true, true));
  empty.update(1 / 60, false, false)
  assert.equal(empty.update(1 / 60, true, true), false, 'an empty tank needs a moment before the next sprint')
  let wait = 0
  while (!empty.update(1 / 60, true, true)) { empty.update(1 / 60, false, false); wait += 2 / 60 }
  assert(wait > SPRINT.recoverDelay && wait < SPRINT.recoverDelay + 1, `about a second and a bit (${wait.toFixed(2)} s)`)
})

test('Sprint stamina: standing still does not drain it; unlimited (Stamin-Up) never runs out', () => {
  const s = new SprintStamina()
  for (let i = 0; i < 600; i++) assert.equal(s.update(1 / 60, true, false), false)
  assert.equal(s.left, SPRINT.seconds)
  s.unlimited = true
  for (let i = 0; i < 60 * 30; i++) assert.equal(s.update(1 / 60, true, true), true)
  assert.equal(s.fraction, 1)
})

if (failures) { console.error(`${failures} gamepad check(s) failed`); process.exit(1) }
console.log('gamepad checks passed')
