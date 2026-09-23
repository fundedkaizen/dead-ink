import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { Draft, type Fill, type Point, type Stroke } from '../../render/ink'
import { penRandom, penSeed } from '../../render/ballpoint'
import type { CollisionWorld } from '../../player/collision'
import { ZONE_GATES } from './zones'

/**
 * Dead Ink's apocalypse: debris, knocked-over junk, boarded windows, ink and blood, and scrawled warnings
 * spread over every zone of the compound. All of it is decoration. The root is noCollision, so the baked
 * navigation graph (and its geometry fingerprint) stays valid and nothing here stops a player, a zombie
 * or a bullet. Everything is placed by probing the real map for floors and walls (the set pieces only name
 * a rough spot), so props sit on floors and marks sit flat on walls even if a building moves.
 *
 * Draw calls stay flat however much is added: every 3D prop in a zone batches into that zone's Draft
 * (paper, silhouettes, ink: three calls), and every painted mark on the map (graffiti, splats, prints,
 * the pixel painting) is one quad in a single atlas mesh.
 */

type Random = () => number
type Rect = { name: string; x: [number, number]; z: [number, number] }
type Wall = { base: THREE.Vector3; normal: THREE.Vector3; tangent: THREE.Vector3 }
type Cell = { u0: number; v0: number; u1: number; v1: number; aspect: number }

const ZONES: readonly Rect[] = [
  { name: 'Mess Yard', x: [-76, -12], z: [-48, 24] },
  { name: 'Southwest Stores', x: [-94, -11], z: [24, 74] },
  { name: 'Warehouse Yard', x: [-12, 99], z: [-19, 49] },
  { name: 'Rail Yard', x: [25, 99], z: [-37, -19] },
  { name: 'East Annex', x: [99, 164], z: [-57, 18] },
]
/** runtime.ts SPAWN_POINT. Not imported: runtime imports this file. Big junk stays out of the first view. */
const SPAWN = new THREE.Vector3(-30, 0, -25)

const INK = new THREE.Color(0x000000)
const OLD_INK = new THREE.Color(0x2b2b2b)
const RED = new THREE.Color(0x8c1c13)
const DARK_RED = new THREE.Color(0x5c0e0a)
const WHITE = new THREE.Color(0xffffff)
const UP = new THREE.Vector3(0, 1, 0)
const HAND = '"Ink Free", "Segoe Print", "Chalkboard SE", "Comic Sans MS", cursive'
const STENCIL = '"Arial Black", Impact, "Helvetica Neue", sans-serif'

/** The warnings survivors left. The first line is also read elsewhere below; keep it as it is. */
const GRAFFITI = [
  'THEY RISE WHEN IT GETS DARK', "DON'T OPEN THE ANNEX", '115', 'NO WAY OUT', 'KEEP SHOOTING', 'THE BOX MOVES',
  'HELP US', "THEY'RE BELOW", 'DAY 41', 'RUN',
] as const

// ---------------------------------------------------------------- the painted-mark atlas

/** Every painted mark shares one canvas and one mesh; marks are tinted by vertex colour. */
class DecalSheet {
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private x = 2
  private y = 2
  private row = 0
  private positions: number[] = []
  private uvs: number[] = []
  private colors: number[] = []
  private indices: number[] = []
  /** Cells that did not fit: a sign the sheet needs to grow. */
  overflow = 0

  constructor(readonly size = 2048) {
    if (typeof document === 'undefined') return
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.canvas.height = size
    this.context = this.canvas.getContext('2d')
  }

  cell(width: number, height: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): Cell | null {
    const c = this.context
    if (!c) return null
    const w = Math.ceil(width), h = Math.ceil(height)
    if (this.x + w + 2 > this.size) { this.x = 2; this.y += this.row + 6; this.row = 0 }
    if (this.y + h + 2 > this.size || w + 4 > this.size) { this.overflow++; return null }
    c.save()
    c.translate(this.x, this.y)
    c.beginPath(); c.rect(0, 0, w, h); c.clip()
    c.fillStyle = c.strokeStyle = '#fff'
    draw(c, w, h)
    c.restore()
    const cell = { u0: this.x / this.size, u1: (this.x + w) / this.size, v0: 1 - (this.y + h) / this.size, v1: 1 - this.y / this.size, aspect: w / h }
    this.x += w + 6
    this.row = Math.max(this.row, h)
    return cell
  }

  /** A quad centred on `centre`, spanning the full-length vectors `right` and `up`. */
  quad(cell: Cell | null, centre: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, color: THREE.Color) {
    if (!cell) return
    const first = this.positions.length / 3
    for (const [s, t] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      this.positions.push(centre.x + right.x * s + up.x * t, centre.y + right.y * s + up.y * t, centre.z + right.z * s + up.z * t)
      this.uvs.push(s < 0 ? cell.u0 : cell.u1, t < 0 ? cell.v0 : cell.v1)
      this.colors.push(color.r, color.g, color.b)
    }
    this.indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }

  mesh() {
    if (!this.canvas || !this.positions.length) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    geometry.setIndex(this.indices)
    const texture = new THREE.CanvasTexture(this.canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    // Soft edges without sorting trouble: depth-tested, never depth-written, pulled towards the camera.
    const material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'Dead Ink dressing: painted marks'
    mesh.renderOrder = 3
    mesh.userData.noCollision = true
    return mesh
  }
}

/** A ragged ink blot with thrown droplets; `drips` runs paint down from it, for walls. */
function drawSplat(random: Random, drips: boolean) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    const cx = w / 2, cy = drips ? h * 0.28 : h / 2, radius = Math.min(w, drips ? h * 0.5 : h) * 0.24
    c.beginPath()
    const points: [number, number][] = []
    for (let i = 0; i < 40; i++) {
      const a = i / 40 * Math.PI * 2
      let r = radius * (0.72 + random() * 0.3 + Math.sin(a * 3 + random()) * 0.08)
      if (random() < 0.18) r *= 1.35 + random() * 0.3
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
    points.forEach(([x, y], i) => {
      const [nx, ny] = points[(i + 1) % points.length]
      if (i === 0) c.moveTo((x + nx) / 2, (y + ny) / 2)
      else c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2)
    })
    c.quadraticCurveTo(...points[0], (points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2)
    c.fill()
    for (let i = 0; i < 22; i++) {
      const a = random() * Math.PI * 2, d = radius * (1.05 + random() * 0.95), r = radius * (0.025 + random() * 0.1)
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * (drips ? 0.6 : 1)
      if (random() < 0.35) {
        // A thrown streak, fat at the blot and thin at the tip.
        c.lineCap = 'round'
        c.lineWidth = r * 1.2
        c.beginPath(); c.moveTo(cx + Math.cos(a) * radius * 0.9, cy + Math.sin(a) * radius * 0.9); c.lineTo(x, y); c.stroke()
      }
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill()
    }
    if (!drips) return
    for (let i = 0; i < 6; i++) {
      const x = cx + (random() - 0.5) * radius * 1.6, length = h * (0.25 + random() * 0.45), width = 3 + random() * 7
      c.fillRect(x - width / 2, cy, width, length)
      c.beginPath(); c.arc(x, cy + length, width * 0.8, 0, Math.PI * 2); c.fill()
    }
  }
}

/** A hand pressed flat and dragged down the wall. */
function drawHand(random: Random) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    const cx = w / 2, cy = h * 0.34, s = w / 200
    c.globalAlpha = 0.55
    for (let i = 0; i < 5; i++) {
      const x = cx - 38 * s + i * 19 * s + random() * 4
      c.fillRect(x, cy, 9 * s * (0.6 + random() * 0.6), h * (0.35 + random() * 0.3))
    }
    c.globalAlpha = 1
    c.beginPath(); c.ellipse(cx, cy + 10 * s, 46 * s, 52 * s, 0, 0, Math.PI * 2); c.fill()
    c.lineCap = 'round'
    const fingers: [number, number, number][] = [[-34, -48, 17], [-12, -62, 18], [10, -60, 18], [30, -48, 16]]
    for (const [dx, dy, width] of fingers) {
      c.lineWidth = width * s
      c.beginPath(); c.moveTo(cx + dx * 0.8 * s, cy - 20 * s); c.lineTo(cx + dx * s, cy + dy * s - 12 * s); c.stroke()
    }
    c.lineWidth = 19 * s
    c.beginPath(); c.moveTo(cx + 36 * s, cy + 20 * s); c.lineTo(cx + 74 * s, cy - 14 * s); c.stroke()
  }
}

/** Hand-painted lettering: each letter a little off its neighbours, a few running drips. */
function drawWords(text: string, random: Random, font = HAND, weight = 'bold', drips = true) {
  const px = 72
  const measure = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (measure) measure.font = `${weight} ${px}px ${font}`
  // The hand fonts' own spaces are narrow, and with every letter tilted the words ran together.
  const advanceOf = (c: CanvasRenderingContext2D | null, letter: string) => letter === ' ' ? px * 0.45 : c?.measureText(letter).width ?? px * 0.6
  const width = [...text].reduce((sum, letter) => sum + advanceOf(measure, letter), 0) + px * 0.6
  const height = px * (drips ? 2.1 : 1.45)
  return { width, height, draw: (c: CanvasRenderingContext2D) => {
    c.font = `${weight} ${px}px ${font}`
    c.textBaseline = 'alphabetic'
    let x = px * 0.3
    const baseline = px * 1.12
    for (const letter of text) {
      const advance = advanceOf(c, letter)
      c.save()
      c.translate(x + advance / 2, baseline + (random() - 0.5) * px * 0.08)
      c.rotate((random() - 0.5) * 0.12)
      c.fillText(letter, -advance / 2, 0)
      c.restore()
      if (drips && letter !== ' ' && random() < 0.3) {
        const dx = x + advance * (0.2 + random() * 0.6), length = px * (0.15 + random() * 0.75), dw = 3 + random() * 4
        c.fillRect(dx - dw / 2, baseline - 4, dw, length)
        c.beginPath(); c.arc(dx, baseline - 4 + length, dw * 0.85, 0, Math.PI * 2); c.fill()
      }
      x += advance
    }
  } }
}

// ---------------------------------------------------------------- building in local frames

/** A Draft seen through a transform, so a prop is built at its own origin and lands anywhere. */
class Kit {
  constructor(readonly draft: Draft, readonly matrix: THREE.Matrix4) {}

  static at(draft: Draft, x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0) {
    return new Kit(draft, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')), new THREE.Vector3(1, 1, 1)))
  }

  child(p: Point, rotation: Point = [0, 0, 0]) {
    return new Kit(this.draft, this.matrix.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...p),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1))))
  }

  point(p: Point): Point { return new THREE.Vector3(...p).applyMatrix4(this.matrix).toArray() as Point }

  line(points: Point[], stroke: Stroke = 'edge', close = false) { this.draft.line(points.map(p => this.point(p)), stroke, close) }

  solid(geometry: THREE.BufferGeometry, p: Point = [0, 0, 0], rotation: Point = [0, 0, 0], outline: Stroke | false = 'edge', smooth = false, fill: Fill = 'paper') {
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)))
    geometry.applyMatrix4(this.matrix)
    this.draft.solid(geometry, [0, 0, 0], fill, outline, [0, 0, 0], smooth)
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, rotation: Point = [0, 0, 0], outline: Stroke | false = 'edge') {
    this.solid(new THREE.BoxGeometry(w, h, d), [x, y, z], rotation, outline)
  }

  beam(a: Point, b: Point, width = 0.08, outline: Stroke | false = 'detail') {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start)
    const geometry = new THREE.BoxGeometry(width, delta.length(), width)
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, delta.normalize()))
    this.solid(geometry, start.add(end).multiplyScalar(0.5).toArray() as Point, [0, 0, 0], outline)
  }

  /** A circle of ink in the plane spanned by the local axes `a` and `b`. */
  circle(centre: Point, radius: number, a: 0 | 1 | 2, b: 0 | 1 | 2, stroke: Stroke = 'detail', segments = 20) {
    this.line(Array.from({ length: segments }, (_, i) => {
      const t = i / segments * Math.PI * 2, p: Point = [...centre]
      p[a] += Math.cos(t) * radius; p[b] += Math.sin(t) * radius
      return p
    }), stroke, true)
  }

  hatch(origin: Point, u: Point, v: Point, spacing = 0.12, cross = false) {
    const o = new THREE.Vector3(...this.point(origin))
    const du = new THREE.Vector3(...this.point([origin[0] + u[0], origin[1] + u[1], origin[2] + u[2]])).sub(o)
    const dv = new THREE.Vector3(...this.point([origin[0] + v[0], origin[1] + v[1], origin[2] + v[2]])).sub(o)
    this.draft.hatch(o.toArray() as Point, du.toArray() as Point, dv.toArray() as Point, { spacing, inset: 0.03, cross, stroke: 'detail' })
  }
}

// ---------------------------------------------------------------- props

function plank(k: Kit, length: number, x: number, y: number, z: number, rotation: Point) {
  k.box(length, 0.03, 0.15, x, y, z, rotation)
  const end = k.child([x, y, z], rotation)
  for (const side of [-1, 1]) end.line([[side * (length / 2 - 0.08), 0.017, -0.03], [side * (length / 2 - 0.08), 0.017, 0.03]], 'detail')
}

function plankPile(k: Kit, random: Random) {
  const count = 3 + Math.floor(random() * 4)
  for (let i = 0; i < count; i++) {
    const length = 1.1 + random() * 1.3
    const lean = random() < 0.3 ? 0.12 + random() * 0.18 : 0
    plank(k, length, (random() - 0.5) * 0.8, 0.02 + i * 0.032 + lean * length * 0.3, (random() - 0.5) * 0.8,
      [0, random() * Math.PI, lean])
  }
}

function rubble(k: Kit, random: Random) {
  const bricks = 5 + Math.floor(random() * 9)
  for (let i = 0; i < bricks; i++) {
    const r = random() * 1.1, a = random() * Math.PI * 2, stacked = i < 3 && random() < 0.5
    k.box(0.22, 0.07, 0.11, Math.cos(a) * r, stacked ? 0.105 : 0.035, Math.sin(a) * r, [0, random() * Math.PI, random() < 0.2 ? 0.5 : 0], 'detail')
  }
  const chunks = 2 + Math.floor(random() * 4)
  for (let i = 0; i < chunks; i++) {
    const size = 0.1 + random() * 0.22, shape = new THREE.DodecahedronGeometry(size, 0)
    shape.scale(1.2, 0.55, 0.9)
    k.solid(shape, [(random() - 0.5) * 1.2, size * 0.3, (random() - 0.5) * 1.2], [0, random() * 6, 0], 'landscape')
  }
}

/** A barrel on its side. Returns where its open end spills, in world space. */
function fallenBarrel(k: Kit, random: Random) {
  const r = 0.3, h = 0.9
  const barrel = k.child([0, r, 0], [0, 0, Math.PI / 2])
  barrel.solid(new THREE.CylinderGeometry(r, r, h, 20), [0, 0, 0], [0, 0, 0], false, true)
  for (const y of [-h / 2, h / 2]) barrel.circle([0, y, 0], r, 0, 2, 'edge')
  for (const y of [-h / 4, h / 4]) barrel.circle([0, y, 0], r + 0.006, 0, 2, 'detail')
  // A dent and a few scratches.
  barrel.line([[r * 0.7, -0.1, r * 0.72], [r * 0.5, 0.05, r * 0.87], [r * 0.72, 0.14, r * 0.7]], 'detail')
  if (random() < 0.5) {
    const standing = k.child([0.2 + random() * 0.4, 0.45, 0.75 + random() * 0.3])
    standing.solid(new THREE.CylinderGeometry(r, r, h, 20), [0, 0, 0], [0, 0, 0], false, true)
    for (const y of [-h / 2, h / 2]) standing.circle([0, y, 0], r, 0, 2, 'edge')
    for (const y of [-h / 4, h / 4]) standing.circle([0, y, 0], r + 0.006, 0, 2, 'detail')
  }
  return new THREE.Vector3(...k.point([-h / 2 - 0.55, 0, 0]))
}

function crate(k: Kit, size: number, x: number, z: number, rotation: Point) {
  const c = k.child([x, size / 2, z], rotation), s = size / 2 + 0.004
  c.box(size, size, size, 0, 0, 0)
  for (const [a, b] of [[0, 2], [2, 0]] as const) for (const side of [-1, 1]) {
    // Slats and a brace on each vertical face.
    const face = (u: number, v: number): Point => { const p: Point = [0, v, 0]; p[a] = u; p[b] = side * s; return p }
    for (const v of [-size * 0.18, size * 0.18]) c.line([face(-s, v), face(s, v)], 'detail')
    c.line([face(-s * 0.9, -s * 0.9), face(s * 0.9, s * 0.9)], 'detail')
  }
}

function crates(k: Kit, random: Random) {
  crate(k, 0.8, 0, 0, [0, random() * 0.6, 0])
  // One knocked on its edge, one burst open into slats.
  crate(k, 0.7, 1.0, 0.4, [0, random(), Math.PI / 2 * (0.25 + random() * 0.1)])
  for (let i = 0; i < 3; i++) plank(k, 0.75, -0.9 + random() * 0.4, 0.02 + i * 0.03, 0.6 + random() * 0.5, [0, random() * 3, 0])
}

function bags(k: Kit, random: Random) {
  const duffel = new THREE.SphereGeometry(1, 12, 8)
  duffel.scale(0.42, 0.17, 0.2)
  k.solid(duffel, [0, 0.15, 0], [0, random(), 0], false, true)
  k.line([[-0.3, 0.3, 0], [-0.1, 0.42, 0.05], [0.12, 0.42, 0.05], [0.3, 0.3, 0]], 'detail')
  k.line([[-0.32, 0.31, -0.02], [0.32, 0.31, -0.02]], 'mesh')
  const pack = k.child([0.75, 0.12, 0.35], [-Math.PI / 2 + 0.2, random() * 2, 0])
  pack.box(0.34, 0.44, 0.22, 0, 0, 0)
  pack.box(0.36, 0.16, 0.24, 0, 0.16, 0.01, [0.1, 0, 0], 'detail')
  pack.box(0.24, 0.16, 0.06, 0, -0.08, 0.14, [0, 0, 0], 'detail')
}

function tyres(k: Kit, random: Random) {
  const count = 1 + Math.floor(random() * 3)
  for (let i = 0; i < count; i++) {
    k.solid(new THREE.TorusGeometry(0.3, 0.11, 8, 20), [(random() - 0.5) * 0.15, 0.11 + i * 0.22, (random() - 0.5) * 0.15], [Math.PI / 2, 0, 0], false, true)
  }
  if (random() < 0.6) k.solid(new THREE.TorusGeometry(0.3, 0.11, 8, 20), [0.75, 0.38, 0.1], [0.2, 0, 0.3], false, true)
}

function sandbags(k: Kit, random: Random, length = 2.4) {
  const bag = (x: number, y: number, z: number) => {
    const shape = new THREE.SphereGeometry(1, 10, 6)
    shape.scale(0.3, 0.12, 0.2)
    k.solid(shape, [x, y, z], [0, (random() - 0.5) * 0.3, (random() - 0.5) * 0.1], false, true)
  }
  const n = Math.round(length / 0.56)
  for (let i = 0; i < n; i++) bag(-length / 2 + i * 0.56 + 0.28, 0.11, 0)
  for (let i = 0; i < n - 1; i++) if (random() < 0.8) bag(-length / 2 + i * 0.56 + 0.56, 0.32, (random() - 0.5) * 0.06)
}

function sawhorse(k: Kit) {
  for (const x of [-0.8, 0.8]) {
    k.beam([x, 0, -0.35], [x, 0.9, 0], 0.07)
    k.beam([x, 0, 0.35], [x, 0.9, 0], 0.07)
  }
  k.box(2.0, 0.22, 0.04, 0, 0.85, 0.05)
  for (let i = 0; i < 6; i++) k.line([[-0.95 + i * 0.36, 0.75, 0.072], [-0.8 + i * 0.36, 0.95, 0.072]], 'edge')
}

function papers(k: Kit, random: Random) {
  const count = 4 + Math.floor(random() * 6)
  for (let i = 0; i < count; i++) {
    const sheet = k.child([(random() - 0.5) * 2.2, 0.012 + i * 0.001, (random() - 0.5) * 2.2], [0, random() * Math.PI * 2, 0])
    const w = 0.21, d = 0.29
    sheet.draft.face([sheet.point([-w / 2, 0, -d / 2]), sheet.point([w / 2, 0, -d / 2]), sheet.point([w / 2, 0, d / 2]), sheet.point([-w / 2, 0, d / 2])], 'paper', 'detail')
    for (let line = 0; line < 5; line++) {
      const z = -d / 2 + 0.05 + line * 0.045
      sheet.line([[-w / 2 + 0.03, 0.002, z], [-w / 2 + 0.03 + (0.1 + random() * 0.05), 0.002, z]], 'mesh')
    }
  }
  if (random() < 0.5) {
    const ball = new THREE.DodecahedronGeometry(0.06, 0)
    k.solid(ball, [(random() - 0.5) * 1.5, 0.05, (random() - 0.5) * 1.5], [random(), random(), 0], 'detail')
  }
}

function warningSign(k: Kit, sheet: DecalSheet, cells: Record<string, Cell | null>, random: Random) {
  const fallen = random() < 0.35
  if (fallen) {
    const board = k.child([0, 0.03, 0.2], [-Math.PI / 2, 0, 0.3])
    board.box(0.7, 0.5, 0.03, 0, 0, 0)
    k.beam([-0.3, 0.04, -0.5], [1.4, 0.04, -0.2], 0.07)
    sheet.quad(cells.danger, new THREE.Vector3(...board.point([0, 0.07, 0.02])),
      new THREE.Vector3(...board.point([0.6, 0, 0.02])).sub(new THREE.Vector3(...board.point([0, 0, 0.02]))),
      new THREE.Vector3(...board.point([0, 0.2, 0.02])).sub(new THREE.Vector3(...board.point([0, 0, 0.02]))), RED)
    return
  }
  const tilt = (random() - 0.5) * 0.25
  const post = k.child([0, 0, 0], [0, 0, tilt])
  post.beam([0, 0, 0], [0, 1.95, 0], 0.07)
  post.box(0.7, 0.5, 0.03, 0, 1.68, 0.05)
  const at = (x: number, y: number) => new THREE.Vector3(...post.point([x, y, 0.07]))
  const origin = at(0, 0)
  sheet.quad(cells.danger, at(0, 1.75), at(0.6, 0).sub(origin), at(0, 0.2).sub(origin), RED)
  sheet.quad(cells.keepOut, at(0, 1.55), at(0.5, 0).sub(origin), at(0, 0.13).sub(origin), INK)
}

/** A collapsed heap: rubble, planks and whatever was thrown on top. */
function heap(k: Kit, random: Random) {
  rubble(k, random)
  rubble(k.child([0.9, 0, 0.3]), random)
  plankPile(k.child([0.3, 0.12, -0.2]), random)
  if (random() < 0.5) tyres(k.child([-1.2, 0, 0.4]), random)
  else crate(k, 0.7, -1.1, 0.5, [0, random(), 0])
}

/** Odds and ends dropped in the open: one plank, a couple of bricks, a sheet of paper, a shoe. */
function litter(k: Kit, random: Random) {
  const pick = random()
  if (pick < 0.3) plank(k, 0.8 + random() * 1.2, 0, 0.018, 0, [0, random() * 3, 0])
  else if (pick < 0.55) {
    for (let i = 0; i < 1 + Math.floor(random() * 3); i++) k.box(0.22, 0.07, 0.11, (random() - 0.5) * 0.6, 0.035, (random() - 0.5) * 0.6, [0, random() * 3, 0], 'detail')
  } else if (pick < 0.8) {
    const w = 0.21, d = 0.29, sheet = k.child([0, 0.012, 0], [0, random() * 6, 0])
    k.draft.face([sheet.point([-w / 2, 0, -d / 2]), sheet.point([w / 2, 0, -d / 2]), sheet.point([w / 2, 0, d / 2]), sheet.point([-w / 2, 0, d / 2])], 'paper', 'detail')
    for (let line = 0; line < 4; line++) sheet.line([[-0.07, 0.002, -0.09 + line * 0.05], [0.05, 0.002, -0.09 + line * 0.05]], 'mesh')
  } else if (pick < 0.9) {
    // A lost shoe.
    k.box(0.28, 0.08, 0.1, 0, 0.04, 0, [0, random() * 3, 0], 'detail')
    k.box(0.12, 0.1, 0.1, -0.07, 0.1, 0, [0, 0, 0], 'detail')
  } else {
    // A spent can, rolled on its side.
    k.solid(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10), [0, 0.035, 0], [Math.PI / 2, random() * 3, 0], 'detail')
  }
}

/** A tipped-over hand cart, one wheel in the air. */
function handcart(k: Kit) {
  const cart = k.child([0, 0.62, 0], [0, 0, 1.25])
  cart.box(1.6, 0.06, 0.9, 0, 0, 0)
  for (const z of [-0.45, 0.45]) cart.box(1.6, 0.25, 0.04, 0, 0.14, z, [0, 0, 0], 'detail')
  for (const z of [-0.5, 0.5]) {
    cart.solid(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 18), [0.2, -0.3, z], [Math.PI / 2, 0, 0], false, true)
    cart.circle([0.2, -0.3, z], 0.3, 0, 1, 'edge')
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI
      cart.line([[0.2 - Math.cos(a) * 0.28, -0.3 - Math.sin(a) * 0.28, z], [0.2 + Math.cos(a) * 0.28, -0.3 + Math.sin(a) * 0.28, z]], 'detail')
    }
  }
  cart.beam([-0.8, 0, -0.35], [-1.9, 0.1, -0.35], 0.05)
  cart.beam([-0.8, 0, 0.35], [-1.9, 0.1, 0.35], 0.05)
}

/** A sedan burnt down to its shell: no glass, no tyres, char hatched over every panel. */
function burntCar(k: Kit, random: Random) {
  const body = k.child([0, 0.62, 0])
  body.box(4.3, 0.62, 1.8, 0, 0, 0)
  body.box(1.25, 0.06, 1.72, 1.45, 0.34, 0, [0, 0, -0.08])
  body.box(1.0, 0.05, 1.72, -1.6, 0.32, 0, [0, 0, 0.04])
  for (const side of [-1, 1]) {
    body.hatch([-2.1, -0.28, side * 0.905], [4.2, 0, 0], [0, 0.56, 0], 0.09, true)
    body.line([[0.75, -0.3, side * 0.905], [0.75, 0.3, side * 0.905]], 'detail')
    body.line([[-0.4, -0.3, side * 0.905], [-0.4, 0.3, side * 0.905]], 'detail')
    // Rims only: the tyres burnt away.
    for (const x of [-1.35, 1.35]) {
      body.solid(new THREE.CylinderGeometry(0.24, 0.24, 0.12, 16), [x, -0.3, side * 0.86], [Math.PI / 2, 0, 0], false, true)
      body.circle([x, -0.3, side * 0.93], 0.24, 0, 1, 'edge', 16)
      body.circle([x, -0.3, side * 0.93], 0.1, 0, 1, 'detail', 10)
    }
    // Pillars of the empty cabin.
    body.beam([0.85, 0.31, side * 0.8], [0.35, 0.83, side * 0.68], 0.07, 'edge')
    body.beam([-0.3, 0.31, side * 0.8], [-0.3, 0.83, side * 0.7], 0.07, 'edge')
    body.beam([-1.3, 0.31, side * 0.8], [-0.95, 0.83, side * 0.68], 0.07, 'edge')
  }
  body.box(1.35, 0.05, 1.42, -0.3, 0.86, 0, [0.03, 0, 0.04])
  body.hatch([-0.95, 0.89, -0.68], [1.3, 0, 0], [0, 0, 1.36], 0.1, true)
  body.hatch([0.85, 0.37, -0.82], [1.2, 0, 0], [0, 0, 1.64], 0.1, true)
  // Seat frames, and the driver's door hanging open.
  for (const x of [0.1, -0.8]) body.box(0.5, 0.45, 1.3, x, 0.4, 0, [0, 0, 0.15], 'detail')
  const door = body.child([0.75, 0, 0.9], [0, -0.9, 0])
  door.box(1.1, 0.58, 0.05, -0.55, 0, 0.02)
  door.hatch([-1.05, -0.24, 0.05], [1.0, 0, 0], [0, 0.48, 0], 0.09, true)
  // The bumper, fallen off.
  k.box(1.7, 0.16, 0.1, 2.5, 0.08, 0.3 + random() * 0.3, [0, 0.5, 0])
}

// ---------------------------------------------------------------- stroke marks on walls

const at = (w: Wall, u: number, v: number, off = 0.014) => w.base.clone().addScaledVector(w.tangent, u).addScaledVector(UP, v).addScaledVector(w.normal, off)
const wallLine = (d: Draft, w: Wall, points: [number, number][], stroke: Stroke = 'detail', close = false, off = 0.014) =>
  d.line(points.map(([u, v]) => at(w, u, v, off).toArray() as Point), stroke, close)

function claws(d: Draft, w: Wall, u: number, v: number, random: Random) {
  const tilt = 0.5 + random() * 0.6, length = 0.45 + random() * 0.35
  for (let i = 0; i < 4; i++) {
    const du = u + i * 0.07, dv = v + i * 0.02
    const points: [number, number][] = []
    for (let s = 0; s <= 4; s++) {
      const t = s / 4
      points.push([du + Math.cos(tilt) * length * t + Math.sin(t * Math.PI) * 0.03, dv - Math.sin(tilt) * length * t])
    }
    wallLine(d, w, points, 'edge')
  }
}

function tally(d: Draft, w: Wall, u: number, v: number, groups: number) {
  for (let g = 0; g < groups; g++) {
    const x = u + g * 0.24
    for (let i = 0; i < 4; i++) wallLine(d, w, [[x + i * 0.04, v], [x + i * 0.04 + 0.01, v + 0.2]], 'detail')
    if (g < groups - 1 || groups % 2) wallLine(d, w, [[x - 0.03, v + 0.03], [x + 0.16, v + 0.16]], 'detail')
  }
}

/** Crossed-out days, the last one circled. */
function calendar(d: Draft, w: Wall, u: number, v: number, days: number) {
  const cell = 0.12
  for (let row = 0; row <= 5; row++) wallLine(d, w, [[u, v - row * cell], [u + 7 * cell, v - row * cell]], 'mesh')
  for (let col = 0; col <= 7; col++) wallLine(d, w, [[u + col * cell, v], [u + col * cell, v - 5 * cell]], 'mesh')
  for (let day = 0; day < Math.min(34, days); day++) {
    const x = u + (day % 7) * cell, y = v - Math.floor(day / 7) * cell
    wallLine(d, w, [[x + 0.02, y - 0.02], [x + cell - 0.02, y - cell + 0.02]], 'detail')
    wallLine(d, w, [[x + cell - 0.02, y - 0.02], [x + 0.02, y - cell + 0.02]], 'detail')
  }
  const next = Math.min(34, days)
  const cx = u + (next % 7 + 0.5) * cell, cy = v - (Math.floor(next / 7) + 0.5) * cell
  wallLine(d, w, Array.from({ length: 14 }, (_, i) => [cx + Math.cos(i / 13 * 7) * 0.075, cy + Math.sin(i / 13 * 7) * 0.065] as [number, number]), 'edge')
}

function arrow(d: Draft, w: Wall, u: number, v: number, length: number, direction: 1 | -1) {
  const tip = u + length * direction
  wallLine(d, w, [[u, v], [u + length * 0.5 * direction, v + 0.04], [tip, v]], 'edge')
  wallLine(d, w, [[tip - 0.22 * direction, v + 0.16], [tip, v], [tip - 0.2 * direction, v - 0.15]], 'edge')
}

/** A sprawled body in chalk (ink here: the paper is already white), metres, head up the +y axis. */
const BODY: [number, number][] = [[-0.06, 0.64], [-0.22, 0.6], [-0.5, 0.72], [-0.62, 0.8], [-0.66, 0.74], [-0.52, 0.62], [-0.24, 0.5],
  [-0.18, 0.2], [-0.2, 0], [-0.42, -0.36], [-0.5, -0.72], [-0.42, -0.76], [-0.34, -0.42], [-0.08, -0.08], [0.02, -0.1], [0.2, -0.44],
  [0.34, -0.8], [0.44, -0.78], [0.34, -0.36], [0.2, 0.02], [0.18, 0.3], [0.26, 0.46], [0.52, 0.28], [0.64, 0.1], [0.72, 0.14],
  [0.6, 0.36], [0.3, 0.62], [0.06, 0.64]]

function chalkOutline(d: Draft, x: number, y: number, z: number, angle: number, scale = 1.15) {
  const c = Math.cos(angle), s = Math.sin(angle)
  const p = ([u, v]: [number, number]): Point => [x + (u * c - v * s) * scale, y + 0.016, z + (u * s + v * c) * scale]
  d.line(BODY.map(p), 'detail', true)
  d.line(Array.from({ length: 16 }, (_, i) => p([Math.cos(i / 16 * Math.PI * 2) * 0.12, 0.8 + Math.sin(i / 16 * Math.PI * 2) * 0.13])), 'detail', true)
}

// ---------------------------------------------------------------- finding places on the real map

const EXCLUDED = /gate ·|gate$|door|wall buy|perk|mystery|pack-a-punch|zombie|jeep|transport|truck|wagon|camera|zipline|yard light|tower|trees|fence/i

class Site {
  private capsule = new Capsule()
  private a = new THREE.Vector3()
  private b = new THREE.Vector3()
  constructor(readonly world: CollisionWorld, readonly random: Random, readonly avoid: { point: THREE.Vector3; radius: number }[]) {}

  /** The walkable floor at x, z: ground, room floors and raised platforms, never roofs or crate tops. */
  ground(x: number, z: number) {
    const y = this.world.floor(this.a.set(x, 1.5, z), 0.1, 2.4)
    if (!Number.isFinite(y)) return null
    if (y > 0.3) {
      // Raised floors must be broad (the loading platform), not a crate lid.
      for (const [dx, dz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
        const other = this.world.floor(this.a.set(x + dx, 1.5, z + dz), 0.1, 2.4)
        if (!(Math.abs(other - y) < 0.05)) return null
      }
    }
    return y
  }

  /** Room for something of radius r and height h standing at x, y, z. */
  clear(x: number, y: number, z: number, r: number, h = 1) {
    this.capsule.set(this.a.set(x, y + r + 0.06, z), this.b.set(x, y + Math.max(h, r * 2 + 0.1), z), r)
    return this.world.fits(this.capsule)
  }

  near(x: number, z: number, extra = 0) {
    return this.avoid.some(({ point, radius }) => Math.hypot(point.x - x, point.z - z) < radius + extra)
  }

  private excluded(mesh: THREE.Object3D) {
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
      if (p.userData.doorHinge || p.userData.kind === 'door' || p.userData.kind === 'fence-gate' || p.userData.kind === 'mission-station' || EXCLUDED.test(p.name)) return true
    }
    return false
  }

  /** A vertical wall straight ahead of `origin`, facing back at it. */
  wallFrom(origin: THREE.Vector3, direction: THREE.Vector3, reach: number, floor: number): Wall | null {
    const hit = this.world.raySurface(origin, direction, reach)
    if (!hit || hit.backFace || Math.abs(hit.normal.y) > 0.12 || this.excluded(hit.mesh)) return null
    const normal = hit.normal.clone().setY(0).normalize()
    if (normal.dot(direction) > -0.6) return null
    return { base: hit.point.clone().setY(floor), normal, tangent: new THREE.Vector3(normal.z, 0, -normal.x) }
  }

  /** The wall is one flat face over u0..u1 by v0..v1, and nothing stands in front of it. */
  flat(w: Wall, u0: number, u1: number, v0: number, v1: number) {
    // Stations and doors only matter where they reach: marks up above them are fine.
    const mid = at(w, (u0 + u1) / 2, 0, 0)
    if (v0 < 2.4 && this.near(mid.x, mid.z, (u1 - u0) / 2)) return false
    const into = w.normal.clone().negate()
    // Dense enough along the wall to catch a window or a sign between samples.
    const steps = Math.max(2, Math.ceil((u1 - u0) / 0.5)), samples: [number, number][] = []
    for (let i = 0; i <= steps; i++) for (const v of [v0, (v0 + v1) / 2, v1]) samples.push([u0 + (u1 - u0) * i / steps, v])
    for (const [u, v] of samples) {
      const hit = this.world.raySurface(at(w, u, v, 0.35), into, 0.5)
      if (!hit || hit.backFace || Math.abs(hit.distance - 0.35) > 0.05 || hit.normal.dot(w.normal) < 0.96 || this.excluded(hit.mesh)) return false
    }
    const centre = at(w, (u0 + u1) / 2, (v0 + v1) / 2, 0.05)
    return !this.world.raySurface(centre, w.normal, 0.9)
  }

  /**
   * The nearest wall to (x, z) that takes a patch `width` wide from v0 to v1 above its floor, optionally
   * one whose outward normal points along `facing`. The patch is centred on the returned wall's base.
   */
  findWall(x: number, z: number, width: number, v0: number, v1: number, facing?: [number, number], radius = 7): Wall | null {
    const face = facing ? new THREE.Vector3(facing[0], 0, facing[1]).normalize() : null
    // Neighbouring stands see the same wall: test each patch of it once.
    const tried = new Set<string>()
    for (let r = 0; r <= radius; r += 1.5) {
      const steps = r === 0 ? 1 : 8
      for (let i = 0; i < steps; i++) {
        const sx = x + Math.cos(i / steps * Math.PI * 2) * r, sz = z + Math.sin(i / steps * Math.PI * 2) * r
        const floor = this.ground(sx, sz)
        if (floor === null || !this.clear(sx, floor, sz, 0.25, 1.6)) continue
        const directions = face ? [-0.35, 0, 0.35].map(a => face.clone().negate().applyAxisAngle(UP, a))
          : Array.from({ length: 8 }, (_, j) => new THREE.Vector3(Math.cos(j * Math.PI / 4), 0, Math.sin(j * Math.PI / 4)))
        for (const direction of directions) {
          const wall = this.wallFrom(new THREE.Vector3(sx, floor + (v0 + v1) / 2, sz), direction, 5, floor)
          if (!wall || (face && wall.normal.dot(face) < 0.9)) continue
          const wallFloor = this.ground(wall.base.x + wall.normal.x * 0.4, wall.base.z + wall.normal.z * 0.4)
          if (wallFloor !== null) wall.base.y = wallFloor
          for (const shift of [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2, 2, -3, 3]) {
            const u0 = shift - width / 2, u1 = shift + width / 2
            const key = [wall.normal.x * 4, wall.normal.z * 4, wall.normal.dot(wall.base) * 4, (wall.tangent.dot(wall.base) + shift) * 2].map(Math.round).join()
            if (tried.has(key)) continue
            tried.add(key)
            if (this.flat(wall, u0, u1, v0, v1)) { wall.base.addScaledVector(wall.tangent, shift); return wall }
          }
        }
      }
    }
    return null
  }
}

// ---------------------------------------------------------------- the hidden things

/** A scratched constellation. Its stars are geometry, in the order `SKY_ORDER` picks them. */
const SKY: [number, number][][][] = [
  [[[0.7, 1], [0, 1], [0, 0], [0.7, 0]], [[0, 0.5], [0.5, 0.5]]],
  [[[0, 0], [0, 1], [0.4, 1], [0.7, 0.75], [0.7, 0.25], [0.4, 0], [0, 0]]],
  [[[0, 0], [0, 1], [0.7, 0], [0.7, 1]]],
]
const SKY_ORDER = [0, 1, 0, 2]

function star(d: Draft, w: Wall, u: number, v: number, size: number) {
  wallLine(d, w, [[u - size, v], [u + size, v]], 'detail')
  wallLine(d, w, [[u, v - size], [u, v + size]], 'detail')
  wallLine(d, w, [[u - size * 0.5, v - size * 0.5], [u + size * 0.5, v + size * 0.5]], 'mesh')
  wallLine(d, w, [[u - size * 0.5, v + size * 0.5], [u + size * 0.5, v - size * 0.5]], 'mesh')
}

function constellation(d: Draft, w: Wall, v: number, random: Random) {
  const height = 0.42, pitch = 0.62, left = -(SKY_ORDER.length * pitch) / 2
  SKY_ORDER.forEach((glyph, i) => {
    for (const stroke of SKY[glyph]) {
      const points = stroke.map(([x, y]) => [left + i * pitch + x * height, v + y * height] as [number, number])
      wallLine(d, w, points, 'mesh')
      for (const [pu, pv] of points) star(d, w, pu, pv, 0.035 + random() * 0.02)
    }
  })
  // Loose stars around it, so it reads as sky before it reads as anything else.
  for (let i = 0; i < 14; i++) star(d, w, left - 0.3 + random() * (SKY_ORDER.length * pitch + 0.4), v - 0.25 + random() * (height + 0.5), 0.02 + random() * 0.02)
}

/** Carved heart with an arrow through it. */
function heart(d: Draft, w: Wall, u: number, v: number, size: number) {
  const points: [number, number][] = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40 * Math.PI * 2
    points.push([u + 16 * Math.sin(t) ** 3 / 32 * size, v + (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 32 * size])
  }
  wallLine(d, w, points, 'edge')
  // The arrow passes above the letters.
  const a = v - size * 0.05, b = v + size * 0.45
  wallLine(d, w, [[u - size * 0.85, a], [u + size * 0.85, b]], 'detail')
  wallLine(d, w, [[u + size * 0.85, b], [u + size * 0.7, b + size * 0.03]], 'detail')
  wallLine(d, w, [[u + size * 0.85, b], [u + size * 0.75, b - size * 0.11]], 'detail')
  for (const k of [0, 0.05, 0.1]) wallLine(d, w, [[u - size * 0.85 + k, a + k * 0.38], [u - size * 0.93 + k, a + size * 0.1 + k * 0.38]], 'mesh')
}

/** The Claude Code mascot as pixel graffiti: 18 by 5 cells, each cell twice as tall as wide. */
const MASCOT = ['...############...', '...##o######o##...', '.################.', '...############...', '....#.#....#.#....']

function drawMascot(c: CanvasRenderingContext2D, w: number, h: number) {
  const cols = MASCOT[0].length, px = w / (cols + 2), py = px * 2
  const top = (h - py * MASCOT.length) / 2 - py * 0.3
  MASCOT.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === '.') return
    c.fillStyle = cell === 'o' ? '#111' : '#d97757'
    // Sprayed cells: a hair of overlap so the blocks read as one painted shape.
    c.fillRect(px * (x + 1) - 0.5, top + y * py - 0.5, px + 1, py + 1)
  }))
  c.fillStyle = '#d97757'
  for (const x of [5, 10, 13]) {
    const length = py * (0.4 + (x % 3) * 0.25)
    c.fillRect(px * (x + 1) + px * 0.35, top + 4 * py + py, px * 0.3, length)
  }
}

// ---------------------------------------------------------------- dressing a zone

type Context = {
  site: Site
  random: Random
  sheet: DecalSheet
  cells: Record<string, Cell | null>
  draft: (x: number, z: number) => Draft
  /** What was placed, and which hand-picked pieces found no wall: for checks, on the root's userData. */
  report: { spots: Record<string, number[]>; missing: string[] }
}

const pick = <T,>(random: Random, items: readonly T[]) => items[Math.floor(random() * items.length) % items.length]

function floorDecal(ctx: Context, cell: Cell | null, x: number, y: number, z: number, size: number, color: THREE.Color, angle = ctx.random() * Math.PI * 2) {
  if (!cell) return
  const c = Math.cos(angle), s = Math.sin(angle)
  ctx.sheet.quad(cell, new THREE.Vector3(x, y + 0.014, z), new THREE.Vector3(c, 0, s).multiplyScalar(size * cell.aspect), new THREE.Vector3(-s, 0, c).multiplyScalar(size), color)
}

function wallDecal(ctx: Context, cell: Cell | null, w: Wall, u: number, v: number, height: number, color: THREE.Color, tilt = 0) {
  if (!cell) return
  const right = w.tangent.clone().multiplyScalar(height * cell.aspect).applyAxisAngle(w.normal, tilt)
  const up = UP.clone().multiplyScalar(height).applyAxisAngle(w.normal, tilt)
  ctx.sheet.quad(cell, at(w, u, v, 0.012), right, up, color)
}

/**
 * Painted words on a wall, sized by their letters rather than their canvas cell: `letters` is the capital
 * height in metres and v the height of the letters' middle. Returns the painted width.
 */
function wallWords(ctx: Context, cell: Cell | null, w: Wall, u: number, v: number, letters: number, color: THREE.Color, tilt = 0, drips = false) {
  if (!cell) return 0
  const rows = drips ? 2.1 : 1.45, height = letters * rows / 0.72
  wallDecal(ctx, cell, w, u, v - (rows / 2 - 0.76) / rows * height, height, color, tilt)
  return height * cell.aspect
}

/** Heights for marks on walls: low or high, leaving the band where wall guns and perk machines hang. */
function wallHeight(random: Random, low = 0.25, high = 2.1) {
  return random() < 0.3 ? low + random() * 0.45 : high + random() * 0.8
}

function dressZone(zone: Rect, ctx: Context) {
  const { site, random, cells } = ctx
  const area = (zone.x[1] - zone.x[0]) * (zone.z[1] - zone.z[0])
  const count = (per1000: number) => Math.max(2, Math.round(area / 1000 * per1000))
  const somewhere = () => [zone.x[0] + 1.5 + random() * (zone.x[1] - zone.x[0] - 3), zone.z[0] + 1.5 + random() * (zone.z[1] - zone.z[0] - 3)] as const

  // Junk heaped against walls, where nobody walks, and a little of it in the open.
  const props = [plankPile, rubble, fallenBarrel, crates, bags, tyres, papers, heap, heap, fallenBarrel, rubble] as const
  for (let n = 0, tries = 0; n < count(5.5) && tries < count(5.5) * 8; tries++) {
    const [x, z] = somewhere()
    const floor = site.ground(x, z)
    if (floor === null || site.near(x, z, 1.5) || !site.clear(x, floor, z, 0.4, 1.2)) continue
    let spot = new THREE.Vector3(x, floor, z), yaw = random() * Math.PI * 2, walled = false
    for (let j = 0; j < 8 && !walled; j++) {
      const direction = new THREE.Vector3(Math.cos(j * Math.PI / 4), 0, Math.sin(j * Math.PI / 4))
      const wall = site.wallFrom(new THREE.Vector3(x, floor + 0.5, z), direction, 3.5, floor)
      if (!wall) continue
      const out = 0.7 + random() * 0.5
      spot = wall.base.clone().addScaledVector(wall.normal, out)
      yaw = Math.atan2(-wall.tangent.z, wall.tangent.x) + (random() - 0.5) * 0.5
      walled = true
    }
    const make = walled ? pick(random, props) : pick(random, [rubble, papers, plankPile] as const)
    const sy = site.ground(spot.x, spot.z)
    if (sy === null || Math.abs(sy - floor) > 0.2 || !site.clear(spot.x, sy, spot.z, 0.35, 1) || site.near(spot.x, spot.z, 1.5)) continue
    if (spot.distanceTo(SPAWN.clone().setY(sy)) < 7 && make !== papers) continue
    const spill: unknown = make(Kit.at(ctx.draft(spot.x, spot.z), spot.x, sy, spot.z, yaw), random)
    if (spill instanceof THREE.Vector3) floorDecal(ctx, cells[random() < 0.8 ? 'puddle' : 'splat0'], spill.x, sy, spill.z, 0.9 + random() * 0.5, INK)
    n++
  }

  // Litter over the open ground: small enough to walk through without noticing.
  for (let i = 0; i < count(9); i++) {
    const [x, z] = somewhere()
    const floor = site.ground(x, z)
    if (floor === null || site.near(x, z, 0.5) || !site.clear(x, floor, z, 0.25, 0.5)) continue
    litter(Kit.at(ctx.draft(x, z), x, floor, z, random() * Math.PI * 2), random)
  }

  // Ink and blood on the ground, and a few drag trails.
  for (let i = 0; i < count(8); i++) {
    const [x, z] = somewhere()
    const floor = site.ground(x, z)
    if (floor === null || !site.clear(x, floor, z, 0.2, 0.6)) continue
    const red = random() < 0.22
    floorDecal(ctx, cells[`splat${Math.floor(random() * 6)}`], x, floor, z, 0.35 + random() * 1.2, red ? RED : random() < 0.3 ? OLD_INK : INK)
    if (red && random() < 0.5) {
      const angle = random() * Math.PI * 2, length = 2 + random() * 3
      for (let s = 1; s < 8; s++) {
        const px = x + Math.cos(angle) * length * s / 8, pz = z + Math.sin(angle) * length * s / 8
        const py = site.ground(px, pz)
        if (py === null || Math.abs(py - floor) > 0.1) break
        floorDecal(ctx, cells[`splat${s % 6}`], px, py, pz, 0.28 * (1 - s / 10), DARK_RED, angle)
      }
    }
  }

  // Splats and drips, bloody hands, claws, tallies and crossed-out days on walls.
  for (let i = 0, placed = 0; placed < count(3.5) && i < count(3.5) * 6; i++) {
    const [x, z] = somewhere()
    const floor = site.ground(x, z)
    if (floor === null || !site.clear(x, floor, z, 0.25, 1.6)) continue
    const kind = random()
    const v = kind < 0.2 ? (random() < 0.5 ? 0.5 + random() * 0.4 : 1.85 + random() * 0.4) : kind >= 0.62 && kind < 0.8 ? 2.0 + random() * 0.8 : wallHeight(random)
    const direction = new THREE.Vector3(1, 0, 0).applyAxisAngle(UP, random() * Math.PI * 2)
    const wall = site.wallFrom(new THREE.Vector3(x, floor + v, z), direction, 6, floor)
    if (!wall) continue
    const wy = site.ground(wall.base.x + wall.normal.x * 0.4, wall.base.z + wall.normal.z * 0.4)
    if (wy !== null) wall.base.y = wy
    if (kind < 0.2) {
      // A hand on the wall, reaching high or slid low: always the one colour that means danger.
      if (!site.flat(wall, -0.2, 0.2, v - 0.25, v + 0.25)) continue
      wallDecal(ctx, cells.hand, wall, 0, v, 0.34, random() < 0.75 ? RED : DARK_RED, (random() - 0.5) * 0.4)
      if (random() < 0.5 && site.flat(wall, 0.12, 0.5, v - 0.3, v + 0.2)) wallDecal(ctx, cells.hand, wall, 0.3, v - 0.08, 0.3, RED, (random() - 0.5) * 0.5)
    } else if (kind < 0.62) {
      const size = 0.5 + random() * 0.7
      if (!site.flat(wall, -size / 2, size / 2, v - size * 0.7, v + size * 0.3)) continue
      const red = random() < 0.25
      wallDecal(ctx, cells[`drip${Math.floor(random() * 3)}`], wall, 0, v - size * 0.2, size, red ? RED : INK)
    } else if (kind < 0.8) {
      if (!site.flat(wall, -0.1, 0.8, v - 0.6, v + 0.1)) continue
      claws(ctx.draft(wall.base.x, wall.base.z), wall, 0, v, random)
    } else if (kind < 0.92) {
      if (!site.flat(wall, -0.1, 1.3, v, v + 0.25)) continue
      tally(ctx.draft(wall.base.x, wall.base.z), wall, 0, v, 2 + Math.floor(random() * 4))
    } else {
      if (v < 2 || !site.flat(wall, -0.05, 0.9, v - 0.62, v + 0.05)) continue
      calendar(ctx.draft(wall.base.x, wall.base.z), wall, 0, v, 18 + Math.floor(random() * 16))
    }
    placed++
  }

  // A chalk outline where someone fell, with the stain still under the head.
  for (let i = 0, placed = 0; placed < (area > 6000 ? 2 : 1) && i < 30; i++) {
    const [x, z] = somewhere()
    const floor = site.ground(x, z)
    if (floor === null || site.near(x, z, 1) || !site.clear(x, floor, z, 0.9, 0.5)) continue
    const angle = random() * Math.PI * 2
    chalkOutline(ctx.draft(x, z), x, floor, z, angle)
    floorDecal(ctx, cells.splat2, x - Math.sin(angle) * 0.9, floor, z + Math.cos(angle) * 0.9, 0.7, RED)
    placed++
  }
}

// ---------------------------------------------------------------- hand-picked set pieces

type Piece = {
  text: string; at: [number, number]; facing: [number, number]; v: number; height: number; color: THREE.Color
  extra?: 'arrow' | 'calendar'
  /** Break onto a second line before this word. */
  wrap?: number
}
const mark = (ctx: Context, name: string, w: Wall) => { ctx.report.spots[name] = [w.base.x, w.base.y, w.base.z, w.normal.x, w.normal.z].map(n => Math.round(n * 100) / 100) }

/** Where the survivors wrote their warnings, as places on the plan: the nearest fitting wall is used. */
const WRITING: Piece[] = [
  { text: GRAFFITI[0], at: [-26, -31], facing: [0, 1], v: 4.15, height: 0.5, color: INK, wrap: 2 },
  { text: GRAFFITI[4], at: [-52, -10], facing: [1, 0], v: 2.9, height: 0.3, color: RED },
  { text: GRAFFITI[5], at: [-39, 16], facing: [-1, 0], v: 2.95, height: 0.4, color: INK },
  { text: GRAFFITI[3], at: [-58, 56], facing: [0, -1], v: 2.9, height: 0.62, color: RED, extra: 'arrow' },
  { text: GRAFFITI[2], at: [-76, 52], facing: [1, 0], v: 2.6, height: 0.9, color: INK },
  { text: GRAFFITI[1], at: [86, 23], facing: [0, -1], v: 2.82, height: 0.26, color: RED },
  { text: GRAFFITI[2], at: [25, 5.5], facing: [0, 1], v: 3.2, height: 1.0, color: RED },
  { text: GRAFFITI[4], at: [44, 23.5], facing: [0, -1], v: 3.25, height: 0.35, color: INK },
  { text: GRAFFITI[6], at: [60, -20.5], facing: [0, 1], v: 0.55, height: 0.32, color: RED },
  { text: GRAFFITI[7], at: [129, -15], facing: [1, 0], v: 2.4, height: 0.45, color: INK, extra: 'arrow' },
  { text: GRAFFITI[8], at: [143, -6], facing: [0, -1], v: 3.05, height: 0.36, color: INK, extra: 'calendar' },
  { text: GRAFFITI[2], at: [110, -36], facing: [0, 1], v: 2.4, height: 0.7, color: INK },
  { text: GRAFFITI[9], at: [-66, 8.5], facing: [0, 1], v: 0.5, height: 0.34, color: RED, extra: 'arrow' },
  { text: GRAFFITI[3], at: [70, -19.8], facing: [0, 1], v: 0.6, height: 0.3, color: INK },
]

function setPieces(ctx: Context, cellsFor: (text: string, drips: boolean) => Cell | null) {
  const { site, random } = ctx
  for (const piece of WRITING) {
    const words = piece.text.split(' ')
    const lines = piece.wrap ? [words.slice(0, piece.wrap).join(' '), words.slice(piece.wrap).join(' ')] : [piece.text]
    let cells = lines.map(line => cellsFor(line, true))
    if (cells.some(cell => !cell)) continue
    const width = Math.max(...cells.map(cell => piece.height * 2.1 / 0.72 * cell!.aspect))
    const gap = piece.height * 1.5
    const low = piece.v - (lines.length - 1) * gap - piece.height * 0.6, high = piece.v + piece.height * 0.6
    const wall = site.findWall(piece.at[0], piece.at[1], width + 0.2, low, high, piece.facing)
    if (!wall) { ctx.report.missing.push(piece.text); continue }
    mark(ctx, piece.text, wall)
    // Drips can run ~1.3 letter heights under the words, past what findWall checked: over a window, a
    // door or down onto a wall gun. Keep them only where that stretch of wall is clear as well.
    const drips = site.flat(wall, -width / 2 - 0.1, width / 2 + 0.1, low - piece.height * 1.3, low)
    if (!drips) cells = lines.map(line => cellsFor(line, false))
    cells.forEach((cell, i) => wallWords(ctx, cell, wall, (i - (lines.length - 1) / 2) * piece.height * 0.8, piece.v - i * gap, piece.height, piece.color, (random() - 0.5) * 0.05, drips))
    const d = ctx.draft(wall.base.x, wall.base.z)
    if (piece.extra === 'arrow' && site.flat(wall, width / 2 + 0.1, width / 2 + 1.3, piece.v - 0.3, piece.v + 0.2)) arrow(d, wall, width / 2 + 0.15, piece.v - 0.05, 1.05, 1)
    if (piece.extra === 'calendar' && site.flat(wall, -width / 2 - 1.1, -width / 2 - 0.1, piece.v - 0.9, piece.v)) calendar(d, wall, -width / 2 - 1.0, piece.v + 0.05, 40)
  }

  // Barricades beside every zone gate, never across it.
  for (const gate of ZONE_GATES) {
    const along = new THREE.Vector3(Math.cos(gate.angle), 0, -Math.sin(gate.angle))
    const across = new THREE.Vector3(-along.z, 0, along.x)
    for (const side of [-1, 1]) for (const face of [-1, 1]) {
      if (random() < 0.35) continue
      const p = new THREE.Vector3(gate.centre[0], 0, gate.centre[1]).addScaledVector(along, side * (gate.width / 2 + 1.6 + random() * 1.5)).addScaledVector(across, face * (1.2 + random()))
      const floor = site.ground(p.x, p.z)
      if (floor === null || !site.clear(p.x, floor, p.z, 0.5, 1.2)) continue
      const yaw = Math.atan2(-along.z, along.x) + (random() - 0.5) * 0.4
      const k = Kit.at(ctx.draft(p.x, p.z), p.x, floor, p.z, yaw)
      const choice = random()
      if (choice < 0.4) sandbags(k, random, 1.8 + random())
      else if (choice < 0.7) sawhorse(k)
      else warningSign(k, ctx.sheet, ctx.cells, random)
    }
  }

  // Warning signs out in the yards.
  for (const [x, z] of [[-20, -12], [-80, 40], [20, 20], [115, 5], [140, -30], [80, 10]] as const) {
    for (let i = 0; i < 10; i++) {
      const px = x + (random() - 0.5) * 8, pz = z + (random() - 0.5) * 8, floor = site.ground(px, pz)
      if (floor === null || site.near(px, pz, 1) || !site.clear(px, floor, pz, 0.5, 2)) continue
      warningSign(Kit.at(ctx.draft(px, pz), px, floor, pz, random() * Math.PI * 2), ctx.sheet, ctx.cells, random)
      break
    }
  }

  // A burnt-out car on the access road, seen through the north fence; a hand cart in the rail yard.
  const car = [44, -56.5] as const, carY = site.ground(...car) ?? 0.025
  const road = Kit.at(ctx.draft(60, -30), car[0], carY, car[1], 0.35)
  burntCar(road, random)
  floorDecal(ctx, ctx.cells.puddle, car[0], carY, car[1], 4.2, OLD_INK, 0.35)
  for (let i = 0; i < 20; i++) {
    const x = 40 + random() * 50, z = -21.3 + random() * 1.3, floor = site.ground(x, z)
    if (floor === null || site.near(x, z, 2) || !site.clear(x, floor, z, 0.8, 1.4)) continue
    handcart(Kit.at(ctx.draft(x, z), x, floor, z, Math.PI + (random() - 0.5) * 0.3))
    break
  }
}

/** Planks nailed over windows; now and then one hangs by a nail or lies under the sill. */
function boardWindows(scene: THREE.Object3D, ctx: Context) {
  const { random } = ctx
  const inside = (x: number, z: number) => ZONES.some(zone => x >= zone.x[0] && x <= zone.x[1] && z >= zone.z[0] && z <= zone.z[1])
  const glass: THREE.Mesh[] = []
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.name.endsWith(': glass surfaces')) return
    for (let p: THREE.Object3D | null = object; p; p = p.parent) if (p.userData.noCollision || /truck|jeep|transport|wagon/i.test(p.name) || p.userData.kind === 'static-prop') return
    glass.push(object)
  })
  const a = new THREE.Vector3(), box = new THREE.Box3(), size = new THREE.Vector3()
  for (const mesh of glass) {
    mesh.updateWorldMatrix(true, false)
    const position = mesh.geometry.getAttribute('position')
    const building = new THREE.Box3().setFromObject(mesh.parent ?? mesh).getCenter(new THREE.Vector3())
    // Group the batched glass back into panes: triangles whose bounds touch belong to one window.
    const panes: THREE.Box3[] = []
    for (let i = 0; i + 2 < position.count; i += 3) {
      box.makeEmpty()
      for (let j = 0; j < 3; j++) box.expandByPoint(a.fromBufferAttribute(position, i + j).applyMatrix4(mesh.matrixWorld))
      const touching = panes.filter(pane => pane.clone().expandByScalar(0.01).intersectsBox(box))
      const merged = box.clone()
      for (const pane of touching) { merged.union(pane); panes.splice(panes.indexOf(pane), 1) }
      panes.push(merged)
    }
    for (const pane of panes) {
      pane.getSize(size)
      const thinX = size.x < 0.08 && size.z > 0.5, thinZ = size.z < 0.08 && size.x > 0.5
      if (!(thinX || thinZ) || size.y < 0.4) continue
      const centre = pane.getCenter(new THREE.Vector3())
      if (!inside(centre.x, centre.z) || ctx.site.near(centre.x, centre.z) || random() < 0.25) continue
      const normal = thinX ? new THREE.Vector3(Math.sign(centre.x - building.x) || 1, 0, 0) : new THREE.Vector3(0, 0, Math.sign(centre.z - building.z) || 1)
      const width = thinX ? size.z : size.x, height = size.y
      const tangent = new THREE.Vector3(normal.z, 0, -normal.x)
      const face = centre.clone().addScaledVector(normal, (thinX ? size.x : size.z) / 2 + 0.045)
      const yaw = Math.atan2(-tangent.z, tangent.x)
      const k = Kit.at(ctx.draft(face.x, face.z), face.x, face.y, face.z, yaw)
      const boards = Math.max(2, Math.round(height / 0.34))
      const length = width + 0.3
      for (let i = 0; i < boards; i++) {
        const y = -height / 2 + (i + 0.5) * height / boards + (random() - 0.5) * 0.06
        const loose = i === boards - 1 && random() < 0.2
        // A loose board hangs from its last nail.
        const nail = length / 2 - 0.07, drop = 0.9 + random() * 0.4
        const x = loose ? nail - Math.cos(drop) * length / 2 : 0, cy = loose ? y - Math.sin(drop) * length / 2 : y
        k.box(length, 0.15, 0.03, x, cy, 0, [0, 0, loose ? drop : (random() - 0.5) * 0.22], 'edge')
        if (!loose) for (const side of [-1, 1]) k.line([[side * (length / 2 - 0.07), y - 0.03, 0.017], [side * (length / 2 - 0.07) + 0.02, y + 0.03, 0.017]], 'detail')
      }
      // A cross brace over the lot.
      if (random() < 0.5) k.box(Math.hypot(width, height) + 0.1, 0.14, 0.03, 0, 0, 0.032, [0, 0, Math.atan2(height, width) * (random() < 0.5 ? 1 : -1)], 'edge')
      if (random() < 0.25) {
        const floor = ctx.site.ground(face.x + normal.x * 0.6, face.z + normal.z * 0.6)
        if (floor !== null) plank(Kit.at(ctx.draft(face.x, face.z), face.x + normal.x * 0.6, floor, face.z + normal.z * 0.6, yaw), length, 0, 0.02, 0, [0, (random() - 0.5) * 0.6, 0])
      }
    }
  }
}

/**
 * Small things for whoever looks closely. Each one is built on its own, from its own data, and fails
 * silently: take any of them out and the rest, and the game, carry on.
 */
function secrets(ctx: Context, write: (text: string, font?: string, weight?: string) => Cell | null) {
  const { site, random } = ctx
  const attempt = (name: string, build: () => boolean) => {
    try { if (!build()) ctx.report.missing.push(name) } catch { ctx.report.missing.push(name) }
  }

  // Stars scratched behind the south barracks.
  attempt('stars', () => {
    const wall = site.findWall(15, 47.2, 2.9, 2.0, 2.8, [0, 1])
    if (wall) { constellation(ctx.draft(wall.base.x, wall.base.z), wall, 2.15, random); mark(ctx, 'stars', wall) }
    return !!wall
  })

  // A carved heart on the administration wing, with two names' worth of letters inside.
  attempt('heart', () => {
    const wall = site.findWall(-24, 37, 0.8, 1.9, 2.6, [0, 1])
    if (!wall) return false
    mark(ctx, 'heart', wall)
    heart(ctx.draft(wall.base.x, wall.base.z), wall, 0, 2.25, 0.42)
    const initials = String.fromCharCode(...[0x8a, 0x88, 0x8a, 0x9c].map(value => value >> 1))
    return wallWords(ctx, write(initials, HAND, 'normal'), wall, 0, 2.2, 0.055, OLD_INK) > 0
  })

  // A crate stood up as a headstone in the southwest corner, a plank cross leaning on it.
  attempt('headstone', () => {
    for (let i = 0; i < 24; i++) {
      const x = -84 + (random() - 0.5) * 6, z = 67 + (random() - 0.5) * 5, floor = site.ground(x, z)
      if (floor === null || !site.clear(x, floor, z, 0.6, 1.2)) continue
      const yaw = -0.2 + random() * 0.4
      const k = Kit.at(ctx.draft(x, z), x, floor, z, yaw)
      k.box(0.7, 0.95, 0.45, 0, 0.475, 0)
      k.hatch([-0.33, 0.05, 0.23], [0.66, 0, 0], [0, 0.18, 0], 0.07)
      // The plank cross stands behind it, clear of the label.
      k.beam([0.05, 0, -0.4], [0, 1.45, -0.36], 0.08, 'edge')
      k.beam([-0.36, 1.12, -0.36], [0.36, 1.1, -0.36], 0.08, 'edge')
      const mound = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)
      mound.scale(0.55, 0.18, 1.0)
      k.solid(mound, [0, 0, 1.25], [0, 0, 0], false, true)
      const lot = [14, 13, 14, 23].map(n => n.toString(36)).join('').toUpperCase()
      const label = write(`${lot}-115`, STENCIL, 'normal')
      const face = (u: number, v: number) => new THREE.Vector3(...k.point([u, v, 0.23]))
      if (label) ctx.sheet.quad(label, face(0, 0.6), face(0.55, 0).sub(face(0, 0)), face(0, 0.55 / label.aspect).sub(face(0, 0)), INK)
      const rip = write('R.I.P.', HAND)
      if (rip) ctx.sheet.quad(rip, face(0, 0.8), face(0.4, 0).sub(face(0, 0)), face(0, 0.4 / rip.aspect).sub(face(0, 0)), OLD_INK)
      floorDecal(ctx, ctx.cells.splat4, x, floor, z + Math.cos(yaw) * 1.3, 0.5, DARK_RED)
      ctx.report.spots.headstone = [x, floor, z].map(n => Math.round(n * 100) / 100)
      return true
    }
    return false
  })

  // Tiny letters cut near the floor behind the security cabin, picked out of the first warning.
  attempt('carving', () => {
    const source = GRAFFITI[0], letters = [2, 23, 8, 13].map(i => source[i]).join('')
    if (!/^[A-Z]{4}$/.test(letters)) return false
    const wall = site.findWall(146, -54, 0.4, 0.28, 0.46, [0, -1])
    if (wall) mark(ctx, 'carving', wall)
    return !!wall && wallWords(ctx, write(letters, HAND, 'normal'), wall, 0, 0.36, 0.06, OLD_INK, 0.05) > 0
  })

  // The mascot, in the nook between the east hut and the storage container.
  attempt('mascot', () => {
    const art = ctx.cells.mascot
    const wall = site.findWall(83, 45.8, 1.6, 1.85, 2.75, [0, 1])
    if (!art || !wall) return false
    mark(ctx, 'mascot', wall)
    wallDecal(ctx, art, wall, 0, 2.3, 0.7, WHITE)
    wallWords(ctx, write('Claude', HAND, 'normal'), wall, 0.6, 1.98, 0.09, INK, -0.08)
    return true
  })
}

// ---------------------------------------------------------------- entry point

/**
 * Dress the compound for Dead Ink. Call once the map is built (after the zone gates, so their positions
 * are clear) and, if possible, after the stations are placed, passing where they stand as `keepClear`
 * so no mark or heap covers a wall gun, perk machine or box spot. Returns a function that removes and
 * frees everything this added.
 */
export function addDressing(scene: THREE.Scene, world: CollisionWorld, random: Random = penRandom(penSeed('dead-ink-dressing')),
  keepClear: readonly THREE.Vector3[] = []) {
  const root = new THREE.Group()
  root.name = 'Dead Ink dressing'
  root.userData.noCollision = true
  root.userData.decorative = true

  const avoid = keepClear.map(point => ({ point, radius: 2.2 }))
  for (const gate of ZONE_GATES) avoid.push({ point: new THREE.Vector3(gate.centre[0], 0, gate.centre[1]), radius: gate.width / 2 + 1 })
  scene.traverse(object => {
    if (object.userData.kind === 'door') avoid.push({ point: object.getWorldPosition(new THREE.Vector3()), radius: 1.8 })
  })

  const sheet = new DecalSheet()
  const cells: Record<string, Cell | null> = {}
  for (let i = 0; i < 6; i++) cells[`splat${i}`] = sheet.cell(256, 256, drawSplat(random, false))
  for (let i = 0; i < 3; i++) cells[`drip${i}`] = sheet.cell(224, 336, drawSplat(random, true))
  cells.puddle = sheet.cell(384, 256, drawSplat(random, false))
  cells.hand = sheet.cell(200, 260, drawHand(random))
  cells.mascot = sheet.cell(400, 280, drawMascot)
  const written = new Map<string, Cell | null>()
  const write = (text: string, font = HAND, weight = 'bold', drips = false) => {
    const key = `${text}|${font}|${weight}|${drips}`
    if (!written.has(key)) {
      const words = drawWords(text, random, font, weight, drips)
      written.set(key, sheet.cell(words.width, words.height, words.draw))
    }
    return written.get(key) ?? null
  }
  cells.danger = write('DANGER', STENCIL, 'normal')
  cells.keepOut = write('KEEP OUT', STENCIL, 'normal')

  const report: Context['report'] = { spots: {}, missing: [] }
  root.userData.dressing = report
  const drafts = new Map<string, Draft>()
  const zoneOf = (x: number, z: number) => ZONES.find(zone => x >= zone.x[0] && x <= zone.x[1] && z >= zone.z[0] && z <= zone.z[1]) ?? ZONES[3]
  const draft = (x: number, z: number) => {
    const zone = zoneOf(x, z)
    let d = drafts.get(zone.name)
    if (!d) { d = new Draft(`Dead Ink dressing · ${zone.name}`); d.userData.noCollision = true; drafts.set(zone.name, d) }
    return d
  }

  for (const zone of ZONES) {
    const bounds = new THREE.Box3(new THREE.Vector3(zone.x[0] - 10, -6, zone.z[0] - 10), new THREE.Vector3(zone.x[1] + 10, 30, zone.z[1] + 10))
    const site = new Site(world.region(bounds), random, avoid)
    const ctx: Context = { site, random, sheet, cells, draft, report }
    dressZone(zone, ctx)
  }
  const ctx: Context = { site: new Site(world, random, avoid), random, sheet, cells, draft, report }
  boardWindows(scene, ctx)
  setPieces(ctx, (text, drips) => write(text, HAND, 'bold', drips))
  secrets(ctx, write)
  if (sheet.overflow) report.missing.push(`${sheet.overflow} painted marks: atlas full`)

  for (const d of drafts.values()) root.add(d.finish())
  const marks = sheet.mesh()
  if (marks) root.add(marks)
  scene.add(root)
  root.updateMatrixWorld(true)

  return () => {
    root.removeFromParent()
    root.traverse(object => {
      if (object instanceof THREE.Mesh) object.geometry.dispose()
    })
    // Draft materials are shared with the whole map; only the atlas material and texture are ours.
    if (marks) {
      const material = marks.material as THREE.MeshBasicMaterial
      material.map?.dispose()
      material.dispose()
    }
  }
}
