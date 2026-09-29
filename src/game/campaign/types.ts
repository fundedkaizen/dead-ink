import type * as THREE from 'three'
import type { EnemySpec, MissionWorld, Vec3 } from '../types'

/**
 * The rescue campaign's data (campaign/missions.ts) and the maps it plays on (campaign/maps/). A mission names
 * everything it uses by id from its map module: where you go in, the cells the hostage can be held in, the
 * way out, the cameras, panels, locked doors, boost spots, guards and dogs. A new map (a real place traced from
 * OpenStreetMap) is one more MapModule with its own anchors and, for its geometry, a build(); the mission logic
 * never changes for it.
 */
export type Difficulty = 'normal' | 'hard' | 'nightmare'
export const DIFFICULTIES: readonly Difficulty[] = ['normal', 'hard', 'nightmare']
export const DIFFICULTY_LABELS: Record<Difficulty, string> = { normal: 'Normal', hard: 'Hard', nightmare: 'Nightmare' }

/** A circle on the ground (y limits optional: the cells underground, a roof). */
export type Zone = { x: number; z: number; r: number; minY?: number; maxY?: number }

export type SpawnAnchor = { id: string; label: string; position: Vec3; lookAt: Vec3 }

/** Where a hostage can be held: his chair, the lock you free him at, and the area that counts as finding him. */
export type CellAnchor = {
  id: string; label: string; area: string
  hostage: Vec3; facing: number
  lock: { position: Vec3; facing: number }
  /** An existing door (by name) that keeps him in: locked until he is freed. */
  door?: string
  zone: Zone
  /** A chair to build (false where the map already has one). */
  chair?: boolean
  /** The id of a lock the map already has (the detention cells' door locks); otherwise one is built at `lock`. */
  station?: string
}

export type ExtractionKind = 'jeep' | 'helicopter' | 'boat'
/**
 * The way out. The team brings the hostage into `zone`; a helicopter or boat must first be called on its radio
 * (`call`) and arrives after `eta` seconds, which the team holds out; then everyone boards at `board` and the
 * vehicle leaves along `route` while a fixed camera (`camera`) watches.
 */
export type ExtractionAnchor = {
  id: string; kind: ExtractionKind; label: string
  board: Vec3; seats: Vec3[]; route: Vec3[]
  camera: { target: Vec3; offset: Vec3 }
  zone: Zone
  /** The jeep needs the exit gate open. */
  gate?: boolean
  call?: { position: Vec3; facing: number }
  eta?: number
  /** Where the vehicle waits (before a helicopter lands it is out of sight). */
  park: Vec3; heading: number
}

export type CameraAnchor = { id: string; position: Vec3; yaw: number; arc: number; range: number; wallMount?: Vec3 }

/** Panels the missions use as objectives: a fuse box, a laptop with the intel, a keycard on a desk. */
export type PanelKind = 'power' | 'intel' | 'keycard' | 'alarm-panel' | 'twokey' | 'radio' | 'supply' | 'ammo'
/** `area`: where it is, in words (the intel names a keycard's hiding place by it). */
export type PanelAnchor = { id: string; kind: PanelKind; label: string; position: Vec3; facing: number; pair?: string; area?: string }

/** Two players only: one gives a boost at `from`, the other climbs to `to` (over a wall, onto a roof). */
export type BoostAnchor = { id: string; label: string; from: Vec3; to: Vec3 }

export type LockKind = 'keycard' | 'pick' | 'twokey'
/** An existing door (by name) a mission locks: a keycard, a lock to pick (or breach), or a two-key panel. */
export type LockedDoor = { door: string; lock: LockKind; label: string; card?: string; panel?: string }

/** A guard as a map offers it. `tier`: only on Hard and up, or only on Nightmare. `routes`: other patrols picked per run. */
export type GuardAnchor = EnemySpec & { tier?: 'hard' | 'nightmare'; routes?: Vec3[][] }

export type DogAnchor = { id: string; route: Vec3[]; tier?: 'hard' | 'nightmare' }

export type NamedZone = Zone & { id: string; label: string }

export interface MapModule {
  id: string
  name: string
  /** Where on Earth (or "A rail supply compound"), for the briefing. */
  place: string
  /**
   * The map's geometry for the mission. Absent: the built-in compound (createCompound + createMissionWorld),
   * which the page builds at load. A location map returns its own scene root and mission world.
   */
  build?: () => { scenery: THREE.Group; world: MissionWorld }
  spawns: Record<string, SpawnAnchor>
  cells: Record<string, CellAnchor>
  extractions: Record<string, ExtractionAnchor>
  cameras: Record<string, CameraAnchor>
  panels: Record<string, PanelAnchor>
  boosts: Record<string, BoostAnchor>
  zones: Record<string, NamedZone>
  /** Guards beyond the ones the map's world already has (world.enemies). */
  guards: Record<string, GuardAnchor>
  dogs: Record<string, DogAnchor>
  /** The mission-select preview: building outlines [x, z, width, depth] and the drawn area. */
  preview: { buildings: [number, number, number, number][]; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }
}

export type ObjectiveKind = 'reach' | 'use' | 'find' | 'free' | 'escort' | 'call' | 'defend' | 'extract'
export type ObjectiveDef = {
  id: string; kind: ObjectiveKind; text: string
  /** reach: a zone id. use: panel ids, any one of them. */
  zone?: string; panels?: string[]
  /** defend: seconds to hold the landing zone. */
  seconds?: number
  optional?: boolean
}
export type StageDef = { id: string; title: string; objectives: ObjectiveDef[] }

export type MissionDef = {
  id: string
  /** Order in the campaign, from 1. */
  number: number
  name: string
  briefing: string
  /** A careful co-op team's play time, as shown on the select screen. */
  estimate: string
  map: string
  /** Picked per run from these. */
  spawns: string[]
  cells: string[]
  hostages: number
  hostageName: string
  extraction: string
  cameras: string[]
  panels: string[]
  lockedDoors: LockedDoor[]
  /** Keycards: each lies at one of `at` (picked per run). */
  keycards: { id: string; label: string; at: string[] }[]
  boosts: string[]
  /** 'world' takes every guard the map's world already has; the rest are ids from the map's guard pool. */
  guards: ('world' | string)[]
  dogs: string[]
  /** Doors that lock while the alarm sounds. */
  alarmLocks: string[]
  stages: StageDef[]
  /** Time star: finish under this many seconds. */
  par: Record<Difficulty, number>
  tools: { pebbles: number; charges: number; drone: boolean }
}
