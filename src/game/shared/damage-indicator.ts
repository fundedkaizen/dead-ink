import type * as THREE from 'three'

/**
 * Call of Duty style damage direction: a red arc around the crosshair pointing at where the shot came
 * from. The arc keeps pointing at the shooter as you turn, so you can spin until it sits at the top.
 */

/**
 * Screen bearing of a world point, in radians: 0 means straight ahead (the arc at the top of the ring),
 * positive clockwise, so +PI/2 is to your right and PI is behind you. `yaw` is the camera's rotation
 * about Y ('YXZ' order); at yaw 0 the camera looks down -Z.
 */
export function screenBearing(eye: { x: number; z: number }, yaw: number, source: { x: number; z: number }) {
  const dx = source.x - eye.x, dz = source.z - eye.z
  const forwardX = -Math.sin(yaw), forwardZ = -Math.cos(yaw)
  const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw)
  return Math.atan2(dx * rightX + dz * rightZ, dx * forwardX + dz * forwardZ)
}

type Arc = { element: HTMLElement; source: THREE.Vector3; age: number; strength: number }
const LIFETIME = 2.2, MERGE_DISTANCE = 4

export class DamageIndicator {
  readonly root = document.createElement('div')
  private arcs: Arc[] = []

  constructor(parent: HTMLElement) {
    this.root.className = 'hud-damage-ring'
    this.root.setAttribute('aria-hidden', 'true')
    parent.append(this.root)
  }

  /** A hit from `source`, a world position. Repeated hits from the same place refresh one arc. */
  hit(source: THREE.Vector3, amount: number) {
    const strength = Math.min(1, 0.45 + amount / 40)
    const existing = this.arcs.find(arc => arc.source.distanceTo(source) < MERGE_DISTANCE)
    if (existing) { existing.age = 0; existing.strength = Math.max(existing.strength, strength); existing.source.copy(source); return }
    const element = document.createElement('div')
    element.className = 'hud-damage-arc'
    // A 300 px square centred on the crosshair; the arc sits at its top (radius 140, about 44 degrees
    // wide) and the whole square rotates to the shooter's bearing.
    element.innerHTML = '<svg viewBox="-150 -150 300 300"><path d="M -52 -130 A 140 140 0 0 1 52 -130" /></svg>'
    this.root.append(element)
    this.arcs.push({ element, source: source.clone(), age: 0, strength })
  }

  update(dt: number, eye: THREE.Vector3, yaw: number) {
    for (const arc of this.arcs) {
      arc.age += dt
      const bearing = screenBearing(eye, yaw, arc.source)
      const fade = arc.age < LIFETIME * 0.55 ? 1 : Math.max(0, 1 - (arc.age - LIFETIME * 0.55) / (LIFETIME * 0.45))
      arc.element.style.transform = `rotate(${bearing}rad)`
      arc.element.style.opacity = String(fade * arc.strength)
    }
    for (const arc of this.arcs.filter(a => a.age >= LIFETIME)) arc.element.remove()
    this.arcs = this.arcs.filter(a => a.age < LIFETIME)
  }

  clear() { for (const arc of this.arcs) arc.element.remove(); this.arcs = [] }
  dispose() { this.clear(); this.root.remove() }
}
