import * as THREE from 'three'
import { applyPenMaterial, createPenSilhouette, penPalette } from '../render/ballpoint'
import { disposeGun, type Gun } from '../lab/weapons/models'
import type { WeaponContext, WeaponFrame, WeaponItem, WeaponName, WeaponSnapshot } from './types'
import { WEAPON_RULES, WEAPON_SLOTS, SHOTGUN_PELLETS, SHOTGUN_BALLISTICS, SNIPER_ZOOM, startingLoadout } from './balance'
import { createMissionGun } from './weapon-models'
import { RARITY_INFO, weaponRules } from './loot'
import { createRarityBeam } from '../render/ink'
import type { EquippedCosmetics, KnifeId } from './zombies/cosmetics/catalogue'
import { CHARM_ANCHORS, CHARM_LENGTH, KNIFE_BUILDERS, applyCamo, buildCharm, buildWatch, removeCamo } from './zombies/cosmetics/models'
import { applyDragonSkin, removeDragonSkin } from './zombies/mythic'
export { WEAPON_RULES } from './balance'

const up = new THREE.Vector3(0, 1, 0)
const right = new THREE.Vector3(1, 0, 0)
const viewAxis = new THREE.Vector3(0, 0, 1)
const down = new THREE.Vector3(0, -1, 0)
const AIM_PITCH = THREE.MathUtils.degToRad(-5)
const AIM_LOWER_TIME = 0.18
/**
 * Switching: the old gun drops and rolls out (SWAP_OUT), the new one rises past its rest and settles
 * (SWAP_SETTLE). The new gun can fire after SWITCH_TIME, while the last of the settle is still playing.
 */
const SWAP_OUT = 0.1, SWAP_SETTLE = 0.42, SWITCH_TIME = 0.26
const SWAP_DROP = 0.24
/** A knife slash, from the gun dipping out to it coming back up. */
const KNIFE_TIME = 0.36
/**
 * A throw (grenade, Ink Doll): the gun dips out, the hand comes up with it, winds back by the ear, throws
 * forward and lets go at THROW_RELEASE (when the mode should launch the real thing), then follows through.
 */
const THROW_TIME = 0.46
export const THROW_RELEASE = 0.29
/** Seconds of stillness before the gun is inspected or the knife does a flourish. */
const IDLE_FLOURISH = 10
const INSPECT_TIME = 3.4, KNIFE_FLOURISH_TIME = 2.3
/** The viewmodel kick is a spring: stiff, slightly underdamped, so the gun overshoots once and settles. */
const KICK_STIFFNESS = 360, KICK_DAMPING = 2 * 0.55 * Math.sqrt(KICK_STIFFNESS)
/**
 * How each gun feels: viewmodel kick (back and up), random roll, camera shake (a roll about the view
 * axis, in radians: it never moves the aim) and muzzle flash size. Shotgun and sniper hit hardest.
 */
const FEEL: Record<WeaponName, { kick: number; roll: number; shake: number; flash: number }> = {
  pistol: { kick: 1, roll: 0.05, shake: 0.005, flash: 0.9 },
  smg: { kick: 0.6, roll: 0.035, shake: 0.003, flash: 0.8 },
  ak: { kick: 0.9, roll: 0.045, shake: 0.0045, flash: 1.05 },
  shotgun: { kick: 1.9, roll: 0.1, shake: 0.018, flash: 1.55 },
  sniper: { kick: 2.1, roll: 0.075, shake: 0.02, flash: 1.35 },
  magnum: { kick: 1.8, roll: 0.09, shake: 0.014, flash: 1.35 },
  lmg: { kick: 0.75, roll: 0.04, shake: 0.006, flash: 1.15 },
}
const DEATH_MACHINE_FEEL = { kick: 0.3, roll: 0.02, shake: 0.002, flash: 1.1 }
/** Where a watch face points: up and toward the eye, so a glance at the wrist shows it. */
const WATCH_FACE = new THREE.Vector3(-0.35, 0.75, 0.6).normalize()
/** Charms are drawn facing +Z; the eye sits behind the gun and off its +X side. */
const CHARM_FACING = new THREE.Quaternion().setFromAxisAngle(up, 2.6)
/** An upgraded shotgun loads this many shells per reload cycle, as in Call of Duty. */
const PACKED_SHELLS = 4
const upgraded = (item: WeaponItem) => item.packed === true || ((item as { packLevel?: number }).packLevel ?? 0) >= 1
type Flourish = { kind: 'inspect' | 'knife'; time: number; weight: number; stopping: boolean }
type V3 = [number, number, number]
/**
 * The slash, in camera space, as [time, grip position, grip rotation (YXZ)]: the knife comes up cocked
 * high on the right with its edge leading, cuts down and across to the lower left, then drops away.
 */
const KNIFE_SLASH: [number, V3, V3][] = [
  [0.06, [0.3, -0.3, -0.3], [-0.1, Math.PI + 0.25, 1.1]],
  [0.12, [0.3, -0.04, -0.32], [-0.55, Math.PI + 0.15, 1.35]],
  [0.25, [-0.22, -0.25, -0.43], [0.25, Math.PI + 1.05, 1.55]],
  [KNIFE_TIME, [-0.02, -0.5, -0.34], [0.5, Math.PI + 0.9, 1.2]],
]
const THROW_PATH: [number, V3, V3][] = [
  [0.06, [0.26, -0.28, -0.34], [0.1, Math.PI, 0]],
  [0.2, [0.25, 0.02, -0.22], [-0.9, Math.PI + 0.2, 0.3]],
  [THROW_RELEASE, [0.06, 0.05, -0.52], [0.5, Math.PI - 0.1, -0.1]],
  [THROW_TIME, [0.0, -0.45, -0.46], [0.9, Math.PI - 0.2, -0.3]],
]
const copyItem = (item: WeaponItem): WeaponItem => ({ ...item, ...(item.position ? { position: [...item.position] } : {}) })
const smooth = (value: number, a: number, b: number) => THREE.MathUtils.smoothstep(value, a, b)
type LooseWeapon = { item: WeaponItem; model: Gun }
/** A spent magazine dropped during a reload: it falls, lands, and is gone a few seconds later. */
type FallingMagazine = { object: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3; age: number; floor: number }
const MAGAZINE_LIFE = 5, MAGAZINES_ON_FLOOR = 6
type Arm = { shoulder: THREE.Vector3; pole: THREE.Vector3; upper: THREE.Mesh; fore: THREE.Mesh; elbow: THREE.Mesh }

/** Gameplay weapons deliberately have no lab action timers or animation-mixer dependencies. */
export class FirstPersonWeapons {
  private inventory: (WeaponItem | null)[] = startingLoadout()
  private slot = this.inventory.findIndex(item => item?.name === 'ak')
  private nextId = 1
  private loose = new Map<string, LooseWeapon>()
  private root = new THREE.Group()
  private mount = new THREE.Group()
  private rightHand = new THREE.Group()
  private leftHand = new THREE.Group()
  private supportFingers = new THREE.Group()
  private armMaterial = new THREE.MeshBasicMaterial({
    color: penPalette.paper, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  })
  // Full upper arms taper through the elbow to a narrower wrist; IK still owns length.
  private upperArmGeometry = new THREE.CylinderGeometry(0.055, 0.075, 1, 24)
  private forearmGeometry = new THREE.CylinderGeometry(0.035, 0.057, 1, 24)
  private jointGeometry = new THREE.SphereGeometry(0.057, 20, 16)
  private palmGeometry = new THREE.SphereGeometry(1, 20, 16)
  private flashGeometry = this.makeFlashGeometry()
  private flashMaterial = applyPenMaterial(new THREE.MeshBasicMaterial({ color: penPalette.ink, transparent: true, opacity: 0.95, side: THREE.DoubleSide, toneMapped: false }), { density: 0.47, scale: 90, seed: 829 })
  private flash = new THREE.Mesh(this.flashGeometry, this.flashMaterial)
  private arms: [Arm, Arm]
  private model: Gun | null = null
  private partRest = new Map<THREE.Object3D, THREE.Vector3>()
  private partRotation = new Map<THREE.Object3D, THREE.Euler>()
  private falling: FallingMagazine[] = []
  /** This reload's old magazine has already fallen. */
  private magazineDropped = false
  /** Perks: reload time and time between shots are multiplied by these (1 = as the weapon is). */
  reloadScale = 1
  fireScale = 1
  /** The Death Machine's barrel cluster: how fast it spins and how far it has turned. */
  private barrelSpeed = 0
  private barrelAngle = 0
  private held = false
  private pendingShot = false
  private enabled = false
  private reloadElapsed: number | null = null
  private reloadAim = 0
  private cooldown = 0
  private switchTime = 0
  private recoil = 0
  private settle = { pitch: 0, yaw: 0 }
  private reducedMotion = false
  private flashTime = 0
  private time = 0
  private aim = 0
  private aimedGripY = 0
  private lower = 0
  private obstructed = false
  private disposed = false
  private scopeActive = false
  private deathVisible = false
  private scopeZoom: number = SNIPER_ZOOM.initial
  private baseFov: number | null = null
  private feet = new THREE.Vector3()
  private frame: WeaponFrame = { active: false, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: this.feet }
  /** Visual kick and roll springs; separate from `recoil`, which only drives the slide and bolt. */
  private kick = { value: 0, velocity: 0, roll: 0, rollVelocity: 0 }
  /** Camera shake as a decaying roll about the view axis; `applied` is what the camera carries now. */
  private shake = { amplitude: 0, time: 0, sign: 1, applied: 0 }
  private flashScale = 1
  private sway = new THREE.Vector2()
  private lastLook: THREE.Euler | null = null
  private turnRate = 0
  private swap: { time: number; outgoing: Gun | null } | null = null
  private knifeTime: number | null = null
  /** A throw in progress, and what is in the hand for it. */
  private throwTime: number | null = null
  private throwModel: THREE.Object3D | null = null
  private knifeHand = new THREE.Group()
  private knifeSpin = new THREE.Group()
  private knives = new Map<KnifeId, Gun>()
  private knifeModel: Gun | null = null
  private idleTime = 0
  private flourish: Flourish | null = null
  private flourishCount = 0
  /** Null until a mode dresses the arms (Dead Ink); the hostage mission never does, and gets no idle flourish. */
  private cosmetics: EquippedCosmetics | null = null
  private watch: Gun | null = null
  private charm: { pivot: THREE.Group; model: Gun; bob: THREE.Vector3; previous: THREE.Vector3; anchor: THREE.Vector3; ready: boolean } | null = null

  constructor(private context: WeaponContext) {
    this.root.name = 'First-person stickman arms'
    this.root.userData.noCollision = true
    this.mount.name = 'Firing hand grip mount'
    this.root.add(this.mount, this.leftHand)
    this.mount.add(this.rightHand, this.flash, this.knifeHand)
    this.knifeHand.name = 'Knife hand'
    this.knifeHand.add(this.knifeSpin)
    this.knifeHand.visible = false
    this.flash.visible = false
    this.makeHand(this.rightHand, true)
    this.leftHand.name = 'Left reload and support hand'
    this.leftHand.add(this.supportFingers)
    this.makeHand(this.supportFingers, false)
    this.arms = [
      this.makeArm(new THREE.Vector3(0.24, -0.34, -0.1), new THREE.Vector3(0.75, -1, 0.4)),
      this.makeArm(new THREE.Vector3(-0.2, -0.34, -0.16), new THREE.Vector3(-0.7, -1, 0.3)),
    ]
    this.context.camera.add(this.root)
    this.setHeldModel()
  }

  get label() { return this.current ? weaponRules(this.current).label : 'Empty hands' }
  get ammo() { return this.current ? `${this.current.magazine} / ${this.current.reserve}` : '—' }
  get reloading() { return this.reloadElapsed !== null }
  get blocked() { return this.obstructed }
  get selected() { return this.slot }
  get scoped() { return this.scopeActive }
  get canAim() { return this.current?.name === 'ak' || this.current?.name === 'smg' || this.current?.name === 'sniper' || this.current?.name === 'lmg' }
  get scopeMagnification() { return this.scopeZoom }
  get lookSensitivity() { return this.scopeActive ? 1 / this.scopeZoom : 1 }
  get current(): WeaponItem | null { return this.inventory[this.slot] }
  get slots(): readonly (WeaponItem | null)[] { return this.inventory }
  /** The first-person model of the gun in hand, for looks layered on by a mode (Dead Ink's Pack-a-Punch camo). */
  get heldModel() { return this.model }

  private makeArm(shoulder: THREE.Vector3, pole: THREE.Vector3): Arm {
    const upper = this.armShape(this.upperArmGeometry)
    const fore = this.armShape(this.forearmGeometry)
    const elbow = this.armShape(this.jointGeometry)
    this.root.add(upper, fore, elbow)
    return { shoulder, pole, upper, fore, elbow }
  }

  private armShape(geometry: THREE.BufferGeometry) {
    const mesh = new THREE.Mesh(geometry, this.armMaterial)
    const contour = createPenSilhouette(geometry, 2.4)
    contour.name = 'First-person arm contour'
    mesh.add(contour)
    return mesh
  }

  private makeFlashGeometry() {
    const star = new THREE.Shape()
    for (let index = 0; index < 10; index++) {
      const angle = index * Math.PI / 5
      const radius = index % 2 ? 0.018 : 0.065
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius
      if (index) star.lineTo(x, y); else star.moveTo(x, y)
    }
    star.closePath()
    return new THREE.ShapeGeometry(star)
  }

  private mitten(parent: THREE.Group, position: [number, number, number], scale: [number, number, number]) {
    const shape = this.armShape(this.palmGeometry)
    shape.position.set(...position)
    shape.scale.set(scale[0] * 1.12, scale[1] * 1.06, scale[2] * 1.08)
    parent.add(shape)
  }

  private makeHand(hand: THREE.Group, firing: boolean) {
    hand.name = firing ? 'Right connected mitten grip' : 'Left connected support mitten'
    if (firing) {
      this.mitten(hand, [-0.023, -0.012, -0.010], [0.033, 0.043, 0.036])
      this.mitten(hand, [-0.002, 0.012, 0.018], [0.020, 0.022, 0.034])
    } else {
      this.mitten(hand, [0, -0.022, 0], [0.042, 0.025, 0.045])
      this.mitten(hand, [-0.030, -0.001, 0.010], [0.017, 0.029, 0.031])
    }
  }

  private segment(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3) {
    const direction = end.clone().sub(start)
    mesh.position.copy(start).add(end).multiplyScalar(0.5)
    mesh.scale.y = direction.length()
    mesh.quaternion.setFromUnitVectors(up, direction.normalize())
  }

  /** A two-bone solve keeps upper arms/forearms exactly 34/36 cm long throughout all poses. */
  private placeArm(arm: Arm, wrist: THREE.Vector3, shoulder = arm.shoulder) {
    const direction = wrist.clone().sub(shoulder)
    const distance = direction.length()
    direction.normalize()
    const upperLength = 0.34, foreLength = 0.36
    const d = THREE.MathUtils.clamp(distance, Math.abs(upperLength - foreLength) + 0.001, upperLength + foreLength - 0.001)
    const along = (upperLength ** 2 - foreLength ** 2 + d ** 2) / (2 * d)
    const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2))
    const bend = arm.pole.clone().addScaledVector(direction, -arm.pole.dot(direction)).normalize()
    const elbow = shoulder.clone().addScaledVector(direction, along).addScaledVector(bend, height)
    this.segment(arm.upper, shoulder, elbow)
    this.segment(arm.fore, elbow, wrist)
    arm.elbow.position.copy(elbow)
  }

  /** `swap` plays the switch animation: the old model drops out before the new one rises. */
  private setHeldModel(swap = false) {
    this.scopeZoom = SNIPER_ZOOM.initial
    this.clearSwap()
    const animate = swap && !this.frame.reducedMotion
    let outgoing: Gun | null = null
    if (this.model && animate) outgoing = this.model
    else if (this.model) disposeGun(this.model)
    this.model = null
    this.charm = null
    this.partRest.clear()
    this.partRotation.clear()
    if (this.current) {
      this.model = createMissionGun(this.current.name, this.current.special)
      // A slight muzzle-up tilt reveals the top of the barrel while aiming.
      // Measure that pose before parenting so its sights stay below the reticle.
      this.model.rotation.x = AIM_PITCH
      this.aimedGripY = -new THREE.Box3().setFromObject(this.model).max.y - 0.008
      this.model.rotation.x = 0
      this.mount.add(this.model)
      for (const part of Object.values(this.model.userData.parts)) {
        this.partRest.set(part, part.position.clone())
        this.partRotation.set(part, part.rotation.clone())
      }
      this.flash.position.copy(this.model.userData.muzzle).z += 0.035
      this.dress()
      if (outgoing) this.model.visible = false
    }
    if (animate) this.swap = { time: outgoing ? 0 : SWAP_OUT, outgoing }
    this.root.visible = this.enabled && !!this.current
    this.pose(0)
  }

  private clearSwap() {
    if (this.swap?.outgoing) disposeGun(this.swap.outgoing)
    this.swap = null
    if (this.model) this.model.visible = true
  }

  /**
   * Put the equipped camo and charm on the gun in hand. An upgraded gun keeps its Pack-a-Punch camo and
   * the Death Machine is never painted; both can still carry the charm.
   */
  private dress() {
    const model = this.model, item = this.current
    if (!model || !item) return
    this.charm?.pivot.removeFromParent()
    this.charm = null
    removeCamo(model)
    removeDragonSkin(model)
    // A Mythic wears its dragon over any camo; upgraded, the dragon shimmers in Pack-a-Punch colours.
    const mythic = item.rarity === 'mythic' && !item.special
    if (mythic) applyDragonSkin(model, upgraded(item))
    const cosmetics = this.cosmetics
    if (!cosmetics) return
    const camo = cosmetics.camos[item.name]
    if (camo && !mythic && !upgraded(item) && !item.special) applyCamo(model, camo)
    if (cosmetics.charm) {
      const pivot = new THREE.Group()
      pivot.name = 'Gun charm pivot'
      pivot.position.set(...(CHARM_ANCHORS[item.special ? 'ak' : item.name] ?? CHARM_ANCHORS.ak))
      const charm = buildCharm(cosmetics.charm)
      charm.name = `Gun charm: ${cosmetics.charm}`
      pivot.add(charm)
      model.add(pivot)
      this.charm = { pivot, model: charm, bob: new THREE.Vector3(), previous: new THREE.Vector3(), anchor: new THREE.Vector3(), ready: false }
    }
  }

  /**
   * Dress the arms: a watch on the left wrist, a charm on every gun, a camo per gun type and the knife
   * skin. Null takes everything off. Dressing also turns on the idle inspect and knife flourish.
   */
  setCosmetics(cosmetics: EquippedCosmetics | null) {
    if (this.disposed) return
    this.cosmetics = cosmetics ? { ...cosmetics, camos: { ...cosmetics.camos } } : null
    this.watch?.removeFromParent()
    this.watch = null
    if (cosmetics?.watch) {
      this.watch = buildWatch(cosmetics.watch)
      this.watch.name = `Watch: ${cosmetics.watch}`
      this.root.add(this.watch)
    }
    this.endFlourish()
    this.idleTime = 0
    if (this.knifeModel && this.knifeTime === null) this.hideKnife()
    // Built now, in the menu, so the first slash of a game does not stall a frame building it.
    if (cosmetics) this.knifeFor(cosmetics.knife)
    this.dress()
    this.pose(0)
  }

  trigger(pressed: boolean) {
    if (!pressed) { this.held = false; return }
    if (this.enabled && this.reloading && this.current?.name === 'shotgun' && this.current.magazine > 0) this.cancel()
    if (!this.enabled || this.reloading || this.switchTime > 0 || !this.current) return
    if (!this.held) this.pendingShot = true
    this.held = true
  }

  reload() {
    const item = this.current
    if (!this.enabled || !item || this.reloading || this.switchTime > 0 || item.reserve <= 0 || item.magazine >= WEAPON_RULES[item.name].capacity) return false
    this.held = false
    this.pendingShot = false
    this.reloadAim = this.aim
    this.magazineDropped = false
    // The knife leaves the hand at once; an inspect eases out under the reload instead of snapping back.
    if (this.flourish?.kind === 'knife') this.endFlourish()
    // Negative time lowers from the current pose; magazine/bolt motion starts at zero.
    this.reloadElapsed = this.aim > 0.001 ? -AIM_LOWER_TIME : 0
    this.setScope(false)
    this.context.emit({ kind: 'reload', weapon: item.name, position: this.context.camera.getWorldPosition(new THREE.Vector3()), radius: 3, text: `Reloading ${this.label.toLowerCase()}` })
    return true
  }

  get selectedSlot() { return this.slot }

  /**
   * Put a weapon straight into the inventory (bought off a wall, taken from the Mystery Box). It goes
   * into an empty slot if there is one; with every slot full it replaces the weapon in your hands, as
   * in Call of Duty. Returns the slot it went into.
   */
  give(source: WeaponItem) {
    const item = copyItem(source)
    delete item.position
    const empty = this.inventory.findIndex(slot => !slot)
    const destination = empty >= 0 ? empty : this.slot
    this.cancel()
    this.inventory[destination] = item
    this.slot = destination
    this.switchTime = SWITCH_TIME
    this.setHeldModel(true)
    this.context.emit({ kind: 'pickup', position: this.feet.clone(), radius: 2, text: `${this.label} picked up` })
    return destination
  }

  /** Top up a carried weapon to at least this magazine and reserve. False when it is not carried. */
  refill(name: WeaponName, magazine: number, reserve: number) {
    const item = this.inventory.find(slot => slot?.name === name)
    if (!item) return false
    item.magazine = Math.max(item.magazine, Math.min(magazine, WEAPON_RULES[name].capacity))
    item.reserve = Math.max(item.reserve, reserve)
    return true
  }

  /**
   * Switch to the next (1) or previous (-1) slot that holds a weapon, wrapping around and skipping
   * empty slots. False when there is no other weapon to switch to.
   */
  cycle(direction: 1 | -1) {
    const count = this.inventory.length
    for (let step = 1; step < count; step++) {
      const index = ((this.slot + direction * step) % count + count) % count
      if (this.inventory[index]) return this.switchSlot(index)
    }
    return false
  }

  switchSlot(index: number) {
    if (!this.enabled || !Number.isInteger(index) || index < 0 || index >= this.inventory.length || index === this.slot) return false
    this.cancel()
    this.slot = index
    this.switchTime = SWITCH_TIME
    this.setHeldModel(true)
    this.context.emit({ kind: 'switch', position: this.feet.clone(), radius: 1, text: this.label })
    return true
  }

  /** Interruption never moves ammunition. Ammo transfer is a single reload-completion event. */
  cancel() {
    this.held = false
    this.pendingShot = false
    this.reloadElapsed = null
    this.reloadAim = 0
    this.switchTime = 0
    this.recoil = 0
    this.flashTime = 0
    this.flash.visible = false
    this.aim = 0
    this.lower = 0
    this.settle.pitch = this.settle.yaw = 0
    this.setScope(false)
    for (const [part, position] of this.partRest) part.position.copy(position)
    for (const [part, rotation] of this.partRotation) part.rotation.copy(rotation)
    this.kick.value = this.kick.velocity = this.kick.roll = this.kick.rollVelocity = 0
    this.shake.amplitude = 0
    this.rollCamera(0)
    this.idleTime = 0
    this.endFlourish()
    if (this.knifeTime !== null) { this.knifeTime = null; this.hideKnife() }
    if (this.throwTime !== null) this.endThrow()
  }

  /**
   * Throw something from the hand: `model` is what you see in it (it is the viewmodel's until the throw
   * ends). The gun dips out and comes back up after; the mode launches the real one at THROW_RELEASE.
   */
  throwItem(model: THREE.Object3D) {
    if (this.disposed || !this.enabled) return false
    this.cancel()
    this.throwTime = 0
    this.throwModel = model
    model.visible = false
    this.knifeSpin.add(model)
    this.switchTime = THROW_TIME
    this.clearSwap()
    this.root.visible = !this.scopeActive
    this.pose(0)
    return true
  }

  private endThrow() {
    this.throwTime = null
    if (this.throwModel) {
      this.throwModel.removeFromParent()
      this.throwModel.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
      this.throwModel = null
    }
    if (this.knifeModel) this.knifeModel.visible = true
    this.hideKnife()
  }

  /**
   * A knife slash in first person: the gun dips out, the equipped knife cuts across the view and the gun
   * comes back up (about a third of a second). The hit itself is the mode's; this is only what you see.
   */
  knifeSwing() {
    if (this.disposed || !this.enabled) return false
    this.cancel()
    this.knifeTime = 0
    this.switchTime = KNIFE_TIME
    this.clearSwap()
    this.root.visible = !this.scopeActive
    this.pose(0)
    return true
  }

  /** The knife is in the hand now: slashing, or showing off during an idle flourish. */
  private get knifeShown() { return this.knifeHand.visible }

  private knifeFor(id: KnifeId) {
    let model = this.knives.get(id)
    if (!model) {
      model = KNIFE_BUILDERS[id]()
      model.name = `Knife: ${id}`
      this.knives.set(id, model)
    }
    return model
  }

  private showKnife() {
    const model = this.knifeFor(this.cosmetics?.knife ?? 'combat')
    if (this.knifeModel !== model) {
      this.knifeModel?.removeFromParent()
      this.knifeModel = model
      this.knifeSpin.add(model)
    }
    // Every trick starts from the knife at rest in the hand.
    for (const part of Object.values(model.userData.parts)) part.rotation.set(0, 0, 0)
    this.knifeSpin.position.set(0, 0, 0); this.knifeSpin.rotation.set(0, 0, 0)
    model.position.set(0, 0, 0)
    this.knifeHand.visible = true
    if (this.model) this.model.visible = false
  }

  private hideKnife() {
    this.knifeHand.visible = false
    if (this.model && !this.swap?.outgoing) this.model.visible = true
  }

  /** Bring the gun back up from below, as the second half of a switch. */
  private raiseGun(from = SWAP_OUT) {
    this.clearSwap()
    if (!this.frame.reducedMotion && this.model) this.swap = { time: from, outgoing: null }
  }

  /** Stop an idle flourish at once (input, pause, switch). The gun comes back quickly if it had left. */
  private endFlourish() {
    const flourish = this.flourish
    if (!flourish) return
    this.flourish = null
    if (flourish.kind === 'knife') {
      const gunGone = flourish.time > 0.1
      this.hideKnife()
      if (gunGone) this.raiseGun(SWAP_OUT + 0.06)
    }
  }

  beginDeath() {
    this.deathVisible = this.root.visible
    this.cancel()
    this.enabled = false
  }

  updateDeath(elapsed: number, reducedMotion: boolean, hitKick = 0, hitSide = 0) {
    const drop = smooth(elapsed, 0, 0.62)
    const kick = reducedMotion ? 0 : hitKick
    this.root.visible = this.deathVisible && elapsed < 0.62 && !reducedMotion
    this.root.position.set(0.08 * drop - hitSide * 0.04 * kick, -0.85 * drop + 0.075 * kick, 0.2 * drop + 0.1 * kick)
    this.root.rotation.set(-0.65 * drop - 0.2 * kick, 0.06 * hitSide * kick, 0.16 * drop + 0.18 * hitSide * kick)
  }

  resetDeath() {
    this.deathVisible = false
    this.root.position.set(0, 0, 0)
    this.root.rotation.set(0, 0, 0)
  }

  private setScope(active: boolean) {
    // The controller enters walk mode after construction, and owns every unscoped FOV.
    // Capture only when entering scope, then restore only a scope-owned change.
    if (!active && !this.scopeActive) return
    if (active && !this.scopeActive) this.baseFov = this.context.camera.fov
    this.scopeActive = active
    const baseline = this.baseFov ?? this.context.camera.fov
    const fov = active ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseline) / 2) / this.scopeZoom)) : baseline
    if (this.context.camera.fov !== fov) {
      this.context.camera.fov = fov
      this.context.camera.updateProjectionMatrix()
    }
    if (!active) this.baseFov = null
  }

  /** Adjust only an active sniper scope; preserve the unscoped camera's FOV. */
  adjustScopeZoom(direction: number) {
    if (this.disposed || !this.enabled || !this.scopeActive || this.current?.name !== 'sniper' ||
        this.reloading || !Number.isFinite(direction) || direction === 0) return false
    this.scopeZoom = THREE.MathUtils.clamp(this.scopeZoom + Math.sign(direction), SNIPER_ZOOM.min, SNIPER_ZOOM.max)
    this.setScope(true)
    return true
  }

  update(dt: number, frame: WeaponFrame) {
    if (this.disposed) return
    this.feet.copy(frame.feet)
    this.frame = { ...frame, feet: this.feet }
    const enabled = frame.active && !frame.climbing
    if (!enabled) { this.cancel(); this.lastLook = null }
    this.enabled = enabled
    this.root.visible = enabled && !!this.current
    if (!enabled) return
    const delta = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1))
    this.time += delta
    this.measureTurn(delta)
    this.stepSprings(delta)
    this.stepAnimations(delta)
    const previousCooldown = this.cooldown
    this.cooldown = Math.max(0, this.cooldown - delta)
    if (this.current?.name === 'shotgun' && previousCooldown > 0.72 && this.cooldown <= 0.72) this.context.emit({ kind: 'weapon-pump', position: this.feet.clone(), radius: 3 })
    this.switchTime = Math.max(0, this.switchTime - delta)
    this.recoil = Math.max(0, this.recoil - delta * 7)
    // Spins up while the trigger is held and runs down after, like a real rotary gun.
    this.barrelSpeed = THREE.MathUtils.damp(this.barrelSpeed, this.held && this.current?.special ? 42 : 0, 5, delta)
    this.barrelAngle = (this.barrelAngle + this.barrelSpeed * delta) % (Math.PI * 2)
    this.flashTime = Math.max(0, this.flashTime - delta)
    this.reducedMotion = frame.reducedMotion
    if (this.reloadElapsed !== null && this.current) {
      this.reloadElapsed += delta
      if (this.reloadElapsed >= weaponRules(this.current).reload * this.reloadScale) {
        const shellReload = this.current.name === 'shotgun'
        const shells = upgraded(this.current) ? PACKED_SHELLS : 1
        const amount = Math.min(WEAPON_RULES[this.current.name].capacity - this.current.magazine, this.current.reserve, shellReload ? shells : Infinity)
        this.current.magazine += amount
        this.current.reserve -= amount
        if (shellReload) this.context.emit({ kind: 'shell-load', radius: 2, position: this.feet.clone() })
        if (shellReload && this.current.magazine < WEAPON_RULES.shotgun.capacity && this.current.reserve > 0) this.reloadElapsed -= weaponRules(this.current).reload * this.reloadScale
        else {
          this.reloadElapsed = null
          this.context.emit({ kind: 'reload-ready', weapon: this.current.name, radius: 2, position: this.feet.clone(), text: 'Weapon ready' })
        }
      }
    }
    if (this.reloadElapsed !== null) this.aim = this.reloadAim * (1 - smooth(this.reloadElapsed, -AIM_LOWER_TIME, 0))
    else this.aim += ((frame.aiming && this.canAim ? 1 : 0) - this.aim) * (1 - Math.exp(-delta * 12))
    this.checkObstruction()
    this.setScope(this.current?.name === 'sniper' && frame.aiming && !this.reloading && this.switchTime <= 0 && !this.obstructed)
    // A scoped rifle is represented by the scope overlay; hide the viewmodel to avoid near-plane clipping.
    this.root.visible = (!!this.current || this.knifeTime !== null || this.throwTime !== null) && !this.scopeActive
    this.lower += ((this.obstructed ? 1 : 0) - this.lower) * Math.min(1, delta * 15)
    this.watchIdle(delta, frame)
    this.pose(delta)
    this.updateFalling(delta)
    const item = this.current
    if (item && this.cooldown <= 0 && !this.reloading && this.switchTime <= 0 && !this.obstructed &&
        (this.pendingShot || (this.held && WEAPON_RULES[item.name].automatic))) this.shoot(item)
    else if (this.settle.pitch || this.settle.yaw) {
      // Resolve fire against the displayed sight before recovery moves it on this frame.
      // A shotgun blast has a heavier recovery than an automatic's short pulse.
      const recovery = this.current?.name === 'shotgun' ? 0.16 : 0.09
      const fraction = 1 - Math.exp(-delta / recovery)
      this.nudge(-this.settle.pitch * fraction, -this.settle.yaw * fraction)
      this.settle.pitch *= 1 - fraction; this.settle.yaw *= 1 - fraction
      if (Math.abs(this.settle.pitch) + Math.abs(this.settle.yaw) < 1e-6) this.settle.pitch = this.settle.yaw = 0
    }
    this.pendingShot = false
    this.flash.visible = this.flashTime > 0
    // A snappy flash: biggest on the frame of the shot, shrinking over its two or three frames.
    if (this.flash.visible) this.flash.scale.setScalar(this.flashScale * (0.55 + 0.9 * this.flashTime / 0.05))
    this.shakeCamera(delta)
    this.lastLook = new THREE.Euler().setFromQuaternion(this.context.camera.quaternion, 'YXZ')
  }

  /** How fast the player is turning, excluding the gun's own kick; drives sway and cancels the idle flourish. */
  private measureTurn(delta: number) {
    const look = new THREE.Euler().setFromQuaternion(this.context.camera.quaternion, 'YXZ')
    let yaw = 0, pitch = 0
    if (this.lastLook && delta > 0) {
      yaw = Math.atan2(Math.sin(look.y - this.lastLook.y), Math.cos(look.y - this.lastLook.y))
      pitch = look.x - this.lastLook.x
      // A teleport or a scripted look-at is not a hand turning; ignore jumps no wrist makes in one frame.
      if (Math.abs(yaw) + Math.abs(pitch) > 0.6) yaw = pitch = 0
      yaw /= delta; pitch /= delta
    }
    this.turnRate = Math.hypot(yaw, pitch)
    const motion = !this.frame.reducedMotion
    // The gun lags the turn: turning left leaves it trailing right, looking up leaves it low.
    const targetX = motion ? THREE.MathUtils.clamp(yaw * 0.007, -0.03, 0.03) : 0
    const targetY = motion ? THREE.MathUtils.clamp(-pitch * 0.005, -0.022, 0.022) : 0
    this.sway.x = THREE.MathUtils.damp(this.sway.x, targetX, 9, delta)
    this.sway.y = THREE.MathUtils.damp(this.sway.y, targetY, 9, delta)
    if (!targetX && Math.abs(this.sway.x) < 1e-6) this.sway.x = 0
    if (!targetY && Math.abs(this.sway.y) < 1e-6) this.sway.y = 0
  }

  /** Sub-stepped so the stiff kick spring stays stable at 30 FPS and below. */
  private stepSprings(delta: number) {
    const kick = this.kick
    if (!kick.value && !kick.velocity && !kick.roll && !kick.rollVelocity) return
    const steps = Math.max(1, Math.ceil(delta * 240)), h = delta / steps
    for (let i = 0; i < steps; i++) {
      kick.velocity += (-KICK_STIFFNESS * kick.value - KICK_DAMPING * kick.velocity) * h
      kick.value += kick.velocity * h
      kick.rollVelocity += (-KICK_STIFFNESS * kick.roll - KICK_DAMPING * kick.rollVelocity) * h
      kick.roll += kick.rollVelocity * h
    }
    if (Math.abs(kick.value) < 1e-4 && Math.abs(kick.velocity) < 1e-3) kick.value = kick.velocity = 0
    if (Math.abs(kick.roll) < 1e-5 && Math.abs(kick.rollVelocity) < 1e-4) kick.roll = kick.rollVelocity = 0
  }

  /** Switch, knife and flourish clocks. */
  private stepAnimations(delta: number) {
    if (this.swap) {
      this.swap.time += delta
      if (this.swap.outgoing && this.swap.time >= SWAP_OUT) {
        disposeGun(this.swap.outgoing)
        this.swap.outgoing = null
        if (this.model && !this.knifeShown) this.model.visible = true
      }
      if (this.swap.time >= SWAP_OUT + SWAP_SETTLE) this.swap = null
    }
    if (this.throwTime !== null) {
      this.throwTime += delta
      // The gun ducks out, then the hand holds the grenade (and not the knife) until it lets go.
      if (!this.knifeShown && this.throwTime >= 0.06) {
        this.knifeHand.visible = true
        if (this.knifeModel) this.knifeModel.visible = false
        if (this.model) this.model.visible = false
      }
      if (this.throwModel) this.throwModel.visible = this.knifeShown && this.throwTime < THROW_RELEASE
      if (this.throwTime >= THROW_TIME) {
        this.endThrow()
        this.raiseGun(SWAP_OUT + 0.03)
      }
    }
    if (this.knifeTime !== null) {
      this.knifeTime += delta
      // The gun dips for the first few frames, then the knife is in the hand.
      if (!this.knifeShown && (this.knifeTime >= 0.06 || this.frame.reducedMotion)) this.showKnife()
      if (this.knifeTime >= KNIFE_TIME) {
        this.knifeTime = null
        this.hideKnife()
        this.raiseGun(SWAP_OUT + 0.03)
      }
    }
    const flourish = this.flourish
    if (flourish) {
      flourish.time += delta
      flourish.weight = THREE.MathUtils.damp(flourish.weight, flourish.stopping ? 0 : 1, flourish.stopping ? 14 : 5, delta)
      if (flourish.kind === 'knife') {
        if (!this.knifeShown && flourish.time >= 0.18 && flourish.time < KNIFE_FLOURISH_TIME - 0.2) this.showKnife()
        if (flourish.time >= KNIFE_FLOURISH_TIME) { this.flourish = null; this.hideKnife(); this.raiseGun() }
      } else if (flourish.time >= INSPECT_TIME || (flourish.stopping && flourish.weight < 1e-3)) this.flourish = null
    }
  }

  /**
   * After a while without shooting, moving or turning, a dressed gun is inspected or the knife does its
   * flourish, alternating. Any input stops it at once.
   */
  private watchIdle(delta: number, frame: WeaponFrame) {
    const busy = this.held || this.pendingShot || this.reloading || this.switchTime > 0 || !!this.swap || this.knifeTime !== null || this.throwTime !== null ||
      frame.aiming || frame.moving > 0.05 || this.turnRate > 0.35 || this.obstructed || this.scopeActive || !this.current ||
      !!frame.hitPose && frame.hitPose.weaponPosition.lengthSq() + frame.hitPose.weaponRotation.lengthSq() > 1e-6
    if (busy) {
      this.idleTime = 0
      if (this.flourish?.kind === 'knife') this.endFlourish()
      else if (this.flourish) this.flourish.stopping = true
      return
    }
    this.idleTime += delta
    if (this.flourish || !this.cosmetics || frame.reducedMotion || this.idleTime < IDLE_FLOURISH) return
    this.idleTime = 0
    this.flourish = { kind: this.flourishCount++ % 2 ? 'knife' : 'inspect', time: 0, weight: 0, stopping: false }
  }

  /** Camera shake as a quick, decaying roll about the view axis: felt, but it never moves the aim. */
  private shakeCamera(delta: number) {
    const shake = this.shake
    let roll = 0
    if (shake.amplitude > 0) {
      shake.time += delta
      if (shake.time > 0.5) shake.amplitude = 0
      else roll = shake.amplitude * shake.sign * Math.exp(-shake.time * 11) * Math.sin(shake.time * 62 + 0.6) * (1 - this.aim * 0.4)
    }
    this.rollCamera(this.frame.reducedMotion ? 0 : roll)
    if (!shake.applied) this.levelCamera(delta)
  }

  /**
   * At rest the view is level. An overlay that puts the camera back wholesale after the frame (Second
   * Draft's revive) drops any roll change made under it, which would otherwise leave the view tilted for
   * good; ease out a small leftover. A roll a hit reaction put on this frame is its own, and is left alone.
   */
  private levelCamera(delta: number) {
    if (this.frame.hitPose?.cameraRotation.z) return
    const look = new THREE.Euler().setFromQuaternion(this.context.camera.quaternion, 'YXZ')
    if (Math.abs(look.z) < 1e-9 || Math.abs(look.z) > 0.05) return
    look.z = Math.abs(look.z) < 1e-4 ? 0 : THREE.MathUtils.damp(look.z, 0, 10, delta)
    this.context.camera.quaternion.setFromEuler(look)
  }

  /** Only the change is applied, so look input and hit reactions that write the camera in between are kept. */
  private rollCamera(roll: number) {
    const change = roll - this.shake.applied
    if (!change) return
    this.context.camera.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(viewAxis, change))
    this.shake.applied = roll
  }

  private gripPosition() {
    const rifle = this.current?.name === 'ak' || this.current?.name === 'sniper' || this.current?.name === 'shotgun' || this.current?.name === 'lmg'
    return new THREE.Vector3(THREE.MathUtils.lerp(rifle ? 0.17 : 0.16, 0, this.aim),
      THREE.MathUtils.lerp(rifle ? -0.23 : -0.20, this.aimedGripY, this.aim), rifle ? -0.36 : -0.43)
  }

  private checkObstruction() {
    if (!this.model) { this.obstructed = false; return }
    const camera = this.context.camera
    camera.updateWorldMatrix(true, false)
    const eye = camera.getWorldPosition(new THREE.Vector3())
    // Test the intended unlowered muzzle so lowering cannot make a blocked barrel clear again.
    const point = this.model.userData.muzzle.clone().applyAxisAngle(right, AIM_PITCH * this.aim)
      .applyAxisAngle(up, Math.PI).add(this.gripPosition())
    const muzzle = camera.localToWorld(point)
    const toMuzzle = muzzle.clone().sub(eye)
    const direction = camera.getWorldDirection(new THREE.Vector3())
    this.obstructed = this.context.world.rayDistance(eye, toMuzzle.clone().normalize(), toMuzzle.length() + 0.08) < toMuzzle.length() + 0.07 ||
      this.context.world.rayDistance(muzzle, direction, 0.24) < 0.24
  }

  private pose(dt: number) {
    const knife = this.knifeShown || this.knifeTime !== null || this.throwTime !== null
    if (!knife && (!this.model || !this.current)) return
    const motion = !this.frame.reducedMotion
    const hit = motion ? this.frame.hitPose : undefined
    const current = this.current
    let progress = 0, inspect = 0
    let magazine: THREE.Object3D | undefined, action: THREE.Object3D | undefined, pump: THREE.Object3D | undefined
    if (knife || !this.model || !current) this.poseKnife(motion)
    else {
      progress = this.reloadElapsed === null ? 0 : Math.max(0, this.reloadElapsed) / (weaponRules(current).reload * this.reloadScale)
      const working = this.reloading ? Math.sin(Math.PI * progress) : 0
      const position = this.gripPosition()
      const bob = motion ? Math.min(1, this.frame.moving) * (1 - this.aim) : 0
      position.x += Math.sin(this.time * 7) * 0.004 * bob
      position.y += Math.cos(this.time * 14) * 0.003 * bob - this.lower * 0.20
      position.z += this.lower * 0.12
      position.x -= working * 0.025
      // A magazine change: the gun rolls toward you and tips up while the magazine comes out, then the new
      // one is seated with a small upward jolt.
      const tilt = this.reloading && motion ? smooth(progress, 0.05, 0.25) * (1 - smooth(progress, 0.7, 0.9)) : 0
      const seat = this.reloading && motion ? smooth(progress, 0.6, 0.66) * (1 - smooth(progress, 0.66, 0.76)) : 0
      position.y += seat * 0.014 - tilt * 0.018
      this.mount.position.copy(position)
      this.mount.rotation.set(AIM_PITCH * this.aim + this.lower * 0.5 + tilt * 0.12 - seat * 0.06,
        Math.PI + working * 0.18, -working * 0.23 - tilt * 0.32, 'YXZ')
      if (hit) {
        this.mount.position.add(hit.weaponPosition)
        this.mount.rotation.x += hit.weaponRotation.x
        this.mount.rotation.y += hit.weaponRotation.y
        this.mount.rotation.z += hit.weaponRotation.z
      }
      if (motion) inspect = this.poseFeel()
      for (const [part, rest] of this.partRest) part.position.copy(rest)
      for (const [part, rotation] of this.partRotation) part.rotation.copy(rotation)
      magazine = this.model.userData.parts.magazine
      if (magazine && this.reloading) {
        const withdrawal = smooth(progress, 0.22, 0.40) * (1 - smooth(progress, 0.48, 0.67))
        magazine.position.y -= withdrawal * 0.13
        magazine.position.x -= withdrawal * 0.065
        magazine.position.z -= withdrawal * 0.045
        magazine.rotation.z += withdrawal * 0.28
        magazine.rotation.x -= withdrawal * 0.18
        // Fully out, the old one falls away; what comes back up reads as a fresh magazine.
        if (!this.magazineDropped && progress >= 0.38 && motion) { this.magazineDropped = true; this.dropMagazine(magazine) }
      }
      action = this.model.userData.parts.slide ?? this.model.userData.parts.bolt
      if (action) action.position.z -= this.reloading
        ? 0.035 * smooth(progress, 0.76, 0.82) * (1 - smooth(progress, 0.86, 0.94))
        : (motion ? this.recoil * 0.026 : 0)
      pump = this.model.userData.parts.pump
      if (pump && !this.reloading) {
        const cycle = WEAPON_RULES.shotgun.interval - this.cooldown
        pump.position.z -= 0.07 * smooth(cycle, 0.12, 0.3) * (1 - smooth(cycle, 0.35, 0.55))
      }
      // The Magnum's cylinder swings out, spins, and snaps back in on a reload; it turns a chamber a shot.
      const cylinder = this.model.userData.parts.cylinder
      if (cylinder) {
        if (this.reloading) {
          const out = smooth(progress, 0.12, 0.25) * (1 - smooth(progress, 0.78, 0.88))
          cylinder.position.x += out * 0.04
          cylinder.rotation.z += smooth(progress, 0.3, 0.7) * Math.PI * 4
        } else if (this.current) cylinder.rotation.z += (WEAPON_RULES.magnum.capacity - this.current.magazine) * Math.PI / 3
      }
      const barrels = this.model.userData.parts.barrels
      if (barrels) barrels.rotation.z += this.barrelAngle
    }
    this.root.updateWorldMatrix(true, true)
    const shoulders = this.arms.map((arm, index) => arm.shoulder.clone().add(hit?.shoulders[index] ?? new THREE.Vector3()))
    const wrist = this.root.worldToLocal(this.mount.localToWorld(new THREE.Vector3(-0.029, -0.02, -0.033)))
    const reachableWrist = wrist.clone().sub(shoulders[0]).clampLength(0.021, 0.699).add(shoulders[0])
    // Move the whole grip if a combined reload/recoil/hit reaches the IK limit.
    // The firing hand stays attached and neither arm is stretched to fake impact.
    this.mount.position.add(reachableWrist.clone().sub(wrist))
    this.root.updateWorldMatrix(true, true)
    // While the old gun drops out of a switch, the hands still hold the old gun.
    const held = this.swap?.outgoing ?? this.model
    const pistol = held?.userData.cls === 'pistol'
    // A pistol's free hand comes up into view to show the watch while the gun is inspected.
    const showWrist = pistol && inspect > 0.02
    this.leftHand.visible = !knife && (!pistol || showWrist || this.reloadElapsed !== null && this.reloadElapsed >= 0)
    const leftArm = this.arms[1]
    leftArm.upper.visible = leftArm.fore.visible = leftArm.elbow.visible = this.leftHand.visible
    const support = held?.userData.support?.clone() ?? new THREE.Vector3(0, 0.035, 0.145)
    // Place the palm against the fore-end rather than intersecting the receiver.
    if (held?.userData.support) support.y += 0.026
    if (pump) support.z += pump.position.z - this.partRest.get(pump)!.z
    // Pistols stay in the right hand; the reload hand enters and leaves below view.
    const left = pistol || knife ? new THREE.Vector3(-0.28, -0.7, -0.12)
      : this.root.worldToLocal(this.mount.localToWorld(support))
    // High enough that the watch behind the hand clears the bottom of a 16:9 screen, left of the hotbar.
    if (showWrist) left.lerp(new THREE.Vector3(-0.15, -0.14, -0.33), inspect)
    if (this.reloading && magazine) {
      const magGrip = magazine.userData.grip as THREE.Vector3 | undefined
      const contact = this.root.worldToLocal(magazine.localToWorld(magGrip?.clone() ?? new THREE.Vector3(0, -0.04, 0)))
      const reach = smooth(progress, 0.03, 0.20) * (1 - smooth(progress, 0.66, 0.77))
      left.lerp(contact, reach)
      if (action) {
        const actionGrip = action.userData.grip as THREE.Vector3 | undefined
        const target = this.root.worldToLocal(action.localToWorld(actionGrip?.clone() ?? new THREE.Vector3()))
        left.lerp(target, smooth(progress, 0.70, 0.79) * (1 - smooth(progress, 0.91, 0.99)))
      }
    }
    // The Magnum: the free hand comes up to the cylinder as it swings out, pushes the fresh rounds in from
    // behind while it spins, and flicks it shut.
    const cylinder = this.model?.userData.parts.cylinder
    if (this.reloading && cylinder) {
      const side = this.root.worldToLocal(cylinder.localToWorld((cylinder.userData.grip as THREE.Vector3 | undefined)?.clone() ?? new THREE.Vector3(0.045, 0.015, 0)))
      const back = this.root.worldToLocal(cylinder.localToWorld(new THREE.Vector3(0.01, 0, -0.075)))
      const hold = smooth(progress, 0.04, 0.18) * (1 - smooth(progress, 0.86, 0.96))
      const load = smooth(progress, 0.3, 0.4) * (1 - smooth(progress, 0.66, 0.76))
      left.lerp(side.lerp(back, load), hold)
      // Two firm shoves of the loader.
      left.z += 0.012 * load * Math.max(0, Math.sin((progress - 0.3) * Math.PI * 7))
    }
    const loadingPort = this.model?.userData.parts.loadingPort
    if (this.reloading && loadingPort) {
      const contact = this.root.worldToLocal(loadingPort.getWorldPosition(new THREE.Vector3()))
      left.lerp(contact, Math.sin(Math.PI * progress))
    }
    if (hit) left.add(hit.leftHand)
    left.sub(shoulders[1]).clampLength(0.021, 0.699).add(shoulders[1])
    this.leftHand.position.copy(left)
    this.leftHand.quaternion.copy(this.mount.quaternion)
    const reachTurn = smooth(progress, 0.03, 0.20) * (1 - smooth(progress, 0.66, 0.77))
    const boltTurn = smooth(progress, 0.70, 0.79) * (1 - smooth(progress, 0.91, 0.99))
    this.leftHand.rotateX(reachTurn * 0.42 - boltTurn * 0.2)
    this.leftHand.rotateZ(reachTurn * 0.38 + boltTurn * 0.35)
    this.placeArm(this.arms[0], reachableWrist, shoulders[0])
    this.placeArm(this.arms[1], left, shoulders[1])
    this.placeWatch(left)
    this.swingCharm(dt)
  }

  /**
   * Kick, sway, the switch drop and the idle inspect, layered on the gun's pose. Returns how far into the
   * inspect the gun is (0 to 1), which also brings a pistol's free hand up.
   */
  private poseFeel() {
    const m = this.mount, kick = this.kick
    m.position.z += kick.value * 0.03
    m.position.y += kick.value * 0.009
    m.rotation.x -= kick.value * 0.06
    m.rotation.z += kick.roll
    const sway = 1 - this.aim * 0.85
    m.position.x += this.sway.x * sway
    m.position.y += this.sway.y * sway
    m.rotation.y += this.sway.x * 1.5 * sway
    m.rotation.z -= this.sway.x * 1.2 * sway
    m.rotation.x -= this.sway.y * 1.2 * sway
    const swap = this.swap
    // The knife flourish starts by dropping the gun exactly as a switch does.
    const flourishOut = this.flourish?.kind === 'knife' ? smooth(this.flourish.time, 0, 0.18) : 0
    if (flourishOut || (swap && swap.time < SWAP_OUT)) {
      const out = Math.max(flourishOut, swap && swap.time < SWAP_OUT ? (swap.time / SWAP_OUT) ** 2 : 0)
      m.position.y -= SWAP_DROP * out
      m.position.x += 0.05 * out
      m.rotation.x += 0.7 * out
      m.rotation.z -= 0.9 * out
    } else if (swap) {
      // Rising past rest and settling: a damped oscillation that lands exactly at zero.
      const t = swap.time - SWAP_OUT
      const drop = Math.exp(-16 * t) * Math.cos(18 * t) * (1 - smooth(t, 0.3, SWAP_SETTLE))
      m.position.y -= SWAP_DROP * drop
      m.position.x -= 0.03 * drop
      m.rotation.x += 0.45 * drop
      m.rotation.z += 0.5 * drop
    }
    const flourish = this.flourish
    if (flourish?.kind !== 'inspect') return 0
    const u = flourish.time / INSPECT_TIME
    const w = flourish.weight * smooth(u, 0, 0.14) * (1 - smooth(u, 0.86, 1))
    // First the side with the charm turns to the eye, then the gun tips up and over to show its top.
    const b = smooth(u, 0.42, 0.58), a = 1 - b
    const drift = Math.sin(flourish.time * 2.3) * 0.04
    m.position.x += w * (-0.09 * a - 0.04 * b)
    m.position.y += w * (0.05 * a + 0.06 * b)
    m.position.z += w * (0.03 * a + 0.03 * b)
    m.rotation.y += w * (0.6 * a - 0.3 * b + drift)
    m.rotation.z += w * (-0.3 * a + 0.6 * b)
    m.rotation.x += w * (0.05 * a - 0.3 * b)
    return w
  }

  /** The knife in the hand: a slash, or the idle flourish with the equipped skin's own trick. */
  private poseKnife(motion: boolean) {
    const m = this.mount
    const set = (p: V3, r: V3) => { m.position.set(...p); m.rotation.set(r[0], r[1], r[2], 'YXZ') }
    if (this.throwTime !== null) {
      const t = this.throwTime
      if (!this.knifeShown) {
        const out = (t / 0.06) ** 2
        const grip = this.gripPosition()
        set([grip.x + 0.04 * out, grip.y - 0.18 * out, grip.z], [0.6 * out, Math.PI, -0.6 * out])
        return
      }
      if (!motion) { set([0.14, -0.2, -0.4], [0, Math.PI, 0]); return }
      let i = 0
      while (i < THROW_PATH.length - 2 && t > THROW_PATH[i + 1][0]) i++
      const [t0, p0, r0] = THROW_PATH[i], [t1, p1, r1] = THROW_PATH[i + 1]
      const k = smooth(t, t0, t1)
      set(p0.map((v, j) => v + (p1[j] - v) * k) as V3, r0.map((v, j) => v + (r1[j] - v) * k) as V3)
      return
    }
    if (this.knifeTime !== null) {
      if (!motion) { set([0.14, -0.2, -0.38], [-0.25, Math.PI + 0.4, 1.3]); return }
      const t = this.knifeTime
      if (!this.knifeShown) {
        // The gun ducks out for the first frames.
        const out = (t / 0.06) ** 2
        const grip = this.gripPosition()
        set([grip.x + 0.04 * out, grip.y - 0.18 * out, grip.z], [0.6 * out, Math.PI, -0.6 * out])
        return
      }
      let i = 0
      while (i < KNIFE_SLASH.length - 2 && t > KNIFE_SLASH[i + 1][0]) i++
      const [t0, p0, r0] = KNIFE_SLASH[i], [t1, p1, r1] = KNIFE_SLASH[i + 1]
      const k = smooth(t, t0, t1)
      set(p0.map((v, j) => v + (p1[j] - v) * k) as V3, r0.map((v, j) => v + (r1[j] - v) * k) as V3)
      return
    }
    const flourish = this.flourish
    if (!flourish || flourish.kind !== 'knife') { set([0.14, -0.6, -0.36], [0, Math.PI, 0]); return }
    const t = flourish.time, end = KNIFE_FLOURISH_TIME
    const show = smooth(t, 0.18, 0.42) * (1 - smooth(t, end - 0.2, end))
    const s = Math.max(0, t - 0.42)
    set([0.13, -0.16 - 0.34 * (1 - show), -0.38], [-0.3 + 0.5 * (1 - show), Math.PI + 0.6, 0.35])
    const knife = this.knifeModel
    if (!knife) return
    const id = this.cosmetics?.knife ?? 'combat'
    const parts = knife.userData.parts
    this.knifeSpin.position.set(0, 0, 0); this.knifeSpin.rotation.set(0, 0, 0); knife.position.set(0, 0, 0)
    if (id === 'butterfly') {
      // Closed, open, closed, open: the blade folds back between the handles and flips out again.
      const closed = smooth(s, 0.1, 0.3) - smooth(s, 0.45, 0.65) + smooth(s, 0.8, 1.0) - smooth(s, 1.15, 1.35)
      parts.blade.rotation.x = Math.PI * closed
      parts.handleB.rotation.x = -0.9 * Math.sin(Math.PI * closed)
      m.rotation.z += 0.25 * Math.sin(s * 5)
    } else if (id === 'karambit') {
      // Two turns around the finger ring, the way a karambit is spun.
      const ring = parts.ring.position
      this.knifeSpin.position.copy(ring)
      knife.position.copy(ring).negate()
      this.knifeSpin.rotation.x = -Math.PI * 4 * smooth(s, 0.1, 1.2)
    } else {
      // A toss: the knife leaves the hand, turns over once and is caught.
      const toss = smooth(s, 0.15, 0.75)
      this.knifeSpin.rotation.z = Math.PI * 2 * toss
      this.knifeSpin.rotation.x = -0.6 * Math.sin(Math.PI * toss)
      m.position.y += 0.06 * Math.sin(Math.PI * toss)
      const turn = smooth(s, 0.9, 1.5)
      m.rotation.y += 0.5 * Math.sin(Math.PI * turn)
    }
  }

  /** The watch rides the left forearm just behind the hand, its face turned up toward the eye. */
  private placeWatch(wrist: THREE.Vector3) {
    const watch = this.watch
    if (!watch) return
    const arm = this.arms[1]
    watch.visible = arm.fore.visible
    if (!watch.visible) return
    const elbow = arm.elbow.position
    const axis = wrist.clone().sub(elbow).normalize()
    watch.position.copy(elbow).lerp(wrist, 0.84)
    const face = WATCH_FACE.clone().addScaledVector(axis, -WATCH_FACE.dot(axis)).normalize()
    const side = new THREE.Vector3().crossVectors(axis, face)
    watch.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, axis, face))
  }

  /**
   * The charm is a pendulum in the world: it keeps its momentum when the gun moves, turns or kicks, and
   * gravity always pulls it down, whatever the gun's angle.
   */
  private swingCharm(dt: number) {
    const charm = this.charm
    if (!charm || dt <= 0) return
    charm.pivot.updateWorldMatrix(true, false)
    const anchor = charm.pivot.getWorldPosition(new THREE.Vector3())
    const rest = anchor.clone().addScaledVector(down, CHARM_LENGTH)
    // Only a jump no hand makes (a teleport, a respawn) restarts it; a sprint moves the anchor ~13 cm a frame.
    if (!charm.ready || this.frame.reducedMotion || charm.anchor.distanceTo(anchor) > 0.5) {
      charm.bob.copy(rest); charm.previous.copy(rest); charm.ready = true
    } else {
      const velocity = charm.bob.clone().sub(charm.previous).multiplyScalar(Math.pow(0.9, dt * 60))
      charm.previous.copy(charm.bob)
      charm.bob.add(velocity).addScaledVector(down, 9.8 * dt * dt)
      charm.bob.sub(anchor).setLength(CHARM_LENGTH).add(anchor)
    }
    charm.anchor.copy(anchor)
    const local = charm.pivot.worldToLocal(charm.bob.clone()).normalize()
    // Swing toward the bob, then turn the charm's face (+Z) back toward the eye behind the gun.
    charm.model.quaternion.setFromUnitVectors(down, local).multiply(CHARM_FACING)
  }

  private shoot(item: WeaponItem) {
    const rules = weaponRules(item)
    this.cooldown = rules.interval * this.fireScale
    if (item.magazine === 0) {
      this.held = false
      // As in Call of Duty: the trigger on an empty magazine clicks and starts the reload by itself.
      if (item.reserve > 0) { this.context.emit({ kind: 'empty' }); this.reload(); return }
      this.context.emit({ kind: 'empty', text: 'No ammunition' })
      return
    }
    this.root.updateWorldMatrix(true, true)
    const origin = this.model!.localToWorld(this.model!.userData.muzzle.clone())
    const eye = this.context.camera.getWorldPosition(new THREE.Vector3())
    const forward = this.context.camera.getWorldDirection(new THREE.Vector3())
    const worldDistance = this.context.world.rayDistance(eye, forward, rules.range)
    const aimDistance = this.context.aimDistance?.(eye, forward, worldDistance) ?? worldDistance
    // Converge on the enemy under the crosshair, not scenery behind its thin silhouette.
    const target = eye.clone().addScaledVector(forward, aimDistance)
    const direction = target.sub(origin).normalize()
    // Also test the animated muzzle; a reload/switch pose can differ from the stable wall probe.
    const bridge = origin.clone().sub(eye)
    if (this.context.world.rayDistance(eye, bridge.clone().normalize(), bridge.length() + 0.02) < bridge.length() ||
        this.context.world.rayDistance(origin, direction, 0.15) < 0.15) { this.obstructed = true; return }
    item.magazine--
    this.recoil = item.name === 'shotgun' ? 1.7 : 1
    this.flashTime = 0.05
    const feel = item.special ? DEATH_MACHINE_FEEL : FEEL[item.name]
    this.flash.rotation.z = Math.random() * Math.PI * 2
    this.flashScale = feel.flash * (0.9 + Math.random() * 0.25)
    // Kicks stack under automatic fire but never past a firm limit, so a long burst stays readable.
    this.kick.value = Math.min(this.kick.value + feel.kick, 2.4)
    this.kick.roll = THREE.MathUtils.clamp(this.kick.roll + (Math.random() < 0.5 ? -1 : 1) * feel.roll * (0.6 + Math.random() * 0.4), -0.16, 0.16)
    this.shake.amplitude = Math.max(this.shake.amplitude * Math.exp(-this.shake.time * 11), feel.shake)
    this.shake.time = 0
    this.shake.sign = Math.random() < 0.5 ? -1 : 1
    if (item.name === 'shotgun') {
      const right = new THREE.Vector3().crossVectors(direction, Math.abs(direction.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : up).normalize()
      const vertical = new THREE.Vector3().crossVectors(right, direction).normalize()
      const spread = Math.tan(SHOTGUN_BALLISTICS.halfAngle)
      const rotation = Math.random() * Math.PI * 2
      for (let pellet = 0; pellet < SHOTGUN_PELLETS; pellet++) {
        const angle = rotation + pellet * 2.399963
        const radius = pellet === 0 ? 0 : spread * Math.sqrt(pellet / (SHOTGUN_PELLETS - 1))
        const ray = direction.clone().addScaledVector(right, Math.cos(angle) * radius).addScaledVector(vertical, Math.sin(angle) * radius).normalize()
        this.context.onShot({ origin: origin.clone(), direction: ray, range: rules.range, damage: rules.damage, weapon: item.name, pelletIndex: pellet })
      }
    } else this.context.onShot({ origin, direction, range: rules.range, damage: rules.damage, weapon: item.name })
    // Shotguns punch upward; limit their sideways pull so the bigger kick stays controllable.
    const pitch = rules.kick * (0.8 + Math.random() * 0.4)
    const yaw = (Math.random() - 0.5) * rules.kick * (item.name === 'shotgun' ? 0.55 : 1)
    this.nudge(pitch, yaw)
    this.settle.pitch += pitch * rules.settle; this.settle.yaw += yaw * 0.35
    this.context.emit({ kind: `shot-${item.name}`, position: origin.clone(), radius: item.name === 'pistol' ? 38 : 55, text: `${rules.label} fired` })
    this.pose(0)
  }

  /** Rotates the real look direction, so the kick is visible and affects the next shot like it would for a player. */
  private nudge(pitch: number, yaw: number) {
    if (this.reducedMotion) return
    const rotation = new THREE.Euler().setFromQuaternion(this.context.camera.quaternion, 'YXZ')
    rotation.x = THREE.MathUtils.clamp(rotation.x + pitch, -1.5, 1.5)
    rotation.y += yaw
    this.context.camera.quaternion.setFromEuler(rotation)
  }

  private groundPosition(feet: THREE.Vector3) {
    const forward = this.context.camera.getWorldDirection(new THREE.Vector3())
    forward.y = 0
    const point = feet.clone().addScaledVector(forward.normalize(), 0.6)
    const height = this.context.world.floor(point, 1, 3)
    point.y = Number.isFinite(height) ? height : feet.y
    const start = feet.clone().add(new THREE.Vector3(0, 0.35, 0))
    const end = point.clone().add(new THREE.Vector3(0, 0.35, 0))
    if (!this.context.world.visible(start, end, this.root)) point.copy(feet)
    return point
  }

  drop(feet: THREE.Vector3) {
    if (!this.enabled || !this.current) return false
    const item = copyItem(this.current)
    item.position = this.groundPosition(feet).toArray() as [number, number, number]
    this.inventory[this.slot] = null
    this.cancel()
    this.addPickup(item)
    this.setHeldModel()
    this.context.emit({ kind: 'drop', position: new THREE.Vector3(...item.position), radius: 3, text: `${weaponRules(item).label} dropped` })
    return true
  }

  addPickup(source: WeaponItem) {
    if (this.disposed || this.loose.has(source.id) || this.inventory.some(item => item?.id === source.id)) return
    const item = copyItem(source)
    item.id ||= `loose-weapon-${this.nextId++}`
    item.magazine = Math.max(0, Math.min(WEAPON_RULES[item.name].capacity, Math.floor(item.magazine)))
    item.reserve = Math.max(0, Math.floor(item.reserve))
    item.position ??= this.feet.toArray() as [number, number, number]
    const model = createMissionGun(item.name)
    model.name = `Dropped ${weaponRules(item).label}: ${item.id}`
    model.userData.noCollision = true
    model.rotation.set(0, 0.6, Math.PI / 2)
    model.position.set(...item.position)
    const bounds = new THREE.Box3().setFromObject(model)
    model.position.y += item.position[1] + 0.012 - bounds.min.y
    if (item.rarity && RARITY_INFO[item.rarity].beam) {
      // Parent under the gun so the beam moves, disposes and ignores collision with it.
      // The gun lies on its side, so undo its rotation to keep the beam vertical.
      const beam = createRarityBeam(RARITY_INFO[item.rarity].color)
      beam.quaternion.copy(model.quaternion).invert()
      model.add(beam)
    }
    this.context.scene.add(model)
    this.loose.set(item.id, { item, model })
  }

  pickupTargets() {
    return [...this.loose.values()].map(({ item, model }) => ({
      object: model as THREE.Object3D, point: model.position.clone().add(new THREE.Vector3(0, 0.10, 0)),
      label: `${this.inventory.every(Boolean) ? 'Swap' : 'Take'} ${weaponRules(item).label}`, id: item.id,
    }))
  }

  pickup(id: string) {
    const found = this.loose.get(id)
    if (!this.enabled || !found) return false
    const eye = this.context.camera.getWorldPosition(new THREE.Vector3())
    const point = found.model.position.clone().add(new THREE.Vector3(0, 0.10, 0))
    if (eye.distanceTo(point) > 2.7 || point.clone().sub(eye).normalize().dot(this.context.camera.getWorldDirection(new THREE.Vector3())) < 0.25 ||
        !this.context.world.visible(eye, point, found.model)) return false
    const empty = this.inventory.findIndex(item => !item)
    const destination = empty < 0 ? this.slot : empty
    if (empty < 0) this.drop(this.feet)
    this.cancel()
    this.loose.delete(id)
    disposeGun(found.model)
    const item = copyItem(found.item)
    delete item.position
    this.inventory[destination] = item
    this.slot = destination
    this.switchTime = SWITCH_TIME
    this.setHeldModel(true)
    this.context.emit({ kind: 'pickup', position: this.feet.clone(), radius: 2, text: `${this.label} picked up` })
    return true
  }

  snapshot(): WeaponSnapshot {
    return { slots: this.inventory.map(item => item ? copyItem(item) : null), selected: this.slot,
      pickups: [...this.loose.values()].map(({ item }) => copyItem(item)), nextId: this.nextId }
  }

  private dropMagazine(magazine: THREE.Object3D) {
    magazine.updateWorldMatrix(true, false)
    const copy = magazine.clone(true)
    magazine.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale)
    copy.name = 'Dropped magazine'
    copy.userData.noCollision = true
    this.context.scene.add(copy)
    const floor = this.context.world.floor(copy.position.clone(), 0.1, 3)
    const side = new THREE.Vector3(-0.35, 0, 0).applyQuaternion(this.context.camera.quaternion).setY(0)
    this.falling.push({ object: copy, age: 0, floor: Number.isFinite(floor) ? floor + 0.02 : copy.position.y - 1.5,
      velocity: side.add(new THREE.Vector3(0, -0.6, 0)),
      spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 4 - 2, Math.random() * 8 - 4) })
    while (this.falling.length > MAGAZINES_ON_FLOOR) this.falling.shift()!.object.removeFromParent()
  }

  private updateFalling(delta: number) {
    for (const mag of this.falling) {
      mag.age += delta
      if (mag.object.position.y > mag.floor) {
        mag.velocity.y -= 9.8 * delta
        mag.object.position.addScaledVector(mag.velocity, delta)
        mag.object.rotation.x += mag.spin.x * delta; mag.object.rotation.y += mag.spin.y * delta; mag.object.rotation.z += mag.spin.z * delta
        if (mag.object.position.y <= mag.floor) mag.object.position.y = mag.floor
      }
    }
    for (const mag of this.falling.filter(m => m.age > MAGAZINE_LIFE)) mag.object.removeFromParent()
    this.falling = this.falling.filter(m => m.age <= MAGAZINE_LIFE)
  }

  private clearFalling() {
    for (const mag of this.falling) mag.object.removeFromParent()
    this.falling = []
  }

  restore(snapshot: WeaponSnapshot) {
    this.clearFalling()
    this.cancel()
    this.cooldown = 0
    this.aim = 0
    this.lower = 0
    this.obstructed = false
    for (const { model } of this.loose.values()) disposeGun(model)
    this.loose.clear()
    this.inventory = snapshot.slots.slice(0, WEAPON_SLOTS).map(item => item ? copyItem(item) : null)
    if (!this.inventory.length) this.inventory = Array(WEAPON_SLOTS).fill(null)
    this.slot = Number.isInteger(snapshot.selected) && snapshot.selected >= 0 && snapshot.selected < this.inventory.length ? snapshot.selected : 0
    this.nextId = snapshot.nextId
    for (const item of snapshot.pickups) this.addPickup(item)
    this.setHeldModel()
  }

  dispose() {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
    this.clearFalling()
    this.clearSwap()
    if (this.model) disposeGun(this.model)
    for (const { model } of this.loose.values()) disposeGun(model)
    this.loose.clear()
    this.root.removeFromParent()
    for (const geometry of [this.upperArmGeometry, this.forearmGeometry, this.jointGeometry, this.palmGeometry, this.flashGeometry]) geometry.dispose()
    this.armMaterial.dispose()
    this.flashMaterial.dispose()
  }
}
