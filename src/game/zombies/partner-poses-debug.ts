import * as THREE from 'three'
import { PartnerAvatar, type PlayerState } from './coop'

/**
 * Dev builds only: `window.__partnerPoses` shows the co-op partner's poses without a second player.
 *
 *   __partnerPoses.play()           a stickman 2.5 m in front of you goes through every pose, over and over
 *   __partnerPoses.play('crawl')    one script, looping: stand, down, crawl, revived, revive or dead
 *   __partnerPoses.at('revive', 2)  that script 2 s in, held still (for screenshots)
 *   __partnerPoses.stop()           then edit __partnerPoses.state and call .step() to drive it by hand
 *   __partnerPoses.remove()
 *
 * 'revive' also lays a downed teammate (red) where the reviver kneels.
 */
type Name = 'stand' | 'down' | 'crawl' | 'revived' | 'revive' | 'dead'
type Step = { at: number; dn?: 0 | 1 | 2; mv?: 0 | 1; rv?: number; turn?: number; pitch?: number }
type Environment = { scene: THREE.Scene; player: { body: { position: THREE.Vector3 } }; camera: { active: THREE.Camera }; invalidate(): void }

/** The last stand crawl: walking pace 4.2 m/s times the crawl's 0.22, round a circle of this radius. */
const CRAWL_SPEED = 4.2 * 0.22, CRAWL_RADIUS = 1.5
const SCRIPTS: Record<Name, { seconds: number; steps: Step[] }> = {
  stand: { seconds: 2.5, steps: [{ at: 0 }] },
  // Down, then the pistol follows the look left, right and up, then down.
  down: { seconds: 7, steps: [{ at: 0.5, dn: 1 }, { at: 2.5, turn: 0.6 }, { at: 3.5, turn: -0.5, pitch: 0.3 }, { at: 4.5, turn: 0, pitch: -0.3 }, { at: 5.5, pitch: 0 }] },
  crawl: { seconds: 9, steps: [{ at: 0, dn: 1 }, { at: 1.5, mv: 1 }] },
  revived: { seconds: 4.5, steps: [{ at: 0, dn: 1 }, { at: 2, dn: 0 }] },
  // Looking down at the teammate; the revive runs for 3 s.
  revive: { seconds: 5, steps: [{ at: 0, pitch: -0.9 }, { at: 0.8, rv: 0.02 }, { at: 3.8, rv: 0 }] },
  dead: { seconds: 5, steps: [{ at: 0, dn: 1 }, { at: 1.5, dn: 2 }] },
}
const TOUR: Name[] = ['stand', 'down', 'crawl', 'revived', 'revive', 'dead']

export function install() {
  const environment = () => (window as unknown as { __environment?: Environment }).__environment
  let avatar: PartnerAvatar | null = null, patient: PartnerAvatar | null = null
  let frame = 0
  // Where the stickman stands, and the way it faces: toward you.
  const origin = new THREE.Vector3(), facing = new THREE.Vector3(), left = new THREE.Vector3()
  const state: PlayerState = { id: 1, p: [0, 0, 0], yaw: 0, pitch: 0, w: 'pistol', mv: 0, dn: 0, rv: 0, pts: 0, kills: 0, name: 'Partner' }
  const patientState: PlayerState = { ...state, id: 2, dn: 1, name: 'Teammate' }
  /** A look yaw for a facing direction (the camera looks down -Z at yaw 0). */
  const yawOf = (x: number, z: number) => Math.atan2(-x, -z)

  async function spawn() {
    const env = environment()
    if (!env) throw new Error('window.__environment is not ready yet')
    if (!avatar) {
      avatar = new PartnerAvatar(env.scene)
      patient = new PartnerAvatar(env.scene)
      await Promise.all([avatar.load(), patient.load()])
      ;(patient.actor!.rig.mesh.material as THREE.MeshBasicMaterial).color.setHex(0xc83232)
    }
    env.camera.active.getWorldDirection(facing).setY(0)
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, -1)
    facing.normalize()
    origin.copy(env.player.body.position).addScaledVector(facing, 2.5)
    facing.negate()
    left.set(facing.z, 0, -facing.x)
  }

  /** Set `state` (and the teammate's) to `name` at `t` seconds in. */
  function scripted(name: Name, t: number) {
    let turn = 0
    Object.assign(state, { dn: 0, mv: 0, rv: 0, pitch: 0 })
    for (const step of SCRIPTS[name].steps) {
      if (step.at > t) break
      if (step.dn !== undefined) state.dn = step.dn
      if (step.mv !== undefined) state.mv = step.mv
      if (step.rv !== undefined) state.rv = step.rv
      if (step.pitch !== undefined) state.pitch = step.pitch
      if (step.turn !== undefined) turn = step.turn
    }
    const x = origin.x, z = origin.z
    state.p = [x, origin.y, z]
    state.yaw = yawOf(facing.x, facing.z) + turn
    if (name === 'crawl' && state.mv) {
      // Round a circle to the left, looking where they crawl.
      const a = (t - 1.5) * CRAWL_SPEED / CRAWL_RADIUS, s = Math.sin(a), c = Math.cos(a)
      state.p = [x + (facing.x * s + left.x * (1 - c)) * CRAWL_RADIUS, origin.y, z + (facing.z * s + left.z * (1 - c)) * CRAWL_RADIUS]
      state.yaw = yawOf(facing.x * c + left.x * s, facing.z * c + left.z * s)
    }
    if (name === 'revive' && state.rv) state.rv = Math.min(1, Math.max(0.02, (t - 0.8) / 3))
    // The teammate lies 1.2 m ahead of the reviver, across its line.
    patientState.p = [x + facing.x * 1.2, origin.y, z + facing.z * 1.2]
    patientState.yaw = state.yaw + Math.PI / 2
  }

  function feed(dt: number, name: Name, t: number) {
    scripted(name, t)
    avatar!.update(dt, state)
    patient!.update(dt, name === 'revive' ? patientState : null)
  }

  const api = {
    state,
    get avatar() { return avatar },
    /** Play the tour (every script in turn) or one script, looping, in real time. */
    async play(name: Name | 'tour' = 'tour') {
      await spawn()
      api.stop()
      const list = name === 'tour' ? TOUR : [name]
      let index = 0, t = 0, last = performance.now()
      api.reset()
      const tick = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        t += dt
        if (t > SCRIPTS[list[index]].seconds) { index = (index + 1) % list.length; t = 0; api.reset() }
        feed(dt, list[index], t)
        environment()?.invalidate()
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    },
    /** `name` at `seconds` in, stepped there at 60 fps from standing, then held. */
    async at(name: Name, seconds: number) {
      await spawn()
      api.stop()
      api.reset()
      for (let t = 0; t <= seconds + 1e-9; t += 1 / 60) feed(1 / 60, name, t)
      environment()?.invalidate()
      return avatar!
    },
    /** One frame of whatever `state` says (after stop()). */
    step(dt = 1 / 60) { avatar?.update(dt, state); environment()?.invalidate() },
    /** Back on its feet, facing you, as if it had just joined (stepped through its get-up at once). */
    reset() {
      if (!avatar) return
      for (let i = 0; i < 150; i++) feed(1 / 60, 'stand', 0)
    },
    stop() { cancelAnimationFrame(frame); frame = 0 },
    remove() { api.stop(); avatar?.dispose(); patient?.dispose(); avatar = patient = null; environment()?.invalidate() },
  }
  Object.assign(window, { __partnerPoses: api })
  return api
}
