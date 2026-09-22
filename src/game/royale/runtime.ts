import * as THREE from 'three'
import { BulletTrails } from '../bullet-trails'
import { fallDamage } from '../balance'
import type { EnvironmentCamera } from '../../camera'
import type { FirstPersonController } from '../../player/controller'
import type { ActionTarget } from '../../player/actions'
import { setDoorOpen } from '../../world/doors'
import { EnemyDirector } from '../ai'
import { FirstPersonWeapons } from '../weapons'
import { MissionAudio } from '../audio'
import { MissionHUD } from '../hud'
import { MissionBlood } from '../hit-reactions'
import type { HitReaction } from '../hit-reactions'
import { MissionImpacts } from '../impacts'
import { PlayerHitReactions, type PlayerBulletHit } from '../player-hit-reactions'
import { PlayerDeathSequence } from '../player-death'
import { RARITY_INFO, rollRarity, weaponRules } from '../loot'
import type { MenuCopy } from '../menu'
import type { EnemySpec, MissionWorld, Shot, SoundEvent } from '../types'
import { createStormWall } from '../../render/ink'
import { findLootSpots, rollMatchLoot } from './loot-spawn'
import { HitMarkers } from './hitmarkers'
import { DamageIndicator } from './damage-indicator'
import { EnemyTracers } from './tracers'
import { Hotbar } from './hotbar'
import { seeded, shuffled, type Random } from './random'
import { advanceStormTimer, outsideBy, planStorm, stormAt, type StormPlan } from './storm'
import './royale.css'

export type RoyaleOptions = { bots: number; seed?: number; loot?: number }
export type RoyaleState = {
  phase: 'active' | 'dead' | 'complete'
  health: number; elapsed: number; kills: number
  alive: number; bots: number; placement: number | null
  seed: number; stormPhase: number; stormNextIn: number; stormShrinking: boolean; outside: boolean
}

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

export const ROYALE_COPY: MenuCopy = {
  title: 'Ink Royale', premise: 'Drop in. Loot up. Be the last one standing.',
  begin: 'Drop in', resume: 'Resume', restart: 'New match',
  deadTitle: 'Eliminated.', completeTitle: 'Victory Royale!', completePremise: 'Last stickman standing.',
  objective: state => {
    const s = state as RoyaleState
    if (s.phase === 'dead') return `You placed #${s.placement} of ${s.bots + 1}.`
    return `${s.alive} left · ${s.stormShrinking ? 'storm closing' : 'storm moves'} in ${fmt(s.stormNextIn)}`
  },
  recap: state => {
    const s = state as RoyaleState
    return [['Place', `#${s.placement ?? 1}`], ['Kills', String(s.kills)], ['Time', fmt(s.elapsed)]]
  },
  deadPremise: state => { const s = state as RoyaleState; return `You placed #${s.placement} of ${s.bots + 1}.` },
  restartWarning: 'This match ends and a new one starts.',
  missionPage: false,
  modeLink: { label: 'Hostage mission', href: './' },
}

/**
 * Battle royale against bots, on the compound. Reuses the game's weapons, AI, audio, blood, impacts,
 * death sequence and HUD; leaves out everything the hostage mission owns (cells, jeep, cameras, alarm,
 * escape). The mission runtime is untouched by this file.
 */
export class RoyaleRuntime {
  state!: RoyaleState
  readonly weapons: FirstPersonWeapons
  readonly ai: EnemyDirector
  readonly audio = new MissionAudio()
  readonly blood: MissionBlood
  readonly impacts: MissionImpacts
  readonly bulletTrails: BulletTrails
  readonly playerHits = new PlayerHitReactions()
  readonly death = new PlayerDeathSequence()
  readonly hud: MissionHUD
  readonly hits: HitMarkers
  readonly indicator: DamageIndicator
  readonly tracers: EnemyTracers
  readonly hotbar: Hotbar
  ready = false
  readonly initialized: Promise<void>
  deaths = 0
  invincible = false
  storm!: StormPlan
  private random!: Random
  private stormWall = createStormWall()
  private status = document.createElement('div')
  private vignette = document.createElement('div')
  private aliveEl!: HTMLElement
  private stormEl!: HTMLElement
  private weaponEl!: HTMLElement
  private weaponTint = ''
  private specs: EnemySpec[]
  private initialAI: ReturnType<EnemyDirector['snapshot']> | null = null
  private abort = new AbortController()
  private active = false
  private aiming = false
  private stepTime = 0
  private interactionTime = 0
  private stormTick = 0
  private botStormTick = 0
  private safePosition = new THREE.Vector3()
  private hitFlash = 0
  private impactPoint: THREE.Vector3 | null = null
  private pendingHits: HitReaction[] = []
  private lastCaption = ''
  private lastCaptionAt = -100
  private disposed = false
  // Mouse-wheel weapon switching: accumulate small trackpad deltas, then switch at most once per notch.
  private wheelAmount = 0
  private wheelAt = 0

  constructor(scene: THREE.Scene, private camera: EnvironmentCamera, readonly player: FirstPersonController,
    readonly world: MissionWorld, private invalidate: () => void, private options: RoyaleOptions) {
    player.missionMode = true
    player.canPlay = () => this.ready && this.state.phase === 'active'
    if (!camera.perspective.parent) scene.add(camera.perspective)
    this.newMatchState(options.seed ?? Math.floor(Math.random() * 2 ** 31))

    // Bots: the compound's guard posts are known-walkable, spread over the whole map, upper floors
    // included. Pick as many as asked for, all active from the start (no alarm reserves in a royale).
    const pool = shuffled(this.random, world.enemies)
    this.specs = pool.slice(0, Math.max(1, Math.min(options.bots, pool.length))).map(spec => ({ ...spec, reserve: false }))
    this.state.bots = this.specs.length

    this.weapons = new FirstPersonWeapons({ scene, camera: camera.perspective, world: player.world,
      aimDistance: (origin, direction, maxDistance) => this.ai.aimDistance(origin, direction, maxDistance),
      emit: event => this.emit(event, true), onShot: shot => this.shot(shot) })
    this.blood = new MissionBlood(scene, player.world, id => {
      const enemy = this.ai?.enemies.find(candidate => candidate.spec.id === id)
      if (!enemy || enemy.state !== 'dead' || enemy.deathClip !== 'dieShotgun') return null
      return enemy.actor.rig.bones.chest.getWorldPosition(new THREE.Vector3())
    })
    this.impacts = new MissionImpacts(scene, player.world)
    this.bulletTrails = new BulletTrails(scene, 'Player bullet')
    player.lookSensitivity = () => this.weapons.lookSensitivity
    this.ai = new EnemyDirector({ scene, world: player.world, doors: player.actions.doors, specs: this.specs,
      emit: event => this.emit(event, false), damagePlayer: (amount, source, hit) => this.damage(amount, 'bullet', source, hit),
      onSurfaceHit: (point, direction, surface, weapon) => this.impacts.emit(point, direction, surface, weapon),
      // Everything a bot drops is loot, so it gets a rarity too.
      dropWeapon: item => this.weapons.addPickup({ ...item, rarity: rollRarity('floor', this.random) }),
      onHit: hit => {
        this.impactPoint = hit.point.clone(); this.blood.emitHit(hit); this.audio.confirmHit(hit)
        this.pendingHits.push(hit)
      } })
    this.hud = new MissionHUD(world, {
      retry: () => { this.restart(); void this.audio.unlock(); this.player.requestControl() },
      restart: () => { this.restart(); void this.audio.unlock(); this.player.requestControl() },
      volume: value => this.audio.setVolume(value), mute: value => this.audio.setMuted(value) }, ROYALE_COPY)
    document.querySelector('#world')?.setAttribute('aria-label', 'Ink Royale battle royale. Mouse to look, WASD move, left click fire, right click toggle aim, mouse wheel switch weapon, F pick up, R reload, Escape pause.')
    const hudRoot = document.querySelector<HTMLElement>('#mission-hud')!
    this.status.className = 'royale-status'
    this.status.innerHTML = '<div class="royale-alive"><strong>0</strong> left</div><div class="royale-storm"></div><div class="royale-weapon" hidden></div>'
    this.aliveEl = this.status.querySelector('strong')!
    this.stormEl = this.status.querySelector<HTMLElement>('.royale-storm')!
    this.weaponEl = this.status.querySelector<HTMLElement>('.royale-weapon')!
    this.vignette.className = 'royale-outside'
    hudRoot.append(this.vignette, this.status)
    this.hits = new HitMarkers(hudRoot)
    this.indicator = new DamageIndicator(hudRoot)
    this.hotbar = new Hotbar(hudRoot)
    this.tracers = new EnemyTracers(scene)
    scene.add(this.stormWall.wall)
    player.onPlayingChange = playing => this.hud.setPlaying(playing)
    player.actions.extraTargets = () => this.targets()
    player.actions.onAction = target => {
      this.weapons.cancel(); this.aiming = false; this.interactionTime = 0.25
      if (target.kind === 'door' || target.kind === 'ladder') this.emit({ kind: target.kind, position: target.point, radius: target.kind === 'door' ? 8 : 5 }, true)
    }
    this.bindInput()
    this.initialized = this.initialize()
  }

  private newMatchState(seed: number) {
    this.random = seeded(seed)
    this.storm = planStorm(this.world.bounds, this.random)
    const bots = this.state?.bots ?? 0
    this.state = { phase: 'active', health: 100, elapsed: 0, kills: 0, alive: bots + 1, bots, placement: null,
      seed, stormPhase: 0, stormNextIn: 0, stormShrinking: false, outside: false }
  }

  private async initialize() {
    try {
      await this.ai.init()
      if (this.disposed) return
      // Mission-only locks do not apply here: open every cell and service door for free movement.
      for (const door of this.player.actions.doors) door.userData.missionLocked = false
      this.player.world.warm()
      this.initialAI = this.ai.snapshot()
      this.startMatch()
      this.ready = true; this.hud.ready(); this.invalidate()
    } catch (error) {
      if (this.disposed) return
      console.error('Battle royale loading failed', error)
      this.hud.error(`Could not load the match: ${error instanceof Error ? error.message : String(error)}. Reload this page to retry.`)
      this.invalidate()
    }
  }

  /** Lay out loot, place the player away from bots, and start the clock. */
  private startMatch() {
    const seeds = this.world.enemies.flatMap(e => [e.position, ...e.patrol])
    const spots = findLootSpots(this.player.world, this.world.bounds, this.random, { count: this.options.loot ?? 90, seeds })
    const loot = rollMatchLoot(spots, this.random)
    // Empty hands, like Fortnite: the first gun you find matters.
    this.weapons.restore({ slots: [null, null, null, null], selected: 0, pickups: loot, nextId: 1 })
    const botStarts = this.specs.map(spec => new THREE.Vector3(...spec.position))
    const candidates = shuffled(this.random, spots).map(s => new THREE.Vector3(...s))
    const spawn = candidates.find(p => botStarts.every(b => b.distanceTo(p) > 30))
      ?? candidates.find(p => botStarts.every(b => b.distanceTo(p) > 18)) ?? candidates[0] ?? new THREE.Vector3(...this.world.spawn)
    this.player.actions.reset()
    this.player.body.teleport(spawn)
    this.player.world.refresh()
    this.player.body.update(1 / 60, new THREE.Vector3(), false)
    this.player.actions.syncCamera(this.camera.perspective)
    const centre = this.storm.circles[0]
    this.camera.perspective.lookAt(new THREE.Vector3(centre.x, spawn.y + 1.7, centre.z))
    this.safePosition.copy(this.player.body.position)
    this.syncStorm()
  }

  restart() {
    if (!this.initialAI) return
    this.death.reset(); this.weapons.resetDeath(); this.playerHits.clear()
    this.player.pause(); this.cancelInput(); this.audio.reset(); this.player.actions.reset()
    this.player.movementLocked = false
    for (const door of this.player.actions.doors) setDoorOpen(door, false, true)
    this.player.world.refresh()
    this.ai.restore(structuredClone(this.initialAI))
    this.blood.restore(undefined)
    this.newMatchState(this.options.seed ?? Math.floor(Math.random() * 2 ** 31))
    this.state.bots = this.specs.length; this.state.alive = this.specs.length + 1
    this.stepTime = 0; this.interactionTime = 0; this.hitFlash = 0; this.stormTick = 0; this.botStormTick = 0
    this.lastCaptionAt = -100; this.pendingHits = []
    this.bulletTrails.clear(); this.impacts.clear(); this.hits.clear(); this.hud.reset()
    this.tracers.clear(); this.indicator.clear(); this.wheelAmount = 0
    this.startMatch()
    this.hud.notify('New match. Grab a weapon.', 3)
    this.invalidate()
  }

  retry() { this.restart() }

  private bindInput() {
    const options = { signal: this.abort.signal }
    document.querySelector('#walk-start')!.addEventListener('click', () => { void this.audio.unlock() }, options)
    window.addEventListener('keydown', this.keyDown, options)
    document.querySelector('#world')!.addEventListener('wheel', event => {
      const wheel = event as WheelEvent
      if (!this.isActive() || wheel.ctrlKey || wheel.metaKey || wheel.altKey) return
      wheel.preventDefault()
      // Scoped with a sniper, the wheel zooms, as before. Otherwise it switches weapons.
      if (this.aiming && this.weapons.adjustScopeZoom(-Math.sign(wheel.deltaY))) { this.invalidate(); return }
      // A mouse notch is about 100 units; a trackpad sends many tiny ones. Switch once per notch's worth,
      // and not faster than every 120 ms, so a flick cannot spin through all four slots.
      const now = performance.now()
      if (now - this.wheelAt > 400) this.wheelAmount = 0
      this.wheelAmount += wheel.deltaMode === 1 ? wheel.deltaY * 40 : wheel.deltaY
      if (Math.abs(this.wheelAmount) < 60 || now - this.wheelAt < 120) return
      if (this.weapons.cycle(this.wheelAmount > 0 ? 1 : -1)) { if (!this.weapons.canAim) this.aiming = false }
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
    if (zoomKey) {
      if (!this.aiming || !this.weapons.adjustScopeZoom(event.code === 'KeyE' ? 1 : -1)) return
      event.preventDefault(); this.invalidate(); return
    }
    switch (event.code) {
      case 'KeyR': if (this.weapons.reload()) this.aiming = false; break
      case 'Digit1': this.weapons.switchSlot(0); break
      case 'Digit2': this.weapons.switchSlot(1); break
      case 'Digit3': this.weapons.switchSlot(2); break
      case 'Digit4': this.weapons.switchSlot(3); break
      case 'KeyG': this.weapons.drop(this.player.body.position); break
      default: return
    }
    if (!this.weapons.canAim) this.aiming = false
    event.preventDefault(); this.invalidate()
  }

  private targets(): ActionTarget[] {
    if (!this.isActive()) return []
    return this.weapons.pickupTargets().map(item => ({ ...item, kind: 'pickup' as const, descending: false, use: () => this.weapons.pickup(item.id) }))
  }

  private emit(event: SoundEvent, audible: boolean) {
    if (this.death.active) return
    // Every bot shot is aimed at you (bots do not fight each other yet), so draw it from the muzzle
    // toward your chest.
    if (event.kind.startsWith('enemy-shot-') && event.position && this.state.phase === 'active')
      this.tracers.fire(event.position, this.player.body.position.clone().setY(this.player.body.position.y + 1.2))
    const eye = this.camera.perspective.position
    const distance = event.position ? eye.distanceTo(event.position) : 0
    const inRange = !event.position || distance <= (event.radius ?? 38)
    if (inRange) this.audio.play(event)
    if (audible && event.radius && event.position) this.ai.hear(event)
    if (event.text && inRange && !event.kind.startsWith('shot-') && !event.kind.startsWith('enemy-shot')) {
      if (event.text !== this.lastCaption || this.state.elapsed - this.lastCaptionAt > 3) {
        this.hud.notify(event.text, 3.5); this.lastCaption = event.text; this.lastCaptionAt = this.state.elapsed
      }
    }
  }

  private soundDirection(point: THREE.Vector3) {
    const relative = point.clone().sub(this.camera.perspective.position).applyQuaternion(this.camera.perspective.quaternion.clone().invert())
    return Math.abs(relative.x) > Math.abs(relative.z) * 0.65 ? relative.x > 0 ? 'Right' : 'Left' : relative.z > 0 ? 'Behind' : 'Ahead'
  }

  private shot(shot: Shot) {
    if (!this.isActive()) return
    const surface = this.player.world.raySurface(shot.origin, shot.direction, shot.range)
    const distance = surface?.distance ?? shot.range
    this.ai.nearMiss(shot, distance)
    this.impactPoint = null
    // Damage numbers come from the health each bot actually lost, so they always match reality,
    // including headshot multipliers and shotgun falloff, without duplicating the AI's damage maths.
    const before = new Map(this.ai.enemies.map(enemy => [enemy.spec.id, enemy.health]))
    this.pendingHits = []
    const hit = this.ai.hit(shot, distance)
    for (const reaction of this.pendingHits) {
      const enemy = this.ai.enemies.find(candidate => candidate.spec.id === reaction.targetId)
      if (!enemy) continue
      const dealt = (before.get(enemy.spec.id) ?? 0) - enemy.health
      this.hits.hit(reaction.point, dealt, enemy.spec.id, reaction.zone === 'head', reaction.lethal)
      if (reaction.lethal) this.state.kills++
    }
    this.pendingHits = []
    if (hit) this.hitFlash = 0.15
    const end = this.impactPoint ?? shot.origin.clone().addScaledVector(shot.direction, distance)
    const impact = !hit && surface ? () => {
      this.audio.play({ kind: 'impact', position: end, radius: 18 })
      this.impacts.emit(end, shot.direction, surface, shot.weapon)
    } : undefined
    this.bulletTrails.emit(shot.origin, end, shot.weapon, undefined, impact)
  }

  damage(amount: number, cause: 'bullet' | 'fall' | 'storm', source?: THREE.Vector3, hit?: PlayerBulletHit) {
    if (this.invincible || !this.isActive() || !(amount > 0) || this.state.phase !== 'active') return
    this.state.health = Math.max(0, this.state.health - amount)
    if (this.state.health === 0) this.state.phase = 'dead'
    // The storm stings without the bullet camera kick; bullets and falls keep the full reaction.
    if (cause !== 'storm' && this.state.phase !== 'dead' && !this.hud.reducedMotion) {
      const point = this.player.body.position.clone().add(new THREE.Vector3(0, 1.17, 0))
      this.playerHits.hit(hit ?? { region: source ? 'torso' : 'leg', side: 0, point,
        direction: source ? point.clone().sub(source) : new THREE.Vector3(0, 1, 0) },
        amount, this.player.body.grounded && !this.player.actions.traversing)
    }
    this.hud.hurt(); this.audio.play({ kind: 'damage' })
    if (cause === 'bullet' && source) this.indicator.hit(source, amount)
    if (cause !== 'storm') {
      this.audio.play({ kind: 'bullet-hit', intensity: Math.min(1, amount / 28) })
      this.hud.hitFrom(1, source ? this.soundDirection(source) : 'Below')
      this.hud.notify(source ? `Taking fire · ${this.soundDirection(source).toLowerCase()}.` : 'You fell.', 2.5)
    } else this.hud.notify('You are in the storm. Get to the safe zone.', 1.5)
    if (this.state.phase === 'dead') {
      this.state.placement = this.aliveBots() + 1
      this.state.alive = this.aliveBots()
      this.playerHits.clear(); this.deaths++
      const direction = hit?.direction ?? (source ? this.camera.perspective.position.clone().sub(source) : undefined)
      this.death.begin(this.camera.perspective, this.player.body.position, this.player.world, this.hud.reducedMotion, direction)
      this.weapons.beginDeath()
      this.player.pause(); this.player.actions.reset(); this.cancelInput()
      this.player.body.velocity.set(0, 0, 0)
      this.audio.beginDeath()
      this.hud.setScoped(false); this.hud.clearThreat(); this.hud.setDeath(this.death)
    }
    this.invalidate()
  }

  private aliveBots() { return this.ai.enemies.filter(enemy => enemy.state !== 'dead').length }

  /** Storm position, wall, and damage to anyone outside it. Damage ticks once a second, as in Fortnite. */
  private updateStorm(dt: number) {
    const now = stormAt(this.storm, this.state.elapsed)
    this.state.stormPhase = now.phase; this.state.stormNextIn = now.nextIn; this.state.stormShrinking = now.shrinking
    // Bots first: if the storm takes the last bot on the same tick it would take you, you win.
    this.botStormTick += dt
    if (this.botStormTick >= 1) {
      this.botStormTick -= 1
      for (const enemy of this.ai.enemies) {
        if (enemy.state === 'dead') continue
        if (outsideBy(now.circle, enemy.position.x, enemy.position.z) > 0) this.ai.applyDamage(enemy.spec.id, now.damage)
      }
    }
    const body = this.player.body.position
    this.state.outside = outsideBy(now.circle, body.x, body.z) > 0
    const tick = advanceStormTimer(this.stormTick, dt, this.state.outside)
    this.stormTick = tick.timer
    for (let i = 0; i < tick.ticks && this.state.phase === 'active' && this.aliveBots() > 0; i++) this.damage(now.damage, 'storm')
    this.syncStorm()
  }

  private syncStorm() {
    const now = stormAt(this.storm, this.state.elapsed)
    // A closed storm has radius zero; keep a sliver so the mesh stays well-formed.
    const r = Math.max(0.5, now.circle.r)
    this.stormWall.wall.position.set(now.circle.x, this.stormWall.wall.position.y, now.circle.z)
    this.stormWall.wall.scale.set(r, 1, r)
    this.stormWall.material.uniforms.radius.value = r
    this.stormWall.material.uniforms.time.value = this.state.elapsed
  }

  private updateStatus() {
    const alive = this.state.phase === 'dead' ? this.aliveBots() : this.aliveBots() + 1
    this.state.alive = alive
    if (this.aliveEl.textContent !== String(alive)) this.aliveEl.textContent = String(alive)
    const storm = this.stormEl
    const text = this.state.outside ? `In the storm · ${fmt(this.state.stormNextIn)}`
      : `${this.state.stormShrinking ? 'Storm closing' : 'Storm moves in'} ${fmt(this.state.stormNextIn)}`
    if (storm.textContent !== text) storm.textContent = text
    const danger = String(this.state.outside)
    if (storm.dataset.danger !== danger) storm.dataset.danger = danger
    this.vignette.classList.toggle('on', this.state.outside && this.state.phase === 'active')
    const weapon = this.weaponEl, current = this.weapons.current
    if (weapon.hidden !== !current) weapon.hidden = !current
    if (current) {
      const label = weaponRules(current).label
      if (weapon.textContent !== label) weapon.textContent = label
      const tint = current.rarity ? RARITY_INFO[current.rarity].css : ''
      if (tint !== this.weaponTint) { this.weaponTint = tint; weapon.style.setProperty('--weapon', tint) }
    }
  }

  update(dt: number, _elapsed = dt) {
    this.finishFrame()
    const landingSpeed = this.player.body.landingSpeed
    this.player.body.landingSpeed = 0
    const active = this.isActive()
    if (this.player.immersive || !this.player.enabled || this.state.phase !== 'active') {
      this.playerHits.clear(); this.hud.clearThreat()
      if (this.player.immersive || !this.player.enabled || !this.death.active) { this.bulletTrails.clear(); this.ai.bulletTrails.clear() }
    }
    let deathVisible = this.death.active && this.player.enabled && !this.player.immersive
    const deathPlaying = deathVisible && !this.death.menuVisible && !document.hidden
    if (active !== this.active) { this.cancelInput(); this.active = active }
    this.audio.setActive(active || deathPlaying)
    const sense = () => ({ feet: this.player.body.position, eye: this.camera.perspective.position, velocity: this.player.body.velocity,
      alive: this.state.phase === 'active', radioEnabled: true,
      yaw: new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y })
    if (active) {
      this.state.elapsed += dt
      const body = this.player.body
      const b = this.world.bounds
      if (body.position.y < -12 || body.position.x < b.minX || body.position.x > b.maxX || body.position.z < b.minZ || body.position.z > b.maxZ) {
        body.teleport(this.safePosition); this.player.actions.syncCamera(this.camera.perspective)
        this.hud.notify('That is the edge of the map.', 3)
      } else if (!this.player.actions.traversing) this.damage(fallDamage(landingSpeed), 'fall')
      this.updateStorm(dt)
      this.ai.update(dt, sense())
      this.blood.update(dt); this.impacts.update(dt)
      const speed = Math.hypot(body.velocity.x, body.velocity.z)
      if (speed > 0.5 && body.grounded || this.player.actions.climbing) {
        this.stepTime += dt
        if (this.stepTime > (this.player.actions.climbing ? 0.5 : speed > 5 ? 0.3 : 0.48)) {
          this.stepTime = 0; this.emit({ kind: this.player.actions.climbing ? 'ladder' : 'footstep', position: body.position.clone(), radius: speed > 5 ? 15 : 6 }, true)
        }
      } else this.stepTime = 0
      this.safePosition.copy(body.position)
      this.interactionTime = Math.max(0, this.interactionTime - dt)
      if (this.state.phase === 'active' && this.aliveBots() === 0) {
        this.state.phase = 'complete'; this.state.placement = 1
        this.player.pause(); this.cancelInput()
        this.hud.notify('Victory Royale!', 8)
      }
    } else if (deathPlaying) {
      // The match carries on while you watch: bots keep fighting and the storm keeps closing.
      this.state.elapsed += dt
      this.player.world.refresh()
      this.updateStorm(dt)
      this.ai.update(dt, sense())
      this.blood.update(dt); this.impacts.update(dt)
    }
    const reactionActive = this.isActive()
    const hitPose = this.playerHits.update(reactionActive ? dt : 0,
      new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y, this.hud.reducedMotion)
    if (reactionActive) {
      const zoom = this.aiming && this.weapons.current?.name === 'sniper' && !this.weapons.reloading ? this.weapons.scopeMagnification : 1
      this.playerHits.applyCamera(this.camera.perspective, this.player.world, 1 / zoom)
    }
    deathVisible = this.death.active && this.player.enabled && !this.player.immersive
    if (deathVisible) {
      if (this.death.update(document.hidden ? 0 : dt, this.camera.perspective, this.player.world)) this.audio.play({ kind: 'player-fall' })
      this.weapons.updateDeath(this.death.elapsed, this.death.reducedMotion, this.death.hitKick, this.death.hitSide)
      this.hud.setDeath(this.death)
    } else {
      if (this.death.active) { this.death.reset(); this.weapons.resetDeath(); this.hud.clearDeath() }
      this.weapons.update(dt, { active: reactionActive && this.interactionTime === 0, climbing: this.player.actions.traversing,
        moving: this.player.body.velocity.length(), aiming: this.aiming, reducedMotion: this.hud.reducedMotion, feet: this.player.body.position, hitPose })
    }
    this.audio.update(this.camera.perspective)
    this.hud.setScoped(this.weapons.scoped, this.weapons.scopeMagnification)
    if (active || deathPlaying) { this.bulletTrails.update(dt); this.hitFlash -= dt }
    document.querySelector<HTMLElement>('.crosshair')?.classList.toggle('confirmed-hit', this.hitFlash > 0)
    this.hits.update(active || deathPlaying ? dt : 0, this.camera.perspective, window.innerWidth, window.innerHeight)
    const running = active || deathPlaying ? dt : 0
    this.tracers.update(running)
    this.indicator.update(running, this.camera.perspective.position,
      new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y)
    this.hotbar.update(this.weapons.slots, this.weapons.selectedSlot)
    this.updateStatus()
    this.hud.update(dt, this.state, { playing: this.player.playing, enabled: this.player.enabled && !this.player.immersive,
      weapon: this.weapons.current, reloading: this.weapons.reloading, position: this.player.body.position,
      yaw: new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y, deaths: this.deaths, ready: this.ready })
    return active || this.death.running
  }

  finishFrame() { this.playerHits.removeCamera() }

  dispose() {
    this.playerHits.clear(); this.disposed = true; this.abort.abort()
    this.stormWall.wall.removeFromParent(); this.stormWall.wall.geometry.dispose(); this.stormWall.material.dispose()
    this.hits.dispose(); this.status.remove(); this.vignette.remove()
    this.indicator.dispose(); this.hotbar.dispose(); this.tracers.dispose()
    this.bulletTrails.dispose(); this.weapons.dispose(); this.ai.dispose(); this.blood.dispose(); this.impacts.dispose()
    this.audio.dispose(); this.hud.dispose()
    this.player.movementLocked = false; this.player.onPlayingChange = () => {}; this.player.lookSensitivity = () => 1
    this.player.actions.extraTargets = () => []; this.player.actions.onAction = () => {}
  }
}
