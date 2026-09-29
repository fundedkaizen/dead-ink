import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Draft, wallText, type Point } from '../../render/ink'
import { synthOutput } from '../ui-slot-sound'

/**
 * The extraction helicopter, drawn in ink in as much detail as the style carries: a shaped fuselage and nose,
 * a framed cockpit with see-through glass, seats and two pilots, sliding side doors, skids on struts, an
 * engine cowling with intakes, vents and exhausts, a tail boom with its fin, stabiliser and tail rotor,
 * panel lines and rivets, a blinking anti-collision beacon, red and green navigation lights, a searchlight
 * with its beam, and a winch with a rope. The rotors spin up and smear into an ink disc at speed.
 *
 * Cheap on phones: each static part is one Draft (a draw per fill and one for its ink), the rivets are one
 * instanced mesh, and only the rotors, doors, rope and lights move.
 *
 * Origin: on the ground between the skids; the nose points along +Z.
 */
export const HELI_BLUE = 0x2878d0
const INK = 0x0b0b0b


export type HelicopterRig = {
  root: THREE.Group
  body: THREE.Group
  rotor: THREE.Group
  blades: THREE.Group
  disc: THREE.Mesh
  tail: THREE.Group
  doors: [THREE.Group, THREE.Group]
  rope: THREE.Line
  hook: THREE.Object3D
  beacon: THREE.Mesh[]
  searchlight: THREE.Mesh
  passengers: THREE.Group
  /** Rotor speed now, 0 (still) to 1 (flying); set by pose(). */
  rpm: number
  /** The rotor's own angle, advanced by pose(). */
  spin: number
}

const blackMaterial = new THREE.MeshBasicMaterial({ color: INK, toneMapped: false })
const glassMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
const blueMaterial = new THREE.MeshBasicMaterial({ color: HELI_BLUE, toneMapped: false })

/** The cabin seen through an open door: dark, with the bench, a seat back and a strap sketched in grey. */
let doorway: THREE.MeshBasicMaterial | null = null
function doorwayMaterial() {
  if (doorway) return doorway
  doorway = new THREE.MeshBasicMaterial({ color: 0x262626, toneMapped: false })
  if (typeof document === 'undefined') return doorway
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const c = canvas.getContext('2d')
  if (!c) return doorway
  c.fillStyle = '#262626'; c.fillRect(0, 0, 128, 128)
  c.strokeStyle = '#8a8a8a'; c.lineWidth = 2
  c.strokeRect(14, 70, 100, 16)
  c.strokeRect(20, 30, 36, 40); c.strokeRect(72, 30, 36, 40)
  c.beginPath(); c.moveTo(64, 0); c.lineTo(64, 28); c.moveTo(0, 100); c.lineTo(128, 100); c.stroke()
  c.strokeStyle = '#5a5a5a'; c.beginPath(); c.moveTo(38, 30); c.lineTo(38, 70); c.moveTo(90, 30); c.lineTo(90, 70); c.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  doorway.map = texture
  doorway.color.setHex(0xffffff)
  return doorway
}

function smooth(draft: Draft, geometry: THREE.BufferGeometry, p: Point, rotation: Point = [0, 0, 0]) {
  draft.solid(geometry, p, 'paper', false, rotation, true)
}

/** An ink smear for a rotor at speed: two faint blade arcs over a pale disc. */
function smearTexture() {
  if (typeof document === 'undefined') return null
  const size = 256, canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const c = canvas.getContext('2d')
  if (!c) return null
  c.translate(size / 2, size / 2)
  c.fillStyle = 'rgba(20,20,20,0.10)'
  c.beginPath(); c.arc(0, 0, size / 2 - 2, 0, Math.PI * 2); c.fill()
  c.strokeStyle = 'rgba(10,10,10,0.55)'
  for (const [start, width] of [[0, 0.9], [Math.PI, 0.9], [Math.PI / 2, 0.45], [Math.PI * 1.5, 0.45]] as const) {
    for (let r = size * 0.14; r < size / 2 - 3; r += 3) {
      c.globalAlpha = 0.35 + 0.4 * (r / (size / 2))
      c.lineWidth = 1.4
      c.beginPath(); c.arc(0, 0, r, start, start + width * (0.4 + r / size)); c.stroke()
    }
  }
  c.globalAlpha = 1
  c.lineWidth = 2
  c.beginPath(); c.arc(0, 0, size / 2 - 3, 0, Math.PI * 2); c.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** A seated passenger's silhouette in a player's colour (the team aboard, as it lifts off). */
function passenger(color: number) {
  const figure = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({ color, toneMapped: false })
  const part = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0) => {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.rotation.x = rx; figure.add(mesh); return mesh
  }
  part(new THREE.CapsuleGeometry(0.17, 0.42, 4, 8), 0, 0.42, 0)
  part(new THREE.SphereGeometry(0.15, 12, 8), 0, 0.95, 0.03)
  for (const x of [-0.1, 0.1]) part(new THREE.CapsuleGeometry(0.06, 0.4, 3, 6), x, 0.12, 0.24, Math.PI / 2)
  for (const x of [-0.1, 0.1]) part(new THREE.CapsuleGeometry(0.055, 0.36, 3, 6), x, -0.18, 0.46)
  return figure
}

/** Merge shapes (each with its own place and turn) into one geometry: one draw for many small solid parts. */
function mergedShapes(parts: { shape: THREE.BufferGeometry; at: Point; turn?: Point; scale?: Point; color?: number }[], colors = false) {
  const placed = parts.map(({ shape, at, turn = [0, 0, 0], scale = [1, 1, 1], color }) => {
    const g = shape.index ? shape.toNonIndexed() : shape
    g.deleteAttribute('uv'); g.deleteAttribute('normal')
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn)), new THREE.Vector3(...scale)))
    if (colors) {
      const c = new THREE.Color(color ?? 0xffffff), count = g.getAttribute('position').count, tint = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) { tint[i * 3] = c.r; tint[i * 3 + 1] = c.g; tint[i * 3 + 2] = c.b }
      g.setAttribute('color', new THREE.BufferAttribute(tint, 3))
    }
    return g
  })
  const merged = mergeGeometries(placed)!
  placed.forEach(g => g.dispose())
  return merged
}

export function createHelicopter(): HelicopterRig {
  const root = new THREE.Group()
  root.name = 'Extraction helicopter'
  root.userData = { noCollision: true, kind: 'helicopter' }
  const body = new THREE.Group()
  root.add(body)

  // ---- everything that never moves, in one drawing: fuselage, nose, belly, engine deck, boom, fin and
  // stabiliser, skids and struts, intakes, vents and exhausts, mast, panel lines, rails, steps, boom seams, the
  // canopy frame, wipers, cockpit seats and console, the side windows, the searchlight housing and the winch.
  const hull = new Draft('Helicopter hull')
  smooth(hull, new RoundedBoxGeometry(2.3, 1.85, 3.9, 4, 0.5), [0, 1.78, 0])
  const nose = new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI)
  nose.scale(1.08, 0.86, 1.45)
  smooth(hull, nose, [0, 1.62, 1.72])
  smooth(hull, new RoundedBoxGeometry(1.6, 0.35, 3.2, 3, 0.15), [0, 0.92, 0.2])
  smooth(hull, new RoundedBoxGeometry(1.35, 0.62, 2.4, 3, 0.25), [0, 2.95, -0.35])
  smooth(hull, new THREE.CylinderGeometry(0.2, 0.46, 5.8, 20, 1), [0, 2.12, -4.55], [-Math.PI / 2 + 0.05, 0, 0])
  const finShape = new THREE.Shape()
  finShape.moveTo(0, 0); finShape.lineTo(0.95, 0.15); finShape.lineTo(1.05, 1.45); finShape.lineTo(0.55, 1.5); finShape.lineTo(0.05, 0.55); finShape.closePath()
  const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.12, bevelEnabled: false })
  fin.translate(0, 0, -0.06)
  hull.solid(fin, [0, 2.15, -6.55], 'paper', 'edge', [0, -Math.PI / 2, 0])
  hull.box(2.1, 0.07, 0.55, 0, 2.18, -5.9, 'paper', 'edge')
  for (const x of [-1.05, 1.05]) hull.box(0.07, 0.36, 0.5, x, 2.2, -5.9, 'paper', 'detail')
  for (const x of [-1.22, 1.22]) {
    hull.beam([x, 0.1, -1.8], [x, 0.1, 2.25], 0.1, 'paper', 'edge')
    hull.beam([x, 0.1, 2.25], [x, 0.36, 2.72], 0.1, 'paper', 'edge')
    for (const z of [-1.05, 1.35]) hull.beam([x, 0.13, z], [x * 0.68, 0.88, z], 0.08, 'paper', 'detail')
  }
  for (const side of [-1, 1]) {
    hull.box(0.08, 0.34, 0.6, side * 0.7, 2.98, 0.45, 'paper', 'detail')
    hull.hatch([side * 0.745, 2.84, 0.18], [0, 0, 0.55], [0, 0.28, 0], { spacing: 0.06, inset: 0.02, stroke: 'detail' })
    hull.hatch([side * 0.69, 2.78, -1.05], [0, 0, 0.9], [0, 0.34, 0], { spacing: 0.05, inset: 0.02 })
    hull.cylinder(0.13, 0.42, side * 0.45, 3.05, -1.62, 'paper', 0.11)
    hull.ring(0.09, 3.26, side * 0.45, -1.62, 'detail', 16)
  }
  hull.cylinder(0.12, 0.55, 0, 3.52, 0.05, 'paper')
  hull.box(0.5, 0.16, 0.5, 0, 0.72, -0.9, 'paper', 'detail')
  for (const side of [-1, 1]) {
    const x = side * 1.155
    for (const z of [-1.55, -0.55, 1.35]) hull.line([[x, 1.02, z], [x, 2.55, z]], 'mesh')
    hull.line([[x, 1.28, -1.8], [x, 1.28, 1.7]], 'mesh')
    hull.line([[x, 2.55, -1.8], [x, 2.55, 1.6]], 'mesh')
    hull.line([[x + side * 0.03, 2.47, -1.7], [x + side * 0.03, 2.47, 1.25]], 'detail')
    hull.line([[x + side * 0.03, 1.05, -1.7], [x + side * 0.03, 1.05, 1.25]], 'detail')
    hull.box(0.34, 0.05, 0.8, side * 1.35, 0.72, 0.4, 'paper', 'detail')
    hull.beam([side * 1.15, 0.9, 0.4], [side * 1.35, 0.74, 0.4], 0.04, 'paper', 'detail')
    // The rear cabin window, glazed and hatched, with its frame.
    hull.box(0.02, 0.55, 0.75, side * 1.162, 2.05, -1.1, 'glass', 'detail')
    hull.hatch([side * 1.175, 1.82, -1.4], [0, 0, 0.3], [0, 0.4, 0], { spacing: 0.08, inset: 0.02 })
    hull.line([[side * 1.176, 1.77, -1.48], [side * 1.176, 2.33, -1.48], [side * 1.176, 2.33, -0.72], [side * 1.176, 1.77, -0.72]], 'detail', true)
  }
  for (const z of [-2.6, -4.2, -5.6]) {
    const r = 0.44 - (Math.abs(z) - 2.2) * 0.058
    hull.line(Array.from({ length: 24 }, (_, i): Point => [Math.sin(i / 24 * Math.PI * 2) * r, 2.12 + Math.cos(i / 24 * Math.PI * 2) * r, z]), 'mesh', true)
  }
  // Canopy frame on the nose, wipers, the two seats and the console behind the glass.
  const onNose = (theta: number, phi: number): Point => {
    const x = Math.sin(phi) * Math.sin(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.cos(theta)
    return [x * 1.08 * 1.04, 1.62 + y * 0.86 * 1.04, 1.72 + z * 1.45 * 1.04]
  }
  for (const theta of [-1.25, -0.55, 0, 0.55, 1.25]) {
    const points: Point[] = []
    for (let phi = 0.36; phi <= 1.62; phi += 0.09) points.push(onNose(theta, phi))
    for (let i = 1; i < points.length; i++) hull.beam(points[i - 1], points[i], 0.045, 'paper', 'detail')
  }
  for (const phi of [0.38, 1.6]) {
    const points: Point[] = []
    for (let theta = -1.3; theta <= 1.3; theta += 0.13) points.push(onNose(theta, phi))
    for (let i = 1; i < points.length; i++) hull.beam(points[i - 1], points[i], 0.04, 'paper', 'detail')
  }
  for (const x of [-0.3, 0.3]) hull.line([[x, 1.62, 3.1], [x * 1.5, 2.02, 2.95]], 'detail')
  for (const x of [-0.45, 0.45]) {
    hull.box(0.5, 0.1, 0.5, x, 1.18, 1.35, 'paper', 'detail')
    hull.box(0.5, 0.75, 0.1, x, 1.58, 1.1, 'paper', 'detail')
  }
  hull.box(0.9, 0.5, 0.25, 0, 1.45, 2.35, 'paper', 'detail')
  // The searchlight housing under the nose, and the winch over the right door.
  hull.solid(new THREE.CylinderGeometry(0.14, 0.14, 0.22, 16), [0, 0.85, 2.35], 'paper', 'edge', [Math.PI / 2 + 0.6, 0, 0], true)
  hull.beam([1.12, 2.62, 1.0], [1.62, 2.66, 1.0], 0.08, 'paper', 'detail')
  hull.beam([1.12, 2.3, 1.0], [1.5, 2.64, 1.0], 0.05, 'paper', 'detail')
  hull.cylinder(0.09, 0.12, 1.62, 2.58, 1.0, 'paper')
  body.add(hull.finish())

  // ---- flat colour, merged: the blue stripes (either side of each doorway), the doorway interiors behind
  // the doors, the pilots, and RESCUE on the boom (one draw each).
  const stripes: { shape: THREE.BufferGeometry; at: Point }[] = []
  for (const side of [-1, 1]) for (const [from, to] of [[-1.85, -0.3], [1.12, 1.75]]) stripes.push({ shape: new THREE.BoxGeometry(0.02, 0.16, to - from), at: [side * 1.162, 1.42, (from + to) / 2] })
  body.add(new THREE.Mesh(mergedShapes(stripes), blueMaterial))
  const openings = [-1, 1].map(side => {
    const plane = new THREE.PlaneGeometry(1.3, 1.3)
    plane.rotateY(side * Math.PI / 2); plane.translate(side * 1.14, 1.76, 0.42)
    return plane
  })
  const doorway = mergeGeometries(openings)!
  body.add(new THREE.Mesh(doorway, doorwayMaterial()))
  const pilots: { shape: THREE.BufferGeometry; at: Point; scale?: Point }[] = []
  for (const x of [-0.45, 0.45]) {
    pilots.push({ shape: new THREE.CapsuleGeometry(0.16, 0.38, 4, 8), at: [x, 1.62, 1.28] })
    pilots.push({ shape: new THREE.SphereGeometry(0.15, 12, 8), at: [x, 2.08, 1.32] })
    pilots.push({ shape: new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), at: [x, 2.1, 1.3], scale: [1, 1, 1.05] })
  }
  body.add(new THREE.Mesh(mergedShapes(pilots), blackMaterial))
  const lettering = wallText('RESCUE', [0, 0, 0], 0.26)
  const letterPlane = lettering.children[0] as THREE.Mesh | undefined
  if (letterPlane) {
    const planes = [-1, 1].map(side => { const g = letterPlane.geometry.clone(); g.rotateY(side * Math.PI / 2); g.translate(side * 0.37, 2.18, -3.9); return g })
    body.add(new THREE.Mesh(mergeGeometries(planes)!, letterPlane.material))
  }

  // ---- the canopy's see-through glass
  const glass = new THREE.SphereGeometry(1.03, 24, 12, -Math.PI * 0.42 + Math.PI / 2, Math.PI * 0.84, Math.PI * 0.12, Math.PI * 0.4)
  glass.scale(1.08, 0.86, 1.45)
  const canopy = new THREE.Mesh(glass, glassMaterial)
  canopy.position.set(0, 1.62, 1.72)
  canopy.renderOrder = 2
  body.add(canopy)

  // ---- sliding doors: each one drawing (panel, glazed window and its frame, handle), sliding back on its rail
  const doors: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const door = new THREE.Group()
    const panel = new Draft(`Helicopter ${side > 0 ? 'right' : 'left'} door`)
    panel.box(0.05, 1.36, 1.35, 0, 0, 0, 'paper', 'edge')
    panel.line([[side * 0.03, -0.62, -0.6], [side * 0.03, -0.62, 0.6]], 'mesh')
    panel.box(0.06, 0.05, 0.22, side * 0.03, -0.1, 0.5, 'paper', 'detail')
    panel.box(0.012, 0.45, 0.8, side * 0.03, 0.3, 0, 'glass', 'detail')
    panel.hatch([side * 0.04, 0.12, -0.35], [0, 0, 0.3], [0, 0.35, 0], { spacing: 0.08, inset: 0.02 })
    for (const y of [0.07, 0.53]) panel.line([[side * 0.04, y, -0.4], [side * 0.04, y, 0.4]], 'detail')
    for (const z of [-0.4, 0.4]) panel.line([[side * 0.04, 0.07, z], [side * 0.04, 0.53, z]], 'detail')
    for (let i = 0; i < 6; i++) panel.box(0.01, 0.018, 0.018, side * 0.03, -0.66, -0.6 + i * 0.24, 'paper', 'detail')
    door.add(panel.finish())
    door.position.set(side * 1.19, 1.76, 0.42)
    door.userData.closedZ = 0.42
    body.add(door)
    doors.push(door)
  }

  // ---- rivets: one instanced mesh along the seams
  const rivetPoints: THREE.Vector3[] = []
  for (const side of [-1, 1]) {
    for (let z = -1.75; z <= 1.6; z += 0.22) { rivetPoints.push(new THREE.Vector3(side * 1.16, 1.2, z), new THREE.Vector3(side * 1.16, 2.62, z)) }
    for (let y = 1.1; y <= 2.5; y += 0.2) rivetPoints.push(new THREE.Vector3(side * 1.16, y, -1.62), new THREE.Vector3(side * 1.16, y, 1.42))
  }
  for (let z = -2.2; z >= -6.4; z -= 0.3) for (const a of [0.6, -0.6]) {
    const r = 0.45 - (Math.abs(z) - 2.2) * 0.058
    rivetPoints.push(new THREE.Vector3(Math.sin(a) * r, 2.12 + Math.cos(a) * r, z))
  }
  const rivets = new THREE.InstancedMesh(new THREE.SphereGeometry(0.018, 6, 4), blackMaterial, rivetPoints.length)
  const matrix = new THREE.Matrix4()
  rivetPoints.forEach((point, i) => rivets.setMatrixAt(i, matrix.makeTranslation(point.x, point.y, point.z)))
  body.add(rivets)

  // ---- lights: the blinking beacon (top and belly, one mesh), the red and green navigation lights (one
  // mesh, coloured per light), and the searchlight's beam
  const beacon = new THREE.Mesh(mergedShapes([{ shape: new THREE.SphereGeometry(0.08, 10, 8), at: [0, 3.3, -1.3] }, { shape: new THREE.SphereGeometry(0.08, 10, 8), at: [0, 0.62, -0.3] }]),
    new THREE.MeshBasicMaterial({ color: 0xe0271e, toneMapped: false }))
  body.add(beacon)
  const nav = new THREE.Mesh(mergedShapes([{ shape: new THREE.SphereGeometry(0.06, 8, 6), at: [-1.08, 2.22, -5.9], color: 0xe0271e },
    { shape: new THREE.SphereGeometry(0.06, 8, 6), at: [1.08, 2.22, -5.9], color: 0x21b04b }], true), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }))
  body.add(nav)
  const beamGeometry = new THREE.ConeGeometry(1.1, 9, 20, 1, true)
  beamGeometry.translate(0, -4.5, 0)
  const searchlight = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({ color: 0xffd66b, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }))
  searchlight.position.set(0, 0.8, 2.5)
  searchlight.rotation.x = -0.6
  searchlight.renderOrder = 3
  body.add(searchlight)

  // ---- the winch's rope and hook
  const ropeGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.3, 0)])
  const rope = new THREE.Line(ropeGeometry, new THREE.LineBasicMaterial({ color: INK }))
  rope.position.set(1.62, 2.5, 1.0)
  body.add(rope)
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 12), blackMaterial)
  hook.position.set(1.62, 2.2, 1.0)
  body.add(hook)

  // ---- main rotor: hub, pitch links and four blades in one drawing; and the smear disc for speed
  const rotor = new THREE.Group()
  rotor.position.set(0, 3.82, 0.05)
  const blades = new THREE.Group()
  const bladeDraft = new Draft('Helicopter main rotor')
  bladeDraft.cylinder(0.3, 0.16, 0, 0, 0, 'paper')
  bladeDraft.cylinder(0.08, 0.28, 0, 0.18, 0, 'paper')
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2, c = Math.cos(a), s = Math.sin(a)
    bladeDraft.beam([s * 0.16, -0.14, c * 0.16], [s * 0.3, 0.02, c * 0.3], 0.035, 'paper', 'detail')
    bladeDraft.box(0.2, 0.08, 0.5, s * 0.5, 0, c * 0.5, 'paper', 'edge', [0, a, 0])
    bladeDraft.box(0.34, 0.045, 5.1, s * 3.2, -0.04, c * 3.2, 'paper', 'edge', [0, a, 0])
    bladeDraft.line([[s * 5.55 - c * 0.17, -0.05, c * 5.55 + s * 0.17], [s * 5.55 + c * 0.17, -0.05, c * 5.55 - s * 0.17]], 'detail')
  }
  blades.add(bladeDraft.finish())
  const texture = smearTexture()
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.8, 64), new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }))
  disc.rotation.x = -Math.PI / 2
  disc.position.y = -0.03
  disc.renderOrder = 4
  rotor.add(blades, disc)
  body.add(rotor)

  // ---- tail rotor
  const tail = new THREE.Group()
  tail.position.set(0.2, 2.95, -6.72)
  const tailDraft = new Draft('Helicopter tail rotor')
  tailDraft.cylinder(0.08, 0.1, 0, 0, 0, 'paper')
  for (const sign of [-1, 1]) tailDraft.box(0.03, 0.62, 0.13, 0.03, sign * 0.34, 0, 'paper', 'edge')
  tailDraft.finish()
  tailDraft.rotation.z = Math.PI / 2
  const tailInner = new THREE.Group()
  tailInner.add(tailDraft)
  tail.add(tailInner)
  body.add(tail)

  const passengers = new THREE.Group()
  passengers.visible = false
  body.add(passengers)

  root.userData.rotors = [rotor, tail]
  return { root, body, rotor, blades, disc, tail, doors: doors as [THREE.Group, THREE.Group], rope, hook, beacon: [beacon], searchlight, passengers, rpm: 0, spin: 0 }
}

/** The team in the doorway for the lift-off: one silhouette per player, in their colours. */
export function seatPassengers(rig: HelicopterRig, colors: readonly number[]) {
  for (const child of [...rig.passengers.children]) child.removeFromParent()
  colors.forEach((color, i) => {
    const figure = passenger(color)
    figure.position.set(0.75, 1.02, 0.95 - i * 0.55)
    figure.rotation.y = Math.PI / 2
    rig.passengers.add(figure)
  })
}

export type HeliPose = {
  /** 0 still, ~0.7 idling on the ground, 1 flying, 1.2 lifting off. */
  rpm: number
  /** 0 shut, 1 slid fully open. */
  doors: number
  /** Metres of rope let down (0 reeled in). */
  rope: number
  searchlight: boolean
  /** Nose-down pitch (radians) and bank. */
  pitch: number; roll: number
  time: number
}

/** Pose the rig for this frame: rotors (blades giving way to the smear disc at speed), doors, rope, lights. */
export function poseHelicopter(rig: HelicopterRig, pose: HeliPose, dt: number) {
  rig.rpm += (pose.rpm - rig.rpm) * Math.min(1, dt * 1.6)
  rig.spin += dt * rig.rpm * 30
  rig.rotor.rotation.y = rig.spin
  rig.tail.children[0].rotation.x = rig.spin * 4.6
  const blur = THREE.MathUtils.smoothstep(rig.rpm, 0.55, 0.85)
  ;(rig.disc.material as THREE.MeshBasicMaterial).opacity = blur * 0.85
  rig.disc.rotation.z = -rig.spin * 0.07
  rig.blades.visible = blur < 0.95
  // Blades fade to thin strokes as the smear takes over.
  rig.blades.scale.set(1, 1 - blur * 0.6, 1)
  rig.doors.forEach(door => { door.position.z = (door.userData.closedZ as number) - pose.doors * 1.32 })
  const positions = rig.rope.geometry.getAttribute('position') as THREE.BufferAttribute
  const sway = Math.sin(pose.time * 1.7) * Math.min(0.6, pose.rope * 0.06)
  positions.setXYZ(1, sway, -0.3 - pose.rope, sway * 0.4); positions.needsUpdate = true
  rig.rope.geometry.computeBoundingSphere()
  rig.hook.position.set(1.62 + sway, 2.2 - pose.rope, 1.0 + sway * 0.4)
  const flash = pose.time % 1.1 < 0.12
  for (const light of rig.beacon) light.visible = flash
  rig.searchlight.visible = pose.searchlight
  rig.body.rotation.set(pose.pitch, 0, pose.roll)
}

// ---------------------------------------------------------------- rotor wash

/**
 * The downwash on the ground: ink strokes and dust rings pushed out from under the helicopter, thicker the
 * lower it hovers. Two instanced meshes, a fixed pool.
 */
export class RotorWash {
  private strokes: THREE.InstancedMesh
  private rings: THREE.InstancedMesh
  private items: { ring: boolean; x: number; z: number; y: number; dx: number; dz: number; age: number; life: number; turn: number }[] = []
  private spawn = 0
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private position = new THREE.Vector3()
  private static readonly COUNT = 140

  constructor(scene: THREE.Scene) {
    this.strokes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.01, 0.7), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }), RotorWash.COUNT)
    const ring = new THREE.RingGeometry(0.47, 0.5, 28)
    ring.rotateX(-Math.PI / 2)
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), RotorWash.COUNT)
    for (const mesh of [this.strokes, this.rings]) { mesh.count = 0; mesh.frustumCulled = false; mesh.userData.noCollision = true; mesh.renderOrder = 3; scene.add(mesh) }
  }

  /** `centre`: the ground under the rotor; `strength` 0 to 1 (the rotor's speed and how low it is). */
  update(dt: number, centre: THREE.Vector3 | null, strength: number) {
    if (centre && strength > 0.02) {
      this.spawn += dt * 120 * strength
      while (this.spawn >= 1 && this.items.length < RotorWash.COUNT * 2) {
        this.spawn -= 1
        const angle = Math.random() * Math.PI * 2, start = 1.2 + Math.random() * 2.5
        const speed = 5 + Math.random() * 7
        this.items.push({ ring: Math.random() < 0.35, x: centre.x + Math.sin(angle) * start, z: centre.z + Math.cos(angle) * start, y: centre.y + 0.05,
          dx: Math.sin(angle) * speed, dz: Math.cos(angle) * speed, age: 0, life: 0.7 + Math.random() * 0.8, turn: angle })
      }
    } else this.spawn = 0
    let strokes = 0, rings = 0
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      item.age += dt
      if (item.age >= item.life) { this.items.splice(i, 1); continue }
      item.x += item.dx * dt; item.z += item.dz * dt
      item.dx *= 1 - dt * 1.2; item.dz *= 1 - dt * 1.2
      const t = item.age / item.life
      if (item.ring && rings < RotorWash.COUNT) {
        this.position.set(item.x, item.y + 0.02, item.z)
        this.scale.setScalar(0.3 + t * 1.3)
        this.rings.setMatrixAt(rings++, this.matrix.compose(this.position, this.quaternion.identity(), this.scale))
      } else if (!item.ring && strokes < RotorWash.COUNT) {
        this.position.set(item.x, item.y + 0.03, item.z)
        this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.turn)
        this.scale.set(1, 1, Math.max(0.05, 1 - t))
        this.strokes.setMatrixAt(strokes++, this.matrix.compose(this.position, this.quaternion, this.scale))
      }
    }
    this.strokes.count = strokes; this.rings.count = rings
    this.strokes.instanceMatrix.needsUpdate = true; this.rings.instanceMatrix.needsUpdate = true
  }

  clear() { this.items = []; this.strokes.count = 0; this.rings.count = 0 }

  dispose() {
    for (const mesh of [this.strokes, this.rings]) { mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose() }
  }
}

// ---------------------------------------------------------------- rotor sound

/**
 * The rotor, in synthesis: filtered noise chopped at the blade-pass rate (the "whump"), a low body under it and
 * a thin turbine whine; louder as it comes near, faster as the rotor spins up. Starts on first use.
 */
export class RotorSound {
  private nodes: { context: AudioContext; out: GainNode; chop: GainNode; lfo: OscillatorNode; whine: OscillatorNode; whineGain: GainNode; body: GainNode; sources: AudioScheduledSourceNode[] } | null = null

  private start() {
    const output = synthOutput('effects', 1)
    if (!output) return null
    const { context, out } = output
    out.gain.value = 0
    const length = context.sampleRate * 2, buffer = context.createBuffer(1, length, context.sampleRate), data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    const noise = context.createBufferSource(); noise.buffer = buffer; noise.loop = true
    const low = context.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 520
    const chop = context.createGain(); chop.gain.value = 0.5
    const lfo = context.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 12
    const depth = context.createGain(); depth.gain.value = 0.5
    lfo.connect(depth).connect(chop.gain)
    noise.connect(low).connect(chop).connect(out)
    const hum = context.createOscillator(); hum.type = 'triangle'; hum.frequency.value = 46
    const body = context.createGain(); body.gain.value = 0.25
    hum.connect(body).connect(out)
    const whine = context.createOscillator(); whine.type = 'sine'; whine.frequency.value = 1150
    const whineGain = context.createGain(); whineGain.gain.value = 0.02
    whine.connect(whineGain).connect(out)
    for (const source of [noise, lfo, hum, whine]) source.start()
    this.nodes = { context, out, chop, lfo, whine, whineGain, body, sources: [noise, lfo, hum, whine] }
    return this.nodes
  }

  /** `rpm` 0 to 1.2; `distance` from the listener in metres; `active` false fades it out. */
  update(rpm: number, distance: number, active: boolean) {
    if (!active || rpm <= 0.01) {
      if (this.nodes) this.nodes.out.gain.setTargetAtTime(0, this.nodes.context.currentTime, 0.3)
      return
    }
    const nodes = this.nodes ?? this.start()
    if (!nodes) return
    const t = nodes.context.currentTime
    const level = Math.min(0.9, rpm) * Math.min(1, 22 / (8 + distance)) * 0.55
    nodes.out.gain.setTargetAtTime(level, t, 0.15)
    nodes.lfo.frequency.setTargetAtTime(6 + rpm * 12, t, 0.2)
    nodes.whine.frequency.setTargetAtTime(700 + rpm * 700, t, 0.3)
  }

  dispose() {
    if (!this.nodes) return
    for (const source of this.nodes.sources) { try { source.stop() } catch { /* already stopped */ } }
    this.nodes.out.disconnect()
    this.nodes = null
  }
}
