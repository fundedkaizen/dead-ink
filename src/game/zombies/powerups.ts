import * as THREE from 'three'
import { createRarityBeam } from '../../render/ink'
import { shuffled, type Random } from '../shared/random'
import { POWERUPS, type PowerupKind } from './rules'

/**
 * Power-ups, Call of Duty style: a dead zombie sometimes leaves one behind, glowing green, and walking
 * into it takes it. Which one comes out of a shuffled bag, so every kind shows up before any repeats.
 */
export const POWERUP_INFO: Record<PowerupKind, { label: string; timed: boolean }> = {
  instaKill: { label: 'Insta-Kill', timed: true },
  doublePoints: { label: 'Double Points', timed: true },
  nuke: { label: 'Nuke', timed: false },
  maxAmmo: { label: 'Max Ammo', timed: false },
  deathMachine: { label: 'Death Machine', timed: true },
  carpenter: { label: 'Carpenter', timed: false },
}
/** Carpenter repairs barricades; it joins the bag when the map has some. */
export const DROPPED_KINDS: readonly PowerupKind[] = ['instaKill', 'doublePoints', 'nuke', 'maxAmmo', 'deathMachine']
/** Green means a power-up, as in Call of Duty. */
export const POWERUP_GREEN = 0x3fae49
/** Walk within this of a power-up to take it. */
export const PICKUP_RADIUS = 1.4

/**
 * When a kill drops one. A drop is guaranteed each time the points earned this game pass the next
 * mark; the gap to the following mark grows x1.14 per drop. Otherwise a small chance on any kill.
 * Never more than four a round.
 */
export class PowerupDropper {
  private increment: number = POWERUPS.firstThreshold
  private next: number = POWERUPS.firstThreshold
  private bag: PowerupKind[] = []
  dropsThisRound = 0

  constructor(private random: Random, private kinds: readonly PowerupKind[] = DROPPED_KINDS) {}

  newRound() { this.dropsThisRound = 0 }

  /** Call on each kill with every point earned so far this game. Returns the power-up it drops, if any. */
  onKill(earned: number): PowerupKind | null {
    if (this.dropsThisRound >= POWERUPS.maxPerRound) return null
    if (earned >= this.next) {
      this.increment *= POWERUPS.thresholdGrowth
      this.next = earned + this.increment
    } else if (this.random() >= POWERUPS.randomChance) return null
    this.dropsThisRound++
    if (!this.bag.length) this.bag = shuffled(this.random, [...this.kinds])
    return this.bag.pop()!
  }
}

// ---------------------------------------------------------------- icons

const ICON = 256
const icons = new Map<PowerupKind, HTMLCanvasElement>()

/** Bold ink glyphs on a soft green glow: the look of the floating drop and of the HUD timer. */
export function powerupIcon(kind: PowerupKind) {
  const cached = icons.get(kind)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ICON
  const c = canvas.getContext('2d')!
  const glow = c.createRadialGradient(128, 128, 30, 128, 128, 126)
  glow.addColorStop(0, 'rgba(63, 174, 73, 0.55)')
  glow.addColorStop(0.6, 'rgba(63, 174, 73, 0.25)')
  glow.addColorStop(1, 'rgba(63, 174, 73, 0)')
  c.fillStyle = glow
  c.fillRect(0, 0, ICON, ICON)
  c.fillStyle = c.strokeStyle = '#111'
  c.lineCap = c.lineJoin = 'round'
  const paper = '#fbfaf5'
  switch (kind) {
    case 'instaKill': {
      // Skull: dome, jaw, hollow eyes, nose, teeth.
      c.beginPath(); c.arc(128, 112, 62, Math.PI * 0.95, Math.PI * 2.05); c.lineTo(178, 150); c.lineTo(78, 150); c.closePath(); c.fill()
      c.fillRect(92, 146, 72, 40)
      c.fillStyle = paper
      c.beginPath(); c.ellipse(103, 118, 17, 20, 0, 0, Math.PI * 2); c.ellipse(153, 118, 17, 20, 0, 0, Math.PI * 2); c.fill()
      c.beginPath(); c.moveTo(128, 136); c.lineTo(120, 152); c.lineTo(136, 152); c.closePath(); c.fill()
      for (const x of [104, 120, 136, 152]) c.fillRect(x - 2, 166, 5, 20)
      break
    }
    case 'doublePoints': {
      c.font = 'bold 150px "Chalkboard SE", "Comic Sans MS", cursive'
      c.textAlign = 'center'; c.textBaseline = 'middle'
      c.lineWidth = 10; c.strokeStyle = paper; c.strokeText('x2', 128, 136)
      c.fillText('x2', 128, 136)
      break
    }
    case 'nuke': {
      // The trefoil: three blades around a hub.
      c.beginPath(); c.arc(128, 128, 16, 0, Math.PI * 2); c.fill()
      for (let i = 0; i < 3; i++) {
        const start = -Math.PI / 2 - Math.PI / 6 + i * Math.PI * 2 / 3
        c.beginPath(); c.arc(128, 128, 84, start, start + Math.PI / 3); c.arc(128, 128, 26, start + Math.PI / 3, start, true); c.closePath(); c.fill()
      }
      break
    }
    case 'maxAmmo': {
      // An ammunition crate with three rounds standing on it.
      c.fillRect(62, 132, 132, 64)
      c.fillStyle = paper; c.fillRect(74, 146, 108, 8); c.fillStyle = '#111'
      for (const x of [88, 128, 168]) {
        c.fillRect(x - 11, 88, 22, 40)
        c.beginPath(); c.moveTo(x - 11, 88); c.quadraticCurveTo(x, 50, x + 11, 88); c.fill()
      }
      break
    }
    case 'deathMachine': {
      // Minigun in profile: barrel bundle, housing, grip.
      c.fillRect(104, 104, 100, 10); c.fillRect(104, 120, 100, 10); c.fillRect(104, 136, 100, 10)
      c.fillRect(196, 98, 12, 54)
      c.fillRect(48, 94, 64, 64)
      c.fillRect(60, 72, 40, 10); c.fillRect(60, 72, 10, 26); c.fillRect(90, 72, 10, 26)
      c.save(); c.translate(70, 158); c.rotate(-0.2); c.fillRect(-12, 0, 24, 44); c.restore()
      break
    }
    case 'carpenter': {
      c.save(); c.translate(128, 128); c.rotate(-0.6)
      c.fillRect(-9, -20, 18, 110); c.fillRect(-46, -52, 92, 34)
      c.restore()
      break
    }
  }
  icons.set(kind, canvas)
  return canvas
}

// ---------------------------------------------------------------- drops in the world

type Drop = { kind: PowerupKind; root: THREE.Group; sprite: THREE.Sprite; age: number; base: THREE.Vector3 }
const textures = new Map<PowerupKind, THREE.CanvasTexture>()

export class PowerupDrops {
  private drops: Drop[] = []

  constructor(private scene: THREE.Scene) {}

  get count() { return this.drops.length }
  get active(): readonly { kind: PowerupKind; position: THREE.Vector3; age: number }[] {
    return this.drops.map(d => ({ kind: d.kind, position: d.base, age: d.age }))
  }

  spawn(kind: PowerupKind, feet: THREE.Vector3) {
    const root = new THREE.Group()
    root.name = `Power-up · ${POWERUP_INFO[kind].label}`
    root.userData.noCollision = true
    let texture = textures.get(kind)
    if (!texture) {
      texture = new THREE.CanvasTexture(powerupIcon(kind))
      texture.colorSpace = THREE.SRGBColorSpace
      textures.set(kind, texture)
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }))
    sprite.scale.setScalar(0.85)
    sprite.renderOrder = 11
    const beam = createRarityBeam(POWERUP_GREEN, 2.6)
    root.add(sprite, beam)
    root.position.copy(feet)
    this.scene.add(root)
    this.drops.push({ kind, root, sprite, age: 0, base: feet.clone() })
  }

  /** Bob, blink near the end, vanish when uncollected. Returns what the player at `feet` walked into. */
  update(dt: number, feet: THREE.Vector3 | null) {
    const taken: PowerupKind[] = []
    for (const drop of [...this.drops]) {
      drop.age += dt
      const left = POWERUPS.lifetime - drop.age
      drop.sprite.position.y = 1.05 + Math.sin(drop.age * 2.6) * 0.12
      drop.sprite.material.rotation = Math.sin(drop.age * 1.7) * 0.12
      // Blinks faster and faster through its last ten seconds, as in Call of Duty.
      drop.root.visible = left > 10 || Math.sin(drop.age * (left > 4 ? 12 : 26)) > -0.3
      const close = feet && Math.hypot(feet.x - drop.base.x, feet.z - drop.base.z) < PICKUP_RADIUS && Math.abs(feet.y - drop.base.y) < 2
      if (close) taken.push(drop.kind)
      if (close || left <= 0) this.remove(drop)
    }
    return taken
  }

  private remove(drop: Drop) {
    drop.root.removeFromParent()
    drop.sprite.material.dispose()
    drop.root.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() })
    this.drops.splice(this.drops.indexOf(drop), 1)
  }

  clear() { for (const drop of [...this.drops]) this.remove(drop) }
  dispose() { this.clear() }
}
