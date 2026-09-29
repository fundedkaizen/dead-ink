import * as THREE from 'three'
import { Draft } from '../../render/ink'
import type { MissionRuntime } from '../runtime'
import { NOISE, type Exposure } from './stealth'

/**
 * This player's campaign tools: crouching (C) and leaning round a corner (Q and E, when not aiming), a stone to
 * throw as a distraction (T), a breach charge on a locked door (B), the hostage's "wait here" and "follow me"
 * (H), and the scout drone (X) that climbs above you for a few seconds and marks every guard it sees for the
 * team. The stance moves the view for the frame only (removeCamera puts it back), as the co-op last stand does.
 */
export const DRONE = { seconds: 12, cooldown: 40, height: 16, speed: 9, reach: 45, markRange: 42 } as const
const CROUCH_DROP = 0.62, LEAN_OFFSET = 0.55, LEAN_ROLL = 0.12

type Stone = { mesh: THREE.Mesh; velocity: THREE.Vector3; age: number }
type Ripple = { line: THREE.LineLoop; age: number }

export class CampaignTools {
  crouched = false
  /** -1 left, 0 upright, 1 right: held Q or E. */
  private leanWanted = 0
  private lean = 0
  private drop = 0
  private applied = new THREE.Vector3()
  private roll = 0
  private stones: Stone[] = []
  private ripples: Ripple[] = []
  private stoneGeometry = new THREE.SphereGeometry(0.07, 10, 8)
  private stoneMaterial = new THREE.MeshBasicMaterial({ color: 0x111111 })
  private rippleMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 })
  private held = new Set<string>()
  private abort = new AbortController()
  /** The scout drone: flying for `drone` seconds more (0: landed), recharging for `cooldown`. */
  drone = 0
  cooldown = 0
  private dronePosition = new THREE.Vector3()
  private droneModel: THREE.Group
  private scanTimer = 0
  private viewPosition = new THREE.Vector3()
  private viewRotation = new THREE.Quaternion()
  private droneBefore = new THREE.Vector3()

  constructor(private r: MissionRuntime, private scene: THREE.Scene) {
    const options = { signal: this.abort.signal }
    window.addEventListener('keyup', event => {
      this.held.delete(event.code)
      if (event.code === 'KeyQ' || event.code === 'KeyE') this.leanWanted = this.held.has('KeyQ') ? -1 : this.held.has('KeyE') ? 1 : 0
    }, options)
    window.addEventListener('blur', () => { this.held.clear(); this.leanWanted = 0 }, options)
    const model = new Draft('Scout drone')
    model.box(0.36, 0.08, 0.36, 0, 0, 0, 'roof', 'detail')
    for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) { model.beam([0, 0, 0], [x, 0.02, z], 0.04, 'roof', 'detail'); model.ring(0.14, 0.05, x, z, 'detail', 16) }
    this.droneModel = new THREE.Group()
    this.droneModel.add(model.finish())
    this.droneModel.userData.noCollision = true
    this.droneModel.visible = false
    scene.add(this.droneModel)
  }

  /** Flying the drone: the guards cannot see you (you are hidden, crouched, still) but you cannot move. */
  get flying() { return this.drone > 0 }
  /** The host's own player is out of play for the guards (never: flying still leaves your body where it is). */
  get hidden() { return false }

  get exposure(): Exposure {
    const velocity = this.r.player.body.velocity, speed = Math.hypot(velocity.x, velocity.z)
    return { crouched: this.crouched || this.flying, moving: speed > 0.5, running: speed > 5, leaning: this.lean !== 0 && Math.abs(this.lean) > 0.3 }
  }

  /** A key for the campaign's tools; true when it was one (the runtime then swallows it). */
  key(event: KeyboardEvent) {
    const r = this.r, campaign = r.campaign
    if (!campaign?.run || event.repeat) return false
    this.held.add(event.code)
    switch (event.code) {
      case 'KeyC': this.crouched = !this.crouched; r.hud.notify(this.crouched ? 'Crouched: slower, quieter, harder to see.' : 'Standing.', 1.4); return true
      case 'KeyQ': case 'KeyE':
        if (r.aimingNow) return false
        this.leanWanted = event.code === 'KeyQ' ? -1 : 1
        return true
      case 'KeyT': return this.throwStone()
      case 'KeyB': if (!campaign.breach()) r.hud.notify(campaign.charges > 0 ? 'Stand at a locked door to set a charge.' : 'No breach charges left.', 2.5); return true
      case 'KeyH': campaign.command(); return true
      case 'KeyX': this.toggleDrone(); return true
      default: return false
    }
  }

  private throwStone() {
    const r = this.r, campaign = r.campaign!
    if (!campaign.takeStone()) { r.hud.notify('No stones left.', 2); return true }
    const direction = r.view.getWorldDirection(new THREE.Vector3())
    const mesh = new THREE.Mesh(this.stoneGeometry, this.stoneMaterial)
    mesh.position.copy(r.view.position).addScaledVector(direction, 0.4)
    this.scene.add(mesh)
    this.stones.push({ mesh, velocity: direction.multiplyScalar(15).add(new THREE.Vector3(0, 3.2, 0)), age: 0 })
    r.hud.notify(`Stone thrown. ${campaign.stones} left.`, 1.6)
    return true
  }

  private toggleDrone() {
    const r = this.r
    if (this.flying) { this.land(); return }
    if (!r.campaign?.mission.tools.drone) return
    if (this.cooldown > 0) { r.hud.notify(`The drone is recharging: ${Math.ceil(this.cooldown)} s.`, 2); return }
    this.drone = DRONE.seconds
    this.droneBefore.copy(r.player.body.position)
    this.dronePosition.copy(r.view.position)
    this.droneModel.visible = true
    r.weapons.setHidden(true)
    r.player.movementLocked = true
    r.cancelInput()
    r.hud.notify('Scout drone up: WASD to fly, X to land. Every guard it sees is marked for the team.', 4)
  }

  private land() {
    const r = this.r
    if (!this.flying) return
    this.drone = 0
    this.cooldown = DRONE.cooldown
    this.droneModel.visible = false
    r.weapons.setHidden(false)
    if (!r.campaign?.boosting) r.player.movementLocked = false
    r.hud.notify('Drone down.', 1.5)
  }

  /** Each playing frame, before the guards look: crouch and lean ease in, and move the view (removeCamera undoes it). */
  stance(dt: number) {
    const r = this.r, camera = r.view
    const reduced = r.hud.reducedMotion
    this.drop += ((this.crouched && !this.flying ? CROUCH_DROP : 0) - this.drop) * Math.min(1, dt * 12)
    this.lean += ((this.flying ? 0 : this.leanWanted) - this.lean) * Math.min(1, dt * 10)
    if (Math.abs(this.lean) < 0.01) this.lean = 0
    this.applied.set(0, 0, 0); this.roll = 0
    this.r.player.stanceScale = this.crouched ? 0.55 : 1
    if (this.flying) {
      this.viewPosition.copy(camera.position); this.viewRotation.copy(camera.quaternion)
      camera.position.copy(this.dronePosition)
      this.applied.copy(this.dronePosition).sub(this.viewPosition)
      return
    }
    if (!this.drop && !this.lean) return
    this.applied.y = -this.drop
    if (this.lean) {
      // Lean only as far as the wall beside you allows.
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize().multiplyScalar(Math.sign(this.lean))
      const origin = camera.position.clone().setY(camera.position.y - this.drop)
      const room = Math.max(0, Math.min(LEAN_OFFSET, r.player.world.rayDistance(origin, right, LEAN_OFFSET + 0.2) - 0.2))
      this.applied.addScaledVector(right, room * Math.abs(this.lean))
      if (!reduced) this.roll = -this.lean * LEAN_ROLL
    }
    camera.position.add(this.applied)
    if (this.roll) camera.rotateZ(this.roll)
  }

  /** Put the view back where the body has it (end of frame). */
  removeCamera() {
    const camera = this.r.view
    if (this.flying && this.applied.lengthSq()) { camera.position.copy(this.viewPosition); this.applied.set(0, 0, 0); return }
    if (this.roll) camera.rotateZ(-this.roll)
    camera.position.sub(this.applied)
    this.applied.set(0, 0, 0); this.roll = 0
  }

  /** Each playing frame: stones in flight, the ripples where they land, the drone. */
  update(dt: number) {
    const r = this.r
    this.cooldown = Math.max(0, this.cooldown - dt)
    for (const stone of [...this.stones]) {
      stone.age += dt
      const step = stone.velocity.clone().multiplyScalar(dt)
      const length = step.length()
      const hit = length > 0 ? r.player.world.rayDistance(stone.mesh.position, step.clone().normalize(), length + 0.08) : Infinity
      if (hit <= length + 0.05 || stone.age > 4) {
        if (hit <= length + 0.05) stone.mesh.position.addScaledVector(step.normalize(), Math.max(0, hit - 0.05))
        this.settle(stone)
        continue
      }
      stone.mesh.position.add(step)
      stone.velocity.y -= 9.8 * dt
    }
    for (const ripple of [...this.ripples]) {
      ripple.age += dt
      ripple.line.scale.setScalar(0.3 + ripple.age * 3)
      ;(ripple.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, 0.6 * (1 - ripple.age / 0.8))
      if (ripple.age > 0.8) { ripple.line.removeFromParent(); ripple.line.geometry.dispose(); this.ripples.splice(this.ripples.indexOf(ripple), 1) }
    }
    if (this.flying) this.fly(dt)
  }

  private landStone(position: THREE.Vector3) {
    const points = Array.from({ length: 24 }, (_, i) => new THREE.Vector3(Math.cos(i / 24 * Math.PI * 2), 0, Math.sin(i / 24 * Math.PI * 2)))
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), this.rippleMaterial.clone())
    line.position.copy(position).setY(position.y + 0.05)
    this.scene.add(line)
    this.ripples.push({ line, age: 0 })
    this.r.emit({ kind: 'stone', position: position.clone(), radius: NOISE.stone }, true)
  }

  private settle(stone: Stone) {
    this.stones.splice(this.stones.indexOf(stone), 1)
    stone.mesh.removeFromParent()
    this.landStone(stone.mesh.position)
  }

  /** WASD flies the drone within its reach of your body; it marks the guards in view. */
  private fly(dt: number) {
    const r = this.r
    this.drone = Math.max(0, this.drone - dt)
    const target = Math.min(DRONE.height, this.droneBefore.y + DRONE.height)
    this.dronePosition.y += (target - this.dronePosition.y) * Math.min(1, dt * 1.6)
    const forward = r.view.getWorldDirection(new THREE.Vector3()).setY(0).normalize()
    const right = new THREE.Vector3(-forward.z, 0, forward.x)
    const x = Number(this.held.has('KeyD')) - Number(this.held.has('KeyA')), z = Number(this.held.has('KeyW')) - Number(this.held.has('KeyS'))
    const move = forward.multiplyScalar(z).addScaledVector(right, x)
    if (move.lengthSq() > 0) this.dronePosition.addScaledVector(move.normalize(), DRONE.speed * dt)
    const offset = this.dronePosition.clone().sub(this.droneBefore).setY(0)
    if (offset.length() > DRONE.reach) this.dronePosition.sub(offset.multiplyScalar(1 - DRONE.reach / offset.length()))
    this.droneModel.position.copy(this.dronePosition).setY(this.dronePosition.y + 0.35)
    if ((this.scanTimer -= dt) <= 0) {
      this.scanTimer = 0.4
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(r.view.projectionMatrix, r.view.matrixWorldInverse))
      r.ai.enemies.forEach((enemy, index) => {
        if (['dead', 'reserve'].includes(enemy.state)) return
        const head = enemy.position.clone().setY(enemy.position.y + 1.4)
        if (head.distanceTo(this.dronePosition) > DRONE.markRange || !frustum.containsPoint(head)) return
        if (!r.player.world.visible(this.dronePosition, head, enemy.actor.root)) return
        const mark = r.state.run?.marks?.find(entry => entry.kind === 'guard' && entry.ref === String(index))
        if (!mark || mark.until - r.state.elapsed < 20) r.campaign?.act(`mark:guard:${index}`)
      })
    }
    if (this.drone <= 0) this.land()
  }

  /** A new attempt: standing, nothing in flight, the drone charged. */
  reset() {
    this.crouched = false; this.leanWanted = 0; this.lean = 0; this.drop = 0
    if (this.flying) this.land()
    this.drone = 0; this.cooldown = 0
    for (const stone of this.stones) stone.mesh.removeFromParent()
    for (const ripple of this.ripples) { ripple.line.removeFromParent(); ripple.line.geometry.dispose() }
    this.stones = []; this.ripples = []
    this.held.clear()
  }

  dispose() {
    this.reset()
    this.abort.abort()
    this.droneModel.removeFromParent()
    this.stoneGeometry.dispose(); this.stoneMaterial.dispose(); this.rippleMaterial.dispose()
  }
}
