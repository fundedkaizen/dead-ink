import * as THREE from 'three'
import { Draft, createRarityBeam, wallText } from '../../render/ink'
import type { WallSpot } from './placement'

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

/** The part itself, about the size of the thing it is. */
export function partModel(id: PartId) {
  const g = new THREE.Group()
  g.name = `Part: ${id}`
  switch (id) {
    case 'lever':
      outlined(g, new THREE.CylinderGeometry(0.02, 0.02, 0.5, 10), metal, [0, 0.25, 0])
      outlined(g, new THREE.CylinderGeometry(0.04, 0.04, 0.14, 12), ink, [0, 0.5, 0], [0, 0, Math.PI / 2])
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
    // A tall column of light over it, seen from across the yard, as the box's is.
    const beam = createRarityBeam(0xffd27a, 7)
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
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  readonly placed = new Set<PartId>()
  private slots = new Map<PartId, { ghost: THREE.Object3D; solid: THREE.Object3D }>()
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
      this.root.add(chalk)
      this.root.add(wallText(BUILDS[build].label.toUpperCase(), [0, 1.5, -0.47], 0.22))
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
  hideParts() { for (const { ghost, solid } of this.slots.values()) { ghost.visible = false; solid.visible = false } }

  reset() {
    this.placed.clear()
    for (const { ghost, solid } of this.slots.values()) { ghost.visible = true; solid.visible = false; solid.scale.setScalar(0.8) }
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
 * The power switch: a grey box on the wall with cables running up it, a lamp, and (once its lever is
 * back) a big lever you pull down. Pulled, the lamp lights and the power comes on across the compound.
 */
export class PowerSwitch {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  private lever = new THREE.Group()
  private lamp: THREE.Mesh
  private pull = -1
  state: 'broken' | 'ready' | 'on' = 'broken'

  constructor(readonly spot: WallSpot) {
    this.root.name = 'Power switch'
    this.root.userData.noCollision = true
    this.root.position.copy(spot.wall.clone().addScaledVector(spot.normal, 0.02).setY(spot.stand.y))
    this.root.rotation.y = Math.atan2(spot.normal.x, spot.normal.z)
    const box = new Draft('Power switch box')
    box.box(0.7, 0.9, 0.22, 0, 1.45, 0.11, 'paper', 'edge')
    box.box(0.56, 0.7, 0.02, 0, 1.45, 0.23, 'paper', 'detail')
    // Conduit up the wall and across.
    box.box(0.08, 1.3, 0.08, -0.22, 2.55, 0.05, 'paper', 'edge')
    box.box(0.08, 1.3, 0.08, 0.22, 2.55, 0.05, 'paper', 'edge')
    box.hatch([-0.3, 1.1, 0.245], [0.6, 0, 0], [0, 0.15, 0], { spacing: 0.05 })
    box.finish()
    this.root.add(box)
    // On the box's face, clear of the conduits above.
    this.root.add(wallText('POWER', [0, 1.62, 0.245], 0.13))
    this.lamp = new THREE.Mesh(new THREE.CircleGeometry(0.06, 20), new THREE.MeshBasicMaterial({ color: 0x3a3a3a, toneMapped: false }))
    this.lamp.position.set(0, 1.78, 0.235)
    this.root.add(this.lamp)
    // The lever pivots at the box's side; it points up when off and swings down when pulled.
    this.lever.position.set(0.42, 1.45, 0.2)
    const arm = partModel('lever')
    arm.position.y = 0
    this.lever.add(arm)
    this.lever.visible = false
    this.root.add(this.lever)
    this.point = spot.wall.clone().addScaledVector(spot.normal, 0.3).setY(spot.stand.y + 1.45)
  }

  /** The lever goes back on. */
  repair() { if (this.state === 'broken') { this.state = 'ready'; this.lever.visible = true; this.lever.rotation.z = 0 } }

  /** Pull it down; returns true on the pull that turns the power on. */
  turnOn() {
    if (this.state !== 'ready') return false
    this.state = 'on'
    this.pull = 0
    return true
  }

  reset() {
    this.state = 'broken'; this.pull = -1
    this.lever.visible = false; this.lever.rotation.z = 0
    ;(this.lamp.material as THREE.MeshBasicMaterial).color.setHex(0x3a3a3a)
  }

  update(dt: number) {
    if (this.pull < 0) return
    this.pull = Math.min(1, this.pull + dt / 0.5)
    // A heavy pull: slow to start, then it slams home.
    this.lever.rotation.z = -Math.PI * 0.85 * this.pull ** 2
    const lit = this.pull >= 1
    ;(this.lamp.material as THREE.MeshBasicMaterial).color.setHex(lit ? 0x4fb34a : 0x3a3a3a)
    if (lit) this.pull = -1
  }

  dispose() {
    this.root.removeFromParent()
    this.lever.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    this.lamp.geometry.dispose(); (this.lamp.material as THREE.Material).dispose()
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
