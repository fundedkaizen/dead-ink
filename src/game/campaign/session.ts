import * as THREE from 'three'
import { setDoorOpen } from '../../world/doors'
import type { ActionTarget } from '../../player/actions'
import { insideVisionCone, type Enemy } from '../ai'
import { initialMission, useStation, loadedCount, type HostageState, type MissionState } from '../mission'
import type { MissionRuntime } from '../runtime'
import type { EnemySpec, Station, WeaponItem } from '../types'
import { rulesFor, missionReward } from './difficulty'
import { MISSIONS, MISSION_IDS, mapFor, missionById } from './missions'
import { CampaignStore, type Stars } from './progress'
import { buildMapProps, type MapProps } from './props'
import { FollowEscort } from './escort'
import { bootMap } from './boot'
import { guardGear } from './detail'
import { awardsFor, grantReward, grantXp } from './rewards'
import { bleedHostage, createRun, currentStage, hurtHostage, insideZone, resolveGuards, reviveHostage, updateObjectives } from './run'
import { NOISE, starsFor, stealthRating, type RunStats, type StealthRating } from './stealth'
import type { Difficulty, ExtractionAnchor, LockedDoor, MapModule, MissionDef } from './types'

/**
 * The rescue campaign inside the running mission (runtime.ts): loading a mission (its guards, hostages, cameras,
 * panels, locks and way out), its rules each frame on the host (objectives, the alarm, the helicopter's
 * approach, a hostage bleeding out), and every player's own prompts (locked doors, takedowns from behind,
 * boosts, the hostage's "wait here" and "follow me"). Co-op guests ask the host through `act()`, which the host
 * answers in `hostAction()`; the run itself travels in the mission state like the rest.
 */
export const HOSTAGE_SENSE_ID = 90
/** Seconds in combat before a guard gets to an alarm (the difficulty picks). */
const RAISE_ALARM: Record<Difficulty, number> = { normal: 11, hard: 8, nightmare: 5 }
const PICK_SECONDS = 8, SLOW_PICK_SECONDS = 20, REVIVE_SECONDS = 3, BREACH_FUSE = 3, TWO_KEY_WINDOW = 1.5, SYNC_WINDOW = 3

export type Summary = {
  mission: MissionDef; difficulty: Difficulty; time: number; stars: Stars; rating: StealthRating
  ink: number; xp: number; best: boolean; unlocked: string | null; awards: string[]; stats: RunStats; kills: number; hostageHealth: number
}

type Hold = { label: string; seconds: number; elapsed: number; from: THREE.Vector3; done: () => void; noise?: number; noiseTimer?: number }
type Charge = { door: string; fuse: number }

export class CampaignSession {
  readonly store = new CampaignStore(MISSION_IDS)
  mission: MissionDef = MISSIONS[0]
  /** The map this page was built with (a mission on another map reloads the page: load()). */
  map: MapModule = bootMap()
  props: MapProps
  loading = false
  /** Set when a mission ends in success: what the summary shows. */
  summary: Summary | null = null
  /** This player's held action (a lock being picked, the hostage being got up). */
  hold: Hold | null = null
  /** This player's tools: stones to throw, breach charges. */
  stones = 0
  charges = 0
  /** This player gives a boost at this spot (co-op). */
  boosting: string | null = null
  private worldGuards: EnemySpec[]
  private doors = new Map<string, THREE.Group>()
  private plantedCharges: Charge[] = []
  private combatFor = 0
  private lastStage = 0
  private ammoTaken = new Map<string, number>()
  private turns = new Map<string, number>()
  private syncs = new Map<number, { guard: number; at: number; direction: THREE.Vector3 }>()
  private lzNoise = 0
  private recorded = false
  private lastAlarm: MissionState['alarm'] = 'inactive'

  constructor(private r: MissionRuntime, scene: THREE.Scene) {
    this.worldGuards = structuredClone(r.world.enemies)
    for (const door of r.player.actions.doors) this.doors.set(door.name, door)
    const existing = r.world.rescue?.cameras.map(camera => camera.id) ?? []
    this.props = buildMapProps(this.map, r.player.actions.doors, r.world.stations, existing)
    scene.add(this.props.root)
    r.world.stations.push(...this.props.stations)
  }

  get run() { return this.r.state.run }
  get rules() { return rulesFor(this.run?.difficulty ?? 'normal') }
  get extraction(): ExtractionAnchor { return this.map.extractions[this.mission.extraction] }

  /** The mission and difficulty to begin with: the saved choice, or ?mission= and ?difficulty= on the address. */
  initialChoice() {
    const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)
    const saved = this.store.current()
    const asked = missionById(params.get('mission'))
    const difficulty = (['normal', 'hard', 'nightmare'] as Difficulty[]).find(d => d === params.get('difficulty')) ?? saved.difficulty
    return { id: asked?.id ?? saved.id, difficulty, seed: Number(params.get('seed')) || undefined }
  }

  // ---------------------------------------------------------------- loading a mission

  /**
   * Plan mission `id` on difficulty `difficulty` from `seed` (a co-op guest uses the host's), and set the world up
   * for it. `first`: the page's first load, where the guards are not loaded yet (the runtime's init loads them).
   */
  async load(id: string, difficulty: Difficulty, seed = Math.floor(Math.random() * 2 ** 31), first = false) {
    const r = this.r
    const mission = missionById(id) ?? MISSIONS[0]
    if (mapFor(mission).id !== this.map.id && typeof location !== 'undefined') {
      // Another map's geometry: load the page onto it (co-op guests follow through the host's invite link).
      const url = new URL(location.href)
      url.searchParams.set('mission', mission.id); url.searchParams.set('difficulty', difficulty)
      location.href = url.toString()
      return mission
    }
    this.loading = true
    this.mission = mission
    this.map = mapFor(mission)
    const run = createRun(mission, this.map, difficulty, seed)
    const guards = resolveGuards(mission, this.map, run, this.worldGuards)
    r.world.enemies = guards
    if (!first) await r.ai.respawn(guards)
    else await r.ai.init()
    const rules = rulesFor(difficulty)
    r.ai.options = { accuracy: rules.accuracy, alertness: rules.alertness, sight: rules.sight, gradual: true }
    // Their kit: helmets and radios, a hood for the marksmen.
    for (const enemy of r.ai.enemies) {
      const bones = (enemy.actor as { rig?: { bones: Record<string, THREE.Object3D> } }).rig?.bones
      if (bones?.head && bones.chest) guardGear(bones.head, bones.chest, enemy.spec.role === 'sniper')
    }
    const extraction = this.extraction
    if (r.escort instanceof FollowEscort) await r.escort.setup(run.cells.map(cell => ({ position: this.map.cells[cell].hostage, facing: this.map.cells[cell].facing })), extraction)
    const state = initialMission()
    state.hostages = run.cells.map((cellId, index): HostageState => {
      const cell = this.map.cells[cellId]
      return { id: cell.station ?? `cell:${cell.id}`, status: 'captive', position: [...cell.hostage], routeIndex: index }
    })
    state.run = run
    r.state = state
    const spawn = this.map.spawns[run.spawn]
    r.world.spawn = [...spawn.position]
    r.world.lookAt = [...spawn.lookAt]
    r.security.configure(this.cameraRigs(), { detectionDwell: rules.cameraDwell, secondWaveDelay: rules.secondWave, reserveLimit: rules.reinforcements })
    r.escape.configure(extraction.route, extraction.camera.target, extraction.camera.offset, extraction.kind !== 'jeep', extraction.heading)
    r.weapons.restore({ slots: campaignLoadout(), selected: 0, pickups: [], nextId: 1000 })
    const tiers = rules.tiers
    r.dogs?.setup(mission.dogs.map(id => this.map.dogs[id]).filter(dog => dog && (!dog.tier || tiers.includes(dog.tier))), rules.smell)
    this.stones = mission.tools.pebbles
    this.charges = mission.tools.charges
    this.boosting = null; this.hold = null; this.summary = null; this.recorded = false
    this.plantedCharges = []; this.turns.clear(); this.syncs.clear(); this.ammoTaken.clear()
    this.combatFor = 0; this.lastStage = 0; this.lzNoise = 0; this.lastAlarm = 'inactive'
    this.loading = false
    return mission
  }

  private cameraRigs() {
    const rigs = [...(this.r.world.rescue?.cameras ?? []), ...this.props.cameras]
    const active = new Set(this.mission.cameras)
    for (const rig of rigs) {
      const on = active.has(rig.id)
      const root = (rig as { root?: THREE.Object3D }).root ?? rig.pivot.parent
      if (root) root.visible = on
    }
    return this.mission.cameras.map(id => {
      const spec = this.map.cameras[id]
      const rig = rigs.find(candidate => candidate.id === id)!
      return { spec: { id, position: spec.position, yaw: spec.yaw, arc: spec.arc, range: spec.range }, rig }
    }).filter(entry => entry.rig)
  }

  // ---------------------------------------------------------------- the world, from the run

  /** Doors, panels and the vehicle as the run has them (after a load, a checkpoint, a co-op tick). */
  syncWorld() {
    const run = this.run, state = this.r.state
    if (!run) return
    for (const locked of this.mission.lockedDoors) {
      const door = this.doors.get(locked.door)
      if (!door) continue
      const open = run.unlocked.includes(locked.door)
      door.userData.missionLocked = !open
      if (!open && door.userData.open) setDoorOpen(door, false, true)
    }
    for (const name of this.mission.alarmLocks) {
      const door = this.doors.get(name)
      if (!door || run.unlocked.includes(name) || this.mission.lockedDoors.some(locked => locked.door === name && !run.unlocked.includes(name))) continue
      const lockdown = state.alarm === 'active'
      if (lockdown && !door.userData.missionLocked) setDoorOpen(door, false)
      door.userData.missionLocked = lockdown
    }
    // Cells: a detention cell with nobody in it stays shut; the cell doors of the held open once freed.
    for (const door of this.r.player.actions.doors) {
      const id = door.userData.hostageId as string | undefined
      if (!id) continue
      const hostage = state.hostages.find(candidate => candidate.id === id)
      const released = !!hostage && hostage.status !== 'captive'
      door.userData.missionLocked = !released
      setDoorOpen(door, released, true)
    }
    for (const station of this.props.stations) station.object.visible = this.visible(station)
    // The props' own state: a thrown fuse lever and its dark lamp, turned keys, the radio's lamp.
    for (const station of this.props.stations) {
      const parts = station.object.userData.parts as import('./props').PanelParts | undefined
      if (!parts) continue
      const used = run.used.includes(station.id)
      if (parts.lever) parts.lever.rotation.x = used ? -1.15 : 0
      if (parts.lamp) (parts.lamp.material as THREE.MeshBasicMaterial).color.setHex(station.kind === 'power' ? (used ? 0x3a3a3a : 0x3fae4a) : station.kind === 'heli' ? (run.called ? 0x3fae4a : 0xf0a020) : used ? 0x3fae4a : 0xf0a020)
      if (parts.key) parts.key.rotation.z = used ? -Math.PI / 2 : 0
    }
    // Door hardware: readers only on this mission's keycard doors (green once open), padlocks while locked.
    const lockedHere = new Map(this.mission.lockedDoors.map(locked => [locked.door, locked]))
    for (const [name, hardware] of this.props.doorHardware) {
      const locked = lockedHere.get(name), open = run.unlocked.includes(name)
      for (const reader of hardware.readers) {
        reader.root.visible = locked?.lock === 'keycard'
        ;(reader.led.material as THREE.MeshBasicMaterial).color.setHex(open ? 0x3fae4a : 0xd0302a)
      }
      if (hardware.padlock) hardware.padlock.visible = !!locked && locked.lock !== 'keycard' && !open
    }
    const tiers = rulesFor(run.difficulty).tiers
    for (const [id, kennel] of this.props.kennels) { const dog = this.map.dogs[id]; kennel.visible = this.mission.dogs.includes(id) && (!dog?.tier || tiers.includes(dog.tier)) }
    for (const [id, nest] of this.props.nests) { const guard = this.map.guards[id]; nest.visible = this.mission.guards.includes(id) && (!guard?.tier || tiers.includes(guard.tier)) }
    // Helicopters: campaign/visuals.ts flies them in from the run.
    for (const [id, vehicle] of this.props.vehicles) if (!this.props.helicopters.has(id)) vehicle.visible = id === this.mission.extraction && run.arrived
    const jeep = this.r.world.rescue?.jeep
    if (jeep) jeep.visible = this.extraction.kind === 'jeep' || this.r.escape.active
    this.r.player.world.refresh()
  }

  /** Whether a campaign prop shows at all in this mission (unchosen keycard spots, other missions' panels do not). */
  private visible(station: Station) {
    const run = this.run
    if (!run) return false
    if (station.kind === 'keycard') return Object.values(run.cards).includes(station.id) && !run.used.includes(station.id)
    if (station.kind === 'hostage') return true
    if (station.id.startsWith('radio:') || station.id.startsWith('board:')) return station.id.endsWith(`:${this.mission.extraction}`)
    return this.mission.panels.includes(station.id)
  }

  /** Whether a station offers its prompt in this mission. */
  active(station: Station) {
    const run = this.run
    if (!run) return true
    switch (station.kind) {
      case 'hostage': return this.r.state.hostages.some(hostage => hostage.id === station.id)
      case 'jeep': return station.id === 'rescue-jeep' ? this.extraction.kind === 'jeep' : station.id === `board:${this.mission.extraction}`
      case 'gate': return !!this.extraction.gate
      case 'cameras': case 'alarm': case 'distraction': return true
      case 'supply': return !this.props.stations.includes(station) || this.mission.panels.includes(station.id)
      default: return this.visible(station)
    }
  }

  // ---------------------------------------------------------------- stations

  /** A campaign station's prompt (undefined: the classic rules decide). */
  label(station: Station): string | null | undefined {
    const run = this.run, state = this.r.state
    if (!run) return undefined
    if (!this.active(station)) return null
    const name = this.mission.hostageName
    switch (station.kind) {
      case 'hostage': {
        const captive = state.hostages.find(hostage => hostage.id === station.id)?.status === 'captive'
        return !captive || state.phase !== 'active' ? null : station.id.startsWith('cell:') ? 'Cut the ropes' : 'Unlock the cell'
      }
      case 'power': return run.used.includes(station.id) ? null : run.powerOff ? 'Power already off' : 'Cut the power'
      case 'intel': return run.used.includes(station.id) ? null : station.label
      case 'keycard': return 'Take the keycard'
      case 'twokey': return 'Turn the key'
      case 'ammo': return 'Take ammunition'
      case 'heli': return run.called ? null : 'Call the helicopter'
      case 'jeep': {
        if (station.id === 'rescue-jeep') return undefined
        if (!run.arrived) return run.called ? 'The helicopter is on its way' : 'Call the helicopter on the radio first'
        if (loadedCount(state) < this.aliveHostages()) return `Get ${name} aboard first`
        return this.r.coop?.paired ? this.r.coop.jeepLabel().replace('jeep', 'helicopter') : 'Board the helicopter'
      }
      default: return undefined
    }
  }

  private aliveHostages() { return this.run?.hostages.filter(vitals => vitals.down !== 2).length ?? this.r.state.hostages.length }

  /** Use a campaign station (the host, for itself or a guest `by`); null: the classic rules handle it. */
  use(station: Station, by: number): { changed: boolean; message: string } | null {
    const run = this.run, state = this.r.state
    if (!run || state.phase !== 'active') return null
    const name = this.mission.hostageName
    switch (station.kind) {
      case 'hostage': {
        const result = useStation(state, 'hostage', station.id)
        if (!result.changed) return result
        const index = state.hostages.findIndex(hostage => hostage.id === station.id)
        if (run.hostages[index]) run.hostages[index].leader = by
        run.found[index] = true
        const who = this.mission.hostages > 1 ? 'One of them is free' : `${name} is free`
        return { changed: true, message: `${who}. He follows the nearest of you: H tells him to wait or follow.` }
      }
      case 'power': {
        if (run.powerOff || run.used.includes(station.id)) return { changed: false, message: '' }
        run.powerOff = true; run.used.push(station.id)
        state.camerasActive = false; state.camerasDisabledUntil = null
        // A dead fuse box is noticed: the nearest guards come to look.
        this.r.ai.hear({ kind: 'power-cut', position: station.point.clone(), radius: 34 })
        return { changed: true, message: 'Power cut: the cameras are dark for good. Guards nearby will come to check the fuse box.' }
      }
      case 'intel': {
        if (run.used.includes(station.id)) return { changed: false, message: '' }
        run.used.push(station.id); run.revealed = true
        const areas = [...new Set(run.cells.map(cell => this.map.cells[cell].area))]
        return { changed: true, message: `Found it: ${name} ${this.mission.hostages > 1 ? 'are' : 'is'} held in ${areas.join(' and ')}. Marked on your screen.` }
      }
      case 'keycard': {
        if (run.used.includes(station.id)) return { changed: false, message: '' }
        run.used.push(station.id)
        const card = Object.entries(run.cards).find(([, spot]) => spot === station.id)?.[0]
        if (card && !run.held.includes(card)) run.held.push(card)
        const label = this.mission.keycards.find(entry => entry.id === card)?.label ?? 'a keycard'
        return { changed: true, message: `You have ${label}. Swipe it at the locked door.` }
      }
      case 'twokey': return this.turnKey(station.id)
      case 'heli': {
        if (run.called) return { changed: false, message: '' }
        if (state.hostages.some(hostage => hostage.status === 'captive')) return { changed: false, message: `Free ${name} first: the helicopter will not wait long.` }
        run.called = true; run.used.push(station.id)
        this.lzNoise = 2
        return { changed: true, message: `Helicopter inbound: about ${Math.round(run.eta)} seconds. Hold the landing zone; the clock only runs while one of you is on it.` }
      }
      case 'jeep': {
        if (station.id === 'rescue-jeep') return null
        if (!run.arrived) return { changed: false, message: run.called ? 'Hold on: the helicopter has not landed yet.' : 'Call it on the radio first.' }
        if (loadedCount(state) < this.aliveHostages()) return { changed: false, message: `Get ${name} aboard first: bring him close and he climbs in.` }
        state.gateOpen = true
        state.jeep = 'escaping'; state.escapeProgress = 0
        return { changed: true, message: 'Everyone aboard. Lifting off.' }
      }
      default: return null
    }
  }

  /** A two-key panel: both keys within a second and a half of each other open the door. */
  private turnKey(id: string) {
    const run = this.run!, now = this.r.state.elapsed
    const panel = this.map.panels[id]
    this.turns.set(id, now)
    const other = panel?.pair ? this.turns.get(panel.pair) : undefined
    if (other === undefined || now - other > TWO_KEY_WINDOW) return { changed: true, message: 'Key turned. The other key must turn at the same moment (within a second and a half).' }
    for (const locked of this.mission.lockedDoors) {
      if (locked.lock !== 'twokey' || (locked.panel !== id && locked.panel !== panel?.pair)) continue
      this.unlock(locked.door, true)
    }
    run.used.push(id)
    if (panel?.pair) run.used.push(panel.pair)
    return { changed: true, message: 'Both keys turned. The records room is open.' }
  }

  /** Open a door for good (keycard, picked, breached, two keys). */
  private unlock(name: string, swing: boolean) {
    const run = this.run!, door = this.doors.get(name)
    if (!run.unlocked.includes(name)) run.unlocked.push(name)
    if (door) { door.userData.missionLocked = false; if (swing) setDoorOpen(door, true) }
    this.r.coop?.doorUsed(door ?? new THREE.Object3D())
  }

  // ---------------------------------------------------------------- this player's prompts

  /** The locked doors, takedowns, boosts and hostage prompts near this player. */
  targets(): ActionTarget[] {
    const r = this.r, run = this.run, targets: ActionTarget[] = []
    if (!run || r.state.phase !== 'active' || this.hold) return targets
    const feet = r.player.body.position, eye = r.view.position
    // Locked doors.
    for (const locked of this.lockedHere()) {
      const door = this.doors.get(locked.door)!
      const hinge = door.children.find(child => child.userData.doorHinge)
      const point = (hinge ?? door).localToWorld(new THREE.Vector3(door.userData.width * 0.7, 1.2, 0))
      if (point.distanceTo(eye) > 2.6) continue
      const index = r.player.actions.doors.indexOf(door)
      const breach = this.charges > 0 ? ' · B: breach' : ''
      if (locked.lock === 'keycard') {
        const card = this.mission.keycards.find(entry => entry.id === locked.card)
        const has = !!locked.card && run.held.includes(locked.card)
        targets.push({ object: door, point, kind: 'mission', descending: false, label: has ? `Swipe ${card?.label ?? 'the keycard'}` : `Locked · needs ${card?.label ?? 'a keycard'}${breach}`,
          use: () => { if (!has) { r.hud.notify(`Locked. Find ${card?.label ?? 'the keycard'}, or breach it (B) if you have a charge.`, 4); return false }
            this.act(`door:${index}:card`); return true } })
      } else {
        const slow = locked.lock === 'twokey'
        const seconds = slow ? SLOW_PICK_SECONDS : PICK_SECONDS
        targets.push({ object: door, point, kind: 'mission', descending: false, label: `${slow ? 'Two keys, or pick it slowly' : 'Pick the lock'} · hold F${breach}`,
          use: () => { this.startHold(`Picking the lock`, seconds, () => this.act(`door:${index}:picked`), NOISE.lockpick); return true } })
      }
    }
    for (const name of this.mission.alarmLocks) {
      const door = this.doors.get(name)
      if (!door?.userData.missionLocked || this.mission.lockedDoors.some(locked => locked.door === name)) continue
      const point = door.localToWorld(new THREE.Vector3(0, 1.2, 0))
      if (point.distanceTo(eye) > 2.6) continue
      targets.push({ object: door, point, kind: 'mission', descending: false, label: `Locked down by the alarm${this.charges > 0 ? ' · B: breach' : ''}`,
        use: () => { r.hud.notify('The alarm locked it. Silence the alarm at a panel, or breach it (B).', 4); return false } })
    }
    // Takedowns from behind.
    const forward = r.view.getWorldDirection(new THREE.Vector3()).setY(0).normalize()
    r.ai.enemies.forEach((enemy, index) => {
      if (!this.canTakeDown(enemy, feet)) return
      const witness = this.witness(enemy)
      const point = enemy.position.clone().setY(enemy.position.y + 1.3)
      const paired = !!r.coop?.paired
      targets.push({ object: enemy.actor.root, point, kind: 'mission', descending: false,
        label: witness && paired ? 'Takedown · a guard is watching: sync with your partner' : witness ? 'Takedown · another guard will see' : 'Takedown',
        use: () => { this.act(`takedown:${index}:${witness && paired ? 'sync' : 'now'}:${forward.x.toFixed(3)},${forward.z.toFixed(3)}`); return true } })
    })
    // The hostages: get a downed one up.
    r.state.hostages.forEach((hostage, index) => {
      const vitals = run.hostages[index]
      if (!vitals || vitals.down !== 1) return
      const at = new THREE.Vector3(...hostage.position)
      if (at.distanceTo(feet) > 2.2) return
      targets.push({ object: r.escort.actors[index]?.root ?? new THREE.Object3D(), point: at.clone().setY(at.y + 0.6), kind: 'mission', descending: false,
        label: `Hold F to get ${this.hostageName(index)} up`, use: () => { this.startHold(`Getting ${this.hostageName(index)} up`, REVIVE_SECONDS, () => this.act(`hostage:${index}:revive`)); return true } })
    })
    // Boosts.
    for (const id of this.mission.boosts) {
      const boost = this.map.boosts[id]
      const from = new THREE.Vector3(...boost.from)
      if (from.distanceTo(feet) > 1.9) continue
      const giver = run.boosts?.[id]
      const me = r.coop?.link.id ?? 0
      if (this.boosting === id) targets.push({ object: r.world.root, point: from.clone().setY(from.y + 0.8), kind: 'mission', descending: false, label: 'Stop boosting',
        use: () => { this.stopBoost(); return true } })
      else if (giver !== undefined && giver !== me) targets.push({ object: r.world.root, point: from.clone().setY(from.y + 1.1), kind: 'mission', descending: false, label: `Climb: ${boost.label.toLowerCase()}`,
        use: () => { this.climb(id); return true } })
      else if (giver === undefined) targets.push({ object: r.world.root, point: from.clone().setY(from.y + 0.8), kind: 'mission', descending: false,
        label: r.coop?.paired ? `Give a boost · ${boost.label.toLowerCase()}` : 'Boost spot · needs two of you',
        use: () => { if (!r.coop?.paired) { r.hud.notify('A boost needs a teammate: one lifts, the other climbs. Invite a friend from Co-op.', 4); return false }
          this.boosting = id; r.player.movementLocked = true; r.cancelInput(); this.act(`boost:${id}:give`); return true } })
    }
    return targets
  }

  private hostageName(index: number) {
    const names = this.mission.hostageName.split(' and ')
    return names[index] ?? names[0]
  }

  /** The doors this mission locks that are still locked. */
  private lockedHere(): LockedDoor[] {
    const run = this.run
    if (!run) return []
    return this.mission.lockedDoors.filter(locked => !run.unlocked.includes(locked.door) && this.doors.get(locked.door)?.userData.missionLocked)
  }

  /** Close enough, behind him, and he has not made you out. */
  canTakeDown(enemy: Enemy, feet: THREE.Vector3) {
    if (['dead', 'reserve', 'combat'].includes(enemy.state) || enemy.awareness >= 1 || enemy.spec.role === 'sniper') return false
    const dx = feet.x - enemy.position.x, dz = feet.z - enemy.position.z, distance = Math.hypot(dx, dz)
    if (distance > 1.7 || Math.abs(feet.y - enemy.position.y) > 0.8) return false
    return (Math.sin(enemy.yaw) * dx + Math.cos(enemy.yaw) * dz) / Math.max(distance, 1e-3) < -0.3
  }

  /** Another guard who would see this one fall. */
  witness(enemy: Enemy) {
    const point = enemy.position.clone().setY(enemy.position.y + 1)
    return this.r.ai.enemies.find(other => other !== enemy && !['dead', 'reserve'].includes(other.state) && other.position.distanceTo(enemy.position) < 20 &&
      insideVisionCone(other.position.clone().setY(other.position.y + 1.5), other.yaw, point, 20, 55) &&
      this.r.player.world.visible(other.position.clone().setY(other.position.y + 1.5), point, other.actor.root)) ?? null
  }

  private startHold(label: string, seconds: number, done: () => void, noise?: number) {
    this.hold = { label, seconds, elapsed: 0, from: this.r.player.body.position.clone(), done, noise, noiseTimer: 0 }
    this.r.cancelInput()
  }

  private stopBoost() {
    if (!this.boosting) return
    this.act(`boost:${this.boosting}:stop`)
    this.boosting = null
    this.r.player.movementLocked = false
  }

  /** Over the wall: a short hop to the far side (the boost's `to`). */
  private climb(id: string) {
    const r = this.r, boost = this.map.boosts[id]
    const to = new THREE.Vector3(...boost.to)
    const floor = r.player.world.floor(to.clone().setY(to.y + 1), 1, 2)
    if (Number.isFinite(floor)) to.y = floor + 0.005
    r.player.body.teleport(to)
    r.player.actions.syncCamera(r.view)
    r.emit({ kind: 'ladder', position: to.clone(), radius: NOISE.walk }, true)
    r.hud.notify(`Over. ${boost.label}.`, 3)
    this.act(`boost:${id}:done`)
  }

  /** Throw one of your stones toward where you look (the runtime draws its flight: tools.ts). */
  takeStone() { if (this.stones <= 0) return false; this.stones--; return true }

  /** B near a locked door: a breach charge, if you have one. */
  breach() {
    const r = this.r, eye = r.view.position
    if (this.charges <= 0) return false
    const names = [...this.lockedHere().map(locked => locked.door), ...this.mission.alarmLocks.filter(name => this.doors.get(name)?.userData.missionLocked)]
    const door = names.map(name => this.doors.get(name)!).find(door => door.localToWorld(new THREE.Vector3(0, 1.2, 0)).distanceTo(eye) < 2.8)
    if (!door) return false
    this.charges--
    this.act(`door:${r.player.actions.doors.indexOf(door)}:breach`)
    r.hud.notify(`Charge set: ${BREACH_FUSE} seconds. Stand back.`, 3)
    return true
  }

  /** H: the nearest freed hostage waits, or follows you. */
  command() {
    const r = this.r, run = this.run
    if (!run) return false
    const feet = r.player.body.position
    let best = -1, distance = 20
    r.state.hostages.forEach((hostage, index) => {
      if (hostage.status !== 'following' || run.hostages[index]?.down) return
      const d = feet.distanceTo(new THREE.Vector3(...hostage.position))
      if (d < distance) { distance = d; best = index }
    })
    if (best < 0) { r.hud.notify('No freed hostage near you.', 2); return false }
    const waiting = run.hostages[best].waiting
    this.act(`hostage:${best}:${waiting ? 'follow' : 'wait'}`)
    r.hud.notify(waiting ? `${this.hostageName(best)}: "Right behind you."` : `${this.hostageName(best)}: "I'll stay here. Don't be long."`, 3)
    return true
  }

  /** An action on the mission: the host (or a solo player) does it at once; a guest asks the host. */
  act(id: string) {
    const coop = this.r.coop
    if (coop?.isGuest && coop.paired) coop.link.send({ t: 'use', id })
    else this.hostAction(id, 0)
  }

  /** Host: an action from player `from` (0 the host). Checks it makes sense, then does it. */
  hostAction(id: string, from: number) {
    const r = this.r, run = this.run, state = r.state
    if (!run || state.phase !== 'active') return
    const [kind, a, b, c] = id.split(':')
    const note = (text: string) => { if (from) r.coop?.link.send({ t: 'note', x: text, s: 4 }, { to: from }); else r.hud.notify(text, 4) }
    if (kind === 'door') {
      const door = r.player.actions.doors[Number(a)]
      if (!door) return
      const locked = this.mission.lockedDoors.find(entry => entry.door === door.name)
      if (b === 'card' && locked?.card && run.held.includes(locked.card)) { this.unlock(door.name, true); note('Keycard accepted.') }
      else if (b === 'picked' && locked && locked.lock !== 'keycard') { this.unlock(door.name, true); note('The lock gives. Door open.') }
      else if (b === 'breach' && (locked || this.mission.alarmLocks.includes(door.name))) this.plantedCharges.push({ door: door.name, fuse: BREACH_FUSE })
      r.syncWorld()
    } else if (kind === 'takedown') {
      const enemy = r.ai.enemies[Number(a)]
      const [x, z] = (c ?? '0,1').split(',').map(Number)
      if (!enemy) return
      if (b === 'sync') {
        this.syncs.set(from, { guard: Number(a), at: state.elapsed, direction: new THREE.Vector3(x, 0, z) })
        const ready = [...this.syncs.entries()].filter(([, entry]) => state.elapsed - entry.at <= SYNC_WINDOW)
        if (ready.length >= 2) {
          for (const [player, entry] of ready) this.takedown(entry.guard, entry.direction, player)
          this.syncs.clear()
          r.coop?.link.send({ t: 'note', x: 'Synced takedown.', s: 3 }); r.hud.notify('Synced takedown.', 3)
        } else note('Ready. Your partner has three seconds to take theirs (F on their guard).')
      } else this.takedown(Number(a), new THREE.Vector3(x, 0, z), from)
    } else if (kind === 'hostage') {
      const vitals = run.hostages[Number(a)]
      if (!vitals) return
      if (b === 'wait') vitals.waiting = true
      else if (b === 'follow') { vitals.waiting = false; vitals.leader = from }
      else if (b === 'revive' && reviveHostage(vitals)) note(`${this.hostageName(Number(a))} is back on his feet.`)
    } else if (kind === 'boost') {
      run.boosts ??= {}
      if (b === 'give' && run.boosts[a] === undefined) run.boosts[a] = from
      else if ((b === 'stop' && run.boosts[a] === from) || b === 'done') {
        const giver = run.boosts[a]
        delete run.boosts[a]
        // The climber is over: the one who lifted can move again.
        if (b === 'done' && giver !== undefined) { if (giver === 0) this.releaseBoost(); else r.coop?.link.send({ t: 'note', x: 'Your teammate is over. You can move again.', s: 3 }, { to: giver }) }
      }
    } else if (kind === 'mark') {
      run.marks ??= []
      const until = state.elapsed + 30
      const existing = run.marks.find(mark => mark.kind === a && mark.ref === b)
      if (existing) existing.until = until
      else run.marks.push({ kind: a as 'guard' | 'camera', ref: b, until })
    } else if (kind === 'camera') {
      if (r.security.destroy(a)) note('Camera down.')
    }
  }

  /** The host's own boost is over (the climber went). */
  releaseBoost() {
    if (!this.boosting) return
    this.boosting = null
    this.r.player.movementLocked = false
    this.r.hud.notify('Your teammate is over. You can move again.', 3)
  }

  private takedown(index: number, direction: THREE.Vector3, by: number) {
    const r = this.r, enemy = r.ai.enemies[index]
    if (!enemy || !r.ai.takedown(enemy, direction.lengthSq() > 0.1 ? direction : enemy.position.clone().sub(r.player.body.position))) return
    this.run!.takedowns++
    if (by) r.coop?.link.send({ t: 'hit', p: [enemy.position.x, enemy.position.y + 1.2, enemy.position.z], z: 'torso', l: 1 }, { to: by })
    else { r.state.kills++; r.audio.play({ kind: 'takedown', position: enemy.position.clone(), radius: NOISE.takedown }) }
  }

  // ---------------------------------------------------------------- each frame

  /** Every client, while playing: this player's held action and the boost they give. */
  local(dt: number) {
    const r = this.r, hold = this.hold
    if (hold) {
      const moved = r.player.body.position.distanceTo(hold.from) > 0.6
      if (!r.player.useHeld || moved || r.state.phase !== 'active') {
        this.hold = null
        if (moved || !r.player.useHeld) r.hud.notify('Stopped.', 1.2)
      } else {
        hold.elapsed += dt
        r.interactionTime = Math.max(r.interactionTime, 0.2)
        if (hold.noise && (hold.noiseTimer = (hold.noiseTimer ?? 0) - dt) <= 0) {
          hold.noiseTimer = 1.4
          r.emit({ kind: 'lockpick', position: r.player.body.position.clone(), radius: hold.noise }, true)
        }
        if (hold.elapsed >= hold.seconds) { this.hold = null; hold.done() }
      }
    }
    if (this.boosting) {
      r.player.movementLocked = true
      const run = this.run, me = r.coop?.link.id ?? 0
      // The host's run says the boost is over (the climber went, or it was never ours).
      if (run && run.boosts?.[this.boosting] !== me && run.boosts?.[this.boosting] !== undefined) this.releaseBoost()
      else if (run && run.boosts && run.boosts[this.boosting] === undefined && this.r.coop?.isGuest) this.releaseBoost()
    }
  }

  /** Host: the mission's rules this frame. `players`: every player's feet and whether they are up. */
  frame(dt: number, players: { id: number; feet: THREE.Vector3; up: boolean }[]) {
    const r = this.r, run = this.run, state = r.state
    if (!run || state.phase !== 'active' || dt <= 0) return
    // Objectives, and a checkpoint at each new stage while nobody is shooting.
    const fresh = updateObjectives(this.mission, this.map, run, {
      players: players.filter(player => player.up).map(player => player.feet.toArray()),
      hostages: state.hostages.map(hostage => ({ freed: hostage.status !== 'captive', loaded: hostage.status === 'loaded', position: hostage.position })),
      complete: false,
    })
    for (const objective of fresh) if (!objective.optional || objective.kind !== 'extract') this.announce(`Done: ${objective.text}.`)
    if (run.stage !== this.lastStage) {
      this.lastStage = run.stage
      const stage = currentStage(this.mission, run)
      if (run.stage < this.mission.stages.length) this.announce(`${stage.title}: ${stage.objectives.find(o => !o.optional)?.text ?? stage.objectives[0].text}`)
      if (state.alarm !== 'active' && !r.ai.enemies.some(enemy => enemy.state === 'combat')) r.saveCheckpoint()
    }
    // A fight that goes on reaches an alarm panel.
    const fighting = r.ai.enemies.filter(enemy => enemy.state === 'combat')
    this.combatFor = fighting.length ? this.combatFor + dt : Math.max(0, this.combatFor - dt * 2)
    if (state.alarm !== 'active' && this.combatFor >= RAISE_ALARM[run.difficulty]) {
      const at = fighting[0]?.lastKnown ?? fighting[0]?.position ?? r.player.body.position
      r.security.trigger(state, at.clone(), 'ALARM - the guards raised the alarm. Reinforcements are coming.')
      this.combatFor = 0
    }
    // Bodies the guards found.
    const found = new Set(r.ai.enemies.flatMap(enemy => enemy.noticedBodies))
    run.bodiesFound = found.size
    // Breach charges.
    for (const charge of [...this.plantedCharges]) {
      charge.fuse -= dt
      if (charge.fuse > 0) continue
      this.plantedCharges.splice(this.plantedCharges.indexOf(charge), 1)
      const door = this.doors.get(charge.door)
      if (!door) continue
      const at = door.getWorldPosition(new THREE.Vector3())
      this.unlock(charge.door, true)
      run.loudShots += 5
      r.emit({ kind: 'breach', position: at.clone().setY(at.y + 1), radius: NOISE.breach, text: 'Breach!' }, true)
      r.impacts.emit(at.clone().setY(at.y + 1.1), new THREE.Vector3(0, 0, 1), undefined, 'shotgun')
    }
    // The helicopter: the clock runs while someone holds the landing zone; the rotor noise draws guards in.
    const extraction = this.extraction
    if (run.called && !run.arrived) {
      const held = players.some(player => player.up && insideZone(extraction.zone, player.feet.toArray()))
      if (held) run.eta = Math.max(0, run.eta - dt)
      if ((this.lzNoise -= dt) <= 0) {
        this.lzNoise = 12
        r.ai.hear({ kind: 'rotor', position: new THREE.Vector3(...extraction.park), radius: 48 })
      }
      if (run.eta <= 0) { run.arrived = true; this.announce('The helicopter is down. Get everyone aboard.'); r.syncWorld() }
    }
    // Hostages bleeding out.
    run.hostages.forEach((vitals, index) => {
      if (bleedHostage(vitals, dt)) r.failMission(`${this.hostageName(index)} died. The rescue failed.`)
    })
    run.marks = run.marks?.filter(mark => mark.until > state.elapsed)
    // The alarm locks (and its end unlocks) the mission's alarm doors.
    if (state.alarm !== this.lastAlarm) {
      if (state.alarm === 'active' && this.lastAlarm !== 'active' && this.mission.alarmLocks.length) this.announce('The alarm has locked doors down. Silence it at a panel, or breach them.')
      this.lastAlarm = state.alarm
      r.syncWorld()
    }
  }

  private announce(text: string) {
    this.r.hud.notify(text, 5)
    if (this.r.coop?.hosting) this.r.coop.link.send({ t: 'note', x: text, s: 5 })
  }

  /** Host: a guard's round struck hostage `index`. */
  hurtHostage(index: number, amount: number) {
    const run = this.run
    const vitals = run?.hostages[index]
    if (!run || !vitals || !hurtHostage(vitals, amount)) return
    run.hostageDamage += amount
    if (vitals.down === 1) {
      run.hostageDowned++
      this.announce(`${this.hostageName(index)} is down! Get to him and hold F before he bleeds out.`)
    }
  }

  /** The guards' view of the freed hostages (they shoot at him too). */
  hostageSenses() {
    const run = this.run, r = this.r
    if (!run) return []
    return r.state.hostages.flatMap((hostage, index) => {
      const vitals = run.hostages[index]
      if (hostage.status !== 'following' || !vitals || vitals.down) return []
      const feet = new THREE.Vector3(...hostage.position)
      const [moving = 0, cowering = 0, speed = 0] = r.escort.motion[index] ?? []
      return [{ feet, eye: feet.clone().setY(feet.y + (cowering ? 1 : 1.5)), velocity: new THREE.Vector3(speed, 0, 0), alive: true, radioEnabled: true,
        id: HOSTAGE_SENSE_ID + index, exposure: { crouched: !!cowering || vitals.waiting, moving: !!moving, running: speed > 3 } }]
    })
  }

  /** The mission was won: record it, pay out, and keep the summary for the menu. */
  complete() {
    const run = this.run, state = this.r.state
    if (!run || this.recorded) return this.summary
    this.recorded = true
    const stats: RunStats = { time: state.elapsed, par: this.mission.par[run.difficulty], alarms: run.alarms, detections: state.detections,
      kills: state.kills, takedowns: run.takedowns, shots: state.shots, loudShots: run.loudShots,
      hostageDamage: run.hostageDamage, hostageDowned: run.hostageDowned, bodiesFound: run.bodiesFound }
    const stars = starsFor(stats)
    const result = this.store.complete(this.mission.id, run.difficulty, state.elapsed, stars)
    const reward = missionReward(this.mission.number, stars.filter(Boolean).length, run.difficulty)
    grantReward(reward.ink, `Rescue: ${this.mission.name}`)
    grantXp(reward.xp, `Rescue: ${this.mission.name}`)
    const awards = awardsFor({ mode: 'rescue', mission: this.mission.id, difficulty: run.difficulty, ...stats, rating: stealthRating(stats) })
    this.summary = { mission: this.mission, difficulty: run.difficulty, time: state.elapsed, stars, rating: stealthRating(stats), ink: reward.ink, xp: reward.xp,
      best: result.best, unlocked: result.unlocked, awards, stats, kills: state.kills,
      hostageHealth: Math.round(run.hostages.reduce((sum, vitals) => sum + vitals.health / vitals.max, 0) / Math.max(1, run.hostages.length) * 100) }
    return this.summary
  }

  /** The next mission after this one, if it is open. */
  next() {
    const index = MISSION_IDS.indexOf(this.mission.id)
    const id = MISSION_IDS[index + 1]
    return id && this.store.isUnlocked(id) ? id : null
  }

  /** Ammunition, taken on the spot (each crate refills you once a minute). */
  ammo(station: Station) {
    const r = this.r, last = this.ammoTaken.get(station.id)
    if (last !== undefined && r.state.elapsed - last < 60) { r.hud.notify('Empty for now. It refills in a minute.', 3); return false }
    const snapshot = r.weapons.snapshot()
    snapshot.slots = snapshot.slots.map(item => item ? { ...item, reserve: Math.max(item.reserve, fullReserve(item)) } : null)
    r.weapons.restore(snapshot)
    this.ammoTaken.set(station.id, r.state.elapsed)
    r.hud.notify('Ammunition topped up.', 3)
    return true
  }

  dispose() { this.props.root.removeFromParent() }
}

function fullReserve(item: WeaponItem) {
  return item.name === 'shotgun' ? 24 : item.name === 'pistol' ? 48 : item.name === 'sniper' ? 15 : 90
}

/** A campaign start: a suppressed pistol first, then the shotgun, rifle and SMG. */
export function campaignLoadout(): WeaponItem[] {
  return [
    { id: 'player-pistol', name: 'pistol', magazine: 12, reserve: 48, suppressed: true },
    { id: 'player-shotgun', name: 'shotgun', magazine: 6, reserve: 18 },
    { id: 'player-ak', name: 'ak', magazine: 30, reserve: 60 },
    { id: 'player-smg', name: 'smg', magazine: 24, reserve: 48 },
  ]
}

export type { MissionState }
