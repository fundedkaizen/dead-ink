import * as THREE from 'three'

/**
 * A quiet objective marker, as Call of Duty shows the power switch: a small icon over the spot, seen
 * through walls, pinned to the screen's edge with an arrow when it is behind you or off to a side, and
 * gone once you are standing at it.
 */
export class WorldMarker {
  readonly element = document.createElement('div')
  private arrow = document.createElement('i')
  private projected = new THREE.Vector3()

  constructor(parent: HTMLElement, icon: string, label: string, private near = 4) {
    this.element.className = 'world-marker'
    this.element.hidden = true
    this.element.setAttribute('aria-label', label)
    this.element.innerHTML = icon
    this.arrow.setAttribute('aria-hidden', 'true')
    this.element.append(this.arrow)
    parent.append(this.element)
  }

  /** `point` null hides it. */
  update(camera: THREE.PerspectiveCamera, point: THREE.Vector3 | null) {
    const show = !!point && camera.position.distanceTo(point) > this.near
    this.element.hidden = !show
    if (!show) return
    const p = this.projected.copy(point!).project(camera)
    const behind = p.z > 1
    let x = p.x, y = p.y
    if (behind) { x = -x; y = -y }
    const edge = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.85
    if (edge) {
      const scale = 1 / Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.85, 1e-3)
      x *= scale; y *= scale
    }
    this.element.style.transform = `translate(${((x + 1) / 2 * window.innerWidth).toFixed(1)}px, ${((1 - y) / 2 * window.innerHeight).toFixed(1)}px)`
    this.element.classList.toggle('edge', edge)
    this.arrow.style.transform = edge ? `rotate(${Math.atan2(-y, x).toFixed(3)}rad)` : ''
  }

  dispose() { this.element.remove() }
}

/** A small lightning bolt in ink with a paper rim, for the power switch. */
export const POWER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2 4 14h6l-2 8 10-12h-6z"/></svg>'
