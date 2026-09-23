import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { BulletTrails } from '../bullet-trails'
import { WEAPON_RULES, fallDamage } from '../balance'
import { PACKED_NAMES, pierceOf } from '../loot'
import type { EnvironmentCamera } from '../../camera'
import type { FirstPersonController } from '../../player/controller'
import type { ActionTarget } from '../../player/actions'
import { setDoorOpen } from '../../world/doors'
import { FirstPersonWeapons } from '../weapons'
import { DeadInkAudio } from './audio'
import { DeadInkMusic } from './music'
import { MissionHUD } from '../hud'
import { MissionBlood } from '../hit-reactions'
import { MissionImpacts } from '../impacts'
import { PlayerHitReactions } from '../player-hit-reactions'
import { PlayerDeathSequence } from '../player-death'
import type { MenuCopy } from '../menu'
import type { MissionWorld, Shot, SoundEvent, WeaponItem, WeaponName, WeaponSnapshot } from '../types'
import { HitMarkers } from '../shared/hitmarkers'
import { DamageIndicator } from '../shared/damage-indicator'
import { Hotbar } from '../shared/hotbar'
import { seeded, weighted, type Random } from '../shared/random'
import { ZombieDirector, type Zombie, type ZombieGait, type ZombieTarget } from './director'
import { NavGraph, geometryHash, type NavData } from './navgraph'
import { pickSpawn } from './spawn'
import { findWallSpots, type WallSpot } from './placement'
import { newGame, returnSpawns, stepRounds, type RoundState } from './rounds'
import { BOSS, DIFFICULTY, MAX_ALIVE, PLAYER_HEALTH, POWERUPS, PRICES, STARTING_POINTS, STORM, ZOMBIE_DAMAGE_SCALE, isBossRound, isStormRound, movementMix, zombieHealth, type Difficulty, type PowerupKind } from './rules'
import { BOX_WEIGHTS, WALL_WEAPONS, ZOMBIE_SLOTS, freshWeapon, pointsForHit, rollBox, startingPistol, wallOffer, RESERVE_MAGAZINES } from './economy'
import { MysteryBox, WallBuy } from './stations'
import { ZombieHud } from './hud'
import { MuzzleSparks, RiseMarks, Shockwaves } from './effects'
import { GRENADE, Grenades } from './grenades'
import { INK_RAY, InkRayBolts } from './wonder'
import { REVIVE, SecondDraftRevive } from './revive'
import { DECOY, DollBuy, animateDoll, inkDoll } from './decoy'
import { THROW_RELEASE } from '../weapons'
import { BENCH_PLACE, BUILDS, BuildSite, PARTS, POWER_PLACE, PartPickup, PowerSwitch, SHIELD, fromBehind, type BuildId, type PartId } from './buildables'
import { ARMORY_PAGE, awardGame, deadInkHome, installCosmetics } from './cosmetics'
import { addDressing } from './dressing'
import { Explosion, MushroomCloud, createGrenadeModel } from './vfx'
import { POWERUP_INFO, PowerupDrops, PowerupDropper } from './powerups'
import { SEALED, ZoneGates, type ZoneGate } from './zones'
import { MACHINE_PLACES, PACK, PERKS, PERK_EFFECT, PERK_LIMIT, PackAPunch, PackedLook, PerkBottle, PerkMachine, type PerkKind } from './perks'

export type ZombieState = {
  phase: 'active' | 'dead' | 'complete'
  health: number; elapsed: number; kills: number
  points: number; round: number; headshots: number; knifeKills: number
}

/** Where you start: the mess yard, open ground in the connected heart of the compound. */
export const SPAWN_POINT: [number, number, number] = [-30, 0, -25]
/** Call of Duty's knife: 150 damage, which kills outright on the first rounds. */
export const KNIFE = { damage: 150, range: 2.1, cooldown: 0.55 } as const
/** Bodies lie a few seconds before they sink; spare actors let new zombies rise meanwhile. */
export const POOL_SIZE = MAX_ALIVE + 8
type TimedPowerup = 'instaKill' | 'doublePoints' | 'deathMachine'

/**
 * Where else the Mystery Box can turn up once the teddy bear takes it: a point in each of three other
 * zones (the nearest good wall to it). After a few spins at one spot, each spin has this chance of the bear.
 */
/** Pack-a-Punch prices: 5000, then 10000, then 20000 to upgrade the same gun again; null when maxed. */
function packCost(item: WeaponItem) {
  const level = item.packed ? item.packLevel ?? 1 : 0
  return level >= PACK.costs.length ? null : PACK.costs[level]
}
const BOX_PLACES: readonly [number, number, number][] = [[-60, 0, 45], [0, 0, 40], [145, 0, 5]]
const BOX_TEDDY_AFTER = 3, BOX_TEDDY_CHANCE = 0.2
/**
 * An upgraded gun's kills sometimes burst in ink that takes the zombies around with them: more often and
 * wider at each Pack-a-Punch level, so the high rounds have an answer to a packed crowd.
 */
const INK_BURST = [{ chance: 0.15, radius: 3 }, { chance: 0.3, radius: 3.8 }, { chance: 0.45, radius: 4.6 }] as const

/**
 * Wall guns past the start, indoors where there are walls to hang them on (the yards are open ground):
 * the Magnum in the southwest stores, and the LMG, the dearest wall gun, in the east annex, the last zone.
 */
const LATE_WALL_WEAPONS: { name: 'magnum' | 'lmg'; near: [number, number, number] }[] = [
  { name: 'magnum', near: [-57, 0.7, 64] },
  { name: 'lmg', near: [120, 0, 0] },
]

/** The Ink Doll wall is in the warehouse, the first zone past the start worth fighting for. */
const DOLL_PLACE: [number, number, number] = [26, 0.7, -10]

/** Where the three Easter-egg skulls hide: up the water tower, inside the southwest stores, in the annex. */
const SKULL_PLACES: readonly [number, number, number][] = [[10.9, 12.6, -30], [-62, 0.7, 62], [140, 0, -45]]

/** A little ink skull, the size of a fist, for the Easter egg. */
function inkSkull() {
  const g = new THREE.Group()
  g.name = 'Easter egg skull'
  g.userData.noCollision = true
  const ink = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false }), paper = new THREE.MeshBasicMaterial({ color: 0xfbfaf5, toneMapped: false })
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), paper)
  head.position.y = 0.11
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.08), paper)
  jaw.position.set(0, 0.04, 0.02)
  const outline = new THREE.Mesh(new THREE.SphereGeometry(0.097, 14, 10), new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false }))
  outline.position.y = 0.11
  g.add(head, jaw, outline)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), ink)
    eye.position.set(side * 0.035, 0.12, 0.075)
    g.add(eye)
  }
  return g
}

/** A zombie's body is this wide to a player walking into it (the Brute's scales with it). */
const ZOMBIE_BODY = 0.34, PLAYER_BODY = 0.3
/** The chosen difficulty is remembered in this browser; storage can be missing or blocked. */
const DIFFICULTY_KEY = 'dead-ink-difficulty'
function savedDifficulty(): Difficulty {
  try { const value = localStorage.getItem(DIFFICULTY_KEY); if (value && value in DIFFICULTY) return value as Difficulty } catch { /* storage unavailable */ }
  return 'normal'
}
/** The Death Machine never runs dry: its drum is topped up every frame while it lasts. */
const DEATH_MACHINE_ROUNDS = 999

export const DEAD_INK_COPY: MenuCopy = {
  title: 'Dead Ink', premise: 'Survive the rounds. Buy guns off the walls. Try your luck at the box.',
  begin: 'Start', resume: 'Resume', restart: 'New game',
  deadTitle: 'Game over.', completeTitle: 'Game over.', completePremise: '',
  objective: state => { const s = state as ZombieState; return s.round > 0 ? `Round ${s.round} · ${s.points} points` : 'Get ready' },
  deadPremise: state => {
    const s = state as ZombieState
    return `You survived ${s.round} round${s.round === 1 ? '' : 's'} · ${s.kills} kills · ${s.headshots} headshots`
  },
  restartWarning: 'This game ends and a new one starts at round 1.',
  missionPage: false,
  modeLink: { label: 'Hostage mission', href: './' },
  controls: [['Knife', 'V'], ['Grenade', 'Q or G'], ['Ink Doll', 'T'], ['Switch weapon', 'Wheel']],
  pages: [ARMORY_PAGE], home: deadInkHome,
}

/**
 * Dead Ink: Call of Duty style round-based zombies on the compound. Reuses the game's weapons, audio,
 * blood, impacts, death sequence and HUD; zombies come from ZombieDirector and find you over the baked
 * navigation graph. The hostage mission's runtime is not touched by this file.
 */
export class ZombiesRuntime {
  state: ZombieState = { phase: 'active', health: PLAYER_HEALTH.base, elapsed: 0, kills: 0, points: STARTING_POINTS, round: 0, headshots: 0, knifeKills: 0 }
  readonly weapons: FirstPersonWeapons
  readonly audio = new DeadInkAudio()
  readonly music = new DeadInkMusic(import.meta.env?.BASE_URL ?? '/')
  readonly blood: MissionBlood
  readonly impacts: MissionImpacts
  readonly bulletTrails: BulletTrails
  readonly playerHits = new PlayerHitReactions()
  readonly death = new PlayerDeathSequence()
  readonly hud: MissionHUD
  readonly hits: HitMarkers
  readonly indicator: DamageIndicator
  readonly hotbar: Hotbar
  readonly zombieHud: ZombieHud
  readonly riseMarks: RiseMarks
  readonly sparks: MuzzleSparks
  readonly shockwaves: Shockwaves
  readonly grenades: Grenades
  readonly bolts: InkRayBolts
  /** Frags carried, and seconds before another can be thrown. */
  grenadeCount: number = GRENADE.start
  private grenadeCooldown = 0
  /** The Brute, while it lives; and the seconds until it comes, on a boss round. */
  brute: Zombie | null = null
  private bruteTimer = -1
  readonly powerups: PowerupDrops
  private dropper: PowerupDropper
  /** Timed power-ups running now, and the seconds each has left. */
  timers: Partial<Record<TimedPowerup, number>> = {}
  /** Every point earned this game (spending does not lower it): what power-up drops count. */
  earned = 0
  /** Your own guns, put away while you hold the Death Machine. */
  private heldWeapons: WeaponSnapshot | null = null
  director: ZombieDirector | null = null
  graph: NavGraph | null = null
  rounds: RoundState = newGame()
  ready = false
  readonly initialized: Promise<void>
  deaths = 0
  invincible = false
  wallBuys: WallBuy[] = []
  box: MysteryBox | null = null
  /** Every place the box can stand; it starts at the first. */
  boxSpots: WallSpot[] = []
  zones: ZoneGates | null = null
  difficulty: Difficulty = savedDifficulty()
  perkMachines: PerkMachine[] = []
  pack: PackAPunch | null = null
  readonly perks = new Set<PerkKind>()
  private bottle: PerkBottle
  private packedLook = new PackedLook()
  /** A perk being drunk: it takes effect when the bottle is empty. */
  private pendingPerk: { kind: PerkKind; timer: number } | null = null
  /** Machines you are standing near, and when each last played its jingle. */
  private nearMachines = new Set<PerkMachine>()
  private jingleAt = new Map<PerkMachine, number>()
  /** Seconds of grace after Second Draft gets you back up. */
  private reviveGrace = 0
  private revive = new SecondDraftRevive()
  /** Ink Dolls: thrown, lying there banging their cymbals, and the wall that sells them. */
  private dolls: Grenades
  private dollCount = 0
  private dollCooldown = 0
  private dollClap = 0
  private dollBuy: DollBuy | null = null
  /**
   * Buildables and the power: parts lying about, what you carry, the build sites (Pack-a-Punch, shield
   * bench), the power switch, and the shield on your back.
   */
  power = false
  packBuilt = false
  private powerSwitch: PowerSwitch | null = null
  private sites = new Map<BuildId, BuildSite>()
  private parts: PartPickup[] = []
  private carried = new Set<PartId>()
  private shieldOnBench = false
  private shieldBackRound = 0
  private shield: { health: number } | null = null
  /** Throws waiting for the hand to let go, so the grenade leaves the screen as it leaves the hand. */
  private pendingThrows: { timer: number; launch: () => void }[] = []
  private uninstallCosmetics: () => void
  /** Grenade blasts and the Nuke's mushroom cloud; the junk, graffiti and hidden details about the map. */
  readonly explosions: Explosion
  readonly nukeCloud: MushroomCloud
  private undress: (() => void) | null = null
  /** An Ink Storm round is on; the last kill's place, for its Max Ammo. */
  private storm = false
  private lastKillAt: THREE.Vector3 | null = null
  private random: Random
  private spawn = new THREE.Vector3(...SPAWN_POINT)
  private abort = new AbortController()
  private active = false
  private aiming = false
  private stepTime = 0
  private interactionTime = 0
  private knifeCooldown = 0
  private lastHurt = -100
  private strandTimer = 0
  private safePosition = new THREE.Vector3()
  private hitFlash = 0
  private impactPoint: THREE.Vector3 | null = null
  private lastCaption = ''
  private lastCaptionAt = -100
  private wheelAmount = 0
  private wheelAt = 0
  private disposed = false
  private pushCapsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.3)
  /** Solid boxes for the things you should not walk through: the Mystery Box and the machines. */
  private solids = new Map<THREE.Object3D, THREE.Mesh>()
  private skulls: { object: THREE.Object3D; found: boolean }[] = []

  constructor(private scene: THREE.Scene, private camera: EnvironmentCamera, readonly player: FirstPersonController,
    readonly world: MissionWorld, private invalidate: () => void, seed = Math.floor(Math.random() * 2 ** 31)) {
    this.random = seeded(seed)
    player.missionMode = true
    player.canPlay = () => this.ready && this.state.phase === 'active'
    if (!camera.perspective.parent) scene.add(camera.perspective)
    this.weapons = new FirstPersonWeapons({ scene, camera: camera.perspective, world: player.world,
      aimDistance: (origin, direction, maxDistance) => this.director?.aimDistance(origin, direction, maxDistance) ?? maxDistance,
      emit: event => this.emit(event), onShot: shot => this.shot(shot) })
    this.uninstallCosmetics = installCosmetics(this.weapons)
    this.blood = new MissionBlood(scene, player.world, id => {
      const zombie = this.director?.zombies.find(z => z.id === id)
      if (!zombie || zombie.state !== 'dead' || zombie.actor.deathClip !== 'dieShotgun') return null
      return zombie.actor.rig.bones.chest.getWorldPosition(new THREE.Vector3())
    })
    this.impacts = new MissionImpacts(scene, player.world)
    this.riseMarks = new RiseMarks(scene)
    this.sparks = new MuzzleSparks(scene)
    this.shockwaves = new Shockwaves(scene)
    this.explosions = new Explosion(scene, player.world)
    this.nukeCloud = new MushroomCloud(scene)
    this.grenades = new Grenades(scene, player.world, createGrenadeModel)
    this.dolls = new Grenades(scene, player.world, inkDoll, { fuse: DECOY.lure + 1, upright: true })
    this.bolts = new InkRayBolts(scene, player.world, (origin, direction, max) => this.director?.aimDistance(origin, direction, max) ?? Infinity)
    this.powerups = new PowerupDrops(scene)
    this.bottle = new PerkBottle(camera.perspective)
    this.dropper = new PowerupDropper(this.random)
    this.bulletTrails = new BulletTrails(scene, 'Player bullet')
    player.lookSensitivity = () => this.weapons.lookSensitivity
    this.hud = new MissionHUD(world, {
      retry: () => { this.restart(); void this.audio.unlock(); this.player.requestControl() },
      restart: () => { this.restart(); void this.audio.unlock(); this.player.requestControl() },
      volume: value => { this.audio.setVolume(value); this.music.setVolume(value) },
      mute: value => { this.audio.setMuted(value); this.music.setMuted(value) } }, DEAD_INK_COPY)
    document.querySelector('#world')?.setAttribute('aria-label', 'Dead Ink, round-based zombies. Mouse to look, WASD move, left click fire, right click aim, mouse wheel switch weapon, V knife, F buy or use, R reload, Escape pause.')
    const hudRoot = document.querySelector<HTMLElement>('#mission-hud')!
    this.zombieHud = new ZombieHud(hudRoot)
    this.hits = new HitMarkers(hudRoot)
    this.indicator = new DamageIndicator(hudRoot)
    // One more cell than you start with, for Spare Nib's third gun; the hotbar hides cells you do not have.
    this.hotbar = new Hotbar(hudRoot, ZOMBIE_SLOTS + 1)
    this.addDifficultySetting()
    player.onPlayingChange = playing => { this.hud.setPlaying(playing); this.updateMusic() }
    player.actions.extraTargets = () => this.targets()
    player.actions.onAction = target => {
      this.weapons.cancel(); this.aiming = false; this.interactionTime = Math.max(this.interactionTime, 0.25)
      if (target.kind === 'door' || target.kind === 'ladder') this.emit({ kind: target.kind, position: target.point, radius: target.kind === 'door' ? 8 : 5 })
    }
    this.bindInput()
    this.initialized = this.initialize()
  }

  /** Difficulty on the Settings page, under the volume; it applies to every zombie from the next one on. */
  private addDifficultySetting() {
    const settings = document.querySelector('.mission-settings')
    if (!settings) return
    const label = document.createElement('label')
    label.className = 'dead-ink-difficulty'
    label.htmlFor = 'dead-ink-difficulty'
    label.textContent = 'Difficulty '
    const select = document.createElement('select')
    select.id = 'dead-ink-difficulty'
    for (const [value, info] of Object.entries(DIFFICULTY)) {
      const option = document.createElement('option')
      option.value = value; option.textContent = `${info.label}: ${info.blurb}`
      select.append(option)
    }
    select.value = this.difficulty
    select.addEventListener('change', () => {
      this.difficulty = select.value as Difficulty
      try { localStorage.setItem(DIFFICULTY_KEY, this.difficulty) } catch { /* storage unavailable */ }
    }, { signal: this.abort.signal })
    label.append(select)
    settings.append(label)
    this.abort.signal.addEventListener('abort', () => label.remove())
  }

  private async initialize() {
    try {
      // Every door open and unlocked, exactly as the navigation graph was baked, except the sealed exits.
      const doors: THREE.Group[] = []
      this.scene.traverse(object => { if (object.userData.kind === 'door') doors.push(object as THREE.Group) })
      for (const door of doors) { door.userData.missionLocked = false; setDoorOpen(door, true, true) }
      // Fingerprint the map as it was baked, every door open; then shut the sealed exits.
      const hash = geometryHash(this.scene)
      for (const door of doors) if (SEALED.some(seal => seal.door === door.name)) { door.userData.missionLocked = true; setDoorOpen(door, false, true) }
      this.player.world.refresh()
      const response = await fetch(`${import.meta.env?.BASE_URL ?? '/'}nav/compound.json`)
      if (!response.ok) throw new Error(`navigation data: HTTP ${response.status}`)
      const graph = NavGraph.fromData(await response.json() as NavData)
      if (this.disposed) return
      if (graph.geometry && graph.geometry !== hash) console.warn(`Dead Ink: navigation graph was baked for geometry ${graph.geometry}, map is ${hash}. Rebake with scripts/build-navgraph.ts.`)
      this.graph = graph
      this.director = new ZombieDirector({ scene: this.scene, world: this.player.world, doors: doors.filter(door => !door.userData.missionLocked), graph, emit: event => this.emit(event),
        damagePlayer: (id, amount, source) => id === 'p1' && this.damage(Math.round(amount * DIFFICULTY[this.difficulty].damage), 'zombie', source),
        onHit: hit => { this.impactPoint = hit.point.clone(); this.blood.emitHit(hit); this.audio.confirmHit(hit) },
        onRise: position => { this.riseMarks.emit(position); this.emit({ kind: 'zombie-rise', position, radius: 30 }) },
        onSlam: (position, radius) => { this.shockwaves.emit(position, radius); this.riseMarks.emit(position) } })
      await this.director.init(POOL_SIZE)
      if (this.disposed) return
      // Every zone but the first shut behind its gate, before anything is placed.
      this.zones = new ZoneGates(this.scene, this.player.world, graph)
      this.zones.closeAll()
      this.director.navigation.clear()
      this.player.world.warm()
      const floor = this.player.world.floor(this.spawn.clone().setY(0.6), 1, 1.5, 0.28)
      if (Number.isFinite(floor)) this.spawn.y = floor
      this.placeStations()
      // Junk, graffiti and hidden details, kept off every station, the doll wall and the skulls.
      const keepClear = [...this.wallBuys.map(b => b.spot.wall), ...this.boxSpots.map(s => s.wall),
        ...this.perkMachines.map(m => m.spot.wall), ...(this.pack ? [this.pack.spot.wall] : []),
        ...(this.dollBuy ? [this.dollBuy.spot.wall] : []), ...this.skulls.map(s => s.object.position),
        ...(this.powerSwitch ? [this.powerSwitch.spot.wall] : []), ...[...this.sites.values()].map(site => site.spot.wall)]
      try { this.undress = addDressing(this.scene, this.player.world, seeded(0xDEAD1), keepClear) }
      catch (error) { console.warn('Dead Ink: dressing failed', error) }
      this.startGame()
      this.ready = true; this.hud.ready(); this.invalidate()
    } catch (error) {
      if (this.disposed) return
      console.error('Dead Ink failed to load', error)
      this.hud.error(`Could not load Dead Ink: ${error instanceof Error ? error.message : String(error)}. Reload this page to retry.`)
      this.invalidate()
    }
  }

  /** Wall guns and the Mystery Box on real walls around the spawn, reachable on foot from it. */
  private placeStations() {
    const graph = this.graph!
    graph.flow([this.spawn])
    const spots = findWallSpots(graph, this.player.world, this.random, { count: WALL_WEAPONS.length + 1, near: 6, far: 70, spacing: 9 })
    // The box sits in the middle of the ring: not the first thing you see, not far away either.
    const boxIndex = Math.min(2, spots.length - 1)
    spots.forEach((spot, i) => {
      if (i === boxIndex) { this.box = new MysteryBox(spot); this.scene.add(this.box.root); return }
      const offer = WALL_WEAPONS[this.wallBuys.length]
      if (!offer) return
      const buy = new WallBuy(spot, offer.name, offer.price)
      this.wallBuys.push(buy)
      this.scene.add(buy.root)
    })
    const taken = spots.map(spot => spot.stand)
    for (const [kind, [x, y, z]] of MACHINE_PLACES) {
      graph.flow([new THREE.Vector3(x, y, z)])
      const [spot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 35, spacing: 7, avoid: taken })
      if (!spot) { console.warn(`Dead Ink: no wall for ${kind} near ${x}, ${z}`); continue }
      taken.push(spot.stand)
      if (kind === 'pack') { this.pack = new PackAPunch(spot); this.scene.add(this.pack.root); continue }
      const machine = new PerkMachine(kind, spot)
      this.perkMachines.push(machine)
      this.scene.add(machine.root)
    }
    this.placeSkulls()
    graph.flow([new THREE.Vector3(...DOLL_PLACE)])
    const [dollSpot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 30, spacing: 7, avoid: taken })
    if (dollSpot) { this.dollBuy = new DollBuy(dollSpot); taken.push(dollSpot.stand); this.scene.add(this.dollBuy.root) }
    // The better guns are further in: each on a wall inside the zone you pay to reach.
    taken.push(...this.skulls.map(s => s.object.position))
    for (const { name, near } of LATE_WALL_WEAPONS) {
      graph.flow([new THREE.Vector3(...near)])
      const [spot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 30, spacing: 7, avoid: taken })
      if (!spot) { console.warn(`Dead Ink: no wall for the ${name} near ${near[0]}, ${near[2]}`); continue }
      taken.push(spot.stand)
      const buy = new WallBuy(spot, name, PRICES.wall[name])
      this.wallBuys.push(buy)
      this.scene.add(buy.root)
    }
    // The power switch in the warehouse, the shield bench by the start, the Pack-a-Punch's build site.
    graph.flow([new THREE.Vector3(...POWER_PLACE)])
    const [powerSpot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 30, spacing: 7, avoid: taken })
    if (powerSpot) { taken.push(powerSpot.stand); this.powerSwitch = new PowerSwitch(powerSpot); this.scene.add(this.powerSwitch.root) }
    else console.warn('Dead Ink: no wall for the power switch')
    graph.flow([new THREE.Vector3(...BENCH_PLACE)])
    const [benchSpot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 30, spacing: 7, avoid: taken })
    if (benchSpot) { taken.push(benchSpot.stand); const bench = new BuildSite('shield', benchSpot, true); this.sites.set('shield', bench); this.scene.add(bench.root) }
    else console.warn('Dead Ink: no wall for the shield bench')
    if (this.pack) { const site = new BuildSite('pack', this.pack.spot, false); this.sites.set('pack', site); this.scene.add(site.root) }
    if (this.box) this.boxSpots = [this.box.spot]
    for (const machine of this.perkMachines) this.makeSolid(machine.root, [1.05, 2.05, 0.7], [0, 1.025, 0])
    for (const [x, y, z] of BOX_PLACES) {
      graph.flow([new THREE.Vector3(x, y, z)])
      const [spot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 35, spacing: 7, avoid: taken })
      if (!spot) continue
      taken.push(spot.stand)
      this.boxSpots.push(spot)
    }
  }

  private startGame() {
    this.state = { phase: 'active', health: PLAYER_HEALTH.base, elapsed: 0, kills: 0, points: STARTING_POINTS, round: 0, headshots: 0, knifeKills: 0 }
    this.rounds = newGame()
    this.director?.clear()
    this.zones?.closeAll()
    this.director?.navigation.clear()
    if (this.box && this.boxSpots[0]) { this.box.place(this.boxSpots[0]); this.makeSolid(this.box.root, [1.44, 0.66, 0.64], [0, 0.33, 0]) }
    this.box?.close()
    this.powerups.clear(); this.timers = {}; this.earned = 0; this.heldWeapons = null
    this.perks.clear(); this.pendingPerk = null; this.reviveGrace = 0; this.applyPerks(); this.zombieHud.perks([])
    this.resetBuildables()
    this.revive.reset(); this.player.movementLocked = false
    this.setStorm(false)
    this.brute = null; this.bruteTimer = -1
    for (const skull of this.skulls) { skull.found = false; skull.object.userData.found = false }
    this.music.stopStings()
    this.grenades.clear(); this.bolts.clear(); this.grenadeCount = GRENADE.start; this.grenadeCooldown = 0
    this.dolls.clear(); this.dollCount = 0; this.dollCooldown = 0; this.pendingThrows = []
    if (this.pack && this.pack.state !== 'idle') this.pack.take()
    this.dropper = new PowerupDropper(this.random)
    this.weapons.restore({ slots: [startingPistol(), null], selected: 0, pickups: [], nextId: 1 })
    this.player.actions.reset()
    this.player.body.teleport(this.spawn.clone())
    this.player.world.refresh()
    this.player.body.update(1 / 60, new THREE.Vector3(), false)
    this.player.actions.syncCamera(this.camera.perspective)
    const look = this.wallBuys[0]?.point ?? this.spawn.clone().add(new THREE.Vector3(0, 1.7, -5))
    this.camera.perspective.lookAt(look.x, this.spawn.y + 1.7, look.z)
    this.safePosition.copy(this.player.body.position)
    this.lastHurt = -100; this.knifeCooldown = 0; this.strandTimer = 0
  }

  restart() {
    this.death.reset(); this.weapons.resetDeath(); this.playerHits.clear()
    this.player.pause(); this.cancelInput(); this.audio.reset(); this.player.actions.reset()
    this.player.movementLocked = false
    this.blood.restore(undefined)
    this.stepTime = 0; this.interactionTime = 0; this.hitFlash = 0; this.lastCaptionAt = -100; this.wheelAmount = 0
    this.bulletTrails.clear(); this.impacts.clear(); this.riseMarks.clear(); this.sparks.clear(); this.shockwaves.clear(); this.explosions.clear(); this.nukeCloud.clear(); this.powerups.clear(); this.hits.clear(); this.indicator.clear(); this.zombieHud.clear(); this.hud.reset()
    this.startGame()
    this.invalidate()
  }

  retry() { this.restart() }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const options = { signal: this.abort.signal }
    document.querySelector('#walk-start')!.addEventListener('click', () => { void this.audio.unlock() }, options)
    // Music may only start after the first click or key press on the page.
    // Capturing, so a menu button that stops the event still counts as the first interaction.
    for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, () => this.music.unlock(), { ...options, capture: true })
    document.addEventListener('visibilitychange', () => this.music.setHidden(document.hidden), options)
    window.addEventListener('keydown', this.keyDown, options)
    document.querySelector('#world')!.addEventListener('wheel', event => {
      const wheel = event as WheelEvent
      if (!this.isActive() || wheel.ctrlKey || wheel.metaKey || wheel.altKey) return
      wheel.preventDefault()
      // Scoped with a sniper, the wheel zooms. Otherwise it switches weapons, once per notch.
      if (this.aiming && this.weapons.current?.name === 'sniper') {
        if (this.weapons.adjustScopeZoom(-Math.sign(wheel.deltaY))) this.invalidate()
        return
      }
      if (this.timers.deathMachine) return
      const now = performance.now()
      if (now - this.wheelAt > 400) this.wheelAmount = 0
      this.wheelAmount += wheel.deltaY * (wheel.deltaMode === 1 ? 40 : wheel.deltaMode === 2 ? 400 : 1)
      if (Math.abs(this.wheelAmount) < 50 || now - this.wheelAt < 150) return
      if (this.weapons.cycle(this.wheelAmount > 0 ? 1 : -1) && !this.weapons.canAim) this.aiming = false
      this.wheelAmount = 0; this.wheelAt = now
      this.invalidate()
    }, { ...options, passive: false })
    window.addEventListener('mousedown', event => {
      if (!this.isActive() || event.target !== document.querySelector('#world')) return
      void this.audio.unlock()
      if (event.button === 0) this.weapons.trigger(true)
      if (event.button === 2) {
        this.aiming = this.weapons.canAim && !this.aiming
        if (this.weapons.current && !this.weapons.canAim) this.hud.notify("You can't aim with this weapon.", 2, true)
      }
      this.invalidate()
    }, options)
    window.addEventListener('mouseup', event => { if (event.button === 0) this.weapons.trigger(false) }, options)
    window.addEventListener('blur', () => this.cancelInput(), options)
    document.addEventListener('pointerlockchange', () => { if (!this.player.playing) this.cancelInput() }, options)
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancelInput() }, options)
  }

  private isActive() { return this.ready && this.state.phase === 'active' && this.player.enabled && this.player.playing && !this.player.immersive }
  private cancelInput() { this.aiming = false; this.weapons.cancel() }

  private keyDown = (event: KeyboardEvent) => {
    const zoomKey = event.code === 'KeyQ' || event.code === 'KeyE'
    if (event.ctrlKey || event.metaKey || event.altKey || (event.repeat && !zoomKey) || !this.player.enabled || this.player.immersive) return
    if (event.target instanceof HTMLElement && event.target.closest('button,input,select,textarea,summary,[contenteditable="true"]')) return
    if (!this.isActive()) return
    // Q zooms a scoped sniper; otherwise it throws a grenade (so does G).
    const scoped = this.aiming && this.weapons.current?.name === 'sniper'
    if (event.code === 'KeyT') {
      if (!event.repeat && this.throwDoll()) { event.preventDefault(); this.invalidate() }
      return
    }
    if ((event.code === 'KeyQ' && !scoped) || event.code === 'KeyG') {
      if (!event.repeat && this.throwGrenade()) { event.preventDefault(); this.invalidate() }
      return
    }
    if (zoomKey) {
      if (!this.aiming || !this.weapons.adjustScopeZoom(event.code === 'KeyE' ? 1 : -1)) return
      event.preventDefault(); this.invalidate(); return
    }
    if (this.timers.deathMachine && ['KeyR', 'Digit1', 'Digit2', 'Digit3'].includes(event.code)) { event.preventDefault(); return }
    switch (event.code) {
      case 'KeyR': if (this.weapons.reload()) this.aiming = false; break
      case 'Digit1': this.weapons.switchSlot(0); break
      case 'Digit2': this.weapons.switchSlot(1); break
      case 'Digit3': this.weapons.switchSlot(2); break
      case 'KeyV': this.knife(); break
      default: return
    }
    if (!this.weapons.canAim) this.aiming = false
    event.preventDefault(); this.invalidate()
  }

  // ---------------------------------------------------------------- spending

  private targets(): ActionTarget[] {
    if (!this.isActive()) return []
    const targets: ActionTarget[] = []
    if (this.dollBuy) {
      const buy = this.dollBuy, full = this.dollCount >= DECOY.carry
      targets.push({ object: buy.root, point: buy.point, kind: 'mission', descending: false,
        label: full ? 'Ink Dolls · full' : `Buy ${DECOY.carry} Ink Dolls · ${DECOY.price}${this.state.points >= DECOY.price ? '' : ` · need ${DECOY.price - this.state.points} more`}`,
        use: () => this.useDollWall(buy) })
    }
    for (const buy of this.wallBuys) {
      const offer = wallOffer(buy.weapon, buy.price, this.weapons.slots)
      targets.push({ object: buy.root, point: buy.point, kind: 'mission', descending: false,
        label: offer.kind === 'full' ? offer.label : this.state.points >= offer.cost ? offer.label : `${offer.label} · need ${offer.cost - this.state.points} more`,
        use: () => this.useWall(buy) })
    }
    const eye = this.camera.perspective.position
    for (const gate of this.zones?.gates ?? []) {
      if (gate.state !== 'closed') continue
      const point = this.zones!.nearestPoint(gate, eye), cost = gate.spec.cost
      if (point.distanceTo(eye) > 4) continue
      targets.push({ object: gate.closed, point, kind: 'mission', descending: false,
        label: `Open the gate to ${gate.spec.zone} · ${cost}${this.state.points >= cost ? '' : ` · need ${cost - this.state.points} more`}`,
        use: () => this.useGate(gate) })
    }
    for (const machine of this.perkMachines) {
      const perk = PERKS[machine.kind]
      const label = !this.power ? `${perk.name} · no power` : this.perks.has(machine.kind) ? `${perk.name} · yours`
        : this.perks.size >= PERK_LIMIT ? `${perk.name} · you can hold ${PERK_LIMIT} perks`
        : `Drink ${perk.name} · ${perk.cost}${this.state.points >= perk.cost ? '' : ` · need ${perk.cost - this.state.points} more`} · ${perk.blurb}`
      targets.push({ object: machine.root, point: machine.point, kind: 'mission', descending: false, label, use: () => this.buyPerk(machine) })
    }
    const pack = this.pack, held = this.weapons.current
    if (pack && this.packBuilt && pack.state !== 'working') {
      const label = !this.power && pack.state === 'idle' ? 'Pack-a-Punch · no power' : pack.state === 'ready' && pack.held ? `Take the ${PACKED_NAMES[pack.held.name]}`
        : !held || held.special ? 'Pack-a-Punch · hold a gun to upgrade it'
        : packCost(held) === null ? 'Pack-a-Punch · fully upgraded'
        : `Pack-a-Punch · ${held.packed ? 'upgrade again' : 'upgrade'} your ${this.weapons.label} · ${packCost(held)}${this.state.points >= packCost(held)! ? '' : ` · need ${packCost(held)! - this.state.points} more`}`
      targets.push({ object: pack.root, point: pack.point, kind: 'mission', descending: false, label, use: () => this.usePack(pack) })
    }
    for (const part of this.parts) {
      if (part.point.distanceTo(eye) > 3) continue
      targets.push({ object: part.root, point: part.point, kind: 'mission', descending: false, label: `Pick up the ${PARTS[part.id].label}`, use: () => this.pickPart(part) })
    }
    const power = this.powerSwitch
    if (power && power.state !== 'on') {
      const label = power.state === 'ready' ? 'Turn on the power'
        : this.carried.has('lever') ? 'Put the lever back on the power switch' : 'The power switch has lost its lever'
      targets.push({ object: power.root, point: power.point, kind: 'mission', descending: false, label, use: () => this.usePower(power) })
    }
    for (const site of this.sites.values()) {
      if (site.build === 'pack' && this.packBuilt) continue
      const name = BUILDS[site.build].label, have = site.missing().filter(id => this.carried.has(id))
      let label: string
      if (site.complete) {
        if (site.build !== 'shield' || this.shield || !this.shieldOnBench) continue
        label = 'Take the ink shield'
      } else if (have.length) label = `Build the ${name} · add the ${have.map(id => PARTS[id].label).join(', ')}`
      else label = `${name[0].toUpperCase()}${name.slice(1)} · missing the ${site.missing().map(id => PARTS[id].label).join(', ')}`
      targets.push({ object: site.root, point: site.point, kind: 'mission', descending: false, label, use: () => this.useSite(site) })
    }
    for (const skull of this.skulls) {
      if (skull.found || skull.object.position.distanceTo(eye) > 2.6) continue
      targets.push({ object: skull.object, point: skull.object.position.clone().setY(skull.object.position.y + 0.12), kind: 'mission', descending: false, label: '...', use: () => this.touchSkull(skull) })
    }
    const box = this.box
    if (box && box.state !== 'spinning' && box.state !== 'leaving') {
      const label = box.state === 'offering' && box.offer ? box.offer.special ? 'Take the Ink Ray' : `Take ${box.offer.rarity === 'common' ? '' : `${box.offer.rarity[0].toUpperCase()}${box.offer.rarity.slice(1)} `}${WEAPON_RULES[box.offer.name].label}`
        : this.state.points >= PRICES.box ? `Mystery Box · ${PRICES.box}` : `Mystery Box · ${PRICES.box} · need ${PRICES.box - this.state.points} more`
      targets.push({ object: box.root, point: box.point, kind: 'mission', descending: false, label, use: () => this.useBox(box) })
    }
    return targets
  }

  /** Same reach and line-of-sight rule as the mission's panels. */
  private canReach(point: THREE.Vector3, object: THREE.Object3D) {
    const eye = this.camera.perspective.position
    return eye.distanceTo(point) <= 2.65 && this.player.world.visible(eye, point, object)
  }

  private spend(cost: number) {
    if (this.state.points < cost) { this.hud.notify('Not enough points.', 1.6, true); return false }
    this.state.points -= cost
    this.zombieHud.spend(cost)
    return true
  }

  /** A new game: the power is off, the parts are scattered again, nothing is built. */
  private resetBuildables() {
    this.setPower(false, false)
    this.powerSwitch?.reset()
    for (const site of this.sites.values()) site.reset()
    this.packBuilt = false
    if (this.pack) { this.pack.root.visible = false; this.removeSolid(this.pack.root) }
    this.shield = null; this.shieldOnBench = false; this.shieldBackRound = 0
    this.carried.clear()
    for (const part of this.parts) part.dispose()
    this.parts = []
    const graph = this.graph
    if (graph) for (const id of Object.keys(PARTS) as PartId[]) {
      const places = PARTS[id].places
      const [x, y, z] = places[Math.floor(this.random() * places.length) % places.length]
      const node = graph.nearest(new THREE.Vector3(x, y, z), 4)
      if (node < 0) { console.warn(`Dead Ink: nowhere to put the ${PARTS[id].label}`); continue }
      const part = new PartPickup(id, graph.point(node))
      this.parts.push(part)
      this.scene.add(part.root)
    }
    this.zombieHud.parts([])
    this.zombieHud.shield(null)
  }

  /** The power across the compound: perk machines light up (stuttering on), the Pack-a-Punch runs. */
  setPower(on: boolean, flicker = true) {
    this.power = on
    for (const machine of this.perkMachines) machine.setPowered(on, flicker)
  }

  private pickPart(part: PartPickup) {
    if (!this.isActive() || part.point.distanceTo(this.camera.perspective.position) > 3) return false
    this.carried.add(part.id)
    this.parts.splice(this.parts.indexOf(part), 1)
    part.dispose()
    this.hud.notify(`You found the ${PARTS[part.id].label}.`, 2.5)
    this.emit({ kind: 'pickup', position: this.player.body.position.clone(), radius: 3 })
    this.zombieHud.parts([...this.carried].map(id => PARTS[id].label))
    this.invalidate()
    return true
  }

  private usePower(power: PowerSwitch) {
    if (!this.isActive() || !this.canReach(power.point, power.root)) return false
    if (power.state === 'broken') {
      if (!this.carried.has('lever')) { this.hud.notify('The lever is missing. It must be somewhere about the compound.', 3, true); return false }
      this.carried.delete('lever')
      power.repair()
      this.emit({ kind: 'pack-work', position: power.point.clone(), radius: 12 })
      this.zombieHud.parts([...this.carried].map(id => PARTS[id].label))
      this.hud.notify('The lever is back on. Pull it.', 2.5)
      return true
    }
    if (!power.turnOn()) return false
    this.setPower(true)
    this.zombieHud.announce('Power on', 3, 'powerup')
    this.emit({ kind: 'boss-slam', position: power.point.clone(), radius: 200 })
    this.invalidate()
    return true
  }

  /** At a build site: put in every part you carry for it; the last one finishes the build. */
  private useSite(site: BuildSite) {
    if (!this.isActive() || !this.canReach(site.point, site.root)) return false
    if (site.complete) {
      if (site.build !== 'shield' || this.shield || !this.shieldOnBench) return false
      this.shield = { health: SHIELD.health }
      this.shieldOnBench = false
      this.hud.notify('The shield is on your back: it takes hits from behind.', 3)
      this.emit({ kind: 'pickup', position: this.player.body.position.clone(), radius: 3 })
      this.zombieHud.shield(1)
      return true
    }
    let added = 0
    for (const id of [...this.carried]) if (PARTS[id].build === site.build && site.place(id)) { this.carried.delete(id); added++ }
    if (!added) { this.hud.notify(`Still missing the ${site.missing().map(id => PARTS[id].label).join(', ')}.`, 2.5, true); return false }
    this.emit({ kind: 'pack-work', position: site.point.clone(), radius: 14 })
    this.zombieHud.parts([...this.carried].map(id => PARTS[id].label))
    if (site.complete) this.completeBuild(site.build)
    this.invalidate()
    return true
  }

  /** A build finished (also the checks' way to skip the hunt). */
  completeBuild(build: BuildId) {
    const site = this.sites.get(build)
    if (site) for (const id of BUILDS[build].parts) site.place(id)
    if (build === 'pack' && this.pack && !this.packBuilt) {
      this.packBuilt = true
      site?.hideParts()
      this.pack.root.visible = true
      this.makeSolid(this.pack.root, [2.05, 1.1, 1.1], [0, 0.55, 0])
      this.shockwaves.emit(this.pack.root.position.clone(), 3)
      this.zombieHud.announce('Pack-a-Punch built', 3, 'powerup')
      this.emit({ kind: 'pack-ready', position: this.pack.point.clone(), radius: 40 })
    }
    if (build === 'shield') {
      this.shieldOnBench = !this.shield
      this.zombieHud.announce('Ink shield built', 3, 'powerup')
      this.emit({ kind: 'pack-ready', position: (site?.point ?? this.player.body.position).clone(), radius: 20 })
    }
    if (build === 'power' && this.powerSwitch) { this.powerSwitch.repair(); this.powerSwitch.turnOn(); this.setPower(true) }
  }

  private removeSolid(owner: THREE.Object3D) {
    const old = this.solids.get(owner)
    if (!old) return
    this.player.world.removeObject(old)
    this.solids.delete(owner)
  }

  private useDollWall(buy: DollBuy) {
    if (!this.isActive() || !this.canReach(buy.point, buy.root) || this.dollCount >= DECOY.carry || !this.spend(DECOY.price)) return false
    this.dollCount = DECOY.carry
    this.hud.notify('Ink Dolls: throw one with T and every zombie goes for it.', 3)
    this.emit({ kind: 'pickup', position: this.player.body.position.clone(), radius: 2 })
    this.invalidate()
    return true
  }

  /** Throw an Ink Doll: it lands on its feet and bangs its cymbals until it goes off. */
  throwDoll() {
    if (!this.isActive() || this.revive.down || this.dollCount <= 0 || this.dollCooldown > 0) return false
    this.dollCount--
    this.dollCooldown = DECOY.cooldown
    const doll = inkDoll()
    doll.scale.setScalar(0.8)
    this.weapons.throwItem(doll)
    this.throwLater(this.dolls)
    return true
  }

  /** Launch from the camera when the hand lets go, the way you are looking then. */
  private throwLater(into: Grenades) {
    this.pendingThrows.push({ timer: THROW_RELEASE, launch: () => {
      const camera = this.camera.perspective
      const forward = camera.getWorldDirection(new THREE.Vector3())
      const origin = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(forward, 0.45).add(new THREE.Vector3(0, -0.05, 0))
      into.throw(origin, forward, this.player.body.velocity.clone().multiplyScalar(0.5))
      this.emit({ kind: 'grenade-throw', position: origin, radius: 6 })
    } })
  }

  /** The doll goes off among the crowd it drew: three times a zombie's health, so nothing near it lives. */
  private dollBlast(at: THREE.Vector3) {
    const director = this.director
    if (!director) return
    const damage = zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * 3
    for (const hit of director.blast(at, DECOY.radius, damage)) {
      this.award(pointsForHit({ lethal: hit.lethal, zone: 'torso' }))
      this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
      if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
    }
    this.explosions.emit(at, DECOY.radius)
    this.emit({ kind: 'grenade-blast', position: at.clone(), radius: 120 })
  }

  private useWall(buy: WallBuy) {
    if (!this.isActive() || !this.canReach(buy.point, buy.root)) return false
    if (this.timers.deathMachine) { this.hud.notify('Not while you hold the Death Machine.', 2, true); return false }
    const offer = wallOffer(buy.weapon, buy.price, this.weapons.slots)
    if (offer.kind === 'full' || !this.spend(offer.cost)) return false
    if (offer.kind === 'buy') this.weapons.give(freshWeapon(`wall-${buy.weapon}-${Math.floor(this.state.elapsed * 1000)}`, buy.weapon))
    else {
      const capacity = WEAPON_RULES[buy.weapon].capacity
      this.weapons.refill(buy.weapon, capacity, capacity * RESERVE_MAGAZINES)
      this.hud.notify(`${WEAPON_RULES[buy.weapon].label} ammo refilled.`, 2)
    }
    this.emit({ kind: 'pickup', position: this.player.body.position.clone(), radius: 2 })
    this.invalidate()
    return true
  }

  private maxHealth() { return this.perks.has('thickInk') ? PLAYER_HEALTH.thickInk : PLAYER_HEALTH.base }

  private applyPerks() {
    this.weapons.reloadScale = this.perks.has('quickDip') ? PERK_EFFECT.reloadScale : 1
    this.weapons.fireScale = this.perks.has('doubleLine') ? PERK_EFFECT.fireScale : 1
  }

  private buyPerk(machine: PerkMachine) {
    const perk = PERKS[machine.kind]
    if (!this.isActive() || !this.canReach(machine.point, machine.root) || this.pendingPerk || this.timers.deathMachine) return false
    if (!this.power) { this.hud.notify('No power. Find the power switch.', 2.5, true); return false }
    if (this.perks.has(machine.kind) || this.perks.size >= PERK_LIMIT || !this.spend(perk.cost)) return false
    // Drink it: the gun goes down, the bottle comes up, the perk works once it is empty.
    this.weapons.cancel(); this.aiming = false
    this.bottle.drink(machine.kind)
    this.emit({ kind: 'perk-jingle', position: machine.point.clone(), radius: 14, voice: machine.kind })
    this.interactionTime = PerkBottle.SECONDS
    this.pendingPerk = { kind: machine.kind, timer: PerkBottle.SECONDS * 0.8 }
    this.emit({ kind: 'perk-drink', position: this.player.body.position.clone(), radius: 5 })
    this.invalidate()
    return true
  }

  private grantPerk(kind: PerkKind) {
    this.perks.add(kind)
    this.applyPerks()
    if (kind === 'spareNib') {
      const snapshot = this.heldWeapons ?? this.weapons.snapshot()
      if (snapshot.slots.length < 3) snapshot.slots.push(null)
      if (!this.heldWeapons) this.weapons.restore(snapshot)
    }
    this.zombieHud.perks([...this.perks])
    this.zombieHud.announce(PERKS[kind].name, 2, PERKS[kind].css)
  }

  /** Going down costs every perk, and Spare Nib's third gun with it, as in Call of Duty. */
  private losePerks() {
    if (this.perks.has('spareNib')) {
      const snapshot = this.heldWeapons ?? this.weapons.snapshot()
      if (snapshot.slots.length > 2) {
        snapshot.slots.length = 2
        if (snapshot.selected >= 2) snapshot.selected = 0
        if (!this.heldWeapons) this.weapons.restore(snapshot)
      }
    }
    this.perks.clear()
    this.applyPerks()
    this.zombieHud.perks([])
  }

  /** Second Draft: instead of dying, get back up with your perks gone and the zombies around you knocked back. */
  private selfRevive() {
    this.losePerks()
    this.state.health = PLAYER_HEALTH.base
    // Untouchable while down and for a moment after getting up.
    this.reviveGrace = REVIVE.seconds + PERK_EFFECT.reviveGrace
    this.director?.shove(this.player.body.position, PERK_EFFECT.reviveShove, 1.5)
    this.revive.start()
    this.weapons.cancel(); this.cancelInput()
    this.player.movementLocked = true
    this.player.body.velocity.set(0, 0, 0)
    this.audio.play({ kind: 'player-fall' })
    if (!this.hud.reducedMotion) this.zombieHud.revive()
    this.zombieHud.announce('Second Draft!', 2.4, PERKS.secondDraft.css)
  }

  /** Put the gun in hand into the Pack-a-Punch; or take the upgraded one back out. */
  private usePack(pack: PackAPunch) {
    if (!this.isActive() || !this.packBuilt || !this.canReach(pack.point, pack.root)) return false
    if (!this.power && pack.state === 'idle') { this.hud.notify('No power. Find the power switch.', 2.5, true); return false }
    if (pack.state === 'ready') {
      const item = pack.take()
      if (!item) return false
      this.weapons.give(item)
      this.emit({ kind: 'pickup', position: this.player.body.position.clone(), radius: 2 })
      this.invalidate()
      return true
    }
    const current = this.weapons.current
    const cost = current ? packCost(current) : null
    if (pack.state !== 'idle' || !current || current.special || cost === null || this.timers.deathMachine || !this.spend(cost)) return false
    // The gun goes in: your hands move to your other gun, or stay empty, until it comes out.
    const snapshot = this.weapons.snapshot()
    snapshot.slots[snapshot.selected] = null
    const other = snapshot.slots.findIndex(Boolean)
    if (other >= 0) snapshot.selected = other
    this.weapons.restore(snapshot)
    const capacity = WEAPON_RULES[current.name].capacity
    const level = (current.packed ? current.packLevel ?? 1 : 0) + 1
    pack.insert({ ...current, id: `${current.id}-packed${level}`, packed: true, packLevel: level, magazine: capacity, reserve: capacity * RESERVE_MAGAZINES * 2 })
    this.emit({ kind: 'pack-work', position: pack.point.clone(), radius: 30 })
    this.invalidate()
    return true
  }

  /**
   * Zombies are solid to you, as in Call of Duty: walk into one and you stop; get surrounded and you are
   * boxed in. Runs after both have moved; a push never takes you into a wall.
   */
  private blockByZombies() {
    const body = this.player.body, feet = body.position
    const push = new THREE.Vector3()
    for (const zombie of this.director?.zombies ?? []) {
      if (zombie.state !== 'chase' || zombie.rise > 0 || zombie.climb) continue
      if (Math.abs(zombie.position.y - feet.y) > 1.2) continue
      const reach = PLAYER_BODY + ZOMBIE_BODY * (zombie.boss ? BOSS.scale : 1)
      const dx = feet.x - zombie.position.x, dz = feet.z - zombie.position.z, d = Math.hypot(dx, dz)
      if (d >= reach) continue
      if (d < 1e-4) push.x += reach; else { push.x += dx / d * (reach - d); push.z += dz / d * (reach - d) }
    }
    if (push.lengthSq() < 1e-8) return
    const target = feet.clone().add(push)
    this.pushCapsule.start.copy(target).y += 0.3 + 0.05
    this.pushCapsule.end.copy(target).y += 1.74 - 0.3
    if (!this.player.world.fits(this.pushCapsule)) return
    feet.copy(target)
    // Stop pressing on into them.
    const into = push.clone().normalize(), along = body.velocity.x * into.x + body.velocity.z * into.z
    if (along < 0) { body.velocity.x -= into.x * along; body.velocity.z -= into.z * along }
    this.camera.perspective.position.x += push.x
    this.camera.perspective.position.z += push.z
  }

  /** Make something solid to the player: an invisible box around it in the collision world. */
  private makeSolid(owner: THREE.Object3D, size: [number, number, number], offset: [number, number, number]) {
    const old = this.solids.get(owner)
    if (old) this.player.world.removeObject(old)
    const box = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ visible: false }))
    box.name = `${owner.name} · solid`
    // Solid to walk into only: bullets, sight lines and the reach test for its own prompt pass through.
    box.userData.blocksSight = false
    box.userData.blocksShots = false
    owner.updateWorldMatrix(true, false)
    box.position.set(...offset).applyMatrix4(owner.matrixWorld)
    box.quaternion.copy(owner.getWorldQuaternion(new THREE.Quaternion()))
    box.updateMatrixWorld(true)
    this.player.world.addObject(box)
    this.solids.set(owner, box)
  }

  /** The menu theme over menus, nothing in a round, the Brute's track while it lives, the requiem after death. */
  private updateMusic() {
    this.music.setMode(this.state.phase === 'dead' ? 'dead' : !this.player.playing ? 'menu'
      : this.brute && this.brute.state === 'chase' ? 'boss' : 'play')
  }

  /**
   * The Easter egg: three little ink skulls hidden about the compound. Touch one and it hums; touch all
   * three in one game and the hidden song plays, as Call of Duty's maps hide theirs.
   */
  private placeSkulls() {
    const graph = this.graph!, taken: THREE.Vector3[] = []
    for (const [x, y, z] of SKULL_PLACES) {
      const node = graph.nearest(new THREE.Vector3(x, y, z), 4)
      if (node < 0) continue
      graph.flow([graph.point(node)])
      const [spot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 12, spacing: 4, avoid: taken })
      const at = spot ? spot.wall.clone().addScaledVector(spot.normal, 0.18).setY(spot.stand.y) : graph.point(node)
      taken.push(at.clone())
      const skull = inkSkull()
      skull.position.copy(at)
      if (spot) skull.rotation.y = Math.atan2(spot.normal.x, spot.normal.z)
      this.scene.add(skull)
      this.skulls.push({ object: skull, found: false })
    }
  }

  private touchSkull(skull: { object: THREE.Object3D; found: boolean }) {
    if (!this.isActive() || skull.found) return false
    if (this.camera.perspective.position.distanceTo(skull.object.position) > 2.6) return false
    skull.found = true
    skull.object.userData.found = true
    this.emit({ kind: 'box-leave', position: skull.object.position.clone(), radius: 8 })
    if (this.skulls.every(s => s.found)) this.music.sting('song')
    return true
  }

  /** The teddy bear took the box: your 950 back, and the box turns up at another of its places. */
  private moveBox() {
    const box = this.box
    if (!box) return
    this.state.points += PRICES.box
    this.zombieHud.gain(PRICES.box)
    const others = this.boxSpots.filter(spot => spot !== box.spot)
    box.place(others[Math.floor(this.random() * others.length)] ?? box.spot)
    this.makeSolid(box.root, [1.44, 0.66, 0.64], [0, 0.33, 0])
    this.hud.notify('The Mystery Box has moved. Follow its light.', 3.5)
    this.emit({ kind: 'box-leave', position: this.player.body.position.clone(), radius: 5 })
  }

  /** Pay to open a zone: the gate sinks into the ink and zombies can now come from the other side too. */
  private useGate(gate: ZoneGate) {
    if (!this.isActive() || !this.zones || gate.state !== 'closed') return false
    const point = this.zones.nearestPoint(gate, this.camera.perspective.position)
    if (!this.canReach(point, gate.closed) || !this.spend(gate.spec.cost)) return false
    this.zones.open(gate)
    this.emit({ kind: 'door', position: point.clone(), radius: 30 })
    this.emit({ kind: 'zombie-rise', position: point.clone().setY(0), radius: 30 })
    this.hud.notify(`${gate.spec.zone} is open.`, 2.5)
    this.invalidate()
    return true
  }

  private useBox(box: MysteryBox) {
    if (!this.isActive() || !this.canReach(box.point, box.root)) return false
    if (this.timers.deathMachine) { this.hud.notify('Not while you hold the Death Machine.', 2, true); return false }
    if (box.state === 'offering') {
      const offer = box.take()
      if (!offer) return false
      const item = freshWeapon(`box-${offer.name}-${Math.floor(this.state.elapsed * 1000)}`, offer.name, offer.rarity)
      this.weapons.give(offer.special ? { ...item, special: offer.special } : item)
      this.invalidate()
      return true
    }
    if (box.state !== 'idle' || !this.spend(PRICES.box)) return false
    const teddy = box.uses >= BOX_TEDDY_AFTER && this.boxSpots.length > 1 && this.random() < BOX_TEDDY_CHANCE
    box.spin(rollBox(this.random, this.weapons.slots), teddy)
    this.emit({ kind: 'box-open', position: box.point.clone(), radius: 25 })
    this.music.sting('boxSpin')
    this.invalidate()
    return true
  }

  // ---------------------------------------------------------------- combat

  /** Points in; Double Points doubles every gain while it runs. */
  private award(amount: number) {
    const points = this.timers.doublePoints ? amount * 2 : amount
    this.state.points += points
    this.earned += points
    this.zombieHud.gain(points)
  }

  /**
   * A gun upgraded twice or more sometimes bursts its kill in ink: every zombie close by takes a heavy
   * blow. Area damage for the late rounds, where picking zombies off one by one gets slow.
   */
  private inkBurst(position: THREE.Vector3, level: number) {
    const director = this.director
    const burst = INK_BURST[Math.min(INK_BURST.length, Math.max(1, level)) - 1]
    if (!director || this.random() >= burst.chance) return
    const centre = position.clone().setY(position.y + 0.8)
    // Twice a zombie's health: with the blast's falloff, everything inside the radius dies, at any round.
    const damage = zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * 2
    for (const hit of director.blast(centre, burst.radius, damage)) {
      this.award(pointsForHit({ lethal: hit.lethal, zone: 'torso' }))
      this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
      if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
    }
    this.shockwaves.emit(position, burst.radius)
    this.riseMarks.emit(position)
    this.emit({ kind: 'ink-burst', position: centre, radius: 40 })
  }

  /** A kill by the player: the Brute pays and always leaves a Max Ammo; others may drop a power-up. */
  private killed(position: THREE.Vector3, zombie?: Zombie, weapon?: WeaponItem | null) {
    this.lastKillAt = position.clone()
    if (weapon?.packed) this.inkBurst(position, weapon.packLevel ?? 1)
    if (zombie && zombie === this.brute) {
      this.brute = null
      this.award(BOSS.points)
      const at = position.clone(), floor = this.player.world.floor(at.clone().setY(at.y + 2.2), 0.1, 3)
      if (Number.isFinite(floor)) at.y = floor
      this.powerups.spawn('maxAmmo', at)
      this.emit({ kind: 'powerup-drop', position: at.clone(), radius: 40 })
      this.zombieHud.announce('The Brute is down', 3)
      return
    }
    const kind = this.dropper.onKill(this.earned)
    if (!kind) return
    // On the surface, even for one shot while still climbing out of the ground.
    const at = position.clone(), floor = this.player.world.floor(at.clone().setY(at.y + 2.2), 0.1, 3)
    if (Number.isFinite(floor)) at.y = floor
    this.powerups.spawn(kind, at)
    this.emit({ kind: 'powerup-drop', position: at.clone(), radius: 40 })
  }

  private activate(kind: PowerupKind) {
    this.zombieHud.announce(`${POWERUP_INFO[kind].label}!`, 2.4, 'powerup')
    this.emit({ kind: 'powerup-grab', position: this.player.body.position.clone(), radius: 5 })
    switch (kind) {
      case 'nuke': {
        const killed = this.director?.killAll() ?? 0
        this.state.kills += killed
        this.award(POWERUPS.nukePoints)
        if (!this.hud.reducedMotion) this.zombieHud.flash()
        // The mushroom cloud, far off ahead of you on the horizon.
        const forward = this.camera.perspective.getWorldDirection(new THREE.Vector3()).setY(0)
        if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1)
        this.nukeCloud.trigger(this.player.body.position.clone().addScaledVector(forward.normalize(), 230).setY(0))
        this.emit({ kind: 'nuke', position: this.player.body.position.clone(), radius: 200 })
        break
      }
      case 'maxAmmo':
        this.grenadeCount = GRENADE.max
        if (this.dollCount > 0) this.dollCount = DECOY.carry
        for (const item of [...this.weapons.slots, ...(this.heldWeapons?.slots ?? [])]) {
          if (!item || item.special) continue
          item.reserve = Math.max(item.reserve, WEAPON_RULES[item.name].capacity * RESERVE_MAGAZINES * (item.packed ? 2 : 1))
        }
        break
      case 'deathMachine':
        if (!this.timers.deathMachine) {
          this.heldWeapons = this.weapons.snapshot()
          this.weapons.restore({ slots: [{ id: 'death-machine', name: 'ak', special: 'deathMachine', magazine: DEATH_MACHINE_ROUNDS, reserve: 0 }, null],
            selected: 0, pickups: [], nextId: this.heldWeapons.nextId })
          this.aiming = false
        }
        this.timers.deathMachine = POWERUPS.timed
        break
      case 'instaKill': case 'doublePoints':
        this.timers[kind] = POWERUPS.timed
        break
      case 'carpenter':
        this.award(POWERUPS.carpenterPoints)
        break
    }
    this.invalidate()
  }

  /** Count timed power-ups down; the Death Machine hands your own guns back when it runs out. */
  private tickPowerups(dt: number) {
    for (const kind of Object.keys(this.timers) as TimedPowerup[]) {
      const left = (this.timers[kind] ?? 0) - dt
      if (left > 0) { this.timers[kind] = left; continue }
      delete this.timers[kind]
      if (kind === 'deathMachine' && this.heldWeapons) { this.weapons.restore(this.heldWeapons); this.heldWeapons = null; this.aiming = false }
    }
    const current = this.weapons.current
    if (this.timers.deathMachine && current?.special) current.magazine = DEATH_MACHINE_ROUNDS
    const feet = this.state.phase === 'active' ? this.player.body.position : null
    for (const kind of this.powerups.update(dt, feet)) this.activate(kind)
    this.zombieHud.powerups((Object.keys(this.timers) as TimedPowerup[]).map(kind => ({ kind, left: this.timers[kind]! })))
  }

  private shot(shot: Shot) {
    if (!this.isActive() || !this.director) return
    // One burst per trigger pull, not one per shotgun pellet.
    if (!shot.pelletIndex) this.sparks.emit(shot.origin, shot.direction, this.weapons.current?.special ? 2 : 4)
    const surface = this.player.world.raySurface(shot.origin, shot.direction, shot.range)
    const distance = surface?.distance ?? shot.range
    this.impactPoint = null
    const scale = ZOMBIE_DAMAGE_SCALE * (this.perks.has('doubleLine') ? PERK_EFFECT.damage : 1)
    const held = this.weapons.current
    if (held?.special === 'rayGun') {
      // A bolt, not a bullet: it flies, and bursts where it lands.
      this.bolts.fire(shot.origin, shot.direction)
      return
    }
    const struck = this.director.hitAll(shot, distance, scale, !!this.timers.instaKill, held ? pierceOf(held) : 1)
    const hit = struck[0] ?? null
    for (const each of struck) {
      this.hitFlash = 0.15
      this.award(pointsForHit({ lethal: each.lethal, zone: each.reaction.zone }))
      this.hits.hit(each.reaction.point, each.dealt, each.zombie.id, each.reaction.zone === 'head', each.lethal)
      if (each.lethal) { this.state.kills++; if (each.reaction.zone === 'head') this.state.headshots++; this.killed(each.zombie.position, each.zombie, held) }
    }
    const end = this.impactPoint ?? shot.origin.clone().addScaledVector(shot.direction, distance)
    const impact = !hit && surface ? () => {
      this.audio.play({ kind: 'impact', position: end, radius: 18 })
      this.impacts.emit(end, shot.direction, surface, shot.weapon)
    } : undefined
    this.bulletTrails.emit(shot.origin, end, shot.weapon, undefined, impact)
  }

  /** Throw a frag the way you are looking, a little up, carrying your own speed with it. */
  throwGrenade() {
    if (!this.isActive() || this.revive.down || this.grenadeCount <= 0 || this.grenadeCooldown > 0) return false
    this.grenadeCount--
    this.grenadeCooldown = GRENADE.cooldown
    // The throw itself keeps the gun down until it is over (an inactive frame would cancel it).
    this.weapons.throwItem(createGrenadeModel())
    this.throwLater(this.grenades)
    return true
  }

  /** An Ink Ray bolt bursts: a splash that kills most things near it, and stings you point-blank. */
  private boltBurst(at: THREE.Vector3) {
    const director = this.director
    if (!director) return
    const damage = Math.max(1500, zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * 1.6)
    for (const hit of director.blast(at, INK_RAY.radius, damage)) {
      this.hitFlash = 0.15
      this.award(pointsForHit({ lethal: hit.lethal, zone: 'torso' }))
      this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
      if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
    }
    const eye = this.camera.perspective.getWorldPosition(new THREE.Vector3())
    const distance = eye.distanceTo(at)
    if (distance < INK_RAY.selfRadius) this.damage(Math.round(INK_RAY.selfDamage * (1 - distance / INK_RAY.selfRadius)), 'zombie', at.clone())
    this.shockwaves.emit(at.clone().setY(at.y - 0.5), INK_RAY.radius)
    this.sparks.emit(at, new THREE.Vector3(0, 1, 0), 8)
    this.emit({ kind: 'ink-burst', position: at.clone(), radius: 60 })
  }

  /** A frag goes off: every zombie in reach takes a heavy blow; you too, if you stood too close. */
  private grenadeBlast(at: THREE.Vector3) {
    const director = this.director
    if (!director) return
    // Twice a zombie's health: everything inside the radius dies, even in the high rounds.
    const damage = Math.max(600, zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * 2)
    for (const hit of director.blast(at, GRENADE.radius, damage)) {
      this.award(pointsForHit({ lethal: hit.lethal, zone: 'torso' }))
      this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
      if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
    }
    const eye = this.camera.perspective.getWorldPosition(new THREE.Vector3())
    const distance = eye.distanceTo(at)
    if (distance < GRENADE.selfRadius && this.player.world.visible(at.clone().setY(at.y + 0.3), eye, new THREE.Object3D()))
      this.damage(Math.round(GRENADE.selfDamage * (1 - distance / GRENADE.selfRadius)), 'zombie', at.clone())
    this.explosions.emit(at, GRENADE.radius)
    this.emit({ kind: 'grenade-blast', position: at.clone(), radius: 120 })
  }

  knife() {
    if (!this.isActive() || !this.director || this.knifeCooldown > 0 || this.revive.down) return false
    this.knifeCooldown = KNIFE.cooldown
    this.weapons.knifeSwing()
    const eye = this.camera.perspective.getWorldPosition(new THREE.Vector3())
    const forward = this.camera.perspective.getWorldDirection(new THREE.Vector3())
    const hit = this.director.knife(eye, forward, KNIFE.range, KNIFE.damage, !!this.timers.instaKill)
    this.emit({ kind: 'drop', position: eye.clone(), radius: 3 })
    if (!hit) return false
    this.hitFlash = 0.15
    this.award(pointsForHit({ lethal: hit.lethal, zone: hit.reaction.zone, knife: true }))
    this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
    if (hit.lethal) { this.state.kills++; this.state.knifeKills++; this.killed(hit.zombie.position, hit.zombie) }
    return true
  }

  damage(amount: number, cause: 'zombie' | 'fall', source?: THREE.Vector3) {
    if (this.invincible || this.reviveGrace > 0 || !this.isActive() || !(amount > 0)) return
    // The shield on your back takes what comes from behind, until it breaks.
    if (this.shield && source && cause === 'zombie') {
      const yaw = new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y
      if (fromBehind(this.player.body.position, yaw, source)) {
        this.shield.health -= amount
        this.audio.play({ kind: 'bullet-hit', intensity: 0.8 })
        this.sparks.emit(source.clone().lerp(this.player.body.position.clone().setY(source.y), 0.7), new THREE.Vector3(0, 1, 0), 6)
        if (this.shield.health <= 0) {
          this.shield = null
          this.shieldBackRound = this.rounds.round + 2
          this.zombieHud.announce('Your shield broke', 2.4)
          this.emit({ kind: 'ink-burst', position: this.player.body.position.clone(), radius: 10 })
        }
        this.zombieHud.shield(this.shield ? this.shield.health / SHIELD.health : null)
        this.invalidate()
        return
      }
    }
    this.state.health = Math.max(0, this.state.health - amount)
    this.lastHurt = this.state.elapsed
    const dead = this.state.health === 0
    if (!dead && !this.hud.reducedMotion) {
      const point = this.player.body.position.clone().add(new THREE.Vector3(0, 1.17, 0))
      this.playerHits.hit({ region: source ? 'torso' : 'leg', side: 0, point,
        direction: source ? point.clone().sub(source) : new THREE.Vector3(0, 1, 0) },
        amount, this.player.body.grounded && !this.player.actions.traversing)
    }
    if (source) this.indicator.hit(source, amount)
    this.hud.hurt(); this.audio.play({ kind: 'damage' })
    this.audio.play({ kind: 'bullet-hit', intensity: Math.min(1, amount / 50) })
    if (cause === 'fall') this.hud.notify('You fell.', 2)
    if (dead && this.perks.has('secondDraft')) this.selfRevive()
    else if (dead) this.gameOver(source)
    this.invalidate()
  }

  private gameOver(source?: THREE.Vector3) {
    this.state.phase = 'dead'
    this.playerHits.clear(); this.deaths++
    const direction = source ? this.camera.perspective.position.clone().sub(source) : undefined
    this.death.begin(this.camera.perspective, this.player.body.position, this.player.world, this.hud.reducedMotion, direction)
    this.weapons.beginDeath()
    this.player.pause(); this.player.actions.reset(); this.cancelInput()
    this.player.body.velocity.set(0, 0, 0)
    this.audio.beginDeath()
    this.hud.setScoped(false); this.hud.clearThreat(); this.hud.setDeath(this.death)
    // Ink for the Armory: round x 10 + kills + headshots x 2.
    const ink = awardGame({ round: this.state.round, kills: this.state.kills, headshots: this.state.headshots })
    this.hud.notify(`+${ink} Ink`, 3)
  }

  // ---------------------------------------------------------------- zombies

  private gait(): ZombieGait {
    const mix = movementMix(Math.max(1, this.rounds.round + DIFFICULTY[this.difficulty].sprintShift))
    return weighted(this.random, { walk: mix.walk, run: mix.run, sprint: mix.sprint })
  }

  private eyes() { return [this.camera.perspective.position.clone()] }

  /** On screen and not behind a wall: what the player would see disappear. */
  private seen(point: THREE.Vector3, ignore: THREE.Object3D) {
    const camera = this.camera.perspective
    const screen = point.clone().project(camera)
    if (screen.z < -1 || screen.z > 1 || Math.abs(screen.x) > 1.15 || Math.abs(screen.y) > 1.15) return false
    return this.player.world.visible(camera.position, point, ignore)
  }

  /** Zombies climb out of the ground somewhere they can walk to you from; seeing it happen is the point. */
  private spawnZombie() {
    const director = this.director, graph = this.graph
    if (!director || !graph) return false
    const spot = pickSpawn(graph, this.player.world, { near: 14, far: 42, eyes: [] }, this.random)
    if (!spot) return false
    const feet = this.player.body.position
    const health = Math.round(zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * (this.storm ? STORM.health : 1))
    return !!director.spawn(spot, health, this.storm ? 'sprint' : this.gait(), Math.atan2(feet.x - spot.x, feet.z - spot.z), true)
  }

  /** The Ink Storm darkens the page while it lasts. */
  private setStorm(on: boolean) {
    this.storm = on
    this.lastKillAt = null
    if (on && !this.hud.reducedMotion) document.body.dataset.deadInkStorm = 'true'
    else delete document.body.dataset.deadInkStorm
  }

  /** The storm is cleared: a Max Ammo where the last one fell, and the light comes back. */
  private stormReward() {
    const at = (this.lastKillAt ?? this.player.body.position).clone()
    const floor = this.player.world.floor(at.clone().setY(at.y + 2.2), 0.1, 3)
    if (Number.isFinite(floor)) at.y = floor
    this.powerups.spawn('maxAmmo', at)
    this.emit({ kind: 'powerup-drop', position: at.clone(), radius: 40 })
    this.setStorm(false)
  }

  /** The Brute climbs out of the ground somewhere it can walk to you from, and roars. */
  private spawnBrute() {
    const director = this.director, graph = this.graph
    if (!director || !graph) return
    const spot = pickSpawn(graph, this.player.world, { near: 16, far: 40, eyes: [] }, this.random)
    const feet = this.player.body.position
    const health = Math.round(BOSS.health(this.rounds.round) * DIFFICULTY[this.difficulty].health)
    const brute = spot && director.spawn(spot, health, 'run', Math.atan2(feet.x - spot.x, feet.z - spot.z), true, true)
    // Nowhere to stand, or every body in use: try again in a moment.
    if (!brute) { this.bruteTimer = 1; return }
    this.brute = brute
    this.riseMarks.emit(brute.position); this.riseMarks.emit(brute.position.clone().add(new THREE.Vector3(0.6, 0, 0.4)))
    this.zombieHud.announce('The Brute', 3)
    this.emit({ kind: 'boss-roar', position: brute.position.clone().setY(brute.position.y + 3), radius: 250 })
  }

  /**
   * Zombies that cannot reach you, or stopped getting closer, come back into play near you, out of
   * sight at both ends: one you are looking at stays put until you look away.
   */
  private relocateStranded(dt: number) {
    this.strandTimer -= dt
    if (this.strandTimer > 0 || !this.director || !this.graph) return
    this.strandTimer = 0.5
    for (const zombie of this.director.zombies) {
      if (zombie.state !== 'chase' || !zombie.stranded) continue
      if (this.seen(zombie.position.clone().setY(zombie.position.y + 1.2), zombie.actor.root)) continue
      const spot = pickSpawn(this.graph, this.player.world, { near: 12, far: 32, eyes: this.eyes() }, this.random)
      if (spot) this.director.relocate(zombie, spot)
    }
  }

  // ---------------------------------------------------------------- frame

  private emit(event: SoundEvent) {
    if (this.death.active && !['player-death', 'player-fall'].includes(event.kind)) return
    const eye = this.camera.perspective.position
    const distance = event.position ? eye.distanceTo(event.position) : 0
    const inRange = !event.position || distance <= (event.radius ?? 38)
    if (inRange) this.audio.play(event)
    if (event.text && inRange && !event.kind.startsWith('shot-')) {
      if (event.text !== this.lastCaption || this.state.elapsed - this.lastCaptionAt > 3) {
        this.hud.notify(event.text, 3.5); this.lastCaption = event.text; this.lastCaptionAt = this.state.elapsed
      }
    }
  }

  update(dt: number, _elapsed = dt) {
    this.finishFrame()
    const landingSpeed = this.player.body.landingSpeed
    this.player.body.landingSpeed = 0
    const active = this.isActive()
    if (this.player.immersive || !this.player.enabled || this.state.phase !== 'active') {
      this.playerHits.clear(); this.hud.clearThreat()
      if (this.player.immersive || !this.player.enabled || !this.death.active) this.bulletTrails.clear()
    }
    let deathVisible = this.death.active && this.player.enabled && !this.player.immersive
    const deathPlaying = deathVisible && !this.death.menuVisible && !document.hidden
    if (active !== this.active) { this.cancelInput(); this.active = active }
    this.audio.setActive(active || deathPlaying)
    // A doll on the ground draws every zombie to it, the Brute too, until it goes off.
    const lures = this.dolls.resting()
    const target = (): ZombieTarget[] => lures.length ? lures.map((doll, i) => ({ id: `doll-${i}`, feet: doll.position, alive: true }))
      : [{ id: 'p1', feet: this.player.body.position, alive: this.state.phase === 'active' }]
    if (active && this.director) {
      this.state.elapsed += dt
      const body = this.player.body
      const b = this.world.bounds
      if (body.position.y < -12 || body.position.x < b.minX || body.position.x > b.maxX || body.position.z < b.minZ || body.position.z > b.maxZ) {
        body.teleport(this.safePosition); this.player.actions.syncCamera(this.camera.perspective)
        this.hud.notify('That is the edge of the map.', 3)
      } else if (!this.player.actions.traversing) this.damage(fallDamage(landingSpeed), 'fall')
      // Rounds: announce, feed zombies in, and hand back any that found nowhere to stand.
      const events = stepRounds(this.rounds, dt, this.director.aliveCount, 1, DIFFICULTY[this.difficulty].spawnDelay * (this.storm ? STORM.spawnDelay : 1))
      this.state.round = this.rounds.round
      if (events.roundStarted) {
        this.dropper.newRound(); this.music.sting('roundStart')
        this.setStorm(isStormRound(events.roundStarted))
        if (this.storm) {
          // A smaller pack: this step may already have fed some in.
          this.rounds.toSpawn = Math.max(0, Math.ceil((this.rounds.toSpawn + events.spawn) * STORM.count) - events.spawn)
          this.zombieHud.announce(`Round ${events.roundStarted}: Ink Storm`, 3.5)
          this.emit({ kind: 'storm' })
        } else this.zombieHud.announce(`Round ${events.roundStarted}`)
        if (isBossRound(events.roundStarted)) this.bruteTimer = BOSS.delay
        if (events.roundStarted > 1) this.grenadeCount = Math.min(GRENADE.max, this.grenadeCount + GRENADE.perRound)
        if (this.shieldBackRound && events.roundStarted >= this.shieldBackRound) {
          this.shieldBackRound = 0; this.shieldOnBench = true
          this.hud.notify('A new ink shield is waiting on the bench.', 3)
        }
      }
      if (this.bruteTimer > 0 && (this.bruteTimer -= dt) <= 0) this.spawnBrute()
      let failed = 0
      for (let i = 0; i < events.spawn; i++) if (!this.spawnZombie()) failed++
      returnSpawns(this.rounds, failed)
      if (events.roundEnded) {
        this.zombieHud.announce(this.storm ? 'The storm passes' : `Round ${events.roundEnded} survived`, 3.5); this.emit({ kind: 'round-end' })
        if (this.storm) this.stormReward()
      }
      this.director.update(dt, target())
      // The last zombie of a round always comes at a sprint, as in every Call of Duty map.
      if (this.rounds.phase === 'active' && this.rounds.toSpawn === 0 && this.director.aliveCount === 1) {
        const last = this.director.zombies.find(z => z.state === 'chase' && !z.boss)
        if (last && last.gait !== 'sprint') last.gait = 'sprint'
      }
      this.blockByZombies()
      this.relocateStranded(dt)
      // Health comes back after a few seconds without being hit, as in Call of Duty.
      if (this.state.phase === 'active' && this.state.elapsed - this.lastHurt > PLAYER_HEALTH.regenDelay)
        this.state.health = Math.min(this.maxHealth(), this.state.health + PLAYER_HEALTH.regenPerSecond * dt)
      this.reviveGrace = Math.max(0, this.reviveGrace - dt)
      if (this.revive.active) {
        const wasDown = this.revive.down
        this.revive.update(dt)
        // Back on your feet: shove the nearest ones again and let you move.
        if (wasDown && !this.revive.down) {
          this.player.movementLocked = false
          this.director.shove(body.position, PERK_EFFECT.reviveShove, 1.5)
          this.emit({ kind: 'powerup-grab', position: body.position.clone(), radius: 5 })
        }
      }
      if (this.pendingPerk && (this.pendingPerk.timer -= dt) <= 0) { this.grantPerk(this.pendingPerk.kind); this.pendingPerk = null }
      for (const part of this.parts) part.update(dt)
      for (const site of this.sites.values()) site.update(dt)
      this.powerSwitch?.update(dt)
      for (const machine of this.perkMachines) {
        machine.update(dt)
        // Walk up to a machine and it plays its jingle (not again for a while).
        const near = machine.point.distanceTo(body.position) < 7
        if (near && !this.nearMachines.has(machine) && this.state.elapsed - (this.jingleAt.get(machine) ?? -100) > 20) {
          this.emit({ kind: 'perk-jingle', position: machine.point.clone(), radius: 14, voice: machine.kind })
          this.jingleAt.set(machine, this.state.elapsed)
        }
        if (near) this.nearMachines.add(machine); else this.nearMachines.delete(machine)
      }
      const packed = this.pack?.update(dt)
      if (packed === 'done') { this.emit({ kind: 'pack-ready', position: this.pack!.point.clone(), radius: 30 }); this.hud.notify('Your upgraded gun is ready.', 2.5) }
      if (packed === 'expired') this.hud.notify('The Pack-a-Punch kept your gun.', 3, true)
      this.knifeCooldown = Math.max(0, this.knifeCooldown - dt)
      const boxEvent = this.box?.update(dt, Object.keys(BOX_WEIGHTS) as WeaponName[])
      if (boxEvent === 'expired') this.hud.notify('The box closed.', 2)
      if (boxEvent === 'landed' && this.box) this.emit({ kind: 'box-offer', position: this.box.point.clone(), radius: 25 })
      if (boxEvent === 'moved') this.moveBox()
      this.blood.update(dt); this.impacts.update(dt); this.riseMarks.update(dt); this.sparks.update(dt); this.shockwaves.update(dt)
      this.explosions.update(dt); this.nukeCloud.update(dt)
      this.zones?.update(dt)
      this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt)
      for (const pending of [...this.pendingThrows]) if ((pending.timer -= dt) <= 0) { this.pendingThrows.splice(this.pendingThrows.indexOf(pending), 1); pending.launch() }
      for (const at of this.grenades.update(dt)) this.grenadeBlast(at)
      this.dollCooldown = Math.max(0, this.dollCooldown - dt)
      for (const doll of lures) animateDoll(doll.object, doll.age)
      if (lures.length && (this.dollClap -= dt) <= 0) { this.dollClap = 0.32; this.emit({ kind: 'doll-clap', position: lures[0].position.clone(), radius: 25 }) }
      for (const at of this.dolls.update(dt)) this.dollBlast(at)
      for (const at of this.bolts.update(dt)) this.boltBurst(at)
      this.tickPowerups(dt)
      const speed = Math.hypot(body.velocity.x, body.velocity.z)
      if (speed > 0.5 && body.grounded || this.player.actions.climbing) {
        this.stepTime += dt
        if (this.stepTime > (this.player.actions.climbing ? 0.5 : speed > 5 ? 0.3 : 0.48)) {
          this.stepTime = 0; this.emit({ kind: this.player.actions.climbing ? 'ladder' : 'footstep', position: body.position.clone(), radius: speed > 5 ? 15 : 6 })
        }
      } else this.stepTime = 0
      this.safePosition.copy(body.position)
      this.interactionTime = Math.max(0, this.interactionTime - dt)
    } else if (deathPlaying && this.director) {
      // The horde keeps moving while you fall.
      this.state.elapsed += dt
      this.player.world.refresh()
      this.director.update(dt, target())
      this.blood.update(dt); this.impacts.update(dt); this.riseMarks.update(dt)
      this.explosions.update(dt); this.nukeCloud.update(dt)
    }
    const reactionActive = this.isActive()
    const yaw = new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y
    const hitPose = this.playerHits.update(reactionActive ? dt : 0, yaw, this.hud.reducedMotion)
    if (reactionActive) {
      const zoom = this.aiming && this.weapons.current?.name === 'sniper' && !this.weapons.reloading ? this.weapons.scopeMagnification : 1
      this.playerHits.applyCamera(this.camera.perspective, this.player.world, 1 / zoom)
      this.revive.applyCamera(this.camera.perspective, this.hud.reducedMotion)
    }
    deathVisible = this.death.active && this.player.enabled && !this.player.immersive
    if (deathVisible) {
      if (this.death.update(document.hidden ? 0 : dt, this.camera.perspective, this.player.world)) this.audio.play({ kind: 'player-fall' })
      this.weapons.updateDeath(this.death.elapsed, this.death.reducedMotion, this.death.hitKick, this.death.hitSide)
      this.hud.setDeath(this.death)
    } else {
      if (this.death.active) { this.death.reset(); this.weapons.resetDeath(); this.hud.clearDeath() }
      this.weapons.update(dt, { active: reactionActive && this.interactionTime === 0 && !this.revive.down, climbing: this.player.actions.traversing,
        moving: this.player.body.velocity.length(), aiming: this.aiming, reducedMotion: this.hud.reducedMotion, feet: this.player.body.position, hitPose })
    }
    this.bottle.update(dt)
    const held = this.weapons.current
    this.packedLook.update(dt, this.weapons.heldModel, held?.packed ? held.packLevel ?? 1 : 0)
    this.audio.update(this.camera.perspective)
    this.hud.setScoped(this.weapons.scoped, this.weapons.scopeMagnification)
    const running = active || deathPlaying ? dt : 0
    if (running) { this.bulletTrails.update(dt); this.hitFlash -= dt }
    document.querySelector<HTMLElement>('.crosshair')?.classList.toggle('confirmed-hit', this.hitFlash > 0)
    this.hits.update(running, this.camera.perspective, window.innerWidth, window.innerHeight)
    this.indicator.update(running, this.camera.perspective.position, yaw)
    this.hotbar.update(this.weapons.slots, this.weapons.selectedSlot)
    this.zombieHud.update(running, this.state.round, this.state.points)
    this.zombieHud.boss(this.brute && this.brute.state === 'chase' ? this.brute.health / this.brute.maxHealth : null)
    this.zombieHud.grenades(this.grenadeCount, this.dollCount)
    this.updateMusic()
    // The heart shows health as a share of your maximum, which Thick Ink raises.
    this.hud.update(dt, { ...this.state, health: this.state.health / this.maxHealth() * 100 }, { playing: this.player.playing, enabled: this.player.enabled && !this.player.immersive,
      weapon: this.weapons.current, reloading: this.weapons.reloading, position: this.player.body.position,
      yaw, deaths: this.deaths, ready: this.ready })
    return active || this.death.running
  }

  finishFrame() { this.revive.removeCamera(); this.playerHits.removeCamera() }

  dispose() {
    this.playerHits.clear(); this.disposed = true; this.abort.abort()
    for (const buy of this.wallBuys) buy.dispose()
    this.box?.dispose()
    this.zones?.dispose()
    for (const box of this.solids.values()) { this.player.world.removeObject(box); box.geometry.dispose() }
    for (const machine of this.perkMachines) machine.dispose()
    this.pack?.dispose(); this.bottle.dispose(); this.packedLook.dispose()
    this.director?.dispose()
    this.hits.dispose(); this.indicator.dispose(); this.hotbar.dispose(); this.zombieHud.dispose()
    this.uninstallCosmetics(); this.bulletTrails.dispose(); this.weapons.dispose(); this.blood.dispose(); this.impacts.dispose(); this.riseMarks.dispose(); this.sparks.dispose(); this.shockwaves.dispose(); this.explosions.dispose(); this.nukeCloud.dispose(); this.undress?.(); this.grenades.dispose(); this.dolls.dispose(); this.dollBuy?.dispose(); this.bolts.dispose(); this.powerups.dispose()
    for (const skull of this.skulls) skull.object.removeFromParent()
    delete document.body.dataset.deadInkStorm
    for (const part of this.parts) part.dispose()
    for (const site of this.sites.values()) site.dispose()
    this.powerSwitch?.dispose()
    this.audio.dispose(); this.music.dispose(); this.hud.dispose()
    this.player.movementLocked = false; this.player.onPlayingChange = () => {}; this.player.lookSensitivity = () => 1
    this.player.actions.extraTargets = () => []; this.player.actions.onAction = () => {}
  }
}
