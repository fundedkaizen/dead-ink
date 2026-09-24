import * as THREE from 'three'
import type { EnemyDirector } from './ai'
import { ENEMY_HEALTH } from './balance'
import { GUARD_STATES, POSTURES, type GuardRow } from './rescue-coop-rules'
import type { HitReaction, HitZone } from './hit-reactions'
import type { BoneName } from '../lab/rig'
import type { EmitSound, WeaponName } from './types'

const eyeOffset = new THREE.Vector3(0, 1.5, 0)

/**
 * Co-op guest: the guards are the host's. Each one here is a puppet that thinks nothing: it goes where the
 * host's snapshot (a GuardRow, fifteen a second) says, easing between snapshots, and plays what the host's
 * guard plays: walking, turning, the look round after a near miss, crouching, aiming at whoever he is after,
 * the muzzle flash of each round (fired()), and the flinch or the fall of a hit (react()).
 */
export class GuardPuppets {
  private goal = new THREE.Vector3()
  private aim = new THREE.Vector3()
  private before = new THREE.Vector3()

  constructor(private ai: EnemyDirector, private emit: EmitSound) {}

  update(dt: number, rows: readonly GuardRow[]) {
    const follow = 1 - Math.exp(-dt * 14)
    for (const row of rows) {
      const enemy = this.ai.enemies[row[0]]
      if (!enemy) continue
      const state = GUARD_STATES[row[1]] ?? 'guard', actor = enemy.actor
      if (state === 'reserve') {
        if (enemy.state !== 'reserve') { enemy.state = 'reserve'; actor.root.visible = false }
        continue
      }
      actor.root.visible = true
      const goal = this.goal.set(row[2], row[3], row[4]), yaw = row[5]
      if (state === 'dead') {
        if (enemy.state !== 'dead') {
          // No reaction reached us (we joined after he fell): lie where the host has the body.
          enemy.state = 'dead'; enemy.health = 0
          enemy.position.copy(goal); enemy.yaw = yaw
          actor.root.position.copy(goal); actor.root.rotation.y = yaw
          actor.restore('dead', 4, enemy.deathClip)
        }
        actor.update(dt, 'dead', false)
        continue
      }
      if (enemy.state === 'dead' || enemy.state === 'reserve') {
        // Up again (the host went back to a checkpoint), or out of the barracks: start where the host has him.
        if (enemy.state === 'dead') actor.restore(state)
        enemy.position.copy(goal); enemy.yaw = yaw; enemy.health = ENEMY_HEALTH
      }
      enemy.state = state
      this.before.copy(enemy.position)
      if (enemy.position.distanceToSquared(goal) > 9) enemy.position.copy(goal)
      else enemy.position.lerp(goal, follow)
      enemy.yaw += Math.atan2(Math.sin(yaw - enemy.yaw), Math.cos(yaw - enemy.yaw)) * follow
      const posture = POSTURES[row[7]] ?? 'stand', scan = row[12] ?? -1, speed = row[6] ?? 0, moving = speed > 0.01
      if ((actor.posture ?? 'stand') !== posture) actor.setPosture?.(posture, posture === 'crouch' && scan >= 0)
      actor.root.position.copy(enemy.position)
      actor.root.rotation.y = enemy.yaw
      actor.root.userData.alertScan = scan >= 0 ? scan : undefined
      enemy.moveSpeed = speed
      enemy.canSee = row[8] === 1
      // Footsteps where he walks, as the host's guard makes them.
      if (moving) {
        enemy.footstepDistance += this.before.distanceTo(enemy.position)
        if (enemy.footstepDistance >= 0.85) {
          enemy.footstepDistance %= 0.85
          this.emit({ kind: 'enemy-footstep', position: enemy.position.clone(), radius: 5 })
        }
      }
      actor.update(dt, state, moving, enemy.canSee ? this.aim.set(row[9], row[10], row[11]) : undefined, speed)
    }
    this.ai.bulletTrails.update(dt)
  }

  /** The host's guard fired: his muzzle flash and kick here (the runtime draws the round and plays its report). */
  fired(index: number) {
    const enemy = this.ai.enemies[index]
    if (enemy && enemy.state !== 'dead') enemy.actor.shoot()
  }

  /** The host's guard was hit: the same flinch or fall, and his cry. Returns the hit, for the blood. */
  react(index: number, clip: string, lethal: boolean, direction: THREE.Vector3, travel: number, zone: HitZone, point: THREE.Vector3,
    weapon?: WeaponName, bone?: string): HitReaction | null {
    const enemy = this.ai.enemies[index]
    if (!enemy || enemy.state === 'dead' || enemy.state === 'reserve') return null
    enemy.actor.root.userData.alertScan = undefined
    enemy.actor.react(clip, lethal, direction, travel)
    if (lethal) {
      enemy.state = 'dead'; enemy.health = 0
      enemy.deathClip = enemy.actor.deathClip
      enemy.actor.update(0, 'dead', false)
    }
    this.emit({ kind: 'enemy-hit', position: point.clone(), radius: 14, zone })
    this.emit({ kind: 'enemy-pain', position: enemy.position.clone().add(eyeOffset), radius: 38, speaker: enemy.speaker, zone })
    if (lethal) this.emit({ kind: 'enemy-down', position: enemy.position.clone(), radius: 5 })
    return { zone, point, direction, lethal, bone: bone as BoneName | undefined, weapon, targetId: enemy.spec.id, clip, travel }
  }
}
