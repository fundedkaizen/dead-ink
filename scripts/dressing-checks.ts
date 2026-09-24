import assert from 'node:assert/strict'
import * as THREE from 'three'
import { geometryHash } from '../src/game/zombies/navgraph'
import { addDressing } from '../src/game/zombies/dressing'
import { Explosion, MushroomCloud, createGrenadeModel } from '../src/game/zombies/vfx'
import { seeded } from '../src/game/shared/random'
import { buildNavScene } from './nav-scene'

// Dead Ink's dressing is decoration, except that its big props stop a player: it must leave the baked
// navigation fingerprint as it was, change collision only where a prop stands, stay off the spots it is
// told to keep clear, and come out cleanly.
// Node has no canvas, so the painted marks are skipped here; the 3D props, strokes and planks are not.
const { scene, world } = buildNavScene()
const hash = geometryHash(scene)
const probes: number[] = []
const probe = () => {
  const out: number[] = []
  for (let x = -90; x <= 160; x += 5) for (let z = -55; z <= 70; z += 5) out.push(world.floor(new THREE.Vector3(x, 1.5, z), 0.1, 2.4))
  return out
}
probes.push(...probe())

const started = performance.now()
let undress = addDressing(scene as THREE.Scene, world, seeded(0xDEAD1))
const took = performance.now() - started
const dressing = () => scene.children.find(child => child.name === 'Dead Ink dressing')
const root = dressing()
assert(root, 'the dressing adds one root to the scene')
assert.equal(root.userData.noCollision, true, 'the dressing root is noCollision')
assert.equal(geometryHash(scene), hash, 'the navigation fingerprint is unchanged by the dressing')
world.refresh()
// The props that stop a player: movement only (bullets and sight pass), and nothing else changed.
const solids = root.userData.solids as THREE.Group
assert(solids.children.length > 20, `the big props have colliders (${solids.children.length})`)
for (const box of solids.children) assert(box.userData.blocksShots === false && box.userData.blocksSight === false, `${box.name} stops movement only`)
const underProp = (x: number, z: number) => solids.children.some(box => {
  const local = box.worldToLocal(new THREE.Vector3(x, box.position.y, z)), size = ((box as THREE.Mesh).geometry as THREE.BoxGeometry).parameters
  return Math.abs(local.x) <= size.width / 2 + 0.05 && Math.abs(local.z) <= size.depth / 2 + 0.05
})
const dressed = probe()
let i = 0, changed = 0
for (let x = -90; x <= 160; x += 5) for (let z = -55; z <= 70; z += 5, i++) {
  if (dressed[i] === probes[i]) continue
  changed++
  assert(underProp(x, z), `the floor changed only under a prop (${x}, ${z}: ${probes[i]} -> ${dressed[i]})`)
}
const report = root.userData.dressing as { spots: Record<string, number[]>; missing: string[] }
for (const name of ['stars', 'headstone']) assert(report.spots[name], `${name} found its place`)
console.log(`PASS dressing leaves the navigation fingerprint as it was; ${solids.children.length} props stop a player, ${changed} floor probes land on one (built in ${took.toFixed(0)} ms)`)

/** Draw calls, vertices, and the nearest solid prop below 2.4 m to a point (ink strokes excluded). */
const measure = (from = new THREE.Vector3(1e6, 0, 1e6)) => {
  let meshes = 0, vertices = 0, nearest = Infinity, at = new THREE.Vector3()
  dressing()!.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    meshes++
    const position = object.geometry.getAttribute('position')
    vertices += position.count
    if (!object.name.endsWith('paper surfaces')) return
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) > 2.4) continue
      const d = Math.hypot(position.getX(i) - from.x, position.getZ(i) - from.z)
      if (d < nearest) { nearest = d; at = new THREE.Vector3().fromBufferAttribute(position, i) }
    }
  })
  return { meshes, vertices, nearest, at }
}
// Somewhere junk landed near the spawn, stood in for a wall gun: dressed again, the junk must keep off it.
const first = measure(new THREE.Vector3(-30, 0, -25))
assert(first.meshes <= 5 * 3 + 1, `draw calls stay flat: ${first.meshes} meshes`)
const keep = first.at.clone()
undress()
assert(!dressing(), 'the dispose function removes the dressing')
world.refresh()
assert.deepEqual(probe(), probes, 'undressed, every floor probe is as it was: the props left the collision world too')
undress = addDressing(scene as THREE.Scene, world, seeded(0xDEAD1), [keep])
const kept = measure(keep)
assert(kept.nearest > 1, `nothing below 2.4 m within 1 m of a kept-clear spot (nearest ${kept.nearest.toFixed(2)} m)`)
console.log(`PASS ${first.meshes} meshes, ${first.vertices} vertices; junk kept ${kept.nearest.toFixed(2)} m off a station spot it used to cover`)

// Same seed, same compound: the same dressing.
undress()
undress = addDressing(scene as THREE.Scene, world, seeded(0xDEAD1), [keep])
assert.equal(measure().vertices, kept.vertices, 'the dressing is deterministic for a seed')
undress()
console.log('PASS dressing is deterministic and disposes cleanly')

// Effects: pooled, bounded, and idle meshes cost no draw calls.
const effects = new THREE.Scene()
const blasts = new Explosion(effects, world), cloud = new MushroomCloud(effects)
const visible = () => { let n = 0; effects.traverse(o => { if (o instanceof THREE.Mesh && o.visible) n++ }); return n }
assert.equal(visible(), 0, 'idle effects draw nothing')
for (let i = 0; i < 25; i++) blasts.emit(new THREE.Vector3(-30 + i * 0.3, 0.06, -25), 5.5)
cloud.trigger(new THREE.Vector3(200, 0, -25)); cloud.trigger(new THREE.Vector3(0, 0, 200)); cloud.trigger(new THREE.Vector3(-200, 0, 0))
for (let t = 0; t < 0.3; t += 0.016) { blasts.update(0.016); cloud.update(0.016) }
effects.traverse(object => {
  if (object instanceof THREE.InstancedMesh) assert(object.count <= object.instanceMatrix.count, `${object.name} stays inside its pool`)
})
assert(visible() <= 9, 'at most six blast and three cloud draw calls')
for (let t = 0; t < 13; t += 0.05) { blasts.update(0.05); cloud.update(0.05) }
assert(!blasts.active && !cloud.active && visible() === 0, 'everything finishes and hides itself again')
blasts.dispose(); cloud.dispose()
const grenade = createGrenadeModel(), size = new THREE.Box3().setFromObject(grenade).getSize(new THREE.Vector3())
assert(size.y > 0.07 && size.y < 0.12, `the grenade is hand sized (${size.y.toFixed(3)} m tall)`)
console.log('PASS explosions and the mushroom cloud stay pooled and go idle; grenade model is hand sized')
