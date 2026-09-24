import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { Octree } from 'three/addons/math/Octree.js'

type Collider = {
  mesh: THREE.Mesh
  bounds: THREE.Box3
  inverse: THREE.Matrix4
  tree?: Octree
  dynamic: boolean
  /** Last capsule query that tested this collider. */
  query?: number
  blocksSight: boolean
  blocksShots: boolean
}

export type SurfaceHit = {
  distance: number; point: THREE.Vector3; normal: THREE.Vector3; mesh: THREE.Mesh; backFace: boolean
  localPoint: THREE.Vector3; localNormal: THREE.Vector3
}

/** Retain the same contact when a hinge moves during the cosmetic bullet flight. */
export function followSurface(hit: SurfaceHit): SurfaceHit {
  hit.mesh.updateWorldMatrix(true, false)
  return { ...hit, point: hit.localPoint.clone().applyMatrix4(hit.mesh.matrixWorld),
    normal: hit.localNormal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.mesh.matrixWorld)) }
}

const up = new THREE.Vector3(0, 1, 0)
const none: never[] = []
// Shared by every world and region view, because views share collider records.
let queries = 0

/**
 * Octree.capsuleIntersect, the same arithmetic in the same order, without its garbage: three.js builds a
 * triangle list, a line array per triangle and a result object per contact, and a zombie crowd asks this
 * thousands of times a second. The result is reused: read it before the next call. These trees hold each
 * face in exactly one leaf (collisionTree), so the duplicate scan is not needed either.
 */
const capsuleScratch = { capsule: new Capsule(), plane: new THREE.Plane(), point: new THREE.Vector3(), line1: new THREE.Line3(), line2: new THREE.Line3(),
  p1: new THREE.Vector3(), p2: new THREE.Vector3(), r: new THREE.Vector3(), s: new THREE.Vector3(), w: new THREE.Vector3(),
  centre: new THREE.Vector3(), other: new THREE.Vector3(), normal: new THREE.Vector3(), faces: [] as THREE.Triangle[], count: 0 }
const capsuleResult = { normal: new THREE.Vector3(), depth: 0 }
function gatherCapsule(tree: Octree, capsule: Capsule) {
  const c = capsuleScratch
  for (const subTree of tree.subTrees) {
    if (!capsule.intersectsBox(subTree.box!)) continue
    if (subTree.triangles.length > 0) for (const face of subTree.triangles) c.faces[c.count++] = face
    else gatherCapsule(subTree, capsule)
  }
}
function closestPoints(line1: THREE.Line3, line2: THREE.Line3, target1: THREE.Vector3, target2: THREE.Vector3) {
  const c = capsuleScratch
  const r = c.r.copy(line1.end).sub(line1.start), s = c.s.copy(line2.end).sub(line2.start), w = c.w.copy(line2.start).sub(line1.start)
  const a = r.dot(s), b = r.dot(r), cc = s.dot(s), d = s.dot(w), e = r.dot(w)
  let t1: number, t2: number
  const divisor = b * cc - a * a
  if (Math.abs(divisor) < 1e-10) {
    const d1 = -d / cc, d2 = (a - d) / cc
    if (Math.abs(d1 - 0.5) < Math.abs(d2 - 0.5)) { t1 = 0; t2 = d1 } else { t1 = 1; t2 = d2 }
  } else { t1 = (d * a + e * cc) / divisor; t2 = (t1 * a - d) / cc }
  t2 = Math.max(0, Math.min(1, t2)); t1 = Math.max(0, Math.min(1, t1))
  target1.copy(r).multiplyScalar(t1).add(line1.start)
  target2.copy(s).multiplyScalar(t2).add(line2.start)
}
/** Octree.triangleCapsuleIntersect: the push-out (into capsuleScratch.normal) and its depth, or -1. */
function triangleCapsule(capsule: Capsule, triangle: THREE.Triangle) {
  const c = capsuleScratch
  triangle.getPlane(c.plane)
  const d1 = c.plane.distanceToPoint(capsule.start) - capsule.radius, d2 = c.plane.distanceToPoint(capsule.end) - capsule.radius
  if ((d1 > 0 && d2 > 0) || (d1 < -capsule.radius && d2 < -capsule.radius)) return -1
  const delta = Math.abs(d1 / (Math.abs(d1) + Math.abs(d2)))
  const point = c.point.copy(capsule.start).lerp(capsule.end, delta)
  if (triangle.containsPoint(point)) { c.normal.copy(c.plane.normal); return Math.abs(Math.min(d1, d2)) }
  const r2 = capsule.radius * capsule.radius
  const line1 = c.line1.set(capsule.start, capsule.end)
  for (let i = 0; i < 3; i++) {
    const line2 = c.line2.set(i === 0 ? triangle.a : i === 1 ? triangle.b : triangle.c, i === 0 ? triangle.b : i === 1 ? triangle.c : triangle.a)
    closestPoints(line1, line2, c.p1, c.p2)
    if (c.p1.distanceToSquared(c.p2) < r2) {
      c.normal.copy(c.p1).sub(c.p2).normalize()
      return capsule.radius - c.p1.distanceTo(c.p2)
    }
  }
  return -1
}
function capsuleIntersect(tree: Octree, capsule: Capsule) {
  const c = capsuleScratch, moved = c.capsule.copy(capsule)
  c.count = 0
  gatherCapsule(tree, moved)
  let hit = false
  for (let i = 0; i < c.count; i++) {
    const depth = triangleCapsule(moved, c.faces[i])
    if (depth === -1) continue
    hit = true
    moved.translate(c.normal.multiplyScalar(depth))
  }
  if (!hit) return false
  const collision = moved.getCenter(c.centre).sub(capsule.getCenter(c.other))
  capsuleResult.depth = collision.length()
  capsuleResult.normal.copy(collision.normalize())
  return capsuleResult
}

/** Partition triangles without duplicating large coplanar slabs into many octants. */
function collisionTree(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position'), index = geometry.index
  const triangles: THREE.Triangle[] = []
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const vertices = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i + offset) : i + offset))
    const triangle = new THREE.Triangle(vertices[0], vertices[1], vertices[2])
    if (triangle.getArea() > 1e-10) triangles.push(triangle)
  }
  const build = (faces: THREE.Triangle[]): Octree => {
    const box = new THREE.Box3()
    for (const face of faces) box.expandByPoint(face.a).expandByPoint(face.b).expandByPoint(face.c)
    box.expandByScalar(0.00001)
    const tree = new Octree(box)
    if (faces.length <= 24) tree.triangles = faces
    else {
      const size = box.getSize(new THREE.Vector3())
      const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
      faces.sort((a, b) => (a.a[axis] + a.b[axis] + a.c[axis]) - (b.a[axis] + b.b[axis] + b.c[axis]))
      const middle = Math.floor(faces.length / 2)
      tree.subTrees = [build(faces.slice(0, middle)), build(faces.slice(middle))]
    }
    return tree
  }
  const root = new Octree()
  root.subTrees = [build(triangles)]
  return root
}

/** Local-space trees are built only for nearby meshes; moving objects retain their trees. */
export class CollisionWorld {
  private colliders: Collider[] = []
  private proxies: THREE.Mesh[] = []
  private capsule = new Capsule()
  private bounds = new THREE.Box3()
  private offset = new THREE.Vector3()
  private ray = new THREE.Raycaster()
  private groundRay = new THREE.Ray()
  private normal = new THREE.Vector3()
  private spatialRays = false
  // Faces of the last tree query. Never shortened: `length = 0` frees the backing store and every ray would regrow it.
  private faces: THREE.Triangle[] = []
  private faceCount = 0
  private rayPoint = new THREE.Vector3()
  private nearestPoint = new THREE.Vector3()
  // Static colliders by 8 m XZ cell, so NPC floor probes skip the other ~850 meshes.
  // `wide` holds moving colliders and slabs spanning many cells; both lists are scanned.
  private cells: Map<number, Collider[]> | null = null
  private wide: Collider[] = []

  constructor(scene: THREE.Object3D) {
    scene.updateWorldMatrix(true, true)
    this.register(scene)
  }

  /** Add the colliders of an object placed after the world was built (Dead Ink's zone gates). */
  addObject(root: THREE.Object3D) {
    root.updateWorldMatrix(true, true)
    this.register(root)
    this.cells = null
  }

  /** Remove every collider belonging to `root`, including its panel proxies. */
  removeObject(root: THREE.Object3D) {
    const owned = (mesh: THREE.Object3D) => {
      for (let object: THREE.Object3D | null = mesh.userData.panelOwner ?? mesh; object; object = object.parent) if (object === root) return true
      return false
    }
    this.colliders = this.colliders.filter(collider => !owned(collider.mesh))
    this.proxies = this.proxies.filter(proxy => { if (!owned(proxy)) return true; proxy.geometry.dispose(); return false })
    this.cells = null
  }

  private register(root: THREE.Object3D) {
    root.traverse(object => {
      for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
        if (parent.userData.noCollision) return
      }
      if (object instanceof THREE.Mesh && !(object.material instanceof THREE.ShaderMaterial)) {
        let dynamic = false
        for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
          if (parent.userData.doorHinge || parent.userData.dynamicCollision) dynamic = true
        }
        this.add(object, dynamic, object.userData.blocksSight !== false, object.userData.blocksShots !== false)
      }
      for (const panel of object.userData.collisionPanels ?? []) {
        const [ax, az] = panel.a, [bx, bz] = panel.b
        const geometry = new THREE.BoxGeometry(Math.hypot(bx - ax, bz - az), panel.height, 0.06)
        geometry.rotateY(-Math.atan2(bz - az, bx - ax))
        geometry.translate((ax + bx) / 2, panel.height / 2, (az + bz) / 2)
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
        mesh.matrixAutoUpdate = false
        mesh.matrixWorld.copy(object.matrixWorld)
        mesh.userData.panelOwner = object
        this.proxies.push(mesh)
        this.add(mesh, false, panel.blocksSight !== false, panel.blocksShots !== false)
      }
    })
  }

  private add(mesh: THREE.Mesh, dynamic: boolean, blocksSight = true, blocksShots = true) {
    mesh.geometry.computeBoundingBox()
    this.colliders.push({ mesh, dynamic, blocksSight, blocksShots,
      bounds: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      inverse: mesh.matrixWorld.clone().invert() })
  }

  private index() {
    if (this.cells) return this.cells
    this.cells = new Map(); this.wide = []
    for (const collider of this.colliders) {
      const { min, max } = collider.bounds
      const x0 = Math.floor(min.x / 8), x1 = Math.floor(max.x / 8), z0 = Math.floor(min.z / 8), z1 = Math.floor(max.z / 8)
      if (collider.dynamic || !((x1 - x0 + 1) * (z1 - z0 + 1) <= 64)) { this.wide.push(collider); continue }
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
        const key = (i + 32768) * 65536 + j + 32768, list = this.cells.get(key)
        if (list) list.push(collider); else this.cells.set(key, [collider])
      }
    }
    return this.cells
  }

  private cell(x: number, z: number) {
    return this.index().get((Math.floor(x / 8) + 32768) * 65536 + Math.floor(z / 8) + 32768) ?? none
  }

  refresh() {
    for (const collider of this.colliders) if (collider.dynamic) {
      collider.mesh.updateWorldMatrix(true, false)
      collider.bounds.copy(collider.mesh.geometry.boundingBox!).applyMatrix4(collider.mesh.matrixWorld)
      collider.inverse.copy(collider.mesh.matrixWorld).invert()
    }
  }

  /** Build, while loading, the few trees (ladder rails, vegetation) whose first sight-line use would cost a 5-25 ms frame. */
  warm() {
    for (const collider of this.colliders) {
      const geometry = collider.mesh.geometry
      if (!collider.dynamic && (geometry.index ?? geometry.getAttribute('position')).count > 9000) this.tree(collider)
    }
  }

  /** Octree.getRayTriangles without its per-ray array and duplicate scan; these trees hold each face in one leaf. */
  private collect(tree: Octree, ray: THREE.Ray) {
    for (const subTree of tree.subTrees) {
      if (!ray.intersectsBox(subTree.box!)) continue
      if (subTree.triangles.length > 0) for (const face of subTree.triangles) this.faces[this.faceCount++] = face
      else this.collect(subTree, ray)
    }
  }

  private tree(collider: Collider) {
    return collider.tree ??= collisionTree(collider.mesh.geometry)
  }

  private collision(collider: Collider, capsule: Capsule) {
    this.capsule.copy(capsule)
    this.capsule.start.applyMatrix4(collider.inverse)
    this.capsule.end.applyMatrix4(collider.inverse)
    const hit = capsuleIntersect(this.tree(collider), this.capsule)
    if (!hit || hit.depth < 0.00001) return null
    hit.normal.transformDirection(collider.mesh.matrixWorld)
    return hit
  }

  private capsuleBounds(capsule: Capsule) {
    // Either end may be the lower one: a capsule swept down or back (Dead Ink's flyers) needs the same box as one swept up.
    this.bounds.makeEmpty().expandByPoint(capsule.start).expandByPoint(capsule.end).expandByScalar(capsule.radius)
    return this.bounds
  }

  fits(capsule: Capsule, ignored: readonly THREE.Object3D[] = []) {
    const bounds = this.capsuleBounds(capsule), cells = this.index(), query = ++queries
    for (const collider of this.wide) if (this.obstructs(collider, bounds, capsule, ignored)) return false
    for (let i = Math.floor(bounds.min.x / 8); i <= Math.floor(bounds.max.x / 8); i++) {
      for (let j = Math.floor(bounds.min.z / 8); j <= Math.floor(bounds.max.z / 8); j++) {
        for (const collider of cells.get((i + 32768) * 65536 + j + 32768) ?? none) {
          // A mesh can occupy several of the touched cells.
          if (collider.query === query) continue
          collider.query = query
          if (this.obstructs(collider, bounds, capsule, ignored)) return false
        }
      }
    }
    return true
  }

  private obstructs(collider: Collider, bounds: THREE.Box3, capsule: Capsule, ignored: readonly THREE.Object3D[]) {
    if (!bounds.intersectsBox(collider.bounds)) return false
    for (let object: THREE.Object3D | null = collider.mesh; object; object = object.parent) {
      if (ignored.includes(object)) return false
    }
    const hit = this.collision(collider, capsule)
    return !!hit && hit.depth > 0.008
  }

  resolve(capsule: Capsule, velocity: THREE.Vector3) {
    let grounded = false
    for (let pass = 0; pass < 3; pass++) {
      let touched = false
      for (const collider of this.colliders) {
        if (!this.capsuleBounds(capsule).intersectsBox(collider.bounds)) continue
        const hit = this.collision(collider, capsule)
        if (!hit) continue
        touched = true
        if (hit.normal.y > 0.55) grounded = true
        capsule.translate(this.offset.copy(hit.normal).multiplyScalar(hit.depth + 0.00001))
        const intoSurface = velocity.dot(hit.normal)
        if (intoSurface < 0) velocity.addScaledVector(hit.normal, -intoSurface)
      }
      if (!touched) break
    }
    return grounded
  }

  /** Small support footprint handles stair treads and the edges of platforms. */
  floor(position: THREE.Vector3, above: number, below: number, radius = 0) {
    let height = -Infinity
    const top = position.y + above, bottom = top - (above + below), samples = radius ? 5 : 1
    for (let sample = 0; sample < samples; sample++) {
      // Centre, then ±X and ±Z of the support footprint.
      const x = position.x + (sample === 1 ? radius : sample === 2 ? -radius : 0)
      const z = position.z + (sample === 3 ? radius : sample === 4 ? -radius : 0)
      this.ray.ray.origin.set(x, top, z)
      this.ray.ray.direction.set(0, -1, 0)
      this.ray.near = 0
      this.ray.far = above + below
      const local = this.cell(x, z)
      for (let pass = 0; pass < 2; pass++) for (const collider of pass ? local : this.wide) {
        // A vertical ray meets a box exactly when its column does.
        const { min, max } = collider.bounds
        if (max.y < bottom || min.y > top || x < min.x || x > max.x || z < min.z || z > max.z) continue
        this.groundRay.copy(this.ray.ray).applyMatrix4(collider.inverse)
        this.faceCount = 0
        this.collect(this.tree(collider), this.groundRay)
        // Octree.rayIntersect's nearest front face, with its arithmetic, minus its allocations.
        let nearest: THREE.Triangle | null = null, distance = 1e100
        for (let i = 0; i < this.faceCount; i++) {
          const face = this.faces[i]
          if (!this.groundRay.intersectTriangle(face.a, face.b, face.c, true, this.rayPoint)) continue
          const along = this.rayPoint.sub(this.groundRay.origin).length()
          if (distance > along) { distance = along; nearest = face; this.nearestPoint.copy(this.rayPoint).add(this.groundRay.origin) }
        }
        if (!nearest || distance > this.ray.far) continue
        nearest.getNormal(this.normal).transformDirection(collider.mesh.matrixWorld)
        if (this.normal.dot(up) > 0.55) height = Math.max(height, this.nearestPoint.applyMatrix4(collider.mesh.matrixWorld).y)
      }
    }
    return height
  }

  visible(from: THREE.Vector3, to: THREE.Vector3, target: THREE.Object3D) {
    this.ray.ray.origin.copy(from)
    this.ray.ray.direction.copy(to).sub(from).normalize()
    this.ray.near = 0.02
    this.ray.far = Math.max(0.02, from.distanceTo(to) - 0.06)
    for (const collider of this.colliders) {
      if (!collider.blocksSight) continue
      let ignored = false
      for (let object: THREE.Object3D | null = collider.mesh; object; object = object.parent) {
        if (object === target) { ignored = true; break }
      }
      if (!ignored && this.reaches(collider) && this.blocksRay(collider)) return false
    }
    return true
  }

  /** The ray is unbounded for Ray.intersectsBox; a 0.3 m muzzle probe must not visit everything along its line. */
  private reaches(collider: Collider) {
    return collider.bounds.distanceToPoint(this.ray.ray.origin) <= this.ray.far + 1e-4 && this.ray.ray.intersectsBox(collider.bounds)
  }

  /** Mesh.raycast visits every triangle, so large fixed meshes (ladders, vegetation, catwalks) use their triangle tree. */
  private large(collider: Collider) {
    const geometry = collider.mesh.geometry
    return !collider.dynamic && (geometry.index ?? geometry.getAttribute('position')).count > 768
  }

  /** Any face between the ray's near and far, with Mesh.raycast's per-face test. */
  private blocksRay(collider: Collider) {
    const { mesh } = collider, material = mesh.material
    if (Array.isArray(material) || !this.large(collider)) return this.ray.intersectObject(mesh, false).length > 0
    this.groundRay.copy(this.ray.ray).applyMatrix4(collider.inverse)
    this.faceCount = 0
    this.collect(this.tree(collider), this.groundRay)
    for (let i = 0; i < this.faceCount; i++) {
      const face = this.faces[i]
      const hit = material.side === THREE.BackSide ? this.groundRay.intersectTriangle(face.c, face.b, face.a, true, this.rayPoint) :
        this.groundRay.intersectTriangle(face.a, face.b, face.c, material.side === THREE.FrontSide, this.rayPoint)
      if (!hit) continue
      const along = hit.applyMatrix4(mesh.matrixWorld).distanceTo(this.ray.ray.origin)
      if (along >= this.ray.near && along <= this.ray.far) return true
    }
    return false
  }

  /** Nearest ballistic surface. Wire panels block bodies, but let shots pass. */
  rayDistance(origin: THREE.Vector3, direction: THREE.Vector3, range: number) {
    this.ray.set(origin, direction)
    this.ray.near = 0.01
    this.ray.far = range
    let distance = range
    for (const collider of this.colliders) {
      if (!collider.blocksShots) continue
      if (!this.reaches(collider)) continue
      if ((this.spatialRays || this.large(collider)) && !Array.isArray(collider.mesh.material)) {
        this.groundRay.copy(this.ray.ray).applyMatrix4(collider.inverse)
        this.faceCount = 0
        this.collect(this.tree(collider), this.groundRay)
        const side = collider.mesh.material.side
        for (let i = 0; i < this.faceCount; i++) {
          const face = this.faces[i]
          const hit = side === THREE.BackSide ? this.groundRay.intersectTriangle(face.c, face.b, face.a, true, this.rayPoint) :
            this.groundRay.intersectTriangle(face.a, face.b, face.c, side !== THREE.DoubleSide, this.rayPoint)
          if (!hit) continue
          const along = hit.applyMatrix4(collider.mesh.matrixWorld).distanceTo(origin)
          if (along >= this.ray.near && along < distance) distance = along
        }
        continue
      }
      const hit = this.ray.intersectObject(collider.mesh, false)[0]
      if (hit && hit.distance < distance) distance = hit.distance
    }
    return distance
  }

  /** Ballistic contact with the actual face normal, including hinged objects. */
  raySurface(origin: THREE.Vector3, direction: THREE.Vector3, range: number): SurfaceHit | null {
    this.ray.set(origin, direction)
    this.ray.near = 0.01
    this.ray.far = range
    let closest: SurfaceHit | null = null
    for (const collider of this.colliders) {
      if (!collider.blocksShots || !this.reaches(collider)) continue
      const { mesh } = collider, { geometry, material } = mesh
      // Placement casts thousands of short rays against batched buildings. Mesh.raycast
      // scans every triangle for each ray; reuse the same spatial tree as floor/sight
      // queries. Keep Three's path for moving, deformed, or partially drawn geometry.
      const count = (geometry.index ?? geometry.getAttribute('position')).count
      if (this.large(collider) && !Array.isArray(material) &&
        !('isSkinnedMesh' in mesh) && !('isInstancedMesh' in mesh) && !geometry.morphAttributes.position?.length &&
        geometry.drawRange.start === 0 && geometry.drawRange.count >= count) {
        this.groundRay.copy(this.ray.ray).applyMatrix4(collider.inverse)
        this.faceCount = 0
        this.collect(this.tree(collider), this.groundRay)
        let nearest: THREE.Triangle | null = null
        let distance: number = closest?.distance ?? range
        for (let i = 0; i < this.faceCount; i++) {
          const face = this.faces[i]
          const hit = material.side === THREE.BackSide ? this.groundRay.intersectTriangle(face.c, face.b, face.a, true, this.rayPoint) :
            this.groundRay.intersectTriangle(face.a, face.b, face.c, material.side === THREE.FrontSide, this.rayPoint)
          if (!hit) continue
          const along = hit.applyMatrix4(mesh.matrixWorld).distanceTo(origin)
          if (along >= this.ray.near && along < distance) {
            distance = along; nearest = face; this.nearestPoint.copy(hit)
          }
        }
        if (nearest) {
          const localNormal = nearest.getNormal(new THREE.Vector3())
          const normal = localNormal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
          const backFace = normal.dot(direction) > 0
          if (backFace) { normal.negate(); localNormal.negate() }
          const point = this.nearestPoint.clone()
          closest = { distance, point, normal, mesh, backFace,
            localPoint: point.clone().applyMatrix4(collider.inverse), localNormal }
        }
        continue
      }
      const hit = this.ray.intersectObject(collider.mesh, false)[0]
      if (!hit?.face || hit.distance >= (closest?.distance ?? range)) continue
      const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(collider.mesh.matrixWorld))
      const backFace = normal.dot(direction) > 0
      if (backFace) normal.negate()
      closest = { distance: hit.distance, point: hit.point, normal, mesh: collider.mesh, backFace,
        localPoint: hit.point.clone().applyMatrix4(collider.inverse),
        localNormal: hit.face.normal.clone().multiplyScalar(backFace ? -1 : 1) }
    }
    return closest
  }

  /** Local triangles for a small decal; never scan/project a whole batched building. */
  surfacePatch(hit: SurfaceHit, radius: number) {
    const collider = this.colliders.find(candidate => candidate.mesh === hit.mesh)
    const geometry = new THREE.BufferGeometry(), positions: number[] = [], normals: number[] = []
    if (collider) {
      const sphere = new THREE.Sphere(hit.point.clone(), radius).applyMatrix4(collider.inverse)
      const triangles: THREE.Triangle[] = []
      this.tree(collider).getSphereTriangles(sphere, triangles)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.mesh.matrixWorld)
      for (const triangle of triangles) {
        const normal = triangle.getNormal(new THREE.Vector3())
        const facing = normal.clone().applyNormalMatrix(normalMatrix).dot(hit.normal) * (hit.backFace ? -1 : 1)
        if (facing < 0.2 || triangle.closestPointToPoint(sphere.center, this.rayPoint).distanceToSquared(sphere.center) > sphere.radius ** 2) continue
        for (const point of [triangle.a, triangle.b, triangle.c]) {
          positions.push(point.x, point.y, point.z); normals.push(normal.x, normal.y, normal.z)
        }
      }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    return geometry
  }

  /** A local query view shares geometry/trees, but never owns their resources.
   * Dynamic leaves stay enrolled even outside the region because doors can swing in.
   * Callers must keep their entire query inside bounds; the main world's refresh
   * updates the shared dynamic matrices before any view is used. */
  region(bounds: THREE.Box3) {
    const view = new CollisionWorld(new THREE.Group())
    view.spatialRays = true
    view.colliders = this.colliders.filter(collider => collider.dynamic || bounds.intersectsBox(collider.bounds))
    view.cells = null
    return view
  }

  dispose() {
    for (const mesh of this.proxies) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.colliders = []
    this.cells = null
    this.proxies = []
  }
}
