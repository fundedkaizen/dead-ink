import * as THREE from 'three'
import { RESCUE_LAYOUT } from './rescue-layout'

export const ESCAPE_TIMING = { departure: 0.08, drive: 1.8, fade: 1.4, black: 1.85, menu: 2.05, end: 2.4 } as const
const smooth = THREE.MathUtils.smoothstep
const ACCELERATION = 0.4
const UP = new THREE.Vector3(0, 1, 0)

/** A stationary exterior shot; one clock owns vehicle travel, fade and menu reveal. */
export class EscapeCinematic {
  active = false
  elapsed = 0
  readonly position = new THREE.Vector3(...RESCUE_LAYOUT.escapeRoute[0])
  readonly rotation = new THREE.Quaternion()
  yaw = 0
  steering = 0
  private route = RESCUE_LAYOUT.escapeRoute.map(point => new THREE.Vector3(...point))
  length = this.route.slice(1).reduce((sum, point, i) => sum + point.distanceTo(this.route[i]), 0)
  private readonly cameraTarget = new THREE.Vector3(164, 0.8, 11)
  private readonly cameraOffset = new THREE.Vector3(-6, 5.6, 14)
  /** The clock's marks: the jeep's by default; a helicopter lifts off more slowly (configure()). */
  timing: { departure: number; drive: number; fade: number; black: number; menu: number; end: number } = { ...ESCAPE_TIMING }
  /** A helicopter or boat: travel follows the route itself, heading along it, with no road curve. */
  private flying = false
  private heading = 0

  /**
   * The rescue campaign's way out: any vehicle along `route`, watched from `target` + `offset`. `heading`: the
   * vehicle's yaw while it waits (the route's own direction takes over as it moves).
   */
  configure(route: readonly (readonly number[])[], target: readonly number[], offset: readonly number[], flying: boolean, heading = 0) {
    this.route = route.map(point => new THREE.Vector3(point[0], point[1], point[2]))
    this.length = this.route.slice(1).reduce((sum, point, i) => sum + point.distanceTo(this.route[i]), 0)
    this.cameraTarget.set(target[0], target[1], target[2])
    this.cameraOffset.set(offset[0], offset[1], offset[2])
    this.flying = flying
    this.heading = heading
    this.timing = flying ? { departure: 0.4, drive: 3.6, fade: 3.1, black: 3.6, menu: 3.8, end: 4.2 } : { ...ESCAPE_TIMING }
    this.position.copy(this.route[0])
  }
  private readonly originalPosition = new THREE.Vector3()
  private readonly originalRotation = new THREE.Quaternion()
  private originalFov = 75

  get progress() {
    const t = THREE.MathUtils.clamp((this.elapsed - this.timing.departure) / this.timing.drive, 0, 1)
    const ramp = t / ACCELERATION
    // Integrate a smooth velocity ramp so acceleration has no abrupt start/end.
    const distance = t < ACCELERATION ? ACCELERATION * (ramp ** 3 - ramp ** 4 / 2) : t - ACCELERATION / 2
    return this.length * distance / (1 - ACCELERATION / 2)
  }
  get speed() {
    const t = (this.elapsed - this.timing.departure) / this.timing.drive
    if (t <= 0 || t >= 1) return 0
    return this.length / (this.timing.drive * (1 - ACCELERATION / 2)) * smooth(t / ACCELERATION, 0, 1)
  }
  get crossedGate() { return this.progress >= this.length - 1e-6 }
  get fade() { return smooth(this.elapsed, this.timing.fade, this.timing.black) }
  get menuVisible() { return this.active && this.elapsed >= this.timing.menu }
  get menuOpacity() { return smooth(this.elapsed, this.timing.menu, this.timing.end) }
  get running() { return this.active && this.elapsed < this.timing.end }

  begin(camera: THREE.PerspectiveCamera) {
    this.originalPosition.copy(camera.position); this.originalRotation.copy(camera.quaternion); this.originalFov = camera.fov
    this.elapsed = 0; this.active = true
    this.position.copy(this.route[0])
    this.rotation.identity(); this.yaw = this.steering = 0
    if (this.flying) { this.yaw = this.heading; this.rotation.setFromAxisAngle(UP, this.yaw) }
    this.applyCamera(camera)
  }

  update(dt: number) {
    if (!this.active) return
    this.elapsed = Math.min(this.timing.end, this.elapsed + Math.max(0, dt))
    let remaining = this.progress
    for (let i = 1; i < this.route.length; i++) {
      const distance = this.route[i - 1].distanceTo(this.route[i])
      this.position.copy(this.route[i - 1]).lerp(this.route[i], Math.min(1, remaining / distance))
      if (remaining <= distance) break
      remaining -= distance
    }
    // Follow one shallow road curve. Body heading follows the travel tangent,
    // and wheel steering follows its curvature instead of yawing sideways.
    const s = this.progress / this.length
    if (this.flying) {
      // Lift, then away along the route: the nose follows the level direction of travel.
      let rest = this.progress, heading = this.heading
      for (let i = 1; i < this.route.length; i++) {
        const leg = this.route[i].clone().sub(this.route[i - 1])
        if (Math.hypot(leg.x, leg.z) > 0.5) heading = Math.atan2(leg.x, leg.z)
        if (rest <= leg.length()) break
        rest -= leg.length()
      }
      this.yaw = heading; this.steering = 0
      this.rotation.setFromAxisAngle(UP, this.yaw)
      return
    }
    if (s > 0 && s < 1) {
      const curve = Math.sin(Math.PI * s)
      const slope = -1.65 * Math.PI * curve ** 2 * Math.cos(Math.PI * s) / this.length
      const curvature = -1.65 * Math.PI ** 2 * (2 * curve * Math.cos(Math.PI * s) ** 2 - curve ** 3)
        / (this.length ** 2 * (1 + slope ** 2) ** 1.5)
      this.position.z -= 0.55 * curve ** 3
      this.yaw = -Math.atan(slope)
      this.steering = -Math.atan(3.2 * curvature)
    } else this.yaw = this.steering = 0
    this.rotation.setFromAxisAngle(UP, this.yaw)
  }

  applyCamera(camera: THREE.PerspectiveCamera) {
    // Fit the exit in portrait too. The stationary camera also avoids extra
    // motion for reduced-motion players: only the jeep moves, then a plain fade.
    camera.position.copy(this.cameraTarget).addScaledVector(this.cameraOffset, Math.max(1, 1.5 / camera.aspect))
    camera.lookAt(this.cameraTarget)
    if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix() }
  }

  reset(camera: THREE.PerspectiveCamera) {
    if (this.active) {
      camera.position.copy(this.originalPosition); camera.quaternion.copy(this.originalRotation)
      camera.fov = this.originalFov; camera.updateProjectionMatrix()
    }
    this.active = false; this.elapsed = 0; this.position.copy(this.route[0])
    this.rotation.identity(); this.yaw = this.steering = 0
  }
}
