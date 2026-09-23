import * as THREE from 'three'
import { Draft, wallText } from '../../render/ink'

/**
 * Dead Ink's main quest, "The Last Edition", in the manner of Black Ops 3's main Easter eggs: a chain of
 * steps across the whole map that ends in a boss fight and a finale.
 *
 * 1. Turn on the power.  2. Build the Pack-a-Punch.
 * 3. Three inkwells wake up across the compound. Zombies that die near one send their ink flying into it
 *    (Call of Duty's soul boxes); a full well leaves a bottle of ink.
 * 4. Pour the three bottles into the Pack-a-Punch.
 * 5. The Editor, a giant Brute, climbs out by the machine. Kill it and the edition is printed.
 */
export type QuestStep = 'power' | 'pack' | 'wells' | 'pour' | 'editor' | 'done'
type Place = [number, number, number]

export const QUEST = {
  souls: 15, soulRadius: 7, soulFlight: 0.7,
  /** The Editor: the Brute's health for the round, times this. */
  editorHealth: 3,
  editorDelay: 3,
} as const

/** The inkwells: the southwest yard, the rail yard, the east annex. */
export const INKWELL_PLACES: readonly Place[] = [[-44, 0, 36], [62, 0, -24], [126, 0, 4]]

/** What the quest line on the HUD says at each step. */
export function questHint(step: QuestStep, detail: { souls?: number; bottles?: number } = {}) {
  switch (step) {
    case 'power': return 'Find the power switch'
    case 'pack': return 'Build the Pack-a-Punch'
    case 'wells': return `Feed the inkwells · ${detail.souls ?? 0}/${QUEST.souls * INKWELL_PLACES.length}${detail.bottles ? ` · ${detail.bottles} bottle${detail.bottles === 1 ? '' : 's'}` : ''}`
    case 'pour': return 'Pour the ink into the Pack-a-Punch'
    case 'editor': return 'Kill the Editor'
    case 'done': return null
  }
}

const ink = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
const glass = new THREE.MeshBasicMaterial({ color: 0xdcefe3, toneMapped: false })

/**
 * An inkwell: a stone pedestal with a wide bowl. Dormant, it is dry; awake, black ink swirls in it and
 * rises with every soul; full, it overflows and a bottle of ink stands on its rim for you to take.
 */
export class Inkwell {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  souls = 0
  awake = false
  bottleTaken = false
  private surface: THREE.Mesh
  private swirl: THREE.Mesh
  private bottle: THREE.Group
  private pulse = 0
  private time = Math.random() * 10

  constructor(at: THREE.Vector3) {
    this.root.name = 'Inkwell'
    this.root.userData.noCollision = true
    this.root.position.copy(at)
    const stone = new Draft('Inkwell pedestal')
    stone.cylinder(0.28, 0.8, 0, 0.4, 0, 'paper', 0.22)
    stone.cylinder(0.55, 0.22, 0, 0.91, 0, 'paper', 0.62)
    stone.ring(0.62, 1.02, 0, 0, 'edge', 48)
    stone.hatch([-0.25, 0.1, 0.285], [0.5, 0, 0], [0, 0.55, 0], { spacing: 0.06 })
    stone.finish()
    this.root.add(stone)
    this.surface = new THREE.Mesh(new THREE.CircleGeometry(0.54, 32), ink)
    this.surface.rotation.x = -Math.PI / 2
    this.surface.position.y = 0.84
    this.surface.visible = false
    this.swirl = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.4, 32, 1, 0, Math.PI * 1.2), new THREE.MeshBasicMaterial({ color: 0x5a5a5a, transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false }))
    this.swirl.rotation.x = -Math.PI / 2
    this.swirl.visible = false
    this.root.add(this.surface, this.swirl)
    // The bottle of ink a full well leaves on its rim.
    this.bottle = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.2, 14), glass)
    const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.15, 14), ink)
    fill.position.y = -0.02
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.08, 10), glass)
    neck.position.y = 0.14
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.096, 0.22, 14), new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false }))
    this.bottle.add(rim, body, fill, neck)
    this.bottle.position.set(0.4, 1.14, 0)
    this.bottle.visible = false
    this.root.add(this.bottle)
    this.root.add(wallText('FEED ME', [0, 1.75, 0], 0.2))
    this.root.children[this.root.children.length - 1].visible = false
    this.point = at.clone().setY(at.y + 1.1)
  }

  get full() { return this.souls >= QUEST.souls }
  /** A bottle stands on the rim, waiting to be taken. */
  get bottleWaiting() { return this.full && !this.bottleTaken }

  wake() {
    this.awake = true
    this.surface.visible = true
    this.swirl.visible = true
    this.root.children[this.root.children.length - 1].visible = true
  }

  addSoul() {
    if (!this.awake || this.full) return false
    this.souls++
    this.pulse = 0.4
    if (this.full) { this.bottle.visible = true; this.root.children[this.root.children.length - 1].visible = false }
    return true
  }

  takeBottle() {
    if (!this.bottleWaiting) return false
    this.bottleTaken = true
    this.bottle.visible = false
    return true
  }

  reset() {
    this.souls = 0; this.awake = false; this.bottleTaken = false; this.pulse = 0
    this.surface.visible = false; this.swirl.visible = false; this.bottle.visible = false
    this.root.children[this.root.children.length - 1].visible = false
  }

  update(dt: number) {
    this.time += dt
    if (!this.awake) return
    this.pulse = Math.max(0, this.pulse - dt)
    // The ink rises from the bottom of the bowl to its brim as the souls come in.
    const level = 0.84 + 0.14 * Math.min(1, this.souls / QUEST.souls)
    this.surface.position.y = level
    this.swirl.position.y = level + 0.005
    this.swirl.rotation.z += dt * (this.full ? 0.6 : 2.2)
    const bob = 1 + this.pulse * 0.6
    this.surface.scale.setScalar(bob)
    if (this.bottle.visible) this.bottle.rotation.y += dt * 1.2
  }

  dispose() {
    this.root.removeFromParent()
    // Only what this well made: the pedestal's ink drawing shares its materials with the whole map.
    for (const mesh of [this.surface, this.swirl]) mesh.geometry.dispose()
    ;(this.swirl.material as THREE.Material).dispose()
    this.bottle.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
  }
}

/** The ink of a zombie killed near a well, flying to it in an arc: pooled black blobs with a tail. */
export class SoulStreams {
  private live: { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number; target: Inkwell }[] = []
  private pool: THREE.Mesh[] = []
  private geometry = new THREE.SphereGeometry(0.09, 10, 8)

  constructor(private scene: THREE.Scene) {}

  emit(from: THREE.Vector3, well: Inkwell) {
    const mesh = this.pool.pop() ?? new THREE.Mesh(this.geometry, ink)
    mesh.position.copy(from)
    this.scene.add(mesh)
    this.live.push({ mesh, from: from.clone(), to: well.point.clone().setY(well.point.y - 0.15), t: 0, target: well })
  }

  /** Move them; returns the wells whose soul arrived this frame. */
  update(dt: number): Inkwell[] {
    const arrived: Inkwell[] = []
    for (const s of [...this.live]) {
      s.t += dt / QUEST.soulFlight
      const k = Math.min(1, s.t)
      s.mesh.position.lerpVectors(s.from, s.to, k)
      s.mesh.position.y += Math.sin(Math.PI * k) * 2.2
      s.mesh.scale.setScalar(1 + Math.sin(Math.PI * k) * 0.6)
      if (k >= 1) {
        arrived.push(s.target)
        s.mesh.removeFromParent()
        this.pool.push(s.mesh)
        this.live.splice(this.live.indexOf(s), 1)
      }
    }
    return arrived
  }

  clear() { for (const s of this.live) { s.mesh.removeFromParent(); this.pool.push(s.mesh) } this.live = [] }
  dispose() { this.clear(); this.geometry.dispose() }
}
