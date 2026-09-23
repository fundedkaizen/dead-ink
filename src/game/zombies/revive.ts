import * as THREE from 'three'

/**
 * Second Draft getting you back up: you go down hard, the world drains to grey and swims while you lie
 * there, then you haul yourself up as the colour floods back, blue for the perk. You cannot move or shoot
 * while you are down (the zombies around you have been shoved back and you cannot be hurt).
 */
export const REVIVE = { seconds: 2.4, fall: 0.35, rise: 1.45, drop: 1.05, roll: 0.5, pitch: 0.28 } as const

export class SecondDraftRevive {
  private time = -1
  private applied: { camera: THREE.Camera; drop: number; turn: THREE.Euler; base: THREE.Quaternion; shown: THREE.Quaternion } | null = null

  get active() { return this.time >= 0 }
  /** Still on the floor: no moving, no shooting. */
  get down() { return this.time >= 0 && this.time < REVIVE.rise }

  start() { this.time = 0 }

  update(dt: number) {
    if (this.time < 0) return
    this.time += dt
    if (this.time >= REVIVE.seconds) this.time = -1
  }

  /** Lower and tip the view for this frame; removeCamera() puts it back after the frame is drawn. */
  applyCamera(camera: THREE.Camera, reducedMotion: boolean) {
    this.removeCamera()
    if (this.time < 0) return
    const t = this.time
    const low = THREE.MathUtils.smoothstep(t, 0, REVIVE.fall) * (1 - THREE.MathUtils.smoothstep(t, REVIVE.rise, REVIVE.seconds))
    if (low <= 0) return
    // A little sway on the floor, as if catching your breath.
    const sway = reducedMotion ? 0 : Math.sin(t * 5.5) * 0.04 * low
    const base = camera.quaternion.clone(), euler = new THREE.Euler().setFromQuaternion(base, 'YXZ')
    const pitch = THREE.MathUtils.clamp(euler.x + REVIVE.pitch * low, -1.5, 1.5) - euler.x
    const roll = (reducedMotion ? 0 : REVIVE.roll) * low + sway
    const drop = REVIVE.drop * low
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

  reset() { this.removeCamera(); this.time = -1 }
}
