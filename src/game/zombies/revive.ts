import * as THREE from 'three'

/**
 * Second Draft getting you back up: you go down hard, the world drains to grey and swims while you lie
 * there, then you haul yourself up as the colour floods back, blue for the perk. You cannot move or shoot
 * while you are down (the zombies around you have been shoved back and you cannot be hurt).
 */
export const REVIVE = { seconds: 2.4, fall: 0.35, rise: 1.45, drop: 1.05, roll: 0.5, pitch: 0.28 } as const
/**
 * Co-op's last stand, down and waiting for a teammate: low on one elbow, a slight lean, the hard tilt
 * only while you fall; you look and aim freely. Crawling rocks the view with each pull.
 */
export const LAST_STAND_VIEW = { drop: 1.02, roll: 0.1, fallRoll: 0.45, settle: 0.45, breathe: 0.012, bob: 0.045, sway: 0.035 } as const

export class SecondDraftRevive {
  private time = -1
  private applied: { camera: THREE.Camera; drop: number; turn: THREE.Euler; base: THREE.Quaternion; shown: THREE.Quaternion } | null = null

  get active() { return this.time >= 0 }
  /** Still on the floor: no moving, no shooting. */
  get down() { return this.time >= 0 && this.time < REVIVE.rise }

  /** Held on the floor (co-op: downed, waiting for a teammate) until release(). */
  private held = false
  /** The co-op last stand's view (holdDown) rather than Second Draft's tumble (start). */
  private lastStand = false
  /** Seconds on the floor, for breathing and the crawl, which keep moving while the fall's clock is held. */
  private floor = 0
  private crawlPhase = 0
  /** How fast you are crawling (m/s), set each frame while down. */
  crawl = 0

  start() { this.time = 0; this.held = false; this.lastStand = false }

  /** Go down and stay down: the fall plays, then the view waits on the floor. */
  holdDown() { if (this.time < 0 || this.time >= REVIVE.rise) { this.time = 0; this.floor = 0 } this.held = true; this.lastStand = true }
  /** Get back up from holdDown(). */
  release() { if (this.held) { this.held = false; this.time = Math.max(this.time, REVIVE.rise - 0.01) } }
  get holding() { return this.held }
  /** Down in the last stand and done falling: free to crawl and shoot. */
  get settled() { return this.held && this.lastStand && this.time >= REVIVE.fall }

  update(dt: number) {
    if (this.time < 0) return
    this.time += dt
    this.floor += dt
    this.crawlPhase += dt * this.crawl * 7
    if (this.held) this.time = Math.min(this.time, REVIVE.rise - 0.02)
    if (this.time >= REVIVE.seconds) this.time = -1
  }

  /** Lower and tip the view for this frame; removeCamera() puts it back after the frame is drawn. */
  applyCamera(camera: THREE.Camera, reducedMotion: boolean) {
    this.removeCamera()
    if (this.time < 0) return
    const t = this.time
    const low = THREE.MathUtils.smoothstep(t, 0, REVIVE.fall) * (1 - THREE.MathUtils.smoothstep(t, REVIVE.rise, REVIVE.seconds))
    if (low <= 0) return
    const base = camera.quaternion.clone(), euler = new THREE.Euler().setFromQuaternion(base, 'YXZ')
    let pitch: number, roll: number, drop: number
    if (this.lastStand) {
      const v = LAST_STAND_VIEW, calm = reducedMotion ? 0 : 1
      // The fall's hard tilt eases into a slight lean on the elbow.
      const falling = 1 - THREE.MathUtils.smoothstep(t, REVIVE.fall, REVIVE.fall + v.settle)
      const breathe = Math.sin(this.floor * 2.2) * v.breathe * calm
      // Each pull of a crawl lifts and rocks the view a little.
      const pull = this.crawl > 0.2 ? Math.abs(Math.sin(this.crawlPhase)) : 0
      pitch = 0
      roll = (v.roll + v.fallRoll * falling * calm + breathe + Math.sin(this.crawlPhase) * v.sway * calm * Math.min(1, this.crawl)) * low
      drop = v.drop * low - pull * v.bob * calm * low
    } else {
      // A little sway on the floor, as if catching your breath.
      const sway = reducedMotion ? 0 : Math.sin(t * 5.5) * 0.04 * low
      pitch = THREE.MathUtils.clamp(euler.x + REVIVE.pitch * low, -1.5, 1.5) - euler.x
      roll = (reducedMotion ? 0 : REVIVE.roll) * low + sway
      drop = REVIVE.drop * low
    }
    camera.position.y -= drop
    euler.set(euler.x + pitch, euler.y, euler.z + roll, 'YXZ')
    camera.quaternion.setFromEuler(euler)
    camera.updateMatrixWorld(true)
    this.applied = { camera, drop, turn: new THREE.Euler(pitch, 0, roll), base, shown: camera.quaternion.clone() }
  }

  removeCamera() {
    if (!this.applied) return
    const { camera, drop, turn, base, shown } = this.applied
    camera.position.y += drop
    // Untouched since: put it back exactly. Changed during the frame (recoil climb, a shake): take off
    // only what the fall added and keep the rest.
    if (camera.quaternion.equals(shown)) camera.quaternion.copy(base)
    else {
      const current = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
      current.set(THREE.MathUtils.clamp(current.x - turn.x, -1.5, 1.5), current.y, current.z - turn.z, 'YXZ')
      camera.quaternion.setFromEuler(current)
    }
    camera.updateMatrixWorld(true)
    this.applied = null
  }

  reset() { this.removeCamera(); this.time = -1; this.held = false; this.lastStand = false; this.crawl = 0 }
}
