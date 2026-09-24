import * as THREE from 'three'
import { Draft, createRarityBeam, wallText } from '../../render/ink'
import { createMissionGun } from '../weapon-models'
import { disposeGun } from '../../lab/weapons/models'
import { RARITY_INFO, rollRarity, type Rarity } from '../loot'
import type { WeaponName } from '../types'
import { BOX_OFFER, BOX_SPIN } from './economy'
import type { WallSize, WallSpot } from './placement'
import { LightMotes } from './effects'
import { MYTHIC, MYTHIC_REVEAL, applyDragonSkin } from './mythic'

/**
 * The things you spend points on, drawn in the same ink as the buildings. Placeholder art until Astra's
 * models arrive: a sheet of paper taped to the wall with the gun on it, and a long crate with question
 * marks. Nothing here collides, so the baked navigation graph stays true.
 */

const facing = (normal: THREE.Vector3) => Math.atan2(normal.x, normal.z)

export class WallBuy {
  readonly root = new THREE.Group()
  /** Where the player looks to use it. */
  readonly point: THREE.Vector3
  private gun: ReturnType<typeof createMissionGun>

  constructor(readonly spot: WallSpot, readonly weapon: WeaponName, readonly price: number) {
    this.root.name = `Wall buy · ${weapon}`
    this.root.userData.noCollision = true
    const angle = facing(spot.normal)
    // Mounted at chest height, a hair off the wall so the paper never flickers into it.
    const centre = spot.wall.clone().addScaledVector(spot.normal, 0.025).setY(spot.stand.y + 1.35)
    this.root.position.copy(centre)
    this.root.rotation.y = angle
    const sheet = new Draft(`Wall buy sheet · ${weapon}`)
    sheet.box(1.15, 0.62, 0.015, 0, 0, 0, 'paper', 'edge')
    sheet.finish()
    this.root.add(sheet)
    this.gun = createMissionGun(weapon)
    this.gun.name = `Wall buy gun · ${weapon}`
    // Side-on against the paper, barrel pointing along the wall.
    this.gun.rotation.set(0, Math.PI / 2, 0)
    this.gun.position.set(0, 0.06, 0.05)
    this.root.add(this.gun)
    this.root.add(wallText(String(price), [0, -0.23, 0.02], 0.14))
    this.point = centre.clone()
  }

  dispose() { disposeGun(this.gun); this.root.removeFromParent() }
}

export type BoxState = 'idle' | 'spinning' | 'offering' | 'leaving'

/** How long the teddy bear sits there before the box lifts off, and how long the lift takes. */
export const BOX_TEDDY = { show: 1.2, spin: 3, lift: 1.4 } as const
/** The box's marker: a tall pale-gold column over wherever it stands, as Call of Duty's light beam. */
const BOX_LIGHT = 0xe8c46a

/**
 * The Mystery Box: pay, it spins through guns, then offers one for a few seconds. Now and then it lands
 * on a teddy bear instead: it lifts away and turns up somewhere else on the map, as in Call of Duty.
 * A Mythic roll makes a moment of it: the reel runs longer and crawls to its stop while the box flickers
 * magenta, then a burst and a tall beam of the tier's colour, and the gun pops up turning, dragon and all.
 */
const WHITE = new THREE.Color(0xffffff)
/** How often a gun sliding past in the reel flashes Mythic pink: a near miss, far more often than the real one in a thousand. */
const REEL_MYTHIC = 0.006

/** A soft round glow, white at the middle and gone at the rim, tinted per rarity. */
function haloTexture() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.45, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g; c.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export class MysteryBox {
  /**
   * The block it fills against its wall, for placement: the crate with its lid open and a gun rising out
   * of it. The wall guns share its ring of spots, and their sheets fit in this block too.
   */
  static readonly SIZE: WallSize = { halfWidth: 0.72, top: 1.75, depth: 0.66 }
  readonly root = new THREE.Group()
  readonly point = new THREE.Vector3()
  spot: WallSpot
  state: BoxState = 'idle'
  /** Seconds into the current spin, offer or departure. */
  timer = 0
  /** Spins at this spot: the teddy only comes after a few. */
  uses = 0
  offer: { name: WeaponName; rarity: Rarity; special?: 'rayGun' } | null = null
  private teddyNext = false
  private lid = new THREE.Group()
  private body = new THREE.Group()
  /** Light rising off the box: a trickle marks it, a burst while it spins, the gun's colour on offer. */
  private motes = new LightMotes(160, 0.06)
  private marker = createRarityBeam(BOX_LIGHT, 14)
  private teddy = teddyBear()
  private glow = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.5), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }))
  private spill = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.2), new THREE.MeshBasicMaterial({ map: spillTexture(), transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
  private floating: ReturnType<typeof createMissionGun> | null = null
  private floatingName: WeaponName | null = null
  private beam: THREE.Group | null = null
  private cycle = 0
  private cycleLength = 0.07
  /** Seconds this spin runs: longer for a Mythic. */
  private spinLength = BOX_SPIN
  /** The Mythic's tall beams, while one is on offer. */
  private mythicBeam: THREE.Group | null = null
  /**
   * The reel, as a case opening: every gun that slides past shows a rarity (the box's own odds, and now
   * and then a flash of Mythic pink), in a halo behind it and in the box's light. What you get is rolled
   * apart from it, at the real odds.
   */
  private reelRarity: Rarity = 'uncommon'
  private halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), transparent: true, opacity: 0, depthWrite: false, toneMapped: false }))
  private baseY: number

  constructor(spot: WallSpot) {
    this.root.name = 'Mystery box'
    this.root.userData.noCollision = true
    const width = 1.4, depth = 0.6, height = 0.55
    // A planked crate: boards drawn across every side, iron brackets on the corners, a lock plate.
    const body = new Draft('Mystery box body')
    body.box(width, height, depth, 0, height / 2, 0, 'paper', 'edge')
    body.box(width + 0.04, 0.05, depth + 0.04, 0, 0.03, 0, 'paper', 'detail')
    for (const y of [0.19, 0.37]) {
      for (const z of [-depth / 2 - 0.002, depth / 2 + 0.002]) body.line([[-width / 2, y, z], [width / 2, y, z]], 'detail')
      for (const x of [-width / 2 - 0.002, width / 2 + 0.002]) body.line([[x, y, -depth / 2], [x, y, depth / 2]], 'detail')
    }
    for (const x of [-1, 1]) for (const z of [-1, 1]) for (const y of [0.05, height - 0.05])
      body.box(0.1, 0.1, 0.1, x * (width / 2 - 0.03), y, z * (depth / 2 - 0.03), 'concrete', 'detail')
    body.box(0.14, 0.16, 0.03, 0, height - 0.12, depth / 2 + 0.012, 'concrete', 'detail')
    body.finish()
    this.body.add(body)
    // The lid hinges along the back edge, banded with iron.
    this.lid.position.set(0, height, -depth / 2)
    const lid = new Draft('Mystery box lid')
    lid.box(width + 0.03, 0.08, depth + 0.03, 0, 0.04, depth / 2, 'paper', 'edge')
    for (const x of [-0.45, 0.45]) lid.box(0.08, 0.09, depth + 0.05, x, 0.045, depth / 2, 'concrete', 'detail')
    lid.finish()
    this.lid.add(lid)
    this.body.add(this.lid)
    // Question marks in glowing gold on the front and back: the box is the one gold thing in the yard.
    for (const [x, z, turn] of [[-0.42, depth / 2 + 0.014, 0], [0.42, depth / 2 + 0.014, 0], [0, -depth / 2 - 0.014, Math.PI]] as const)
      this.body.add(goldMark([x, height * 0.5, z], turn))
    // Light pouring out of the open box, and a warm spill on the ground around it.
    this.glow.rotation.x = -Math.PI / 2
    this.glow.position.y = height - 0.03
    this.spill.rotation.x = -Math.PI / 2
    this.spill.position.y = 0.012
    this.baseY = height + 0.15
    this.teddy.visible = false
    this.halo.scale.set(1.05, 0.62, 1)
    this.halo.visible = false
    this.body.add(this.motes, this.teddy, this.glow, this.spill, this.halo)
    this.root.add(this.body, this.marker)
    this.spot = spot
    this.place(spot)
  }

  /** Stand the box at a spot, closed, long side along the wall, back against it. */
  place(spot: WallSpot) {
    const depth = 0.6, height = 0.55
    this.spot = spot
    const centre = spot.wall.clone().addScaledVector(spot.normal, depth / 2 + 0.06).setY(spot.stand.y)
    this.root.position.copy(centre)
    this.root.rotation.y = facing(spot.normal)
    this.body.position.set(0, 0, 0)
    this.body.rotation.set(0, 0, 0)
    this.body.visible = true
    this.point.copy(centre).setY(spot.stand.y + height + 0.1).addScaledVector(spot.normal, depth / 2)
    this.uses = 0
    this.close()
  }

  /** Start a spin with the gun it will land on, or with the teddy bear. */
  spin(result: { name: WeaponName; rarity: Rarity; special?: 'rayGun' }, teddy = false) {
    this.offer = teddy ? null : result
    this.teddyNext = teddy
    this.state = 'spinning'
    this.timer = 0
    this.cycle = 0
    this.spinLength = this.mythic ? BOX_SPIN + MYTHIC_REVEAL.slow : BOX_SPIN
    this.uses++
  }

  /** Take the offered gun; the box closes. */
  take() {
    const offer = this.offer
    this.close()
    return offer
  }

  /** The spin will land, or has landed, on a Mythic. */
  get mythic() { return !this.teddyNext && this.offer?.rarity === 'mythic' }

  close() {
    this.state = 'idle'
    this.offer = null
    this.teddyNext = false
    this.timer = 0
    this.teddy.visible = false
    this.setFloating(null)
  }

  /** Advance the animation. 'landed': the spin stopped on a gun; 'expired': it went untaken; 'moved': the teddy took the box away. */
  update(dt: number, spinNames: readonly WeaponName[]): 'landed' | 'expired' | 'moved' | null {
    const lidTarget = this.state === 'idle' ? 0 : -1.25
    this.lid.rotation.x += (lidTarget - this.lid.rotation.x) * Math.min(1, dt * 8)
    this.marker.visible = this.state === 'idle' && this.body.visible
    // Brighter the wider the lid is open.
    const open = Math.min(1, -this.lid.rotation.x / 1.25)
    const glow = this.glow.material as THREE.MeshBasicMaterial, spill = this.spill.material as THREE.MeshBasicMaterial
    glow.opacity = open * (0.75 + 0.2 * Math.sin(this.timer * 18))
    spill.opacity = 0.55 + 0.45 * open
    // A Mythic: the box flickers its colour as the reel crawls to a stop, then flashes white to magenta.
    const mythic = this.mythic && (this.state === 'spinning' || this.state === 'offering')
    const tease = mythic && this.state === 'spinning' ? Math.max(0, (this.timer - (this.spinLength - MYTHIC_REVEAL.tease)) / MYTHIC_REVEAL.tease) : 0
    const burst = mythic && this.state === 'offering' ? Math.max(0, 1 - this.timer / MYTHIC_REVEAL.burst) : 0
    glow.color.set(0xffd36b)
    spill.color.set(0xffffff)
    if (this.state === 'spinning') {
      const reel = RARITY_INFO[this.reelRarity].color
      glow.color.setHex(reel)
      spill.color.setHex(reel).lerp(WHITE, 0.4)
    }
    if (tease > 0 && Math.sin(this.timer * (26 + tease * 30)) > 0.2 - tease * 0.6) { glow.color.set(MYTHIC.color); spill.color.set(0xff7ac8) }
    if (burst > 0) {
      glow.color.set(MYTHIC.color).lerp(new THREE.Color(0xffffff), burst ** 3)
      glow.opacity = Math.min(1, open * (0.8 + burst))
      spill.color.set(0xff7ac8)
    } else if (mythic && this.state === 'offering') { glow.color.set(MYTHIC.color); spill.color.set(0xff9ad4) }
    const top = this.baseY - 0.15
    const mythicMote = () => Math.random() < 0.5 ? MYTHIC.crimson : MYTHIC.violet
    if (this.state === 'idle') this.motes.update(dt, 5, p => p.set((Math.random() - 0.5) * 1.3, top + 0.1, (Math.random() - 0.5) * 0.55), 0xe8b64a, 0.35)
    else if (this.state === 'spinning') this.motes.update(dt, 110 + tease * 120, p => p.set((Math.random() - 0.5) * 1.2, top, (Math.random() - 0.5) * 0.45), tease > 0 && Math.random() < tease ? mythicMote() : RARITY_INFO[this.reelRarity].color, 1.9 + tease)
    else if (this.state === 'leaving') this.motes.update(dt, 70, p => p.set((Math.random() - 0.5) * 1.3, Math.random() * 0.4, (Math.random() - 0.5) * 0.5), 0xe8b64a, 1.2)
    else if (burst > 0) {
      // The burst: a fountain of the tier's colours off the box.
      this.motes.update(dt, 900 * burst, p => p.set((Math.random() - 0.5) * 1.2, top + Math.random() * 0.3, (Math.random() - 0.5) * 0.5), mythicMote(), 2.2 + 2.5 * burst)
    } else {
      const color = this.mythic ? mythicMote() : this.offer && this.offer.rarity !== 'common' ? RARITY_INFO[this.offer.rarity].color : 0xe8b64a
      const at = this.floating?.position ?? new THREE.Vector3(0, top + 0.6, 0)
      this.motes.update(dt, this.mythic ? 70 : 45, p => p.randomDirection().multiplyScalar(0.25 + Math.random() * 0.3).add(at), color, 0.45)
    }
    if (this.mythicBeam) {
      // The tall beam swells out of the burst and settles into a slow pulse.
      const pulse = 1 + 1.1 * burst ** 2 + 0.08 * Math.sin(this.timer * 5)
      this.mythicBeam.scale.set(pulse, 1, pulse)
    }
    if (this.state === 'idle') return null
    this.timer += dt
    if (this.state === 'spinning') {
      // Cycle through guns, slowing down as it settles, rising out of the box.
      this.cycle -= dt
      if (this.cycle <= 0) {
        const pool = spinNames.length ? spinNames : [this.offer?.name ?? 'pistol']
        const next = pool[Math.floor(Math.random() * pool.length)]
        this.reelRarity = Math.random() < REEL_MYTHIC ? 'mythic' : rollRarity('chest')
        this.setFloating(next)
        // A Mythic's reel crawls through its last few guns, each held longer than the one before.
        const progress = this.timer / this.spinLength
        this.cycleLength = this.cycle = 0.07 + 0.25 * progress ** 2 + (this.mythic ? 0.55 * progress ** 6 : 0)
      }
      if (this.timer >= this.spinLength) {
        this.timer = 0
        if (this.teddyNext) {
          this.state = 'leaving'
          this.setFloating(null)
          this.teddy.visible = true
        } else {
          this.state = 'offering'
          this.setFloating(this.offer!.name, this.offer!.rarity, this.offer!.special)
          return 'landed'
        }
      }
    } else if (this.state === 'leaving') {
      // The bear sits there; the lid slams; the box spins up faster and faster, rising a little, and
      // then shoots off into the sky.
      this.teddy.position.set(0, this.baseY + 0.3 + Math.sin(this.timer * 3) * 0.04, 0)
      this.teddy.rotation.y = Math.sin(this.timer * 2) * 0.4
      const spin = Math.max(0, this.timer - BOX_TEDDY.show), lift = Math.max(0, spin - BOX_TEDDY.spin)
      if (spin > 0) {
        this.teddy.visible = false
        this.lid.rotation.x = 0
        const s = Math.min(spin, BOX_TEDDY.spin)
        this.body.rotation.y = s * s * 2.2 + lift * 14
        this.body.position.set(Math.sin(spin * 50) * 0.015, 0.45 * (s / BOX_TEDDY.spin) ** 2 + (lift / BOX_TEDDY.lift) ** 2 * 22, 0)
      }
      if (lift >= BOX_TEDDY.lift) { this.body.visible = false; this.body.rotation.y = 0; this.state = 'idle'; this.teddyNext = false; return 'moved' }
      return null
    } else if (this.timer >= BOX_OFFER) {
      this.close()
      return 'expired'
    }
    if (this.floating) {
      // Side-on, like the reel of a slot machine: each gun slides up through the opening, slower and
      // slower, until the last one stops in the middle and sinks back in as the offer runs out.
      const rise = this.state === 'spinning' ? Math.min(1, this.timer / this.spinLength) : 1 - Math.min(1, this.timer / BOX_OFFER) * 0.6
      const reel = this.state === 'spinning' ? 1 - this.cycle / this.cycleLength - 0.5 : 0
      this.floating.position.set(0, this.baseY + 0.45 * rise + reel * 0.34, 0)
      this.floating.rotation.set(0, Math.PI / 2, 0)
      this.floating.scale.setScalar(this.state === 'spinning' ? 1 - Math.abs(reel) * 0.5 : 1 + Math.sin(this.timer * 3) * 0.02)
      // The Ink Ray is pistol-sized; on offer it is shown larger, the box's prize.
      if (this.state === 'offering' && this.offer?.special === 'rayGun') this.floating.scale.multiplyScalar(1.6)
      // The reel's colour behind each gun as it passes, brightest as it crosses the middle.
      const halo = this.halo.material as THREE.SpriteMaterial
      this.halo.visible = this.state === 'spinning'
      if (this.halo.visible) {
        this.halo.position.copy(this.floating.position)
        halo.color.setHex(RARITY_INFO[this.reelRarity].color)
        halo.opacity = 0.6 * (1 - Math.abs(reel) * 1.4)
      }
      if (this.mythic && this.state === 'offering') {
        // It pops up big, turns one and a half times, and settles with its dragon's side (the gun's right,
        // which also faces you in first person) toward you, a little higher and larger.
        const turn = Math.min(1, this.timer / 1.5), ease = 1 - (1 - turn) ** 3
        this.floating.rotation.y = Math.PI / 2 + Math.PI * 3 * ease
        this.floating.position.y += 0.12 * ease
        this.floating.scale.multiplyScalar(1.25 + 0.5 * Math.exp(-this.timer * 7) * Math.cos(this.timer * 18))
      }
    }
    return null
  }

  private setFloating(name: WeaponName | null, rarity?: Rarity, special?: 'rayGun') {
    if (name !== this.floatingName || rarity) {
      if (this.floating) { disposeGun(this.floating); this.floating = null }
      // The beam's material is shared across all loot of a colour; only its shapes are this box's.
      this.beam?.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
      this.beam?.removeFromParent(); this.beam = null
      this.mythicBeam?.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
      this.mythicBeam?.removeFromParent(); this.mythicBeam = null
      this.floatingName = name
      if (name) {
        this.floating = createMissionGun(name, special)
        this.floating.name = `Mystery box gun · ${name}`
        this.floating.userData.noCollision = true
        this.body.add(this.floating)
        if (rarity && RARITY_INFO[rarity].beam) {
          this.beam = createRarityBeam(RARITY_INFO[rarity].color, 3)
          this.beam.position.y = 0.1
          this.body.add(this.beam)
        }
        if (rarity === 'mythic') {
          applyDragonSkin(this.floating)
          // Two columns into the sky, crimson inside violet, just behind the gun so they frame it rather
          // than wash over it.
          this.mythicBeam = new THREE.Group()
          this.mythicBeam.name = 'Mythic beam'
          const inner = createRarityBeam(MYTHIC.crimson, MYTHIC_REVEAL.beam), outer = createRarityBeam(MYTHIC.violet, MYTHIC_REVEAL.beam * 0.8)
          inner.scale.set(1.2, 1, 1.2)
          outer.scale.set(1.8, 1, 1.8)
          this.mythicBeam.add(inner, outer)
          this.mythicBeam.position.set(0, 0.1, -0.2)
          this.body.add(this.mythicBeam)
        }
      }
    }
  }

  dispose() {
    this.setFloating(null); this.motes.dispose()
    const halo = this.halo.material as THREE.SpriteMaterial
    halo.map?.dispose(); halo.dispose()
    this.marker.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    this.teddy.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose() } })
    for (const mesh of [this.glow, this.spill]) { mesh.geometry.dispose(); (mesh.material as THREE.MeshBasicMaterial).map?.dispose(); (mesh.material as THREE.Material).dispose() }
    this.root.traverse(o => { if (o.userData.goldMark && o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.MeshBasicMaterial).map?.dispose(); (o.material as THREE.Material).dispose() } })
    this.root.removeFromParent()
  }
}

/** A question mark in gold with a soft glow, drawn once and shared. */
let goldTexture: THREE.CanvasTexture | null = null
function goldMark(position: [number, number, number], turn: number) {
  if (!goldTexture && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const c = canvas.getContext('2d')!
    c.font = 'bold 104px "Chalkboard SE", "Comic Sans MS", cursive'
    c.textAlign = 'center'; c.textBaseline = 'middle'
    c.shadowColor = 'rgba(255, 196, 64, 0.9)'; c.shadowBlur = 18
    c.fillStyle = '#e8a317'; c.fillText('?', 64, 68)
    c.shadowBlur = 0; c.lineWidth = 3; c.strokeStyle = '#111'; c.strokeText('?', 64, 68)
    goldTexture = new THREE.CanvasTexture(canvas)
    goldTexture.colorSpace = THREE.SRGBColorSpace
  }
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), new THREE.MeshBasicMaterial({ map: goldTexture, transparent: true, depthWrite: false, toneMapped: false }))
  mark.position.set(...position)
  mark.rotation.y = turn
  mark.userData.noCollision = true
  return mark
}

/** The warm light the box throws on the ground: a soft gold oval. */
function spillTexture() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 88
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(64, 44, 4, 64, 44, 62)
  g.addColorStop(0, 'rgba(255, 205, 90, 0.55)'); g.addColorStop(0.55, 'rgba(255, 205, 90, 0.22)'); g.addColorStop(1, 'rgba(255, 205, 90, 0)')
  c.fillStyle = g; c.fillRect(0, 0, 128, 88)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** The teddy bear: ink black like everything that lives here, with two red button eyes. */
function teddyBear() {
  const bear = new THREE.Group()
  bear.name = 'Mystery box teddy bear'
  bear.userData.noCollision = true
  const ink = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
  const eye = new THREE.MeshBasicMaterial({ color: 0xd4332a, toneMapped: false })
  const ball = (r: number, x: number, y: number, z: number, material = ink) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), material)
    mesh.position.set(x, y, z)
    bear.add(mesh)
  }
  ball(0.16, 0, 0, 0)
  ball(0.11, 0, 0.22, 0)
  for (const side of [-1, 1]) {
    ball(0.045, side * 0.085, 0.31, 0)
    ball(0.055, side * 0.15, 0.03, 0.03)
    ball(0.06, side * 0.08, -0.14, 0.05)
    ball(0.018, side * 0.04, 0.24, 0.1, eye)
  }
  return bear
}
