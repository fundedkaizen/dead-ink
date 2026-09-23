import * as THREE from 'three'

/**
 * Second Draft getting you back up: you go down hard, the world drains to grey and swims while you lie
 * there, then you haul yourself up as the colour floods back, blue for the perk. You cannot move or shoot
 * while you are down (the zombies around you have been shoved back and you cannot be hurt).
 */
export const REVIVE = { seconds: 2.4, fall: 0.35, rise: 1.45, drop: 1.05, roll: 0.5, pitch: 0.28 } as const

export class SecondDraftRevive {
  private time = -1
  private applied: { camera: THREE.Camera; position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null

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
    this.applied = { camera, position: camera.position.clone(), quaternion: camera.quaternion.clone() }
    camera.position.y -= REVIVE.drop * low
    const turn = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    turn.x = THREE.MathUtils.clamp(turn.x + REVIVE.pitch * low, -1.5, 1.5)
    turn.z += (reducedMotion ? 0 : REVIVE.roll) * low + sway
    camera.quaternion.setFromEuler(turn)
    camera.updateMatrixWorld(true)
  }

  removeCamera() {
    if (!this.applied) return
    const { camera, position, quaternion } = this.applied
    camera.position.copy(position)
    camera.quaternion.copy(quaternion)
    camera.updateMatrixWorld(true)
    this.applied = null
  }

  reset() { this.removeCamera(); this.time = -1 }
}
