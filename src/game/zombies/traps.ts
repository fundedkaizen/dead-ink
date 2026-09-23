import * as THREE from 'three'
import { Draft, wallText } from '../../render/ink'
import type { GateSpec } from './zones'

/**
 * Ink traps, as Call of Duty's fire and electric traps: across a gate opening, a switch on a post beside it.
 * Pay, and ink jets spray across the opening for a while: every zombie that walks through dies (the
 * Brute only takes a beating), and so will you if you stand in it. Then it has to recharge. Kills in a trap
 * count but pay no points, as in Call of Duty, so a trap is for surviving, not farming.
 */
export const TRAP = { cost: 1000, active: 25, cooldown: 45, depth: 1.6, playerDps: 60, bruteDps: 300 } as const

/** The gates that carry a trap, and which side you come from (where the switch stands). */
export const TRAP_GATES: readonly { gate: string; home: [number, number] }[] = [
  { gate: 'warehouse', home: [-30, -25] },
  { gate: 'rail', home: [25.5, -6] },
]

export type TrapState = 'idle' | 'active' | 'cooling'

export class InkTrap {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  readonly centre: THREE.Vector3
  state: TrapState = 'idle'
  timer = 0
  private jets: THREE.Mesh[] = []
  private splashes: THREE.Mesh[] = []
  private lamp: THREE.Mesh
  private along: THREE.Vector3
  private across: THREE.Vector3
  private half: number
  private time = 0
  private jetMaterial = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, side: THREE.DoubleSide })
  private splashMaterial = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false })

  constructor(readonly spec: GateSpec, home: [number, number], floor: number) {
    this.root.name = `Ink trap · ${spec.zone}`
    this.root.userData.noCollision = true
    this.centre = new THREE.Vector3(spec.centre[0], floor, spec.centre[1])
    this.along = new THREE.Vector3(Math.cos(spec.angle), 0, -Math.sin(spec.angle))
    this.across = new THREE.Vector3(-this.along.z, 0, this.along.x)
    this.half = spec.width / 2
    // The switch stands just past the gate's end on the side you come from.
    const toHome = new THREE.Vector3(home[0] - spec.centre[0], 0, home[1] - spec.centre[1])
    const side = Math.sign(toHome.dot(this.across)) || 1
    const post = this.centre.clone().addScaledVector(this.along, this.half + 0.9).addScaledVector(this.across, side * 1.3)
    const box = new Draft('Ink trap switch', post.x, post.z, Math.atan2(this.across.x * side, this.across.z * side))
    box.box(0.1, 1.2, 0.1, 0, 0.6, 0, 'paper', 'edge')
    box.box(0.42, 0.52, 0.2, 0, 1.35, 0.02, 'paper', 'edge')
    box.box(0.3, 0.1, 0.04, 0, 1.2, 0.13, 'paper', 'detail')
    box.finish()
    box.position.y = floor
    this.root.add(box)
    // The price on the box's face, which looks out along `across` toward where you come from.
    const text = wallText(String(TRAP.cost), [0, 0, 0], 0.12)
    text.position.copy(post).setY(floor + 1.42).addScaledVector(this.across, side * 0.13)
    text.rotation.y = Math.atan2(this.across.x * side, this.across.z * side)
    this.root.add(text)
    this.lamp = new THREE.Mesh(new THREE.CircleGeometry(0.045, 16), new THREE.MeshBasicMaterial({ color: 0x3a3a3a, toneMapped: false }))
    this.lamp.position.copy(post).setY(floor + 1.56).addScaledVector(this.across, side * 0.125)
    this.lamp.rotation.y = text.rotation.y
    this.root.add(this.lamp)
    // Nozzle pipes low on both ends of the opening.
    const pipes = new Draft('Ink trap pipes')
    for (const end of [-1, 1]) {
      const p = this.centre.clone().addScaledVector(this.along, end * (this.half + 0.1))
      for (const h of [0.35, 1.0]) pipes.box(0.14, 0.14, 0.14, p.x - this.centre.x, h, p.z - this.centre.z, 'paper', 'edge')
    }
    pipes.finish()
    pipes.position.copy(this.centre)
    this.root.add(pipes)
    // The jets: thin ink sheets across the opening at two heights, and splashes on the floor.
    for (const h of [0.35, 1.0]) for (const lane of [-0.35, 0.35]) {
      const jet = new THREE.Mesh(new THREE.PlaneGeometry(spec.width + 0.2, 0.12), this.jetMaterial)
      jet.position.copy(this.centre).setY(floor + h).addScaledVector(this.across, lane)
      jet.rotation.y = spec.angle
      jet.visible = false
      this.jets.push(jet)
      this.root.add(jet)
    }
    for (let i = 0; i < 6; i++) {
      const splash = new THREE.Mesh(new THREE.CircleGeometry(0.35, 14), this.splashMaterial)
      splash.rotation.x = -Math.PI / 2
      splash.position.copy(this.centre).setY(floor + 0.03).addScaledVector(this.along, (i / 5 - 0.5) * spec.width * 0.9)
      splash.visible = false
      this.splashes.push(splash)
      this.root.add(splash)
    }
    this.point = post.clone().setY(floor + 1.35)
  }

  /** Whether a spot on the ground is inside the jets. */
  inside(point: THREE.Vector3) {
    const d = point.clone().sub(this.centre).setY(0)
    return Math.abs(d.dot(this.along)) <= this.half + 0.3 && Math.abs(d.dot(this.across)) <= TRAP.depth
  }

  start() {
    if (this.state !== 'idle') return false
    this.state = 'active'
    this.timer = TRAP.active
    return true
  }

  reset() { this.state = 'idle'; this.timer = 0; this.show(false) }

  /** Advance; `powered` lights the lamp. Returns 'ended' the frame it stops spraying. */
  update(dt: number, powered: boolean): 'ended' | null {
    this.time += dt
    let event: 'ended' | null = null
    if (this.state !== 'idle') {
      this.timer -= dt
      if (this.timer <= 0) {
        if (this.state === 'active') { this.state = 'cooling'; this.timer = TRAP.cooldown; event = 'ended' }
        else { this.state = 'idle'; this.timer = 0 }
      }
    }
    const spraying = this.state === 'active'
    this.show(spraying)
    if (spraying) {
      // The sheets flutter and the splashes throb, so the jets read as moving ink, not flat bars.
      this.jets.forEach((jet, i) => { jet.scale.y = 0.6 + 0.6 * Math.abs(Math.sin(this.time * 17 + i * 1.7)) })
      this.splashes.forEach((s, i) => s.scale.setScalar(0.7 + 0.5 * Math.abs(Math.sin(this.time * 9 + i * 2.1))))
    }
    const lamp = this.lamp.material as THREE.MeshBasicMaterial
    lamp.color.setHex(!powered ? 0x3a3a3a : this.state === 'idle' ? 0x4fb34a : 0xd4332a)
    return event
  }

  private show(on: boolean) {
    for (const jet of this.jets) jet.visible = on
    for (const s of this.splashes) s.visible = on
  }

  dispose() {
    this.root.removeFromParent()
    for (const m of [...this.jets, ...this.splashes, this.lamp]) m.geometry.dispose()
    this.jetMaterial.dispose(); this.splashMaterial.dispose(); (this.lamp.material as THREE.Material).dispose()
  }
}
