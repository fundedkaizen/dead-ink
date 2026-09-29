import { seeded, shuffled, type Random } from '../shared/random'
import type { EnemySpec, Vec3 } from '../types'
import { rulesFor } from './difficulty'
import type { Difficulty, MapModule, MissionDef, ObjectiveDef, Zone } from './types'

/**
 * One attempt at a campaign mission, as MissionState.run: everything picked for this run from its seed (where
 * you go in, which cell holds the hostage, where the keycards lie, which way each guard patrols) and everything
 * the team has done so far. It lives in the mission state, so checkpoints, restarts and the co-op mirror carry it
 * like the rest.
 */
export type HostageVitals = {
  health: number; max: number
  /** 0 up, 1 down (bleeding out: a player can revive him), 2 dead (the mission fails). */
  down: 0 | 1 | 2
  bleed: number
  /** Told to stay put ("wait here"), instead of following the nearest player. */
  waiting: boolean
  /** Who he follows first (the player who freed him, or who last said "follow me"). */
  leader: number
}

export type CampaignRun = {
  mission: string; difficulty: Difficulty; seed: number
  spawn: string
  /** Per hostage, the cell he is held in. */
  cells: string[]
  /** Keycard id -> the panel it lies at. */
  cards: Record<string, string>
  /** Guard id -> index of the patrol it walks this run (0: its own). */
  routes: Record<string, number>
  stage: number
  done: string[]
  /** Panels used (a panel works once). */
  used: string[]
  /** Keycards the team carries. */
  held: string[]
  /** Doors opened for good (a keycard, a picked lock, a breach, two keys). */
  unlocked: string[]
  /** Hostages whose cell the team has seen (or the intel revealed). */
  found: boolean[]
  revealed: boolean
  powerOff: boolean
  /** Extraction: called on the radio, seconds until it arrives (counting while the team holds the zone), arrived. */
  called: boolean; eta: number; arrived: boolean
  hostages: HostageVitals[]
  stones: number; charges: number
  /** Boost spot -> the player lifting there (co-op). */
  boosts?: Record<string, number>
  /** Spotter marks the team shares: a guard (by index) or a camera (by id), until a mission time. */
  marks?: { kind: 'guard' | 'camera'; ref: string; until: number }[]
  // What the run counted, for the stars and the summary.
  alarms: number; takedowns: number; loudShots: number; hostageDamage: number; hostageDowned: number; bodiesFound: number
}

export const HOSTAGE_BLEED_SECONDS = 50

const pick = <T>(random: Random, items: readonly T[]) => items[Math.floor(random() * items.length)]

export function createRun(mission: MissionDef, map: MapModule, difficulty: Difficulty, seed: number): CampaignRun {
  // Scramble the seed first: nearby seeds (1, 2, 3...) would otherwise start their streams alike.
  const random = seeded(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(mission.number, 0xc2b2ae35))
  random(); random()
  const spawn = pick(random, mission.spawns)
  const cells = shuffled(random, mission.cells).slice(0, mission.hostages)
  const cards: Record<string, string> = {}
  for (const card of mission.keycards) cards[card.id] = pick(random, card.at)
  const routes: Record<string, number> = {}
  for (const id of mission.guards) {
    const guard = map.guards[id]
    if (guard?.routes?.length) routes[id] = Math.floor(random() * (guard.routes.length + 1))
  }
  const max = rulesFor(difficulty).hostageHealth
  return {
    mission: mission.id, difficulty, seed, spawn, cells, cards, routes,
    stage: 0, done: [], used: [], held: [], unlocked: [], found: cells.map(() => false), revealed: false, powerOff: false,
    called: false, eta: map.extractions[mission.extraction]?.eta ?? 0, arrived: map.extractions[mission.extraction]?.kind === 'jeep',
    hostages: cells.map(() => ({ health: max, max, down: 0, bleed: 0, waiting: false, leader: 0 })),
    stones: mission.tools.pebbles, charges: mission.tools.charges,
    alarms: 0, takedowns: 0, loudShots: 0, hostageDamage: 0, hostageDowned: 0, bodiesFound: 0,
  }
}

/**
 * The guards of this run: the map world's own (for missions that take them), then the mission's pool guards,
 * each on this run's patrol; the difficulty's tiers decide which pool guards come.
 */
export function resolveGuards(mission: MissionDef, map: MapModule, run: CampaignRun, worldGuards: readonly EnemySpec[]): EnemySpec[] {
  const tiers = rulesFor(run.difficulty).tiers
  const guards: EnemySpec[] = []
  for (const id of mission.guards) {
    if (id === 'world') { guards.push(...worldGuards.map(spec => structuredClone(spec))); continue }
    const anchor = map.guards[id]
    if (!anchor || (anchor.tier && !tiers.includes(anchor.tier))) continue
    const { tier: _tier, routes, ...spec } = structuredClone(anchor)
    const route = run.routes[id] ? routes?.[run.routes[id] - 1] : undefined
    if (route?.length) { spec.patrol = route; spec.position = [...route[0]] as Vec3 }
    guards.push(spec)
  }
  return guards
}

export const insideZone = (zone: Zone, p: readonly number[]) =>
  Math.hypot(p[0] - zone.x, p[2] - zone.z) <= zone.r && (zone.minY === undefined || p[1] >= zone.minY) && (zone.maxY === undefined || p[1] <= zone.maxY)

/** What the host sees this frame, for the objectives. */
export type ObjectiveFacts = {
  /** Every player still up, feet positions. */
  players: readonly (readonly number[])[]
  /** Every hostage: freed (not captive), loaded aboard, position. */
  hostages: readonly { freed: boolean; loaded: boolean; position: readonly number[] }[]
  complete: boolean
}

function objectiveDone(objective: ObjectiveDef, mission: MissionDef, map: MapModule, run: CampaignRun, facts: ObjectiveFacts) {
  const extraction = map.extractions[mission.extraction]
  switch (objective.kind) {
    case 'reach': { const zone = objective.zone ? map.zones[objective.zone] : undefined; return !!zone && facts.players.some(p => insideZone(zone, p)) }
    case 'use': return (objective.panels ?? []).some(id => run.used.includes(id))
    case 'find': return run.found.every(Boolean)
    case 'free': return facts.hostages.length > 0 && facts.hostages.every(h => h.freed)
    case 'escort': return !!extraction && facts.hostages.every((h, i) => run.hostages[i]?.down === 2 || h.loaded || (h.freed && insideZone(extraction.zone, h.position)))
    case 'call': return run.called
    case 'defend': return run.arrived && run.called
    case 'extract': return facts.complete
  }
}

/**
 * Tick the objectives: mark what is now done (in any stage: a team that frees the hostage before cutting the
 * power has still freed him), and move the stage on past every stage whose required objectives are all done.
 * Returns the objectives completed this call, for the captions.
 */
export function updateObjectives(mission: MissionDef, map: MapModule, run: CampaignRun, facts: ObjectiveFacts): ObjectiveDef[] {
  const fresh: ObjectiveDef[] = []
  // The cells: seeing the hostage (standing in his cell's zone) finds him.
  run.cells.forEach((id, index) => {
    const cell = map.cells[id]
    if (cell && !run.found[index] && facts.players.some(p => insideZone(cell.zone, p))) run.found[index] = true
  })
  for (const stage of mission.stages) for (const objective of stage.objectives) {
    if (run.done.includes(objective.id) || !objectiveDone(objective, mission, map, run, facts)) continue
    run.done.push(objective.id)
    fresh.push(objective)
  }
  while (run.stage < mission.stages.length && mission.stages[run.stage].objectives.every(o => o.optional || run.done.includes(o.id))) run.stage++
  return fresh
}

/** The stage the team is on (the last one once all are done). */
export const currentStage = (mission: MissionDef, run: CampaignRun) => mission.stages[Math.min(run.stage, mission.stages.length - 1)]

/** The line for the HUD and the pause menu: the stage, then its first open objective. */
export function objectiveLine(mission: MissionDef, run: CampaignRun) {
  const stage = currentStage(mission, run)
  const next = stage.objectives.find(o => !o.optional && !run.done.includes(o.id)) ?? stage.objectives.find(o => !run.done.includes(o.id))
  return next ? next.text : stage.title
}

/** A hostage's hurt: he goes down at no health, and a down hostage who bleeds out is dead. */
export function hurtHostage(vitals: HostageVitals, amount: number) {
  if (vitals.down || !(amount > 0)) return false
  vitals.health = Math.max(0, vitals.health - amount)
  if (!vitals.health) { vitals.down = 1; vitals.bleed = HOSTAGE_BLEED_SECONDS }
  return true
}

/** Time on the floor; true the moment he dies. */
export function bleedHostage(vitals: HostageVitals, dt: number) {
  if (vitals.down !== 1) return false
  vitals.bleed = Math.max(0, vitals.bleed - Math.max(0, dt))
  if (vitals.bleed > 0) return false
  vitals.down = 2
  return true
}

/** A player got him up: half his health back. */
export function reviveHostage(vitals: HostageVitals) {
  if (vitals.down !== 1) return false
  vitals.down = 0; vitals.bleed = 0; vitals.health = Math.ceil(vitals.max / 2)
  return true
}
