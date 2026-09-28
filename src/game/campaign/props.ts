import * as THREE from 'three'
import { Draft, type Point } from '../../render/ink'
import { groundOutline } from '../../world/architecture'
import { createCellLock } from '../cell-lock'
import { createMissionControl } from '../mission-controls'
import { CAMERA_LIGHTS } from '../security'
import type { Station, StationKind } from '../types'
import type { CameraAnchor, ExtractionAnchor, MapModule, PanelKind } from './types'

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
  chairs: Map<string, THREE.Object3D>
}

const PANEL_STATION: Record<PanelKind, StationKind> = { power: 'power', intel: 'intel', keycard: 'keycard', 'alarm-panel': 'alarm', twokey: 'twokey', radio: 'heli', supply: 'supply', ammo: 'ammo' }
export const KEYCARD_INK = 0xe3a41c
const SCREEN_BLUE = 0x146bff

function chair(position: readonly number[], facing: number) {
  const chair = new Draft('Hostage chair')
  chair.userData = { noCollision: true, kind: 'hostage-chair' }
  chair.box(0.48, 0.065, 0.46, 0, 0.3, -0.371, 'concrete', 'detail')
  for (const x of [-0.205, 0.205]) for (const z of [-0.56, -0.18]) chair.beam([x, 0.025, z], [x, 0.3, z], 0.045, 'roof', 'detail')
  for (const x of [-0.205, 0.205]) chair.beam([x, 0.31, -0.56], [x, 0.92, -0.59], 0.04, 'roof', 'detail')
  chair.box(0.47, 0.25, 0.05, 0, 0.78, -0.58, 'concrete', 'detail')
  // Rope loops round the back legs: this is where you cut him loose.
  for (const y of [0.45, 0.62]) chair.ring(0.06, y, 0, -0.58, 'detail', 12)
  chair.rotation.y = facing
  chair.position.set(position[0], position[1], position[2])
  return chair.finish()
}

/** A panel's own shape, so you know what it is before the prompt shows. */
function panel(kind: PanelKind, label: string, id: string, position: readonly number[], facing: number): Station {
  if (kind === 'supply') { const station = createMissionControl('supply', id, label, position as Point, facing); station.object.userData.noCollision = true; return station }
  const object = new Draft(label, position[0], position[2], facing)
  object.position.y = position[1]
  object.userData = { noCollision: true, kind: 'mission-station', stationKind: PANEL_STATION[kind], stationId: id }
  let target: Point = [0, 1.1, 0.2]
  const stand = (height: number) => {
    object.box(0.7, height, 0.5, 0, height / 2, 0, 'concrete', 'detail')
    if (position[1] < 0.05) groundOutline(object, 0, 0, 0.7, 0.5)
  }
  if (kind === 'power') {
    object.beam([0, 0, 0], [0, 1.1, 0], 0.12, 'roof', 'detail')
    object.box(0.62, 0.8, 0.26, 0, 1.35, 0.06, 'paper', 'edge')
    // A lightning bolt and the throw lever.
    object.line([[-0.06, 1.62, 0.2], [-0.14, 1.36, 0.2], [0.02, 1.38, 0.2], [-0.05, 1.12, 0.2]], 'detail')
    object.beam([0.2, 1.2, 0.22], [0.2, 1.48, 0.3], 0.05, 'roof', 'detail')
    target = [0.2, 1.4, 0.3]
  } else if (kind === 'intel') {
    stand(0.78)
    object.box(0.42, 0.03, 0.3, 0, 0.8, 0.02, 'roof', 'detail')
    object.box(0.42, 0.28, 0.02, 0, 0.94, -0.13, 'roof', 'detail', [-0.35, 0, 0])
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.22), new THREE.MeshBasicMaterial({ color: SCREEN_BLUE, toneMapped: false }))
    screen.position.set(0, 0.945, -0.114); screen.rotation.x = -0.35
    object.add(screen)
    target = [0, 0.95, 0]
  } else if (kind === 'keycard') {
    stand(0.78)
    const card = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.1), new THREE.MeshBasicMaterial({ color: KEYCARD_INK, toneMapped: false }))
    card.name = 'Keycard'
    card.position.set(0.05, 0.79, 0.04); card.rotation.y = 0.3
    object.add(card)
    object.box(0.3, 0.02, 0.22, -0.12, 0.79, -0.05, 'paper', 'detail', [0, -0.2, 0])
    target = [0.05, 0.85, 0.05]
  } else if (kind === 'twokey') {
    object.beam([0, 0, 0], [0, 1.0, 0], 0.1, 'roof', 'detail')
    object.box(0.42, 0.5, 0.18, 0, 1.25, 0.04, 'paper', 'edge')
    object.ring(0.05, 1.28, 0, 0.14, 'detail', 16)
    object.line([[0, 1.28, 0.14], [0, 1.2, 0.14]], 'detail')
    object.line([[-0.12, 1.45, 0.135], [0.12, 1.45, 0.135]], 'detail')
    target = [0, 1.28, 0.2]
  } else if (kind === 'radio') {
    stand(0.7)
    object.box(0.55, 0.3, 0.3, 0, 0.86, 0, 'green', 'detail')
    object.beam([0.2, 1.0, -0.1], [0.28, 1.9, -0.12], 0.025, 'paper', 'detail')
    for (const x of [-0.15, -0.05, 0.05]) object.box(0.05, 0.05, 0.03, x, 0.88, 0.16, 'paper', 'detail')
    target = [0, 0.95, 0.15]
  } else if (kind === 'ammo') {
    object.box(0.9, 0.42, 0.5, 0, 0.21, 0, 'roof', 'detail')
    object.box(0.94, 0.06, 0.54, 0, 0.45, 0, 'paper', 'detail')
    for (const x of [-0.25, 0, 0.25]) object.line([[x - 0.06, 0.2, 0.252], [x + 0.06, 0.32, 0.252]], 'detail')
    if (position[1] < 0.05) groundOutline(object, 0, 0, 0.9, 0.5)
    target = [0, 0.5, 0.1]
  } else {
    stand(0.9)
    target = [0, 1, 0]
  }
  object.finish()
  const point = new THREE.Vector3(...target).applyAxisAngle(new THREE.Vector3(0, 1, 0), facing).add(new THREE.Vector3(position[0], position[1], position[2]))
  return { id, kind: PANEL_STATION[kind], object, point, label }
}

export function poleCamera(spec: CameraAnchor): CameraObject {
  const root = new THREE.Group()
  root.name = spec.id
  root.position.set(...spec.position)
  root.userData.noCollision = true
  const mount = new Draft(`${spec.id} mount`)
  mount.box(0.12, spec.position[1], 0.12, 0, -spec.position[1] / 2, 0, 'roof', 'detail')
  const pivot = new THREE.Group()
  pivot.rotation.y = spec.yaw
  const casing = new Draft(`${spec.id} housing`)
  casing.box(0.4, 0.3, 0.7, 0, 0, 0.25, 'roof', 'detail')
  casing.box(0.24, 0.2, 0.04, 0, 0, 0.62, 'concrete', 'detail')
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: CAMERA_LIGHTS.watching, toneMapped: false }))
  lamp.name = `${spec.id} status light`
  lamp.position.set(0.15, -0.065, 0.65)
  pivot.add(casing.finish(), lamp)
  root.add(mount.finish(), pivot)
  return { id: spec.id, root, pivot, lamp }
}

/**
 * A small ink helicopter: cabin, tail boom, skids, and rotors that spin (userData.rotors). Its origin is the
 * middle of the skids on the ground; it faces +Z.
 */
export function createHelicopter() {
  const root = new THREE.Group()
  root.name = 'Extraction helicopter'
  root.userData = { noCollision: true, kind: 'helicopter' }
  const body = new Draft('Helicopter body')
  body.box(2.1, 1.7, 3.6, 0, 1.55, 0.2, 'paper', 'edge')
  body.box(1.9, 1.1, 1.2, 0, 1.35, 2.35, 'glass', 'edge')
  body.beam([0, 1.9, -1.4], [0, 2.2, -7.2], 0.42, 'paper', 'edge')
  body.box(0.12, 1.3, 1.0, 0, 2.6, -7.1, 'paper', 'edge')
  for (const x of [-1.05, 1.05]) {
    body.beam([x, 0.12, -1.6], [x, 0.12, 2.4], 0.1, 'roof', 'detail')
    for (const z of [-1, 1.6]) body.beam([x, 0.12, z], [x * 0.8, 0.75, z], 0.07, 'roof', 'detail')
  }
  // The open side door the team climbs in by.
  body.box(0.02, 1.2, 1.3, 1.06, 1.5, 0.4, 'roof', 'detail')
  body.box(0.34, 0.3, 0.34, 0, 2.55, 0.2, 'roof', 'detail')
  root.add(body.finish())
  const rotor = new Draft('Helicopter main rotor')
  for (const angle of [0, Math.PI / 2]) rotor.box(0.3, 0.05, 11, 0, 0, 0, 'roof', 'detail', [0, angle, 0])
  const rotorGroup = new THREE.Group()
  rotorGroup.position.set(0, 2.78, 0.2)
  rotorGroup.add(rotor.finish())
  const tail = new Draft('Helicopter tail rotor')
  tail.box(0.04, 1.6, 0.18, 0, 0, 0, 'roof', 'detail')
  const tailGroup = new THREE.Group()
  tailGroup.position.set(0.12, 2.6, -7.1)
  tailGroup.add(tail.finish())
  root.add(rotorGroup, tailGroup)
  root.userData.rotors = [rotorGroup, tailGroup]
  return root
}

/** A painted landing pad: a circle and an H. */
function helipad(extraction: ExtractionAnchor) {
  const pad = new Draft(`${extraction.label} · landing pad`, extraction.park[0], extraction.park[2], extraction.heading)
  pad.userData.noCollision = true
  pad.ring(4.2, 0.03, 0, 0, 'detail', 64)
  pad.line([[-1, 0.03, -1.4], [-1, 0.03, 1.4]], 'edge')
  pad.line([[1, 0.03, -1.4], [1, 0.03, 1.4]], 'edge')
  pad.line([[-1, 0.03, 0], [1, 0.03, 0]], 'edge')
  return pad.finish()
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
  for (const cell of Object.values(map.cells)) {
    if (cell.chair) { const seat = chair(cell.hostage, cell.facing); root.add(seat); chairs.set(cell.id, seat) }
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
      const helicopter = createHelicopter()
      helicopter.position.set(...extraction.park)
      helicopter.rotation.y = extraction.heading
      helicopter.visible = false
      root.add(helipad(extraction), helicopter)
      vehicles.set(extraction.id, helicopter)
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
  return { root, stations, cameras, vehicles, chairs }
}
