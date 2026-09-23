import * as THREE from 'three'
import { box, gun, metal, part, path, tube, type Gun, type V } from './common'

/** The body's axis: the bore line runs along +Z at this height above the grip. */
const AXIS = 0.074
const GREEN = 0x46e05a
/** The wonder weapon's glow is the one colour on it; one set of materials for every copy, pulsing together. */
let glowMaterials: { glow: THREE.MeshBasicMaterial; core: THREE.MeshBasicMaterial; halo: THREE.MeshBasicMaterial | null } | null = null
function glows() {
  if (glowMaterials) return glowMaterials
  const glow = new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false })
  const core = new THREE.MeshBasicMaterial({ color: 0xd9ffd6, toneMapped: false })
  let halo: THREE.MeshBasicMaterial | null = null
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const c = canvas.getContext('2d')!
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 31)
    g.addColorStop(0, 'rgba(120, 255, 130, 0.9)'); g.addColorStop(0.35, 'rgba(70, 224, 90, 0.45)'); g.addColorStop(1, 'rgba(70, 224, 90, 0)')
    c.fillStyle = g; c.fillRect(0, 0, 64, 64)
    const map = new THREE.CanvasTexture(canvas)
    map.colorSpace = THREE.SRGBColorSpace
    halo = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
  }
  // A slow breath in the glass, as the Ray Gun's chamber hums; held still under reduced motion.
  const base = new THREE.Color(GREEN)
  glow.onBeforeRender = () => {
    const still = typeof document !== 'undefined' && document.body?.dataset.reducedMotion === 'true'
    const t = still ? 0 : performance.now() / 1000
    glow.color.copy(base).multiplyScalar(0.85 + 0.25 * Math.sin(t * 3.1))
  }
  glowMaterials = { glow, core, halo }
  return glowMaterials
}

/** A torus (rings, bezels, the trigger guard); rotation in degrees like `part`. */
const ring = (r: number, t: number, pos: V, rot: V = [0, 0, 0], arc = Math.PI * 2) =>
  part(new THREE.TorusGeometry(r, t, 8, 28, arc), metal, pos, rot)
/** A cone on the bore line: `front` and `rear` radii, centred at `z`. */
const cone = (front: number, rear: number, len: number, z: number, segments = 24) =>
  part(new THREE.CylinderGeometry(front, rear, len, segments), metal, [0, AXIS, z], [90, 0, 0])

/**
 * Dead Ink's wonder weapon, the Ink Ray, drawn after the Ray Gun of Call of Duty's zombies: a 1950s
 * pulp-magazine pistol. A bulbous rear receiver with a round porthole on each side glowing green, a
 * banded neck, a thin barrel through three stacked radiator discs, and a flared bell muzzle with a
 * glowing emitter. Held like the pistol (same grip, same hand) so every pose carries over; its grip
 * holds a power cell that drops out on a reload as the pistol's magazine does. Paper and ink; the
 * green glow is its only colour, the colour of its shots.
 */
export function buildInkRay(): Gun {
  const muzzleZ = 0.226
  const result = gun('pistol', 'pistol', false, [0, AXIS, muzzleZ], [0.035, AXIS, 0.0], (g, parts) => {
    // Grip where the pistol's is, raked the same way: a rounded handle with finger grooves.
    const grip = new THREE.Group()
    grip.rotation.x = THREE.MathUtils.degToRad(-14)
    const handle = new THREE.CapsuleGeometry(0.018, 0.07, 6, 14).scale(0.92, 1, 1.08)
    grip.add(part(handle, metal, [0, -0.004, 0]))
    for (const [i, y] of [-0.028, -0.009, 0.01].entries()) {
      grip.add(path([new THREE.Vector3(-0.012, y, 0.0165), new THREE.Vector3(0, y - 0.003, 0.0198), new THREE.Vector3(0.012, y, 0.0165)], 900 + i, 1.2))
    }
    // The grip's spine joins the receiver.
    grip.add(box(0.03, 0.03, 0.036, [0, 0.042, -0.002]))
    g.add(grip)
    // The power cell: a pommel cap and a banded canister in the butt, the Ink Ray's magazine.
    const cell = new THREE.Group()
    cell.rotation.x = grip.rotation.x
    cell.add(part(new THREE.CylinderGeometry(0.023, 0.021, 0.013, 20), metal, [0, -0.057, 0]))
    cell.add(part(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 16), metal, [0, -0.041, 0]))
    cell.userData.grip = new THREE.Vector3(0, -0.062, 0)
    parts.magazine = cell
    g.add(cell)

    // The trigger guard: one round loop of wire, and a curled trigger inside it.
    g.add(ring(0.02, 0.0034, [0, 0.03, 0.03], [0, 90, 180], Math.PI))
    g.add(box(0.006, 0.022, 0.006, [0, 0.026, 0.036], metal, [-24, 0, 0]))
    g.add(box(0.012, 0.012, 0.03, [0, 0.043, 0.03]))

    // The receiver: a fat egg of a chamber, longer than it is tall, with a round dial capping its tail.
    const receiver = new THREE.SphereGeometry(0.046, 26, 18).scale(0.78, 0.92, 1.12)
    g.add(part(receiver, metal, [0, AXIS, 0]))
    // The dial on its tail is the face you see in first person: a gauge rimmed in a bezel, its needle
    // over green glass (added after batching).
    g.add(part(new THREE.CylinderGeometry(0.017, 0.02, 0.008, 24), metal, [0, AXIS, -0.05], [-90, 0, 0]))
    g.add(ring(0.0155, 0.003, [0, AXIS, -0.0542]))
    g.add(path([new THREE.Vector3(0, AXIS - 0.002, -0.0556), new THREE.Vector3(-0.007, AXIS + 0.009, -0.0556)], 932, 1.5))
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (0.15 + i * 0.175)
      g.add(path([new THREE.Vector3(Math.cos(a) * 0.009, AXIS + Math.sin(a) * 0.009, -0.0556), new THREE.Vector3(Math.cos(a) * 0.012, AXIS + Math.sin(a) * 0.012, -0.0556)], 940 + i, 0.8))
    }
    // A seam round its nose, drawn in ink, and a fin along its spine carrying the rear sight.
    g.add(path(Array.from({ length: 25 }, (_, i) => {
      const a = i / 24 * Math.PI * 2
      return new THREE.Vector3(Math.cos(a) * 0.0297, AXIS + Math.sin(a) * 0.035, 0.03)
    }), 931, 1.1))
    g.add(box(0.006, 0.018, 0.058, [0, AXIS + 0.039, -0.006]))
    g.add(box(0.016, 0.012, 0.008, [0, AXIS + 0.05, -0.03]))
    // The chamber: a porthole on each side, rimmed in a bezel (the green glass goes in after batching,
    // because batched faces are all paper).
    const chamber = new THREE.Group()
    chamber.position.set(0, AXIS, -0.004)
    for (const side of [-1, 1]) {
      chamber.add(part(new THREE.CylinderGeometry(0.022, 0.026, 0.008, 24), metal, [side * 0.031, 0, 0], [0, 0, side * -90]))
      chamber.add(ring(0.02, 0.0035, [side * 0.0355, 0, 0], [0, 90, 0]))
      // Four rivets round each bezel.
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4
        chamber.add(part(new THREE.SphereGeometry(0.0026, 6, 5), metal, [side * 0.033, Math.sin(a) * 0.0245, Math.cos(a) * 0.0245]))
      }
    }
    parts.chamber = chamber
    g.add(chamber)

    // The neck: a collar narrowing from the receiver into the barrel, banded twice.
    g.add(cone(0.018, 0.03, 0.04, 0.062))
    g.add(ring(0.027, 0.0045, [0, AXIS, 0.047]))
    g.add(ring(0.019, 0.0042, [0, AXIS, 0.08]))
    // The barrel runs through three stacked radiator discs, each ringed on its face.
    g.add(tube(0.0115, 0.12, [0, AXIS, 0.14]))
    for (const [i, z] of [0.1, 0.126, 0.152].entries()) {
      const r = 0.056 - i * 0.003
      g.add(part(new THREE.CylinderGeometry(r, r, 0.006, 36), metal, [0, AXIS, z], [90, 0, 0]))
      g.add(ring(r * 0.6, 0.002, [0, AXIS, z + 0.0038]))
    }
    // A thin rib ties the discs together along the top, ending in the front sight.
    g.add(box(0.005, 0.006, 0.06, [0, AXIS + 0.044, 0.126]))
    g.add(box(0.005, 0.012, 0.008, [0, AXIS + 0.054, 0.156]))
    // The muzzle: a short neck flaring out into a bell with a heavy lip.
    g.add(ring(0.014, 0.004, [0, AXIS, 0.172]))
    g.add(part(new THREE.CylinderGeometry(0.022, 0.011, 0.04, 24, 1, true), metal, [0, AXIS, muzzleZ - 0.021], [90, 0, 0]))
    g.add(ring(0.0215, 0.0036, [0, AXIS, muzzleZ - 0.002]))
  }, 'ink-ray')
  // The glow: two portholes, the power cell's band and the emitter deep in the bell, each with a soft
  // halo of light round it.
  const { glow, core, halo } = glows()
  const disc = (r: number, material: THREE.Material, pos: V, turn: number, name: string) => {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(r, 28), material)
    mesh.position.set(...pos)
    mesh.rotation.y = turn
    mesh.name = name
    mesh.userData.noCollision = true
    return mesh
  }
  const chamber = result.userData.parts.chamber
  for (const side of [-1, 1]) {
    const turn = side * Math.PI / 2
    chamber.add(disc(0.0195, glow, [side * 0.0352, 0, 0], turn, 'Ink Ray chamber glow'))
    chamber.add(disc(0.0085, core, [side * 0.0356, 0.004, 0.003], turn, 'Ink Ray chamber core'))
    if (halo) chamber.add(disc(0.05, halo, [side * 0.038, 0, 0], turn, 'Ink Ray chamber halo'))
  }
  result.add(disc(0.0135, glow, [0, AXIS, -0.0543], Math.PI, 'Ink Ray gauge glow'))
  const cellBand = new THREE.Mesh(new THREE.CylinderGeometry(0.0146, 0.0146, 0.008, 16, 1, true), glow)
  cellBand.position.set(0, -0.04, 0)
  cellBand.name = 'Ink Ray cell glow'
  result.userData.parts.magazine.add(cellBand)
  result.add(disc(0.017, glow, [0, AXIS, muzzleZ - 0.007], 0, 'Ink Ray emitter glow'))
  result.add(disc(0.007, core, [0, AXIS, muzzleZ - 0.0065], 0, 'Ink Ray emitter core'))
  if (halo) result.add(disc(0.04, halo, [0, AXIS, muzzleZ + 0.002], 0, 'Ink Ray emitter halo'))
  return result
}
