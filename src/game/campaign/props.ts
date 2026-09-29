import * as THREE from 'three'
import { Draft } from '../../render/ink'
import { createCellLock } from '../cell-lock'
import type { Station, StationKind } from '../types'
import type { CameraAnchor, MapModule, PanelKind } from './types'
import { createHelicopter as createDetailedHelicopter, type HelicopterRig } from './helicopter'
import { ammoStack, cameraPole, captivity, cardReader, fieldRadio, fuseBox, kennel, keycardBox, keyPanel, landingZone, laptopCrate, medicalPost, padlock, sniperNest } from './detail'
import { MISSIONS } from './missions'

const missionsOn = (map: MapModule) => MISSIONS.filter(mission => mission.map === map.id)

/**
 * What the campaign adds to a map's world so its anchors can be used: chairs and locks at the cells, the
 * panels (fuse boxes, laptops, keycards, key panels, radios, ammunition), pole cameras, helicopters with their
 * pads, and the boost marks. Built once, for every anchor of the map; each mission only uses its own (the rest
 * stand as scenery, their prompts off). Hostage mode only: Dead Ink never builds these.
 */
export type CameraObject = { id: string; root: THREE.Group; pivot: THREE.Group; lamp: THREE.Mesh }
export type MapProps = {
  root: THREE.Group
  stations: Station[]
  cameras: CameraObject[]
  vehicles: Map<string, THREE.Group>
  /** The helicopters' rigs, by extraction id (their rotors, doors, rope and lights). */
  helicopters: Map<string, HelicopterRig>
  /** The landing zones' windsocks (they stream in the rotor wash). */
  windsocks: Map<string, THREE.Group>
  chairs: Map<string, THREE.Object3D>
  /** Door hardware, by door name: keycard readers (their LEDs), a padlock on the leaf. */
  doorHardware: Map<string, { readers: { root: THREE.Object3D; led: THREE.Mesh }[]; padlock: THREE.Object3D | null }>
  /** Kennels by dog id, sniper nests by guard id. */
  kennels: Map<string, THREE.Object3D>
  nests: Map<string, THREE.Object3D>
}

const PANEL_STATION: Record<PanelKind, StationKind> = { power: 'power', intel: 'intel', keycard: 'keycard', 'alarm-panel': 'alarm', twokey: 'twokey', radio: 'heli', supply: 'supply', ammo: 'ammo' }


/** A panel's own shape (campaign/detail.ts), so you know what it is before the prompt shows. */
function panel(kind: PanelKind, label: string, id: string, position: readonly number[], facing: number): Station & { parts?: PanelParts } {
  const built = kind === 'power' ? fuseBox() : kind === 'intel' ? laptopCrate() : kind === 'keycard' ? keycardBox() : kind === 'twokey' ? keyPanel(id.endsWith('b') ? 'B' : 'A')
    : kind === 'radio' ? fieldRadio() : kind === 'ammo' ? ammoStack() : medicalPost()
  const object = built.root
  object.name = label
  object.position.set(position[0], position[1], position[2])
  object.rotation.y = facing
  object.userData = { noCollision: true, kind: 'mission-station', stationKind: PANEL_STATION[kind], stationId: id }
  object.updateMatrixWorld(true)
  const point = object.localToWorld(built.target.clone())
  const parts: PanelParts = { lever: (built as { lever?: THREE.Group }).lever, lamp: (built as { lamp?: THREE.Mesh }).lamp, key: (built as { key?: THREE.Group }).key,
    card: (built as { card?: THREE.Mesh }).card }
  object.userData.parts = parts
  return { id, kind: PANEL_STATION[kind], object, point, label, parts }
}

/** The moving bits of a panel: the fuse lever, a status lamp, a turning key, the keycard lying there. */
export type PanelParts = { lever?: THREE.Group; lamp?: THREE.Mesh; key?: THREE.Group; card?: THREE.Mesh }

export function poleCamera(spec: CameraAnchor): CameraObject {
  const root = new THREE.Group()
  root.name = spec.id
  root.position.set(...spec.position)
  root.userData.noCollision = true
  const { mount, pivot, lamp } = cameraPole(spec.position[1])
  pivot.rotation.y = spec.yaw
  root.add(mount, pivot)
  return { id: spec.id, root, pivot, lamp }
}

/** A boost spot: two chalk chevrons pointing over the wall. */
function boostMark(from: readonly number[], to: readonly number[]) {
  const angle = Math.atan2(to[0] - from[0], to[2] - from[2])
  const mark = new Draft('Boost spot', from[0], from[2], angle)
  mark.userData.noCollision = true
  for (const z of [-0.2, 0.15]) mark.line([[-0.35, 0.03, z - 0.25], [0, 0.03, z], [0.35, 0.03, z - 0.25]], 'detail')
  return mark.finish()
}

/**
 * Build the campaign's props for `map` into a new group (the caller adds it to the scene and to collision).
 * `doors`: the world's doors, for the detention cells' door locks. `existingCameras`: camera ids the world
 * already has (the compound's four).
 */
export function buildMapProps(map: MapModule, doors: readonly THREE.Group[], existingStations: readonly Station[], existingCameras: readonly string[]): MapProps {
  const root = new THREE.Group()
  root.name = `Rescue campaign props · ${map.name}`
  root.userData.noCollision = true
  const stations: Station[] = [], cameras: CameraObject[] = [], vehicles = new Map<string, THREE.Group>(), chairs = new Map<string, THREE.Object3D>()
  const helicopters = new Map<string, HelicopterRig>()
  const windsocks = new Map<string, THREE.Group>()
  for (const cell of Object.values(map.cells)) {
    if (cell.chair) {
      const seat = captivity(cell.station ? 3.9 : 3)
      seat.position.set(...cell.hostage); seat.rotation.y = cell.facing
      root.add(seat); chairs.set(cell.id, seat)
    }
    if (cell.station) {
      if (existingStations.some(station => station.id === cell.station)) continue
      const door = doors.find(candidate => candidate.userData.hostageId === cell.station)
      if (door) stations.push(createCellLock(door))
      continue
    }
    const lock = new THREE.Group()
    lock.position.set(...cell.lock.position)
    lock.userData = { noCollision: true, kind: 'mission-station', stationKind: 'hostage', stationId: `cell:${cell.id}` }
    root.add(lock)
    stations.push({ id: `cell:${cell.id}`, kind: 'hostage', object: lock, label: 'Cut the ropes',
      point: new THREE.Vector3(cell.hostage[0], cell.hostage[1] + 0.8, cell.hostage[2]) })
  }
  for (const spec of Object.values(map.panels)) {
    const station = panel(spec.kind, spec.label, spec.id, spec.position, spec.facing)
    root.add(station.object); stations.push(station)
  }
  for (const spec of Object.values(map.cameras)) {
    if (existingCameras.includes(spec.id)) continue
    const camera = poleCamera(spec)
    root.add(camera.root); cameras.push(camera)
  }
  for (const extraction of Object.values(map.extractions)) {
    if (extraction.kind === 'helicopter') {
      const rig = createDetailedHelicopter()
      const helicopter = rig.root
      helicopter.position.set(...extraction.park)
      helicopter.rotation.y = extraction.heading
      helicopter.visible = false
      const zone = landingZone()
      zone.root.position.set(...extraction.park); zone.root.rotation.y = extraction.heading
      root.add(zone.root, helicopter)
      windsocks.set(extraction.id, zone.sock)
      vehicles.set(extraction.id, helicopter)
      helicopters.set(extraction.id, rig)
      stations.push({ id: `board:${extraction.id}`, kind: 'jeep', object: helicopter, label: 'Board the helicopter',
        point: new THREE.Vector3(...extraction.board).setY(extraction.board[1] + 1.1) })
    }
    if (extraction.call) {
      const radio = panel('radio', 'Call the helicopter', `radio:${extraction.id}`, extraction.call.position, extraction.call.facing)
      root.add(radio.object); stations.push(radio)
    }
  }
  for (const boost of Object.values(map.boosts)) root.add(boostMark(boost.from, boost.to))
  root.updateMatrixWorld(true)
  // Door hardware for every door a mission on this map locks: readers on both faces for keycards, a padlock
  // on the leaf for a lock to pick (the two-key doors have their panels).
  const doorHardware: MapProps['doorHardware'] = new Map()
  for (const locked of missionsOn(map).flatMap(mission => mission.lockedDoors)) {
    const door = doors.find(candidate => candidate.name === locked.door)
    if (!door) continue
    const entry = doorHardware.get(locked.door) ?? { readers: [], padlock: null }
    doorHardware.set(locked.door, entry)
    const width = door.userData.width as number
    if (locked.lock === 'keycard' && !entry.readers.length) for (const side of [-1, 1]) {
      const reader = cardReader()
      reader.root.position.set(width / 2 + 0.22, -1.2 + 1.2, side * 0.08)
      reader.root.rotation.y = side > 0 ? 0 : Math.PI
      door.add(reader.root)
      entry.readers.push(reader)
    } else if (locked.lock !== 'keycard' && !entry.padlock) {
      const hinge = door.children.find(child => child.userData.doorHinge)
      if (!hinge) continue
      const lock = padlock()
      lock.position.set(width - 0.3, 1.05, 0.06)
      lock.userData.noCollision = true
      hinge.add(lock)
      entry.padlock = lock
    }
  }
  const kennels = new Map<string, THREE.Object3D>()
  const names = ['Rex', 'Brutus', 'Kaiser', 'Duke', 'Tank', 'Wolf', 'Bruno']
  Object.values(map.dogs).forEach((dog, i) => {
    const [a, b] = [dog.route[0], dog.route[1] ?? dog.route[0]]
    const along = Math.atan2(b[0] - a[0], b[2] - a[2])
    const house = kennel(names[i % names.length])
    house.position.set(a[0] - Math.cos(along) * 2.2, a[1], a[2] + Math.sin(along) * 2.2)
    house.rotation.y = along + Math.PI / 2
    house.userData.noCollision = true
    root.add(house); kennels.set(dog.id, house)
  })
  const nests = new Map<string, THREE.Object3D>()
  for (const guard of Object.values(map.guards)) {
    if (guard.role !== 'sniper') continue
    const nest = sniperNest()
    nest.position.set(...guard.position); nest.rotation.y = guard.facing ?? 0
    nest.userData.noCollision = true
    root.add(nest); nests.set(guard.id, nest)
  }
  return { root, stations, cameras, vehicles, helicopters, windsocks, chairs, doorHardware, kennels, nests }
}
