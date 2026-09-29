import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Draft, type Point } from '../../render/ink'
import { synthOutput } from '../ui-slot-sound'

/**
 * The boat way out, for harbour maps (Marsaxlokk): a luzzu, the Maltese fishing boat, in ink: a planked hull
 * with its sheer line, the tall stem and sternpost, painted bands and the Eye of Osiris on both bows, the
 * gunwale and rubbing strake, ribs, thwarts and floorboards inside, a small wheelhouse with its windows, an
 * inboard engine box with its exhaust, tyre fenders, a coiled mooring line, oars along the thwarts, a mast with a
 * flag and a riding light. The propeller turns; the hull bobs and heels. Its wake is instanced foam.
 *
 * Origin: at the waterline amidships; the bow points along +Z.
 */
export const LUZZU = { blue: 0x2a6fc0, yellow: 0xf2c230, red: 0xd0402f, green: 0x3a9a50 } as const
const INK = 0x111111

export type BoatRig = { root: THREE.Group; hull: THREE.Group; propeller: THREE.Group; light: THREE.Mesh; flag: THREE.Group; passengers: THREE.Group; throttle: number }

/** The hull's half-breadth at a station along it (z from -3.1 stern to 3.3 bow). */
function breadth(z: number) { const t = (z + 3.1) / 6.4; return 1.25 * Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.93 + 0.035))) ** 0.7 }
/** The sheer (gunwale height), sweeping up to the stem and sternpost; the depth of the keel below the water. */
const sheer = (z: number) => 0.75 + 0.35 * (z / 3.2) ** 4
const depth = (z: number) => 0.55 * (0.35 + 0.65 * breadth(z) / 1.25)
/** A point on the hull: `a` round the section, -π/2 (port gunwale) through 0 (keel) to π/2 (starboard). */
function section(z: number, a: number): Point {
  return [Math.sin(a) * breadth(z), sheer(z) - (sheer(z) + depth(z)) * Math.abs(Math.cos(a)) ** 0.9, z]
}
/** How far out the hull side is at height `y` of station `z`. */
function hullX(z: number, y: number) {
  const c = Math.max(0, Math.min(1, (sheer(z) - y) / (sheer(z) + depth(z)))) ** (1 / 0.9)
  return Math.sin(Math.acos(c)) * breadth(z)
}

/** The hull as a lofted surface: stations along its length, each a rounded V from keel to gunwale. */
function hullGeometry() {
  const stations = 28, around = 12
  const positions: number[] = [], index: number[] = []
  for (let i = 0; i <= stations; i++) {
    const z = -3.1 + i / stations * 6.4
    for (let j = 0; j <= around; j++) positions.push(...section(z, j / around * Math.PI - Math.PI / 2))
  }
  const row = around + 1
  for (let i = 0; i < stations; i++) for (let j = 0; j < around; j++) {
    const a = i * row + j, b = a + row
    index.push(a, b, a + 1, a + 1, b, b + 1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

/** The Eye of Osiris, painted on each bow. */
function eyeTexture() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 64
  const c = canvas.getContext('2d')!
  c.fillStyle = '#ffffff'; c.beginPath(); c.ellipse(64, 32, 44, 20, 0, 0, Math.PI * 2); c.fill()
  c.strokeStyle = '#111'; c.lineWidth = 4; c.stroke()
  c.fillStyle = '#2a6fc0'; c.beginPath(); c.arc(64, 32, 14, 0, Math.PI * 2); c.fill()
  c.fillStyle = '#111'; c.beginPath(); c.arc(64, 32, 7, 0, Math.PI * 2); c.fill()
  c.strokeStyle = '#d0402f'; c.lineWidth = 5; c.beginPath(); c.moveTo(14, 10); c.quadraticCurveTo(64, -8, 114, 10); c.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function colourBand(z0: number, z1: number, y: number, height: number, color: number) {
  const pieces: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    const steps = 16, positions: number[] = [], index: number[] = []
    for (let i = 0; i <= steps; i++) {
      const z = z0 + (z1 - z0) * i / steps
      positions.push(side * (hullX(z, y) + 0.012), y, z, side * (hullX(z, y + height) + 0.012), y + height, z)
    }
    for (let i = 0; i < steps; i++) { const a = i * 2; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(index)
    pieces.push(g.toNonIndexed())
  }
  const merged = mergeGeometries(pieces)!
  return new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false }))
}

export function createBoat(): BoatRig {
  const root = new THREE.Group()
  root.name = 'Extraction boat'
  root.userData = { noCollision: true, kind: 'boat' }
  const hull = new THREE.Group()
  root.add(hull)
  const d = new Draft('Luzzu hull')
  d.solid(hullGeometry(), [0, 0, 0], 'paper', false, [0, 0, 0], true)
  // Plank seams along the hull, the gunwale and rubbing strake, the stem and sternpost.
  for (const fraction of [0.35, 0.6, 0.8]) for (const side of [-1, 1]) {
    const points: Point[] = []
    for (let i = 0; i <= 24; i++) { const [x, y, z] = section(-2.95 + i / 24 * 6.1, side * fraction * Math.PI / 2); points.push([x * 1.004, y, z]) }
    d.line(points, 'mesh')
  }
  for (const side of [-1, 1]) {
    const rail: Point[] = []
    for (let i = 0; i <= 30; i++) { const z = -3.0 + i / 30 * 6.2; rail.push([side * (breadth(z) + 0.02), sheer(z) + 0.04, z]) }
    for (let i = 1; i < rail.length; i++) d.beam(rail[i - 1], rail[i], 0.07, 'paper', 'edge')
  }
  d.beam([0, -0.4, 3.2], [0, 1.9, 3.55], 0.11, 'paper', 'edge')
  d.beam([0, -0.4, -3.05], [0, 1.6, -3.3], 0.11, 'paper', 'edge')
  d.box(0.06, 0.06, 0.3, 0, 1.9, 3.45, 'paper', 'detail')
  // Inside: floorboards, ribs, three thwarts, the wheelhouse, the engine box and its exhaust.
  d.box(1.5, 0.04, 4.6, 0, -0.1, 0, 'paper', 'detail')
  for (let z = -2.4; z <= 2.4; z += 0.45) { const b = breadth(z) - 0.06; d.line([[-b, 0.65, z], [-b * 0.7, 0.0, z], [b * 0.7, 0.0, z], [b, 0.65, z]], 'mesh') }
  for (const z of [-1.9, 1.3, 2.3]) d.box(breadth(z) * 1.9, 0.06, 0.28, 0, 0.45, z, 'paper', 'edge')
  d.box(1.3, 1.1, 1.3, 0, 0.9, -0.4, 'paper', 'edge')
  d.box(1.42, 0.08, 1.42, 0, 1.5, -0.4, 'paper', 'edge')
  for (const side of [-1, 1]) {
    d.box(0.02, 0.36, 0.8, side * 0.66, 1.1, -0.4, 'glass', 'detail')
    d.line([[side * 0.672, 0.92, -0.8], [side * 0.672, 1.28, -0.8], [side * 0.672, 1.28, 0.0], [side * 0.672, 0.92, 0.0]], 'detail', true)
    d.hatch([side * 0.675, 0.95, -0.75], [0, 0, 0.3], [0, 0.3, 0], { spacing: 0.08, inset: 0.02 })
  }
  d.box(0.8, 0.36, 0.02, 0, 1.1, 0.26, 'glass', 'detail')
  d.box(0.9, 0.5, 0.8, 0, 0.3, -2.3, 'paper', 'edge')
  d.hatch([0.451, 0.12, -2.65], [0, 0, 0.7], [0, 0.35, 0], { spacing: 0.05, inset: 0.01 })
  d.solid(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10), [0.3, 0.95, -2.5], 'paper', 'detail', [0, 0, 0], true)
  d.ring(0.05, 1.4, 0.3, -2.5, 'detail', 10)
  // Oars along the thwarts, a coiled line on the foredeck, tyre fenders on both sides.
  for (const side of [-1, 1]) {
    d.beam([side * 0.45, 0.52, -1.6], [side * 0.45, 0.52, 2.2], 0.04, 'paper', 'detail')
    d.box(0.02, 0.14, 0.4, side * 0.45, 0.52, 2.35, 'paper', 'detail')
    for (const z of [-1.4, 0.4, 1.8]) {
      d.solid(new THREE.TorusGeometry(0.16, 0.07, 8, 16), [side * (breadth(z) + 0.1), 0.35, z], 'paper', 'detail', [0, Math.PI / 2, 0], true)
      d.line([[side * breadth(z), 0.82, z], [side * (breadth(z) + 0.1), 0.5, z]], 'detail')
    }
  }
  for (let i = 0; i < 4; i++) d.ring(0.22 - i * 0.04, 0.5 + i * 0.015, 0, 2.7, 'detail', 18)
  // Mast, riding light and flag halyard.
  d.solid(new THREE.CylinderGeometry(0.04, 0.05, 2.4, 10), [0, 2.6, -0.4], 'paper', 'edge', [0, 0, 0], true)
  d.line([[0, 3.8, -0.4], [0, 0.8, 1.4]], 'mesh')
  d.line([[0, 3.8, -0.4], [0, 0.85, -2.8]], 'mesh')
  hull.add(d.finish())
  // Painted bands: blue along the top strake, yellow below it, a red line at the waterline; the eyes.
  hull.add(colourBand(-2.9, 3.1, 0.55, 0.16, LUZZU.blue), colourBand(-2.9, 3.1, 0.38, 0.14, LUZZU.yellow), colourBand(-2.8, 3.0, -0.02, 0.05, LUZZU.red))
  const eyeMaterial = new THREE.MeshBasicMaterial({ map: eyeTexture(), transparent: true, side: THREE.DoubleSide, toneMapped: false })
  const eyes = mergeGeometries([-1, 1].map(side => {
    const g = new THREE.PlaneGeometry(0.46, 0.23)
    g.rotateY(side * (Math.PI / 2 - 0.45)); g.translate(side * (hullX(2.55, 0.62) + 0.02), 0.62, 2.55)
    return g
  }))!
  hull.add(new THREE.Mesh(eyes, eyeMaterial))
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff2b0, toneMapped: false }))
  light.position.set(0, 3.86, -0.4)
  hull.add(light)
  const flag = new THREE.Group()
  flag.position.set(0, 3.5, -0.4)
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32, 6, 1), new THREE.MeshBasicMaterial({ color: LUZZU.red, side: THREE.DoubleSide, toneMapped: false }))
  cloth.geometry.translate(-0.25, 0, 0)
  flag.add(cloth)
  hull.add(flag)
  // The propeller under the stern.
  const propeller = new THREE.Group()
  propeller.position.set(0, -0.42, -3.15)
  const prop = new Draft('Luzzu propeller')
  prop.solid(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 8), [0, 0, 0], 'paper', 'detail', [Math.PI / 2, 0, 0], true)
  for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; prop.box(0.06, 0.2, 0.02, Math.sin(a) * 0.11, Math.cos(a) * 0.11, 0, 'paper', 'detail', [0, 0.35, -a]) }
  propeller.add(prop.finish())
  hull.add(propeller)
  const passengers = new THREE.Group()
  passengers.visible = false
  hull.add(passengers)
  return { root, hull, propeller, light, flag, passengers, throttle: 0 }
}

/** Pose the boat: bobbing and heeling on the swell, the propeller at `throttle`, the flag in the wind. */
export function poseBoat(rig: BoatRig, throttle: number, time: number, dt: number) {
  rig.throttle += (throttle - rig.throttle) * Math.min(1, dt * 1.5)
  rig.hull.position.y = Math.sin(time * 1.3) * 0.06
  rig.hull.rotation.set(-rig.throttle * 0.06 + Math.sin(time * 0.9) * 0.02, 0, Math.sin(time * 1.1) * 0.035)
  rig.propeller.rotation.z += dt * (2 + rig.throttle * 40)
  const cloth = rig.flag.children[0] as THREE.Mesh
  const positions = cloth.geometry.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < positions.count; i++) positions.setZ(i, Math.sin(time * 6 + positions.getX(i) * 9) * 0.04 * -positions.getX(i) * 4)
  positions.needsUpdate = true
}

/** The wake: foam strokes peeling off the stern and a bow wave, on the water; one instanced mesh. */
export class Wake {
  private mesh: THREE.InstancedMesh
  private items: { x: number; z: number; y: number; dx: number; dz: number; age: number; life: number; turn: number }[] = []
  private spawn = 0
  private matrix = new THREE.Matrix4()
  private static readonly COUNT = 120
  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.01, 0.9), new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false }), Wake.COUNT)
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.userData.noCollision = true
    scene.add(this.mesh)
  }
  update(dt: number, boat: THREE.Object3D | null, speed: number, water: number) {
    if (boat && speed > 0.3) {
      this.spawn += dt * Math.min(60, speed * 10)
      const yaw = boat.rotation.y, back = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), side = new THREE.Vector3(back.z, 0, -back.x)
      while (this.spawn >= 1 && this.items.length < Wake.COUNT) {
        this.spawn -= 1
        const s = Math.random() < 0.5 ? -1 : 1, stern = Math.random() < 0.7
        const at = boat.position.clone().addScaledVector(back, stern ? 3.2 : -3.0).addScaledVector(side, s * (stern ? 0.4 : 0.9))
        this.items.push({ x: at.x, z: at.z, y: water + 0.02, dx: side.x * s * 1.5 + back.x * 0.5, dz: side.z * s * 1.5 + back.z * 0.5, age: 0, life: 1.4 + Math.random(), turn: yaw + s * 0.5 })
      }
    }
    let n = 0
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      item.age += dt
      if (item.age >= item.life) { this.items.splice(i, 1); continue }
      item.x += item.dx * dt; item.z += item.dz * dt
      const t = item.age / item.life
      this.matrix.compose(new THREE.Vector3(item.x, item.y, item.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.turn), new THREE.Vector3(1, 1, 1 - t * 0.8))
      this.mesh.setMatrixAt(n++, this.matrix)
    }
    this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true
  }
  clear() { this.items = []; this.mesh.count = 0 }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose() }
}

/** The inboard diesel: a low chug (a pulsed square through a low-pass) and a little water noise. */
export class EngineSound {
  private nodes: { context: AudioContext; out: GainNode; pulse: OscillatorNode; sources: AudioScheduledSourceNode[] } | null = null
  private start() {
    const output = synthOutput('effects', 1)
    if (!output) return null
    const { context, out } = output
    out.gain.value = 0
    const pulse = context.createOscillator(); pulse.type = 'square'; pulse.frequency.value = 9
    const low = context.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 180
    const level = context.createGain(); level.gain.value = 0.5
    pulse.connect(low).connect(level).connect(out)
    const hum = context.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 55
    const humLow = context.createBiquadFilter(); humLow.type = 'lowpass'; humLow.frequency.value = 240
    const humLevel = context.createGain(); humLevel.gain.value = 0.18
    hum.connect(humLow).connect(humLevel).connect(out)
    pulse.start(); hum.start()
    this.nodes = { context, out, pulse, sources: [pulse, hum] }
    return this.nodes
  }
  update(throttle: number, distance: number, active: boolean) {
    if (!active) { if (this.nodes) this.nodes.out.gain.setTargetAtTime(0, this.nodes.context.currentTime, 0.3); return }
    const nodes = this.nodes ?? this.start()
    if (!nodes) return
    const t = nodes.context.currentTime
    nodes.out.gain.setTargetAtTime((0.25 + throttle * 0.5) * Math.min(1, 18 / (6 + distance)) * 0.5, t, 0.2)
    nodes.pulse.frequency.setTargetAtTime(7 + throttle * 9, t, 0.3)
  }
  dispose() {
    if (!this.nodes) return
    for (const source of this.nodes.sources) { try { source.stop() } catch { /* stopped */ } }
    this.nodes.out.disconnect(); this.nodes = null
  }
}
