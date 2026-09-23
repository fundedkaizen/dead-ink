import * as THREE from 'three'

/**
 * The scene's per-frame matrix update, without redoing the ones that cannot have changed.
 *
 * three.js recomposes every object's local matrix and multiplies out its world matrix every frame: about
 * 3,500 objects here, nearly all of them the still compound (about 2 ms a frame on a fast PC). This does the
 * same walk, but an object whose position, rotation, scale and parent are what they were last frame, under a
 * parent that did not move, keeps its matrices. Anything that moves is updated exactly as three.js would.
 * Objects with their own updateMatrixWorld (cameras, skinned meshes) take the normal path, subtree and all.
 */
const standard = THREE.Object3D.prototype.updateMatrixWorld
/** Last seen: position x y z, quaternion x y z w, scale x y z. */
type Cache = { values: Float64Array; parent: THREE.Object3D | null }
const CACHE = Symbol('matrix cache')
type Cached = THREE.Object3D & { [CACHE]?: Cache }

function moved(object: Cached) {
  let cache = object[CACHE]
  const p = object.position, q = object.quaternion, s = object.scale
  if (!cache) cache = object[CACHE] = { values: new Float64Array(10).fill(NaN), parent: null }
  const v = cache.values
  if (v[0] === p.x && v[1] === p.y && v[2] === p.z && v[3] === q.x && v[4] === q.y && v[5] === q.z && v[6] === q.w
    && v[7] === s.x && v[8] === s.y && v[9] === s.z && cache.parent === object.parent && object.pivot === null) return false
  v[0] = p.x; v[1] = p.y; v[2] = p.z; v[3] = q.x; v[4] = q.y; v[5] = q.z; v[6] = q.w; v[7] = s.x; v[8] = s.y; v[9] = s.z
  cache.parent = object.parent
  return true
}

function update(object: Cached, force: boolean) {
  if (object.matrixAutoUpdate && moved(object)) object.updateMatrix()
  if (object.matrixWorldNeedsUpdate || force) {
    if (object.matrixWorldAutoUpdate) {
      if (object.parent === null) object.matrixWorld.copy(object.matrix)
      else object.matrixWorld.multiplyMatrices(object.parent.matrixWorld, object.matrix)
    }
    object.matrixWorldNeedsUpdate = false
    force = true
  }
  const children = object.children
  for (let i = 0, l = children.length; i < l; i++) {
    const child = children[i] as Cached
    if (child.updateMatrixWorld !== standard) {
      // Its own override (a camera's inverse, a skinned mesh's bind matrix) must run: the normal path from here.
      child.updateMatrixWorld(force)
    } else update(child, force)
  }
}

/** Replace `scene.updateMatrixWorld`, which the renderer calls every frame. */
export function skipStillMatrices(scene: THREE.Scene) {
  scene.updateMatrixWorld = function (force = false) { update(this, force) }
}
