// The compound exactly as Dead Ink plays it, for baking and checking the zombie navigation graph:
// the mission world's geometry, prepared the same way, with every door unlocked and open.
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { setDoorOpen } from '../src/world/doors'
import type { RaisedWays } from '../src/game/zombies/navgraph'

export function buildNavScene() {
  const scene = new THREE.Scene()
  const compound = createCompound(), mission = createMissionWorld(compound)
  prepareCompound(compound)
  scene.add(compound, mission.root)
  const doors: THREE.Group[] = []
  scene.traverse(o => { if (o.userData.kind === 'door') doors.push(o as THREE.Group) })
  for (const door of doors) { door.userData.missionLocked = false; setDoorOpen(door, true, true) }
  const world = new CollisionWorld(scene)
  world.refresh()
  return { scene, world, doors, bounds: mission.bounds, mission }
}

/**
 * The ways up for zombies: every ladder, as the player climbs it (PlayerActions.ladderPoint: the bottom
 * rung, level with the deck just outside it, then on the deck), and the zip line landings.
 */
export function raisedWays(scene: THREE.Object3D, world: CollisionWorld): RaisedWays {
  const ways: RaisedWays = { climbs: [], seeds: [] }
  scene.traverse(object => {
    const data = object.userData
    if (data.kind === 'ladder') {
      const bottom = object.localToWorld(new THREE.Vector3(0, data.bottomHeight + 0.025, 0.44))
      const outside = object.localToWorld(new THREE.Vector3(0, data.landingHeight + 0.025, 0.44))
      const top = object.localToWorld(new THREE.Vector3(0, data.landingHeight + 0.025, -data.landingDepth - 0.18))
      // Tank roofs slope up beyond the ladder; use the actual landing surface.
      const floor = world.floor(top, 0.7, 0.25)
      if (Number.isFinite(floor)) top.y = floor + 0.025
      outside.y = Math.max(outside.y, top.y)
      ways.climbs.push({ bottom, via: [outside], top })
      ways.seeds.push(top)
    }
    if (data.kind === 'zipline' && data.gameplay)
      for (const key of ['startLanding', 'endLanding']) ways.seeds.push(object.localToWorld(new THREE.Vector3().fromArray(data[key])))
  })
  return ways
}
