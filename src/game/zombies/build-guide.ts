import * as THREE from 'three'
import { BUILDS, PARTS, type BuildId, type PartId } from './buildables'

/**
 * Guidance for the buildables (buildables.ts), so nobody walks about with every shield part wondering where
 * it goes: a toast for every part found ("Shield part 1/3: build it at the workbench") with the spot marked,
 * and, once the team holds every part a build still needs, a hint that stays on screen with an arrow and the
 * distance to the spot until it is built. The workbench and the Pack-a-Punch's outline glow while the team
 * holds one of their parts, and both are on the mini map.
 *
 * The text and the choice of hint are pure (checked in Node); BuildGuide draws the hint.
 */

/** Where each build goes, as a player would say it. */
export const BUILD_SPOT: Record<BuildId, string> = { power: 'the power switch', pack: 'its chalk outline', shield: 'the workbench' }
const NAME: Record<BuildId, string> = { power: 'Power', pack: 'Pack-a-Punch', shield: 'Shield' }

/** The toast for a part just found: which part of how many, and where it goes. */
export function partToast(part: PartId, got: number, total: number) {
  const build = PARTS[part].build
  if (build === 'power') return 'Power lever found: fit it on the power switch'
  return `${NAME[build]} part ${got}/${total}: build it at ${BUILD_SPOT[build]}`
}

/** How far along each build the team is: parts carried, parts already fitted. */
export type BuildState = {
  carried: readonly PartId[]
  placed: Partial<Record<BuildId, readonly PartId[]>>
  /** The power switch: lever missing, lever fitted, power on. */
  power: 'broken' | 'ready' | 'on'
  packBuilt: boolean
  /** A finished shield waits on the bench (and this player is not wearing one). */
  shieldWaiting: boolean
}

/** Parts of `build` the team has: carried or already fitted. */
export function partsGot(state: BuildState, build: BuildId) {
  const parts = BUILDS[build].parts
  return parts.filter(id => state.carried.includes(id) || (state.placed[build] ?? []).includes(id)).length
}

export type Guide = { build: BuildId; text: string; action: 'build' | 'take' }

/**
 * The hint that stays on screen: a build whose missing parts the team now carries, all of them (the shield
 * first, then the Pack-a-Punch, then the power lever); else a finished shield waiting to be taken; else none.
 */
export function buildGuide(state: BuildState): Guide | null {
  for (const build of ['shield', 'pack', 'power'] as const) {
    const parts = BUILDS[build].parts, placed = state.placed[build] ?? []
    const missing = parts.filter(id => !placed.includes(id))
    if (!missing.length) continue
    if (build === 'power' && state.power !== 'broken') continue
    if (build === 'pack' && state.packBuilt) continue
    if (missing.every(id => state.carried.includes(id))) {
      return { build, action: 'build', text: build === 'power' ? 'Fit the lever on the power switch' : `Build the ${BUILDS[build].label} at ${BUILD_SPOT[build]}` }
    }
  }
  if (state.shieldWaiting) return { build: 'shield', action: 'take', text: 'Take the ink shield from the workbench' }
  return null
}

/** Whether a build's spot should glow: the team holds at least one part it still needs. */
export const siteWanted = (state: BuildState, build: BuildId) =>
  BUILDS[build].parts.some(id => state.carried.includes(id) && !(state.placed[build] ?? []).includes(id))

const SHIELD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5.2 3.4 9.3 8 11 4.6-1.7 8-5.8 8-11V5z"/><path d="M12 6v12M7.5 10.5h9" class="cut"/></svg>'
const BUILD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 3.5a5 5 0 0 0-6 6.3L3 15.3 5.7 18l5.5-5.5a5 5 0 0 0 6.3-6l-3 3-2.4-.6-.6-2.4z"/></svg>'

/**
 * The hint on screen: a line under the round ("Build the ink shield at the workbench · 23 m") with an arrow
 * turned toward the spot, and a marker over the spot itself, seen through walls. `show(null)` hides both.
 */
export class BuildGuide {
  readonly element = document.createElement('div')
  private text = document.createElement('span')
  private distance = document.createElement('b')
  private arrow = document.createElement('i')
  private marker = document.createElement('div')
  private projected = new THREE.Vector3()
  private shown = ''

  constructor(parent: HTMLElement) {
    this.element.className = 'build-guide'
    this.element.setAttribute('role', 'status')
    this.element.hidden = true
    this.arrow.setAttribute('aria-hidden', 'true')
    this.arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3 20 20 12 15.5 4 20z"/></svg>'
    this.element.append(this.arrow, this.text, this.distance)
    this.marker.className = 'build-guide-marker'
    this.marker.hidden = true
    parent.append(this.element, this.marker)
  }

  /** Every frame: the hint (or null), where its spot is, and the camera to point from. */
  update(camera: THREE.PerspectiveCamera, guide: Guide | null, spot: THREE.Vector3 | null) {
    const on = !!guide && !!spot
    this.element.hidden = !on
    this.marker.hidden = !on
    if (!on) { this.shown = ''; return }
    if (guide!.text !== this.shown) {
      this.shown = guide!.text
      this.text.textContent = guide!.text
      this.marker.innerHTML = guide!.build === 'shield' ? SHIELD_ICON : BUILD_ICON
      this.element.dataset.build = guide!.build
    }
    const eye = camera.getWorldPosition(new THREE.Vector3())
    const metres = Math.round(eye.distanceTo(spot!))
    this.distance.textContent = `${metres} m`
    // The arrow: the spot's bearing from where you look, as a compass needle (up is straight ahead).
    const look = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y
    const bearing = Math.atan2(-(spot!.x - eye.x), -(spot!.z - eye.z)) - look
    this.arrow.style.transform = `rotate(${(-bearing).toFixed(3)}rad)`
    // The marker over the spot, pinned to the screen's edge when it is behind or off to a side.
    const p = this.projected.copy(spot!).setY(spot!.y + 0.9).project(camera)
    const behind = p.z > 1
    let x = p.x, y = p.y
    if (behind) { x = -x; y = -y }
    if (behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.85) { const k = 1 / Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.85, 1e-3); x *= k; y *= k }
    this.marker.style.transform = `translate(${((x + 1) / 2 * window.innerWidth).toFixed(1)}px, ${((1 - y) / 2 * window.innerHeight).toFixed(1)}px)`
    this.marker.hidden = metres < 3
  }

  dispose() { this.element.remove(); this.marker.remove() }
}
