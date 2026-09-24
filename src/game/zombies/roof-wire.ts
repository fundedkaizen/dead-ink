import * as THREE from 'three'
import { Draft, type Point } from '../../render/ink'
import type { CollisionWorld } from '../../player/collision'

/**
 * Dead Ink keeps players inside the compound, and the mess hall's flat roof was the one way out: its west
 * ladder comes down on the road side, and from the knee-high parapet a jump carried a player off the roof onto
 * the road, and from there round the outside of every fence. In zombie mode, razor wire runs along the top of
 * the parapet on the three sides over the road (north, west and east), too high to jump; the parapet is built
 * up across the ladder's gap, under the wire; and the ladder is closed to players (PlayerActions skips a
 * ladder whose userData.closed is set). Zombies were already kept off both: windows.ts cuts their graph along
 * the hall's outer walls. The wire is on the parapet, not the roof, so no graph spot changes.
 */
export const ROOF_WIRE = {
  /**
   * Its collider, from the top of the parapet, up to the barbed strand along the stakes. A sprint jump into the
   * parapet rides up its edge and lifts the feet up to 0.73 m over it (dead-ink-perimeter-checks tries).
   */
  height: 1.1,
  /** The coil: how far it swells out across the wall and up, and how far apart its loops are. */
  across: 0.3, rise: 0.45, pitch: 0.26,
} as const

/** Wire the mess hall roof and close its ladder (see ROOF_WIRE); returns the undo. */
export function wireRoof(world: CollisionWorld, scene: THREE.Object3D) {
  const ladder = scene.getObjectByName('Mess hall · west exterior roof ladder')
  let hall: THREE.Object3D | null = ladder ?? null
  while (hall && hall.userData.kind !== 'mess-hall') hall = hall.parent
  const roof = hall?.getObjectByName('Mess hall · flat walkable roof and parapet')
  if (!ladder || !hall || !roof) { console.warn('Dead Ink: no mess hall roof to wire'); return () => {} }
  const [w, d] = hall.userData.footprint as [number, number], halfW = w / 2, halfD = d / 2
  const { walkingHeight, parapetHeight, ladderGapWidth } = roof.userData as { walkingHeight: number; parapetHeight: number; ladderGapWidth: number }
  const ladderZ = (ladder.userData.top as number[])[2]
  // In the hall's own frame, with its origin on top of the parapet: the colliders stand from there up.
  const wire = new Draft('Dead Ink · mess hall roof razor wire')
  wire.position.y = walkingHeight + parapetHeight
  // The ladder's gap, walled up to parapet height.
  wire.box(0.24, parapetHeight, ladderGapWidth, -halfW, -parapetHeight / 2, ladderZ, 'paper')
  const runs: [number, number, number, number][] = [
    [-halfW - 0.15, -halfD, halfW + 0.15, -halfD], [-halfW, -halfD, -halfW, halfD], [halfW, -halfD, halfW, halfD],
  ]
  wire.userData.collisionPanels = runs.map(([ax, az, bx, bz]) => ({ a: [ax, az], b: [bx, bz], height: ROOF_WIRE.height, blocksSight: false, blocksShots: false }))
  for (const [ax, az, bx, bz] of runs) coil(wire, ax, az, bx, bz)
  hall.add(wire.finish())
  world.addObject(wire)
  ladder.userData.closed = true
  return () => {
    world.removeObject(wire)
    wire.removeFromParent()
    wire.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() })
    delete ladder.userData.closed
  }
}

/** A concertina coil resting on a wall top from (ax, az) to (bx, bz), barbed, on stakes with a barbed strand along their tops. */
function coil(g: Draft, ax: number, az: number, bx: number, bz: number) {
  const length = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / length, uz = (bz - az) / length
  const { across: wide, rise, pitch, height } = ROOF_WIRE, loops = Math.round(length / pitch), sides = 12
  const at = (s: number, across: number, up: number): Point => [ax + ux * s - uz * across, up, az + uz * s + ux * across]
  for (let loop = 0; loop < loops; loop++) {
    // No two loops quite the same size, as a coil stretched along a wall sags and bulges.
    const k = 0.9 + 0.1 * Math.sin(loop * 2.3) + 0.05 * Math.sin(loop * 0.7)
    const points: Point[] = []
    for (let i = 0; i <= sides; i++) {
      const s = (loop + i / sides) * length / loops, angle = i / sides * Math.PI * 2 - Math.PI / 2
      points.push(at(s, Math.cos(angle) * wide * k, rise + Math.sin(angle) * rise * k))
    }
    g.line(points, 'detail')
    // Barbs on the crown and the outer side of each loop.
    const s = (loop + 0.5) * length / loops
    for (const [across, up] of [[0, rise * (1 + k)], [wide * k, rise]]) {
      g.line([at(s - 0.04, across - 0.03, up - 0.03), at(s + 0.04, across + 0.03, up + 0.03)], 'mesh')
      g.line([at(s - 0.04, across + 0.03, up + 0.03), at(s + 0.04, across - 0.03, up - 0.03)], 'mesh')
    }
  }
  const stakes = Math.max(1, Math.round(length / 3))
  for (let i = 0; i <= stakes; i++) g.line([at(i / stakes * length, 0, 0), at(i / stakes * length, 0, height)], 'detail')
  // The strand along the stake tops, barbed every 0.3 m: the collider's top edge, drawn.
  g.line([at(0, 0, height), at(length, 0, height)], 'detail')
  for (let s = 0.15; s < length; s += 0.3) g.line([at(s - 0.04, -0.03, height - 0.03), at(s + 0.04, 0.03, height + 0.03)], 'mesh')
}
