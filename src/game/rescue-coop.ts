import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import type { MissionRuntime } from './runtime'
import { CoopLink, CoopLobby, PLAYER_COLORS, PLAYER_CSS, PartnerAvatar, PartnerTag, StandBar, savedName, saveName, toVector, vec, type CoopStatus, type PlayerState } from './shared/coop'
import { WorldMarker } from './zombies/markers'
import { REVIVE_ICON, ReviveSyringe } from './zombies/last-stand'
import { LAST_STAND_VIEW, SecondDraftRevive } from './zombies/revive'
import { GuardPuppets } from './guard-puppets'
import { GUARD_STATES, GUEST_OFFSETS, LastStand, RESCUE_COOP, ReviveHold, applyMirror, canRevive, decodeHurt, doorBits, encodeHurt, escapeReady, escortLeaders,
  everyoneDown, guardRows, mirrorMission, rescueInviteLink, type MissionMirror, type RescueIncoming, type RescueMessage } from './rescue-coop-rules'
import { useStation } from './mission'
import { setDoorOpen } from '../world/doors'
import { EYE_HEIGHT } from '../player/body'
import { ENEMY_COMBAT, WEAPON_RULES } from './balance'
import { bulletNearMiss } from './bullet-trails'
import type { ActionTarget } from '../player/actions'
import type { SurfaceHit } from '../player/collision'
import type { HitReaction } from './hit-reactions'
import type { PlayerBulletHit } from './player-hit-reactions'
import type { PlayerSense, Shot, SoundEvent, Station, WeaponItem, WeaponName, WeaponSnapshot } from './types'

/** Another player: what they last told us, their stickman, name tag and revive cross, and (on the host) what the guards see of them. */
type Teammate = { id: number; state: PlayerState | null; avatar: PartnerAvatar; tag: PartnerTag; marker: WorldMarker; sense: PlayerSense; heardAt: number }
type Tick = Extract<RescueMessage, { t: 'tick' }>

/** Sounds of the host's world its guests hear too: the guards' calls and reloads, the alarm horn, the bell, a panel. */
const SHARED_SOUNDS = new Set(['callout', 'horn', 'enemy-reload', 'bell', 'objective'])
const ignore = new THREE.Object3D()
/** Directions go at four decimals: two would throw a round tens of centimetres off at range. */
const fine = (v: THREE.Vector3): [number, number, number] => [Math.round(v.x * 1e4) / 1e4, Math.round(v.y * 1e4) / 1e4, Math.round(v.z * 1e4) / 1e4]

/**
 * The hostage rescue for two to four players (the rules and messages: rescue-coop-rules.ts). The host's game
 * is the mission; a guest's draws it and owns only its player. Solo play never touches any of this: nothing
 * here runs until someone opens a room from the menu's Co-op page or an invite link.
 *
 * Down, not dead: a player the guards drop goes into a last stand (on the floor, crawling, with a pistol) and
 * bleeds out unless a teammate holds F over them. With everyone down the mission fails for all, and the
 * normal try-again runs from the host.
 */
export class RescueCoop {
  readonly link: CoopLink<RescueMessage, RescueIncoming>
  /** Every other player, by number (the host 0, guests 1 to 3). */
  readonly mates = new Map<number, Teammate>()
  status: CoopStatus = { kind: 'idle' }
  /** Your last stand: down and bleeding out, or out of this attempt. */
  readonly stand = new LastStand()
  /** Reviving a teammate. */
  readonly hold = new ReviveHold()
  /** The last stand's view: low on one elbow, rocking with the crawl. */
  readonly view = new SecondDraftRevive()
  /** Host: the mission has begun since it last started over, so its world runs for everyone, menus open or not. */
  begun = false
  /** Host: whose round the guards are being hit by (0 the host). */
  shooter = 0
  private reaction: HitReaction | null = null
  private syringe: ReviveSyringe
  private bar: StandBar
  private lobby: CoopLobby | null = null
  private puppets: GuardPuppets
  private tick: Tick | null = null
  private sendTimer = 0
  private clock = 0
  /** Doors we just swung, until the host's ticks catch up with them. */
  private pendingDoors = new Map<number, number>()
  /** The guns you went down with, back in your hands when you are picked up. */
  private downWeapons: WeaponSnapshot | null = null
  private placed = false
  private euler = new THREE.Euler()

  constructor(private r: MissionRuntime, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private hudRoot: HTMLElement) {
    this.link = new CoopLink<RescueMessage, RescueIncoming>(rescueInviteLink, message => this.message(message), status => this.statusChanged(status), (id, joined) => this.peer(id, joined))
    this.syringe = new ReviveSyringe(camera)
    this.bar = new StandBar(hudRoot)
    this.puppets = new GuardPuppets(r.ai, event => r.emit(event, false))
    // Opened from an invite: join once the mission has loaded (its start stays this browser's own, to go back to
    // if the host leaves, and the guest is placed after the load puts the player at the insertion point), and
    // show the Co-op page, where the Jump in button is.
    const invite = new URLSearchParams(location.search).get('join')
    if (invite) {
      void r.initialized.then(() => {
        if (!r.ready) return
        this.link.open(invite)
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-menu-open="coop"]')?.click())
      })
    }
  }

  get paired() { return this.link.paired }
  /** This browser is a guest: the mission is the host's. */
  get isGuest() { return this.link.role === 'guest' }
  /** This browser is the host, with at least one guest. */
  get hosting() { return this.link.role === 'host' && this.link.paired }
  get name() { return savedName(`Player ${this.link.id + 1}`) }

  /** The Co-op page on the menu. */
  buildLobby(slot: HTMLElement) {
    this.lobby = new CoopLobby(slot, () => ({ status: this.status, name: this.name, role: this.link.role, peers: this.link.peers.size,
      players: [{ id: this.link.id, name: this.name, me: true }, ...this.matesHere().map(mate => ({ id: mate.id, name: mate.state.name, me: false }))] }),
    { invite: join => this.link.open(join), cancel: () => { this.link.close(); this.statusChanged({ kind: 'idle' }) }, rename: name => { saveName(name); this.lobby?.render() } })
  }
  showLobby() { this.lobby?.render() }

  // ---------------------------------------------------------------- teammates

  private mate(id: number): Teammate {
    let mate = this.mates.get(id)
    if (!mate) {
      const avatar = new PartnerAvatar(this.scene, PLAYER_COLORS[id] ?? PLAYER_COLORS[0])
      void avatar.load()
      const marker = new WorldMarker(this.hudRoot, REVIVE_ICON, 'A downed teammate', 0)
      marker.element.classList.add('coop-revive')
      mate = { id, state: null, avatar, tag: new PartnerTag(this.hudRoot, `Player ${id + 1}`, PLAYER_CSS[id] ?? PLAYER_CSS[0]), marker, heardAt: -1,
        sense: { feet: new THREE.Vector3(), eye: new THREE.Vector3(), velocity: new THREE.Vector3(), alive: false, radioEnabled: true, id } }
      this.mates.set(id, mate)
    }
    return mate
  }

  private dropMate(id: number) {
    const mate = this.mates.get(id)
    if (!mate) return
    mate.avatar.dispose(); mate.tag.dispose(); mate.marker.dispose()
    this.mates.delete(id)
  }

  private mateName(id: number) { return this.mates.get(id)?.state?.name || `Player ${id + 1}` }

  /** Teammates who have told us where they are. */
  private matesHere() { return [...this.mates.values()].filter((mate): mate is Teammate & { state: PlayerState } => !!mate.state) }

  /** Host: a guest said where they are. What the guards see of them follows. */
  private heard(from: number, state: PlayerState) {
    const mate = this.mate(from), sense = mate.sense, feet = toVector(state.p), since = this.clock - mate.heardAt
    if (mate.state && since > 0 && since < 0.5) sense.velocity.copy(feet).sub(sense.feet).divideScalar(since)
    else sense.velocity.set(0, 0, 0)
    sense.feet.copy(feet)
    sense.eye.copy(feet).setY(feet.y + (state.dn ? EYE_HEIGHT - LAST_STAND_VIEW.drop : EYE_HEIGHT))
    // The guards leave alone a player who is down, or has the menu open.
    sense.alive = state.dn === 0 && !state.ps
    sense.yaw = state.yaw
    mate.heardAt = this.clock
    mate.state = { ...state, id: from }
  }

  private myState(): PlayerState {
    const r = this.r, body = r.player.body, e = this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ')
    return { id: this.link.id, p: vec(body.position), yaw: Math.round(e.y * 100) / 100, pitch: Math.round(e.x * 100) / 100, w: r.weapons.current?.name ?? null,
      mv: Math.hypot(body.velocity.x, body.velocity.z) > 0.6 ? 1 : 0, dn: this.stand.down, pts: 0, kills: r.state.kills, name: this.name,
      rv: this.hold.active ? Math.round(this.hold.fraction * 100) / 100 : 0, rt: this.hold.active ? this.hold.target : undefined, ps: r.player.playing ? 0 : 1 }
  }

  // ---------------------------------------------------------------- the host's world

  /** Host: can the guards and cameras see the local player (up, and in co-op not in the menu). */
  hostVisible() { return this.stand.down === 0 && (!this.paired || this.r.player.playing) }

  /** Host: the guests the guards can see and shoot. */
  senses(): PlayerSense[] { return this.hosting ? this.matesHere().map(mate => mate.sense) : [] }

  /** Host: the eyes the cameras can catch. Alone, the player's. */
  eyes(own: THREE.Vector3, ownVisible: boolean): THREE.Vector3 | THREE.Vector3[] {
    if (!this.hosting) return own
    const eyes = this.matesHere().filter(mate => mate.sense.alive).map(mate => mate.sense.eye)
    if (ownVisible) eyes.unshift(own)
    return eyes
  }

  /** Host: who the hostage follows. Alone, the player. */
  leaders(own: THREE.Vector3): THREE.Vector3 | THREE.Vector3[] {
    const hostage = this.r.state.hostages[0]
    if (!this.hosting || !hostage) return own
    return escortLeaders(hostage.position, hostage.by, [{ id: 0, feet: own, up: this.stand.down === 0 },
      ...this.matesHere().map(mate => ({ id: mate.id, feet: mate.sense.feet, up: mate.state.dn === 0 }))])
  }

  /** Host: guests reaching the detention block count for the objective too. */
  guestsProgress() {
    const state = this.r.state
    for (const mate of this.matesHere()) {
      const [x, y, z] = mate.state.p
      if (Math.abs(x - 117) < 10 && z > -31 && z < -2) state.detentionFound = true
      if (state.detentionFound && y < -2.8) state.cellsReached = true
    }
  }

  /** The world goes on while this player has the menu open: the host's, for its guests; a guest's follows the host. */
  worldRuns() {
    const r = this.r
    if (!this.paired || !r.ready || r.escape.active || !r.player.enabled || r.player.immersive || r.state.phase !== 'active') return false
    return this.isGuest || this.begun
  }

  /** Guest: the guards, the hostage and the cameras as the host's last tick has them. */
  guestStep(dt: number) {
    const r = this.r, tick = this.tick
    // The mission clock runs on between ticks, so the cameras sweep smoothly; each tick sets it again.
    if (r.state.phase === 'active') r.state.elapsed += dt
    this.puppets.update(dt, tick?.g ?? [])
    r.escort.follow(dt, r.state, tick?.h ?? [])
    r.security.sync(r.state)
  }

  // ---------------------------------------------------------------- your own player

  /** In play (host or guest): reviving a teammate, and the last stand's view. */
  frame(dt: number) {
    if (!this.paired) return
    const r = this.r, body = r.player.body
    if (this.hold.active) {
      const target = this.hold.target, mate = this.mates.get(target)
      const near = !!mate?.state && canRevive({ dn: this.stand.down, feet: body.position }, { dn: mate.state.dn, feet: mate.avatar.feet })
      const result = this.hold.step(dt, near && r.player.useHeld)
      if (result === 'stopped') { r.player.movementLocked = this.stand.down === 2; this.syringe.stop() }
      else if (result === 'done') this.revived(target)
      else r.interactionTime = Math.max(r.interactionTime, 0.2)
    }
    this.view.crawl = this.stand.down === 1 ? Math.hypot(body.velocity.x, body.velocity.z) : 0
    this.view.update(dt)
  }

  /** Low on the floor while down, for this frame (finishFrame puts it back). */
  applyView(camera: THREE.PerspectiveCamera, reducedMotion: boolean) { this.view.applyCamera(camera, reducedMotion) }

  /** Your gun works in the last stand once you are done falling. */
  canShoot() { return !this.view.down || this.view.settled }

  /** Co-op: a hit on your own health; false when you are down already. */
  takeHit(amount: number) {
    if (this.stand.down || !(amount > 0)) return false
    this.r.state.health = Math.max(0, this.r.state.health - amount)
    return true
  }

  /** Down, not dead: on the floor with a pistol, crawling, until a teammate gets you up or you bleed out. */
  goDown() {
    if (!this.stand.fall()) return
    const r = this.r
    r.state.health = 0
    r.cancelInput()
    this.hold.stop(); this.syringe.stop()
    this.lastStandPistol()
    r.player.movementLocked = false; r.player.crawling = true; r.player.actions.disabled = true
    r.player.body.velocity.set(0, 0, 0)
    this.view.holdDown()
    r.audio.play({ kind: 'player-fall' })
    r.hud.notify('You are down. Crawl and keep shooting: a teammate can pick you up.', 4, true)
    this.link.send({ t: 'down', dn: 1 })
  }

  /** Out comes a pistol you carry, or a spare one. */
  private lastStandPistol() {
    const r = this.r, snapshot = r.weapons.snapshot()
    this.downWeapons = snapshot
    const held = snapshot.slots.find(item => item?.name === 'pistol' && item.magazine + item.reserve > 0)
    const pistol: WeaponItem = held ?? { id: 'last-stand-pistol', name: 'pistol', magazine: WEAPON_RULES.pistol.capacity, reserve: WEAPON_RULES.pistol.capacity * 2 }
    r.weapons.restore({ slots: snapshot.slots.map((_, index) => index ? null : pistol), selected: 0, pickups: snapshot.pickups, nextId: snapshot.nextId })
  }

  /** Picked up: half your health back, and every gun you went down with (the pistol keeps what it has left). */
  private getUp() {
    if (!this.stand.revive()) return false
    const r = this.r
    r.state.health = RESCUE_COOP.reviveHealth
    this.view.release()
    r.player.movementLocked = false; r.player.crawling = false; r.player.actions.disabled = false
    if (this.downWeapons) {
      const back = this.downWeapons, pistol = r.weapons.current, now = r.weapons.snapshot()
      this.downWeapons = null
      const same = pistol && back.slots.find(item => item?.id === pistol.id)
      if (same && pistol) { same.magazine = pistol.magazine; same.reserve = pistol.reserve }
      r.weapons.restore({ ...back, pickups: now.pickups, nextId: Math.max(back.nextId, now.nextId) })
    }
    this.link.send({ t: 'down', dn: 0 })
    return true
  }

  /** Bled out: nothing in your hands, flat on the floor for the rest of this attempt. */
  private bledOut() {
    const r = this.r, snapshot = r.weapons.snapshot()
    r.player.crawling = false
    r.player.movementLocked = true
    this.hold.stop(); this.syringe.stop()
    this.downWeapons = null
    r.weapons.restore({ slots: snapshot.slots.map(() => null), selected: 0, pickups: snapshot.pickups, nextId: snapshot.nextId })
    r.hud.notify('You bled out. Your team can still finish the rescue.', 4, true)
    this.link.send({ t: 'down', dn: 2 })
  }

  /** Revive prompts over teammates who are down within reach. */
  reviveTargets(): ActionTarget[] {
    if (!this.paired || this.stand.down) return []
    const feet = this.r.player.body.position, targets: ActionTarget[] = []
    for (const mate of this.mates.values()) {
      if (!mate.state || !canRevive({ dn: 0, feet }, { dn: mate.state.dn, feet: mate.avatar.feet })) continue
      targets.push({ object: mate.avatar.actor?.root ?? ignore, point: mate.avatar.feet.clone().setY(mate.avatar.feet.y + 0.6), kind: 'mission', descending: false,
        label: `Hold to revive ${mate.state.name}`, use: () => {
          this.hold.start(mate.id); this.r.player.movementLocked = true; this.r.cancelInput(); this.syringe.start(); return true } })
    }
    return targets
  }

  /** You got a teammate up: the host tells them, or a guest asks the host to. */
  private revived(id: number) {
    const r = this.r, mate = this.mates.get(id)
    r.player.movementLocked = this.stand.down === 2
    this.syringe.stop()
    if (!mate) return
    if (this.link.role === 'host') this.link.send({ t: 'revive', by: this.name }, { to: id })
    else this.link.send({ t: 'revive', target: id, by: this.name })
    if (mate.state) mate.state.dn = 0
    r.hud.notify(`You got ${this.mateName(id)} back up.`, 2.5)
  }

  /** Every frame, playing or not: bleeding out, the teammates, the last stand's bar, the lobby, and what we send. */
  idle(dt: number) {
    this.clock += dt
    const r = this.r, paired = this.paired
    // No bleeding out once the jeep is on its way: a downed player rides along.
    if (paired && r.state.phase === 'active' && !r.escape.active && this.stand.step(dt)) this.bledOut()
    // Down with nobody left to get you up: the rescue is lost.
    if (!paired && this.stand.down && r.state.phase === 'active') r.fail()
    const showing = paired && !r.escape.active
    for (const mate of this.mates.values()) {
      const state = showing ? mate.state : null
      // A reviver kneels facing whoever they are reviving: us, or another teammate.
      mate.avatar.poses.reviveAt = state?.rv && state.rt !== undefined
        ? state.rt === this.link.id ? r.player.body.position : this.mates.get(state.rt)?.avatar.feet ?? null : null
      mate.avatar.update(dt, state)
      if (state) mate.tag.name(state.name)
      mate.tag.update(this.camera, state ? mate.avatar.head() : null, !!state?.dn)
      mate.marker.update(this.camera, r.player.playing && state?.dn === 1 ? mate.avatar.feet.clone().setY(mate.avatar.feet.y + 0.9) : null)
    }
    this.standBar()
    this.syringe.update(dt, this.hold.active ? this.hold.fraction : 1)
    this.lobby?.refresh()
    // Everyone down or out: the mission is lost for all.
    if (this.hosting && r.state.phase === 'active' && !r.escape.active && everyoneDown([this.stand.down, ...this.matesHere().map(mate => mate.state.dn)])) r.fail()
    if (!paired || (this.sendTimer -= dt) > 0) return
    this.sendTimer = 1 / RESCUE_COOP.sendRate
    if (this.link.role === 'host') {
      this.link.send({ t: 'tick', g: guardRows(r.ai.enemies), m: mirrorMission(r.state), d: doorBits(r.player.actions.doors),
        players: [this.myState(), ...this.matesHere().map(mate => mate.state)], h: r.escort.motion })
    } else this.link.send({ t: 'me', me: this.myState() })
  }

  /** One bar under the crosshair: yours to fill, a teammate filling it for you, or your time running out. */
  private standBar() {
    if (!this.paired) { this.bar.show(null); return }
    const helper = this.stand.down === 1 ? this.matesHere().find(mate => mate.state.rv && mate.state.rt === this.link.id) : undefined
    if (this.hold.active) this.bar.show(`Reviving ${this.mateName(this.hold.target)}`, this.hold.fraction)
    else if (helper) this.bar.show(`${helper.state.name} is reviving you`, helper.state.rv!)
    else if (this.stand.down === 1) this.bar.show('Bleeding out', this.stand.bleed / RESCUE_COOP.bleedSeconds, 'bleed')
    else this.bar.show(null)
  }

  // ---------------------------------------------------------------- shots, uses, sounds

  /** Guest: the host has the real guards and works the round out; here it stops at the guard it meets, or flies on to the wall. */
  guestShot(shot: Shot, surface: SurfaceHit | null, distance: number) {
    const r = this.r
    this.link.send({ t: 'shot', o: vec(shot.origin), d: fine(shot.direction), range: shot.range, damage: shot.damage,
      weapon: shot.weapon ?? r.weapons.current?.name ?? 'pistol', pellet: shot.pelletIndex })
    const body = r.ai.aimDistance(shot.origin, shot.direction, distance)
    const end = shot.origin.clone().addScaledVector(shot.direction, Math.min(body, distance))
    const impact = body >= distance && surface ? () => {
      r.audio.play({ kind: 'impact', position: end, radius: 18 })
      r.impacts.emit(end, shot.direction, surface, shot.weapon)
    } : undefined
    r.bulletTrails.emit(shot.origin, end, shot.weapon, undefined, impact)
    if (!shot.pelletIndex) this.link.send({ t: 'fire', o: vec(shot.origin), e: vec(end), w: shot.weapon ?? 'pistol' })
  }

  /** Host: our own shot, for the guests to see and hear. */
  fired(origin: THREE.Vector3, end: THREE.Vector3, weapon?: WeaponName) {
    if (this.hosting) this.link.send({ t: 'fire', o: vec(origin), e: vec(end), w: weapon ?? 'pistol' })
  }

  /** Host: a guard fired; the guests see the flash and the round, and hear it. */
  guardFired(index: number, muzzle: THREE.Vector3, end: THREE.Vector3, weapon: WeaponName) {
    if (this.hosting) this.link.send({ t: 'fire', o: vec(muzzle), e: vec(end), w: weapon, g: index })
  }

  /** Host: a guard was hit (by anyone): every guest plays the same reaction. */
  guardHit(hit: HitReaction) {
    this.reaction = hit
    if (!this.hosting) return
    const index = this.r.ai.enemies.findIndex(enemy => enemy.spec.id === hit.targetId)
    if (index < 0) return
    this.link.send({ t: 'react', g: index, c: hit.clip ?? 'flinchBody', l: hit.lethal ? 1 : 0, d: fine(hit.direction), tr: Math.round((hit.travel ?? 1) * 100) / 100,
      z: hit.zone, p: vec(hit.point), w: hit.weapon, b: hit.bone })
  }

  /** Host: a guard's round struck guest `id`. */
  hurt(id: number, amount: number, source: THREE.Vector3, hit?: PlayerBulletHit) {
    this.link.send({ t: 'hurt', n: amount, s: vec(source), h: hit ? encodeHurt(hit) : undefined }, { to: id })
  }

  /** Host: a guard's gun on the floor, for every guest. */
  dropped(item: WeaponItem) { if (this.hosting) this.link.send({ t: 'drop', item }) }

  /** We picked a gun up: it goes for everyone. */
  took(id: string) {
    if (!this.paired) return
    if (this.isGuest) this.link.send({ t: 'take', id })
    else this.link.send({ t: 'taken', id })
  }

  /** Host: the sounds of its world that guests hear as well (a guard opening a door comes without `audible`). */
  shareSound(event: SoundEvent, audible: boolean) {
    if (!this.hosting || !(SHARED_SOUNDS.has(event.kind) || (event.kind === 'door' && !audible))) return
    this.link.send({ t: 'snd', k: event.kind, p: event.position ? vec(event.position) : undefined, r: event.radius, x: event.text, v: event.voice, s: event.speaker, w: event.weapon })
  }

  /** Guest: a sound the host's guards may hear (our gunfire goes as a fire message). */
  noise(event: SoundEvent) {
    if (!this.isGuest || !this.paired || !event.position || !event.radius || event.kind.startsWith('shot-')) return
    this.link.send({ t: 'noise', k: event.kind, p: vec(event.position), r: event.radius })
  }

  /** We swung a door: the host swings it for everyone. */
  doorUsed(door: THREE.Object3D) {
    if (!this.paired) return
    const index = this.r.player.actions.doors.indexOf(door as THREE.Group)
    if (index < 0) return
    this.pendingDoors.set(index, this.clock + 0.8)
    this.link.send({ t: 'door', i: index, o: door.userData.open ? 1 : 0 })
  }

  /** Guest: ask the host to use a panel, a cell lock, the jeep. */
  requestUse(station: Station) {
    const r = this.r
    if (!this.paired) return false
    if (station.kind === 'supply' && r.state.health >= 100) { r.hud.notify('Health is full. Leave the dressing for later.', 7); return false }
    if (station.kind === 'jeep' && !this.jeepReady()) { r.hud.notify('The jeep leaves when everyone is here, or when the host says go.', 4); return false }
    this.link.send({ t: 'use', id: station.id })
    return true
  }

  /** Host: a guest used a station. Same checks and effects as the host's own use; the guest hears how it went. */
  private guestUse(id: string, from: number) {
    const r = this.r, mate = this.mates.get(from), station = r.world.stations.find(candidate => candidate.id === id)
    if (!station || !mate?.state || mate.state.dn || r.state.phase !== 'active' || r.escape.active) return
    if (mate.sense.feet.clone().setY(mate.sense.feet.y + EYE_HEIGHT).distanceTo(station.point) > RESCUE_COOP.useReach) return
    const note = (text: string, seconds = 7) => this.link.send({ t: 'note', x: text, s: seconds }, { to: from })
    if (station.kind === 'supply') {
      if (r.state.supplies.includes(id)) return
      r.state.supplies.push(id)
      this.link.send({ t: 'heal' }, { to: from })
      return
    }
    if (station.kind === 'jeep') {
      if (r.gateOpening()) { note('Wait for the exit gate to finish opening.', 3); return }
      if (!this.jeepReady()) { note('The jeep leaves when everyone is here, or when the host says go.', 4); return }
    }
    const result = useStation(r.state, station.kind, id)
    if (result.message) note(result.message)
    if (!result.changed) return
    r.stationEffects(station, from, result.message)
    r.syncWorld(); r.invalidate()
  }

  /** Host: a station changed the mission; the others hear who did what. */
  used(station: Station, by: number, message: string) {
    if (!this.hosting || station.kind === 'supply' || !message) return
    const text = `${by ? this.mateName(by) : this.name}: ${message}`
    this.link.send({ t: 'note', x: text, s: 6 }, by ? { skip: by } : undefined)
    if (by) this.r.hud.notify(text, 6)
  }

  /** The jeep can leave: everyone still up is at it. */
  jeepReady() {
    const r = this.r, jeep = r.world.stations.find(station => station.kind === 'jeep')
    if (!this.paired || !jeep) return true
    return escapeReady([{ feet: r.player.body.position, up: this.stand.down === 0 },
      ...this.matesHere().map(mate => ({ feet: mate.avatar.feet, up: mate.state.dn === 0 }))], jeep.point)
  }

  /** The jeep's prompt in co-op: board when everyone is there; the host can leave now and take them along. */
  jeepLabel() { return this.jeepReady() ? 'Board jeep' : this.link.role === 'host' ? 'Leave now · everyone rides along' : 'Waiting for everyone at the jeep' }

  // ---------------------------------------------------------------- the mission's turns

  /** Play began or paused: the host's first start begins the mission for everyone. */
  playing(playing: boolean) {
    // A guest who pauses says so at once: a tab in the background sends nothing more, and the guards leave a paused player alone.
    if (!playing && this.isGuest) this.link.send({ t: 'me', me: this.myState() })
    if (!playing || this.link.role !== 'host' || this.begun) return
    this.begun = true
    this.link.send({ t: 'start', by: this.name })
  }

  /** The escape begins: the host takes every guest along. */
  escaping() {
    this.hold.stop(); this.syringe.stop()
    if (this.hosting) this.link.send({ t: 'escape' })
  }

  /** Everyone is down: the host tells the guests; whoever was on the floor goes on from there. */
  failed() {
    if (this.hosting) this.link.send({ t: 'fail' })
    const down = !!this.stand.down
    this.hold.stop(); this.syringe.stop(); this.view.reset()
    if (down) this.camera.position.y -= LAST_STAND_VIEW.drop
    this.r.player.crawling = false; this.r.player.actions.disabled = false
    this.bar.show(null)
  }

  /** Back to the checkpoint (every player, each time the mission starts over). */
  clear() {
    this.stand.reset(); this.hold.stop(); this.syringe.stop(); this.view.reset()
    this.downWeapons = null; this.pendingDoors.clear(); this.begun = false
    this.r.player.crawling = false; this.r.player.actions.disabled = false
    this.bar.show(null)
    this.lobby?.started(false)
  }

  /** Host: after a try again or a restart, the guests start over too. */
  resetAll(kind: 'retry' | 'restart') {
    if (!this.hosting) return
    this.link.send({ t: 'reset', kind })
    this.sendSync()
  }

  /** Guest: only the host can start the mission over; ask it (once the mission is lost or won). */
  asksHost(kind: 'retry' | 'restart') {
    if (!this.isGuest || !this.paired) return false
    if (this.r.state.phase === 'active') this.r.hud.notify('Only the host can start the mission over.', 3)
    else { this.link.send({ t: 'again', kind }); this.r.hud.notify('Asked the host to start again.', 3) }
    return true
  }

  private sendSync(to?: number) {
    const r = this.r
    if (this.link.role !== 'host' || !this.paired) return
    this.link.send({ t: 'sync', m: mirrorMission(r.state), d: doorBits(r.player.actions.doors), pickups: r.weapons.snapshot().pickups, begun: this.begun ? 1 : 0 },
      to === undefined ? undefined : { to })
  }

  /** Guest: start beside the host at the insertion point, not inside them. */
  private placeGuest(force = false) {
    const r = this.r
    if (!this.isGuest || (this.placed && !force) || (r.player.playing && !force)) return
    this.placed = true
    const offset = GUEST_OFFSETS[this.link.id] ?? GUEST_OFFSETS[1]
    const spot = new THREE.Vector3(...r.world.spawn).add(new THREE.Vector3(...offset))
    const floor = r.player.world.floor(spot.clone().setY(spot.y + 0.6), 1, 1.5)
    if (Number.isFinite(floor)) spot.y = floor
    if (!r.player.world.fits(new Capsule(spot.clone().setY(spot.y + 0.35), spot.clone().setY(spot.y + 1.5), 0.3))) return
    r.player.body.teleport(spot)
    r.player.actions.syncCamera(this.camera)
  }

  // ---------------------------------------------------------------- messages

  private message(m: RescueIncoming) {
    const r = this.r, from = m.from ?? 0
    switch (m.t) {
      // ---- on a guest
      case 'sync':
        this.mirror(m.m)
        this.applyDoors(m.d, true)
        this.applyPickups(m.pickups)
        this.lobby?.started(!!m.begun)
        this.placeGuest()
        break
      case 'tick': {
        if (!Array.isArray(m.g) || !m.m || !Array.isArray(m.players)) break
        this.tick = m
        // Everyone else, as the host sees them; anyone missing has left.
        for (const player of m.players) if (player.id !== this.link.id) this.mate(player.id).state = player
        for (const id of [...this.mates.keys()]) if (!m.players.some(player => player.id === id)) this.dropMate(id)
        this.mirror(m.m)
        this.applyDoors(m.d)
        break
      }
      case 'react': {
        const hit = this.puppets.react(m.g, m.c, !!m.l, toVector(m.d), m.tr, m.z, toVector(m.p), m.w, m.b)
        if (hit) r.blood.emitHit(hit)
        // The last tick still has him standing: until the next one comes, he stays down and his fall plays on.
        const row = hit?.lethal ? this.tick?.g.find(row => row[0] === m.g) : undefined
        if (row) row[1] = GUARD_STATES.indexOf('dead')
        break
      }
      case 'hit':
        r.hitFlash = 0.15
        r.audio.confirmHit({ zone: m.z, lethal: !!m.l })
        if (m.l) r.state.kills++
        break
      case 'hurt': r.damage(m.n, m.s ? toVector(m.s) : undefined, m.h ? decodeHurt(m.h) : undefined); break
      case 'snd':
        r.emit({ kind: m.k, position: m.p ? toVector(m.p) : undefined, radius: m.r, text: m.x, voice: m.v, speaker: m.s, weapon: m.w }, false)
        break
      case 'note': r.hud.notify(m.x, m.s ?? 5); break
      case 'drop': r.weapons.addPickup(m.item); break
      case 'taken': r.weapons.removePickup(m.id); break
      case 'heal':
        r.state.health = 100
        r.hud.notify('Field dressing used. Health restored.', 7)
        break
      case 'start':
        this.lobby?.started()
        r.hud.notify(`${m.by || this.mateName(0)} started the mission.`, 3)
        break
      case 'escape':
        if (!r.escape.active) { r.state.jeep = 'escaping'; r.beginEscape() }
        break
      case 'fail': r.fail(); break
      case 'reset':
        if (m.kind === 'retry') r.retry(true); else r.restart(true)
        this.placeGuest(true)
        break
      // ---- either way
      case 'fire': this.fire(m, from); break
      case 'door': {
        const door = r.player.actions.doors[m.i]
        if (!door) break
        setDoorOpen(door, !!m.o)
        this.pendingDoors.delete(m.i)
        r.audio.play({ kind: 'door', position: door.getWorldPosition(new THREE.Vector3()), radius: 8 })
        if (this.link.role === 'host') this.link.send({ t: 'door', i: m.i, o: m.o }, { skip: from })
        break
      }
      case 'revive':
        // On the host, a guest's revive of another guest is passed on.
        if (this.link.role === 'host' && m.target !== undefined && m.target !== 0) {
          this.link.send({ t: 'revive', by: m.by }, { to: m.target })
          const mate = this.mates.get(m.target)
          if (mate?.state) mate.state.dn = 0
        } else if (this.getUp()) r.hud.notify(`${m.by ?? 'A teammate'} got you back up.`, 2.5)
        break
      case 'down': { const mate = this.mates.get(from); if (mate?.state) mate.state.dn = m.dn; break }
      // ---- on the host
      case 'me': this.heard(from, m.me); break
      case 'shot': this.partnerShot(m, from); break
      case 'use': this.guestUse(m.id, from); break
      case 'noise':
        if (m.r > 0 && m.r <= 60) r.ai.hear({ kind: m.k, position: toVector(m.p), radius: m.r })
        break
      case 'take':
        r.weapons.removePickup(m.id)
        this.link.send({ t: 'taken', id: m.id }, { skip: from })
        break
      case 'again':
        if (r.state.phase === 'active') break
        if (m.kind === 'retry') r.retry(); else r.restart()
        break
    }
  }

  /** A shot to see and hear: a guard's (his flash, the round, a near miss), or a teammate's (as Dead Ink's co-op). */
  private fire(m: Extract<RescueMessage, { t: 'fire' }>, from: number) {
    const r = this.r, o = toVector(m.o), e = toVector(m.e)
    const weapon = (m.w in WEAPON_RULES ? m.w : 'pistol') as WeaponName
    if (m.g === undefined) {
      r.bulletTrails.emit(o, e, weapon)
      // On the host a guest's shot is heard by the guards, and scares the hostage.
      r.emit({ kind: `shot-${weapon}`, position: o, radius: weapon === 'pistol' ? 38 : 55 }, this.link.role === 'host')
      if (this.link.role === 'host') this.link.send({ t: 'fire', o: m.o, e: m.e, w: m.w }, { skip: from })
      return
    }
    // A guard's round leaves his gun here; the host's muzzle when ours is far off (he has only just moved).
    this.puppets.fired(m.g)
    const muzzle = r.ai.enemies[m.g]?.actor.muzzle() ?? o.clone()
    if (muzzle.distanceTo(o) > 1.5) muzzle.copy(o)
    const enemy = r.ai.enemies[m.g], sniper = enemy?.spec.role === 'sniper' || weapon === 'sniper'
    r.emit({ kind: `enemy-shot-${weapon}`, position: muzzle.clone(), radius: (sniper ? ENEMY_COMBAT.sniperEngagedRange : ENEMY_COMBAT.engagedRange) + 20 }, false)
    const direction = e.clone().sub(muzzle).normalize(), length = muzzle.distanceTo(e)
    const surface = r.player.world.raySurface(muzzle, direction, length + 0.2)
    const impact = surface && Math.abs(surface.distance - length) < 0.3 ? () => {
      r.emit({ kind: 'impact', position: e.clone(), radius: 18 }, false)
      r.impacts.emit(e, direction, surface, weapon)
    } : undefined
    // A near miss past our head, heard as it goes by (not the round that hits us: that one we feel).
    const eye = this.camera.position
    const near = !this.stand.down && e.distanceTo(eye) > 0.9 ? bulletNearMiss(muzzle, e, eye) : null
    r.ai.bulletTrails.emit(muzzle, e, weapon, near ? { fraction: near.fraction, fire: () => {
      const pass = bulletNearMiss(muzzle, e, this.camera.position)
      if (pass && r.player.world.visible(pass.point, this.camera.position, ignore)) {
        r.emit({ kind: 'enemy-bullet-whiz', position: pass.point, source: muzzle.clone(), intensity: pass.intensity, radius: 5 }, false)
      }
    } } : undefined, impact)
  }

  /** Host: works out a guest's round against its guards, and sends that guest the hit marker. */
  private partnerShot(m: Extract<RescueMessage, { t: 'shot' }>, from: number) {
    const r = this.r, mate = this.mates.get(from), rules = WEAPON_RULES[m.weapon]
    if (!mate?.state || !rules || r.state.phase !== 'active') return
    const origin = toVector(m.o), direction = toVector(m.d).normalize()
    if (!(direction.lengthSq() > 0.5)) return
    const range = Math.min(m.range, rules.range)
    const shot: Shot = { origin, direction, range, damage: Math.min(m.damage, rules.damage), weapon: m.weapon, pelletIndex: m.pellet }
    const surface = r.player.world.raySurface(origin, direction, range)
    const distance = surface?.distance ?? range
    r.ai.nearMiss(shot, distance)
    this.shooter = from
    this.reaction = null
    const hit = r.ai.hit(shot, distance, mate.sense)
    this.shooter = 0
    const reaction = this.reaction as HitReaction | null
    if (hit && reaction) this.link.send({ t: 'hit', p: vec(reaction.point), z: reaction.zone, l: reaction.lethal ? 1 : 0 }, { to: from })
  }

  /**
   * Guest: take the host's world, keeping our own escape running to its end on our own clock. The host's
   * failure and escape come as messages; a tick that gets here first starts them all the same.
   */
  private mirror(mirror: MissionMirror) {
    const r = this.r, state = r.state
    const key = () => `${state.gateOpen}|${state.hostages.map(hostage => hostage.status).join()}|${state.camerasActive}|${state.alarm}`
    const before = key()
    const failing = !r.escape.active && state.phase === 'active' && mirror.phase === 'dead'
    const escaping = !r.escape.active && state.phase === 'active' && (mirror.jeep === 'escaping' || mirror.jeep === 'escaped')
    let next = mirror
    if (r.escape.active) next = { ...mirror, phase: state.phase === 'complete' ? 'complete' : mirror.phase, jeep: state.jeep, escapeProgress: state.escapeProgress }
    else if (failing || escaping) next = { ...mirror, phase: 'active', jeep: escaping ? 'escaping' : mirror.jeep, escapeProgress: 0 }
    applyMirror(state, next)
    if (key() !== before) r.syncWorld()
    if (failing) r.fail()
    else if (escaping) r.beginEscape()
  }

  private applyDoors(bits: string, instant = false) {
    if (typeof bits !== 'string') return
    const doors = this.r.player.actions.doors
    for (let i = 0; i < doors.length && i < bits.length; i++) {
      const open = bits[i] === '1'
      if (!!doors[i].userData.open === open || (!instant && (this.pendingDoors.get(i) ?? -1) > this.clock)) continue
      setDoorOpen(doors[i], open, instant)
    }
  }

  private applyPickups(items: readonly WeaponItem[]) {
    if (!Array.isArray(items)) return
    const weapons = this.r.weapons, ids = new Set(items.map(item => item.id))
    for (const item of weapons.snapshot().pickups) if (!ids.has(item.id)) weapons.removePickup(item.id)
    for (const item of items) weapons.addPickup(item)
  }

  private statusChanged(status: CoopStatus) {
    this.status = status
    if (status.kind === 'error' || status.kind === 'waiting' || status.kind === 'alone') {
      for (const id of [...this.mates.keys()]) this.dropMate(id)
    }
    if (status.kind === 'error' && this.link.role === 'guest') {
      // The host is gone: this browser goes on alone, from the start of the mission.
      const played = !!this.tick
      this.link.close()
      this.tick = null
      this.placed = false
      if (played) { this.r.restart(true); this.r.hud.notify('The host left. The mission starts over for you alone.', 5) }
    }
    this.lobby?.render()
  }

  /** Someone joined or left: the host brings a newcomer up to date; whoever left goes. */
  private peer(id: number, joined: boolean) {
    if (joined && this.link.role === 'host') this.sendSync(id)
    if (!joined) this.dropMate(id)
  }

  dispose() {
    this.link.close()
    for (const id of [...this.mates.keys()]) this.dropMate(id)
    this.view.reset(); this.syringe.dispose(); this.bar.dispose(); this.lobby?.dispose()
  }
}
