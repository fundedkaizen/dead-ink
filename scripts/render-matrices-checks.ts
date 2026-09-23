// The scene's matrix update that skips still objects (src/render/matrices.ts) must give exactly the world
// matrices three.js's own update gives, frame after frame, however objects move, turn, scale or change parent.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { skipStillMatrices } from '../src/render/matrices'
import { seeded } from '../src/game/shared/random'

const random = seeded(5)
const build = () => {
  const scene = new THREE.Scene(), all: THREE.Object3D[] = [scene]
  for (let i = 0; i < 400; i++) {
    const object = i % 7 === 0 ? new THREE.PerspectiveCamera() : i % 5 === 0 ? new THREE.Bone() : new THREE.Object3D()
    object.position.set(random() * 10, random() * 10, random() * 10)
    object.rotation.set(random(), random(), random())
    all[Math.floor(random() * all.length)].add(object)
    all.push(object)
  }
  return { scene, all }
}
// Two identical scenes driven identically: one updated by three.js, one by the skipping update.
const seed = random
const a = build()
const b = (() => { const copy = a.scene.clone(true) as THREE.Scene; const all: THREE.Object3D[] = []; copy.traverse(o => all.push(o)); return { scene: copy, all } })()
const order: THREE.Object3D[] = []; a.scene.traverse(o => order.push(o))
assert.equal(order.length, b.all.length)
skipStillMatrices(b.scene)
const same = (label: string) => {
  a.scene.updateMatrixWorld(); b.scene.updateMatrixWorld()
  const listA: THREE.Object3D[] = [], listB: THREE.Object3D[] = []
  a.scene.traverse(o => listA.push(o)); b.scene.traverse(o => listB.push(o))
  for (let i = 0; i < listA.length; i++) {
    const ea = listA[i].matrixWorld.elements, eb = listB[i].matrixWorld.elements
    for (let k = 0; k < 16; k++) assert(Math.abs(ea[k] - eb[k]) < 1e-9, `${label}: object ${i} world matrix matches`)
    if (listA[i] instanceof THREE.Camera) {
      const ia = (listA[i] as THREE.Camera).matrixWorldInverse.elements, ib = (listB[i] as THREE.Camera).matrixWorldInverse.elements
      for (let k = 0; k < 16; k++) assert(Math.abs(ia[k] - ib[k]) < 1e-6 * Math.max(1, Math.abs(ia[k])), `${label}: camera ${i} inverse matches (${ia[k]} vs ${ib[k]})`)
    }
  }
}
same('first frame')
const pick = (i: number) => {
  const listA: THREE.Object3D[] = [], listB: THREE.Object3D[] = []
  a.scene.traverse(o => listA.push(o)); b.scene.traverse(o => listB.push(o))
  const index = 1 + (i % (listA.length - 1))
  return [listA[index], listB[index]] as const
}
for (let frame = 0; frame < 120; frame++) {
  // A few objects change each frame, in every way code in the game changes them.
  for (let n = 0; n < 6; n++) {
    const [oa, ob] = pick(Math.floor(seed() * 1e6)), kind = Math.floor(seed() * 6), value = seed()
    for (const o of [oa, ob]) {
      if (kind === 0) o.position.x += value
      else if (kind === 1) o.rotation.y += value
      else if (kind === 2) o.scale.setScalar(0.5 + value)
      else if (kind === 3) { o.position.y += value; o.updateMatrix() }
      else if (kind === 4) { o.quaternion.set(0, 0, 0, 1); o.updateMatrixWorld(true) }
    }
    if (kind === 5 && !(oa instanceof THREE.Scene)) {
      // Move it under another parent, keeping its local transform (not a descendant of itself).
      const [pa, pb] = pick(Math.floor(seed() * 1e6))
      let cycle = false
      for (let p: THREE.Object3D | null = pa; p; p = p.parent) if (p === oa) cycle = true
      if (!cycle) { pa.add(oa); pb.add(ob) }
    }
  }
  same(`frame ${frame}`)
}
// Hand-set matrices keep working.
const [ma, mb] = pick(17)
for (const o of [ma, mb]) { o.matrixAutoUpdate = false; o.matrix.makeTranslation(3, 2, 1); o.matrixWorldNeedsUpdate = true }
same('a hand-set matrix')
console.log('render matrices checks passed: the skipping update matches three.js over 120 frames of changes')
