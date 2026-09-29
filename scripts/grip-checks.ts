import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { FirstPersonWeapons } from '../src/game/weapons'
import { BAKED_GRIPS } from '../src/game/grip-plans'
import { clearGripPlans, gripKey, gripPlan, solveGripPlan, supportSurface, type GripPlan } from '../src/game/grips'
import { InkHand, gunCloud, handClips, tipGap, type HandPose } from '../src/game/hands'
import { createMissionGun } from '../src/game/weapon-models'
import { NO_COSMETICS } from '../src/game/zombies/cosmetics/catalogue'
import type { WeaponFrame, WeaponItem } from '../src/game/types'
import { GRIP_GUNS } from './grip-guns'

let failures = 0
function test(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}`, error) }
}

const label = (item: Pick<WeaponItem, 'name' | 'special'>) => item.special ?? item.name
const solved = new Map<string, { plan: GripPlan; model: ReturnType<typeof createMissionGun>; key: string }>()
for (const item of GRIP_GUNS) {
  const model = createMissionGun(item.name, item.special)
  const key = gripKey(item, model)
  solved.set(label(item), { plan: solveGripPlan(model as never, item, key), model, key })
}

test('Every gun\'s grip is baked, and the bake matches the solver (re-run scripts/bake-grips.ts after a model or solver change)', () => {
  for (const item of GRIP_GUNS) {
    const { plan, key } = solved.get(label(item))!
    const baked = BAKED_GRIPS[key]
    assert(baked, `${key} has no baked grip`)
    const near = (a: number[], b: number[], tolerance: number, what: string) => a.forEach((v, i) => assert(Math.abs(v - b[i]) <= tolerance, `${key} ${what}[${i}] baked ${b[i]}, solved ${v}`))
    near(plan.firing.elements, baked.firing, 2e-5, 'firing')
    near(plan.support.elements, baked.support, 2e-5, 'support')
    for (const [pose, bakedPose, what] of [[plan.idle, baked.idle, 'idle'], [plan.pull, baked.pull, 'pull'], [plan.supportPose, baked.supportPose, 'support pose']] as const) {
      pose.fingers.forEach((finger, i) => near([...finger.curl, finger.spread], [...bakedPose.fingers[i].curl, bakedPose.fingers[i].spread], 2e-4, `${what} finger ${i}`))
      near([...pose.thumb.curl, pose.thumb.yaw, pose.thumb.lift, pose.thumb.twist ?? 0], [...bakedPose.thumb.curl, bakedPose.thumb.yaw, bakedPose.thumb.lift, bakedPose.thumb.twist], 2e-4, `${what} thumb`)
    }
    assert.equal(plan.style, baked.style)
  }
})

test('Every gun is held with no finger, thumb or palm through it, and the fingers touching it', () => {
  const mm = (v: number) => v === Infinity ? 'none within 3 cm' : `${(v * 1000).toFixed(1)} mm`
  for (const item of GRIP_GUNS) {
    const { plan, model, key } = solved.get(label(item))!
    const cloud = gunCloud(model, key)
    const name = label(item)
    for (let f = 0; f < 5; f++) {
      assert(!handClips(plan.idle, plan.firing, cloud, [f], false), `${name}: firing ${f ? `finger ${f}` : 'index'} sinks into the gun`)
      assert(!handClips(plan.supportPose, plan.support, supportSurface(plan, cloud), [f], false), `${name}: support finger ${f} sinks into the gun`)
    }
    assert(!handClips(plan.idle, plan.firing, cloud, [], true), `${name}: the firing palm sinks into the gun`)
    assert(!handClips(plan.supportPose, plan.support, supportSurface(plan, cloud), [], true), `${name}: the support palm sinks into the gun`)
    assert(!handClips(plan.pull, plan.firing, cloud, [0], false), `${name}: the index sinks in pulling the trigger`)
    // The index on the trigger (or along the frame) and the middle and ring fingers round the grip, their
    // last two segments on it (within the ink line's width and a hair).
    for (const f of [0, 1, 2]) {
      const gap = tipGap(plan.idle, f, plan.firing, cloud)
      assert(gap <= 0.0045, `${name}: firing finger ${f} floats ${mm(gap)} off the gun`)
    }
    // The other hand: at least three fingers on what it holds.
    const touching = [0, 1, 2, 3].filter(f => tipGap(plan.supportPose, f, plan.support, supportSurface(plan, cloud)) <= 0.0045)
    assert(touching.length >= 3, `${name}: only fingers ${touching} of the support hand touch`)
    // Both thumbs rest on or close by the gun (or the other hand), not out in the air.
    assert(tipGap(plan.idle, 4, plan.firing, cloud) <= 0.025, `${name}: the firing thumb is out in the air`)
    assert(tipGap(plan.supportPose, 4, plan.support, supportSurface(plan, cloud)) <= 0.025, `${name}: the support thumb is out in the air`)
  }
})

test('A pistol is cupped, a rifle held under its handguard or pump, a front grip or the PDW magazine gripped, the Ink Cannon\'s tank cradled', () => {
  const styles: Record<string, GripPlan['style']> = {
    pistol: 'cup', burst: 'cup', magnum: 'cup', smg: 'cup', rayGun: 'cup', ak: 'handguard', lmg: 'handguard', shotgun: 'handguard',
    sniper: 'handguard', lever: 'handguard', rocket: 'vertical', deathMachine: 'vertical', pdw: 'vertical', inkCannon: 'tank',
  }
  for (const item of GRIP_GUNS) {
    const { plan, model } = solved.get(label(item))!
    assert.equal(plan.style, styles[label(item)], label(item))
    // The support hand sits by what it holds: the handguard's support point, the tank.
    const support = model.userData.support as THREE.Vector3 | undefined
    if (plan.style === 'handguard' && support) assert(Math.abs(plan.supportWrist.z - support.z) < 0.08, `${label(item)} support hand ${plan.supportWrist.z.toFixed(3)} is not at the handguard ${support.z}`)
    // A left hand: its frame is a reflection (the mirrored hand's scale carries it).
    assert(plan.support.determinant() < 0, `${label(item)}: the support hand is not a left hand`)
    assert(plan.firing.determinant() > 0, `${label(item)}: the firing hand is not a right hand`)
  }
})

test('Taking up a gun reads its baked grip: no solving on a phone', () => {
  clearGripPlans()
  const started = performance.now()
  for (const item of GRIP_GUNS) gripPlan(solved.get(label(item))!.model as never, item)
  const elapsed = performance.now() - started
  assert(elapsed < 20, `reading ${GRIP_GUNS.length} baked grips took ${elapsed.toFixed(1)} ms`)
})

function viewmodel() {
  const scene = new THREE.Scene()
  const world = new CollisionWorld(scene)
  const camera = new THREE.PerspectiveCamera(75, 1.7, 0.06, 100)
  camera.position.set(0, 1.7, 0)
  scene.add(camera)
  const weapons = new FirstPersonWeapons({ scene, camera, world, onShot: () => {}, emit: () => {} })
  const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: new THREE.Vector3() }
  const step = (seconds: number) => { for (let time = 0; time < seconds - 1e-8; time += 1 / 60) weapons.update(1 / 60, frame) }
  const hold = (item: Pick<WeaponItem, 'name' | 'special'>) => {
    weapons.restore({ slots: [{ id: `grip-${label(item)}`, ...item, magazine: 3, reserve: 30 } as WeaponItem, null], selected: 0, pickups: [], nextId: 1 })
    step(0.6)
  }
  const inner = weapons as unknown as { firingHand: InkHand; supportHand: InkHand; leftHand: THREE.Group; plan: GripPlan }
  return { scene, weapons, frame, step, hold, inner }
}

test('Both hands stay on the arms (fixed-length bones) for every gun, idle, firing and reloading', () => {
  const { scene, weapons, step, hold, inner } = viewmodel()
  const rig = scene.getObjectByName('First-person stickman arms')!
  const limbs = rig.children.filter(object => object instanceof THREE.Mesh && object.geometry.type === 'CylinderGeometry') as THREE.Mesh[]
  const end = (limb: THREE.Mesh) => limb.localToWorld(new THREE.Vector3(0, 0.5, 0))
  const check = (name: string, when: string) => {
    for (const [i, limb] of limbs.entries()) assert(Math.abs(limb.scale.y - (i % 2 ? 0.36 : 0.34)) < 0.0001, `${name} ${when}: limb ${i} is ${limb.scale.y}`)
    const right = inner.firingHand.root.getWorldPosition(new THREE.Vector3())
    assert(right.distanceTo(end(limbs[1])) < 0.001, `${name} ${when}: the firing hand is ${(right.distanceTo(end(limbs[1])) * 1000).toFixed(1)} mm off its forearm`)
    if (inner.leftHand.visible) {
      const left = inner.supportHand.root.getWorldPosition(new THREE.Vector3())
      assert(left.distanceTo(end(limbs[3])) < 0.001, `${name} ${when}: the support hand is ${(left.distanceTo(end(limbs[3])) * 1000).toFixed(1)} mm off its forearm`)
    }
  }
  rig.updateWorldMatrix(true, true)
  for (const item of GRIP_GUNS) {
    hold(item)
    check(label(item), 'idle')
    weapons.trigger(true); step(1 / 60); check(label(item), 'firing'); step(0.1); weapons.trigger(false)
    step(1)
    if (weapons.reload()) for (let i = 0; i < 12; i++) { step(0.1); check(label(item), `reloading ${i}`) }
  }
  weapons.dispose()
})

test('The index finger closes on the trigger as it fires and eases off after; the support hand opens for a magazine', () => {
  const { weapons, step, hold, inner } = viewmodel()
  const index = (pose: HandPose) => pose.fingers[0].curl.reduce((a, b) => a + b, 0)
  hold({ name: 'pistol' })
  const rest = index(inner.firingHand.currentPose)
  assert(Math.abs(rest - index(inner.plan.idle)) < 0.01, 'at rest the index lies as planned')
  weapons.trigger(true); step(2 / 60)
  assert(index(inner.firingHand.currentPose) > rest + 0.1, 'firing, the index pulls the trigger')
  weapons.trigger(false); step(1)
  assert(Math.abs(index(inner.firingHand.currentPose) - rest) < 0.01, 'after the shot the index eases back')
  // Reloading: the fingers let go of the grip as the hand goes for the magazine, and take it again after.
  const change = () => Math.max(...inner.supportHand.currentPose.fingers.flatMap((f, i) => f.curl.map((c, j) => Math.abs(c - inner.plan.supportPose.fingers[i].curl[j]))))
  assert(change() < 0.01, 'at rest the support hand holds as planned')
  assert(weapons.reload())
  let most = 0
  for (let i = 0; i < 40; i++) { step(1 / 30); most = Math.max(most, change()) }
  assert(most > 0.3, `the support fingers let go for the magazine (${most.toFixed(2)} rad)`)
  step(3)
  assert(change() < 0.01, 'and take the grip again')
  weapons.dispose()
})

test('The lever rifle\'s hand rides the lever as it is worked, and comes back to the grip', () => {
  const { weapons, step, hold, inner } = viewmodel()
  hold({ name: 'lever' })
  const rest = inner.firingHand.root.position.clone()
  weapons.trigger(true); step(1 / 60); weapons.trigger(false)
  let moved = 0
  for (let i = 0; i < 60; i++) { step(1 / 60); moved = Math.max(moved, inner.firingHand.root.position.distanceTo(rest)) }
  assert(moved > 0.01, `the hand moved ${(moved * 1000).toFixed(1)} mm with the lever`)
  step(2)
  assert(inner.firingHand.root.position.distanceTo(rest) < 1e-6, 'and is back on the grip')
  weapons.dispose()
})

test('Each hand is three draw calls in any pose, and is only rebuilt when its pose changes; gloves follow the fingers', () => {
  const { weapons, step, hold, inner } = viewmodel()
  hold({ name: 'ak' })
  for (const hand of [inner.firingHand, inner.supportHand]) {
    const drawn: THREE.Object3D[] = []
    hand.root.traverse(object => { if ((object as THREE.Mesh).isMesh || (object as THREE.LineSegments).isLineSegments) drawn.push(object) })
    assert.equal(drawn.length, 3, `${hand.root.name}: ${drawn.map(o => o.name).join(', ')}`)
  }
  let rebuilt = 0
  for (const hand of [inner.firingHand, inner.supportHand]) {
    const setPose = hand.setPose.bind(hand)
    hand.setPose = pose => { rebuilt++; setPose(pose) }
  }
  step(1)
  assert.equal(rebuilt, 0, 'holding still rebuilds nothing')
  weapons.setCosmetics({ ...NO_COSMETICS, gloves: 'tactical' })
  step(1 / 60)
  for (const hand of [inner.firingHand, inner.supportHand]) {
    const material = hand.mesh.material as THREE.ShaderMaterial
    assert(material.defines?.GLOVE_COORD !== undefined || (material as unknown as { userData: { glove?: string } }).userData.glove, `${hand.root.name} wears the glove`)
    assert(hand.mesh.geometry.getAttribute('gloveCoord'), 'the glove pattern follows the jointed hand')
  }
  weapons.dispose()
})

if (failures) { console.error(`${failures} grip check(s) failed.`); process.exit(1) }
console.log('All grip checks passed.')
