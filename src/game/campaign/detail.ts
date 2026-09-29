import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Draft, type Point } from '../../render/ink'
import { groundOutline } from '../../world/architecture'

/**
 * The campaign's props, drawn to the power switch's standard (zombies/buildables.ts): every part a real part,
 * bolted, riveted, strapped and shaded, and still only a few draw calls each (a Draft batches its fills into
 * one mesh and its ink into one; the few moving or coloured bits are their own small meshes).
 *
 * Each builder draws in its own frame: origin on the ground (or the floor it stands on), facing +Z.
 */
export const KEYCARD_ORANGE = 0xe3a41c
const INK = 0x111111
export const LAMP = { red: 0xd0302a, green: 0x3fae4a, off: 0x3a3a3a, amber: 0xf0a020, screen: 0x146bff } as const

const lamps = new Map<number, THREE.MeshBasicMaterial>()
/** A small unlit lamp or LED (shared materials per colour; set the mesh's own when it must change). */
export function lampMesh(color: number, radius = 0.03, own = false) {
  const material = own ? new THREE.MeshBasicMaterial({ color, toneMapped: false }) : lamps.get(color) ?? (() => {
    const m = new THREE.MeshBasicMaterial({ color, toneMapped: false }); lamps.set(color, m); return m
  })()
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material)
}

/** A word stencilled in ink on a plate (heavy capitals, cut by the stencil's bridges). */
export function stencil(word: string, width: number, height: number, color = '#111111') {
  if (typeof document === 'undefined') return new THREE.Group()
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 128
  const c = canvas.getContext('2d')!
  let size = 104
  const font = () => `${size}px Impact, "Arial Black", "Franklin Gothic Heavy", sans-serif`
  c.font = font()
  while (c.measureText(word).width > 480 && size > 30) { size -= 4; c.font = font() }
  c.fillStyle = color
  c.textBaseline = 'middle'
  let x = (512 - c.measureText(word).width) / 2
  for (const letter of word) {
    const w = c.measureText(letter).width
    c.fillText(letter, x, 66)
    if (/[A-Z0-9]/.test(letter)) c.clearRect(x + w * ('OQCGDUVWMAXYZ0'.includes(letter) ? 0.5 : 0.45) - size * 0.028, 0, size * 0.056, 128)
    x += w
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }))
  mesh.name = `Stencil · ${word}`
  mesh.userData.noCollision = true
  return mesh
}

const bolt = (d: Draft, x: number, y: number, z: number, size = 0.016, depth = 0.008) => d.box(size, size, depth, x, y, z, 'paper', 'detail')

// ---------------------------------------------------------------- the fuse box (cut the power)

/**
 * A freestanding service pedestal: a concrete plinth, two steel posts on bolted feet, a breaker cabinet on two
 * rails with a riveted, hinged door and its latch, a stencilled POWER plate, a warning triangle, conduit down
 * into a cable trench under a checker plate, a caged status lamp, and the big throw lever on its bracket.
 * `lever` pivots about X (0 up, on; -1.2 down, off); `lamp` is its own material, to go dark.
 */
export function fuseBox() {
  const root = new THREE.Group()
  const d = new Draft('Fuse pedestal')
  d.box(1.1, 0.14, 0.7, 0, 0.07, 0, 'concrete', 'detail')
  groundOutline(d, 0, 0, 1.1, 0.7)
  for (const x of [-0.38, 0.38]) {
    d.box(0.16, 0.012, 0.16, x, 0.146, 0, 'paper', 'detail')
    for (const [bx, bz] of [[-0.055, -0.055], [0.055, -0.055], [-0.055, 0.055], [0.055, 0.055]]) bolt(d, x + bx, 0.156, bz, 0.018, 0.01)
    d.box(0.06, 1.95, 0.06, x, 1.1, 0, 'paper', 'edge')
    d.box(0.075, 0.03, 0.075, x, 2.085, 0, 'paper', 'detail')
  }
  // Rails across the posts, and the cabinet on them.
  for (const y of [1.02, 1.82]) {
    d.box(0.9, 0.05, 0.03, 0, y, 0.045, 'paper', 'detail')
    for (const x of [-0.38, 0.38]) bolt(d, x, y, 0.066, 0.022, 0.012)
  }
  d.box(0.66, 0.92, 0.26, 0, 1.42, 0.2, 'paper', 'edge')
  d.box(0.56, 0.82, 0.02, 0, 1.42, 0.34, 'paper', 'edge')
  for (const y of [1.14, 1.7]) d.solid(new THREE.CylinderGeometry(0.013, 0.013, 0.09, 16), [-0.292, y, 0.345], 'paper', 'detail', [0, 0, 0], true)
  d.box(0.034, 0.12, 0.006, 0.245, 1.42, 0.353, 'paper', 'detail')
  d.box(0.02, 0.09, 0.022, 0.245, 1.42, 0.367, 'paper', 'detail')
  for (const x of [-0.3, -0.15, 0, 0.15, 0.3]) for (const y of [0.985, 1.855]) bolt(d, x, y, 0.334)
  for (const y of [1.14, 1.28, 1.42, 1.56, 1.7]) bolt(d, 0.305, y, 0.334)
  const w = 0.3505
  d.line([[-0.245, 1.04, w], [0.245, 1.04, w], [0.245, 1.8, w], [-0.245, 1.8, w]], 'detail', true)
  d.line([[-0.21, 1.075, w], [-0.09, 1.075, w], [-0.15, 1.18, w]], 'detail', true)
  d.line([[-0.143, 1.16, w], [-0.161, 1.122, w], [-0.141, 1.126, w], [-0.157, 1.088, w]], 'detail')
  d.box(0.34, 0.09, 0.006, 0, 1.75, 0.353, 'paper', 'edge')
  for (const x of [-0.155, 0.155]) bolt(d, x, 1.75, 0.359, 0.012, 0.006)
  // The lever's bracket: a plate on the door, two cheeks and the pin; the contacts below.
  d.box(0.16, 0.18, 0.01, 0.12, 1.45, 0.355, 'paper', 'edge')
  for (const x of [0.054, 0.186]) for (const y of [1.382, 1.518]) bolt(d, x, y, 0.365, 0.018, 0.01)
  for (const x of [0.071, 0.169]) d.box(0.016, 0.12, 0.105, x, 1.45, 0.4125, 'paper', 'edge')
  d.solid(new THREE.CylinderGeometry(0.011, 0.011, 0.14, 12), [0.12, 1.45, 0.43], 'paper', 'detail', [0, 0, Math.PI / 2], true)
  d.box(0.09, 0.05, 0.016, 0.12, 1.2, 0.358, 'paper', 'edge')
  for (const x of [0.0955, 0.1445]) d.box(0.009, 0.075, 0.1, x, 1.2, 0.416, 'paper', 'detail')
  // Lamp cage on top.
  d.cylinder(0.04, 0.03, 0.2, 1.905, 0.2)
  d.ring(0.043, 1.955, 0.2, 0.2, 'detail', 24)
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2, c = Math.cos(a), s = Math.sin(a)
    d.line([[0.2 + 0.03 * c, 1.92, 0.2 + 0.03 * s], [0.2 + 0.043 * c, 1.955, 0.2 + 0.043 * s], [0.2 + 0.012 * c, 2.0, 0.2 + 0.012 * s]], 'detail')
  }
  d.cylinder(0.014, 0.012, 0.2, 2.002, 0.2)
  // Conduit out of the bottom, down into a trench under a checker plate, with its straps.
  for (const [x, r] of [[-0.18, 0.028], [-0.07, 0.018]]) {
    d.solid(new THREE.CylinderGeometry(r + 0.008, r + 0.008, 0.03, 16), [x, 0.945, 0.12], 'paper', 'detail', [0, 0, 0], true)
    d.solid(new THREE.CylinderGeometry(r, r, 0.8, 16), [x, 0.54, 0.12], 'paper', 'detail', [0, 0, 0], true)
  }
  d.box(0.2, 0.024, 0.01, -0.125, 0.55, 0.16, 'paper', 'detail')
  d.box(0.5, 0.03, 0.5, -0.12, 0.155, 0.42, 'paper', 'edge')
  for (let i = 0; i < 5; i++) d.line([[-0.34 + i * 0.1, 0.171, 0.2], [-0.3 + i * 0.1, 0.171, 0.64]], 'mesh')
  // Shade: the cabinet's right side and the wall of posts behind.
  d.hatch([0.3325, 0.98, 0.075], [0, 0, 0.25], [0, 0.88, 0], { spacing: 0.035, inset: 0.01 })
  root.add(d.finish())
  const plate = stencil('POWER', 0.28, 0.07)
  plate.position.set(0, 1.75, 0.357)
  const lamp = lampMesh(LAMP.green, 0.033, true)
  lamp.position.set(0.2, 1.955, 0.2)
  // The throw lever, on its pin: a steel bar with a black T grip.
  const lever = new THREE.Group()
  lever.position.set(0.12, 1.45, 0.43)
  const bar = new Draft('Fuse lever')
  bar.box(0.034, 0.3, 0.034, 0, 0.17, 0, 'paper', 'edge')
  bar.solid(new THREE.CylinderGeometry(0.024, 0.024, 0.17, 12), [0, 0.33, 0], 'paper', 'edge', [0, 0, Math.PI / 2])
  for (const side of [-1, 1]) bar.solid(new THREE.CylinderGeometry(0.029, 0.029, 0.02, 12), [side * 0.092, 0.33, 0], 'paper', 'detail', [0, 0, Math.PI / 2])
  lever.add(bar.finish())
  root.add(plate, lamp, lever)
  return { root, lever, lamp, target: new THREE.Vector3(0.12, 1.55, 0.5) }
}

// ---------------------------------------------------------------- the intel laptop

/** A screen texture: a map grid, a photo box, lines of text and a red pin. */
function screenTexture() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 160
  const c = canvas.getContext('2d')!
  c.fillStyle = '#146bff'; c.fillRect(0, 0, 256, 160)
  c.strokeStyle = '#ffffff'; c.globalAlpha = 0.85; c.lineWidth = 1.5
  c.strokeRect(10, 12, 118, 90)
  for (let x = 10; x <= 128; x += 20) { c.beginPath(); c.moveTo(x, 12); c.lineTo(x, 102); c.stroke() }
  for (let y = 12; y <= 102; y += 18) { c.beginPath(); c.moveTo(10, y); c.lineTo(128, y); c.stroke() }
  c.strokeRect(142, 12, 100, 60)
  c.beginPath(); c.arc(192, 36, 10, 0, Math.PI * 2); c.moveTo(174, 70); c.quadraticCurveTo(192, 48, 210, 70); c.stroke()
  for (let y = 84; y < 150; y += 11) { c.fillStyle = '#ffffff'; c.fillRect(142, y, 60 + (y * 7 % 40), 3) }
  for (let y = 114; y < 150; y += 11) c.fillRect(10, y, 90 + (y * 3 % 30), 3)
  c.globalAlpha = 1; c.fillStyle = '#d0302a'; c.beginPath(); c.arc(78, 56, 5, 0, Math.PI * 2); c.fill()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * A rugged field laptop on a plank crate: the crate's boards, battens, rope handles and stencil; the laptop's
 * base, keyboard keys, trackpad, hinge and armoured corners, and its lit screen; a power brick and cable, a
 * clipboard of papers and a mug.
 */
export function laptopCrate() {
  const root = new THREE.Group()
  const d = new Draft('Intel crate')
  d.box(0.9, 0.72, 0.62, 0, 0.36, 0, 'paper', 'edge')
  groundOutline(d, 0, 0, 0.9, 0.62)
  for (const y of [0.18, 0.36, 0.54]) { d.line([[-0.45, y, 0.311], [0.45, y, 0.311]], 'mesh'); d.line([[0.451, y, -0.31], [0.451, y, 0.31]], 'mesh') }
  for (const x of [-0.4, 0.4]) d.box(0.07, 0.72, 0.02, x, 0.36, 0.32, 'paper', 'detail')
  d.box(0.9, 0.06, 0.02, 0, 0.66, 0.32, 'paper', 'detail')
  for (const x of [-0.4, 0.4]) for (const y of [0.08, 0.64]) bolt(d, x, y, 0.332, 0.014)
  for (const side of [-1, 1]) { d.ring(0.05, 0.45, side * 0.46, 0, 'detail', 12) }
  // The laptop.
  d.box(0.46, 0.035, 0.32, 0, 0.738, 0.04, 'paper', 'edge')
  for (const [x, z] of [[-0.225, -0.115], [0.225, -0.115], [-0.225, 0.195], [0.225, 0.195]]) d.box(0.04, 0.045, 0.04, x, 0.74, z, 'paper', 'detail')
  for (let row = 0; row < 4; row++) for (let col = 0; col < 11; col++) {
    d.box(0.028, 0.006, 0.028, -0.17 + col * 0.034, 0.759, -0.05 + row * 0.036, 'paper', 'detail')
  }
  d.box(0.14, 0.004, 0.08, 0, 0.758, 0.14, 'paper', 'detail')
  d.solid(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 10), [0, 0.76, -0.12], 'paper', 'detail', [0, 0, Math.PI / 2], true)
  d.box(0.46, 0.3, 0.02, 0, 0.9, -0.16, 'paper', 'edge', [-0.3, 0, 0])
  for (const [x, y] of [[-0.215, 0.76], [0.215, 0.76], [-0.215, 1.04], [0.215, 1.04]]) d.box(0.04, 0.04, 0.03, x, y, -0.12 - (y - 0.76) * 0.3, 'paper', 'detail', [-0.3, 0, 0])
  // Power brick and cable, a clipboard, a mug.
  d.box(0.12, 0.035, 0.07, 0.34, 0.738, -0.18, 'paper', 'detail')
  d.line([[0.28, 0.74, -0.18], [0.2, 0.75, -0.15], [0.1, 0.75, -0.16], [0, 0.76, -0.14]], 'detail')
  d.line([[0.4, 0.72, -0.2], [0.45, 0.6, -0.25], [0.46, 0.2, -0.27], [0.5, 0.01, -0.35]], 'detail')
  d.box(0.2, 0.012, 0.28, -0.33, 0.726, 0.12, 'paper', 'edge', [0, 0.25, 0])
  d.box(0.07, 0.02, 0.03, -0.36, 0.735, 0.0, 'paper', 'detail', [0, 0.25, 0])
  for (let i = 0; i < 4; i++) d.line([[-0.39, 0.733, 0.06 + i * 0.04], [-0.28, 0.733, 0.03 + i * 0.04]], 'mesh')
  d.cylinder(0.04, 0.09, 0.33, 0.77, 0.16, 'paper')
  d.ring(0.03, 0.8, 0.375, 0.16, 'detail', 12)
  root.add(d.finish())
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.25), new THREE.MeshBasicMaterial({ map: screenTexture(), color: 0xffffff, toneMapped: false }))
  screen.position.set(0, 0.905, -0.146); screen.rotation.x = -0.3
  const label = stencil('INTEL', 0.3, 0.08)
  label.position.set(0, 0.45, 0.332)
  root.add(screen, label)
  return { root, target: new THREE.Vector3(0, 0.95, 0.05) }
}

// ---------------------------------------------------------------- the keycard

/** A keycard's face: orange, a black stripe, a chip and a photo box. */
export function keycardTexture() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 80
  const c = canvas.getContext('2d')!
  c.fillStyle = '#e3a41c'; c.fillRect(0, 0, 128, 80)
  c.fillStyle = '#111'; c.fillRect(0, 56, 128, 12)
  c.strokeStyle = '#111'; c.lineWidth = 2; c.strokeRect(10, 10, 30, 36)
  c.fillStyle = '#c9c6bd'; c.fillRect(92, 16, 22, 16); c.strokeRect(92, 16, 22, 16)
  c.beginPath(); c.moveTo(103, 16); c.lineTo(103, 32); c.moveTo(92, 24); c.lineTo(114, 24); c.stroke()
  c.fillStyle = '#111'; c.fillRect(48, 14, 34, 4); c.fillRect(48, 24, 26, 4); c.fillRect(48, 34, 30, 4)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * A steel cash box, lid thrown open on its hinges, on a small folding table: the keycard on its lanyard inside,
 * the box's handle, lock and hinge pins, the table's cross legs and braces, and a sign-out sheet.
 */
export function keycardBox() {
  const root = new THREE.Group()
  const d = new Draft('Keycard box')
  // Folding table.
  d.box(0.7, 0.03, 0.5, 0, 0.76, 0, 'paper', 'edge')
  for (const side of [-1, 1]) {
    d.beam([side * 0.3, 0.02, -0.2], [side * 0.3, 0.745, 0.2], 0.025, 'paper', 'detail')
    d.beam([side * 0.3, 0.02, 0.2], [side * 0.3, 0.745, -0.2], 0.025, 'paper', 'detail')
    d.box(0.03, 0.03, 0.03, side * 0.3, 0.39, 0, 'paper', 'detail')
  }
  d.beam([-0.3, 0.2, 0.18], [0.3, 0.2, 0.18], 0.018, 'paper', 'detail')
  // The box and its open lid.
  d.box(0.3, 0.09, 0.2, 0.06, 0.82, 0.02, 'paper', 'edge')
  d.box(0.3, 0.2, 0.012, 0.06, 0.965, -0.085, 'paper', 'edge', [-0.35, 0, 0])
  for (const x of [-0.05, 0.17]) d.solid(new THREE.CylinderGeometry(0.008, 0.008, 0.04, 8), [x, 0.866, -0.08], 'paper', 'detail', [0, 0, Math.PI / 2], true)
  d.box(0.1, 0.015, 0.02, 0.06, 0.87, 0.125, 'paper', 'detail')
  d.box(0.03, 0.03, 0.006, 0.06, 0.83, 0.123, 'paper', 'detail')
  d.line([[-0.06, 0.866, 0.1], [0.18, 0.866, 0.1]], 'mesh')
  // Lanyard loop over the edge.
  d.line([[0.0, 0.87, 0.04], [-0.08, 0.86, 0.1], [-0.1, 0.78, 0.13], [-0.12, 0.7, 0.14], [-0.06, 0.66, 0.13], [0.0, 0.7, 0.12], [0.02, 0.8, 0.1], [0.03, 0.86, 0.06]], 'detail')
  // A sign-out sheet with ruled lines.
  d.box(0.2, 0.004, 0.26, -0.22, 0.778, 0.05, 'paper', 'edge', [0, -0.15, 0])
  for (let i = 0; i < 6; i++) d.line([[-0.3, 0.781, -0.05 + i * 0.035], [-0.14, 0.781, -0.07 + i * 0.035]], 'mesh')
  root.add(d.finish())
  const card = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.004, 0.075), new THREE.MeshBasicMaterial({ map: keycardTexture(), color: 0xffffff, toneMapped: false }))
  card.name = 'Keycard'
  card.position.set(0.06, 0.869, 0.03); card.rotation.y = 0.25
  root.add(card)
  return { root, card, target: new THREE.Vector3(0.06, 0.9, 0.05) }
}

// ---------------------------------------------------------------- door hardware

/**
 * A keycard reader for a door's frame: a wall plate and bolts, the reader's body with its card slot, a red
 * LED that turns green when it opens, a keypad, and conduit up to the lintel. Returns the LED to recolour.
 */
export function cardReader() {
  const root = new THREE.Group()
  const d = new Draft('Keycard reader')
  d.box(0.16, 0.26, 0.012, 0, 1.25, 0.006, 'paper', 'detail')
  for (const [x, y] of [[-0.06, 1.14], [0.06, 1.14], [-0.06, 1.36], [0.06, 1.36]]) bolt(d, x, y, 0.016, 0.012, 0.008)
  d.box(0.1, 0.18, 0.045, 0, 1.25, 0.034, 'paper', 'edge')
  d.box(0.07, 0.008, 0.02, 0, 1.31, 0.06, 'paper', 'detail')
  d.line([[-0.03, 1.305, 0.058], [0.03, 1.305, 0.058]], 'detail')
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) d.box(0.016, 0.014, 0.006, -0.022 + col * 0.022, 1.18 + row * 0.022, 0.058, 'paper', 'detail')
  d.solid(new THREE.CylinderGeometry(0.012, 0.012, 0.9, 10), [0, 1.8, 0.015], 'paper', 'detail', [0, 0, 0], true)
  for (const y of [1.55, 1.95]) d.box(0.04, 0.016, 0.03, 0, y, 0.015, 'paper', 'detail')
  root.add(d.finish())
  const led = lampMesh(LAMP.red, 0.011, true)
  led.position.set(0.03, 1.325, 0.058)
  root.add(led)
  return { root, led }
}

/** A heavy padlock through a hasp on the door leaf (to pick, or breach). */
export function padlock() {
  const d = new Draft('Padlock and hasp')
  d.box(0.05, 0.16, 0.012, 0, 0, 0.006, 'paper', 'edge')
  for (const y of [-0.05, 0.05]) bolt(d, 0, y, 0.014, 0.012, 0.008)
  d.box(0.12, 0.04, 0.01, 0.07, 0.03, 0.016, 'paper', 'detail')
  torus(d, 0.03, 0.009, [0.1, -0.005, 0.035])
  d.box(0.075, 0.07, 0.035, 0.1, -0.06, 0.035, 'paper', 'edge')
  d.ring(0.008, -0.08, 0.1, 0.053, 'detail', 8)
  d.line([[0.1, -0.08, 0.054], [0.1, -0.09, 0.054]], 'detail')
  return d.finish()
}

/** Half a ring (a handle, a shackle) as a smooth solid. */
function torus(d: Draft, radius: number, tube: number, at: Point, rotation: Point = [0, 0, 0]) {
  d.solid(new THREE.TorusGeometry(radius, tube, 8, 20, Math.PI), at, 'paper', 'detail', rotation, true)
}

/**
 * A two-key panel on a wall post: a steel box, its hinged cover, a key switch with the key in it (the key turns
 * with `key.rotation.z`), an A or B plate, a status lamp, and conduit off to the door.
 */
export function keyPanel(letter: string) {
  const root = new THREE.Group()
  const d = new Draft('Two-key panel')
  d.box(0.1, 1.1, 0.1, 0, 0.55, 0, 'paper', 'edge')
  d.box(0.22, 0.02, 0.22, 0, 0.01, 0, 'paper', 'detail')
  for (const [x, z] of [[-0.08, -0.08], [0.08, -0.08], [-0.08, 0.08], [0.08, 0.08]]) bolt(d, x, 0.026, z, 0.016, 0.01)
  d.box(0.34, 0.4, 0.14, 0, 1.3, 0.05, 'paper', 'edge')
  d.box(0.3, 0.36, 0.012, 0, 1.3, 0.126, 'paper', 'detail')
  for (const y of [1.18, 1.42]) d.solid(new THREE.CylinderGeometry(0.01, 0.01, 0.05, 8), [-0.16, y, 0.13], 'paper', 'detail', [0, 0, 0], true)
  for (const [x, y] of [[-0.14, 1.12], [0.14, 1.12], [-0.14, 1.48], [0.14, 1.48]]) bolt(d, x, y, 0.134, 0.012, 0.006)
  d.solid(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 20), [0, 1.3, 0.137], 'paper', 'edge', [Math.PI / 2, 0, 0], true)
  d.ring(0.03, 1.3, 0, 0.148, 'detail', 16)
  d.box(0.16, 0.05, 0.006, 0, 1.43, 0.136, 'paper', 'edge')
  d.solid(new THREE.CylinderGeometry(0.014, 0.014, 0.6, 10), [0.12, 1.75, 0.03], 'paper', 'detail', [0, 0, 0], true)
  d.hatch([0.172, 1.1, -0.02], [0, 0, 0.14], [0, 0.4, 0], { spacing: 0.035, inset: 0.01 })
  root.add(d.finish())
  const plate = stencil(`KEY ${letter}`, 0.15, 0.045)
  plate.position.set(0, 1.43, 0.14)
  const key = new THREE.Group()
  key.position.set(0, 1.3, 0.15)
  const k = new Draft('Key')
  k.box(0.012, 0.05, 0.03, 0, 0.0, 0.015, 'paper', 'detail')
  k.box(0.05, 0.04, 0.01, 0, 0.04, 0.03, 'paper', 'edge')
  key.add(k.finish())
  const lamp = lampMesh(LAMP.amber, 0.018, true)
  lamp.position.set(0.1, 1.2, 0.135)
  root.add(plate, key, lamp)
  return { root, key, lamp, target: new THREE.Vector3(0, 1.3, 0.2) }
}

// ---------------------------------------------------------------- the helicopter radio and the landing zone

/**
 * A field radio set up on an ammunition crate: the set's case, dials, a speaker grille, the handset on its coiled
 * cord, a battery pack strapped on, a whip antenna with a pennant, a folding stool, and a smoke canister.
 */
export function fieldRadio() {
  const root = new THREE.Group()
  const d = new Draft('Field radio')
  d.box(0.8, 0.5, 0.45, 0, 0.25, 0, 'paper', 'edge')
  groundOutline(d, 0, 0, 0.8, 0.45)
  for (const x of [-0.3, 0.3]) { d.box(0.12, 0.04, 0.03, x, 0.46, 0.235, 'paper', 'detail'); d.line([[x - 0.04, 0.2, 0.227], [x + 0.04, 0.3, 0.227]], 'detail') }
  for (const y of [0.1, 0.4]) d.line([[-0.4, y, 0.226], [0.4, y, 0.226]], 'mesh')
  // The set.
  d.box(0.5, 0.3, 0.28, -0.05, 0.65, 0, 'paper', 'edge')
  d.box(0.46, 0.26, 0.012, -0.05, 0.65, 0.146, 'paper', 'detail')
  for (const x of [-0.2, -0.1]) { d.solid(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 16), [x, 0.7, 0.16], 'paper', 'edge', [Math.PI / 2, 0, 0], true); d.line([[x, 0.7, 0.176], [x, 0.725, 0.176]], 'detail') }
  for (let i = 0; i < 5; i++) d.line([[0.05, 0.6 + i * 0.022, 0.155], [0.16, 0.6 + i * 0.022, 0.155]], 'mesh')
  d.box(0.06, 0.03, 0.012, 0.1, 0.74, 0.155, 'paper', 'detail')
  // Battery pack strapped to the side.
  d.box(0.12, 0.22, 0.24, 0.27, 0.61, 0, 'paper', 'edge')
  for (const y of [0.55, 0.67]) d.box(0.13, 0.02, 0.25, 0.27, y, 0, 'paper', 'detail')
  // Handset on its hook, coiled cord.
  d.box(0.05, 0.2, 0.06, -0.33, 0.66, 0.1, 'paper', 'edge', [0, 0, 0.2])
  const coil: Point[] = []
  for (let i = 0; i <= 40; i++) { const t = i / 40; coil.push([-0.31 + t * 0.12 + Math.cos(t * 30) * 0.015, 0.56 - Math.sin(t * Math.PI) * 0.12, 0.1 + Math.sin(t * 30) * 0.015]) }
  d.line(coil, 'detail')
  // Whip antenna and pennant.
  d.solid(new THREE.CylinderGeometry(0.02, 0.025, 0.06, 10), [0.12, 0.83, -0.08], 'paper', 'detail', [0, 0, 0], true)
  d.line([[0.12, 0.86, -0.08], [0.14, 1.6, -0.1], [0.17, 2.3, -0.13]], 'edge')
  d.face([[0.17, 2.3, -0.13], [0.17, 2.18, -0.13], [0.4, 2.24, -0.12]], 'paper', 'detail')
  // A folding stool beside it, and a smoke canister.
  d.box(0.32, 0.03, 0.3, -0.75, 0.42, 0.2, 'paper', 'edge')
  for (const side of [-1, 1]) { d.beam([-0.9, 0.02, 0.2 + side * 0.12], [-0.6, 0.41, 0.2 - side * 0.12], 0.022, 'paper', 'detail'); d.beam([-0.6, 0.02, 0.2 + side * 0.12], [-0.9, 0.41, 0.2 - side * 0.12], 0.022, 'paper', 'detail') }
  d.cylinder(0.05, 0.16, -0.55, 0.08, -0.25, 'paper')
  d.box(0.03, 0.03, 0.06, -0.55, 0.18, -0.25, 'paper', 'detail')
  root.add(d.finish())
  const lamp = lampMesh(LAMP.green, 0.014, true)
  lamp.position.set(0.14, 0.74, 0.158)
  const label = stencil('RADIO', 0.22, 0.06)
  label.position.set(0, 0.2, 0.228)
  root.add(lamp, label)
  return { root, lamp, target: new THREE.Vector3(-0.05, 0.75, 0.2) }
}

/**
 * A landing zone: the painted circle, the H with its outline, corner chevrons, twelve edge lights on their
 * bases, and a windsock on its mast (the sock's cone is its own group, to stream in the rotor wash).
 */
export function landingZone() {
  const root = new THREE.Group()
  const d = new Draft('Landing zone')
  d.ring(4.4, 0.03, 0, 0, 'edge', 72)
  d.ring(4.2, 0.03, 0, 0, 'detail', 72)
  const h: Point[] = [[-1.1, 0.031, -1.5], [-0.6, 0.031, -1.5], [-0.6, 0.031, -0.25], [0.6, 0.031, -0.25], [0.6, 0.031, -1.5], [1.1, 0.031, -1.5],
    [1.1, 0.031, 1.5], [0.6, 0.031, 1.5], [0.6, 0.031, 0.25], [-0.6, 0.031, 0.25], [-0.6, 0.031, 1.5], [-1.1, 0.031, 1.5]]
  d.line(h, 'edge', true)
  d.hatch([-1.05, 0.032, -1.45], [0.4, 0, 0], [0, 0, 2.9], { spacing: 0.09, inset: 0.02 })
  d.hatch([0.65, 0.032, -1.45], [0.4, 0, 0], [0, 0, 2.9], { spacing: 0.09, inset: 0.02 })
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4, c = Math.cos(a), s = Math.sin(a)
    const p = (r: number, off: number): Point => [c * r - s * off, 0.031, s * r + c * off]
    d.line([p(5.6, -0.6), p(5.1, 0), p(5.6, 0.6)], 'detail')
    d.line([p(6, -0.6), p(5.5, 0), p(6, 0.6)], 'detail')
  }
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2, x = Math.cos(a) * 4.7, z = Math.sin(a) * 4.7
    d.cylinder(0.07, 0.06, x, 0.03, z, 'paper')
    d.cylinder(0.035, 0.08, x, 0.1, z, 'paper', 0.03)
  }
  // Windsock mast off the pad.
  d.box(0.5, 0.1, 0.5, 6.5, 0.05, -3.2, 'concrete', 'detail')
  d.solid(new THREE.CylinderGeometry(0.05, 0.07, 4.2, 12), [6.5, 2.2, -3.2], 'paper', 'edge', [0, 0, 0], true)
  for (const y of [1, 2, 3]) d.line([[6.45, y, -3.15], [6.55, y + 0.3, -3.15]], 'mesh')
  d.ring(0.16, 4.3, 6.5, -3.2, 'detail', 16)
  root.add(d.finish())
  const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: LAMP.amber, toneMapped: false }), 12)
  const matrix = new THREE.Matrix4()
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; lights.setMatrixAt(i, matrix.makeTranslation(Math.cos(a) * 4.7, 0.17, Math.sin(a) * 4.7)) }
  const sock = new THREE.Group()
  sock.position.set(6.5, 4.3, -3.2)
  const cone = new Draft('Windsock')
  const geometry = new THREE.CylinderGeometry(0.16, 0.06, 1.2, 16, 1, true)
  geometry.rotateZ(Math.PI / 2); geometry.translate(0.6, 0, 0)
  cone.solid(geometry, [0, 0, 0], 'paper', false, [0, 0, 0], true)
  for (const x of [0.3, 0.6, 0.9]) cone.line(Array.from({ length: 13 }, (_, i): Point => [x, Math.cos(i / 12 * Math.PI * 2) * (0.16 - x * 0.083), Math.sin(i / 12 * Math.PI * 2) * (0.16 - x * 0.083)]), 'detail')
  sock.add(cone.finish())
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.11, 0.3, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xd0302a, side: THREE.DoubleSide, toneMapped: false }))
  stripe.rotation.z = Math.PI / 2; stripe.position.x = 0.35
  sock.add(stripe)
  root.add(lights, sock)
  return { root, sock, lights }
}

// ---------------------------------------------------------------- ammunition and supplies

/**
 * Stacked ammunition: two steel ammo cans with lids, latches and carry handles, an open plank crate with
 * magazines standing in it, and a stencilled 7.62 on the front.
 */
export function ammoStack() {
  const root = new THREE.Group()
  const d = new Draft('Ammunition')
  d.box(0.9, 0.42, 0.5, 0, 0.21, 0, 'paper', 'edge')
  groundOutline(d, 0, 0, 0.9, 0.5)
  for (const x of [-0.42, 0.42]) d.box(0.05, 0.42, 0.52, x, 0.21, 0, 'paper', 'detail')
  for (const y of [0.14, 0.28]) d.line([[-0.4, y, 0.251], [0.4, y, 0.251]], 'mesh')
  // Magazines standing in the open crate.
  for (let i = 0; i < 7; i++) d.box(0.035, 0.16, 0.09, -0.3 + i * 0.1, 0.46, -0.05, 'paper', 'detail', [0.12, 0, 0])
  // Two ammo cans on the right end.
  for (const [x, y] of [[0.2, 0.46], [0.2, 0.66]]) {
    d.box(0.3, 0.19, 0.16, x, y + 0.03, 0.14, 'paper', 'edge')
    d.box(0.32, 0.03, 0.18, x, y + 0.135, 0.14, 'paper', 'detail')
    d.box(0.03, 0.06, 0.03, x + 0.14, y + 0.08, 0.235, 'paper', 'detail')
    torus(d, 0.05, 0.008, [x, y + 0.15, 0.14], [0, 0, 0])
  }
  root.add(d.finish())
  const label = stencil('7.62', 0.3, 0.09)
  label.position.set(-0.1, 0.2, 0.253)
  root.add(label)
  return { root, target: new THREE.Vector3(0, 0.55, 0.15) }
}

/** A first-aid post: a wall cabinet on a stand with a red cross, a stretcher leaning on it, a medic bag. */
export function medicalPost() {
  const root = new THREE.Group()
  const d = new Draft('First aid post')
  d.box(0.08, 1.4, 0.08, 0, 0.7, -0.1, 'paper', 'edge')
  d.box(0.4, 0.04, 0.4, 0, 0.02, -0.1, 'paper', 'detail')
  d.box(0.56, 0.5, 0.2, 0, 1.25, 0, 'paper', 'edge')
  d.box(0.5, 0.44, 0.012, 0, 1.25, 0.106, 'paper', 'detail')
  for (const y of [1.08, 1.42]) d.solid(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 8), [-0.25, y, 0.11], 'paper', 'detail', [0, 0, 0], true)
  d.box(0.03, 0.08, 0.02, 0.22, 1.25, 0.12, 'paper', 'detail')
  // Stretcher leaning on the post.
  for (const side of [-0.22, 0.22]) d.beam([0.55 + side, 0.02, 0.35], [0.45 + side, 1.8, -0.02], 0.035, 'paper', 'edge')
  d.face([[0.35, 0.3, 0.3], [0.75, 0.3, 0.3], [0.69, 1.5, 0.05], [0.29, 1.5, 0.05]], 'paper', 'detail')
  // A medic bag.
  d.box(0.36, 0.22, 0.2, -0.4, 0.11, 0.2, 'paper', 'edge')
  torus(d, 0.08, 0.012, [-0.4, 0.22, 0.2])
  root.add(d.finish())
  const cross = new THREE.Group()
  const red = new THREE.MeshBasicMaterial({ color: 0xd0302a, toneMapped: false })
  for (const [w, h] of [[0.2, 0.06], [0.06, 0.2]]) { const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, h), red); cross.add(bar) }
  cross.position.set(0, 1.25, 0.114)
  const bagCross = cross.clone(); bagCross.scale.setScalar(0.5); bagCross.position.set(-0.4, 0.11, 0.302)
  root.add(cross, bagCross)
  return { root, target: new THREE.Vector3(0, 1.2, 0.2) }
}

// ---------------------------------------------------------------- the camera on its pole

/**
 * A security camera on its pole: a base plate with four anchor bolts, the pole with a junction box and conduit,
 * a bracket arm, and the pan head carrying the housing (sun hood, lens ring, IR ring, cable tail). The pivot
 * and lamp are returned for the security system to turn and colour.
 */
export function cameraPole(height: number) {
  const mount = new Draft('Camera pole')
  mount.box(0.36, 0.03, 0.36, 0, -height + 0.015, 0, 'paper', 'detail')
  for (const [x, z] of [[-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]]) mount.box(0.03, 0.05, 0.03, x, -height + 0.04, z, 'paper', 'detail')
  mount.solid(new THREE.CylinderGeometry(0.055, 0.07, height - 0.12, 12), [0, -height / 2 - 0.06, 0], 'paper', 'edge', [0, 0, 0], true)
  mount.box(0.18, 0.24, 0.1, 0, -height + 1.2, 0.09, 'paper', 'edge')
  mount.box(0.16, 0.22, 0.01, 0, -height + 1.2, 0.143, 'paper', 'detail')
  for (const [x, y] of [[-0.06, -height + 1.1], [0.06, -height + 1.1], [-0.06, -height + 1.3], [0.06, -height + 1.3]]) bolt(mount, x, y, 0.15, 0.01, 0.006)
  mount.solid(new THREE.CylinderGeometry(0.014, 0.014, height - 1.35, 8), [0.05, -(height - 1.35) / 2 - 0.12, 0.08], 'paper', 'detail', [0, 0, 0], true)
  for (const y of [-height + 1.6, -height + 2.2]) mount.box(0.14, 0.02, 0.14, 0, y, 0.03, 'paper', 'detail')
  mount.box(0.12, 0.12, 0.12, 0, -0.08, 0, 'paper', 'edge')
  mount.solid(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), [0, 0.02, 0], 'paper', 'detail', [0, 0, 0], true)
  const pivot = new THREE.Group()
  const casing = new Draft('Camera housing')
  casing.box(0.36, 0.26, 0.62, 0, 0.12, 0.25, 'paper', 'edge')
  casing.box(0.42, 0.03, 0.72, 0, 0.27, 0.3, 'paper', 'edge')
  casing.solid(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 20), [0, 0.12, 0.575], 'paper', 'edge', [Math.PI / 2, 0, 0], true)
  casing.ring(0.07, 0.12, 0, 0.603, 'detail', 16)
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; casing.box(0.014, 0.014, 0.01, Math.cos(a) * 0.085, 0.12 + Math.sin(a) * 0.085, 0.602, 'paper', 'detail') }
  for (const z of [0.05, 0.4]) casing.line([[0.181, 0.0, z], [0.181, 0.24, z]], 'mesh')
  casing.line([[0, 0.02, -0.06], [0.02, -0.06, -0.14], [0.05, -0.1, -0.1]], 'detail')
  casing.hatch([0.182, 0.0, -0.05], [0, 0, 0.6], [0, 0.24, 0], { spacing: 0.04, inset: 0.01 })
  pivot.add(casing.finish())
  const lamp = lampMesh(0x21db66, 0.05, true)
  lamp.name = 'camera status light'
  lamp.position.set(0.14, 0.02, 0.58)
  pivot.add(lamp)
  return { mount: mount.finish(), pivot, lamp }
}

// ---------------------------------------------------------------- dog kennels and sniper nests

/**
 * A dog kennel: plank walls and floor, a pitched roof with shingle rows and a ridge cap, an arched doorway,
 * a name board, the chain on its ground stake, and two bowls.
 */
export function kennel(name: string) {
  const root = new THREE.Group()
  const d = new Draft('Kennel')
  d.box(1.2, 0.08, 1.4, 0, 0.04, 0, 'paper', 'detail')
  for (const side of [-1, 1]) {
    d.box(0.05, 0.8, 1.3, side * 0.575, 0.48, 0, 'paper', 'edge')
    for (let i = 0; i < 5; i++) d.line([[side * 0.601, 0.16 + i * 0.16, -0.64], [side * 0.601, 0.16 + i * 0.16, 0.64]], 'mesh')
  }
  d.box(1.2, 0.8, 0.05, 0, 0.48, -0.625, 'paper', 'edge')
  // Front with an arched doorway.
  const front = new THREE.Shape()
  front.moveTo(-0.6, 0); front.lineTo(0.6, 0); front.lineTo(0.6, 0.8); front.lineTo(0, 1.25); front.lineTo(-0.6, 0.8); front.closePath()
  const hole = new THREE.Path()
  hole.moveTo(-0.25, 0); hole.lineTo(-0.25, 0.42); hole.absarc(0, 0.42, 0.25, Math.PI, 0, true); hole.lineTo(0.25, 0); hole.closePath()
  front.holes.push(hole)
  const face = new THREE.ExtrudeGeometry(front, { depth: 0.05, bevelEnabled: false })
  d.solid(face, [0, 0.08, 0.625], 'paper', 'edge')
  const back = new THREE.Shape(); back.moveTo(-0.6, 0.8); back.lineTo(0.6, 0.8); back.lineTo(0, 1.25); back.closePath()
  d.solid(new THREE.ExtrudeGeometry(back, { depth: 0.05, bevelEnabled: false }), [0, 0.08, -0.65], 'paper', 'detail')
  // Roof: two slopes, shingle rows, a ridge cap.
  for (const side of [-1, 1]) {
    d.box(0.8, 0.04, 1.5, side * 0.33, 1.12, 0, 'paper', 'edge', [0, 0, -side * 0.64])
    for (let i = 1; i < 4; i++) d.line([[side * (0.05 + i * 0.16), 1.37 - i * 0.12, -0.74], [side * (0.05 + i * 0.16), 1.37 - i * 0.12, 0.74]], 'mesh')
  }
  d.box(0.1, 0.06, 1.55, 0, 1.36, 0, 'paper', 'detail')
  // Name board, chain and stake, bowls.
  d.box(0.36, 0.1, 0.012, 0, 0.98, 0.682, 'paper', 'edge')
  d.cylinder(0.02, 0.2, 0.9, 0.1, 0.9, 'paper')
  const chain: Point[] = []
  for (let i = 0; i <= 10; i++) chain.push([0.9 - i * 0.07, 0.02 + Math.sin(i * 1.3) * 0.01, 0.9 - i * 0.02])
  d.line(chain, 'detail')
  for (const [x, z] of [[-0.5, 0.95], [-0.25, 1.05]]) { d.cylinder(0.1, 0.05, x, 0.025, z, 'paper', 0.12); d.ring(0.1, 0.05, x, z, 'detail', 16) }
  d.hatch([-0.6, 0.12, 0.66], [0.35, 0, 0], [0, 0.65, 0], { spacing: 0.05, inset: 0.01 })
  root.add(d.finish())
  const board = stencil(name.toUpperCase(), 0.3, 0.075)
  board.position.set(0, 0.98, 0.69)
  root.add(board)
  return root
}

/**
 * A sniper nest on a roof: a horseshoe of sandbags (instanced, one draw), a camouflage net on four poles, an
 * ammunition can, a spotting scope on its tripod, and a folded tarp.
 */
export function sniperNest() {
  const root = new THREE.Group()
  const bags: THREE.Matrix4[] = []
  const bag = new THREE.CapsuleGeometry(0.13, 0.32, 3, 8)
  bag.rotateZ(Math.PI / 2); bag.scale(1, 0.62, 0.9)
  for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 9; i++) {
    const a = -Math.PI * 0.85 + i / 8 * Math.PI * 1.7 + (layer % 2) * 0.1, r = 1.25
    const m = new THREE.Matrix4().compose(new THREE.Vector3(Math.sin(a) * r, 0.1 + layer * 0.16, Math.cos(a) * r),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + Math.PI / 2), new THREE.Vector3(1, 1, 1))
    bags.push(m)
  }
  const sandbags = new THREE.InstancedMesh(bag, new THREE.MeshBasicMaterial({ color: 0xf4f1e8, toneMapped: false }), bags.length)
  const outline = new THREE.InstancedMesh(bag, new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, toneMapped: false }), bags.length)
  bags.forEach((m, i) => { sandbags.setMatrixAt(i, m); outline.setMatrixAt(i, m.clone().multiply(new THREE.Matrix4().makeScale(1.12, 1.18, 1.12))) })
  const d = new Draft('Sniper nest')
  for (const [x, z] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 0.9], [1.1, 0.9]]) d.beam([x, 0, z], [x * 0.95, 1.75, z * 0.95], 0.04, 'paper', 'detail')
  const net: Point[][] = []
  for (let i = 0; i <= 6; i++) net.push([[-1.05 + i * 0.35, 1.75 - Math.sin(i / 6 * Math.PI) * 0.15, -1.05], [-1.05 + i * 0.35, 1.72 - Math.sin(i / 6 * Math.PI) * 0.15, 0.86]])
  for (const [a, b] of net) d.line([a, b], 'mesh')
  for (let j = 0; j <= 5; j++) d.line(Array.from({ length: 7 }, (_, i): Point => [-1.05 + i * 0.35, 1.74 - Math.sin(i / 6 * Math.PI) * 0.15, -1.05 + j * 0.38]), 'mesh')
  d.box(0.28, 0.18, 0.14, 0.6, 0.09, 0.3, 'paper', 'edge')
  torus(d, 0.05, 0.008, [0.6, 0.19, 0.3])
  for (const a of [0, 2.1, 4.2]) d.beam([-0.5, 0, -0.2], [-0.5 + Math.sin(a) * 0.25, 0.0, -0.2 + Math.cos(a) * 0.25], 0.02, 'paper', 'detail')
  for (const a of [0, 2.1, 4.2]) d.beam([-0.5 + Math.sin(a) * 0.25, 0.0, -0.2 + Math.cos(a) * 0.25], [-0.5, 0.55, -0.2], 0.018, 'paper', 'detail')
  d.solid(new THREE.CylinderGeometry(0.04, 0.05, 0.35, 12), [-0.5, 0.62, -0.1], 'paper', 'edge', [Math.PI / 2 - 0.2, 0, 0], true)
  d.box(0.6, 0.08, 0.35, 0.1, 0.04, -0.7, 'paper', 'edge')
  for (let i = 0; i < 3; i++) d.line([[-0.2 + i * 0.3, 0.081, -0.87], [-0.15 + i * 0.3, 0.081, -0.53]], 'mesh')
  root.add(sandbags, outline, d.finish())
  return root
}

// ---------------------------------------------------------------- the hostage's room

/**
 * Where a hostage is kept in a room: the chair (ropes round its back legs), a coil of rope and a cut zip tie on
 * the floor, a bucket, a water bottle and a bare bulb hanging on its flex.
 */
export function captivity(floorToCeiling = 3) {
  const root = new THREE.Group()
  const d = new Draft('Captivity')
  d.box(0.48, 0.065, 0.46, 0, 0.3, -0.371, 'concrete', 'detail')
  for (const x of [-0.205, 0.205]) for (const z of [-0.56, -0.18]) d.beam([x, 0.025, z], [x, 0.3, z], 0.045, 'roof', 'detail')
  for (const x of [-0.205, 0.205]) d.beam([x, 0.31, -0.56], [x, 0.92, -0.59], 0.04, 'roof', 'detail')
  d.box(0.47, 0.25, 0.05, 0, 0.78, -0.58, 'concrete', 'detail')
  for (const y of [0.45, 0.62]) d.ring(0.06, y, 0, -0.58, 'detail', 12)
  for (const x of [-0.205, 0.205]) d.ring(0.035, 0.12, x, -0.18, 'detail', 10)
  // Rope coil, a bucket, a bottle.
  for (let i = 0; i < 4; i++) d.ring(0.12 - i * 0.015, 0.02 + i * 0.012, 0.55, 0.3, 'detail', 20)
  d.line([[0.43, 0.02, 0.3], [0.3, 0.02, 0.1], [0.2, 0.02, 0.05]], 'detail')
  d.cylinder(0.14, 0.26, -0.6, 0.13, 0.2, 'paper', 0.16)
  d.ring(0.16, 0.26, -0.6, 0.2, 'detail', 20)
  d.line([[-0.75, 0.26, 0.2], [-0.6, 0.38, 0.2], [-0.45, 0.26, 0.2]], 'detail')
  d.cylinder(0.035, 0.22, 0.35, 0.11, -0.5, 'paper', 0.02)
  d.box(0.025, 0.03, 0.025, 0.35, 0.24, -0.5, 'paper', 'detail')
  // The bulb on its flex.
  const top = floorToCeiling - 0.05
  d.line([[0.1, top, 0.1], [0.1, top - 0.9, 0.1]], 'detail')
  d.cylinder(0.025, 0.05, 0.1, top - 0.93, 0.1, 'paper')
  root.add(d.finish())
  const bulb = lampMesh(0xfff2b0, 0.045)
  bulb.position.set(0.1, top - 1.0, 0.1)
  root.add(bulb)
  return root
}

// ---------------------------------------------------------------- guard and dog gear

const gearInk = new THREE.MeshBasicMaterial({ color: 0x0b0b0b, toneMapped: false })
const gearPiece = (shape: THREE.BufferGeometry, at: Point, scale: Point = [1, 1, 1]) => {
  const g = shape.index ? shape.toNonIndexed() : shape
  g.deleteAttribute('uv'); g.deleteAttribute('normal')
  return g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion(), new THREE.Vector3(...scale)))
}
/**
 * A guard's kit on his rig, two draws: a helmet with its brim (and a marksman's ragged hood) on the head, and a
 * radio with its antenna on the chest.
 */
export function guardGear(head: THREE.Object3D, chest: THREE.Object3D, sniper: boolean) {
  const helmet = mergeGeometries([
    gearPiece(new THREE.SphereGeometry(0.135, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), [0, 0.2, 0], [1.08, 0.9, 1.12]),
    gearPiece(new THREE.CylinderGeometry(0.16, 0.16, 0.012, 16), [0, 0.17, 0.01]),
    ...sniper ? [gearPiece(new THREE.ConeGeometry(0.2, 0.18, 7, 1, true), [0, 0.24, -0.03])] : [],
  ])!
  const kit = mergeGeometries([
    gearPiece(new THREE.BoxGeometry(0.06, 0.1, 0.035), [0.09, 0.08, 0.12]),
    gearPiece(new THREE.CylinderGeometry(0.004, 0.004, 0.26, 4), [0.1, 0.25, 0.12]),
  ])!
  const onHead = new THREE.Mesh(helmet, gearInk), onChest = new THREE.Mesh(kit, gearInk)
  head.add(onHead); chest.add(onChest)
  return [onHead, onChest]
}

/** A dog's red collar and its steel tag, one mesh coloured per part. */
export function dogGear(root: THREE.Object3D) {
  const colour = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex), n = g.getAttribute('position').count, tint = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { tint[i * 3] = c.r; tint[i * 3 + 1] = c.g; tint[i * 3 + 2] = c.b }
    g.setAttribute('color', new THREE.BufferAttribute(tint, 3)); return g
  }
  const collar = gearPiece(new THREE.TorusGeometry(0.1, 0.02, 6, 16), [0, 0, 0])
  collar.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2 + 0.6)).translate(0, 0.74, 0.34)
  const geometry = mergeGeometries([colour(collar, 0xd0302a), colour(gearPiece(new THREE.SphereGeometry(0.025, 8, 6), [0, 0.66, 0.4]), 0xc9c6bd)])!
  root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })))
}
