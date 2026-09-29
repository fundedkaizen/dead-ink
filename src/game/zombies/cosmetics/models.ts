import * as THREE from 'three'
import { applyPenMaterial, penPalette } from '../../../render/ballpoint'
import { box, gun, metal, part, path, tube, type Gun, type V } from '../../../lab/weapons/models/common'
import { RARITY_INFO } from '../../loot'
import type { CamoId, CharmId, GloveId, KnifeId, WatchId } from './catalogue'

/**
 * First-person cosmetics, drawn like the guns: paper faces, black contours, built through the gun
 * batcher so every copy shares one set of geometry. Colour only where rarity earns it.
 *
 * Every model uses the gun frame (+Z forward, +Y up, metres). Knives are gripped at the origin with the
 * blade along +Z; charms hang from the origin down -Y; a watch's band wraps the Y axis (the forearm) with
 * its face toward +Z.
 */

const paperLike = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 })
/** Gold is the legendary colour everywhere in the game; the watches and charms borrow it. */
const GOLD = paperLike(0xe3b04b)
const GOLD_PALE = paperLike(0xf2dca0)
const GEM = paperLike(0xe6f6ff)
const INK = paperLike(penPalette.ink)
const STEEL_DARK = paperLike(0x3a3a3a)
/** Handles and straps are hatched, like shaded paper, so they read apart from bright blades. */
const HATCH = applyPenMaterial(paperLike(penPalette.paper), { density: 0.42, scale: 320, seed: 311 })
const HATCH_DENSE = applyPenMaterial(paperLike(penPalette.paper), { density: 0.7, scale: 380, seed: 419 })
/**
 * A charm hangs from the gun, so anything that repaints a gun's plain paper (a camo, the Pack-a-Punch
 * shimmer) would repaint the charm too. Its paper is a separate material that looks the same.
 */
const CHARM_PAPER = paperLike(penPalette.paper)
/** Mythic pink-gold, the dark violet under a skeleton dial, and the pink that glows (pulsed by animateCosmetics). */
const ROSE = paperLike(0xe9a6a1)
const VIOLET_DARK = paperLike(0x1c0a24)
const MYTHIC_PINK = new THREE.Color(RARITY_INFO.mythic.color), MYTHIC_PALE = new THREE.Color(0xffb8dc)
const GLOW = paperLike(RARITY_INFO.mythic.color)
/** The halo behind the Ink Heart: no outline, just light. */
const HALO = new THREE.MeshBasicMaterial({ color: RARITY_INFO.mythic.color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })

/** Parts named here are recoloured after batching; the batcher itself draws every face as paper. */
function tint(model: Gun, materials: Record<string, THREE.Material>) {
  for (const [name, material] of Object.entries(materials)) {
    model.userData.parts[name]?.traverse(object => {
      if (object instanceof THREE.Mesh && object.material === metal) object.material = material
    })
  }
  return model
}

/** Extrude a side silhouette ([Z, Y] points) across a thin width: blades and flat plates. */
function plate(points: [number, number][], width: number, pos: V = [0, 0, 0]) {
  const shape = new THREE.Shape()
  points.forEach(([z, y], i) => i ? shape.lineTo(-z, y) : shape.moveTo(-z, y))
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false })
  geometry.rotateY(Math.PI / 2).translate(-width / 2, 0, 0)
  return part(geometry, metal, pos)
}

const line = (points: [number, number, number][], seed: number, width = 1.2) =>
  path(points.map(p => new THREE.Vector3(...p)), seed, width)

const group = (parts: Record<string, THREE.Object3D>, name: string, parent: THREE.Object3D, pos: V = [0, 0, 0]) => {
  const g = new THREE.Group()
  g.position.set(...pos)
  parts[name] = g
  parent.add(g)
  return g
}

// ---------------------------------------------------------------- knives

/** Ribs around a handle: small raised bands so the grip reads as a grip. */
function ribs(target: THREE.Object3D, from: number, to: number, count: number, w: number, h: number) {
  for (let i = 0; i < count; i++) target.add(box(w + 0.003, h + 0.003, 0.004, [0, 0, from + (to - from) * i / (count - 1)]))
}

function combat(): Gun {
  const model = gun('pistol', 'pistol', false, [0, 0, 0.225], [0, 0, 0], (g, parts) => {
    const handle = group(parts, 'handle', g)
    handle.add(box(0.024, 0.03, 0.11, [0, 0, -0.012]))
    ribs(handle, -0.05, 0.03, 5, 0.024, 0.03)
    g.add(box(0.03, 0.034, 0.012, [0, 0, -0.072]))
    g.add(box(0.02, 0.066, 0.008, [0, -0.004, 0.047]))
    g.add(plate([[0.05, 0.013], [0.17, 0.013], [0.2, 0.006], [0.226, -0.005], [0.19, -0.016], [0.05, -0.017]], 0.004))
    g.add(line([[0.0025, -0.009, 0.055], [0.0025, -0.009, 0.185], [0.0025, -0.003, 0.212]], 71))
    g.add(line([[0.0025, 0.004, 0.06], [0.0025, 0.004, 0.16]], 72, 0.9))
  }, 'cosmetic:knife:combat')
  return tint(model, { handle: HATCH })
}

function bayonet(): Gun {
  const model = gun('pistol', 'pistol', false, [0, 0, 0.27], [0, 0, 0], (g, parts) => {
    const handle = group(parts, 'handle', g)
    handle.add(box(0.022, 0.032, 0.115, [0, 0, -0.012]))
    ribs(handle, -0.055, 0.035, 7, 0.022, 0.032)
    g.add(box(0.026, 0.036, 0.016, [0, 0, -0.075]))
    g.add(box(0.018, 0.075, 0.009, [0, 0.004, 0.05]))
    // The muzzle ring on top of the guard is what makes it a bayonet.
    g.add(part(new THREE.TorusGeometry(0.011, 0.0028, 8, 18), metal, [0, 0.045, 0.05]))
    g.add(plate([[0.054, 0.012], [0.235, 0.012], [0.27, -0.001], [0.235, -0.014], [0.054, -0.014]], 0.004))
    g.add(line([[0.0025, 0.0, 0.07], [0.0025, 0.0, 0.215]], 81, 1.6))
    g.add(line([[-0.0025, 0.0, 0.07], [-0.0025, 0.0, 0.215]], 82, 1.6))
  }, 'cosmetic:knife:bayonet')
  return tint(model, { handle: HATCH_DENSE })
}

function cleaver(): Gun {
  const model = gun('pistol', 'pistol', false, [0, 0, 0.2], [0, 0, 0], (g, parts) => {
    const handle = group(parts, 'handle', g)
    handle.add(box(0.022, 0.028, 0.105, [0, 0, -0.02]))
    for (const z of [-0.05, -0.005]) handle.add(tube(0.004, 0.026, [0, 0, z], metal, [0, 0, 90]))
    g.add(box(0.012, 0.03, 0.016, [0, 0.0, 0.037]))
    g.add(plate([[0.043, 0.024], [0.2, 0.03], [0.205, -0.068], [0.043, -0.06]], 0.005))
    g.add(part(new THREE.RingGeometry(0.004, 0.0085, 14), metal, [0.003, 0.01, 0.18], [0, 90, 0]))
    g.add(line([[0.003, -0.05, 0.048], [0.003, -0.056, 0.2]], 91, 1.4))
  }, 'cosmetic:knife:cleaver')
  return tint(model, { handle: HATCH })
}

function karambit(): Gun {
  const model = gun('pistol', 'pistol', false, [0, -0.07, 0.14], [0, 0, 0], (g, parts) => {
    const handle = group(parts, 'handle', g)
    handle.add(box(0.022, 0.03, 0.1, [0, 0, -0.01], metal, [-8, 0, 0]))
    ribs(handle, -0.045, 0.02, 4, 0.022, 0.03)
    // The finger ring: the knife spins around it.
    const ring = group(parts, 'ring', g, [0, 0.004, -0.083])
    ring.add(part(new THREE.TorusGeometry(0.021, 0.0055, 8, 22), metal, [0, 0, 0], [0, 90, 0]))
    g.add(plate([[0.036, 0.015], [0.078, 0.013], [0.113, -0.004], [0.134, -0.034], [0.139, -0.078],
      [0.121, -0.046], [0.103, -0.023], [0.076, -0.009], [0.036, -0.013]], 0.004))
    g.add(line([[0.0025, -0.004, 0.05], [0.0025, -0.008, 0.09], [0.0025, -0.022, 0.115], [0.0025, -0.05, 0.13]], 101, 1.1))
  }, 'cosmetic:knife:karambit')
  return tint(model, { handle: HATCH_DENSE, ring: HATCH_DENSE })
}

/** Butterfly: the blade and one handle swing on the pivot, so the idle flourish can flip it. */
function butterfly(): Gun {
  const pivot = 0.052
  const model = gun('pistol', 'pistol', false, [0, 0, 0.19], [0, 0, 0], (g, parts) => {
    const fixed = group(parts, 'handleA', g)
    fixed.add(box(0.008, 0.026, 0.125, [0.0075, 0, -0.01]))
    for (const z of [-0.05, -0.02, 0.01]) fixed.add(box(0.0095, 0.008, 0.014, [0.0075, 0, z]))
    const swing = group(parts, 'handleB', g, [0, 0, pivot])
    swing.add(box(0.008, 0.026, 0.125, [-0.0075, 0, -pivot - 0.01]))
    swing.add(box(0.012, 0.006, 0.018, [-0.004, 0.012, -pivot - 0.066]))
    const blade = group(parts, 'blade', g, [0, 0, pivot])
    blade.add(plate([[0, 0.01], [0.11, 0.01], [0.138, 0.0], [0.11, -0.013], [0.012, -0.013]], 0.004))
    blade.add(line([[0.0025, -0.007, 0.012], [0.0025, -0.007, 0.112]], 111, 1.1))
    g.add(tube(0.0045, 0.03, [0, 0, pivot], metal, [0, 0, 90]))
  }, 'cosmetic:knife:butterfly')
  return tint(model, { handleA: HATCH, handleB: HATCH })
}

/** Mythic: a karambit in dark violet steel whose cutting edge glows pink, with a pink-gold finger ring. */
function heartline(): Gun {
  const model = gun('pistol', 'pistol', false, [0, -0.07, 0.14], [0, 0, 0], (g, parts) => {
    const handle = group(parts, 'handle', g)
    handle.add(box(0.022, 0.03, 0.1, [0, 0, -0.01], metal, [-8, 0, 0]))
    ribs(handle, -0.045, 0.02, 4, 0.022, 0.03)
    const ring = group(parts, 'ring', g, [0, 0.004, -0.083])
    ring.add(part(new THREE.TorusGeometry(0.021, 0.0055, 8, 22), metal, [0, 0, 0], [0, 90, 0]))
    // The whole blade glows; a dark spine laid over it leaves only the inner curve (the edge) showing.
    const edge = group(parts, 'edge', g)
    edge.add(plate([[0.036, 0.015], [0.078, 0.013], [0.113, -0.004], [0.134, -0.034], [0.139, -0.078],
      [0.121, -0.046], [0.103, -0.023], [0.076, -0.009], [0.036, -0.013]], 0.004))
    const spine = group(parts, 'spine', g)
    spine.add(plate([[0.036, 0.016], [0.078, 0.014], [0.114, -0.004], [0.135, -0.034], [0.137, -0.066],
      [0.126, -0.042], [0.107, -0.018], [0.077, -0.004], [0.036, -0.008]], 0.0048))
    g.add(line([[0.0026, 0.006, 0.05], [0.0026, 0.005, 0.09], [0.0026, -0.006, 0.114]], 121, 1.1))
  }, 'cosmetic:knife:heartline')
  return tint(model, { handle: HATCH_DENSE, ring: ROSE, edge: GLOW, spine: VIOLET_DARK })
}

export const KNIFE_BUILDERS: Record<KnifeId, () => Gun> = { combat, bayonet, cleaver, karambit, butterfly, heartline }

// ---------------------------------------------------------------- watches

const BAND_RADIUS = 0.041

/** Case, dial, hands and crown, shared by every watch; the face points along +Z. */
function watchHead(g: THREE.Group, parts: Record<string, THREE.Object3D>, style: { caseTo: string; dialTo: string; bezel?: 'plain' | 'diver' | 'fluted' | 'gems' }) {
  const head = group(parts, style.caseTo, g, [0, 0, BAND_RADIUS + 0.004])
  head.add(part(new THREE.CylinderGeometry(0.019, 0.019, 0.009, 24), metal, [0, 0, 0], [90, 0, 0]))
  for (const y of [-1, 1]) for (const x of [-1, 1]) head.add(box(0.005, 0.009, 0.004, [x * 0.009, y * 0.02, -0.002]))
  head.add(tube(0.0025, 0.005, [0.021, 0, 0], metal, [0, 0, 90]))
  const dial = group(parts, style.dialTo, head)
  dial.add(part(new THREE.CircleGeometry(0.0145, 24), metal, [0, 0, 0.0047]))
  // Twelve ticks and two hands in ink: ten past ten, the way watches are photographed.
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, r0 = i % 3 ? 0.0115 : 0.0098
    head.add(line([[Math.sin(a) * r0, Math.cos(a) * r0, 0.005], [Math.sin(a) * 0.0135, Math.cos(a) * 0.0135, 0.005]], 200 + i, i % 3 ? 0.7 : 1.1))
  }
  head.add(line([[0, 0, 0.0052], [-0.0085, 0.005, 0.0052]], 221, 1.6))
  head.add(line([[0, 0, 0.0052], [0.0095, 0.0075, 0.0052]], 222, 1.2))
  const bezel = style.bezel ?? 'plain'
  if (bezel === 'gems') {
    const gems = group(parts, 'gems', head)
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8
      gems.add(part(new THREE.OctahedronGeometry(0.0028), metal, [Math.sin(a) * 0.0172, Math.cos(a) * 0.0172, 0.0055]))
    }
  } else {
    head.add(part(new THREE.TorusGeometry(0.0168, 0.0026, 6, 28), metal, [0, 0, 0.0048]))
    if (bezel !== 'plain') for (let i = 0; i < (bezel === 'fluted' ? 24 : 12); i++) {
      const a = i * Math.PI * 2 / (bezel === 'fluted' ? 24 : 12)
      head.add(line([[Math.sin(a) * 0.0152, Math.cos(a) * 0.0152, 0.0072], [Math.sin(a) * 0.0186, Math.cos(a) * 0.0186, 0.0072]], 240 + i, 0.8))
    }
  }
}

/** A bracelet of links (metal watches) or a plain strap (tactical). */
function band(g: THREE.Group, parts: Record<string, THREE.Object3D>, to: string, links: boolean, centreTo?: string) {
  const strap = group(parts, to, g)
  strap.add(part(new THREE.CylinderGeometry(BAND_RADIUS, BAND_RADIUS, 0.017, 28, 1, true), metal, [0, 0, 0]))
  if (!links) return
  for (let i = 0; i < 18; i++) {
    const a = i * Math.PI * 2 / 18
    const x = Math.sin(a) * (BAND_RADIUS + 0.0006), z = Math.cos(a) * (BAND_RADIUS + 0.0006)
    strap.add(line([[x, -0.0085, z], [x, 0.0085, z]], 260 + i, 0.8))
  }
  if (centreTo) {
    const centre = group(parts, centreTo, g)
    centre.add(part(new THREE.CylinderGeometry(BAND_RADIUS + 0.0012, BAND_RADIUS + 0.0012, 0.0065, 28, 1, true), metal, [0, 0, 0]))
  }
}

function watch(id: WatchId): Gun {
  const model = gun('pistol', 'pistol', false, [0, 0, 0], [0, 0, 0], (g, parts) => {
    if (id === 'tactical') { band(g, parts, 'strap', false); watchHead(g, parts, { caseTo: 'case', dialTo: 'dial' }) }
    if (id === 'diver') { band(g, parts, 'strap', true); watchHead(g, parts, { caseTo: 'case', dialTo: 'dial', bezel: 'diver' }) }
    if (id === 'two-tone') { band(g, parts, 'strap', true, 'gold'); watchHead(g, parts, { caseTo: 'case', dialTo: 'dial', bezel: 'fluted' }) }
    if (id === 'president') { band(g, parts, 'gold', true); watchHead(g, parts, { caseTo: 'goldCase', dialTo: 'dial', bezel: 'fluted' }) }
    if (id === 'diamond') { band(g, parts, 'gold', true); watchHead(g, parts, { caseTo: 'goldCase', dialTo: 'dial', bezel: 'gems' }) }
    if (id === 'skeleton') { band(g, parts, 'rose', true); watchHead(g, parts, { caseTo: 'roseCase', dialTo: 'dial', bezel: 'fluted' }); skeletonGears(parts) }
  }, `cosmetic:watch:${id}`)
  // Inner parts first: tinting the case would otherwise paint the dial and gears inside it too.
  if (id === 'skeleton') return tint(model, { gearA: ROSE, gearB: ROSE, gearC: ROSE, jewels: GLOW, dial: VIOLET_DARK, roseCase: ROSE, rose: ROSE })
  const dial = id === 'tactical' || id === 'diver' ? STEEL_DARK : id === 'president' || id === 'diamond' ? GOLD_PALE : metal
  return tint(model, { strap: id === 'tactical' ? HATCH_DENSE : metal, gold: GOLD, goldCase: GOLD, case: id === 'tactical' ? HATCH_DENSE : metal,
    dial, gems: GEM })
}

/** One flat gear: a rim, teeth and spokes, centred on its part's origin so it can turn in place. */
function gearInto(target: THREE.Object3D, radius: number, teeth: number) {
  target.add(part(new THREE.RingGeometry(radius * 0.72, radius, 20), metal, [0, 0, 0]))
  for (let i = 0; i < teeth; i++) {
    const a = i * Math.PI * 2 / teeth
    target.add(part(new THREE.PlaneGeometry(radius * 0.32, radius * 0.34), metal, [Math.sin(a) * radius * 1.12, Math.cos(a) * radius * 1.12, 0], [0, 0, -a * THREE.MathUtils.RAD2DEG]))
  }
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3
    target.add(line([[0, 0, 0.0001], [Math.sin(a) * radius * 0.74, Math.cos(a) * radius * 0.74, 0.0001]], 330 + teeth + i, 0.7))
  }
}

/** The skeleton's movement, seen through its open dial: three meshing gears on pink jewels. */
function skeletonGears(parts: Record<string, THREE.Object3D>) {
  const head = parts.roseCase
  const z = 0.0049
  const gears: [string, number, number, number, number][] = [['gearA', -0.0048, -0.003, 0.0055, 12], ['gearB', 0.0058, 0.0028, 0.0042, 9], ['gearC', 0.0014, -0.0092, 0.003, 7]]
  const jewels = group(parts, 'jewels', head)
  for (const [name, x, y, r, teeth] of gears) {
    gearInto(group(parts, name, head, [x, y, z]), r, teeth)
    jewels.add(part(new THREE.CircleGeometry(0.0011, 8), metal, [x, y, z + 0.0002]))
  }
}

export const buildWatch = (id: WatchId) => watch(id)

// ---------------------------------------------------------------- charms

/** Every charm hangs this far below its ring; the pendulum swings about the ring. */
const CHARM_SCALE = 1.5
export const CHARM_LENGTH = 0.034 * CHARM_SCALE

/** A heart outline as [Z, Y] points, `size` tall, centred on the origin. */
function heartPoints(size: number, count: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / count * Math.PI * 2, k = size / 30
    return [16 * Math.sin(t) ** 3 * k, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 2.5) * k] as [number, number]
  })
}

function charm(id: CharmId): Gun {
  const model = gun('pistol', 'pistol', false, [0, 0, 0], [0, 0, 0], (g, parts) => {
    g.add(part(new THREE.TorusGeometry(0.0035, 0.001, 6, 12), metal, [0, 0, 0], [0, 90, 0]))
    g.add(line([[0, -0.003, 0], [0, -0.012, 0.0006], [0, -0.02, 0], [0, -0.026, 0]], 300, 1.3))
    const y = -0.034
    if (id === 'skull') {
      g.add(part(new THREE.SphereGeometry(0.0095, 14, 10), metal, [0, y, 0]))
      g.add(box(0.011, 0.006, 0.009, [0, y - 0.009, 0.001]))
      const eyes = group(parts, 'ink', g)
      for (const x of [-1, 1]) eyes.add(part(new THREE.CircleGeometry(0.0026, 10), metal, [x * 0.0036, y - 0.001, 0.0092]))
      eyes.add(part(new THREE.CircleGeometry(0.0013, 6), metal, [0, y - 0.0048, 0.0094]))
    }
    if (id === 'dice') {
      g.add(box(0.012, 0.012, 0.012, [-0.004, y, 0], metal, [20, 30, 10]))
      g.add(box(0.01, 0.01, 0.01, [0.007, y - 0.011, 0.002], metal, [-15, 50, 25]))
      const pips = group(parts, 'ink', g)
      for (const [px, py] of [[-0.003, 0.003], [0, 0], [0.003, -0.003]]) pips.add(part(new THREE.CircleGeometry(0.0012, 8), metal, [-0.004 + px, y + py, 0.0065]))
    }
    if (id === 'ink-drop') {
      const drop = group(parts, 'ink', g)
      drop.add(part(new THREE.SphereGeometry(0.009, 14, 10), metal, [0, y - 0.004, 0]))
      drop.add(part(new THREE.ConeGeometry(0.0078, 0.014, 14), metal, [0, y + 0.007, 0]))
      g.add(part(new THREE.CircleGeometry(0.0022, 8), metal, [-0.003, y - 0.001, 0.0092]))
    }
    if (id === 'teddy') {
      const bear = group(parts, 'hatch', g)
      bear.add(part(new THREE.SphereGeometry(0.0072, 12, 10), metal, [0, y + 0.002, 0]))
      for (const x of [-1, 1]) bear.add(part(new THREE.SphereGeometry(0.0028, 8, 6), metal, [x * 0.0058, y + 0.0078, 0]))
      bear.add(part(new THREE.SphereGeometry(0.0085, 12, 10), metal, [0, y - 0.011, 0]))
      for (const x of [-1, 1]) {
        bear.add(part(new THREE.SphereGeometry(0.0033, 8, 6), metal, [x * 0.0082, y - 0.008, 0.002]))
        bear.add(part(new THREE.SphereGeometry(0.0036, 8, 6), metal, [x * 0.0052, y - 0.019, 0.002]))
      }
      g.add(part(new THREE.SphereGeometry(0.0026, 8, 6), metal, [0, y + 0.0005, 0.0065]))
    }
    if (id === 'crane') {
      // Four flat folds: body, two wings, neck and tail.
      g.add(plate([[-0.012, 0], [0, 0.004], [0.012, 0], [0, -0.006]], 0.0015, [0, y, 0]))
      g.add(plate([[-0.013, 0.003], [-0.004, 0.0], [-0.016, 0.013]], 0.0015, [0, y, 0]))
      g.add(plate([[0.013, 0.003], [0.004, 0.0], [0.017, 0.015], [0.019, 0.013]], 0.0015, [0, y, 0]))
      const wing = part(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.016, 0.004), new THREE.Vector2(0.006, 0.012)])), metal, [0.001, y + 0.001, 0])
      wing.rotation.y = Math.PI / 2; wing.rotation.x = -0.5
      g.add(wing)
    }
    if (id === 'ink-heart') {
      // A pink-gold locket, a heart of ink set in it and, in the ink, a heart of glowing pink.
      group(parts, 'rose', g).add(plate(heartPoints(0.011, 24), 0.005, [0, y, 0]))
      group(parts, 'ink', g).add(plate(heartPoints(0.0078, 24), 0.0058, [0, y + 0.0004, 0]))
      group(parts, 'core', g).add(plate(heartPoints(0.0042, 20), 0.0064, [0, y + 0.0008, 0]))
    }
    if (id === 'golden-bullet') {
      const bullet = group(parts, 'gold', g)
      bullet.add(part(new THREE.CylinderGeometry(0.0045, 0.0045, 0.017, 12), metal, [0, y - 0.002, 0]))
      bullet.add(part(new THREE.ConeGeometry(0.0045, 0.009, 12), metal, [0, y - 0.0145, 0], [180, 0, 0]))
      bullet.add(part(new THREE.CylinderGeometry(0.005, 0.005, 0.0025, 12), metal, [0, y + 0.0065, 0]))
    }
  }, `cosmetic:charm:${id}`)
  // Drawn at real size a charm is a speck at arm's length; half as big again reads without crowding the gun.
  model.scale.setScalar(CHARM_SCALE)
  tint(model, { core: GLOW, ink: INK, hatch: HATCH, gold: GOLD, rose: ROSE })
  model.traverse(object => { if (object instanceof THREE.Mesh && object.material === metal) object.material = CHARM_PAPER })
  if (id === 'ink-heart') {
    // The glow: a soft heart of light behind the locket, seen from both sides, no ink line. animateCosmetics pulses it.
    const shape = new THREE.Shape(heartPoints(0.017, 32).map(([z, y]) => new THREE.Vector2(-z, y)))
    const halo = new THREE.Mesh(new THREE.ShapeGeometry(shape), HALO)
    halo.rotation.y = Math.PI / 2
    const holder = new THREE.Group()
    holder.position.set(0, -0.034, 0)
    holder.add(halo)
    model.add(holder)
    model.userData.parts.halo = holder
  }
  return model
}

export const buildCharm = (id: CharmId) => charm(id)

// ---------------------------------------------------------------- camos

const CAMO_CODE: Record<CamoId, number> = { stripes: 0, woodland: 1, digital: 2, obsidian: 3, gold: 4,
  crosshatch: 5, blueprint: 6, 'red-ink': 7, 'black-gold': 8, diamond: 9, nebula: 10,
  'ink-wash': 11, newsprint: 12, topo: 13, 'love-letter': 14, circuit: 15, molten: 16 }
/** Camos that move: their shared clock runs while one is drawn. */
const ANIMATED_CAMOS: readonly CamoId[] = ['diamond', 'nebula', 'circuit', 'molten']
const camoMaterials = new Map<CamoId, THREE.MeshBasicMaterial>()
/**
 * Seconds for the animated camos (Diamond's glints), shared by every copy. Advanced as the material draws,
 * so it costs nothing while no Diamond gun is on screen; held still under reduced motion.
 */
const camoTime = { value: 0 }
const reducedMotion = () => typeof document !== 'undefined' && document.body?.dataset.reducedMotion === 'true'

/**
 * A camo replaces a gun's paper faces. Batched gun faces carry no UVs, so the pattern is projected from
 * gun-space position on the three axes (like the pen hatching) and never stretches along a barrel.
 */
export function camoMaterial(id: CamoId) {
  const cached = camoMaterials.get(id)
  if (cached) return cached
  const material = metal.clone()
  material.defines = { CAMO: CAMO_CODE[id] }
  material.onBeforeCompile = shader => {
    shader.uniforms.camoGold = { value: new THREE.Color(RARITY_INFO.legendary.color) }
    shader.uniforms.camoTime = camoTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCamoPosition;
        varying vec3 vCamoNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCamoPosition = position;
        vCamoNormal = normal;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCamoPosition;
        varying vec3 vCamoNormal;
        uniform vec3 camoGold;
        uniform float camoTime;
        float camoHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float camoNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(camoHash(i), camoHash(i + vec2(1.0, 0.0)), f.x), mix(camoHash(i + vec2(0.0, 1.0)), camoHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float camoFbm(vec2 p) { return camoNoise(p) * 0.6 + camoNoise(p * 2.13) * 0.28 + camoNoise(p * 4.37) * 0.12; }
        float camoDot2(vec2 v) { return dot(v, v); }
        // A heart's signed distance (0 at its outline, negative inside), about a unit tall, point down at y 0.
        float camoHeart(vec2 p) {
          p.x = abs(p.x);
          if (p.y + p.x > 1.0) return sqrt(camoDot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
          return sqrt(min(camoDot2(p - vec2(0.0, 1.0)), camoDot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
        }
        vec3 camoPattern(vec2 p) {
          #if CAMO == 0
            float band = fract(p.x * 22.0 + p.y * 9.0 + sin(p.y * 70.0 + p.x * 30.0) * 0.25 + camoFbm(p * 60.0) * 0.9);
            float stripe = smoothstep(0.64, 0.68, band) * (1.0 - smoothstep(0.83, 0.87, band));
            return mix(vec3(1.0), vec3(0.0), stripe);
          #elif CAMO == 1
            float n = camoFbm(p * 32.0 + 3.1);
            float m = camoFbm(p * 55.0 - 7.3);
            vec3 c = vec3(1.0);
            c = mix(c, vec3(0.45), smoothstep(0.44, 0.47, n));
            c = mix(c, vec3(0.13), smoothstep(0.58, 0.61, n));
            c = mix(c, vec3(0.005), smoothstep(0.62, 0.65, m));
            return c;
          #elif CAMO == 2
            vec2 cell = floor(p / 0.011);
            float clump = camoNoise(cell * 0.22);
            float pick = camoHash(cell) * 0.35 + clump * 0.65;
            return pick > 0.62 ? vec3(0.01) : pick > 0.47 ? vec3(0.18) : pick > 0.36 ? vec3(0.5) : vec3(1.0);
          #elif CAMO == 3
            float vein = abs(camoFbm(p * 26.0) - 0.5);
            vec3 glass = mix(vec3(0.004, 0.003, 0.006), vec3(0.03, 0.018, 0.045), camoNoise(p * 12.0));
            return mix(vec3(0.62, 0.52, 0.78), glass, smoothstep(0.012, 0.03, vein));
          #elif CAMO == 4
            float leaf = camoFbm(p * 40.0);
            float hatch = step(0.82, fract((p.x + p.y) * 260.0)) * 0.25;
            return camoGold * (0.82 + leaf * 0.35) - hatch * 0.2;
          #elif CAMO == 5
            // Crosshatch: pen hatching laid in three passes, darker where the noise says shade.
            float shade = camoFbm(p * 26.0 + 1.7);
            float wob = camoNoise(p * 90.0) * 0.5;
            float a = step(0.74, fract((p.x + p.y) * 170.0 + wob)) * step(0.34, shade);
            float b = step(0.74, fract((p.x - p.y) * 170.0 + wob)) * step(0.5, shade);
            float c = step(0.76, fract(p.y * 190.0 + wob)) * step(0.66, shade);
            return mix(vec3(0.96), vec3(0.015), max(a, max(b, c)));
          #elif CAMO == 6
            // Blueprint: blue paper, a faint fine grid, bold lines every fifth and construction circles.
            vec3 blue = vec3(0.012, 0.085, 0.36);
            vec2 fine = abs(fract(p / 0.012) - 0.5);
            vec2 bold = abs(fract(p / 0.06) - 0.5);
            float circle = 1.0 - smoothstep(0.0, 0.02, abs(length(fract(p / 0.09 + 0.25) - 0.5) - 0.32));
            float line = max(step(0.43, max(fine.x, fine.y)) * 0.3, max(step(0.47, max(bold.x, bold.y)), circle * 0.75));
            return mix(blue * (0.9 + camoNoise(p * 20.0) * 0.2), vec3(0.8, 0.9, 1.0), line);
          #elif CAMO == 7
            // Red Ink: paper soaked through, dark where it pooled, spattered at the edges.
            float n = camoFbm(p * 24.0 + 11.0);
            float m = camoFbm(p * 66.0 - 4.0);
            vec3 red = vec3(0.6, 0.028, 0.02), deep = vec3(0.16, 0.0, 0.004);
            vec3 c = vec3(0.97, 0.94, 0.92);
            float soak = smoothstep(0.44, 0.48, n);
            c = mix(c, red, soak);
            c = mix(c, deep, smoothstep(0.6, 0.64, n) * smoothstep(0.45, 0.5, m));
            float spatter = step(0.94, camoHash(floor(p / 0.005))) * step(0.36, n);
            return mix(c, red, spatter * (1.0 - soak));
          #elif CAMO == 8
            // Black Gold: black lacquer veined with gold leaf.
            float vein = abs(camoFbm(p * 20.0) - 0.5);
            float fine = abs(camoFbm(p * 46.0 + 5.0) - 0.5);
            vec3 lacquer = vec3(0.004) + vec3(0.012) * camoNoise(p * 36.0);
            float g = 1.0 - smoothstep(0.01, 0.026, vein);
            g = max(g, (1.0 - smoothstep(0.005, 0.012, fine)) * 0.75);
            return mix(lacquer, camoGold * 1.08, g);
          #elif CAMO == 11
            // Ink Wash: watercolour blots, pale in the middle and dark where the water dried at their edges.
            float n = camoFbm(p * 14.0 + 2.0);
            float m = camoFbm(p * 31.0 - 5.0);
            vec3 c = vec3(0.97);
            c = mix(c, vec3(0.62), smoothstep(0.44, 0.6, n) * 0.85);
            c = mix(c, vec3(0.16), (1.0 - smoothstep(0.0, 0.025, abs(n - 0.46))) * 0.75);
            c = mix(c, vec3(0.08), smoothstep(0.67, 0.71, m) * 0.8);
            return c;
          #elif CAMO == 12
            // Newsprint: blocks of halftone dots and blocks of tiny type, on grey-white paper.
            vec2 block = floor(p / vec2(0.07, 0.05));
            float kind = camoHash(block + 4.1);
            vec3 paper = vec3(0.9, 0.89, 0.85);
            float shade = camoFbm(p * 18.0 + block);
            vec2 g = fract(p / 0.005) - 0.5;
            float halftone = 1.0 - step(0.12 + shade * 0.32, length(g));
            vec2 t = vec2(p.x / 0.01, p.y / 0.0045);
            float word = step(0.28, camoHash(floor(t) + block * 7.0));
            float type = step(0.45, fract(t.y)) * word * step(0.06, fract(p.x / 0.07)) * step(fract(p.x / 0.07), 0.94);
            float rule = 1.0 - smoothstep(0.0, 0.0015, abs(fract(p.y / 0.05) - 0.02) * 0.05);
            return mix(paper, vec3(0.06), max(kind < 0.45 ? halftone * 0.9 : type * 0.85, rule * 0.9));
          #elif CAMO == 13
            // Contour Map: drawn contour lines, every fifth heavier, over tinted map paper.
            float h = camoFbm(p * 8.5 + 1.3);
            float ring = abs(fract(h * 16.0) - 0.5);
            float line = 1.0 - smoothstep(0.035, 0.08, ring);
            float major = (1.0 - smoothstep(0.02, 0.06, abs(fract(h * 3.2) - 0.5))) ;
            vec3 base = mix(vec3(0.96, 0.94, 0.86), vec3(0.78, 0.86, 0.7), smoothstep(0.35, 0.7, h));
            return mix(mix(base, vec3(0.45, 0.28, 0.12), line * 0.8), vec3(0.3, 0.16, 0.06), major * 0.9);
          #elif CAMO == 14
            // Love Letter: pink letter paper, faint ruled lines, and hearts inked here and there.
            vec3 paper = vec3(1.0, 0.86, 0.9);
            float ruled = 1.0 - smoothstep(0.0, 0.08, abs(fract(p.y / 0.011) - 0.5) - 0.42);
            vec3 c = mix(paper, vec3(0.62, 0.72, 0.95), ruled * 0.5);
            vec2 cell = floor(p / 0.028);
            vec2 f = fract(p / 0.028) - 0.5;
            float h = camoHash(cell);
            float a = (h - 0.5) * 1.2;
            f = mat2(cos(a), -sin(a), sin(a), cos(a)) * f;
            float d = camoHeart(f * (3.4 - h * 1.2) + vec2(0.0, 0.5));
            float show = step(0.3, h);
            c = mix(c, vec3(0.08, 0.0, 0.03), (1.0 - smoothstep(0.0, 0.06, abs(d))) * show);
            c = mix(c, h > 0.7 ? vec3(0.86, 0.1, 0.32) : vec3(1.0, 0.45, 0.62), step(d, 0.0) * show);
            return c;
          #elif CAMO == 15
            // Circuit Ink: copper-green traces on a dark board, pads at their ends, pulses racing along them.
            vec2 q = p / 0.013;
            vec2 i = floor(q), f = fract(q);
            float h = camoHash(i);
            float across = step(0.5, h);
            float trace = across > 0.5 ? 1.0 - smoothstep(0.07, 0.11, abs(f.y - 0.5)) : 1.0 - smoothstep(0.07, 0.11, abs(f.x - 0.5));
            trace *= step(0.25, camoHash(i + 9.2));
            float pad = (1.0 - smoothstep(0.18, 0.24, length(f - 0.5))) * step(0.78, camoHash(i + 3.1));
            float along = across > 0.5 ? f.x : f.y;
            float pulse = pow(max(0.0, sin((along + camoHash(i + 1.7) * 7.0 - camoTime * 1.6) * 3.14159)), 24.0);
            vec3 board = vec3(0.012, 0.05, 0.035) + vec3(0.02) * camoNoise(p * 60.0);
            vec3 c = mix(board, vec3(0.09, 0.5, 0.34), max(trace, pad));
            return c + vec3(0.55, 1.0, 0.8) * pulse * max(trace, pad * 0.6) * 1.3;
          #elif CAMO == 16
            // Molten Ink: a black crust split by cracks of glowing gold that flow slowly along the gun.
            float t = camoTime * 0.22;
            vec2 w = p * 15.0;
            float n = camoFbm(w + vec2(t, -t * 0.4));
            float crack = abs(camoFbm(w * 1.35 + vec2(-t * 0.5, t * 0.8) + 3.3) - 0.5);
            float lava = 1.0 - smoothstep(0.015, 0.075, crack);
            vec3 crust = vec3(0.025, 0.018, 0.016) + vec3(0.05, 0.035, 0.03) * camoNoise(p * 70.0);
            vec3 hot = mix(vec3(0.85, 0.22, 0.02), camoGold * 1.35, smoothstep(0.35, 0.75, n));
            return mix(crust, hot, lava) + hot * 0.12 * pow(n, 3.0);
          #elif CAMO == 10
            // Ink Nebula: violet ink swirled through with pink, drifting slowly, pricked with twinkling stars.
            float t = camoTime * 0.12;
            vec2 w = p * 18.0;
            vec2 warp = vec2(camoFbm(w + vec2(t, -t * 0.7)), camoFbm(w * 1.3 - vec2(t * 0.8, t) + 4.7));
            float swirl = camoFbm(w * 0.9 + warp * 2.6 + vec2(-t * 0.5, t * 0.3));
            float wisp = camoFbm(w * 2.2 - warp * 1.8 + 9.1);
            vec3 c = mix(vec3(0.012, 0.002, 0.03), vec3(0.16, 0.02, 0.42), smoothstep(0.3, 0.62, swirl));
            c = mix(c, vec3(0.75, 0.02, 0.27), smoothstep(0.52, 0.72, wisp) * smoothstep(0.35, 0.6, swirl));
            c += vec3(1.0, 0.55, 0.8) * pow(smoothstep(0.66, 0.8, wisp), 2.0) * 0.35;
            vec2 sq = p / 0.009;
            vec2 si = floor(sq), sf = fract(sq) - 0.5;
            float star = step(0.9, camoHash(si + 2.3));
            float twinkle = 0.35 + 0.65 * pow(max(0.0, sin(camoTime * (1.2 + camoHash(si) * 2.5) + camoHash(si + 7.7) * 6.2831)), 6.0);
            float dotStar = 1.0 - smoothstep(0.04, 0.16, length(sf));
            float rays = (1.0 - smoothstep(0.0, 0.03, min(abs(sf.x), abs(sf.y)))) * (1.0 - smoothstep(0.0, 0.42, length(sf)));
            return c + vec3(1.0, 0.9, 0.97) * star * twinkle * max(dotStar, rays * 0.8);
          #else
            // Diamond: cut facets (the nearest of scattered points), each its own shade of ice, dark
            // girdle lines between them, glints that flash facet by facet and a slow sweep of light.
            vec2 q = p / 0.017;
            vec2 i = floor(q), f = fract(q);
            float d1 = 8.0, d2 = 8.0; vec2 cell = vec2(0.0);
            for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
              vec2 o = vec2(float(x), float(y));
              vec2 r = o + vec2(camoHash(i + o), camoHash(i + o + 17.3)) - f;
              float d = dot(r, r);
              if (d < d1) { d2 = d1; d1 = d; cell = i + o; } else if (d < d2) d2 = d;
            }
            float h = camoHash(cell);
            float tone = pow(h, 1.6) * 0.7 + 0.3 * camoHash(cell + 5.1);
            vec3 ice = mix(vec3(0.22, 0.36, 0.66), vec3(1.0), tone);
            float edge = smoothstep(0.02, 0.09, sqrt(d2) - sqrt(d1));
            ice = mix(vec3(0.07, 0.1, 0.2), ice, edge);
            float phase = camoTime * (0.8 + h * 1.8) + h * 6.2831;
            float glint = pow(max(0.0, sin(phase)), 14.0) * step(0.42, camoHash(cell + 3.1));
            float sweep = pow(max(0.0, sin((p.x + p.y) * 18.0 - camoTime * 1.4)), 30.0);
            // Fire: each glint catches a little of the spectrum, washed toward white.
            vec3 fire = mix(vec3(1.0), 0.5 + 0.5 * cos(6.2831 * (h + vec3(0.0, 0.33, 0.67))), 0.35);
            return ice + fire * (glint * 1.5 + sweep * 0.6 * edge);
          #endif
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 camoWeights = pow(abs(normalize(vCamoNormal)), vec3(4.0));
        camoWeights /= max(dot(camoWeights, vec3(1.0)), 0.0001);
        // Pattern colours are linear, like every colour the renderer outputs through sRGB.
        diffuseColor.rgb = camoPattern(vCamoPosition.zy) * camoWeights.x
          + camoPattern(vCamoPosition.zx + 0.37) * camoWeights.y
          + camoPattern(vCamoPosition.xy + 0.71) * camoWeights.z;`)
  }
  material.customProgramCacheKey = () => `dead-ink-camo:${id}`
  if (ANIMATED_CAMOS.includes(id)) material.onBeforeRender = () => { camoTime.value = reducedMotion() ? 1.2 : performance.now() / 1000 % 1000 }
  camoMaterials.set(id, material)
  return material
}

/**
 * The Mythic cosmetics' motion, once a frame: the skeleton watch's gears turn, the Ink Heart's glow and
 * the Heartline's edge pulse. `seconds` is a clock; pass a constant under reduced motion to hold them still.
 */
export function animateCosmetics(seconds: number, models: readonly (THREE.Object3D | null | undefined)[]) {
  const pulse = 0.5 + 0.5 * Math.sin(seconds * 2.2)
  GLOW.color.copy(MYTHIC_PINK).lerp(MYTHIC_PALE, pulse * 0.6)
  HALO.opacity = 0.18 + 0.3 * pulse
  for (const model of models) {
    const parts = model?.userData.parts as Record<string, THREE.Object3D> | undefined
    if (!parts) continue
    // Meshing gears turn against each other, the smaller ones faster.
    if (parts.gearA) { parts.gearA.rotation.z = seconds * 0.9; parts.gearB.rotation.z = -seconds * 0.9 * 12 / 9; parts.gearC.rotation.z = -seconds * 0.9 * 12 / 7 }
    if (parts.halo) parts.halo.scale.setScalar(0.9 + 0.25 * pulse)
  }
}

/** Paint a gun's paper faces with a camo. Returns false when the gun has no plain paper to paint. */
export function applyCamo(model: THREE.Object3D, id: CamoId) {
  const camo = camoMaterial(id)
  let painted = false
  model.traverse(object => {
    if (object instanceof THREE.Mesh && object.material === metal) { object.material = camo; painted = true }
  })
  return painted
}

/** Back to plain paper, for a gun whose camo was taken off. */
export function removeCamo(model: THREE.Object3D) {
  const camos = new Set<THREE.Material>(camoMaterials.values())
  model.traverse(object => { if (object instanceof THREE.Mesh && camos.has(object.material)) object.material = metal })
}

// ---------------------------------------------------------------- gloves

/**
 * Gloves: a material for the first-person mittens (both hands) and the cuffs round each wrist. The hands are
 * unit spheres scaled into mittens, so the patterns are drawn from the sphere's own position (-1 to 1): the
 * palm faces -Y, the fingers +Z. Colour only where rarity earns it.
 */
const GLOVE_CODE: Record<GloveId, number> = { work: 0, tactical: 1, rubber: 2, wraps: 3, origami: 4, boxing: 5, bones: 6, brute: 7, midas: 8, heartstring: 9 }
const gloveMaterials = new Map<string, THREE.MeshBasicMaterial>()
const gloveTime = { value: 0 }

/**
 * `part` 'hand': the jointed first-person hand (hands.ts), which carries its own glove coordinates (across the
 * hand, out of its back, along it); 'cuff': anything else, patterned from its own shape.
 */
export function gloveMaterial(id: GloveId, part: 'hand' | 'cuff' = 'cuff') {
  const cached = gloveMaterials.get(`${id}:${part}`)
  if (cached) return cached
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
  // Dark gloves are stitched in pale thread, the rest in dark.
  material.defines = { GLOVE: GLOVE_CODE[id], ...(id === 'tactical' || id === 'bones' || id === 'brute' || id === 'midas' ? { GLOVE_PALE_THREAD: 1 } : {}), ...(part === 'hand' ? { GLOVE_COORD: 1 } : {}) }
  material.onBeforeCompile = shader => {
    shader.uniforms.gloveTime = gloveTime
    shader.uniforms.gloveGold = { value: new THREE.Color(RARITY_INFO.legendary.color) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGlove;
        #ifdef GLOVE_COORD
          attribute vec3 gloveCoord;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef GLOVE_COORD
          vGlove = gloveCoord;
        #else
          vGlove = position;
        #endif`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGlove;
        uniform float gloveTime;
        uniform vec3 gloveGold;
        float gloveHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gloveNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gloveHash(i), gloveHash(i + vec2(1.0, 0.0)), f.x), mix(gloveHash(i + vec2(0.0, 1.0)), gloveHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float gloveDot2(vec2 v) { return dot(v, v); }
        float gloveHeart(vec2 p) {
          p.x = abs(p.x);
          if (p.y + p.x > 1.0) return sqrt(gloveDot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
          return sqrt(min(gloveDot2(p - vec2(0.0, 1.0)), gloveDot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
        }
        vec3 glovePattern(vec3 g) {
          vec2 s = g.xz;
          #if GLOVE == 0
            // Work gloves: worn canvas, hatched, with a darker palm.
            float hatch = step(0.7, fract((g.x + g.z) * 9.0 + gloveNoise(s * 6.0) * 0.6));
            vec3 c = vec3(0.86, 0.83, 0.76) - hatch * 0.18;
            return mix(c, vec3(0.62, 0.56, 0.46), smoothstep(0.1, -0.3, g.y));
          #elif GLOVE == 1
            // Night Ops: black, with grey padded knuckles across the back.
            float knuckle = (1.0 - smoothstep(0.18, 0.24, abs(fract(g.x * 2.2 + 0.5) - 0.5))) * smoothstep(0.35, 0.55, g.y) * smoothstep(-0.2, 0.3, g.z);
            return mix(vec3(0.07), vec3(0.34), knuckle);
          #elif GLOVE == 2
            // Scrubbers: glossy green rubber, a pale shine band across the back.
            float shine = 1.0 - smoothstep(0.0, 0.12, abs(g.y - 0.55 - g.x * 0.2));
            return mix(vec3(0.24, 0.62, 0.28), vec3(0.8, 1.0, 0.8), shine * 0.6);
          #elif GLOVE == 3
            // Knuckle wraps: strips of white tape wound at a slant, their edges inked.
            float band = fract(g.z * 3.2 + g.x * 1.1 + g.y * 0.4);
            float edge = 1.0 - smoothstep(0.0, 0.06, min(band, 1.0 - band));
            return mix(vec3(0.97, 0.96, 0.92), vec3(0.12), edge * 0.85);
          #elif GLOVE == 4
            // Origami: folded blue paper, each facet its own shade, the folds inked.
            vec2 q = s * 2.6 + g.y * 0.8;
            vec2 i = floor(q), f = fract(q);
            float tri = step(f.x, f.y);
            float h = gloveHash(i + tri * 3.7);
            float fold = 1.0 - smoothstep(0.0, 0.05, min(min(f.x, f.y), abs(f.x - f.y)));
            vec3 blue = mix(vec3(0.33, 0.55, 0.9), vec3(0.72, 0.84, 1.0), h);
            return mix(blue, vec3(0.08, 0.14, 0.3), fold * 0.8);
          #elif GLOVE == 5
            // Blue Corner: blue leather with white laces up the back of the wrist.
            float lace = (1.0 - smoothstep(0.05, 0.1, abs(fract(g.z * 5.0) - 0.5 + g.x * 0.8))) * (1.0 - smoothstep(0.25, 0.3, abs(g.x))) * step(0.4, g.y) * step(g.z, -0.2);
            float shine = 1.0 - smoothstep(0.0, 0.2, abs(g.y - 0.6));
            return mix(mix(vec3(0.12, 0.4, 0.86), vec3(0.55, 0.75, 1.0), shine * 0.5), vec3(1.0), lace);
          #elif GLOVE == 6
            // Bone Hands: black, with the bones of the hand drawn on in white.
            float finger = 1.0 - smoothstep(0.06, 0.1, abs(fract(g.x * 2.4 + 0.5) - 0.5));
            float joint = step(0.35, abs(fract(g.z * 2.2) - 0.5));
            float bones = finger * (1.0 - joint * 0.9) * step(0.0, g.y);
            float knuckle = (1.0 - smoothstep(0.1, 0.16, length(vec2(fract(g.x * 2.4 + 0.5) - 0.5, g.z - 0.05)))) * step(0.0, g.y);
            return mix(vec3(0.05), vec3(0.95), max(bones, knuckle));
          #elif GLOVE == 7
            // Brute Knuckles: bruised violet hide with black studs across the knuckles.
            float stud = 1.0 - smoothstep(0.12, 0.17, length(vec2(fract(g.x * 2.2 + 0.5) - 0.5, (g.z - 0.25) * 2.2)));
            vec3 hide = mix(vec3(0.3, 0.12, 0.45), vec3(0.5, 0.25, 0.65), gloveNoise(s * 5.0));
            return mix(hide, vec3(0.03), stud * step(0.2, g.y));
          #elif GLOVE == 8
            // Midas Touch: solid gold, a sweep of light and fine hatching in the shade.
            float sweep = 1.0 - smoothstep(0.0, 0.25, abs(g.x + g.z * 0.6 - 0.2));
            float hatch = step(0.82, fract((g.x - g.z) * 14.0)) * smoothstep(0.2, -0.4, g.y);
            return gloveGold * (0.85 + sweep * 0.45) - hatch * 0.2;
          #else
            // Heartstring: rose gold, pink stitched hearts that glow and fade on the back of each hand.
            vec3 rose = vec3(0.91, 0.64, 0.62);
            float pulse = 0.55 + 0.45 * sin(gloveTime * 2.2);
            vec2 q = vec2(g.x, g.z) * 1.6;
            vec2 cell = floor(q + 0.5), f = q - cell;
            float d = gloveHeart(f * 2.6 + vec2(0.0, 0.55));
            float back = step(0.15, g.y);
            vec3 c = mix(rose, vec3(0.1, 0.02, 0.06), (1.0 - smoothstep(0.0, 0.08, abs(d))) * back);
            c = mix(c, mix(vec3(0.88, 0.15, 0.56), vec3(1.0, 0.72, 0.86), pulse), step(d, 0.0) * back);
            float stitch = step(0.5, fract(atan(g.z, g.x) * 6.0)) * (1.0 - smoothstep(0.02, 0.05, abs(length(g.xz) - 0.9)));
            return mix(c, vec3(0.88, 0.15, 0.56), stitch * 0.8);
          #endif
        }
        // What every glove has, whatever its pattern: a padded knuckle panel across the back, stitched round
        // its edge, and a seam of running stitches where the back meets the palm.
        vec3 gloveMake(vec3 c, vec3 g) {
          #ifdef GLOVE_PALE_THREAD
            vec3 thread = vec3(0.86);
          #else
            vec3 thread = vec3(0.06);
          #endif
          float seamDash = step(0.45, fract(atan(g.z, g.x) * 7.0));
          float seam = (1.0 - smoothstep(0.025, 0.06, abs(g.y - 0.05))) * seamDash;
          float inPanel = step(abs(g.x), 0.62) * step(0.08, g.z) * step(g.z, 0.62) * step(0.3, g.y);
          float margin = min(min(0.62 - abs(g.x), g.z - 0.08), 0.62 - g.z);
          float border = inPanel * (1.0 - step(0.07, margin)) * step(0.02, margin);
          float panelDash = step(0.5, fract((abs(g.x) + g.z) * 12.0));
          // Raised: lit on its top edge, shaded below.
          c = mix(c, c * 0.8 + vec3(0.04), inPanel * 0.85);
          c = mix(c, thread, max(seam, border * panelDash) * 0.9);
          return c;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = gloveMake(glovePattern(vGlove), vGlove);`)
  }
  material.customProgramCacheKey = () => `dead-ink-glove:${id}:${part}`
  if (id === 'heartstring') material.onBeforeRender = () => { gloveTime.value = reducedMotion() ? 0.7 : performance.now() / 1000 % 1000 }
  gloveMaterials.set(`${id}:${part}`, material)
  return material
}

/**
 * Where each gun's charm hangs, in gun space: on the side that faces the middle of the screen, clear of
 * the firing hand and the support hand.
 */
export const CHARM_ANCHORS: Record<string, V> = {
  // Under the dust cover ahead of the trigger guard: from the butt it hung below the bottom of a 16:9 screen.
  pistol: [0.004, 0.031, 0.12],
  smg: [0.036, 0.03, -0.075],
  ak: [0.03, 0.05, 0.07],
  shotgun: [0.024, 0.055, 0.12],
  sniper: [0.03, 0.035, 0.13],
}
