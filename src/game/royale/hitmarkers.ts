import * as THREE from 'three'

/**
 * Modern Warfare style hit feedback: an X flashes over the crosshair on every hit and turns red on a
 * kill, and the damage dealt floats up off the target. Headshot numbers are gold.
 *
 * Shotgun pellets that land on the same target within a moment are summed into one number, the way
 * Fortnite shows a shotgun hit, instead of eight small ones.
 */
type Floating = { element: HTMLElement; point: THREE.Vector3; age: number; damage: number; targetId: string; head: boolean; kill: boolean }

const LIFETIME = 0.9, MERGE_WINDOW = 0.09, MARKER_TIME = 0.16, KILL_MARKER_TIME = 0.34

export class HitMarkers {
  readonly root = document.createElement('div')
  private marker = document.createElement('div')
  private floating: Floating[] = []
  private markerTime = 0
  private projected = new THREE.Vector3()

  constructor(parent: HTMLElement) {
    this.root.className = 'royale-hits'
    this.root.setAttribute('aria-hidden', 'true')
    this.marker.className = 'royale-hitmarker'
    this.marker.innerHTML = '<i></i><i></i><i></i><i></i>'
    this.root.append(this.marker)
    parent.append(this.root)
  }

  hit(point: THREE.Vector3, damage: number, targetId: string, head: boolean, kill: boolean) {
    if (!(damage > 0)) return
    this.markerTime = kill ? KILL_MARKER_TIME : Math.max(this.markerTime, MARKER_TIME)
    this.marker.classList.toggle('kill', kill || (this.marker.classList.contains('kill') && this.markerTime > MARKER_TIME))
    this.marker.classList.add('show')
    const recent = this.floating.find(f => f.targetId === targetId && f.age < MERGE_WINDOW)
    if (recent) {
      recent.damage += damage; recent.head ||= head; recent.kill ||= kill
      this.paint(recent)
      return
    }
    const element = document.createElement('span')
    element.className = 'royale-damage'
    this.root.append(element)
    const entry: Floating = { element, point: point.clone(), age: 0, damage, targetId, head, kill }
    this.paint(entry)
    this.floating.push(entry)
  }

  private paint(entry: Floating) {
    entry.element.textContent = String(Math.round(entry.damage))
    entry.element.classList.toggle('head', entry.head)
    entry.element.classList.toggle('kill', entry.kill)
  }

  update(dt: number, camera: THREE.Camera, width: number, height: number) {
    this.markerTime -= dt
    if (this.markerTime <= 0) this.marker.classList.remove('show', 'kill')
    for (const entry of this.floating) {
      entry.age += dt
      // Drift upward in the world so the number rises off the body it hit.
      this.projected.copy(entry.point).setY(entry.point.y + 0.35 + entry.age * 0.9).project(camera)
      const behind = this.projected.z > 1
      const k = entry.age / LIFETIME
      entry.element.style.opacity = behind ? '0' : String(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3)
      entry.element.style.transform = `translate(${(this.projected.x * 0.5 + 0.5) * width}px, ${(-this.projected.y * 0.5 + 0.5) * height}px) translate(-50%, -50%) scale(${entry.age < 0.08 ? 1.35 - entry.age * 4 : 1})`
    }
    for (const entry of this.floating.filter(f => f.age >= LIFETIME)) entry.element.remove()
    this.floating = this.floating.filter(f => f.age < LIFETIME)
  }

  clear() {
    for (const entry of this.floating) entry.element.remove()
    this.floating = []
    this.markerTime = 0
    this.marker.classList.remove('show', 'kill')
  }

  dispose() { this.clear(); this.root.remove() }
}
