import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { BulletTrails } from '../bullet-trails'
import { WEAPON_RULES, fallDamage } from '../balance'
import { PACKED_NAMES, pierceOf, weaponRules } from '../loot'
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
import { bruteDue, roundAlive } from './brute'
import { NavGraph, geometryHash, type NavData } from './navgraph'
import { pickSpawn } from './spawn'
import { findWallSpots, type WallSpot } from './placement'
import { newGame, returnSpawns, stepRounds, type RoundState } from './rounds'
import { BOSS, DIFFICULTY, MAX_ALIVE, PLAYER_HEALTH, POWERUPS, PRICES, STARTING_POINTS, STORM, ZOMBIE_DAMAGE_SCALE, isStormRound, movementMix, zombieHealth, type Difficulty, type PowerupKind } from './rules'
import { BOX_WEIGHTS, WALL_WEAPONS, ZOMBIE_SLOTS, freshWeapon, pointsForHit, rollBox, spareAmmo, startingPistol, wallOffer, RESERVE_MAGAZINES } from './economy'
import { MysteryBox, WallBuy } from './stations'
import { ZombieHud } from './hud'
import { MuzzleSparks, RiseMarks, Shockwaves } from './effects'
import { GRENADE, Grenades } from './grenades'
import { INK_RAY, InkRayBolts } from './wonder'
// Dead Ink weapons: the Ink Rocket and the Deadline's explosive rounds.
import { InkRockets, ROCKET, rocketLoad, type RocketBurst } from './rockets'
import { DEADLINE_ROUND, roundDamage, selfBlast, type BlastKind } from './blasts'
import { isAkimbo } from '../akimbo'
import { REVIVE, SecondDraftRevive } from './revive'
import { DECOY, DollBuy, animateDoll, inkDoll } from './decoy'
import { THROW_RELEASE } from '../weapons'
import { BENCH_PLACE, BUILDS, BuildSite, PARTS, POWER_PLACE, PartPickup, PowerSwitch, SHIELD, fromBehind, type BuildId, type PartId } from './buildables'
import { ARMORY_PAGE, beginGame, deadInkHome, installCosmetics, recordBruteKill, recordGameEnd, recordKill, recordQuestComplete, recordRound, recordStormSurvived, type ChallengeUnlock } from './cosmetics'
import { DEAD_INK_GAME_OVER } from './summary'
import { LowHealthWarning } from './lowhealth'
import { getSettings, lookScale, subscribeSettings, volumeFor } from '../settings'
import { addDressing } from './dressing'
import { Explosion, MushroomCloud, createGrenadeModel } from './vfx'
import { POWERUP_INFO, PowerupDrops, PowerupDropper } from './powerups'
import { SEALED, ZONE_GATES, ZoneGates, type ZoneGate } from './zones'
import { InkTrap, TRAP, TRAP_GATES } from './traps'
import { INKWELL_PLACES, Inkwell, QUEST, SoulStreams, questHint, type QuestStep } from './quest'
import { BLOT, GAS, rollBlot } from './gas'
import { POWER_ICON, WorldMarker } from './markers'
import { REVIVE_ICON, ReviveSyringe } from './last-stand'
import { GameOverFlight } from './game-over'
import { playMythicSting } from './mythic'
import { CoopLink, PLAYER_COLORS, PLAYER_CSS, PartnerAvatar, PartnerTag, toVector, vec, type CoopIncoming, type CoopMessage, type CoopStatus, type PlayerState, type WorldState } from './coop'
import type { Shot as ShotType } from '../types'
import type { Rarity } from '../loot'
import { MACHINE_PLACES, PACK, PERKS, PERK_EFFECT, PERK_LIMIT, PackAPunch, PackedLook, PerkBottle, PerkMachine, type PerkKind } from './perks'
import { Minimap, type MinimapMate } from './minimap'
import { Barriers, WINDOW, type Barrier } from './windows'
// The Ink Storm's flyers (flyers.ts) and what a storm brings (rules.ts).
import { StormPack } from './flyers'
import { inkwingHealth, stormNumber } from './rules'

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
/** Another player in co-op: what they last told us, their stickman, name tag and revive cross, and their colour. */
type Teammate = { id: number; state: PlayerState | null; avatar: PartnerAvatar; tag: PartnerTag; marker: WorldMarker; css: string }

/**
 * Where else the Mystery Box can turn up once the teddy bear takes it: a point in each of three other
 * zones (the nearest good wall to it). After a few spins at one spot, each spin has this chance of the bear.
 */
/** Pack-a-Punch prices: 5000, then 10000, then 20000 to upgrade the same gun again; null when maxed. */
function packCost(item: WeaponItem) {
  const level = item.packed ? item.packLevel ?? 1 : 0
  // The Ink Ray upgrades once, to the X2, as the Ray Gun does in Call of Duty.
  if (item.special === 'rayGun') return level ? null : PACK.costs[0]
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

const PACKED_TRACER = 0xd4332a
/** The Ink Ray's bolt, as a teammate sees it go by: its own green. */
const RAY_TRACER = 0x46e05a

/** Co-op: how close and how long a revive takes, how long you can wait on the floor, how often we send. */
const COOP = { reviveReach: 2.2, reviveSeconds: 3, revivePoints: 100, bleedSeconds: 45, sendRate: 15 } as const

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
  controls: [['Knife', 'V'], ['Grenade', 'Q or G'], ['Ink Doll', 'E'], ['Switch weapon', 'Wheel']],
  pages: [ARMORY_PAGE], home: deadInkHome, mode: 'zombies', gameOver: DEAD_INK_GAME_OVER,
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
  /** The Ink Rocket's rockets in flight (rockets.ts). */
  readonly rockets: InkRockets
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
  /** Ink traps across two gate openings, and the clocks for their damage and sound. */
  traps: InkTrap[] = []
  private trapTick = 0
  /** The main quest, "The Last Edition": its step, the inkwells, the ink flying into them, the Editor. */
  questStep: QuestStep = 'power'
  wells: Inkwell[] = []
  private soulStreams: SoulStreams | null = null
  private bottles = 0
  editor: Zombie | null = null
  private editorTimer = -1
  /** 0..1: how deep in a Blot's gas the player is (it drives the screen effect); damage owed, paid in whole points. */
  gasExposure = 0
  private gasDamage = 0
  /**
   * Co-op: the link to the other browser, their stickman and name tag, what they last told us, and the
   * host's last snapshot (on the guest). `down` is this player's own state: 0 up, 1 down, 2 bled out.
   */
  readonly seed: number
  coop: CoopLink
  /** Every other player, by number (the host 0, guests 1 to 3): what they last told us, their stickman, name tag and revive cross. */
  readonly mates = new Map<number, Teammate>()
  private hudRoot: HTMLElement
  /** Where the power switch is, until the power is on. */
  private powerMarker: WorldMarker
  private lastTick: Extract<CoopMessage, { t: 'tick' }> | null = null
  private sendTimer = 0
  down: 0 | 1 | 2 = 0
  private bleed = 0
  private reviving = 0
  /** Whom you are reviving. */
  private revivingId = -1
  /** The guns you went down with, back in your hands when you are picked up. */
  private downWeapons: WeaponSnapshot | null = null
  private syringe: ReviveSyringe
  /** The game over: ink, then a flight over the map under GAME OVER, then the scores. */
  private gameOverFlight = new GameOverFlight(document.body)
  /** The player who paid for the box's spin: the gun is theirs. */
  private boxOwner = 0
  private coopPanel: HTMLElement | null = null
  private coopStatus: CoopStatus = { kind: 'idle' }
  private partnerKills = 0
  /** Who is in the co-op lobby, as last drawn on the co-op page. */
  private lobbyKey = ''
  /** The guests' Ink Dolls, on the host: where each lies and how long it keeps drawing zombies. */
  private partnerLures: { position: THREE.Vector3; left: number }[] = []
  private partsKey = ''
  /** Accuracy for the game-over page: trigger pulls, and pulls that hit a zombie (a shotgun blast counts once). */
  private shotsFired = 0
  private shotsHit = 0
  private pullHit = false
  /** Ink creeping in from the edges as your health runs low, with a heartbeat. */
  readonly lowHealth = new LowHealthWarning({ onBeat: strength => this.audio.play({ kind: 'heartbeat', intensity: strength }) })
  private stopSettings = () => {}
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
  /** What the storm brings as it comes: groups of Inkwings, a few sprinters. */
  private stormPack = new StormPack()
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
  /** Mini map (minimap.ts), and the teammates it shows: the co-op partner, one entry reused every frame. */
  private minimap: Minimap | null = null
  private mapMatePool: MinimapMate[] = []
  private mapMates: MinimapMate[] = []
  /**
   * Boarded windows (windows.ts): the mess hall's windows on the road side. The window being rebuilt while
   * F is held, the wait until the next plank, and (on the guest) its rebuild points this round as the host
   * counts them.
   */
  barriers: Barriers | null = null
  private repairing: Barrier | null = null
  private repairWait = 0
  private barrierPaid = 0

  constructor(private scene: THREE.Scene, private camera: EnvironmentCamera, readonly player: FirstPersonController,
    readonly world: MissionWorld, private invalidate: () => void, seed = Math.floor(Math.random() * 2 ** 31)) {
    this.random = seeded(seed)
    this.seed = seed
    this.coop = new CoopLink(seed, message => this.coopMessage(message), status => this.coopStatusChanged(status), (id, joined) => this.coopPeer(id, joined))
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
    this.rockets = new InkRockets(scene, player.world, (origin, direction, max) => this.director?.aimDistance(origin, direction, max) ?? max)
    this.powerups = new PowerupDrops(scene)
    this.bottle = new PerkBottle(camera.perspective)
    this.syringe = new ReviveSyringe(camera.perspective)
    this.dropper = new PowerupDropper(this.random)
    this.bulletTrails = new BulletTrails(scene, 'Player bullet')
    player.lookSensitivity = () => lookScale(this.weapons.lookSensitivity, this.aiming)
    this.hud = new MissionHUD(world, {
      retry: () => { this.restart(); void this.audio.unlock(); this.player.requestControl() },
      restart: () => { this.restart(); void this.audio.unlock(); this.player.requestControl() },
      volume: () => this.applySettings(),
      mute: () => this.applySettings() }, { ...DEAD_INK_COPY, pages: [...(DEAD_INK_COPY.pages ?? []),
        { id: 'coop', label: 'Co-op', title: 'Play with a friend', build: body => this.buildCoopPanel(body), show: () => this.renderCoopPanel() }] })
    this.stopSettings = subscribeSettings(() => this.applySettings())
    this.applySettings()
    document.querySelector('#world')?.setAttribute('aria-label', 'Dead Ink, round-based zombies. Mouse to look, WASD move, left click fire, right click aim, mouse wheel switch weapon, V knife, F buy or use, R reload, Escape pause.')
    const hudRoot = document.querySelector<HTMLElement>('#mission-hud')!
    this.hudRoot = hudRoot
    this.zombieHud = new ZombieHud(hudRoot)
    this.hits = new HitMarkers(hudRoot)
    this.powerMarker = new WorldMarker(hudRoot, POWER_ICON, 'The power switch')
    this.indicator = new DamageIndicator(hudRoot)
    // One more cell than you start with, for Spare Nib's third gun; the hotbar hides cells you do not have.
    this.hotbar = new Hotbar(hudRoot, ZOMBIE_SLOTS + 1)
    this.addDifficultySetting()
    player.onPlayingChange = playing => { this.hud.setPlaying(playing); this.updateMusic() }
    player.actions.extraTargets = () => this.targets()
    player.actions.onAction = target => {
      this.weapons.cancel(); this.aiming = false; this.interactionTime = Math.max(this.interactionTime, 0.25)
      if (target.kind === 'door' || target.kind === 'ladder') this.emit({ kind: target.kind, position: target.point, radius: target.kind === 'door' ? 8 : 5 })
      if (target.kind === 'zipline') this.audio.play({ kind: 'zipline', duration: this.player.actions.rideSeconds })
    }
    this.bindInput()
    this.initialized = this.initialize()
    // Opened from an invite: join at once and show the co-op page, where the Start button is.
    const invite = new URLSearchParams(location.search).get('join')
    if (invite) {
      this.coop.open(invite)
      void this.initialized.then(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-menu-open="coop"]')?.click()))
    }
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
        damagePlayer: (id, amount, source, knock) => {
          const n = Math.round(amount * DIFFICULTY[this.difficulty].damage)
          // Targets are p1 for the host, p2 to p4 for guests 1 to 3.
          const player = Number(id.slice(1)) - 1
          if (player === 0) this.damage(n, 'zombie', source, knock)
          else if (player > 0) this.coop.send({ t: 'hurt', n, s: source ? vec(source) : undefined, k: knock ? vec(knock) : undefined }, { to: player })
        },
        // Whom the Brute's attacks can hurt, even while an Ink Doll has the zombies' attention.
        players: () => this.playerTargets(),
        onHit: hit => { this.impactPoint = hit.point.clone(); this.blood.emitHit(hit); this.audio.confirmHit(hit) },
        onRise: position => { this.riseMarks.emit(position); this.emit({ kind: 'zombie-rise', position, radius: 30 }) },
        onSlam: (position, radius) => { this.shockwaves.emit(position, radius); this.riseMarks.emit(position) } })
      await this.director.init(POOL_SIZE)
      this.applySettings()
      if (this.disposed) return
      // Every zone but the first shut behind its gate, before anything is placed.
      this.zones = new ZoneGates(this.scene, this.player.world, graph)
      this.zones.closeAll()
      // The mess hall's road-side windows boarded up: the only way in from the road (before anything is placed).
      this.barriers = new Barriers(this.scene, this.player.world, graph, event => this.emit(event))
      this.director.windows = this.barriers.list
      this.director.navigation.clear()
      this.player.world.warm()
      const floor = this.player.world.floor(this.spawn.clone().setY(0.6), 1, 1.5, 0.28)
      if (Number.isFinite(floor)) this.spawn.y = floor
      this.placeStations()
      // Mini map: its plan is built once, here, from the map as it now stands.
      this.minimap = new Minimap(this.zombieHud.root, { scene: this.scene, bounds: this.world.bounds, graph, home: this.spawn, power: this.powerSwitch?.point ?? null })
      // Junk, graffiti and hidden details, kept off every station, the doll wall and the skulls.
      const keepClear = [...this.wallBuys.map(b => b.spot.wall), ...this.boxSpots.map(s => s.wall),
        ...this.perkMachines.map(m => m.spot.wall), ...(this.pack ? [this.pack.spot.wall] : []),
        ...(this.dollBuy ? [this.dollBuy.spot.wall] : []), ...this.skulls.map(s => s.object.position),
        ...(this.powerSwitch ? [this.powerSwitch.spot.wall] : []), ...[...this.sites.values()].map(site => site.spot.wall),
        ...this.traps.flatMap(trap => [trap.centre, trap.point]), ...this.wells.map(well => well.root.position)]
      try { this.undress = addDressing(this.scene, this.player.world, seeded(0xDEAD1), keepClear) }
      catch (error) { console.warn('Dead Ink: dressing failed', error) }
      // Its solid props are not in the baked graph: zombies go round them, not into them.
      const solids = this.scene.getObjectByName('Dead Ink dressing')?.userData.solids
      if (solids) graph.closeSolids(this.player.world, solids)
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
    const spots = findWallSpots(graph, this.player.world, this.random, { count: WALL_WEAPONS.length + 1, near: 6, far: 70, spacing: 9, size: MysteryBox.SIZE })
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
      const [spot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 35, spacing: 7, avoid: taken, size: kind === 'pack' ? PackAPunch.SIZE : PerkMachine.SIZE })
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
    const [powerSpot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 30, spacing: 7, avoid: taken, size: PowerSwitch.SIZE })
    if (powerSpot) { taken.push(powerSpot.stand); this.powerSwitch = new PowerSwitch(powerSpot); this.scene.add(this.powerSwitch.root) }
    else console.warn('Dead Ink: no wall for the power switch')
    graph.flow([new THREE.Vector3(...BENCH_PLACE)])
    // Near its place if a wall there fits it, else further out: without a bench the shield cannot be built.
    const [benchSpot] = [30, 60, 120].map(far => findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far, spacing: 7, avoid: taken, size: BuildSite.BENCH })[0]).filter(Boolean)
    if (benchSpot) { taken.push(benchSpot.stand); const bench = new BuildSite('shield', benchSpot, true); this.sites.set('shield', bench); this.scene.add(bench.root) }
    else console.warn('Dead Ink: no wall for the shield bench')
    if (this.pack) { const site = new BuildSite('pack', this.pack.spot, false); this.sites.set('pack', site); this.scene.add(site.root) }
    this.soulStreams = new SoulStreams(this.scene)
    for (const [x, y, z] of INKWELL_PLACES) {
      const at = this.levelGround(new THREE.Vector3(x, y, z), 0.7)
      if (!at) { console.warn(`Dead Ink: nowhere for an inkwell near ${x}, ${z}`); continue }
      const well = new Inkwell(at)
      this.wells.push(well)
      this.scene.add(well.root)
      this.makeSolid(well.root, [1.25, 1.05, 1.25], [0, 0.52, 0])
    }
    for (const { gate, home } of TRAP_GATES) {
      const spec = ZONE_GATES.find(g => g.id === gate)
      if (!spec) continue
      const floor = this.player.world.floor(new THREE.Vector3(spec.centre[0], 1, spec.centre[1]), 1, 2, 0)
      const trap = new InkTrap(spec, home, Number.isFinite(floor) ? floor : 0)
      this.traps.push(trap)
      this.scene.add(trap.root)
    }
    if (this.box) this.boxSpots = [this.box.spot]
    for (const machine of this.perkMachines) this.makeSolid(machine.root, [1.05, 2.05, 0.7], [0, 1.025, 0])
    for (const [x, y, z] of BOX_PLACES) {
      graph.flow([new THREE.Vector3(x, y, z)])
      const [spot] = findWallSpots(graph, this.player.world, this.random, { count: 1, near: 0, far: 35, spacing: 7, avoid: taken, size: MysteryBox.SIZE })
      if (!spot) continue
      taken.push(spot.stand)
      this.boxSpots.push(spot)
    }
  }

  private startGame() {
    this.state = { phase: 'active', health: PLAYER_HEALTH.base, elapsed: 0, kills: 0, points: STARTING_POINTS, round: 0, headshots: 0, knifeKills: 0 }
    this.rounds = newGame()
    this.director?.clear()
    this.barriers?.reset(); this.repairing = null; this.barrierPaid = 0
    this.zones?.closeAll()
    this.director?.navigation.clear()
    if (this.box && this.boxSpots[0]) { this.box.place(this.boxSpots[0]); this.makeSolid(this.box.root, [1.44, 0.66, 0.64], [0, 0.33, 0]) }
    this.box?.close()
    this.powerups.clear(); this.timers = {}; this.earned = 0; this.heldWeapons = null
    this.perks.clear(); this.pendingPerk = null; this.reviveGrace = 0; this.applyPerks(); this.zombieHud.perks([])
    this.resetBuildables()
    this.revive.reset(); this.player.movementLocked = false
    beginGame(); this.shotsFired = 0; this.shotsHit = 0; this.lowHealth.clear()
    this.setStorm(false)
    this.brute = null; this.bruteTimer = -1
    for (const skull of this.skulls) { skull.found = false; skull.object.userData.found = false }
    this.music.stopStings()
    this.grenades.clear(); this.bolts.clear(); this.rockets.clear(); this.grenadeCount = GRENADE.start; this.grenadeCooldown = 0
    this.dolls.clear(); this.dollCount = 0; this.dollCooldown = 0; this.pendingThrows = []
    if (this.pack && this.pack.state !== 'idle') this.pack.take()
    this.dropper = new PowerupDropper(this.random)
    this.weapons.restore({ slots: [startingPistol(), null], selected: 0, pickups: [], nextId: 1 })
    this.player.actions.reset()
    // In co-op the guest starts a couple of metres beside the host, not inside them.
    const node = this.isGuest && this.graph ? this.graph.nearest(this.spawn.clone().add(new THREE.Vector3(2, 0, 0)), 2) : -1
    this.player.body.teleport(node >= 0 ? this.graph!.point(node).setY(this.spawn.y) : this.spawn.clone())
    this.player.world.refresh()
    this.player.body.update(1 / 60, new THREE.Vector3(), false)
    this.player.actions.syncCamera(this.camera.perspective)
    const look = this.wallBuys[0]?.point ?? this.spawn.clone().add(new THREE.Vector3(0, 1.7, -5))
    this.camera.perspective.lookAt(look.x, this.spawn.y + 1.7, look.z)
    this.safePosition.copy(this.player.body.position)
    this.lastHurt = -100; this.knifeCooldown = 0; this.strandTimer = 0
    this.down = 0; this.bleed = 0; this.reviving = 0; this.revivingId = -1; this.boxOwner = 0; this.partnerKills = 0
    this.downWeapons = null; this.player.crawling = false; this.player.actions.disabled = false; this.syringe.stop(); this.zombieHud.lastStand(null)
    this.lastTick = null
    this.partnerLures = []
    if (this.coop.role === 'host') { this.sendSync(); this.coop.send({ t: 'start' }) }
  }

  restart() {
    this.death.reset(); this.weapons.resetDeath(); this.playerHits.clear(); this.gameOverFlight.end(); delete document.body.dataset.deadInkOver
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
  /** In a game with the pause menu open. */
  private menuOpenInGame() { return this.ready && this.state.phase === 'active' && this.player.enabled && !this.player.playing && !this.player.immersive }
  /** Co-op pausing pauses everyone, as the host set it (the guests follow the host's setting). */
  private pauseEveryone() { return this.coop.role === 'host' ? getSettings().coopPause : this.lastTick?.fz !== 0 }
  /** With pausing for everyone off, the host's pause menu pauses only the host: the world runs on for the others. */
  private hostMenuKeepsWorld() { return this.coop.role === 'host' && this.paired && !this.pauseEveryone() && this.menuOpenInGame() }
  /**
   * A teammate paused: with pausing for everyone on, so does this player, so nobody plays on while time stands
   * still for the zombies. Resuming while they are still paused pauses again.
   */
  private followPause() {
    const pauser = this.paired && this.pauseEveryone() ? this.matesHere().find(mate => mate.state.ps === 1) : undefined
    this.hud.setPausedBy(pauser?.state.name ?? null)
    if (pauser && this.isActive()) this.player.pause()
  }
  private cancelInput() { this.aiming = false; this.weapons.cancel() }

  private keyDown = (event: KeyboardEvent) => {
    const zoomKey = event.code === 'KeyQ' || event.code === 'KeyE'
    if (event.ctrlKey || event.metaKey || event.altKey || (event.repeat && !zoomKey) || !this.player.enabled || this.player.immersive) return
    if (event.target instanceof HTMLElement && event.target.closest('button,input,select,textarea,summary,[contenteditable="true"]')) return
    if (!this.isActive()) return
    // Q zooms a scoped sniper; otherwise it throws a grenade (so does G). E zooms a scoped sniper in;
    // otherwise it throws an Ink Doll (so does T, which the pad uses).
    const scoped = this.aiming && this.weapons.current?.name === 'sniper'
    if (event.code === 'KeyT' || (event.code === 'KeyE' && !scoped)) {
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
    this.barrierTargets(targets, eye)
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
      const blurb = machine.kind === 'secondDraft' && this.paired ? 'Revive your partner twice as fast.' : perk.blurb
      const label = !this.power && !this.soloDraft(machine.kind) ? `${perk.name} · no power` : this.perks.has(machine.kind) ? `${perk.name} · yours`
        : this.perks.size >= PERK_LIMIT ? `${perk.name} · you can hold ${PERK_LIMIT} perks`
        : this.timers.deathMachine ? `${perk.name} · not while you hold the Death Machine`
        : `Drink ${perk.name} · ${perk.cost}${this.state.points >= perk.cost ? '' : ` · need ${perk.cost - this.state.points} more`} · ${blurb}`
      targets.push({ object: machine.root, point: machine.point, kind: 'mission', descending: false, label, use: () => this.buyPerk(machine) })
    }
    const pack = this.pack, held = this.weapons.current
    if (pack && this.packBuilt && this.questStep === 'pour' && pack.state === 'idle') {
      targets.push({ object: pack.root, point: pack.point, kind: 'mission', descending: false, label: 'Pour the three bottles of ink into the Pack-a-Punch', use: () => this.pourInk() })
    } else if (pack && this.packBuilt && pack.state !== 'working') {
      const label = !this.power && pack.state === 'idle' ? 'Pack-a-Punch · no power' : pack.state === 'ready' && pack.held ? `Take the ${pack.held.special === 'rayGun' ? 'Ink Ray X2' : PACKED_NAMES[pack.held.name]}`
        : !held || held.special === 'deathMachine' ? 'Pack-a-Punch · hold a gun to upgrade it'
        : packCost(held) === null ? 'Pack-a-Punch · fully upgraded'
        : `Pack-a-Punch · ${held.packed ? 'upgrade again' : 'upgrade'} your ${this.weapons.label} · ${packCost(held)}${this.state.points >= packCost(held)! ? '' : ` · need ${packCost(held)! - this.state.points} more`}`
      targets.push({ object: pack.root, point: pack.point, kind: 'mission', descending: false, label, use: () => this.usePack(pack) })
    }
    if (this.paired && !this.down) for (const mate of this.mates.values()) {
      if (mate.state?.dn !== 1 || mate.avatar.feet.distanceTo(this.player.body.position) >= COOP.reviveReach) continue
      targets.push({ object: mate.avatar.actor?.root ?? this.scene, point: mate.avatar.feet.clone().setY(mate.avatar.feet.y + 0.6), kind: 'mission', descending: false,
        label: `Hold to revive ${mate.state.name}`, use: () => {
          this.reviving = 0.001; this.revivingId = mate.id; this.player.movementLocked = true; this.cancelInput(); this.syringe.start(); return true } })
    }
    for (const part of this.parts) {
      if (part.point.distanceTo(eye) > 3 || !part.root.visible) continue
      targets.push({ object: part.root, point: part.point, kind: 'mission', descending: false, label: `Pick up the ${PARTS[part.id].label}`, use: () => this.pickPart(part) })
    }
    const power = this.powerSwitch
    if (power && power.state !== 'on') {
      const label = power.state === 'ready' ? 'Turn on the power'
        : this.carried.has('lever') ? 'Put the lever back on the power switch' : 'The power switch has lost its lever'
      targets.push({ object: power.root, point: power.point, kind: 'mission', descending: false, label, use: () => this.usePower(power) })
    }
    for (const well of this.wells) {
      if (!well.bottleWaiting || well.point.distanceTo(eye) > 3) continue
      targets.push({ object: well.root, point: well.point, kind: 'mission', descending: false, label: 'Take the bottle of ink', use: () => this.takeBottle(well) })
    }
    for (const trap of this.traps) {
      if (trap.point.distanceTo(eye) > 3) continue
      const gate = this.zones?.gates.find(g => g.spec.id === trap.spec.id)
      const label = !this.power ? 'Ink trap · no power' : gate && gate.state === 'closed' ? 'Ink trap · open the gate first'
        : trap.state === 'active' ? 'Ink trap · running' : trap.state === 'cooling' ? 'Ink trap · recharging'
        : `Ink trap · ${TRAP.cost}${this.state.points >= TRAP.cost ? '' : ` · need ${TRAP.cost - this.state.points} more`}`
      targets.push({ object: trap.root, point: trap.point, kind: 'mission', descending: false, label, use: () => this.useTrap(trap) })
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
    for (const trap of this.traps) trap.reset()
    this.questStep = 'power'; this.bottles = 0; this.editor = null; this.editorTimer = -1
    this.gasExposure = 0; this.gasDamage = 0; document.body.style.removeProperty('--dead-ink-gas')
    for (const well of this.wells) well.reset()
    this.soulStreams?.clear()
    this.packBuilt = false
    if (this.pack) { this.pack.root.visible = false; this.removeSolid(this.pack.root) }
    this.shield = null; this.shieldOnBench = false; this.shieldBackRound = 0
    this.carried.clear()
    for (const part of this.parts) part.dispose()
    this.parts = []
    const graph = this.graph
    // Two parts never share a spot, and none lies in a perk machine, the Pack-a-Punch, a box spot or a wall gun.
    const taken: THREE.Vector3[] = [...this.perkMachines.map(machine => machine.root.position), ...(this.pack ? [this.pack.root.position] : []),
      ...this.boxSpots.map(spot => spot.stand), ...this.wallBuys.map(buy => buy.spot.stand)]
    if (graph) for (const id of Object.keys(PARTS) as PartId[]) {
      const clear = PARTS[id].places.filter(([px, , pz]) => !taken.some(t => Math.hypot(t.x - px, t.z - pz) < 3))
      const places = clear.length ? clear : PARTS[id].places
      const [x, y, z] = places[Math.floor(this.random() * places.length) % places.length]
      // On the real floor at its place (a tower deck's middle, not the grid spot at its edge); the
      // zombies' grid is the fallback.
      const floor = this.player.world.floor(new THREE.Vector3(x, y + 1, z), 0.5, 2.5, 0.25)
      const node = Number.isFinite(floor) && Math.abs(floor - y) < 1.5 ? -1 : graph.nearest(new THREE.Vector3(x, y, z), 4)
      if (node < 0 && !(Number.isFinite(floor) && Math.abs(floor - y) < 1.5)) { console.warn(`Dead Ink: nowhere to put the ${PARTS[id].label}`); continue }
      const part = new PartPickup(id, node >= 0 ? graph.point(node) : new THREE.Vector3(x, floor, z))
      this.parts.push(part)
      taken.push(part.root.position)
      this.scene.add(part.root)
    }
    this.zombieHud.parts([])
    this.zombieHud.shield(null)
  }

  /** The power across the compound: perk machines light up (stuttering on), the Pack-a-Punch runs. */
  setPower(on: boolean, flicker = true) {
    this.power = on
    for (const machine of this.perkMachines) machine.setPowered(on || this.soloDraft(machine.kind), flicker)
  }

  /** Second Draft needs no power when you play alone (Call of Duty's solo Quick Revive). */
  private soloDraft(kind: PerkKind) { return kind === 'secondDraft' && !this.paired }

  private pickPart(part: PartPickup) {
    if (!this.isActive() || part.point.distanceTo(this.camera.perspective.position) > 3) return false
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'part', id: part.id }); return true }
    return this.takePart(part, null)
  }

  /** A part into the team's hands (the host decides; `by` is the guest who picked it up, null the host). */
  private takePart(part: PartPickup, by: number | null) {
    this.carried.add(part.id)
    this.parts.splice(this.parts.indexOf(part), 1)
    part.dispose()
    this.hud.notify(by !== null ? `${this.mateName(by)} found the ${PARTS[part.id].label}.` : `You found the ${PARTS[part.id].label}.`, 2.5)
    this.emit({ kind: 'pickup', position: this.player.body.position.clone(), radius: 3 })
    this.zombieHud.parts([...this.carried].map(id => PARTS[id].label))
    this.invalidate()
    return true
  }

  private usePower(power: PowerSwitch) {
    if (!this.isActive() || !this.canReach(power.point, power.root)) return false
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'power' }); return true }
    return this.workPower(power)
  }

  /** Fit the lever, or pull it: the power comes on for everyone. */
  private workPower(power: PowerSwitch) {
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
    this.shout('Power on', 3, 'powerup')
    this.emit({ kind: 'boss-slam', position: power.point.clone(), radius: 200 })
    this.invalidate()
    return true
  }

  /** At a build site: put in every part you carry for it; the last one finishes the build. */
  private useSite(site: BuildSite) {
    if (!this.isActive() || !this.canReach(site.point, site.root)) return false
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'site', build: site.build }); return true }
    return this.buildAt(site, null)
  }

  /** Fit the team's parts at a site, or take the finished shield (`by`: the guest at the site, null the host). */
  private buildAt(site: BuildSite, by: number | null) {
    if (site.complete) {
      if (by !== null) {
        if (site.build !== 'shield' || !this.shieldOnBench) return false
        this.shieldOnBench = false
        this.coop.send({ t: 'shield' }, { to: by })
        return true
      }
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
      this.shout('Pack-a-Punch built', 3, 'powerup')
      this.emit({ kind: 'pack-ready', position: this.pack.point.clone(), radius: 40 })
    }
    if (build === 'shield') {
      this.shieldOnBench = !this.shield
      this.zombieHud.announce('Ink shield built', 3, 'powerup')
      this.emit({ kind: 'pack-ready', position: (site?.point ?? this.player.body.position).clone(), radius: 20 })
    }
    if (build === 'power' && this.powerSwitch) { this.powerSwitch.repair(); this.powerSwitch.turnOn(); this.setPower(true) }
  }

  private useTrap(trap: InkTrap) {
    if (!this.isActive() || !this.canReach(trap.point, trap.root)) return false
    if (!this.power) { this.hud.notify('No power. Find the power switch.', 2.5, true); return false }
    const gate = this.zones?.gates.find(g => g.spec.id === trap.spec.id)
    if (gate && gate.state === 'closed') return false
    if (trap.state !== 'idle' || !this.spend(TRAP.cost)) return false
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'trap', index: this.traps.indexOf(trap) }); return true }
    trap.start()
    this.emit({ kind: 'pack-work', position: trap.point.clone(), radius: 20 })
    this.invalidate()
    return true
  }

  /**
   * Running traps: zombies in the jets die (no points; the Brute takes a steady beating), the player in
   * them gets hurt, and the ink hisses.
   */
  private updateTraps(dt: number) {
    const director = this.director
    this.trapTick -= dt
    const tick = this.trapTick <= 0
    if (tick) this.trapTick = 0.25
    for (const trap of this.traps) {
      trap.update(dt, this.power)
      if (trap.state !== 'active' || !director) continue
      if (!this.isGuest) for (const zombie of director.zombies) {
        if (zombie.state !== 'chase' || !trap.inside(zombie.position)) continue
        const chest = zombie.position.clone().setY(zombie.position.y + 1.1 * (zombie.boss ? BOSS.scale : 1))
        const damage = zombie.boss ? TRAP.bruteDps * dt : zombie.health + 1
        for (const hit of director.blast(chest, 0.3, damage)) {
          if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
        }
      }
      if (tick) {
        if (trap.inside(this.player.body.position)) this.damage(Math.round(TRAP.playerDps * 0.25), 'gas')
        if (Math.random() < 0.5) this.emit({ kind: 'ink-burst', position: trap.centre.clone().setY(trap.centre.y + 0.6), radius: 30 })
      }
    }
  }

  /** The quest moves on by itself as its conditions come true; the inkwells take in their souls. */
  private updateQuest(dt: number) {
    if (this.isGuest) {
      // The host counts the souls; here they are only seen and heard.
      for (const well of this.soulStreams?.update(dt, this.camera.perspective) ?? []) this.emit({ kind: 'soul-in', position: well.point.clone(), radius: 25 })
      for (const well of this.wells) well.update(dt)
      const souls = this.wells.reduce((sum, well) => sum + Math.min(QUEST.souls, well.souls), 0)
      this.zombieHud.quest(this.questLine(souls))
      return
    }
    if (this.questStep === 'power' && this.power) this.questStep = 'pack'
    if (this.questStep === 'pack' && this.packBuilt) {
      this.questStep = 'wells'
      for (const well of this.wells) well.wake()
      this.shout('The inkwells are thirsty', 3.5)
      this.hud.notify('Kill zombies near the inkwells to fill them.', 4)
    }
    for (const well of this.soulStreams?.update(dt, this.camera.perspective) ?? []) {
      this.emit({ kind: 'soul-in', position: well.point.clone(), radius: 25 })
      if (well.addSoul() && well.full) {
        this.emit({ kind: 'pack-ready', position: well.point.clone(), radius: 40 })
        this.hud.notify('An inkwell is full. Take its bottle.', 3)
      }
    }
    for (const well of this.wells) well.update(dt)
    if (this.questStep === 'wells' && this.bottles >= this.wells.length && this.wells.length) {
      this.questStep = 'pour'
      this.hud.notify('Three bottles of ink. The Pack-a-Punch is waiting.', 4)
    }
    if (this.editorTimer > 0 && (this.editorTimer -= dt) <= 0) this.spawnEditor()
    const souls = this.wells.reduce((sum, well) => sum + Math.min(QUEST.souls, well.souls), 0)
    this.zombieHud.quest(this.questLine(souls))
  }

  /** The quest line, spelling out the power step: find the lever, fit it, pull it. */
  private questLine(souls: number) {
    if (this.questStep === 'power' && this.powerSwitch) {
      if (this.powerSwitch.state === 'ready') return 'Pull the power switch'
      return this.carried.has('lever') ? 'Fit the lever on the power switch' : 'Find the power lever (it glints)'
    }
    return questHint(this.questStep, { souls, bottles: this.bottles })
  }

  private takeBottle(well: Inkwell) {
    if (!this.isActive() || well.point.distanceTo(this.camera.perspective.position) > 3) return false
    if (this.isGuest) { if (well.bottleWaiting) this.coop.send({ t: 'use', what: 'bottle', index: this.wells.indexOf(well) }); return well.bottleWaiting }
    if (!well.takeBottle()) return false
    this.bottles++
    this.emit({ kind: 'pickup', position: this.player.body.position.clone(), radius: 3 })
    this.hud.notify(`A bottle of ink (${this.bottles} of ${this.wells.length}).`, 2.5)
    return true
  }

  private pourInk(partner = false) {
    const pack = this.pack
    if (!pack || this.questStep !== 'pour') return false
    if (!partner && (!this.isActive() || !this.canReach(pack.point, pack.root))) return false
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'pour' }); return true }
    this.questStep = 'editor'
    this.bottles = 0
    this.editorTimer = QUEST.editorDelay
    this.shockwaves.emit(pack.root.position.clone(), 6)
    this.emit({ kind: 'boss-slam', position: pack.point.clone(), radius: 200 })
    this.shout('The press is running', 3)
    return true
  }

  /** The Editor climbs out near the Pack-a-Punch: the Brute's body, three times its health. */
  private spawnEditor() {
    const director = this.director, graph = this.graph, pack = this.pack
    if (!director || !graph || !pack) return
    graph.flow([this.player.body.position])
    const node = graph.nearest(pack.spot.stand, 4)
    const spot = node >= 0 ? graph.point(node).addScaledVector(pack.spot.normal, 3) : null
    const floorSpot = spot && director.navigation.floor(spot) ? spot : pickSpawn(graph, this.player.world, { near: 10, far: 30, eyes: [] }, this.random)
    const feet = this.player.body.position
    const health = Math.round(BOSS.health(this.rounds.round, 1 + this.matesHere().length) * QUEST.editorHealth * DIFFICULTY[this.difficulty].health)
    const editor = floorSpot && director.spawn(floorSpot, health, 'run', Math.atan2(feet.x - floorSpot.x, feet.z - floorSpot.z), true, true)
    if (!editor) { this.editorTimer = 1; return }
    this.editor = editor
    // The Brute's moves; the name on its health bar (for the guests too).
    if (editor.brute) editor.brute.editor = true
    this.riseMarks.emit(editor.position); this.riseMarks.emit(editor.position.clone().add(new THREE.Vector3(-0.7, 0, 0.5)))
    this.shout('The Editor', 3.5)
    this.emit({ kind: 'boss-roar', position: editor.position.clone().setY(editor.position.y + 3), radius: 250 })
  }

  /** The Editor is dead: the last edition is printed. Every perk, points, a Max Ammo and the song. */
  private finishQuest(position: THREE.Vector3) {
    this.editor = null
    this.questStep = 'done'
    this.award(2500)
    for (const kind of Object.keys(PERKS) as PerkKind[]) if (!this.perks.has(kind)) this.grantPerk(kind)
    const at = position.clone(), floor = this.player.world.floor(at.clone().setY(at.y + 2.2), 0.1, 3)
    if (Number.isFinite(floor)) at.y = floor
    this.dropPowerup('maxAmmo', at)
    if (!this.hud.reducedMotion) this.zombieHud.flash()
    this.shout('The Last Edition is printed', 6, 'powerup')
    this.hud.notify('You finished Dead Ink\'s story. Every perk is yours.', 6)
    this.sting('song')
    this.toastUnlocks(recordQuestComplete())
  }

  // ---------------------------------------------------------------- co-op

  /** This browser is the guest: its zombies are the host's, its world follows the host's. */
  get isGuest() { return this.coop.role === 'guest' }
  private get paired() { return this.coop.paired }

  /** A player's name, remembered in this browser. */
  private get playerName() {
    const fallback = `Player ${this.coop.id + 1}`
    try { return (localStorage.getItem('dead-ink-name') ?? '').trim().slice(0, 16) || fallback } catch { return fallback }
  }

  /** A teammate by number, made the first time we hear of them: their stickman, name tag and revive cross, in their colour. */
  private mate(id: number): Teammate {
    let mate = this.mates.get(id)
    if (!mate) {
      const color = PLAYER_COLORS[id] ?? PLAYER_COLORS[0], css = PLAYER_CSS[id] ?? PLAYER_CSS[0]
      const avatar = new PartnerAvatar(this.scene, color)
      void avatar.load()
      const marker = new WorldMarker(this.hudRoot, REVIVE_ICON, 'A downed teammate', 0)
      marker.element.classList.add('revive')
      mate = { id, state: null, avatar, tag: new PartnerTag(this.hudRoot, `Player ${id + 1}`, css), marker, css }
      this.mates.set(id, mate)
    }
    return mate
  }

  /** A teammate left: their stickman, tag and cross go. */
  private dropMate(id: number) {
    const mate = this.mates.get(id)
    if (!mate) return
    mate.avatar.dispose(); mate.tag.dispose(); mate.marker.dispose()
    this.mates.delete(id)
    this.partnerLures = []
  }

  private mateName(id: number) { return this.mates.get(id)?.state?.name || `Player ${id + 1}` }

  /** Teammates who have told us where they are. */
  private matesHere() { return [...this.mates.values()].filter((mate): mate is Teammate & { state: PlayerState } => !!mate.state) }

  private myState(): PlayerState {
    const cam = this.camera.perspective
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ')
    const body = this.player.body
    return { id: this.coop.id, p: vec(body.position), yaw: Math.round(e.y * 100) / 100, pitch: Math.round(e.x * 100) / 100, w: this.weapons.current?.name ?? null,
      mv: Math.hypot(body.velocity.x, body.velocity.z) > 0.6 ? 1 : 0, dn: this.down, pts: this.state.points, kills: this.state.kills, name: this.playerName,
      rv: this.reviving > 0 ? Math.round(this.reviving / this.reviveTime() * 100) / 100 : 0, rt: this.reviving > 0 ? this.revivingId : undefined,
      air: this.player.body.grounded ? undefined : 1, ps: this.menuOpenInGame() ? 1 : undefined }
  }

  /** The host tells a guest (or all of them) how the world stands: open gates, the power, the box's place. */
  private sendSync(to?: number) {
    if (this.coop.role !== 'host' || !this.paired) return
    this.coop.send({ t: 'sync', gates: (this.zones?.gates ?? []).filter(g => g.state !== 'closed').map(g => g.spec.id), power: this.power,
      box: this.box ? this.boxSpots.indexOf(this.box.spot) : 0, seed: this.seed, difficulty: this.difficulty }, to === undefined ? undefined : { to })
  }

  /** In a round: power-ups teammates walk into, bleeding out, reviving, the last stand's bar, and the game's end. */
  private coopFrame(dt: number) {
    if (!this.paired) return
    // Power-ups are the host's: it checks every guest's feet as well as its own.
    if (this.coop.role === 'host') for (const mate of this.matesHere())
      if (mate.state.dn === 0) for (const taken of this.powerups.collect(mate.avatar.feet)) this.grabbed(taken.kind, taken.position, mate.id)
    if (this.down === 1 && (this.bleed -= dt) <= 0) {
      // Bled out: nothing in your hands, flat on the floor until the next round.
      this.down = 2
      this.player.crawling = false
      this.player.movementLocked = true
      this.downWeapons = null
      this.weapons.restore({ slots: [null, null], selected: 0, pickups: [], nextId: this.weapons.snapshot().nextId })
      this.coop.send({ t: 'down', dn: 2 })
      this.hud.notify('You bled out. You will be back next round.', 4, true)
    }
    if (this.reviving > 0) {
      const mate = this.mates.get(this.revivingId)
      const near = !!mate && mate.state?.dn === 1 && mate.avatar.feet.distanceTo(this.player.body.position) < COOP.reviveReach
      // Held the whole way (F, or the pad's X): let go, step away or go down yourself and it stops.
      if (!mate || !near || this.down || !this.player.useHeld) { this.reviving = 0; this.player.movementLocked = this.down === 2; this.syringe.stop() }
      else if ((this.reviving += dt) >= this.reviveTime()) {
        this.reviving = 0
        this.player.movementLocked = false
        this.syringe.stop()
        // The host tells the guest; a guest asks the host to pass it on (or gets the host up itself).
        if (this.coop.role === 'host') this.coop.send({ t: 'revive', by: this.playerName }, { to: mate.id })
        else this.coop.send({ t: 'revive', target: mate.id, by: this.playerName })
        if (mate.state) mate.state.dn = 0
        this.award(COOP.revivePoints)
        this.hud.notify(`You got ${this.mateName(mate.id)} back up.`, 2.5)
      } else this.interactionTime = Math.max(this.interactionTime, 0.2)
    }
    // One bar under the crosshair: yours to fill, theirs filling for you, or your time running out.
    const helper = this.down === 1 ? this.matesHere().find(mate => mate.state.rv && mate.state.rt === this.coop.id) : undefined
    if (this.reviving > 0) this.zombieHud.lastStand(`Reviving ${this.mateName(this.revivingId)}`, this.reviving / this.reviveTime())
    else if (helper) this.zombieHud.lastStand(`${helper.state.name} is reviving you`, helper.state.rv!)
    else if (this.down === 1) this.zombieHud.lastStand('Bleeding out', this.bleed / COOP.bleedSeconds, 'bleed')
    else this.zombieHud.lastStand(null)
    // Everyone down (or out): the game is over for all.
    if (this.coop.role === 'host' && this.down && this.matesHere().every(mate => mate.state.dn)) {
      this.coop.send({ t: 'gameover' })
      this.gameOver()
    }
  }

  /** Every frame, playing or not: draw the teammates and the scoreboard, keep the lobby current, send our state. */
  private coopIdle(dt: number) {
    const paired = this.paired
    for (const mate of this.mates.values()) {
      const state = paired ? mate.state : null
      // A reviver kneels facing whoever they are reviving: us, or another teammate.
      mate.avatar.poses.reviveAt = state?.rv && state.rt !== undefined
        ? state.rt === this.coop.id ? this.player.body.position : this.mates.get(state.rt)?.avatar.feet ?? null : null
      mate.avatar.update(dt, state)
      if (state) mate.tag.name(state.name)
      mate.tag.update(this.camera.perspective, state ? mate.avatar.head() : null, !!state?.dn)
      mate.marker.update(this.camera.perspective, this.player.playing && state?.dn === 1 ? mate.avatar.feet.clone().setY(mate.avatar.feet.y + 0.9) : null)
    }
    this.powerMarker.update(this.camera.perspective, this.player.playing && !this.power && this.powerSwitch ? this.powerSwitch.point : null)
    this.zombieHud.scoreboard(paired ? [{ name: this.playerName, points: this.state.points, me: true, down: !!this.down, color: PLAYER_CSS[this.coop.id] },
      ...this.matesHere().sort((a, b) => a.id - b.id).map(mate => ({ name: mate.state.name, points: mate.state.pts, me: false, down: !!mate.state.dn, color: mate.css }))] : null)
    this.renderLobby()
    if (!paired || (this.sendTimer -= dt) > 0) return
    this.sendTimer = 1 / COOP.sendRate
    if (this.coop.role === 'host') {
      const debris = this.director?.brutes.debris.rows() ?? []
      this.coop.send({ t: 'tick', fz: getSettings().coopPause ? 1 : 0, z: this.director?.snapshot() ?? [], r: this.rounds.round, ph: this.rounds.phase, players: [this.myState(), ...this.matesHere().map(mate => mate.state)],
        storm: this.storm, pw: this.power ? 1 : 0, pk: this.packBuilt ? 1 : 0, w: this.worldState(), ...(debris.length ? { bd: debris } : {}) })
    } else this.coop.send({ t: 'me', me: this.myState() })
  }

  /** A shared announcement: shown here, and on the guest's screen when we are the host. */
  private shout(text: string, seconds = 3, tone?: string) {
    this.zombieHud.announce(text, seconds, tone)
    if (this.coop.role === 'host') this.coop.send({ t: 'announce', text, s: seconds, tone })
  }

  private sting(name: 'roundStart' | 'boxSpin' | 'song') {
    this.music.sting(name)
    if (this.coop.role === 'host') this.coop.send({ t: 'sting', name })
  }

  /** Down in co-op: on the floor until the partner gets you up, or you bleed out. */
  private goDown() {
    this.down = 1
    this.bleed = COOP.bleedSeconds
    this.state.health = 0
    this.losePerks()
    this.cancelInput()
    this.reviving = 0; this.syringe.stop()
    // The last stand, as Call of Duty: on the floor with a pistol, crawling, still shooting.
    if (this.timers.deathMachine && this.heldWeapons) { this.weapons.restore(this.heldWeapons); this.heldWeapons = null }
    delete this.timers.deathMachine
    this.lastStandPistol()
    this.player.movementLocked = false
    this.player.crawling = true
    this.player.actions.disabled = true
    this.player.body.velocity.set(0, 0, 0)
    this.revive.holdDown()
    this.audio.play({ kind: 'player-fall' })
    this.zombieHud.announce('You are down', 2.5)
    this.hud.notify('Crawl and keep shooting: a teammate can pick you up.', 4, true)
    this.coop.send({ t: 'down', dn: 1 })
  }

  /** Out comes the best pistol you carry (the Ink Ray first, as the Ray Gun in Call of Duty), or a spare one. */
  private lastStandPistol() {
    const snapshot = this.weapons.snapshot()
    this.downWeapons = snapshot
    const rank = (item: WeaponItem | null) => !item ? 0 : item.special === 'rayGun' ? 4 : item.name === 'magnum' ? 3 : item.name === 'pistol' ? 2 : 0
    const best = snapshot.slots.reduce<WeaponItem | null>((a, b) => rank(b) > rank(a) ? b : a, null)
    const pistol = best && best.magazine + best.reserve > 0 ? best : { ...startingPistol(), id: 'last-stand-pistol' }
    this.weapons.restore({ slots: [pistol, null], selected: 0, pickups: [], nextId: snapshot.nextId })
  }

  /** How long a revive takes you: Second Draft halves it. */
  private reviveTime() { return COOP.reviveSeconds * (this.perks.has('secondDraft') ? 0.5 : 1) }

  /** Back up: revived by the partner, or back at the start of a round after bleeding out. */
  private getUp(respawn = false) {
    if (!this.down) return
    this.down = 0
    this.bleed = 0
    this.state.health = PLAYER_HEALTH.base
    this.lastHurt = this.state.elapsed
    this.reviveGrace = 2
    this.revive.release()
    this.player.movementLocked = false
    this.player.crawling = false
    this.player.actions.disabled = false
    if (respawn) {
      this.downWeapons = null
      this.weapons.restore({ slots: [startingPistol(), null], selected: 0, pickups: [], nextId: 1 })
      this.revive.reset()
    } else if (this.downWeapons) {
      // Back up with every gun you went down with; the pistol keeps what it has left.
      const back = this.downWeapons, pistol = this.weapons.current
      this.downWeapons = null
      const same = pistol && back.slots.find(item => item?.id === pistol.id)
      if (same && pistol) { same.magazine = pistol.magazine; same.reserve = pistol.reserve }
      this.weapons.restore(back)
    }
    this.coop.send({ t: 'down', dn: 0 })
  }

  /** The host's buildables, traps and quest for the guest (small: sent with every tick). */
  private worldState(): WorldState {
    const placed: Record<string, string[]> = {}
    for (const [build, site] of this.sites) placed[build] = [...site.placed]
    return {
      parts: this.parts.map(p => [p.id, Math.round(p.root.position.x * 100) / 100, Math.round(p.root.position.y * 100) / 100, Math.round(p.root.position.z * 100) / 100]),
      carried: [...this.carried], placed, power: this.powerSwitch?.state ?? 'broken', shieldOnBench: this.shieldOnBench ? 1 : 0,
      traps: this.traps.map(t => [t.state, Math.round(t.timer * 10) / 10]), quest: this.questStep,
      wells: this.wells.map(w => [w.awake ? 1 : 0, w.souls, w.bottleTaken ? 1 : 0]), bottles: this.bottles,
      win: this.barriers?.counts(), wp: [0, 1, 2, 3].map(id => this.barriers?.ledger.paidBy(`p${id + 1}`, this.rounds.round) ?? 0),
    }
  }

  /** On the guest: make the parts, sites, switch, traps and inkwells look as the host has them. */
  private applyWorld(w: WorldState) {
    // Parts: rebuild the list when it differs (a new game, or one picked up).
    const key = w.parts.map(p => p.join(',')).join('|')
    if (key !== this.partsKey) {
      this.partsKey = key
      for (const part of this.parts) part.dispose()
      this.parts = w.parts.map(([id, x, y, z]) => { const part = new PartPickup(id as PartId, new THREE.Vector3(x, y, z)); this.scene.add(part.root); return part })
    }
    const carried = w.carried.join(',')
    if (carried !== [...this.carried].join(',')) {
      this.carried = new Set(w.carried as PartId[])
      this.zombieHud.parts([...this.carried].map(id => PARTS[id].label))
    }
    for (const [build, site] of this.sites) for (const id of w.placed[build] ?? []) if (!site.placed.has(id as PartId)) site.place(id as PartId)
    const power = this.powerSwitch
    if (power && power.state !== w.power) { if (w.power !== 'broken') power.repair(); if (w.power === 'on') power.turnOn() }
    this.shieldOnBench = !!w.shieldOnBench
    w.traps.forEach(([state, timer], i) => { const trap = this.traps[i]; if (trap && trap.state !== state) { trap.state = state; trap.timer = timer } })
    this.questStep = w.quest as QuestStep
    w.wells.forEach(([awake, souls, taken], i) => {
      const well = this.wells[i]
      if (!well) return
      if (awake && !well.awake) well.wake()
      while (well.souls < souls) well.addSoul()
      if (taken && !well.bottleTaken) well.takeBottle()
    })
    this.bottles = w.bottles
    if (w.win) this.barriers?.apply(w.win)
    this.barrierPaid = w.wp?.[this.coop.id] ?? 0
  }

  /** Every message from the other browsers (on the host, `from` says which guest). */
  private coopMessage(m: CoopIncoming) {
    const from = m.from ?? 0
    switch (m.t) {
      // ---- on the guest
      case 'sync': {
        for (const gate of this.zones?.gates ?? []) if (m.gates.includes(gate.spec.id) && gate.state === 'closed') this.zones!.open(gate)
        if (m.power !== this.power) this.setPower(m.power, false)
        const spot = this.boxSpots[m.box]
        if (this.box && spot && this.box.spot !== spot) { this.box.place(spot); this.makeSolid(this.box.root, [1.44, 0.66, 0.64], [0, 0.33, 0]) }
        break
      }
      case 'tick': {
        const newRound = this.lastTick && m.r > this.lastTick.r
        this.lastTick = m
        // Everyone else, as the host sees them; anyone missing has left.
        for (const player of m.players) if (player.id !== this.coop.id) this.mate(player.id).state = player
        for (const id of [...this.mates.keys()]) if (!m.players.some(player => player.id === id)) this.dropMate(id)
        if (!!m.pw !== this.power) this.setPower(!!m.pw)
        if (m.pk && !this.packBuilt) this.completeBuild('pack')
        if (m.w) this.applyWorld(m.w)
        if (m.bd) this.director?.brutes.debris.sync(m.bd)
        if (newRound) {
          if (this.down === 2) this.getUp(true)
          this.grenadeCount = Math.min(GRENADE.max, this.grenadeCount + GRENADE.perRound)
          if (this.liveBoss(false)) this.bruteCarriesOver()
        }
        break
      }
      case 'award':
        this.state.points += m.n
        this.zombieHud.gain(m.n)
        if (m.k) { this.state.kills += m.k; this.state.headshots += m.h ?? 0; for (let i = 0; i < m.k; i++) this.toastUnlocks(recordKill({ weapon: this.weapons.current?.special ? null : this.weapons.current?.name ?? null, headshot: i < (m.h ?? 0), packed: !!this.weapons.current?.packed, packLevel: this.weapons.current?.packLevel, round: this.rounds.round, special: !!this.weapons.current?.special })) }
        break
      case 'hit':
        this.hitFlash = 0.15
        this.hits.hit(toVector(m.pt), m.dealt, m.id, !!m.head, !!m.lethal)
        if (!m.pt) break
        this.shotsHit += this.pullHit ? 0 : 1; this.pullHit = true
        break
      case 'hurt': this.damage(m.n, 'zombie', m.s ? toVector(m.s) : undefined, m.k ? toVector(m.k) : undefined); break
      case 'announce': this.zombieHud.announce(m.text, m.s, m.tone); break
      case 'sting': this.music.sting(m.name); break
      case 'gate': {
        const gate = this.zones?.gates.find(g => g.spec.id === m.id)
        if (gate && gate.state === 'closed') { this.zones!.open(gate); this.emit({ kind: 'door', position: this.zones!.nearestPoint(gate, this.camera.perspective.position), radius: 30 }) }
        break
      }
      case 'box': {
        const box = this.box
        if (!box) break
        if (m.a === 'spin' && m.r) { box.spin({ name: m.r.name, rarity: m.r.rarity as Rarity, special: m.r.special }, !!m.teddy); this.boxOwner = m.by ?? 0; this.music.sting('boxSpin') }
        else if (m.a === 'take') box.take()
        else if (m.a === 'close') box.close()
        else if (m.a === 'move' && m.spot !== undefined && this.boxSpots[m.spot]) { box.place(this.boxSpots[m.spot]); this.makeSolid(box.root, [1.44, 0.66, 0.64], [0, 0.33, 0]) }
        break
      }
      case 'drop': this.powerups.spawn(m.k, toVector(m.p)); this.emit({ kind: 'powerup-drop', position: toVector(m.p), radius: 40 }); break
      case 'grab': this.powerups.removeNear(m.k, toVector(m.p)); this.activate(m.k, m.by === this.coop.id ? 'me' : 'partner'); break
      case 'boom': this.blastLook(toVector(m.p), m.r, m.k); break
      case 'gameover': if (this.state.phase === 'active') this.gameOver(); break
      case 'start':
        // The host pressed Start: jump in (the page needs a click of ours to take the mouse).
        this.hud.notify(`${this.mateName(0)} started the game.`, 3)
        this.coopPanel?.classList.add('started')
        break
      // ---- on the host
      case 'me': this.mate(from).state = { ...m.me, id: from }; break
      case 'shot': this.partnerShot(m, from); break
      case 'knife': this.partnerKnife(m, from); break
      case 'blast': this.partnerBlast(toVector(m.p), m.r, m.dmg, from, m.k); break
      case 'use':
        if (m.what === 'gate') {
          const gate = this.zones?.gates.find(g => g.spec.id === m.id)
          if (gate && gate.state === 'closed') {
            this.zones!.open(gate)
            this.emit({ kind: 'door', position: this.zones!.nearestPoint(gate, this.player.body.position), radius: 30 })
            this.hud.notify(`${this.mateName(from)} opened ${gate.spec.zone}.`, 2.5)
            this.coop.send({ t: 'gate', id: gate.spec.id })
          }
        } else if (m.what === 'box') this.spinBox(from, m.guns)
        else if (m.what === 'box-take') this.box?.take()
        else if (m.what === 'part') { const part = this.parts.find(p => p.id === m.id); if (part) this.takePart(part, from) }
        else if (m.what === 'site') { const site = this.sites.get(m.build as BuildId); if (site) this.buildAt(site, from) }
        else if (m.what === 'power' && this.powerSwitch) this.workPower(this.powerSwitch)
        else if (m.what === 'trap') { const trap = this.traps[m.index]; if (trap && trap.state === 'idle' && this.power) { trap.start(); this.emit({ kind: 'pack-work', position: trap.point.clone(), radius: 20 }) } }
        else if (m.what === 'bottle') { const well = this.wells[m.index]; if (well?.takeBottle()) { this.bottles++; this.hud.notify(`${this.mateName(from)} took a bottle of ink (${this.bottles} of ${this.wells.length}).`, 2.5) } }
        else if (m.what === 'pour') this.pourInk(true)
        else if (m.what === 'window') this.partnerRebuild(m.index, from)
        break
      case 'lure': this.partnerLures.push({ position: toVector(m.p), left: m.s }); break
      case 'shield':
        this.shield = { health: SHIELD.health }
        this.hud.notify('The shield is on your back: it takes hits from behind.', 3)
        this.zombieHud.shield(1)
        break
      // ---- both
      case 'revive':
        // On the host, a guest's revive of another guest is passed on.
        if (this.coop.role === 'host' && m.target !== undefined && m.target !== 0) {
          this.coop.send({ t: 'revive', by: m.by }, { to: m.target })
          const mate = this.mates.get(m.target)
          if (mate?.state) mate.state.dn = 0
        } else { this.getUp(); this.hud.notify(`${m.by ?? 'A teammate'} got you back up.`, 2.5) }
        break
      case 'fire': {
        // A teammate's shot: its tracer (green for the Ink Ray, red once upgraded) and its report where they stand.
        const o = toVector(m.o), e = toVector(m.e), ray = m.w === 'raygun'
        // Dead Ink weapons: a teammate's Ink Rocket is seen flying, not as a tracer (its burst comes as a blast).
        if (m.w === 'rocket') this.rockets.fire(o, e.clone().sub(o), rocketLoad({ name: 'rocket', packed: !!m.pk }), true)
        else this.bulletTrails.emit(o, e, ray ? 'pistol' : m.w as WeaponName, undefined, undefined, m.pk ? PACKED_TRACER : ray ? RAY_TRACER : undefined)
        this.audio.play({ kind: ray ? 'shot-raygun' : `shot-${m.w}`, position: o, radius: 55, packed: m.pk })
        if (this.coop.role === 'host' && m.from !== undefined) this.coop.send({ t: 'fire', o: m.o, e: m.e, w: m.w, pk: m.pk }, { skip: m.from })
        break
      }
      case 'soul': {
        const well = this.wells[m.i]
        if (well) { const from = toVector(m.p); this.soulStreams?.emit(from, well); this.emit({ kind: 'soul', position: from, radius: 30 }) }
        break
      }
      case 'down': { const mate = this.mates.get(from); if (mate?.state) mate.state.dn = m.dn; break }
    }
  }

  private coopStatusChanged(status: CoopStatus) {
    this.coopStatus = status
    // Second Draft's machine is lit without power only when alone.
    this.setPower(this.power, false)
    if (status.kind === 'error' || status.kind === 'waiting' || status.kind === 'alone') {
      for (const id of [...this.mates.keys()]) this.dropMate(id)
      this.zombieHud.lastStand(null)
    }
    this.renderCoopPanel()
  }

  /** Someone joined or left: the host brings a newcomer up to date; whoever left goes. */
  private coopPeer(id: number, joined: boolean) {
    if (joined && this.coop.role === 'host') this.sendSync(id)
    if (!joined) this.dropMate(id)
    this.lobbyKey = ''
  }

  /** The host works out a guest's shot against its zombies, and sends back the points and hit markers. */
  private partnerShot(m: Extract<CoopMessage, { t: 'shot' }>, from: number) {
    const director = this.director
    if (!director) return
    const origin = toVector(m.o), direction = toVector(m.d).normalize()
    const shot: ShotType = { origin, direction, range: m.range, damage: m.damage, weapon: m.weapon, pelletIndex: m.pellet }
    const surface = this.player.world.raySurface(origin, direction, m.range)
    const struck = director.hitAll(shot, surface?.distance ?? m.range, m.scale, !!this.timers.instaKill, m.pierce)
    let points = 0, kills = 0, heads = 0
    for (const each of struck) {
      const head = each.reaction.zone === 'head'
      points += pointsForHit({ lethal: each.lethal, zone: each.reaction.zone })
      this.coop.send({ t: 'hit', pt: vec(each.reaction.point), dealt: each.dealt, id: each.zombie.id, head: head ? 1 : 0, lethal: each.lethal ? 1 : 0 }, { to: from })
      if (each.lethal) { kills++; if (head) heads++; this.partnerKills++; this.killed(each.zombie.position, each.zombie, null, head, from) }
    }
    if (points) this.coop.send({ t: 'award', n: this.timers.doublePoints ? points * 2 : points, k: kills, h: heads }, { to: from })
  }

  private partnerKnife(m: Extract<CoopMessage, { t: 'knife' }>, from: number) {
    const hit = this.director?.knife(toVector(m.o), toVector(m.f).normalize(), m.range, m.damage, !!this.timers.instaKill)
    if (!hit) return
    const points = pointsForHit({ lethal: hit.lethal, zone: hit.reaction.zone, knife: true })
    this.coop.send({ t: 'hit', pt: vec(hit.reaction.point), dealt: hit.dealt, id: hit.zombie.id, head: 0, lethal: hit.lethal ? 1 : 0 }, { to: from })
    if (hit.lethal) { this.partnerKills++; this.killed(hit.zombie.position, hit.zombie, null, false, from) }
    this.coop.send({ t: 'award', n: this.timers.doublePoints ? points * 2 : points, k: hit.lethal ? 1 : 0 }, { to: from })
  }

  /** A guest's grenade, doll, Ink Ray bolt, rocket or Deadline round going off: the host does the damage, the guest gets the points. */
  private partnerBlast(at: THREE.Vector3, radius: number, damage: number, from: number, kind?: BlastKind) {
    const director = this.director
    if (!director) return
    let points = 0, kills = 0
    for (const hit of director.blast(at, radius, damage)) {
      points += pointsForHit({ lethal: hit.lethal, explosive: true })
      if (hit.lethal) { kills++; this.partnerKills++; this.killed(hit.zombie.position, hit.zombie, null, false, from) }
    }
    this.blastLook(at, radius, kind)
    // The other guests see it go off too.
    this.coop.send({ t: 'boom', p: vec(at), r: radius, k: kind }, { skip: from })
    if (points) this.coop.send({ t: 'award', n: this.timers.doublePoints ? points * 2 : points, k: kills }, { to: from })
  }

  /** The box spins for a player (the host 0, or a guest); its gun is for whoever paid. */
  private spinBox(by: number, guns: readonly WeaponName[] = []) {
    const box = this.box
    if (!box) return false
    if (box.state !== 'idle') { if (by !== 0) this.coop.send({ t: 'award', n: PRICES.box }, { to: by }); return false }
    const held = by === 0 ? this.weapons.slots : guns.map(name => ({ id: name, name, magazine: 0, reserve: 0 }))
    const teddy = box.uses >= BOX_TEDDY_AFTER && this.boxSpots.length > 1 && this.random() < BOX_TEDDY_CHANCE
    const result = rollBox(this.random, held)
    box.spin(result, teddy)
    this.boxOwner = by
    this.coop.send({ t: 'box', a: 'spin', r: { name: result.name, rarity: result.rarity, special: result.special }, teddy, by })
    this.emit({ kind: 'box-open', position: box.point.clone(), radius: 25 })
    this.sting('boxSpin')
    return true
  }

  /** The co-op part of the Dead Ink home card: invite a friend, or the state of joining one. */
  private buildCoopPanel(slot: HTMLElement) {
    const panel = document.createElement('div')
    panel.className = 'coop-panel'
    slot.append(panel)
    this.coopPanel = panel
    this.renderCoopPanel()
  }

  private renderCoopPanel() {
    const panel = this.coopPanel
    if (!panel) return
    const s = this.coopStatus
    const name = `<label class="coop-name">Your name <input maxlength="16" value="${this.playerName.replace(/"/g, '')}" aria-label="Your name"></label>`
    const escapeHtml = (text: string) => text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
    let body: string
    if (s.kind === 'idle') body = `<button type="button" class="coop-invite">Play with a friend</button><p>Send them a link: they play in their browser, nothing to install.</p>`
    else if (s.kind === 'connecting') body = '<p>Connecting…</p>'
    else if (s.kind === 'waiting') body = `<p><strong>Send this link to your friend:</strong></p><div class="coop-link"><input readonly value="${escapeHtml(s.link)}" aria-label="Invite link"><button type="button" class="coop-copy">Copy</button></div><p>Waiting for them to open it… <button type="button" class="coop-cancel">Cancel</button></p>`
    else if (s.kind === 'paired') body = (s.role === 'host'
      ? `<div class="coop-link"><input readonly value="${escapeHtml(s.link)}" aria-label="Invite link"><button type="button" class="coop-copy">Copy</button></div><div class="coop-players"></div><p>Up to four players. Start when everyone is here.</p><button type="button" class="coop-start">Start</button>`
      : '<div class="coop-players"></div><p class="coop-wait">Waiting for the host to start.</p><button type="button" class="coop-start">Jump in</button>')
    else if (s.kind === 'alone') body = '<p>Joined. Waiting for your friend\'s game…</p>'
    else body = `<p class="coop-error">${escapeHtml(s.reason)}</p><button type="button" class="coop-invite">Try again</button>`
    panel.innerHTML = `<h3>Co-op</h3>${name}${body}`
    this.lobbyKey = ''
    this.renderLobby()
    panel.querySelector<HTMLInputElement>('.coop-name input')?.addEventListener('change', event => {
      try { localStorage.setItem('dead-ink-name', (event.target as HTMLInputElement).value.trim().slice(0, 16)) } catch { /* private window */ }
    })
    panel.querySelector('.coop-invite')?.addEventListener('click', () => {
      const join = new URLSearchParams(location.search).get('join')
      this.coop.open(s.kind === 'error' && join ? join : undefined)
    })
    panel.querySelector('.coop-start')?.addEventListener('click', () => document.querySelector<HTMLElement>('#walk-start')?.click())
    panel.querySelector('.coop-cancel')?.addEventListener('click', () => { this.coop.close(); this.coopStatusChanged({ kind: 'idle' }) })
    panel.querySelector('.coop-copy')?.addEventListener('click', event => {
      const input = panel.querySelector<HTMLInputElement>('.coop-link input')!
      void navigator.clipboard?.writeText(input.value).catch(() => { input.select(); document.execCommand('copy') })
      ;(event.target as HTMLButtonElement).textContent = 'Copied'
    })
  }

  /** The co-op lobby: who is here, in their colours, the host first. Cheap when nothing changed. */
  private renderLobby() {
    const list = this.coopPanel?.querySelector<HTMLElement>('.coop-players')
    if (!list) return
    const players = [{ id: this.coop.id, name: this.playerName, me: true }, ...this.matesHere().map(mate => ({ id: mate.id, name: mate.state.name, me: false }))]
      .sort((a, b) => a.id - b.id)
    const key = players.map(player => `${player.id}:${player.name}`).join('|') + `|${this.coop.peers.size}`
    if (key === this.lobbyKey) return
    this.lobbyKey = key
    const clean = (text: string) => text.replace(/[<>&"]/g, '')
    // Guests who joined but have not said their name yet still count.
    const waiting = this.coop.role === 'host' ? Math.max(0, this.coop.peers.size - (players.length - 1)) : 0
    list.innerHTML = `<strong>Players ${players.length + waiting} of 4</strong><ul>${players.map(player =>
      `<li style="--tag: ${PLAYER_CSS[player.id] ?? PLAYER_CSS[0]}">${clean(player.name)}${player.id === 0 ? ' (host)' : ''}${player.me ? ' · you' : ''}</li>`).join('')}${
      Array.from({ length: waiting }, () => '<li class="joining">Joining…</li>').join('')}</ul>`
  }

  private removeSolid(owner: THREE.Object3D) {
    const old = this.solids.get(owner)
    if (!old) return
    this.player.world.removeObject(old)
    this.solids.delete(owner)
  }

  /** A challenge done: a short toast with what it unlocked. */
  private toastUnlocks(list: ChallengeUnlock[]) { if (list.length) this.hud.notify(list.map(u => u.title).join(' · '), 4, true) }

  /** Volumes and mute from the settings store: master x music for the songs, master x effects for the rest. */
  private applySettings() {
    const s = getSettings()
    // Blood: red, black ink, or off (the ink gore goes with it when off).
    const blood = (s as { blood?: 'red' | 'ink' | 'off' }).blood ?? 'red'
    this.blood.setMode(blood)
    if (this.director) this.director.gore.root.visible = blood !== 'off'
    this.audio.setMuted(s.muted); this.music.setMuted(s.muted)
    this.audio.setVolume(volumeFor(s, 'effects')); this.music.setVolume(volumeFor(s, 'music'))
  }

  private useDollWall(buy: DollBuy) {
    if (!this.isActive() || !this.canReach(buy.point, buy.root) || this.dollCount >= DECOY.carry || !this.spend(DECOY.price)) return false
    this.dollCount = DECOY.carry
    this.hud.notify('Ink Dolls: throw one with E and every zombie goes for it.', 3)
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
    this.coopBlast(at, DECOY.radius, this.blastDamage('dollBlast'))
    if (this.isGuest) return
    const damage = zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * 3
    for (const hit of director.blast(at, DECOY.radius, damage)) {
      this.award(pointsForHit({ lethal: hit.lethal, explosive: true }))
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
    // Long Stroke: sprint for as long as you like.
    this.player.unlimitedSprint = this.perks.has('longStroke')
  }

  private buyPerk(machine: PerkMachine) {
    const perk = PERKS[machine.kind]
    if (!this.isActive() || !this.canReach(machine.point, machine.root)) return false
    // Every refusal says why: a machine that ignores F reads as a broken one.
    const refusal = this.timers.deathMachine ? 'Not while you hold the Death Machine.'
      : this.pendingPerk ? 'Finish the one you are drinking first.'
      : !this.power && !this.soloDraft(machine.kind) ? 'No power. Find the power switch.'
      : this.perks.has(machine.kind) ? `You already have ${perk.name}.`
      : this.perks.size >= PERK_LIMIT ? `You can hold ${PERK_LIMIT} perks.` : null
    if (refusal) { this.hud.notify(refusal, 2.5, true); return false }
    if (!this.spend(perk.cost)) return false
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
    if (pack.state !== 'idle' || !current || current.special === 'deathMachine' || cost === null || this.timers.deathMachine || !this.spend(cost)) return false
    // The gun goes in: your hands move to your other gun, or stay empty, until it comes out.
    const snapshot = this.weapons.snapshot()
    snapshot.slots[snapshot.selected] = null
    const other = snapshot.slots.findIndex(Boolean)
    if (other >= 0) snapshot.selected = other
    this.weapons.restore(snapshot)
    const level = (current.packed ? current.packLevel ?? 1 : 0) + 1
    const upgraded = { ...current, id: `${current.id}-packed${level}`, packed: true, packLevel: level }
    const capacity = weaponRules(upgraded).capacity
    pack.insert({ ...upgraded, magazine: capacity, reserve: current.special === 'rayGun' ? INK_RAY.packedReserve : spareAmmo(upgraded) })
    this.emit({ kind: 'pack-work', position: pack.point.clone(), radius: 30 })
    this.invalidate()
    return true
  }

  /**
   * Zombies are solid to you, as in Call of Duty: walk into one and you stop; get surrounded and you are
   * boxed in. Runs after both have moved; a push never takes you into a wall.
   */
  /**
   * Co-op blasts: the guest's go to the host (which does the damage and pays the guest) and are drawn
   * here; the host's are drawn on the guest's screen too.
   */
  private coopBlast(at: THREE.Vector3, radius: number, damage: number, kind?: BlastKind) {
    if (!this.paired) return
    if (this.isGuest) {
      this.coop.send({ t: 'blast', p: vec(at), r: radius, dmg: damage, k: kind })
      this.blastLook(at, radius, kind)
    } else this.coop.send({ t: 'boom', p: vec(at), r: radius, k: kind })
  }

  /**
   * What each kind of blast deals, the same numbers the host uses for its own. A frag's is fixed, as in Call
   * of Duty (grenades.ts); the Ink Doll's and the Ink Ray's still rise with the round, as their wonder does.
   */
  private blastDamage(kind: string) {
    const health = zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health
    return kind === 'dollBlast' ? health * 3 : kind === 'boltBurst' ? Math.max(1500, health * 1.6) : GRENADE.damage
  }

  /** How a blast shows: a frag's burst (the Ink Doll's and the Ink Ray's too, as before), a rocket's, a Deadline round's pop. */
  private blastLook(at: THREE.Vector3, radius: number, kind: BlastKind = 'grenade') {
    this.explosions.emit(at, kind === 'round' ? DEADLINE_ROUND.look : radius)
    this.emit({ kind: kind === 'rocket' ? 'rocket-boom' : kind === 'round' ? 'round-burst' : 'grenade-blast', position: at.clone(), radius: kind === 'rocket' ? 160 : 120 })
  }

  private blockByZombies() {
    const body = this.player.body, feet = body.position
    const push = new THREE.Vector3()
    for (const zombie of this.director?.zombies ?? []) {
      if (zombie.state !== 'chase' || zombie.rise > 0 || zombie.climb || this.director?.flyers.owns(zombie)) continue
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
  /**
   * Level ground near `near` for something round standing in the open (an inkwell): the whole base flat,
   * on the ground rather than half on a platform's lip, with room around it. Rings out to 6 m.
   */
  private levelGround(near: THREE.Vector3, radius: number) {
    const world = this.player.world, probe = new THREE.Vector3(), room = new Capsule()
    for (let ring = 0; ring <= 8; ring++) {
      const steps = ring ? ring * 6 : 1
      for (let s = 0; s < steps; s++) {
        const angle = s / steps * Math.PI * 2, x = near.x + Math.cos(angle) * ring * 0.75, z = near.z + Math.sin(angle) * ring * 0.75
        const floor = world.floor(probe.set(x, near.y + 0.6, z), 0.6, 1.5)
        if (!Number.isFinite(floor) || Math.abs(floor - near.y) > 0.3) continue
        let level = true
        for (let i = 0; i < 8 && level; i++) {
          const around = world.floor(probe.set(x + Math.cos(i * Math.PI / 4) * radius, floor + 0.5, z + Math.sin(i * Math.PI / 4) * radius), 0.5, 0.6)
          level = Number.isFinite(around) && Math.abs(around - floor) < 0.04
        }
        room.start.set(x, floor + radius + 0.05, z); room.end.set(x, floor + 1.6, z); room.radius = radius
        if (level && world.fits(room)) return new THREE.Vector3(x, floor, z)
      }
    }
    return null
  }

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
    this.music.setMode(this.state.phase === 'dead' ? 'dead' : !this.player.playing ? 'menu' : this.liveBoss() ? 'boss' : 'play')
  }

  /**
   * The living boss whose health bar shows: the Editor before the Brute (`editor` false: the Brute alone). A
   * guest has no Brute of its own: its bosses are the host's, drawn from the snapshot.
   */
  private liveBoss(editor = true): Zombie | null {
    if (!this.isGuest) return editor && this.editor?.state === 'chase' ? this.editor : this.bruteHunting ? this.brute : null
    const bosses = this.director?.zombies.filter(z => z.brute && z.state === 'chase') ?? []
    return (editor ? bosses.find(z => z.brute!.editor) : undefined) ?? bosses.find(z => !z.brute!.editor) ?? null
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
    if (!box || this.isGuest) return
    // The teddy bear's refund goes to whoever paid.
    if (this.paired && this.boxOwner !== 0) this.coop.send({ t: 'award', n: PRICES.box }, { to: this.boxOwner })
    else { this.state.points += PRICES.box; this.zombieHud.gain(PRICES.box) }
    const others = this.boxSpots.filter(spot => spot !== box.spot)
    box.place(others[Math.floor(this.random() * others.length)] ?? box.spot)
    this.coop.send({ t: 'box', a: 'move', spot: this.boxSpots.indexOf(box.spot) })
    this.makeSolid(box.root, [1.44, 0.66, 0.64], [0, 0.33, 0])
    this.hud.notify('The Mystery Box has moved. Follow its light.', 3.5)
    this.emit({ kind: 'box-leave', position: this.player.body.position.clone(), radius: 5 })
  }

  /** Pay to open a zone: the gate sinks into the ink and zombies can now come from the other side too. */
  private useGate(gate: ZoneGate) {
    if (!this.isActive() || !this.zones || gate.state !== 'closed') return false
    const point = this.zones.nearestPoint(gate, this.camera.perspective.position)
    if (!this.canReach(point, gate.closed) || !this.spend(gate.spec.cost)) return false
    // The guest asks; the host opens it for both.
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'gate', id: gate.spec.id }); return true }
    this.zones.open(gate)
    this.coop.send({ t: 'gate', id: gate.spec.id })
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
      // In co-op the gun is for whoever paid.
      if (this.paired && this.boxOwner !== this.coop.id) return false
      const offer = box.take()
      if (this.paired) this.coop.send(this.isGuest ? { t: 'use', what: 'box-take' } : { t: 'box', a: 'take' })
      if (!offer) return false
      const item = freshWeapon(`box-${offer.name}-${Math.floor(this.state.elapsed * 1000)}`, offer.name, offer.rarity)
      this.weapons.give(offer.special ? { ...item, special: offer.special, magazine: INK_RAY.magazine, reserve: INK_RAY.reserve } : item)
      this.invalidate()
      return true
    }
    if (box.state !== 'idle' || !this.spend(PRICES.box)) return false
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'box', guns: this.weapons.slots.filter(Boolean).map(s => s!.name) }); return true }
    this.spinBox(0)
    this.invalidate()
    return true
  }

  // ---------------------------------------------------------------- boarded windows (windows.ts)

  /** From inside, at a window with planks missing: hold F to nail them back, a plank at a time. */
  private barrierTargets(targets: ActionTarget[], eye: THREE.Vector3) {
    const barriers = this.barriers
    if (!barriers) return
    const left = this.isGuest ? WINDOW.roundCap - this.barrierPaid : barriers.ledger.left('p1', this.rounds.round)
    for (const barrier of barriers.list) {
      if (barrier.boards >= WINDOW.boards || barrier.vaulting || !barrier.inside(eye) || barrier.point.distanceTo(eye) > 2.65) continue
      targets.push({ object: barriers.root, point: barrier.point, kind: 'mission', descending: false,
        label: left > 0 ? 'Hold to rebuild the barrier' : 'Hold to rebuild the barrier · no more points this round',
        use: () => { this.repairing = barrier; return true } })
    }
  }

  /**
   * While F (or the pad's use button) stays down at a window: a plank every WINDOW.repairSeconds, however fast
   * F is tapped, with the gun lowered. The host nails it and pays; the guest asks the host.
   */
  private updateRepair(dt: number) {
    this.repairWait = Math.max(0, this.repairWait - dt)
    const barrier = this.repairing
    if (!barrier) return
    const eye = this.camera.perspective.position
    if (!this.player.useHeld || !this.isActive() || this.down || this.revive.down || barrier.boards >= WINDOW.boards
      || !barrier.inside(eye) || barrier.point.distanceTo(eye) > 2.65) { this.repairing = null; return }
    this.interactionTime = Math.max(this.interactionTime, 0.2)
    if (this.repairWait > 0) return
    this.repairWait = WINDOW.repairSeconds
    if (this.isGuest) { this.coop.send({ t: 'use', what: 'window', index: barrier.index }); return }
    const paid = this.barriers!.rebuild(barrier, 'p1', this.rounds.round, this.timers.doublePoints ? 2 : 1)
    if (paid > 0) { this.state.points += paid; this.earned += paid; this.zombieHud.gain(paid) }
  }

  /** On the host: the guest nailed a plank back; the points go to the guest. */
  private partnerRebuild(index: number, from: number) {
    const barrier = this.barriers?.list[index]
    if (!barrier || !this.mates.get(from) || this.mates.get(from)!.avatar.feet.distanceTo(barrier.point) > 3.5) return
    const paid = this.barriers!.rebuild(barrier, `p${from + 1}`, this.rounds.round, this.timers.doublePoints ? 2 : 1)
    if (paid > 0) this.coop.send({ t: 'award', n: paid }, { to: from })
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
      this.award(pointsForHit({ lethal: hit.lethal, explosive: true }))
      this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
      if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
    }
    this.shockwaves.emit(position, burst.radius)
    this.riseMarks.emit(position)
    this.emit({ kind: 'ink-burst', position: centre, radius: 40 })
  }

  /** A kill by the player: the Brute pays and always leaves a Max Ammo; others may drop a power-up. */
  private killed(position: THREE.Vector3, zombie?: Zombie, weapon?: WeaponItem | null, headshot = false, byGuest?: number) {
    const byPartner = byGuest !== undefined
    const credit = (points: number) => byPartner ? this.coop.send({ t: 'award', n: this.timers.doublePoints ? points * 2 : points }, { to: byGuest }) : this.award(points)
    if (!byPartner) this.toastUnlocks(recordKill({ weapon: weapon && !weapon.special ? weapon.name : null, headshot, packed: !!weapon?.packed,
      packLevel: weapon?.packLevel, round: this.rounds.round, special: !!weapon?.special }))
    this.lastKillAt = position.clone()
    if (this.questStep === 'wells' && zombie && !zombie.boss) {
      // The nearest thirsty inkwell in reach takes this one's ink.
      let best: Inkwell | null = null, bestDistance: number = QUEST.soulRadius
      for (const well of this.wells) {
        const distance = well.root.position.distanceTo(position)
        if (well.awake && !well.full && distance < bestDistance) { best = well; bestDistance = distance }
      }
      if (best) {
        const from = position.clone().setY(position.y + 1.2)
        this.soulStreams?.emit(from, best)
        this.emit({ kind: 'soul', position: from, radius: 30 })
        this.coop.send({ t: 'soul', p: vec(from), i: this.wells.indexOf(best) })
      }
    }
    if (zombie && zombie === this.editor) { this.finishQuest(position); return }
    if (weapon?.packed) this.inkBurst(position, weapon.packLevel ?? 1)
    if (zombie && zombie === this.brute) {
      if (!byPartner) this.toastUnlocks(recordBruteKill())
      this.brute = null
      credit(BOSS.points)
      const at = position.clone(), floor = this.player.world.floor(at.clone().setY(at.y + 2.2), 0.1, 3)
      if (Number.isFinite(floor)) at.y = floor
      this.dropPowerup('maxAmmo', at)
      this.shout('The Brute is down', 3)
      return
    }
    const kind = this.dropper.onKill(this.earned)
    if (!kind) return
    // On the surface, even for one shot while still climbing out of the ground.
    const at = position.clone(), floor = this.player.world.floor(at.clone().setY(at.y + 2.2), 0.1, 3)
    if (Number.isFinite(floor)) at.y = floor
    this.dropPowerup(kind, at)
  }

  /** A power-up appears (on the host): here, with its sound, and on every guest's screen. */
  private dropPowerup(kind: PowerupKind, at: THREE.Vector3) {
    this.powerups.spawn(kind, at)
    this.emit({ kind: 'powerup-drop', position: at.clone(), radius: 40 })
    if (this.coop.role === 'host') this.coop.send({ t: 'drop', k: kind, p: vec(at) })
  }

  /** A power-up was walked into (on the host): its effects here, and the guests hear who took it. */
  private grabbed(kind: PowerupKind, at: THREE.Vector3, by: number) {
    this.activate(kind, by === 0 ? 'me' : 'partner')
    this.coop.send({ t: 'grab', k: kind, p: vec(at), by })
  }

  /**
   * A power-up's effects for this player. Most are for everyone (as in Call of Duty); the Death Machine
   * only for whoever took it. The Nuke's kills happen on the host, which owns the zombies.
   */
  private activate(kind: PowerupKind, who: 'me' | 'partner' = 'me') {
    this.zombieHud.announce(`${POWERUP_INFO[kind].label}!`, 2.4, 'powerup')
    this.emit({ kind: 'powerup-grab', position: this.player.body.position.clone(), radius: 5 })
    switch (kind) {
      case 'nuke': {
        const killed = this.isGuest ? 0 : this.director?.killAll() ?? 0
        this.state.kills += killed
        for (let i = 0; i < killed; i++) recordKill({ round: this.rounds.round })
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
          if (!item || item.special === 'deathMachine') continue
          item.reserve = Math.max(item.reserve, item.special === 'rayGun' ? item.packed ? INK_RAY.packedReserve : INK_RAY.reserve : spareAmmo(item))
        }
        break
      case 'deathMachine':
        if (who !== 'me') break
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
    const feet = this.state.phase === 'active' && !this.down && !this.isGuest ? this.player.body.position : null
    for (const kind of this.powerups.update(dt, feet)) this.grabbed(kind, this.player.body.position.clone(), 0)
    this.zombieHud.powerups((Object.keys(this.timers) as TimedPowerup[]).map(kind => ({ kind, left: this.timers[kind]! })))
  }

  private shot(shot: Shot) {
    if (!this.isActive() || !this.director) return
    // One burst per trigger pull, not one per shotgun pellet.
    if (!shot.pelletIndex) { this.shotsFired++; this.pullHit = false }
    if (!shot.pelletIndex) this.sparks.emit(shot.origin, shot.direction, this.weapons.current?.special ? 2 : 4)
    const surface = this.player.world.raySurface(shot.origin, shot.direction, shot.range)
    const distance = surface?.distance ?? shot.range
    this.impactPoint = null
    const scale = ZOMBIE_DAMAGE_SCALE * (this.perks.has('doubleLine') ? PERK_EFFECT.damage : 1)
    const held = this.weapons.current
    // Teammates see the tracer and hear the gun (a guest's goes through the host to the others).
    if (this.paired && !shot.pelletIndex) {
      const end = shot.origin.clone().addScaledVector(shot.direction, Math.min(distance, 60))
      this.coop.send({ t: 'fire', o: vec(shot.origin), e: vec(end), w: held?.special === 'rayGun' ? 'raygun' : shot.weapon ?? held?.name ?? 'pistol',
        pk: held?.packed ? held.packLevel ?? 1 : 0 })
    }
    if (held?.special === 'rayGun') {
      // A bolt, not a bullet: it flies, and bursts where it lands.
      this.bolts.fire(shot.origin, shot.direction, !!held.packed)
      return
    }
    // The Ink Rocket: a rocket, not a bullet (rockets.ts); it bursts where it lands.
    if (held?.name === 'rocket') { this.rockets.fire(shot.origin, shot.direction, rocketLoad(held)); return }
    // The Deadline's rounds burst where they strike (blasts.ts): in the first body, or on a wall.
    const explosive = held && isAkimbo(held) ? held : null
    if (this.isGuest) {
      // The host has the real zombies: it works the shot out and sends back hits and points.
      this.coop.send({ t: 'shot', o: vec(shot.origin), d: vec(shot.direction), range: shot.range, damage: shot.damage, weapon: shot.weapon ?? held?.name ?? 'pistol',
        scale, pierce: held ? pierceOf(held) : 1, pellet: shot.pelletIndex })
      if (explosive) {
        const body = this.director.aimDistance(shot.origin, shot.direction, distance)
        if (body < distance || surface) this.roundBurst(shot.origin.clone().addScaledVector(shot.direction, Math.min(body, distance)), shot.direction, explosive)
      }
      return
    }
    const struck = this.director.hitAll(shot, distance, scale, !!this.timers.instaKill, held ? pierceOf(held) : 1)
    if (struck.length && !this.pullHit) { this.shotsHit++; this.pullHit = true }
    const hit = struck[0] ?? null
    for (const each of struck) {
      this.hitFlash = 0.15
      this.award(pointsForHit({ lethal: each.lethal, zone: each.reaction.zone }))
      this.hits.hit(each.reaction.point, each.dealt, each.zombie.id, each.reaction.zone === 'head', each.lethal)
      if (each.lethal) { this.state.kills++; if (each.reaction.zone === 'head') this.state.headshots++; this.killed(each.zombie.position, each.zombie, held, each.reaction.zone === 'head') }
    }
    const end = this.impactPoint ?? shot.origin.clone().addScaledVector(shot.direction, distance)
    const impact = !hit && surface ? () => {
      this.audio.play({ kind: 'impact', position: end, radius: 18 })
      this.impacts.emit(end, shot.direction, surface, shot.weapon)
    } : undefined
    // An upgraded gun's rounds fly red, as Pack-a-Punched rounds glow in Call of Duty.
    this.bulletTrails.emit(shot.origin, end, shot.weapon, undefined, impact, held?.packed ? PACKED_TRACER : undefined)
    if (explosive && (hit || surface)) this.roundBurst(end, shot.direction, explosive)
  }

  /** A Deadline round goes off where it struck: a small splash that gibs and cripples, and stings you close up. */
  private roundBurst(point: THREE.Vector3, direction: THREE.Vector3, item: WeaponItem) {
    this.burst(point.clone().addScaledVector(direction, -0.05), DEADLINE_ROUND.radius, roundDamage(item), 'round', DEADLINE_ROUND.selfRadius, DEADLINE_ROUND.selfDamage)
  }

  /** An Ink Rocket bursts: a big blast that clears a pack, gibs and cripples, and hurts you if you are close. */
  private rocketBurst(burst: RocketBurst) {
    this.burst(burst.at, burst.radius, burst.damage, 'rocket', burst.radius * ROCKET.selfRadius, ROCKET.selfDamage)
  }

  /**
   * A rocket or a Deadline round going off. It hurts you if you stood too close, host or guest alike; the
   * host does the damage to the zombies, and a guest's goes to the host, as its grenades do.
   */
  private burst(at: THREE.Vector3, radius: number, damage: number, kind: BlastKind, selfReach: number, selfDamage: number) {
    const hurt = selfBlast(this.player.world, at, this.player.body.position, this.camera.perspective.getWorldPosition(new THREE.Vector3()), selfReach, selfDamage)
    if (hurt >= 1) this.damage(Math.round(hurt), 'zombie', at.clone())
    this.coopBlast(at, radius, damage, kind)
    const director = this.director
    if (this.isGuest || !director) return
    for (const hit of director.blast(at, radius, damage)) {
      this.hitFlash = 0.15
      this.award(pointsForHit({ lethal: hit.lethal, explosive: true }))
      this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
      if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
    }
    this.blastLook(at, radius, kind)
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
  private boltBurst(at: THREE.Vector3, packed = false) {
    const director = this.director
    if (!director) return
    const radius = packed ? INK_RAY.packedRadius : INK_RAY.radius, scale = packed ? INK_RAY.packedDamage : 1
    this.coopBlast(at, radius, this.blastDamage('boltBurst') * scale)
    if (this.isGuest) return
    const damage = Math.max(1500, zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * 1.6) * scale
    for (const hit of director.blast(at, radius, damage)) {
      this.hitFlash = 0.15
      this.award(pointsForHit({ lethal: hit.lethal, explosive: true }))
      this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
      if (hit.lethal) { this.state.kills++; this.killed(hit.zombie.position, hit.zombie) }
    }
    const eye = this.camera.perspective.getWorldPosition(new THREE.Vector3())
    const distance = eye.distanceTo(at)
    if (distance < INK_RAY.selfRadius) this.damage(Math.round(INK_RAY.selfDamage * (1 - distance / INK_RAY.selfRadius)), 'zombie', at.clone())
    this.shockwaves.emit(at.clone().setY(at.y - 0.5), radius)
    this.sparks.emit(at, new THREE.Vector3(0, 1, 0), 8)
    this.emit({ kind: 'ink-burst', position: at.clone(), radius: 60 })
  }

  /** A frag goes off: every zombie in reach takes a heavy blow; you too, if you stood too close. */
  private grenadeBlast(at: THREE.Vector3) {
    const director = this.director
    if (!director) return
    this.coopBlast(at, GRENADE.radius, this.blastDamage('grenadeBlast'))
    if (this.isGuest) return
    // A fixed blow, as a frag's is in Call of Duty (grenades.ts): a pack dies early on; from about round 6
    // the ones at the edge live through it, and some of them crawl.
    for (const hit of director.blast(at, GRENADE.radius, GRENADE.damage)) {
      this.award(pointsForHit({ lethal: hit.lethal, explosive: true }))
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
    this.emit({ kind: 'drop', position: eye.clone(), radius: 3 })
    if (this.isGuest) { this.coop.send({ t: 'knife', o: vec(eye), f: vec(forward), range: KNIFE.range, damage: KNIFE.damage }); return true }
    const hit = this.director.knife(eye, forward, KNIFE.range, KNIFE.damage, !!this.timers.instaKill)
    if (!hit) return false
    this.hitFlash = 0.15
    this.award(pointsForHit({ lethal: hit.lethal, zone: hit.reaction.zone, knife: true }))
    this.hits.hit(hit.reaction.point, hit.dealt, hit.zombie.id, false, hit.lethal)
    if (hit.lethal) { this.state.kills++; this.state.knifeKills++; this.killed(hit.zombie.position, hit.zombie) }
    return true
  }

  /** `knock`: a shove added to your speed (the Brute's blows throw you), m/s. */
  damage(amount: number, cause: 'zombie' | 'fall' | 'gas', source?: THREE.Vector3, knock?: THREE.Vector3) {
    if (this.invincible || this.reviveGrace > 0 || this.down || !this.isActive() || !(amount > 0)) return
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
    // Thrown by the blow: off your feet, so the ground does not stop the shove at once.
    if (knock && !dead && !this.player.actions.traversing) { this.player.body.velocity.add(knock); if (knock.y > 0) this.player.body.grounded = false }
    // Gas and traps burn steadily: no knock-back on every tick, just the hurt.
    if (!dead && !this.hud.reducedMotion && cause !== 'gas') {
      const point = this.player.body.position.clone().add(new THREE.Vector3(0, 1.17, 0))
      this.playerHits.hit({ region: source ? 'torso' : 'leg', side: 0, point,
        direction: source ? point.clone().sub(source) : new THREE.Vector3(0, 1, 0) },
        amount, this.player.body.grounded && !this.player.actions.traversing)
    }
    if (source) this.indicator.hit(source, amount)
    if (!dead) this.lowHealth.hit(amount / this.maxHealth())
    this.hud.hurt(); this.audio.play({ kind: 'damage' })
    if (cause !== 'gas') this.audio.play({ kind: 'bullet-hit', intensity: Math.min(1, amount / 50) })
    if (cause === 'fall') this.hud.notify('You fell.', 2)
    // Alone, Second Draft gets you up. In co-op you always go down into your last stand: a teammate can pick
    // you up, and the game ends only when everyone is down (the host sees to that).
    if (dead && this.perks.has('secondDraft') && !this.paired) this.selfRevive()
    else if (dead && this.paired && !this.down) this.goDown()
    else if (dead && !this.down) { if (this.coop.role === 'host') this.coop.send({ t: 'gameover' }); this.gameOver(source) }
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
    // Ink for the Armory (round x 10 + kills + headshots x 2 + challenge rewards), and the game-over page's report.
    const report = recordGameEnd({ round: this.state.round, kills: this.state.kills, headshots: this.state.headshots,
      shotsFired: this.shotsFired, shotsHit: this.shotsHit, elapsed: this.state.elapsed })
    this.hud.notify(`+${report.inkTotal} Ink`, 3)
    this.lowHealth.clear()
    delete document.body.dataset.deadInkOneHit
    // As in Call of Duty: the fall, then ink, then the map from above under GAME OVER while the requiem plays.
    this.gameOverFlight.begin(this.player.body.position.clone(), this.flightStops(), Math.max(1, this.state.round), this.player.world)
  }

  /** Where the game-over flight passes: the start, the box, the Pack-a-Punch and every perk machine. */
  private flightStops() {
    return [this.spawn, this.box?.root.position, this.pack?.root.position, ...this.perkMachines.map(machine => machine.root.position)]
      .filter((point): point is THREE.Vector3 => !!point).map(point => point.clone())
  }

  /** What the HUD shows of a death here: the fall's blur until the flight, then the scores on the flight's clock. */
  private deathView() {
    const flight = this.gameOverFlight, death = this.death
    return { reducedMotion: death.reducedMotion, menuVisible: flight.menuVisible, menuOpacity: flight.menuOpacity, visionLoss: flight.flying ? 0 : death.visionLoss }
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
    // The Ink Storm: its Inkwings come out of the storm in groups (flyers.ts); its sprinters rise as zombies do, below.
    if (this.storm) {
      const group = this.stormPack.next(this.random, 1 + Math.min(this.rounds.toSpawn, MAX_ALIVE - 1 - director.aliveCount))
      if (group) return this.spawnInkwings(group)
    }
    // Some come from the road, clawing up outside a boarded window of the mess hall and tearing their way in.
    const entry = this.barriers?.pickSpawn(this.random) ?? null
    const spot = entry?.rise ?? pickSpawn(graph, this.player.world, { near: 14, far: 42, eyes: [] }, this.random)
    if (!spot) return false
    const feet = this.player.body.position
    // From round 8 a few are Blots: bloated, slower, tougher, and they burst into poison gas.
    const blot = !this.storm && rollBlot(this.rounds.round, this.random)
    const health = Math.round(zombieHealth(this.rounds.round) * DIFFICULTY[this.difficulty].health * (this.storm ? STORM.health : 1) * (blot ? BLOT.health : 1))
    const zombie = director.spawn(spot, health, this.storm ? 'sprint' : this.gait(), entry ? entry.barrier.facing : Math.atan2(feet.x - spot.x, feet.z - spot.z), true, false, blot)
    if (zombie && entry) director.sendToWindow(zombie, entry.barrier)
    return !!zombie
  }

  /**
   * A group of Inkwings out of the storm round the players (flyers.ts). The round fed in one of them; the rest
   * are taken from its count here, and any that found nowhere to come out go back to it.
   */
  private spawnInkwings(group: number) {
    const director = this.director!, players = 1 + this.matesHere().length
    this.rounds.toSpawn -= group - 1
    const targets: ZombieTarget[] = [{ id: 'p1', feet: this.player.body.position, alive: !this.down },
      ...this.matesHere().filter(mate => mate.state.dn === 0).map(mate => ({ id: `p${mate.id + 1}`, feet: mate.avatar.feet, alive: true }))]
    const health = Math.round(inkwingHealth(this.rounds.round, players) * DIFFICULTY[this.difficulty].health)
    const placed = director.flyers.arrive(group, targets, health, this.random, stormNumber(this.rounds.round))
    if (placed < group) { this.stormPack.back(group - placed); this.rounds.toSpawn += group - placed - (placed ? 0 : 1) }
    return placed > 0
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
    this.toastUnlocks(recordStormSurvived())
    const at = (this.lastKillAt ?? this.player.body.position).clone()
    const floor = this.player.world.floor(at.clone().setY(at.y + 2.2), 0.1, 3)
    if (Number.isFinite(floor)) at.y = floor
    this.dropPowerup('maxAmmo', at)
    this.setStorm(false)
  }

  /** The Brute is alive and hunting (it carries over from round to round until it is killed). */
  get bruteHunting() { return !!this.brute && this.brute.boss && this.brute.state === 'chase' }

  /** A round starts with the Brute still about: a short line saying so (on each player's screen). */
  private bruteCarriesOver() { this.hud.notify('The Brute is still hunting you.', 3.5) }

  /** The Brute climbs out of the ground somewhere it can walk to you from, and roars. Never a second one. */
  private spawnBrute() {
    const director = this.director, graph = this.graph
    if (!director || !graph || this.bruteHunting) return
    const spot = pickSpawn(graph, this.player.world, { near: 16, far: 40, eyes: [] }, this.random)
    const feet = this.player.body.position
    const health = Math.round(BOSS.health(this.rounds.round, 1 + this.matesHere().length) * DIFFICULTY[this.difficulty].health)
    const brute = spot && director.spawn(spot, health, 'run', Math.atan2(feet.x - spot.x, feet.z - spot.z), true, true)
    // Nowhere to stand, or every body in use: try again in a moment.
    if (!brute) { this.bruteTimer = 1; return }
    this.brute = brute
    this.riseMarks.emit(brute.position); this.riseMarks.emit(brute.position.clone().add(new THREE.Vector3(0.6, 0, 0.4)))
    this.shout('The Brute', 3)
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
      // Never the Brute: it vanishing behind your back and turning up elsewhere reads as a glitch.
      if (zombie.state !== 'chase' || !zombie.stranded || zombie.boss) continue
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
    const deathPlaying = this.death.active && this.player.enabled && !this.player.immersive && !this.death.menuVisible && !document.hidden
    if (active !== this.active) { this.cancelInput(); this.active = active }
    this.audio.setActive(active || deathPlaying)
    // A doll on the ground draws every zombie to it, the Brute too, until it goes off.
    const lures = this.dolls.resting()
    const allLures = [...lures.map(doll => doll.position), ...this.partnerLures.map(lure => lure.position)]
    const target = (): readonly ZombieTarget[] => allLures.length ? allLures.map((feet, i) => ({ id: `doll-${i}`, feet, alive: true }))
      : this.playerTargets()
    this.followPause()
    if ((active || this.hostMenuKeepsWorld()) && this.director) {
      this.state.elapsed += dt
      const body = this.player.body
      const b = this.world.bounds
      if (body.position.y < -12 || body.position.x < b.minX || body.position.x > b.maxX || body.position.z < b.minZ || body.position.z > b.maxZ) {
        body.teleport(this.safePosition); this.player.actions.syncCamera(this.camera.perspective)
        this.hud.notify('That is the edge of the map.', 3)
      } else if (!this.player.actions.traversing) this.damage(fallDamage(landingSpeed), 'fall')
      if (this.isGuest) this.guestStep(dt)
      else this.hostStep(dt, target)
      this.coopFrame(dt)
      // Health comes back after a few seconds without being hit, as in Call of Duty.
      if (this.state.phase === 'active' && !this.down && this.state.elapsed - this.lastHurt > PLAYER_HEALTH.regenDelay)
        this.state.health = Math.min(this.maxHealth(), this.state.health + PLAYER_HEALTH.regenPerSecond * dt)
      this.afterStep(dt)
    } else if (deathPlaying && this.director) {
      // The horde keeps moving while you fall.
      this.state.elapsed += dt
      this.player.world.refresh()
      if (this.isGuest) this.director.puppet(dt, this.lastTick?.z ?? [], this.player.body.position)
      else this.director.update(dt, target())
      this.blood.update(dt); this.impacts.update(dt); this.riseMarks.update(dt)
      this.explosions.update(dt); this.nukeCloud.update(dt)
    }
    this.coopIdle(dt)
    // Keep frames coming while playing, while the death plays out, and while a partner is connected
    // (their stickman and messages keep moving even with our menu open).
    return this.renderRest(dt, active, deathPlaying) || this.coop.paired
  }

  /**
   * Every player the zombies may go for, the host first. Each says whether they are off the ground (the Brute's
   * slam wave passes under a jump); a teammate's news reaches us late, so their jump gets that long to arrive.
   */
  private playerTargets(): ZombieTarget[] {
    // After the game ends the horde still shambles about, closing in on where you fell (as in Call of Duty).
    return [{ id: 'p1', feet: this.player.body.position, alive: (this.state.phase === 'active' && !this.down) || this.gameOverFlight.active,
      air: !this.player.body.grounded },
      ...(this.coop.role === 'host' && this.paired ? this.matesHere().filter(mate => mate.state.dn === 0)
        .map(mate => ({ id: `p${mate.id + 1}`, feet: mate.avatar.feet, alive: true, air: !!mate.state.air, lag: BOSS.slam.lag })) : [])]
  }

  /** The host (or a solo game): rounds, spawns and the zombies' own thinking. */
  private hostStep(dt: number, target: () => readonly ZombieTarget[]) {
    if (!this.director) return
    {
      // Rounds: announce, feed zombies in, and hand back any that found nowhere to stand. A boss does not
      // hold a round open: it carries on into the next ones until it is killed.
      const events = stepRounds(this.rounds, dt, roundAlive(this.director.zombies), 1 + this.matesHere().length, DIFFICULTY[this.difficulty].spawnDelay * (this.storm ? STORM.spawnDelay : 1))
      this.state.round = this.rounds.round
      if (events.roundStarted) {
        this.dropper.newRound(); this.sting('roundStart')
        if (this.down === 2) this.getUp(true)
        this.toastUnlocks(recordRound(events.roundStarted))
        this.setStorm(isStormRound(events.roundStarted))
        if (this.storm) {
          // The storm's own pack, Inkwings and a few sprinters (flyers.ts): this step may already have fed some in.
          this.rounds.toSpawn = Math.max(0, this.stormPack.begin(events.roundStarted, 1 + this.matesHere().length) - events.spawn)
          this.shout(`Round ${events.roundStarted}: Ink Storm`, 3.5)
          this.emit({ kind: 'storm' })
        } else this.shout(`Round ${events.roundStarted}`)
        // One Brute at a time: one still hunting you carries over, and no other comes.
        if (bruteDue(events.roundStarted, this.bruteHunting)) this.bruteTimer = BOSS.delay
        else if (this.bruteHunting) this.bruteCarriesOver()
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
        this.shout(this.storm ? 'The storm passes' : `Round ${events.roundEnded} survived`, 3.5); this.emit({ kind: 'round-end' })
        if (this.storm) this.stormReward()
      }
      this.director.update(dt, target())
      // The last zombie of a round always comes at a sprint, as in every Call of Duty map.
      if (this.rounds.phase === 'active' && this.rounds.toSpawn === 0 && roundAlive(this.director.zombies) === 1) {
        const last = this.director.zombies.find(z => z.state === 'chase' && !z.boss)
        if (last && last.gait !== 'sprint') last.gait = 'sprint'
      }
      this.relocateStranded(dt)
    }
  }

  /**
   * The guest: no rounds or thinking of its own. The zombies are the host's, drawn from its last
   * snapshot; the round, its phase and the Ink Storm come from it too.
   */
  private guestStep(dt: number) {
    const tick = this.lastTick
    if (tick) {
      this.rounds.round = tick.r; this.state.round = tick.r; this.rounds.phase = tick.ph
      if (tick.storm !== this.storm) this.setStorm(tick.storm)
    }
    this.director!.puppet(dt, tick?.z ?? [], this.player.body.position)
  }

  /** Everything after the zombies move, the same for host, guest and solo. */
  private afterStep(dt: number) {
    const body = this.player.body, lures = this.dolls.resting()
    if (!this.director) return
    {
      // A Blot's gas: damage while you are in it, deeper in hurts more; the screen darkens with it.
      this.gasExposure = this.director!.gas.exposure(this.camera.perspective.position)
      if (this.gasExposure > 0 && !this.down) {
        this.gasDamage += GAS.damagePerSecond * this.gasExposure * DIFFICULTY[this.difficulty].damage * dt
        if (this.gasDamage >= 5) { const amount = Math.floor(this.gasDamage); this.gasDamage -= amount; this.damage(amount, 'gas') }
      } else this.gasDamage = 0
      document.body.style.setProperty('--dead-ink-gas', this.gasExposure.toFixed(3))
      this.blockByZombies()
      // One swipe from going down, the whole screen goes red, as in Call of Duty; otherwise the ink creeps
      // in with the health you have left.
      const oneHit = this.state.phase === 'active' && this.state.health > 0 && this.state.health <= PLAYER_HEALTH.zombieHit * DIFFICULTY[this.difficulty].damage
      this.lowHealth.update(this.player.playing ? dt : 0, this.state.phase !== 'active' ? 1 : oneHit ? Math.min(0.06, this.state.health / this.maxHealth()) : this.state.health / this.maxHealth())
      if (oneHit !== (document.body.dataset.deadInkOneHit === 'true')) {
        if (oneHit) document.body.dataset.deadInkOneHit = 'true'; else delete document.body.dataset.deadInkOneHit
      }
      const fov = getSettings().fov, cam = this.camera.perspective
      if (this.player.playing && !this.weapons.scoped && cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix() }
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
      this.updateTraps(dt)
      this.updateQuest(dt)
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
      if (boxEvent === 'landed' && this.box) {
        this.emit({ kind: 'box-offer', position: this.box.point.clone(), radius: 25 })
        if (this.box.offer?.rarity === 'mythic') playMythicSting()
      }
      if (boxEvent === 'moved' && !this.isGuest) this.moveBox()
      if (boxEvent === 'expired' && this.coop.role === 'host') this.coop.send({ t: 'box', a: 'close' })
      this.blood.update(dt); this.impacts.update(dt); this.riseMarks.update(dt); this.sparks.update(dt); this.shockwaves.update(dt)
      this.explosions.update(dt); this.nukeCloud.update(dt)
      this.zones?.update(dt)
      this.barriers?.update(dt); this.updateRepair(dt)
      this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt)
      for (const pending of [...this.pendingThrows]) if ((pending.timer -= dt) <= 0) { this.pendingThrows.splice(this.pendingThrows.indexOf(pending), 1); pending.launch() }
      for (const at of this.grenades.update(dt)) this.grenadeBlast(at)
      this.dollCooldown = Math.max(0, this.dollCooldown - dt)
      for (const doll of lures) animateDoll(doll.object, doll.age)
      // The guest's doll draws the host's zombies: tell the host once, when it lands.
      if (this.isGuest) for (const doll of lures) if (!doll.object.userData.lureSent) {
        doll.object.userData.lureSent = true
        this.coop.send({ t: 'lure', p: vec(doll.position), s: DECOY.lure + 1 - doll.age })
      }
      for (const lure of [...this.partnerLures]) if ((lure.left -= dt) <= 0) this.partnerLures.splice(this.partnerLures.indexOf(lure), 1)
      if (lures.length && (this.dollClap -= dt) <= 0) { this.dollClap = 0.32; this.emit({ kind: 'doll-clap', position: lures[0].position.clone(), radius: 25 }) }
      for (const at of this.dolls.update(dt)) this.dollBlast(at)
      for (const burst of this.bolts.update(dt)) this.boltBurst(burst.at, burst.packed)
      for (const burst of this.rockets.update(dt)) this.rocketBurst(burst)
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
    }
  }

  /** The view, the gun in your hands and the HUD, every frame. */
  private renderRest(dt: number, active: boolean, deathPlaying: boolean) {
    let deathVisible: boolean
    const reactionActive = this.isActive()
    const yaw = new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y
    const hitPose = this.playerHits.update(reactionActive ? dt : 0, yaw, this.hud.reducedMotion)
    if (reactionActive) {
      const zoom = this.aiming && this.weapons.current?.name === 'sniper' && !this.weapons.reloading ? this.weapons.scopeMagnification : 1
      this.playerHits.applyCamera(this.camera.perspective, this.player.world, 1 / zoom)
      this.revive.crawl = this.down === 1 ? Math.hypot(this.player.body.velocity.x, this.player.body.velocity.z) : 0
      this.revive.applyCamera(this.camera.perspective, this.hud.reducedMotion)
    }
    deathVisible = this.death.active && this.player.enabled && !this.player.immersive
    if (deathVisible) {
      // The fall until the screen has gone to ink; then the flight has the camera. The fall's clock stops
      // there, so the horde keeps moving and frames keep coming for as long as the flight runs.
      const flying = this.gameOverFlight.flying
      if (!flying && this.death.update(document.hidden ? 0 : dt, this.camera.perspective, this.player.world)) this.audio.play({ kind: 'player-fall' })
      this.gameOverFlight.update(document.hidden ? 0 : dt, this.camera.perspective, this.hud.reducedMotion)
      if (flying) document.body.dataset.deadInkOver = 'flying'
      this.weapons.updateDeath(this.death.elapsed, this.death.reducedMotion, this.death.hitKick, this.death.hitSide)
      this.hud.setDeath(this.deathView())
    } else {
      if (this.death.active) { this.death.reset(); this.weapons.resetDeath(); this.hud.clearDeath() }
      if (this.gameOverFlight.active) { this.gameOverFlight.end(); delete document.body.dataset.deadInkOver }
      this.weapons.update(dt, { active: reactionActive && this.interactionTime === 0 && (!this.revive.down || this.revive.settled), climbing: this.player.actions.traversing,
        moving: this.player.body.velocity.length(), aiming: this.aiming, reducedMotion: this.hud.reducedMotion, feet: this.player.body.position, hitPose })
    }
    this.bottle.update(dt)
    this.syringe.update(dt, this.reviving > 0 ? this.reviving / this.reviveTime() : 1)
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
    const boss = this.liveBoss()
    this.zombieHud.boss(boss ? boss.health / boss.maxHealth : null, boss?.brute?.editor ? 'THE EDITOR' : 'THE BRUTE', !!boss?.brute?.enraged)
    this.zombieHud.grenades(this.grenadeCount, this.dollCount)
    // Mini map: you, the stations (this runtime's perk machines, box, Pack-a-Punch, power, gates), parts, teammates.
    this.minimap?.update(dt, this.player.body.position, yaw, this, this.parts, this.minimapMates(), this.player.playing)
    this.updateMusic()
    // The heart shows health as a share of your maximum, which Thick Ink raises.
    this.hud.update(dt, { ...this.state, health: this.state.health / this.maxHealth() * 100 }, { playing: this.player.playing, enabled: this.player.enabled && !this.player.immersive,
      weapon: this.weapons.current, reloading: this.weapons.reloading, position: this.player.body.position,
      yaw, deaths: this.deaths, ready: this.ready })
    return active || this.death.running
  }

  /** Mini map teammates: every other player while connected, in their colour. */
  private minimapMates() {
    this.mapMates.length = 0
    if (!this.paired) return this.mapMates
    for (const mate of this.matesHere()) {
      const dot = this.mapMatePool[this.mapMates.length] ??= { position: new THREE.Vector3(), yaw: 0, color: mate.css }
      dot.position.copy(mate.avatar.feet); dot.yaw = mate.state.yaw; dot.color = mate.css
      this.mapMates.push(dot)
    }
    return this.mapMates
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
    this.minimap?.dispose()
    this.uninstallCosmetics(); this.lowHealth.dispose(); this.stopSettings(); this.bulletTrails.dispose(); this.weapons.dispose(); this.blood.dispose(); this.impacts.dispose(); this.riseMarks.dispose(); this.sparks.dispose(); this.shockwaves.dispose(); this.explosions.dispose(); this.nukeCloud.dispose(); this.undress?.(); this.grenades.dispose(); this.dolls.dispose(); this.dollBuy?.dispose(); this.bolts.dispose(); this.rockets.dispose(); this.powerups.dispose()
    for (const skull of this.skulls) skull.object.removeFromParent()
    delete document.body.dataset.deadInkStorm
    delete document.body.dataset.deadInkOneHit
    this.coop.close(); for (const id of [...this.mates.keys()]) this.dropMate(id); this.powerMarker.dispose(); this.syringe.dispose(); this.gameOverFlight.dispose(); delete document.body.dataset.deadInkOver
    for (const part of this.parts) part.dispose()
    for (const site of this.sites.values()) site.dispose()
    this.powerSwitch?.dispose()
    for (const trap of this.traps) trap.dispose()
    for (const well of this.wells) well.dispose()
    this.soulStreams?.dispose()
    this.barriers?.dispose()
    document.body.style.removeProperty('--dead-ink-gas')
    this.audio.dispose(); this.music.dispose(); this.hud.dispose()
    this.player.movementLocked = false; this.player.onPlayingChange = () => {}; this.player.lookSensitivity = () => 1
    this.player.actions.extraTargets = () => []; this.player.actions.onAction = () => {}
  }
}
