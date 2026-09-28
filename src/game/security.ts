import * as THREE from 'three'
import type { CollisionWorld } from '../player/collision'
import type { EnemyDirector } from './ai'
import type { MissionState } from './mission'
import { RESCUE_LAYOUT } from './rescue-layout'
import type { EmitSound, MissionWorld } from './types'

export const SECURITY_RULES = { detectionDwell: 0.75, secondWaveDelay: 14, searchCooldown: 12, reserveLimit: 4, hornInterval: 7 } as const
export const CAMERA_LIGHTS = { watching: 0x21db66, alarm: 0xff2929, offline: 0x40464a } as const
export const CAMERA_PATROL = { holdSeconds: 3.5, turnSeconds: 1.8 } as const

/** Three lookout directions, with a full stop before each smooth motor turn. */
export function cameraPatrolYaw(elapsed: number, index: number, yaw: number, arc: number) {
  const stops = [0, 1, 0, -1]
  const segment = CAMERA_PATROL.holdSeconds + CAMERA_PATROL.turnSeconds
  const time = Math.max(0, elapsed) + index * 0.8
  const cycleStep = Math.floor((time + 1e-9) / segment)
  const step = cycleStep % stops.length
  const progress = THREE.MathUtils.clamp((time - cycleStep * segment - CAMERA_PATROL.holdSeconds) / CAMERA_PATROL.turnSeconds, 0, 1)
  const smooth = progress * progress * (3 - 2 * progress)
  return yaw + THREE.MathUtils.lerp(stops[step], stops[(step + 1) % stops.length], smooth) * arc
}
export type CameraSpec = { id: string; position: [number, number, number]; yaw: number; arc: number; range: number }
export type CameraRig = { id: string; pivot: THREE.Group; lamp: THREE.Mesh; root?: THREE.Object3D }
/** The rescue campaign's cameras and alarm rules (its difficulty); absent, the classic mission's. */
export type SecurityRules = { detectionDwell: number; secondWaveDelay: number; reserveLimit: number }

/** Security keeps only a confirmed sighting; guard perception remains authoritative afterward. */
export class SecuritySystem {
  private dwell = new Map<string, number>()
  private lastAlarm: MissionState['alarm'] = 'inactive'
  private lastLampColor: number | null = null
  private hornElapsed = 0
  private rigs: { spec: CameraSpec; rig: CameraRig }[] | null = null
  private rules: SecurityRules = SECURITY_RULES
  /** Cameras shot out: dark, drooping, blind for good (the campaign's; a restart brings them back). */
  destroyed = new Set<string>()
  /** Called when a camera raises the alarm (the campaign counts alarms). */
  onAlarm: (position: THREE.Vector3) => void = () => {}

  /** Watch through these cameras, with these rules (the campaign's mission). */
  configure(rigs: { spec: CameraSpec; rig: CameraRig }[], rules: SecurityRules) {
    this.rigs = rigs; this.rules = rules; this.lastLampColor = null
  }

  /** The cameras in use: the configured ones, or the classic four. */
  list(): { spec: CameraSpec; rig: CameraRig }[] {
    if (this.rigs) return this.rigs
    const out: { spec: CameraSpec; rig: CameraRig }[] = []
    for (const rig of this.missionWorld.rescue?.cameras ?? []) {
      const spec = RESCUE_LAYOUT.cameras.find(candidate => candidate.id === rig.id)
      if (spec) out.push({ spec, rig })
    }
    return out
  }

  /** A camera shot out: false if it was already gone or is not in use. */
  destroy(id: string) {
    const entry = this.list().find(item => item.spec.id === id)
    if (!entry || this.destroyed.has(id)) return false
    this.destroyed.add(id)
    this.dwell.delete(id)
    entry.rig.pivot.rotation.x = 0.55
    for (const material of Array.isArray(entry.rig.lamp.material) ? entry.rig.lamp.material : [entry.rig.lamp.material]) {
      if ('color' in material) (material as THREE.MeshBasicMaterial).color.setHex(CAMERA_LIGHTS.offline)
    }
    return true
  }

  constructor(private world: CollisionWorld, private missionWorld: MissionWorld, private ai: EnemyDirector, private emit: EmitSound) {}

  reset() {
    this.dwell.clear()
    this.lastAlarm = 'inactive'
    this.lastLampColor = null
    this.hornElapsed = 0
    for (const { rig } of this.rigs ?? []) rig.pivot.rotation.x = 0
    this.destroyed.clear()
  }

  sync(state: MissionState, visualElapsed = state.elapsed) {
    if (state.alarm === 'silenced' && this.lastAlarm === 'active') {
      this.ai.silenceAlarm()
      this.dwell.clear()
      this.hornElapsed = 0
    }
    this.lastAlarm = state.alarm
    const color = !state.camerasActive ? CAMERA_LIGHTS.offline : state.alarm === 'active' ? CAMERA_LIGHTS.alarm : CAMERA_LIGHTS.watching
    const changed = this.lastLampColor !== color
    this.list().forEach(({ spec, rig: camera }, index) => {
      if (this.destroyed.has(spec.id)) return
      if (state.camerasActive) camera.pivot.rotation.y = cameraPatrolYaw(visualElapsed, index, spec.yaw, spec.arc)
      if (changed) {
        for (const material of Array.isArray(camera.lamp.material) ? camera.lamp.material : [camera.lamp.material]) {
          if ('color' in material) (material as THREE.MeshBasicMaterial).color.setHex(color)
          if ('emissive' in material) (material as THREE.MeshStandardMaterial).emissiveIntensity = 0
        }
      }
    })
    if (!state.camerasActive) this.dwell.clear()
    this.lastLampColor = color
  }

  trigger(state: MissionState, position: THREE.Vector3, text?: string) {
    if (state.phase !== 'active' || state.alarm === 'active') return false
    state.alarm = 'active'
    state.alarmElapsed = 0
    state.silencedElapsed = 0
    state.alarmPosition = position.toArray() as [number, number, number]
    state.detections++
    const count = Math.min(2, this.rules.reserveLimit - state.reservesDispatched)
    state.reservesDispatched += this.ai.respondToAlarm(position, Math.max(0, count))
    this.hornElapsed = 0
    this.emit({ kind: 'horn', position: position.clone(), radius: 100, text: text ?? 'ALARM - barracks responding to the camera sighting.' })
    this.sync(state)
    this.onAlarm(position)
    return true
  }

  /** `eyes`: the player's eye, or in co-op every player the cameras can catch. */
  update(dt: number, state: MissionState, eyes: THREE.Vector3 | readonly THREE.Vector3[]) {
    this.sync(state)
    if (state.phase !== 'active' || dt <= 0) return
    dt = Math.min(dt, 0.1)
    if (state.alarm === 'active') {
      state.alarmElapsed += dt
      this.hornElapsed += dt
      if (state.alarmPosition && state.alarmElapsed >= this.rules.secondWaveDelay && state.reservesDispatched < this.rules.reserveLimit) {
        state.reservesDispatched += this.ai.respondToAlarm(new THREE.Vector3(...state.alarmPosition), this.rules.reserveLimit - state.reservesDispatched, false)
      }
      if (this.hornElapsed >= SECURITY_RULES.hornInterval) {
        this.hornElapsed %= SECURITY_RULES.hornInterval
        this.emit({ kind: 'horn', position: state.alarmPosition ? new THREE.Vector3(...state.alarmPosition) : undefined, radius: 100 })
      }
    } else if (state.alarm === 'silenced') {
      state.silencedElapsed += dt
      if (state.silencedElapsed >= SECURITY_RULES.searchCooldown) state.alarm = 'inactive'
    }
    if (!state.camerasActive) return
    const watched: readonly THREE.Vector3[] = Array.isArray(eyes) ? eyes : [eyes as THREE.Vector3]
    for (const { spec, rig: camera } of this.list()) {
      if (this.destroyed.has(spec.id)) continue
      const origin = new THREE.Vector3(...spec.position)
      const yaw = camera.pivot.rotation.y
      const eye = watched.find(eye => {
        const dx = eye.x - origin.x, dz = eye.z - origin.z
        const distance = Math.hypot(dx, dz)
        const inCone = distance > 0.2 && distance <= spec.range && Math.abs(eye.y - origin.y) < 6 &&
          (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / distance >= Math.cos(28 * Math.PI / 180)
        return inCone && this.world.visible(origin, eye, camera.pivot)
      })
      const elapsed = eye ? (this.dwell.get(camera.id) ?? 0) + dt : 0
      this.dwell.set(camera.id, elapsed)
      if (eye && elapsed >= this.rules.detectionDwell) this.trigger(state, eye.clone().add(new THREE.Vector3(0, -1.65, 0)))
    }
  }
}
