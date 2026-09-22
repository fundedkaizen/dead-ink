import * as THREE from 'three'
import { Draft, createRarityBeam, wallText } from '../../render/ink'
import { createMissionGun } from '../weapon-models'
import { disposeGun } from '../../lab/weapons/models'
import { RARITY_INFO, type Rarity } from '../loot'
import type { WeaponName } from '../types'
import { BOX_OFFER, BOX_SPIN } from './economy'
import type { WallSpot } from './placement'
import { LightMotes } from './effects'

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

export type BoxState = 'idle' | 'spinning' | 'offering'

/** The Mystery Box: pay, it spins through guns, then offers one for a few seconds. */
export class MysteryBox {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  state: BoxState = 'idle'
  /** Seconds into the current spin or offer. */
  timer = 0
  offer: { name: WeaponName; rarity: Rarity } | null = null
  private lid = new THREE.Group()
  /** Light rising off the box: a trickle marks it, a burst while it spins, the gun's colour on offer. */
  private motes = new LightMotes(160, 0.06)
  private floating: ReturnType<typeof createMissionGun> | null = null
  private floatingName: WeaponName | null = null
  private beam: THREE.Group | null = null
  private cycle = 0
  private baseY: number

  constructor(readonly spot: WallSpot) {
    this.root.name = 'Mystery box'
    this.root.userData.noCollision = true
    const width = 1.4, depth = 0.6, height = 0.55
    // Long side along the wall, back against it.
    const centre = spot.wall.clone().addScaledVector(spot.normal, depth / 2 + 0.06).setY(spot.stand.y)
    this.root.position.copy(centre)
    this.root.rotation.y = facing(spot.normal)
    const body = new Draft('Mystery box body')
    body.box(width, height, depth, 0, height / 2, 0, 'paper', 'edge')
    body.box(width + 0.04, 0.05, depth + 0.04, 0, 0.12, 0, 'paper', 'detail')
    body.finish()
    this.root.add(body)
    // The lid hinges along the back edge.
    this.lid.position.set(0, height, -depth / 2)
    const lid = new Draft('Mystery box lid')
    lid.box(width + 0.03, 0.08, depth + 0.03, 0, 0.04, depth / 2, 'paper', 'edge')
    lid.finish()
    this.lid.add(lid)
    this.root.add(this.lid)
    for (const x of [-0.42, 0.42]) this.root.add(wallText('?', [x, height * 0.52, depth / 2 + 0.012], 0.34))
    this.baseY = height + 0.15
    this.root.add(this.motes)
    this.point = centre.clone().setY(spot.stand.y + height + 0.1).addScaledVector(spot.normal, depth / 2)
  }

  /** Start a spin with the gun it will land on. */
  spin(result: { name: WeaponName; rarity: Rarity }) {
    this.offer = result
    this.state = 'spinning'
    this.timer = 0
    this.cycle = 0
  }

  /** Take the offered gun; the box closes. */
  take() {
    const offer = this.offer
    this.close()
    return offer
  }

  close() {
    this.state = 'idle'
    this.offer = null
    this.timer = 0
    this.setFloating(null)
  }

  /** Advance the animation. Returns true when an offer expired untaken. */
  update(dt: number, spinNames: readonly WeaponName[]) {
    const lidTarget = this.state === 'idle' ? 0 : -1.25
    this.lid.rotation.x += (lidTarget - this.lid.rotation.x) * Math.min(1, dt * 8)
    const top = this.baseY - 0.15
    if (this.state === 'idle') this.motes.update(dt, 5, p => p.set((Math.random() - 0.5) * 1.3, top + 0.1, (Math.random() - 0.5) * 0.55), 0xe8b64a, 0.35)
    else if (this.state === 'spinning') this.motes.update(dt, 110, p => p.set((Math.random() - 0.5) * 1.2, top, (Math.random() - 0.5) * 0.45), 0xffc94a, 1.9)
    else {
      const color = this.offer && this.offer.rarity !== 'common' ? RARITY_INFO[this.offer.rarity].color : 0xe8b64a
      const at = this.floating?.position ?? new THREE.Vector3(0, top + 0.6, 0)
      this.motes.update(dt, 45, p => p.randomDirection().multiplyScalar(0.25 + Math.random() * 0.3).add(at), color, 0.45)
    }
    if (this.state === 'idle') return false
    this.timer += dt
    if (this.state === 'spinning') {
      // Cycle through guns, slowing down as it settles, rising out of the box.
      this.cycle -= dt
      if (this.cycle <= 0) {
        const pool = spinNames.length ? spinNames : [this.offer!.name]
        const next = pool[Math.floor(Math.random() * pool.length)]
        this.setFloating(next)
        this.cycle = 0.07 + 0.25 * (this.timer / BOX_SPIN) ** 2
      }
      if (this.timer >= BOX_SPIN) {
        this.state = 'offering'
        this.timer = 0
        this.setFloating(this.offer!.name, this.offer!.rarity)
      }
    } else if (this.timer >= BOX_OFFER) {
      this.close()
      return true
    }
    if (this.floating) {
      const rise = this.state === 'spinning' ? Math.min(1, this.timer / BOX_SPIN) : 1 - Math.min(1, this.timer / BOX_OFFER) * 0.6
      this.floating.position.set(0, this.baseY + 0.45 * rise, 0)
      this.floating.rotation.y += dt * (this.state === 'spinning' ? 5 : 1.2)
    }
    return false
  }

  private setFloating(name: WeaponName | null, rarity?: Rarity) {
    if (name !== this.floatingName || rarity) {
      if (this.floating) { disposeGun(this.floating); this.floating = null }
      // The beam's material is shared across all loot of a colour; only its shapes are this box's.
      this.beam?.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
      this.beam?.removeFromParent(); this.beam = null
      this.floatingName = name
      if (name) {
        this.floating = createMissionGun(name)
        this.floating.name = `Mystery box gun · ${name}`
        this.floating.userData.noCollision = true
        this.root.add(this.floating)
        if (rarity && RARITY_INFO[rarity].beam) {
          this.beam = createRarityBeam(RARITY_INFO[rarity].color, 3)
          this.beam.position.y = 0.1
          this.root.add(this.beam)
        }
      }
    }
  }

  dispose() { this.setFloating(null); this.motes.dispose(); this.root.removeFromParent() }
}
