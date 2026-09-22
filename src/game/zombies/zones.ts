import * as THREE from 'three'
import { fence, gate } from '../../world/industrial'
import { wallText } from '../../render/ink'
import type { CollisionWorld } from '../../player/collision'
import type { NavGraph } from './navgraph'
import { PRICES } from './rules'

/**
 * Zones, Call of Duty style: you start in the mess yard, and every other part of the compound is shut
 * behind a gate you pay to open. The compound already has its gates, standing open; Dead Ink closes
 * them, and adds one fence (with its own gate) where the southwest yard and the warehouse yard ran into
 * each other beside the gatehouse.
 *
 * A closed gate blocks the player (its colliders) and the zombies (the navigation graph is cut across
 * it), so zombies only ever rise in zones a player has opened. Opening one sinks it into the ink.
 */
export type GateSpec = {
  id: string
  /** The zone it opens into. */
  zone: string
  cost: number
  centre: [number, number]
  width: number
  /** Rotation about Y: the gate spans its local X axis. */
  angle: number
  /** The compound's own open gate standing here, hidden while this one is shut. */
  replaces?: string
}

export const ZONE_GATES: readonly GateSpec[] = [
  { id: 'southwest', zone: 'Southwest Stores', cost: PRICES.door.cheap, centre: [-60.45, 21.15], width: 10.8, angle: 0, replaces: 'West service gate · open' },
  { id: 'warehouse', zone: 'Warehouse Yard', cost: PRICES.door.standard, centre: [-12.45, 2.25], width: 7.8, angle: -Math.PI / 2, replaces: 'Inner yard gate · open' },
  { id: 'yards', zone: 'Warehouse Yard', cost: PRICES.door.standard, centre: [-11.05, 40], width: 5.6, angle: Math.PI / 2 },
  { id: 'rail', zone: 'Rail Yard', cost: PRICES.door.expensive, centre: [57, -18.75], width: 6, angle: 0, replaces: 'Rail maintenance gate · open' },
  { id: 'annex', zone: 'East Annex', cost: 1500, centre: [99, 11], width: 6, angle: Math.PI / 2, replaces: 'East annex service gate · open' },
  { id: 'railEntrance', zone: 'East Annex', cost: 1500, centre: [99, -32.3], width: 5.4, angle: Math.PI / 2 },
]

/**
 * Fence Dead Ink adds so the zones only meet at gates: across the slot between the inner-yard fence and
 * the gatehouse, and from the gatehouse to the south perimeter either side of the 'yards' gate.
 */
export const ZONE_FENCES: readonly [number, number][][] = [
  [[-12.45, 24.0], [-11.05, 24.0]],
  [[-11.05, 30.9], [-11.05, 37.2]],
  [[-11.05, 42.8], [-11.05, 49.3]],
]

/**
 * Ways out that stay shut in Dead Ink, cut from the navigation graph for good: the compound's secure exit
 * gate (the hostage mission's escape), which would join the outer road to the east annex.
 */
export const SEALED: readonly { door: string; a: [number, number]; b: [number, number] }[] = [
  { door: 'Secure compound exit gate', a: [164, 6.6], b: [164, 15.4] },
]

/** The ends of a gate's opening, flat. */
export function gateSegment(spec: GateSpec): [THREE.Vector3, THREE.Vector3] {
  const along = new THREE.Vector3(Math.cos(spec.angle), 0, -Math.sin(spec.angle)).multiplyScalar(spec.width / 2)
  const centre = new THREE.Vector3(spec.centre[0], 0, spec.centre[1])
  return [centre.clone().sub(along), centre.clone().add(along)]
}

export type ZoneGate = {
  spec: GateSpec
  segment: [THREE.Vector3, THREE.Vector3]
  closed: THREE.Object3D
  /** The open gate shown once paid for: the compound's own, or one made here. */
  opened: THREE.Object3D | null
  ownOpened: boolean
  gap: number | null
  state: 'closed' | 'opening' | 'open'
  sink: number
}

const SINK = { seconds: 0.9, depth: 3.6 } as const

export class ZoneGates {
  readonly gates: ZoneGate[] = []
  private fences: THREE.Object3D[] = []

  constructor(private scene: THREE.Scene, private world: CollisionWorld, private graph: NavGraph) {
    ZONE_FENCES.forEach((points, i) => {
      const run = fence(`Dead Ink zone fence ${i + 1}`, points)
      scene.add(run)
      world.addObject(run)
      for (let n = 1; n < points.length; n++) graph.closeGap({ x: points[n - 1][0], z: points[n - 1][1] }, { x: points[n][0], z: points[n][1] })
      this.fences.push(run)
    })
    for (const seal of SEALED) graph.closeGap({ x: seal.a[0], z: seal.a[1] }, { x: seal.b[0], z: seal.b[1] })
    for (const spec of ZONE_GATES) {
      const [x, z] = spec.centre
      const existing = spec.replaces ? scene.getObjectByName(spec.replaces) ?? null : null
      const opened = existing ?? gate(`${spec.zone} gate · open`, x, z, spec.width, spec.angle, true)
      this.gates.push({ spec, segment: gateSegment(spec), closed: closedGate(spec), opened, ownOpened: !existing, gap: null, state: 'open', sink: 0 })
    }
  }

  /** Shut every gate: a new game. */
  closeAll() {
    for (const g of this.gates) {
      if (g.state === 'closed') continue
      g.closed.position.y = 0
      if (!g.closed.parent) this.scene.add(g.closed)
      this.world.addObject(g.closed)
      if (g.opened) {
        g.opened.visible = false
        if (g.ownOpened && g.opened.parent) { this.world.removeObject(g.opened); g.opened.removeFromParent() }
      }
      g.gap = this.graph.closeGap(g.segment[0], g.segment[1])
      g.state = 'closed'
    }
  }

  /** Paid for: the way through opens at once, and the gate sinks into the ink. */
  open(g: ZoneGate) {
    if (g.state !== 'closed') return false
    this.world.removeObject(g.closed)
    if (g.gap !== null) this.graph.openGap(g.gap)
    g.gap = null
    if (g.opened) {
      g.opened.visible = true
      if (g.ownOpened) { this.scene.add(g.opened); this.world.addObject(g.opened) }
    }
    g.state = 'opening'
    g.sink = 0
    return true
  }

  update(dt: number) {
    for (const g of this.gates) {
      if (g.state !== 'opening') continue
      g.sink += dt
      const t = Math.min(1, g.sink / SINK.seconds)
      g.closed.position.y = -SINK.depth * t * t
      if (t >= 1) { g.closed.removeFromParent(); g.state = 'open' }
    }
  }

  /** The point on a closed gate nearest `eye`, at chest height: where its buy prompt sits. */
  nearestPoint(g: ZoneGate, eye: THREE.Vector3) {
    const line = new THREE.Line3(g.segment[0], g.segment[1])
    return line.closestPointToPoint(eye.clone().setY(0), true, new THREE.Vector3()).setY(1.3)
  }

  isOpen(id: string) { return this.gates.find(g => g.spec.id === id)?.state !== 'closed' }

  dispose() {
    for (const g of this.gates) {
      this.world.removeObject(g.closed); g.closed.removeFromParent()
      if (g.opened) { g.opened.visible = true; if (g.ownOpened) { this.world.removeObject(g.opened); g.opened.removeFromParent() } }
      if (g.gap !== null) this.graph.openGap(g.gap)
    }
    for (const run of this.fences) { this.world.removeObject(run); run.removeFromParent() }
  }
}

/** A shut wire gate with the zone's name and its price painted on both faces. */
function closedGate(spec: GateSpec) {
  const g = gate(`${spec.zone} gate · closed`, spec.centre[0], spec.centre[1], spec.width, spec.angle, false)
  g.userData.zoneGate = spec.id
  for (const [face, turn] of [[0.06, 0], [-0.06, Math.PI]] as const) {
    g.add(wallText(spec.zone.toUpperCase(), [0, 1.95, face], 0.32, turn))
    g.add(wallText(String(spec.cost), [0, 1.45, face], 0.42, turn))
  }
  return g
}
