// The compound exactly as Dead Ink plays it, for baking and checking the zombie navigation graph:
// the mission world's geometry, prepared the same way, with every door unlocked and open.
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { setDoorOpen } from '../src/world/doors'

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
