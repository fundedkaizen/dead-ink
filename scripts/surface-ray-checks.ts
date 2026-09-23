import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'

// Compare accelerated surface contacts with Three's independent mesh raycaster:
// material sides, indexed/non-indexed geometry, transforms, back faces and range.
let checked = 0
for (const indexed of [true, false]) for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
  const scene = new THREE.Scene()
  const geometry = new THREE.BoxGeometry(6, 5, 3, 15, 15, 15)
  const mesh = new THREE.Mesh(indexed ? geometry : geometry.toNonIndexed(), new THREE.MeshBasicMaterial({ side }))
  mesh.position.set(7, 2, -4); mesh.rotation.set(0.13, 0.43, -0.07); mesh.scale.set(1.2, 0.8, 1.7)
  scene.add(mesh)
  const world = new CollisionWorld(scene)
  const ray = new THREE.Raycaster()
  for (let i = 0; i < 60; i++) {
    const angle = i * 2.399963229728653
    const origin = new THREE.Vector3(Math.cos(angle) * 9, Math.sin(angle * 0.7) * 5, Math.sin(angle) * 9).add(mesh.position)
    if (i % 5 === 0) origin.copy(mesh.position) // inside: back face contacts
    const target = mesh.position.clone().add(new THREE.Vector3(0.37, -0.22, 0.19))
    const direction = target.sub(origin).normalize(), range = i % 7 === 0 ? 0.5 : 30
    ray.set(origin, direction); ray.near = 0.01; ray.far = range
    const expected = ray.intersectObject(mesh, false).find(hit => hit.distance < range)
    const actual = world.raySurface(origin, direction, range)
    assert.equal(!!actual, !!expected, 'same hit or miss as Three')
    if (actual && expected?.face) {
      assert(Math.abs(actual.distance - expected.distance) < 1e-7, 'same nearest distance')
      assert(actual.point.distanceTo(expected.point) < 1e-7, 'same world point')
      const normal = expected.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
      const backFace = normal.dot(direction) > 0
      if (backFace) normal.negate()
      assert.equal(actual.backFace, backFace, 'same back-face flag')
      assert(actual.normal.distanceTo(normal) < 1e-7, 'same transformed normal')
      assert(actual.localPoint.clone().applyMatrix4(mesh.matrixWorld).distanceTo(actual.point) < 1e-7)
      assert(actual.localNormal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).distanceTo(actual.normal) < 1e-7)
    }
    checked++
  }
  // The fast path must not silently regress to scanning a complete mesh.
  const oldRaycast = mesh.raycast
  mesh.raycast = () => { throw new Error('large static surface used the full mesh raycast') }
  world.raySurface(mesh.position.clone().add(new THREE.Vector3(0, 0, 10)), new THREE.Vector3(0, 0, -1), 20)
  mesh.raycast = oldRaycast
  // Partial geometry must retain Three's draw-range behavior.
  mesh.geometry.setDrawRange(0, 0)
  assert.equal(world.raySurface(mesh.position.clone().add(new THREE.Vector3(0, 0, 10)), new THREE.Vector3(0, 0, -1), 20), null)
  world.dispose(); mesh.geometry.dispose(); mesh.material.dispose()
}
// Nearest mesh wins, and moving colliders retain their surface contact after refresh.
{
  const scene = new THREE.Scene()
  const far = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 1, 16, 16, 16), new THREE.MeshBasicMaterial())
  far.position.z = -5
  const door = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.2), new THREE.MeshBasicMaterial())
  door.userData.dynamicCollision = true
  scene.add(far, door)
  const world = new CollisionWorld(scene), origin = new THREE.Vector3(0.12, 0.23, 3), direction = new THREE.Vector3(0, 0, -1)
  assert.equal(world.raySurface(origin, direction, 20)?.mesh, door)
  door.position.x = 10; world.refresh()
  assert.equal(world.raySurface(origin, direction, 20)?.mesh, far)
  world.dispose(); far.geometry.dispose(); far.material.dispose(); door.geometry.dispose(); door.material.dispose()
}
console.log(`PASS ${checked} surface-ray comparisons, accelerated path, draw range, nearest mesh and moving door`)
