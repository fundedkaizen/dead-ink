import * as THREE from 'three'
import { Draft, wallText } from '../../render/ink'
import { PRICES } from './rules'
import type { WallSpot } from './placement'
import { LightMotes } from './effects'
import { metal } from '../../lab/weapons/models/common'

/**
 * Perks, Call of Duty's perk-a-colas in ink: a machine on a wall, pay, drink, keep the perk until you
 * go down. Each perk has its own colour (its machine's light, its bottle, its HUD badge), because each
 * perk is a meaning of its own.
 */
export type PerkKind = 'thickInk' | 'quickDip' | 'doubleLine' | 'secondDraft' | 'spareNib'

export const PERKS: Record<PerkKind, { name: string; cod: string; cost: number; color: number; css: string; blurb: string }> = {
  thickInk: { name: 'Thick Ink', cod: 'Juggernog', cost: PRICES.perks.thickInk, color: 0xc8322b, css: '#c8322b', blurb: 'Take five hits instead of two.' },
  quickDip: { name: 'Quick Dip', cod: 'Speed Cola', cost: PRICES.perks.quickDip, color: 0x2e9b45, css: '#2e9b45', blurb: 'Reload twice as fast.' },
  doubleLine: { name: 'Double Line', cod: 'Double Tap', cost: PRICES.perks.doubleLine, color: 0xe08a1e, css: '#e08a1e', blurb: 'Fire faster; every bullet counts twice.' },
  secondDraft: { name: 'Second Draft', cod: 'Quick Revive', cost: PRICES.perks.secondDraftSolo, color: 0x2f6fd0, css: '#2f6fd0', blurb: 'Get back up once when you would die.' },
  spareNib: { name: 'Spare Nib', cod: 'Mule Kick', cost: PRICES.perks.spareNib, color: 0x1f9a93, css: '#1f9a93', blurb: 'Carry a third gun.' },
}
/** Call of Duty's perk limit. */
export const PERK_LIMIT = 4
/** What a perk does, in numbers. */
export const PERK_EFFECT = { reloadScale: 0.5, fireScale: 0.75, damage: 2, reviveGrace: 3, reviveShove: 5 } as const
/**
 * Where each perk machine and the Pack-a-Punch go: a point in its zone (the gates are shut when they are
 * placed, so the nearest good wall to it is always in that zone). Quick Revive by the spawn, as in Call of
 * Duty; the rest spread over the zones you have to open (the rail yard has no wall to stand one on);
 * Pack-a-Punch by the Detention block.
 */
export const MACHINE_PLACES: readonly [PerkKind | 'pack', [number, number, number]][] = [
  ['secondDraft', [-30, 0, -25]], ['quickDip', [-40, 0, 40]], ['thickInk', [20, 0, 20]],
  ['doubleLine', [40, 0, 40]], ['spareNib', [125, 0, -10]], ['pack', [117, 0, -5]],
]
/** Pack-a-Punch: price, how long the machine works on a gun, and how long it waits for you to take it. */
export const PACK = { cost: PRICES.packAPunch, work: 3.2, wait: 15 } as const

// ---------------------------------------------------------------- icons

const icons = new Map<string, HTMLCanvasElement>()

/** A round badge in the perk's colour with a white ink glyph. */
export function perkIcon(kind: PerkKind) {
  const cached = icons.get(kind)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const c = canvas.getContext('2d')!
  c.fillStyle = PERKS[kind].css
  c.beginPath(); c.arc(64, 64, 58, 0, Math.PI * 2); c.fill()
  c.lineWidth = 6; c.strokeStyle = '#111'; c.stroke()
  c.fillStyle = c.strokeStyle = '#fbfaf5'
  c.lineCap = c.lineJoin = 'round'
  switch (kind) {
    case 'thickInk':
      // A heavy drop.
      c.beginPath(); c.moveTo(64, 22); c.bezierCurveTo(92, 58, 96, 70, 90, 84); c.arc(64, 80, 27, 0.15, Math.PI - 0.15); c.bezierCurveTo(32, 70, 36, 58, 64, 22); c.fill()
      break
    case 'quickDip':
      // A lightning nib.
      c.beginPath(); c.moveTo(72, 18); c.lineTo(40, 70); c.lineTo(62, 70); c.lineTo(52, 110); c.lineTo(88, 54); c.lineTo(66, 54); c.closePath(); c.fill()
      break
    case 'doubleLine':
      c.lineWidth = 13
      for (const x of [48, 80]) { c.beginPath(); c.moveTo(x, 28); c.lineTo(x, 100); c.stroke() }
      break
    case 'secondDraft':
      // A turning arrow.
      c.lineWidth = 12
      c.beginPath(); c.arc(64, 66, 30, -Math.PI * 0.2, Math.PI * 1.35); c.stroke()
      c.beginPath(); c.moveTo(96, 34); c.lineTo(98, 64); c.lineTo(70, 54); c.closePath(); c.fill()
      break
    case 'spareNib':
      // A pen nib and a plus.
      c.beginPath(); c.moveTo(52, 22); c.lineTo(74, 70); c.lineTo(52, 108); c.lineTo(30, 70); c.closePath(); c.fill()
      c.fillStyle = PERKS[kind].css; c.beginPath(); c.arc(52, 66, 6, 0, Math.PI * 2); c.fill()
      c.fillStyle = '#fbfaf5'; c.fillRect(80, 58, 30, 10); c.fillRect(90, 48, 10, 30)
      break
  }
  icons.set(kind, canvas)
  return canvas
}

const facing = (normal: THREE.Vector3) => Math.atan2(normal.x, normal.z)

function iconPlane(canvas: HTMLCanvasElement, size: number) {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }))
  plane.userData.noCollision = true
  return plane
}

// ---------------------------------------------------------------- machines

/** A perk machine against a wall: ink cabinet, a lit panel in the perk's colour, its badge and price. */
export class PerkMachine {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  private light: THREE.Mesh
  private time = Math.random() * 10

  constructor(readonly kind: PerkKind, readonly spot: WallSpot) {
    const perk = PERKS[kind]
    this.root.name = `Perk machine · ${perk.name}`
    this.root.userData.noCollision = true
    const width = 1.05, depth = 0.7, height = 2.05
    this.root.position.copy(spot.wall.clone().addScaledVector(spot.normal, depth / 2 + 0.04).setY(spot.stand.y))
    this.root.rotation.y = facing(spot.normal)
    const body = new Draft(`${perk.name} cabinet`)
    body.box(width, height, depth, 0, height / 2, 0, 'paper', 'edge')
    body.box(width * 0.8, 0.14, 0.06, 0, 0.55, depth / 2 + 0.02, 'paper', 'detail')
    body.box(0.18, 0.28, 0.05, width * 0.3, 1.0, depth / 2 + 0.02, 'paper', 'detail')
    body.finish()
    this.root.add(body)
    // The lit panel: the one strong colour on the machine.
    this.light = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.82, 0.62), new THREE.MeshBasicMaterial({ color: perk.color, toneMapped: false }))
    this.light.position.set(0, 1.62, depth / 2 + 0.012)
    this.root.add(this.light)
    const badge = iconPlane(perkIcon(kind), 0.5)
    badge.position.set(0, 1.62, depth / 2 + 0.02)
    this.root.add(badge)
    this.root.add(wallText(perk.name.toUpperCase(), [0, 1.2, depth / 2 + 0.02], 0.2))
    this.root.add(wallText(String(perk.cost), [-0.12, 0.9, depth / 2 + 0.02], 0.22))
    this.point = spot.wall.clone().addScaledVector(spot.normal, depth + 0.05).setY(spot.stand.y + 1.3)
  }

  /** The panel pulses gently, like a vending machine's light. */
  update(dt: number) {
    this.time += dt
    const material = this.light.material as THREE.MeshBasicMaterial
    material.color.setHex(PERKS[this.kind].color).multiplyScalar(0.86 + 0.14 * Math.sin(this.time * 2.2))
  }

  dispose() {
    this.root.removeFromParent()
    // Its own panel, badge and lettering only: the ink drawing's materials are shared by the whole map.
    this.root.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return
      const material = o.material as THREE.MeshBasicMaterial
      if (o !== this.light && !material.map) return
      o.geometry.dispose(); material.map?.dispose(); material.dispose()
    })
  }
}

/**
 * Pack-a-Punch: a bulky press. Put a gun in, it works on it (shaking, light pouring out), then offers
 * the upgraded gun back for a few seconds.
 */
export class PackAPunch {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  state: 'idle' | 'working' | 'ready' = 'idle'
  timer = 0
  /** The gun inside, as it will come out. */
  held: import('../types').WeaponItem | null = null
  private press = new THREE.Group()
  private motes = new LightMotes(220, 0.07)
  private hue = 0

  constructor(readonly spot: WallSpot) {
    this.root.name = 'Pack-a-Punch'
    this.root.userData.noCollision = true
    const width = 1.5, depth = 0.9, height = 1.75
    this.root.position.copy(spot.wall.clone().addScaledVector(spot.normal, depth / 2 + 0.04).setY(spot.stand.y))
    this.root.rotation.y = facing(spot.normal)
    const body = new Draft('Pack-a-Punch body')
    body.box(width, 0.95, depth, 0, 0.475, 0, 'paper', 'edge')
    body.box(width * 0.9, 0.08, depth * 0.9, 0, 0.99, 0, 'paper', 'detail')
    for (const x of [-width / 2 + 0.12, width / 2 - 0.12]) body.box(0.12, height - 0.95, 0.12, x, 0.95 + (height - 0.95) / 2, -depth / 2 + 0.12, 'paper', 'detail')
    body.box(width, 0.14, 0.3, 0, height, -depth / 2 + 0.15, 'paper', 'edge')
    body.finish()
    this.root.add(body)
    // The press head that comes down on the gun.
    const head = new Draft('Pack-a-Punch press')
    head.box(width * 0.7, 0.18, depth * 0.55, 0, 0, 0, 'paper', 'edge')
    head.finish()
    this.press.add(head)
    this.press.position.set(0, 1.45, 0.05)
    this.root.add(this.press)
    this.root.add(wallText('PACK-A-PUNCH', [0, 0.7, depth / 2 + 0.02], 0.2))
    this.root.add(wallText(String(PACK.cost), [0, 0.42, depth / 2 + 0.02], 0.22))
    this.root.add(this.motes)
    this.point = spot.wall.clone().addScaledVector(spot.normal, depth + 0.1).setY(spot.stand.y + 1.2)
  }

  insert(item: import('../types').WeaponItem) {
    this.held = item
    this.state = 'working'
    this.timer = 0
  }

  take() {
    const item = this.held
    this.held = null
    this.state = 'idle'
    this.timer = 0
    return item
  }

  /** Returns 'done' when the gun is ready, 'expired' when it was never taken. */
  update(dt: number): 'done' | 'expired' | null {
    this.timer += dt
    this.hue = (this.hue + dt * 0.35) % 1
    const colour = new THREE.Color().setHSL(this.hue, 0.8, 0.55)
    let result: 'done' | 'expired' | null = null
    if (this.state === 'working') {
      // The press slams down and shakes; light pours out of the sides.
      const t = Math.min(1, this.timer / 0.4)
      this.press.position.y = 1.45 - 0.4 * t + (t >= 1 ? Math.sin(this.timer * 55) * 0.01 : 0)
      this.motes.update(dt, 140, p => p.set((Math.random() - 0.5) * 1.4, 1.0, (Math.random() - 0.5) * 0.8), colour, 1.6)
      if (this.timer >= PACK.work) { this.state = 'ready'; this.timer = 0; result = 'done' }
    } else if (this.state === 'ready') {
      this.press.position.y += (1.45 - this.press.position.y) * Math.min(1, dt * 6)
      this.motes.update(dt, 40, p => p.randomDirection().multiplyScalar(0.3).add(new THREE.Vector3(0, 1.25, 0.1)), colour, 0.5)
      if (this.timer >= PACK.wait) { this.state = 'idle'; result = 'expired' }
    } else {
      this.press.position.y += (1.45 - this.press.position.y) * Math.min(1, dt * 6)
      this.motes.update(dt, 6, p => p.set((Math.random() - 0.5) * 1.2, 1.05, (Math.random() - 0.5) * 0.7), colour, 0.35)
    }
    return result
  }

  dispose() {
    this.motes.dispose()
    this.root.removeFromParent()
  }
}

// ---------------------------------------------------------------- drinking

/** The first-person bottle: raised, tipped back, gone. Drawn in the perk's colour. */
export class PerkBottle {
  readonly root = new THREE.Group()
  private material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  private time = -1
  static readonly SECONDS = 1.5

  constructor(camera: THREE.Camera) {
    this.root.name = 'Perk bottle'
    this.root.userData.noCollision = true
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.038, 0.16, 18), this.material)
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.03, 0.07, 14), this.material)
    neck.position.y = 0.115
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0385, 0.0385, 0.06, 18), new THREE.MeshBasicMaterial({ color: 0xfbfaf5, toneMapped: false }))
    label.position.y = -0.01
    const outline = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.044, 0.17, 18), new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false }))
    this.root.add(body, neck, label, outline)
    this.root.visible = false
    camera.add(this.root)
  }

  get drinking() { return this.time >= 0 }

  drink(color: number) {
    this.material.color.setHex(color)
    this.time = 0
    this.root.visible = true
  }

  update(dt: number) {
    if (this.time < 0) return
    this.time += dt
    const t = this.time / PerkBottle.SECONDS
    if (t >= 1) { this.time = -1; this.root.visible = false; return }
    // Up from below, tipped back to the mouth, then away.
    const up = THREE.MathUtils.smoothstep(t, 0, 0.3), away = THREE.MathUtils.smoothstep(t, 0.8, 1)
    this.root.position.set(0.1 - 0.06 * up, -0.34 + 0.24 * up - 0.3 * away, -0.42 + 0.12 * up)
    this.root.rotation.set(-0.3 + 1.7 * THREE.MathUtils.smoothstep(t, 0.3, 0.55), 0, 0.2)
  }

  dispose() { this.root.removeFromParent(); this.root.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose() } }) }
}

// ---------------------------------------------------------------- the upgraded gun

/**
 * The Pack-a-Punch camo on the gun in your hands: its paper faces shimmer slowly through the colours,
 * which no rarity uses, and specks of light drift off the barrel.
 */
export class PackedLook {
  private model: THREE.Object3D | null = null
  private material: THREE.MeshBasicMaterial | null = null
  private motes = new LightMotes(60, 0.018)
  private time = 0

  update(dt: number, model: THREE.Object3D | null, packed: boolean) {
    const target = packed ? model : null
    if (target !== this.model) {
      this.motes.removeFromParent(); this.motes.reset()
      this.model = target
      if (target) {
        this.material ??= metal.clone()
        const camo = this.material
        target.traverse(object => { if (object instanceof THREE.Mesh && object.material === metal) object.material = camo })
        target.add(this.motes)
      }
    }
    if (!this.model || !this.material) return
    this.time += dt
    const hue = (this.time * 0.12) % 1
    this.material.color.setHSL(hue, 0.7, 0.74)
    this.motes.update(dt, 16, p => p.set((Math.random() - 0.5) * 0.05, 0.06 + Math.random() * 0.05, 0.1 + Math.random() * 0.45),
      new THREE.Color().setHSL((hue + 0.35) % 1, 0.9, 0.6), 0.22)
  }

  dispose() { this.motes.dispose(); this.material?.dispose() }
}
