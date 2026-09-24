import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Draft, createRarityBeam, wallText } from '../../render/ink'
import type { WallSize, WallSpot } from './placement'

/**
 * Buildables, as Black Ops 2 and 3 have them: parts lie about the map (each game in one of a few places),
 * you pick them up, and at the right spot you put them together.
 *
 * - The power switch has lost its lever. Until it is back and pulled, the perk machines are dark and the
 *   Pack-a-Punch will not run (Call of Duty's power switch).
 * - The Pack-a-Punch has to be built from three parts, out in the far zones.
 * - The ink shield: three parts, a workbench near the start. Built, you take it and wear it on your back,
 *   where it takes the hits from behind until it breaks.
 */
export type PartId = 'lever' | 'gear' | 'plate' | 'tank' | 'panel' | 'strap' | 'grip'
export type BuildId = 'power' | 'pack' | 'shield'
type Place = [number, number, number]

export const BUILDS: Record<BuildId, { label: string; parts: readonly PartId[] }> = {
  power: { label: 'power switch', parts: ['lever'] },
  pack: { label: 'Pack-a-Punch', parts: ['gear', 'plate', 'tank'] },
  shield: { label: 'ink shield', parts: ['panel', 'strap', 'grip'] },
}

/** Each part turns up in one of its places, chosen at the start of a game. */
export const PARTS: Record<PartId, { label: string; build: BuildId; places: readonly Place[] }> = {
  // Always in the starting area, so the power is the first thing you can do: up the observation tower,
  // inside the mess hall, or out in the mess yard.
  lever: { label: 'power lever', build: 'power', places: [[-50.4, 6.8, 16.5], [-38, 0.3, -46], [-22, 0, -22]] },
  gear: { label: 'press gear', build: 'pack', places: [[60, 0, -21], [54, 0, -30], [68, 0, -14]] },
  plate: { label: 'printing plate', build: 'pack', places: [[-57, 0.7, 64], [10.95, 12.6, -31.2], [20, 0, 20]] },
  tank: { label: 'ink tank', build: 'pack', places: [[120, 0, 0], [132, 0, -10], [112, 0, 10]] },
  panel: { label: 'shield panel', build: 'shield', places: [[-38, 0, -44], [-18, 0, -18], [-46, 0, -28]] },
  strap: { label: 'shield strap', build: 'shield', places: [[-40, 0, 40], [-57, 0.7, 64], [-30, 0, 30]] },
  grip: { label: 'shield grip', build: 'shield', places: [[20, 0, 20], [30, 0, 44], [25.5, 0.7, -6]] },
}

/** The power switch in the building by the start (the first rooms), and the shield workbench nearby. */
export const POWER_PLACE: Place = [-30, 0.3, -50]
export const BENCH_PLACE: Place = [-45, 0, -40]

/** The shield on your back: what it soaks up, and how far round from straight behind it covers. */
export const SHIELD = { health: 1500, arc: THREE.MathUtils.degToRad(115) } as const

const ink = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
const paper = new THREE.MeshBasicMaterial({ color: 0xfbfaf5, toneMapped: false })
const metal = new THREE.MeshBasicMaterial({ color: 0xc9c6bd, toneMapped: false })
const rim = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false })

/** A mesh with an ink outline shell, the way the small props are drawn. */
function outlined(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, position: Place, rotation: Place = [0, 0, 0], grow = 1.14) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(...position); mesh.rotation.set(...rotation)
  const shell = new THREE.Mesh(geometry, rim)
  shell.position.copy(mesh.position); shell.rotation.copy(mesh.rotation); shell.scale.setScalar(grow)
  group.add(mesh, shell)
  return mesh
}

/** Steel and ink, for pieces merged into one fill. */
const STEEL = 0xc9c6bd, INK = 0x111111
const tinted = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })
type Piece = { shape: THREE.BufferGeometry; at: Place; turn?: Place; color: number; grow?: number }

/**
 * Pieces drawn the way the small props are (a fill, and an ink shell round each one), merged into one
 * fill coloured per piece and one shell: two draw calls however many pieces. `grow` 0 leaves out the shell.
 */
function merged(group: THREE.Group, pieces: Piece[]) {
  const fills: THREE.BufferGeometry[] = [], shells: THREE.BufferGeometry[] = []
  const placing = new THREE.Matrix4(), colour = new THREE.Color()
  for (const { shape, at, turn = [0, 0, 0], color, grow = 1.14 } of pieces) {
    shape.deleteAttribute('uv')
    colour.setHex(color)
    const tints = new Float32Array(shape.getAttribute('position').count * 3)
    for (let i = 0; i < tints.length; i += 3) { tints[i] = colour.r; tints[i + 1] = colour.g; tints[i + 2] = colour.b }
    shape.setAttribute('color', new THREE.BufferAttribute(tints, 3))
    placing.compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn)), new THREE.Vector3(1, 1, 1))
    if (grow) shells.push(shape.clone().scale(grow, grow, grow).applyMatrix4(placing))
    fills.push(shape.applyMatrix4(placing))
  }
  group.add(new THREE.Mesh(mergeGeometries(fills), tinted), new THREE.Mesh(mergeGeometries(shells), rim))
  for (const g of [...fills, ...shells]) g.dispose()
}

/**
 * The power lever, from its foot up: the square spigot that seats it in the switch, a square steel bar,
 * and a black T grip with steel ends. The same drawing lies on the floor and sits in the switch.
 */
function leverPieces(): Piece[] {
  return [
    { shape: new THREE.BoxGeometry(0.028, 0.05, 0.028), at: [0, 0.025, 0], color: STEEL },
    { shape: new THREE.BoxGeometry(0.034, 0.3, 0.034), at: [0, 0.195, 0], color: STEEL },
    { shape: new THREE.CylinderGeometry(0.024, 0.024, 0.17, 16), at: [0, 0.36, 0], turn: [0, 0, Math.PI / 2], color: INK },
    ...[-1, 1].map((side): Piece => ({ shape: new THREE.CylinderGeometry(0.029, 0.029, 0.02, 16), at: [side * 0.092, 0.36, 0], turn: [0, 0, Math.PI / 2], color: STEEL })),
  ]
}

/** The part itself, about the size of the thing it is. */
export function partModel(id: PartId) {
  const g = new THREE.Group()
  g.name = `Part: ${id}`
  switch (id) {
    case 'lever':
      merged(g, leverPieces())
      break
    case 'gear': {
      outlined(g, new THREE.CylinderGeometry(0.22, 0.22, 0.06, 24), metal, [0, 0.03, 0])
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6
        outlined(g, new THREE.BoxGeometry(0.07, 0.06, 0.07), metal, [Math.cos(a) * 0.25, 0.03, Math.sin(a) * 0.25], [0, -a, 0], 1.2)
      }
      outlined(g, new THREE.CylinderGeometry(0.05, 0.05, 0.08, 12), ink, [0, 0.03, 0])
      break
    }
    case 'plate':
      outlined(g, new THREE.BoxGeometry(0.5, 0.03, 0.34), metal, [0, 0.015, 0])
      for (let i = 0; i < 4; i++) outlined(g, new THREE.BoxGeometry(0.36, 0.012, 0.03), ink, [0, 0.036, -0.1 + i * 0.066], [0, 0, 0], 1)
      break
    case 'tank':
      outlined(g, new THREE.CylinderGeometry(0.14, 0.14, 0.42, 18), paper, [0, 0.21, 0])
      outlined(g, new THREE.CylinderGeometry(0.1, 0.1, 0.3, 18), ink, [0, 0.21, 0.05], [0, 0, 0], 1)
      outlined(g, new THREE.CylinderGeometry(0.04, 0.04, 0.08, 10), metal, [0, 0.46, 0])
      break
    case 'panel':
      outlined(g, new THREE.BoxGeometry(0.6, 0.05, 0.9), paper, [0, 0.025, 0])
      for (const z of [-0.3, 0, 0.3]) outlined(g, new THREE.BoxGeometry(0.62, 0.06, 0.06), ink, [0, 0.04, z], [0, 0, 0], 1)
      break
    case 'strap':
      outlined(g, new THREE.TorusGeometry(0.16, 0.025, 6, 20), ink, [0, 0.03, 0], [Math.PI / 2, 0, 0], 1.25)
      outlined(g, new THREE.BoxGeometry(0.08, 0.03, 0.06), metal, [0.16, 0.03, 0])
      break
    case 'grip':
      outlined(g, new THREE.BoxGeometry(0.26, 0.05, 0.05), ink, [0, 0.025, 0])
      for (const x of [-0.13, 0.13]) outlined(g, new THREE.BoxGeometry(0.04, 0.05, 0.12), metal, [x, 0.025, 0.05])
      break
  }
  return g
}

/** A part lying on the floor: it turns slowly and a chalk ring round it pulses, so it can be found. */
export class PartPickup {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  private model: THREE.Group
  private ring: THREE.Mesh
  private time = Math.random() * 10

  constructor(readonly id: PartId, at: THREE.Vector3) {
    this.root.name = `Buildable part · ${PARTS[id].label}`
    this.root.userData.noCollision = true
    this.root.position.copy(at)
    this.model = partModel(id)
    this.model.position.y = 0.12
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.47, 40), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, toneMapped: false, depthWrite: false }))
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.02
    // A faint grey glint over it, head height: there if you look, not a beacon (gold is the box's).
    const beam = createRarityBeam(0x8f9aa6, 1.8)
    this.root.add(this.model, this.ring, beam)
    this.point = at.clone().setY(at.y + 0.3)
  }

  update(dt: number) {
    this.time += dt
    this.model.rotation.y += dt * 0.9
    this.model.position.y = 0.12 + Math.sin(this.time * 2.4) * 0.03
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 3)
    this.ring.scale.setScalar(1 + pulse * 0.25)
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = 0.75 - pulse * 0.5
  }

  dispose() {
    this.root.removeFromParent()
    this.root.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    ;(this.ring.material as THREE.Material).dispose()
  }
}

/**
 * Where a build goes together: a chalk outline of each missing part, drawn in dashes; placed parts appear
 * solid in their spot. `anchor` is the group the finished thing stands in (or null for the shield bench).
 */
export class BuildSite {
  /** The block the shield's workbench fills against its wall, for placement, parts on it and all. */
  static readonly BENCH: WallSize = { halfWidth: 0.8, top: 1.35, depth: 0.85 }
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  readonly placed = new Set<PartId>()
  private slots = new Map<PartId, { ghost: THREE.Object3D; solid: THREE.Object3D }>()
  /** A machine's chalk outline and its name on the wall: gone once the machine stands there. */
  private marks: THREE.Object3D[] = []
  private pop = 0

  constructor(readonly build: BuildId, readonly spot: WallSpot, bench: boolean) {
    this.root.name = `Build site · ${BUILDS[build].label}`
    this.root.userData.noCollision = true
    this.root.position.copy(spot.wall.clone().addScaledVector(spot.normal, 0.5).setY(spot.stand.y))
    this.root.rotation.y = Math.atan2(spot.normal.x, spot.normal.z)
    if (bench) {
      // A trestle workbench against the wall.
      const table = new Draft(`Workbench · ${BUILDS[build].label}`)
      table.box(1.6, 0.06, 0.7, 0, 0.9, 0, 'paper', 'edge')
      for (const x of [-0.7, 0.7]) for (const z of [-0.28, 0.28]) table.box(0.06, 0.9, 0.06, x, 0.45, z, 'paper', 'edge')
      table.box(1.4, 0.04, 0.5, 0, 0.3, 0, 'paper', 'detail')
      table.finish()
      this.root.add(table)
    } else {
      // A chalk square on the floor where the machine will stand.
      const chalk = new Draft(`Build outline · ${BUILDS[build].label}`)
      chalk.line([[-1, 0.02, -0.6], [1, 0.02, -0.6], [1, 0.02, 0.6], [-1, 0.02, 0.6]], 'detail', true)
      chalk.finish()
      const label = wallText(BUILDS[build].label.toUpperCase(), [0, 1.5, -0.47], 0.22)
      this.marks.push(chalk, label)
      this.root.add(chalk, label)
    }
    const parts = BUILDS[build].parts
    parts.forEach((id, i) => {
      const x = (i - (parts.length - 1) / 2) * 0.45
      const y = bench ? 0.94 : 0.05
      const solid = partModel(id)
      solid.position.set(x, y, 0)
      solid.scale.setScalar(0.8)
      solid.visible = false
      const ghost = partModel(id)
      ghost.position.copy(solid.position); ghost.scale.copy(solid.scale)
      ghost.traverse(o => { if (o instanceof THREE.Mesh) o.material = o.material === rim ? ghostRim : ghostFill })
      this.root.add(solid, ghost)
      this.slots.set(id, { ghost, solid })
    })
    this.point = this.root.position.clone().setY(spot.stand.y + (bench ? 1 : 0.6))
  }

  get complete() { return BUILDS[this.build].parts.every(id => this.placed.has(id)) }
  missing() { return BUILDS[this.build].parts.filter(id => !this.placed.has(id)) }

  place(id: PartId) {
    const slot = this.slots.get(id)
    if (!slot || this.placed.has(id)) return false
    this.placed.add(id)
    slot.ghost.visible = false
    slot.solid.visible = true
    this.pop = 0.35
    return true
  }

  /** Hide the parts once the finished thing takes their place (the power switch, the machine). */
  hideParts() {
    for (const { ghost, solid } of this.slots.values()) { ghost.visible = false; solid.visible = false }
    for (const mark of this.marks) mark.visible = false
  }

  reset() {
    this.placed.clear()
    for (const { ghost, solid } of this.slots.values()) { ghost.visible = true; solid.visible = false; solid.scale.setScalar(0.8) }
    for (const mark of this.marks) mark.visible = true
  }

  update(dt: number) {
    if (this.pop <= 0) return
    this.pop = Math.max(0, this.pop - dt)
    const k = 0.8 * (1 + Math.sin((1 - this.pop / 0.35) * Math.PI) * 0.35)
    for (const id of this.placed) this.slots.get(id)!.solid.scale.setScalar(k)
  }

  dispose() {
    this.root.removeFromParent()
    for (const { ghost, solid } of this.slots.values()) for (const g of [ghost, solid]) g.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
  }
}
const ghostFill = new THREE.MeshBasicMaterial({ color: 0xfbfaf5, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false })
const ghostRim = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false })

/**
 * The power switch, as Call of Duty's (Kino der Toten, Der Riese): a heavy breaker cabinet bolted to the
 * wall on two rails, a stencilled POWER plate, conduit up the wall and off along it to a junction box, a
 * caged lamp on top, and a big throw lever on a hinge bracket on the cabinet's door. Pulled down, its
 * blade drops into the contacts below, sparks fly and the lamp stutters on green; the power comes on
 * across the compound. Until the lever is found the bracket stands empty, its socket showing.
 *
 * Drawn in the unit's own frame: x along the wall to the right, y up from the floor, z out of the wall.
 * The cabinet sits right of the middle so that the whole unit, junction box and all, is centred on the spot.
 */
const SHIFT = 0.215
/** The lever's pin, and the contacts its blade closes into, below it. */
const PIVOT: Place = [0, 1.3, 0.36], CONTACTS: Place = [0, 1.1, 0.4]
/** Lever angles, forward from straight up: sitting in the bracket, the empty socket drooping, pulled home. */
const REST = THREE.MathUtils.degToRad(12), LOOSE = THREE.MathUtils.degToRad(28), HOME = Math.PI
/**
 * The pull: seconds to throw it (slow to start, then it slams home), to bounce back and settle, and the
 * lamp catching after the slam (it goes out at each odd switch, on at each even one).
 */
const PULL = { travel: 0.62, bounce: 0.32, flicker: [0.06, 0.14, 0.2, 0.34, 0.38, 0.47] } as const
const LAMP_OFF = 0x3a3a3a, LAMP_ON = 0x4fb34a
const SPARKS = 14
const sparkInk = new THREE.MeshBasicMaterial({ color: INK, toneMapped: false })
const sparkMatrix = new THREE.Matrix4(), sparkTurn = new THREE.Quaternion(), sparkAt = new THREE.Vector3(), sparkWay = new THREE.Vector3(), sparkSize = new THREE.Vector3()
const FORWARD = new THREE.Vector3(0, 0, 1)

/** Where the lever's foot sits in the collar, up from the pin. */
const SEAT = 0.045

/**
 * What turns on the lever's pin: the hub and the square collar the lever seats in, and either the empty
 * socket, dark, or the lever itself (the same pieces as the part you carry, so it is the same lever).
 */
function pivotPieces(lever: boolean): Piece[] {
  return [
    { shape: new THREE.CylinderGeometry(0.032, 0.032, 0.078, 20), at: [0, 0, 0], turn: [0, 0, Math.PI / 2], color: STEEL },
    { shape: new THREE.BoxGeometry(0.058, 0.07, 0.058), at: [0, 0.055, 0], color: STEEL },
    ...lever ? leverPieces().map((piece): Piece => ({ ...piece, at: [piece.at[0], piece.at[1] + SEAT, piece.at[2]] }))
      : [{ shape: new THREE.BoxGeometry(0.038, 0.004, 0.038), at: [0, 0.0905, 0] as Place, color: INK, grow: 0 }],
  ]
}

/** Everything that never moves, in one drawing. */
function switchCabinet() {
  const d = new Draft('Power switch cabinet')
  // Two rails bolted to the wall carry the cabinet.
  for (const y of [1.1, 1.86]) {
    d.box(0.84, 0.05, 0.03, 0, y, 0.015, 'paper', 'detail')
    for (const x of [-0.395, 0.395]) d.box(0.022, 0.022, 0.014, x, y, 0.037, 'paper', 'detail')
  }
  // The cabinet, its door hinged on the left with a latch on the right, rivets round the frame.
  d.box(0.66, 0.92, 0.24, 0, 1.48, 0.15, 'paper', 'edge')
  d.box(0.56, 0.82, 0.02, 0, 1.48, 0.28, 'paper', 'edge')
  for (const y of [1.2, 1.76]) d.solid(new THREE.CylinderGeometry(0.013, 0.013, 0.09, 20), [-0.292, y, 0.285], 'paper', 'detail', [0, 0, 0], true)
  d.box(0.034, 0.12, 0.006, 0.245, 1.48, 0.293, 'paper', 'detail')
  d.box(0.02, 0.09, 0.022, 0.245, 1.48, 0.307, 'paper', 'detail')
  const rivet = (x: number, y: number) => d.box(0.016, 0.016, 0.008, x, y, 0.274, 'paper', 'detail')
  for (const x of [-0.3, -0.15, 0, 0.15, 0.3]) for (const y of [1.045, 1.915]) rivet(x, y)
  for (const y of [1.2, 1.34, 1.48, 1.62, 1.76]) rivet(0.305, y)
  for (const y of [1.34, 1.48, 1.62]) rivet(-0.305, y)
  // The POWER plate, riveted to the door (the stencil is its own mesh).
  d.box(0.34, 0.09, 0.006, 0, 1.81, 0.293, 'paper', 'edge')
  for (const x of [-0.155, 0.155]) d.box(0.012, 0.012, 0.006, x, 1.81, 0.299, 'paper', 'detail')
  // The door's pressed panel, and a warning triangle with a bolt in it, low on the door.
  const w = 0.2905
  d.line([[-0.245, 1.1, w], [0.245, 1.1, w], [0.245, 1.86, w], [-0.245, 1.86, w]], 'detail', true)
  d.line([[-0.21, 1.135, w], [-0.09, 1.135, w], [-0.15, 1.24, w]], 'detail', true)
  d.line([[-0.143, 1.22, w], [-0.161, 1.182, w], [-0.141, 1.186, w], [-0.157, 1.148, w]], 'detail')
  // The lever's hinge bracket: a plate bolted to the door, two cheeks, the pin through them and its nuts.
  const [, py, pz] = PIVOT
  d.box(0.16, 0.18, 0.01, 0, py, 0.295, 'paper', 'edge')
  for (const x of [-0.066, 0.066]) for (const y of [py - 0.068, py + 0.068]) d.box(0.018, 0.018, 0.01, x, y, 0.305, 'paper', 'detail')
  for (const x of [-0.049, 0.049]) d.box(0.016, 0.12, 0.105, x, py, 0.3525, 'paper', 'edge')
  d.solid(new THREE.CylinderGeometry(0.011, 0.011, 0.14, 16), [0, py, pz], 'paper', 'detail', [0, 0, Math.PI / 2], true)
  for (const x of [-0.063, 0.063]) d.solid(new THREE.CylinderGeometry(0.019, 0.019, 0.012, 6), [x, py, pz], 'paper', 'detail', [0, 0, Math.PI / 2])
  // The contacts below it: a block and two jaws the lever's blade drops between.
  const cy = CONTACTS[1]
  d.box(0.09, 0.05, 0.016, 0, cy, 0.298, 'paper', 'edge')
  for (const x of [-0.0245, 0.0245]) d.box(0.009, 0.075, 0.1, x, cy, 0.356, 'paper', 'detail')
  // The lamp's base, cage and cap on top (the bulb is its own mesh).
  d.cylinder(0.04, 0.03, 0.2, 1.955, 0.15)
  d.ring(0.043, 2.005, 0.2, 0.15, 'detail', 24)
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2, c = Math.cos(a), s = Math.sin(a)
    d.line([[0.2 + 0.03 * c, 1.97, 0.15 + 0.03 * s], [0.2 + 0.043 * c, 2.005, 0.15 + 0.043 * s], [0.2 + 0.012 * c, 2.05, 0.15 + 0.012 * s]], 'detail')
  }
  d.cylinder(0.014, 0.012, 0.2, 2.052, 0.15)
  // Two conduits out of the top, up the wall, bending left together (one bend inside the other), along
  // the wall and into a junction box.
  const zc = 0.065, bendY = 2.18, centreX = -0.3, end = -0.595
  for (const [x, r] of [[-0.2, 0.03], [-0.085, 0.019]]) {
    const bend = x - centreX, y = bendY + bend
    d.solid(new THREE.CylinderGeometry(r + 0.008, r + 0.008, 0.03, 24), [x, 1.955, zc], 'paper', 'detail', [0, 0, 0], true)
    d.solid(new THREE.CylinderGeometry(r, r, bendY - 1.97, 24), [x, (bendY + 1.97) / 2, zc], 'paper', 'detail', [0, 0, 0], true)
    d.solid(new THREE.TorusGeometry(bend, r, 20, 16, Math.PI / 2), [centreX, bendY, zc], 'paper', 'detail', [0, 0, 0], true)
    d.solid(new THREE.CylinderGeometry(r, r, centreX - end, 24), [(centreX + end) / 2, y, zc], 'paper', 'detail', [0, 0, Math.PI / 2], true)
    d.solid(new THREE.CylinderGeometry(r + 0.008, r + 0.008, 0.025, 24), [end - 0.0125, y, zc], 'paper', 'detail', [0, 0, Math.PI / 2], true)
  }
  // Straps hold them to the wall: across the rise, and across the run.
  d.box(0.19, 0.026, 0.01, -0.1425, 2.07, 0.1, 'paper', 'detail')
  for (const x of [-0.2435, -0.137, -0.0415]) d.box(0.012, 0.026, 0.095, x, 2.07, 0.0475, 'paper', 'detail')
  d.box(0.026, 0.21, 0.01, -0.46, 2.335, 0.1, 'paper', 'detail')
  for (const y of [2.224, 2.343, 2.446]) d.box(0.026, 0.012, 0.095, -0.46, y, 0.0475, 'paper', 'detail')
  // The junction box, its lid screwed on.
  d.box(0.22, 0.32, 0.1, -0.73, 2.34, 0.05, 'paper', 'edge')
  d.box(0.19, 0.29, 0.01, -0.73, 2.34, 0.105, 'paper', 'detail')
  for (const x of [-0.81, -0.65]) for (const y of [2.215, 2.465]) d.box(0.012, 0.012, 0.006, x, y, 0.113, 'paper', 'detail')
  // Shade: the cabinet's and the junction box's right sides, and a shadow on the wall under the cabinet.
  d.hatch([0.3325, 1.04, 0.035], [0, 0, 0.23], [0, 0.88, 0], { spacing: 0.035, inset: 0.01 })
  d.hatch([-0.6175, 2.19, 0.005], [0, 0, 0.09], [0, 0.3, 0], { spacing: 0.035, inset: 0.008 })
  d.hatch([-0.25, 0.93, 0.003], [0.68, 0, 0], [0, 0.085, 0], { spacing: 0.04, inset: 0.006 })
  return d.finish()
}

/** A word stencilled in ink: heavy capitals, each cut by the stencil's bridges. */
function stencil(word: string, width: number, height: number) {
  if (typeof document === 'undefined') return new THREE.Group()
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 128
  const c = canvas.getContext('2d')!
  let size = 112
  const font = () => `${size}px Impact, "Arial Black", "Franklin Gothic Heavy", sans-serif`
  c.font = font()
  while (c.measureText(word).width > 480 && size > 40) { size -= 4; c.font = font() }
  c.fillStyle = '#111111'
  c.textBaseline = 'middle'
  let x = (512 - c.measureText(word).width) / 2
  for (const letter of word) {
    const w = c.measureText(letter).width
    c.fillText(letter, x, 66)
    // The bridges that hold a stencil together: through the middle of round letters, beside the stem of the rest.
    c.clearRect(x + w * ('OQCGDUVWMAXYZ'.includes(letter) ? 0.5 : 0.45) - size * 0.028, 0, size * 0.056, 128)
    x += w
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }))
  mesh.name = `Stencil · ${word}`
  return mesh
}

export class PowerSwitch {
  /** The block the unit fills on its wall, for placement: cabinet, conduit and junction box, and the lever's reach. */
  static readonly SIZE: WallSize = { halfWidth: 0.64, top: 2.55, depth: 0.5, bottom: 0.85 }
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  state: 'broken' | 'ready' | 'on' = 'broken'
  /** Turns on the lever's pin: the empty socket while the lever is lost, the lever once it is back. */
  private pivot = new THREE.Group()
  private empty = new THREE.Group()
  private lever = new THREE.Group()
  private lamp: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  private plate: THREE.Object3D
  private sparks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.008, 0.008, 1), sparkInk, SPARKS)
  /** Per spark: position, velocity, age, life. */
  private spark = new Float32Array(SPARKS * 8)
  private alive = 0
  /** Seconds into the pull, or -1 when still. */
  private pull = -1

  constructor(readonly spot: WallSpot) {
    this.root.name = 'Power switch'
    this.root.userData.noCollision = true
    this.root.position.copy(spot.wall.clone().addScaledVector(spot.normal, 0.01).setY(spot.stand.y))
    this.root.rotation.y = Math.atan2(spot.normal.x, spot.normal.z)
    const unit = new THREE.Group()
    unit.position.x = SHIFT
    this.root.add(unit)
    unit.add(switchCabinet())
    this.plate = stencil('POWER', 0.28, 0.07)
    this.plate.position.set(0, 1.81, 0.2975)
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.033, 16, 12), new THREE.MeshBasicMaterial({ color: LAMP_OFF, toneMapped: false }))
    this.lamp.position.set(0.2, 2.005, 0.15)
    this.pivot.position.set(...PIVOT)
    this.pivot.rotation.x = LOOSE
    merged(this.empty, pivotPieces(false))
    merged(this.lever, pivotPieces(true))
    this.lever.visible = false
    this.pivot.add(this.empty, this.lever)
    this.sparks.name = 'Power switch sparks'
    this.sparks.frustumCulled = false
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.sparks.count = 0
    this.sparks.visible = false
    unit.add(this.plate, this.lamp, this.pivot, this.sparks)
    // In front of the lever, between its pin and its grip.
    const along = new THREE.Vector3(spot.normal.z, 0, -spot.normal.x)
    this.point = this.root.position.clone().addScaledVector(along, SHIFT).addScaledVector(spot.normal, 0.45).setY(spot.stand.y + 1.45)
  }

  /** The lever goes back on. */
  repair() { if (this.state === 'broken') { this.state = 'ready'; this.lever.visible = true; this.empty.visible = false; this.pivot.rotation.x = REST } }

  /** Pull it down; returns true on the pull that turns the power on. */
  turnOn() {
    if (this.state !== 'ready') return false
    this.state = 'on'
    this.pull = 0
    return true
  }

  reset() {
    this.state = 'broken'; this.pull = -1
    this.lever.visible = false; this.empty.visible = true; this.pivot.rotation.x = LOOSE
    this.lamp.material.color.setHex(LAMP_OFF)
    this.alive = 0; this.sparks.count = 0; this.sparks.visible = false
  }

  update(dt: number) {
    if (this.pull < 0) return
    const before = this.pull
    this.pull += dt
    const { travel, bounce, flicker } = PULL, since = this.pull - travel
    if (since < 0) this.pivot.rotation.x = REST + (HOME - REST) * (this.pull / travel) ** 3
    else {
      if (before < travel) this.burst()
      // It slams home and bounces back up a little, twice, smaller each time.
      const u = Math.min(1, since / bounce)
      this.pivot.rotation.x = HOME - 0.2 * (1 - u) ** 2 * Math.abs(Math.sin(3 * Math.PI * u))
    }
    let switches = 0
    for (let i = 0; i < flicker.length; i++) if (since >= flicker[i]) switches++
    this.lamp.material.color.setHex(since >= 0 && switches % 2 === 0 ? LAMP_ON : LAMP_OFF)
    this.stepSparks(dt)
    if (since >= Math.max(bounce, flicker[flicker.length - 1]) && !this.alive) { this.pull = -1; this.pivot.rotation.x = HOME }
  }

  /** Ink sparks off the contacts as the blade closes. */
  private burst() {
    const s = this.spark, [x, y, z] = CONTACTS
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 8
      s[o] = x + (Math.random() - 0.5) * 0.04; s[o + 1] = y + (Math.random() - 0.5) * 0.05; s[o + 2] = z
      s[o + 3] = (Math.random() - 0.5) * 3.2; s[o + 4] = -0.4 + Math.random() * 2.4; s[o + 5] = 0.8 + Math.random() * 2
      s[o + 6] = 0; s[o + 7] = 0.22 + Math.random() * 0.24
    }
    this.alive = SPARKS
  }

  private stepSparks(dt: number) {
    if (!this.alive) return
    const s = this.spark
    let shown = 0
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 8
      if (s[o + 6] >= s[o + 7]) continue
      s[o + 6] += dt
      s[o + 4] -= 9 * dt
      s[o] += s[o + 3] * dt; s[o + 1] += s[o + 4] * dt; s[o + 2] += s[o + 5] * dt
      if (s[o + 6] >= s[o + 7]) continue
      sparkWay.set(s[o + 3], s[o + 4], s[o + 5])
      const speed = sparkWay.length()
      sparkTurn.setFromUnitVectors(FORWARD, sparkWay.divideScalar(speed))
      sparkSize.set(1, 1, Math.min(0.08, speed * 0.022) * (1 - s[o + 6] / s[o + 7]))
      this.sparks.setMatrixAt(shown++, sparkMatrix.compose(sparkAt.set(s[o], s[o + 1], s[o + 2]), sparkTurn, sparkSize))
    }
    this.alive = shown
    this.sparks.count = shown
    this.sparks.visible = shown > 0
    this.sparks.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.root.removeFromParent()
    // Its own shapes, bulb, stencil and sparks; the ink and steel materials are shared.
    this.root.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    this.lamp.material.dispose()
    if (this.plate instanceof THREE.Mesh) { this.plate.material.map?.dispose(); this.plate.material.dispose() }
    this.sparks.dispose()
  }
}

/**
 * Whether a hit from `source` lands on the shield on your back: it covers the half of the circle behind
 * you (SHIELD.arc either side of straight behind is measured from straight ahead).
 */
export function fromBehind(feet: THREE.Vector3, yaw: number, source: THREE.Vector3) {
  const dx = source.x - feet.x, dz = source.z - feet.z
  if (dx * dx + dz * dz < 1e-6) return false
  // The camera looks down -Z at yaw 0.
  const ahead = new THREE.Vector2(-Math.sin(yaw), -Math.cos(yaw)), to = new THREE.Vector2(dx, dz).normalize()
  return Math.acos(THREE.MathUtils.clamp(ahead.dot(to), -1, 1)) > SHIELD.arc
}
