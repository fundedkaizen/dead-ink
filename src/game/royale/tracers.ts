import * as THREE from 'three'
import { createDangerStreak } from '../../render/ink'

/**
 * Red ink streaks for enemy fire aimed at you. The game's own bullet trails are small ink drops that
 * cross the screen in about a tenth of a second; these linger for half a second along the full path,
 * so a distant shooter can be found by eye. Presentation only: hits are decided by the AI as before.
 */
type Streak = ReturnType<typeof createDangerStreak> & { age: number; busy: boolean }

const POOL = 24, LIFETIME = 0.5, STOP_SHORT = 2.5

export class EnemyTracers {
  private streaks: Streak[] = []

  constructor(private scene: THREE.Scene) {}

  /** A streak from the muzzle toward the target, stopping short so it never covers your view. */
  fire(muzzle: THREE.Vector3, target: THREE.Vector3) {
    const length = muzzle.distanceTo(target) - STOP_SHORT
    if (length < 1) return
    let streak = this.streaks.find(s => !s.busy)
    if (!streak) {
      if (this.streaks.length >= POOL) streak = this.streaks.reduce((oldest, s) => s.age > oldest.age ? s : oldest)
      else { streak = { ...createDangerStreak(), age: 0, busy: false }; this.streaks.push(streak) }
    }
    const end = muzzle.clone().add(target.clone().sub(muzzle).setLength(length))
    streak.line.geometry.setPositions([muzzle.x, muzzle.y, muzzle.z, end.x, end.y, end.z])
    streak.age = 0; streak.busy = true
    streak.material.opacity = 1
    if (!streak.line.parent) this.scene.add(streak.line)
    streak.line.visible = true
  }

  update(dt: number) {
    for (const streak of this.streaks) {
      if (!streak.busy) continue
      streak.age += dt
      const k = streak.age / LIFETIME
      streak.material.opacity = k < 0.35 ? 1 : Math.max(0, 1 - (k - 0.35) / 0.65)
      if (streak.age >= LIFETIME) { streak.busy = false; streak.line.visible = false }
    }
  }

  clear() { for (const streak of this.streaks) { streak.busy = false; streak.line.visible = false } }
  dispose() { for (const streak of this.streaks) streak.dispose(); this.streaks = [] }
}
