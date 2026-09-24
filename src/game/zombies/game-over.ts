import * as THREE from 'three'
import type { CollisionWorld } from '../../player/collision'

/**
 * Call of Duty Zombies' game over. After your fall the screen sinks into ink; it opens on a slow flight
 * over the map, the horde still shambling about below, under GAME OVER and the rounds you survived, while
 * the requiem plays. The scores come up a few seconds later and the flight goes on behind them.
 *
 * Timing (seconds from the game ending): the fall plays until `fade`, the ink is total at `black`, clear
 * again at `clear`; the title from `title`; the scores at `menu`. The flight runs at `speed` metres a second,
 * at least `height` up and `clearance` above whatever is below, looking `ahead` metres along its way.
 */
export const GAME_OVER = { fade: 1.5, black: 2.1, clear: 2.9, title: 2.5, menu: 8, speed: 6, height: 18, clearance: 9, ahead: 34, step: 8 } as const

export class GameOverFlight {
  readonly root = document.createElement('div')
  active = false
  elapsed = 0
  private ink = document.createElement('div')
  private subtitle = document.createElement('span')
  private path: THREE.CatmullRomCurve3 | null = null
  private length = 1
  private travelled = 0
  private point = new THREE.Vector3()
  private ahead = new THREE.Vector3()

  constructor(parent: HTMLElement) {
    this.root.className = 'dead-ink-over'
    this.root.hidden = true
    this.root.setAttribute('role', 'status')
    this.ink.className = 'dead-ink-over-ink'
    const title = document.createElement('div')
    title.className = 'dead-ink-over-title'
    const heading = document.createElement('strong')
    heading.textContent = 'GAME OVER'
    title.append(heading, this.subtitle)
    this.root.append(this.ink, title)
    parent.append(this.root)
  }

  /** The game ended: plan the flight (from above where you fell, round every stop) and set the words. */
  begin(from: THREE.Vector3, stops: readonly THREE.Vector3[], rounds: number, world: CollisionWorld) {
    // A loop round the stops in order of their bearing from the middle, starting over where you fell.
    const middle = stops.reduce((sum, stop) => sum.add(stop), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, stops.length))
    const bearing = (p: THREE.Vector3) => Math.atan2(p.z - middle.z, p.x - middle.x)
    const start = bearing(from)
    const ordered = [...stops].sort((a, b) => ((bearing(a) - start + Math.PI * 4) % (Math.PI * 2)) - ((bearing(b) - start + Math.PI * 4) % (Math.PI * 2)))
    const corners = [from, ...ordered]
    // Waypoints every few metres along the loop, each lifted clear of whatever stands below it, so the
    // flight follows the roofs rather than cutting through a water tower.
    const points: THREE.Vector3[] = []
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length]
      const steps = Math.max(1, Math.ceil(a.distanceTo(b) / GAME_OVER.step))
      for (let s = 0; s < steps; s++) points.push(this.lift(a.clone().lerp(b, s / steps), world))
    }
    // Smooth the heights so the camera glides over a roof instead of hopping onto it.
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < points.length; i++) {
      const before = points[(i - 1 + points.length) % points.length].y, after = points[(i + 1) % points.length].y
      points[i].y = Math.max(points[i].y, (before + after) / 2 - 1)
    }
    this.path = points.length >= 2 ? new THREE.CatmullRomCurve3(points, true, 'centripetal') : null
    this.length = Math.max(1, this.path?.getLength() ?? 1)
    this.travelled = 0
    this.elapsed = 0
    this.active = true
    this.subtitle.textContent = rounds === 1 ? 'You survived 1 round' : `You survived ${rounds} rounds`
    this.root.hidden = false
    this.root.classList.remove('titled')
    this.ink.style.opacity = '0'
  }

  /** High enough over this spot: above the flight height, and well clear of whatever is below. */
  private lift(at: THREE.Vector3, world: CollisionWorld) {
    const top = world.floor(new THREE.Vector3(at.x, 80, at.z), 0, 140)
    return new THREE.Vector3(at.x, Math.max(GAME_OVER.height, (Number.isFinite(top) ? top : 0) + GAME_OVER.clearance), at.z)
  }

  /** The camera has left the fall and is flying. */
  get flying() { return this.active && this.elapsed >= GAME_OVER.black }
  /** The scores are up. */
  get menuVisible() { return this.active && this.elapsed >= GAME_OVER.menu }
  get menuOpacity() { return this.active ? THREE.MathUtils.smoothstep(this.elapsed, GAME_OVER.menu, GAME_OVER.menu + 0.6) : 0 }

  /** Advance the ink, the words and the flight; moves the camera once the screen has gone black. */
  update(dt: number, camera: THREE.PerspectiveCamera, reducedMotion: boolean) {
    if (!this.active) return
    this.elapsed += dt
    const t = this.elapsed
    const ink = t < GAME_OVER.black ? THREE.MathUtils.smoothstep(t, GAME_OVER.fade, GAME_OVER.black) : 1 - THREE.MathUtils.smoothstep(t, GAME_OVER.black, GAME_OVER.clear)
    this.ink.style.opacity = ink.toFixed(3)
    if (t >= GAME_OVER.title && !this.root.classList.contains('titled')) this.root.classList.add('titled')
    if (!this.flying || !this.path) return
    // With reduced motion the camera holds one high view instead of flying.
    if (!reducedMotion || this.travelled === 0) this.travelled = (this.travelled + dt * GAME_OVER.speed) % this.length
    const u = this.travelled / this.length
    this.path.getPointAt(u, this.point)
    this.path.getPointAt((u + GAME_OVER.ahead / this.length) % 1, this.ahead)
    // Looking along the way and down at the ground ahead.
    this.ahead.y = Math.max(0, this.ahead.y - GAME_OVER.height - 4)
    camera.position.copy(this.point)
    camera.lookAt(this.ahead)
    camera.updateMatrixWorld()
  }

  end() {
    this.active = false
    this.elapsed = 0
    this.root.hidden = true
    this.root.classList.remove('titled')
  }

  dispose() { this.root.remove() }
}
