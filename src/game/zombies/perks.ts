import * as THREE from 'three'
import { Draft, wallText } from '../../render/ink'
import { PRICES } from './rules'
import type { WallSpot } from './placement'
import { LightMotes, MuzzleSparks } from './effects'
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
export const PACK = { cost: PRICES.packAPunch, costs: [PRICES.packAPunch, 10000, 20000], work: 3.2, wait: 15 } as const

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
  /** Dark until the power is on; `flicker` counts down while it stutters into life. */
  powered = true
  private flicker = 0

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
    if (!this.powered) { material.color.setHex(0x3a3a3a); return }
    this.flicker = Math.max(0, this.flicker - dt)
    // Coming on: a few stutters, like a tube light catching.
    if (this.flicker > 0 && Math.sin(this.time * 47 + this.flicker * 13) > 0.1) { material.color.setHex(0x3a3a3a); return }
    material.color.setHex(PERKS[this.kind].color).multiplyScalar(0.86 + 0.14 * Math.sin(this.time * 2.2))
  }

  setPowered(on: boolean, flicker = true) {
    if (on && !this.powered && flicker) this.flicker = 0.9 + Math.random() * 0.5
    this.powered = on
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
 * Pack-a-Punch: the one machine on the map that should look like it matters. A riveted cabinet with a
 * glowing emblem, a roller tray, two steel pillars with hydraulic rams, a stamping press on a crossbeam,
 * a gear, a sign with shifting colours and a row of lights over it. Put a gun in: the press hammers it,
 * sparks fly, steam vents, light pours out; then it offers the gun back for a few seconds.
 */
export class PackAPunch {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  state: 'idle' | 'working' | 'ready' = 'idle'
  timer = 0
  /** The gun inside, as it will come out. */
  held: import('../types').WeaponItem | null = null
  private press = new THREE.Group()
  private gear = new THREE.Group()
  private motes = new LightMotes(260, 0.08)
  private steam = new LightMotes(90, 0.3)
  private sparks: MuzzleSparks
  private lights: THREE.Mesh[] = []
  private tinted: THREE.MeshBasicMaterial[] = []
  private spill: THREE.Mesh
  private hue = 0
  private lastPound = -1
  static readonly REST = 2.42

  constructor(readonly spot: WallSpot) {
    this.root.name = 'Pack-a-Punch'
    this.root.userData.noCollision = true
    const width = 2.0, depth = 1.1
    this.root.position.copy(spot.wall.clone().addScaledVector(spot.normal, depth / 2 + 0.05).setY(spot.stand.y))
    this.root.rotation.y = facing(spot.normal)
    const front = depth / 2
    const frame = new Draft('Pack-a-Punch frame')
    // The cabinet on its plinth, a panel with rivets, hazard stripes along the foot.
    frame.box(width + 0.1, 0.1, depth + 0.1, 0, 0.05, 0, 'concrete', 'detail')
    frame.box(width, 0.95, depth, 0, 0.575, 0, 'paper', 'edge')
    frame.line([[-0.88, 0.2, front + 0.004], [0.88, 0.2, front + 0.004], [0.88, 0.95, front + 0.004], [-0.88, 0.95, front + 0.004]], 'detail', true)
    for (let x = -0.84; x <= 0.85; x += 0.28) for (const y of [0.24, 0.91]) frame.box(0.035, 0.035, 0.02, x, y, front + 0.01, 'concrete', 'detail')
    for (let x = -0.98; x < 0.98; x += 0.13) frame.line([[x, 0.11, front + 0.004], [x + 0.1, 0.19, front + 0.004]], 'detail')
    for (const side of [-1, 1]) for (let y = 0.35; y <= 0.85; y += 0.1) frame.box(0.02, 0.035, depth * 0.6, side * (width / 2 + 0.01), y, 0, 'concrete', 'detail')
    // The tray and its rollers, where the gun goes in.
    frame.box(1.3, 0.07, 0.5, 0, 1.085, 0.2, 'concrete', 'edge')
    for (let z = 0.02; z <= 0.4; z += 0.095) frame.solid(new THREE.CylinderGeometry(0.035, 0.035, 1.2, 16), [0, 1.14, z], 'paper', 'detail', [0, 0, Math.PI / 2])
    // Steel pillars, braces and hydraulic rams, the crossbeam and the sign board.
    for (const side of [-1, 1]) {
      frame.box(0.24, 2.05, 0.3, side * 0.92, 2.06, -0.32, 'paper', 'edge')
      frame.beam([side * 0.92, 1.1, -0.15], [side * 0.62, 2.9, -0.34], 0.07, 'concrete', 'detail')
      frame.solid(new THREE.CylinderGeometry(0.075, 0.075, 1.1, 20), [side * 0.66, 1.75, -0.42], 'paper', 'detail')
      frame.solid(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 12), [side * 0.66, 2.55, -0.42], 'concrete', 'detail')
      frame.beam([side * 0.98, 0.6, -front + 0.05], [side * 0.98, 3.1, -front + 0.05], 0.09, 'paper', 'detail')
    }
    frame.box(2.3, 0.32, 0.55, 0, 3.1, -0.3, 'paper', 'edge')
    for (let x = -1.05; x <= 1.06; x += 0.3) frame.box(0.04, 0.04, 0.02, x, 3.1, -0.02, 'concrete', 'detail')
    frame.box(2.5, 0.66, 0.1, 0, 3.66, -0.36, 'paper', 'edge')
    frame.finish()
    this.root.add(frame)
    // The press head, which moves.
    const head = new Draft('Pack-a-Punch press head')
    head.box(1.35, 0.4, 0.72, 0, 0, 0, 'paper', 'edge')
    head.box(1.2, 0.08, 0.6, 0, -0.24, 0, 'concrete', 'detail')
    for (const x of [-0.45, 0.45]) head.solid(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 14), [x, 0.68, -0.05], 'concrete', 'detail')
    head.line([[-0.62, 0.12, 0.365], [0.62, 0.12, 0.365]], 'detail')
    head.line([[-0.62, -0.08, 0.365], [0.62, -0.08, 0.365]], 'detail')
    head.finish()
    this.press.add(head)
    this.press.position.set(0, PackAPunch.REST, 0.12)
    this.root.add(this.press)
    // A gear on the side of the press, turning while it works.
    const gear = new Draft('Pack-a-Punch gear')
    gear.solid(new THREE.TorusGeometry(0.22, 0.045, 10, 28), [0, 0, 0], 'paper', 'detail', [0, Math.PI / 2, 0])
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4
      gear.box(0.06, 0.1, 0.07, 0, Math.sin(a) * 0.27, Math.cos(a) * 0.27, 'concrete', 'detail', [a, 0, 0])
    }
    gear.box(0.05, 0.38, 0.05, 0, 0, 0, 'concrete', 'detail')
    gear.box(0.05, 0.05, 0.38, 0, 0, 0, 'concrete', 'detail')
    gear.finish()
    this.gear.add(gear)
    this.gear.position.set(0.72, 0, 0)
    this.press.add(this.gear)
    // Colour: the sign, the emblem, the lights and the light on the ground all shift together.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.5), this.tint(new THREE.MeshBasicMaterial({ map: signTexture(), transparent: true, depthWrite: false, toneMapped: false })))
    sign.position.set(0, 3.66, -0.3)
    const emblem = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), this.tint(new THREE.MeshBasicMaterial({ map: emblemTexture(), transparent: true, depthWrite: false, toneMapped: false })))
    emblem.position.set(0, 0.57, front + 0.012)
    this.root.add(sign, emblem)
    for (let i = 0; i < 7; i++) {
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), new THREE.MeshBasicMaterial({ toneMapped: false }))
      light.position.set(-0.9 + i * 0.3, 3.1, -0.01)
      this.lights.push(light)
      this.root.add(light)
    }
    this.spill = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 3.2), this.tint(new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })))
    this.spill.rotation.x = -Math.PI / 2
    this.spill.position.set(0, 0.012, 0.6)
    this.root.add(this.spill, this.motes, this.steam)
    this.sparks = new MuzzleSparks(this.root as unknown as THREE.Scene)
    this.point = spot.wall.clone().addScaledVector(spot.normal, depth + 0.15).setY(spot.stand.y + 1.2)
  }

  private tint(material: THREE.MeshBasicMaterial) { this.tinted.push(material); return material }

  insert(item: import('../types').WeaponItem) {
    this.held = item
    this.state = 'working'
    this.timer = 0
    this.lastPound = -1
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
    const working = this.state === 'working'
    this.hue = (this.hue + dt * (working ? 0.9 : 0.12)) % 1
    const colour = new THREE.Color().setHSL(this.hue, 0.85, 0.58)
    for (const material of this.tinted) material.color.copy(colour)
    this.lights.forEach((light, i) => {
      const flicker = working ? (Math.sin(this.timer * 20 + i * 1.7) > 0 ? 1 : 0.4) : 1
      ;(light.material as THREE.MeshBasicMaterial).color.setHSL((this.hue + i / 7) % 1, 0.9, 0.55 * flicker)
    })
    ;(this.spill.material as THREE.MeshBasicMaterial).opacity = working ? 0.95 : 0.6
    let result: 'done' | 'expired' | null = null
    if (working) {
      // The press hammers the gun six times, in step with the sound: sparks off every blow, steam out
      // of the vents, the gear turning, light pouring off the tray.
      const blow = Math.floor((this.timer - 0.3) / 0.45)
      const phase = ((this.timer - 0.3) % 0.45) / 0.45
      const down = this.timer > 0.3 && blow < 6 ? Math.max(0, 1 - phase * 3) : 0
      this.press.position.y = PackAPunch.REST - 0.95 * down - Math.min(1, this.timer / 0.3) * 0.2
      if (blow >= 0 && blow < 6 && blow !== this.lastPound && this.timer > 0.3) {
        this.lastPound = blow
        for (const x of [-0.4, 0, 0.4]) this.sparks.emit(new THREE.Vector3(x, 1.2, 0.3), new THREE.Vector3(x * 2, 0.6, 1), 5)
      }
      this.gear.rotation.x -= dt * 6
      this.motes.update(dt, 180, p => p.set((Math.random() - 0.5) * 1.3, 1.15, 0.2 + (Math.random() - 0.5) * 0.4), colour, 1.8)
      this.steam.update(dt, 22, p => p.set((Math.random() < 0.5 ? -1 : 1) * 1.02, 0.4 + Math.random() * 0.45, (Math.random() - 0.5) * 0.5), 0xd8d8d8, 0.9)
      if (this.timer >= PACK.work) { this.state = 'ready'; this.timer = 0; result = 'done' }
    } else {
      this.press.position.y += (PackAPunch.REST - this.press.position.y) * Math.min(1, dt * 5)
      this.gear.rotation.x -= dt * (this.state === 'ready' ? 1.5 : 0.3)
      if (this.state === 'ready') {
        this.motes.update(dt, 60, p => p.randomDirection().multiplyScalar(0.35).add(new THREE.Vector3(0, 1.4, 0.2)), colour, 0.5)
        if (this.timer >= PACK.wait) { this.state = 'idle'; result = 'expired' }
      } else this.motes.update(dt, 10, p => p.set((Math.random() - 0.5) * 1.3, 1.15, 0.2 + (Math.random() - 0.5) * 0.4), colour, 0.35)
      this.steam.update(dt, 0, p => p.set(0, 0, 0), 0xd8d8d8, 0.9)
    }
    this.sparks.update(dt)
    return result
  }

  dispose() {
    this.motes.dispose(); this.steam.dispose(); this.sparks.dispose()
    for (const material of this.tinted) { material.map?.dispose(); material.dispose() }
    for (const light of this.lights) { light.geometry.dispose(); (light.material as THREE.Material).dispose() }
    this.root.removeFromParent()
  }
}

/** "PACK-A-PUNCH" in white, heavy, outlined in ink; the material tints it. */
function signTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024; canvas.height = 224
  const c = canvas.getContext('2d')!
  // As large as fits the board with room for the glow.
  let size = 150
  do { c.font = `bold ${size}px "Chalkboard SE", "Comic Sans MS", cursive`; size -= 6 } while (c.measureText('PACK-A-PUNCH').width > 940 && size > 40)
  c.textAlign = 'center'; c.textBaseline = 'middle'
  c.shadowColor = 'rgba(255,255,255,0.9)'; c.shadowBlur = 22
  c.fillStyle = '#ffffff'; c.fillText('PACK-A-PUNCH', 512, 118)
  c.shadowBlur = 0; c.lineWidth = 6; c.strokeStyle = '#111'; c.strokeText('PACK-A-PUNCH', 512, 118)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** A fist-and-lightning emblem in a ring, white, for tinting. */
function emblemTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const c = canvas.getContext('2d')!
  c.shadowColor = 'rgba(255,255,255,0.9)'; c.shadowBlur = 16
  c.lineWidth = 16; c.strokeStyle = '#fff'
  c.beginPath(); c.arc(128, 128, 104, 0, Math.PI * 2); c.stroke()
  c.fillStyle = '#fff'
  c.beginPath(); c.moveTo(146, 34); c.lineTo(84, 138); c.lineTo(122, 138); c.lineTo(104, 222); c.lineTo(174, 112); c.lineTo(136, 112); c.closePath(); c.fill()
  c.shadowBlur = 0; c.lineWidth = 5; c.strokeStyle = '#111'; c.stroke()
  c.beginPath(); c.arc(128, 128, 114, 0, Math.PI * 2); c.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** A soft white oval for the light the machine throws on the ground. */
function glowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 96
  const c = canvas.getContext('2d')!
  const g = c.createRadialGradient(64, 48, 4, 64, 48, 62)
  g.addColorStop(0, 'rgba(255,255,255,0.6)'); g.addColorStop(0.5, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g; c.fillRect(0, 0, 128, 96)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// ---------------------------------------------------------------- drinking

/**
 * The contour of an old glass soda bottle, bottom to lip: a heel, a bulge, a waist, a second bulge,
 * the shoulder and a long neck. Radius and height in metres.
 */
const CONTOUR: readonly [number, number][] = [
  [0, 0], [0.027, 0], [0.03, 0.006], [0.031, 0.02], [0.0335, 0.045], [0.031, 0.068], [0.027, 0.083], [0.029, 0.098],
  [0.0325, 0.114], [0.031, 0.13], [0.025, 0.145], [0.017, 0.16], [0.0125, 0.175], [0.0112, 0.19], [0.0128, 0.194], [0.0128, 0.2], [0.0095, 0.2],
]
const contour = (grow: number, top = 1) => CONTOUR.filter(([, y]) => y <= 0.2 * top + 1e-6).map(([r, y]) => new THREE.Vector2(Math.max(0, r + (r > 0 ? grow : 0)), y))

/** The first-person bottle, an old glass contour bottle with the perk inside: raised, drunk, gone. */
export class PerkBottle {
  readonly root = new THREE.Group()
  private liquid: THREE.Mesh
  private liquidMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.94, depthWrite: false, toneMapped: false })
  private labelTexture: THREE.CanvasTexture | null = null
  private label: THREE.Mesh
  private time = -1
  static readonly SECONDS = 1.6

  constructor(camera: THREE.Camera) {
    this.root.name = 'Perk bottle'
    this.root.userData.noCollision = true
    const glass = new THREE.Mesh(new THREE.LatheGeometry(contour(0), 36),
      new THREE.MeshBasicMaterial({ color: 0xcfe7d8, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }))
    glass.renderOrder = 3
    // The drink, inside the glass, up to the shoulder; it drains from the top as you drink.
    const inner = CONTOUR.filter(([, y]) => y > 0.003 && y <= 0.15).map(([r, y]) => new THREE.Vector2(r * 0.84, y - 0.003))
    this.liquid = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(0, 0), ...inner, new THREE.Vector2(0, inner[inner.length - 1].y)], 30), this.liquidMaterial)
    this.liquid.position.y = 0.003
    this.liquid.renderOrder = 2
    // A white glint running down one side of the glass.
    const glint = new THREE.Mesh(new THREE.LatheGeometry(contour(0.0006).slice(2, -3), 4, 0.5, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }))
    glint.renderOrder = 4
    // An ink outline around the whole bottle, like everything else in the world.
    const outline = new THREE.Mesh(new THREE.LatheGeometry(contour(0.0022), 36), new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false }))
    // The far wall of the glass, solid and pale green, just inside the outline: seen through the front
    // glass it hides the black outline (which made the whole bottle read grey), leaving an ink rim.
    const back = new THREE.Mesh(new THREE.LatheGeometry(contour(0.0004), 36), new THREE.MeshBasicMaterial({ color: 0xdcefe3, side: THREE.BackSide, toneMapped: false }))
    // A paper label round the waist, with the perk's name.
    this.label = new THREE.Mesh(new THREE.CylinderGeometry(0.0283, 0.0283, 0.026, 30, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }))
    this.label.position.y = 0.083
    this.label.renderOrder = 5
    this.root.add(outline, back, this.liquid, glass, glint, this.label)
    this.root.visible = false
    camera.add(this.root)
  }

  get drinking() { return this.time >= 0 }

  drink(kind: PerkKind) {
    const perk = PERKS[kind]
    this.liquidMaterial.color.setHex(perk.color)
    this.labelTexture?.dispose()
    this.labelTexture = labelTexture(perk.name, perk.css)
    const material = this.label.material as THREE.MeshBasicMaterial
    material.map = this.labelTexture; material.needsUpdate = true
    this.time = 0
    this.root.visible = true
  }

  update(dt: number) {
    if (this.time < 0) return
    this.time += dt
    const t = this.time / PerkBottle.SECONDS
    if (t >= 1) { this.time = -1; this.root.visible = false; return }
    // Up from below the view, tipped back to the mouth, drained, then away.
    const up = THREE.MathUtils.smoothstep(t, 0, 0.28), tip = THREE.MathUtils.smoothstep(t, 0.28, 0.5), away = THREE.MathUtils.smoothstep(t, 0.82, 1)
    this.root.position.set(0.11 - 0.08 * tip, -0.36 + 0.24 * up + 0.07 * tip - 0.34 * away, -0.4 + 0.16 * tip)
    this.root.rotation.set(-0.15 + 2.05 * tip - 1.2 * away, 0, 0.25 - 0.2 * tip)
    this.liquid.scale.y = 1 - 0.85 * THREE.MathUtils.smoothstep(t, 0.42, 0.8)
  }

  dispose() {
    this.root.removeFromParent()
    this.labelTexture?.dispose()
    this.root.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose() } })
  }
}

/** The bottle's label: paper, the perk's name twice round in ink, a band of its colour. */
function labelTexture(name: string, css: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 64
  const c = canvas.getContext('2d')!
  c.fillStyle = '#fbfaf5'; c.fillRect(0, 0, 512, 64)
  c.fillStyle = css; c.fillRect(0, 0, 512, 9); c.fillRect(0, 55, 512, 9)
  c.fillStyle = '#111'; c.font = 'italic bold 34px "Chalkboard SE", "Comic Sans MS", cursive'
  c.textAlign = 'center'; c.textBaseline = 'middle'
  for (const x of [128, 384]) c.fillText(name, x, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// ---------------------------------------------------------------- the upgraded gun

/**
 * The Pack-a-Punch camo on the gun in your hands: its paper faces shimmer slowly through the colours,
 * which no rarity uses. (Motes drifting off the barrel were too busy in play.)
 */
export class PackedLook {
  private model: THREE.Object3D | null = null
  private material: THREE.MeshBasicMaterial | null = null
  private motes = new LightMotes(60, 0.018)
  private time = 0

  /** `level`: 0 not upgraded; 1 a slow shimmer; 2 faster and gold-bright; 3 deep, saturated and quick. */
  update(dt: number, model: THREE.Object3D | null, level: number) {
    const target = level > 0 ? model : null
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
    const look = [[0.12, 0.7, 0.74], [0.3, 0.85, 0.66], [0.55, 1, 0.52]][Math.min(3, level) - 1]
    const hue = (this.time * look[0]) % 1
    this.material.color.setHSL(hue, look[1], look[2])
    this.motes.update(dt, 0, p => p.set(0, 0, 0), 0xffffff, 0)
  }

  dispose() { this.motes.dispose(); this.material?.dispose() }
}
