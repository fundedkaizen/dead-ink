import * as THREE from 'three'
import { disposeGun, type Gun } from '../lab/weapons/models'
import type { WeaponItem } from './types'

/**
 * Dead Ink's Deadline: the Pack-a-Punched Magnum is a pair, one in each hand, as Call of Duty's Mustang &
 * Sally. The left hand holds a second revolver posed as the right one's mirror image, with its own kick and
 * muzzle flash, and the two take turns. FirstPersonWeapons poses it from the right hand's grip; this file
 * builds it and keeps it looking like its twin. No other gun is ever held this way.
 *
 * Only the pose and the mitten are mirrored, not the gun: a mirrored drawing turns its pen strokes inside
 * out and they vanish, and a revolver in the left hand is the same revolver anyway.
 */
export const isAkimbo = (item: Pick<WeaponItem, 'name' | 'packed'> | null | undefined) => item?.name === 'magnum' && !!item.packed

/** Which hand fires next: they take turns, the right first from a full load (`capacity` counts both guns). */
export const firingHand = (magazine: number, capacity: number): 'right' | 'left' => (capacity - magazine) % 2 === 0 ? 'right' : 'left'

export type Kick = { value: number; velocity: number; roll: number; rollVelocity: number }

export class Offhand {
  /** The left grip, posed as the right hand's grip mount is, across the middle of the view. */
  readonly mount = new THREE.Group()
  readonly kick: Kick = { value: 0, velocity: 0, roll: 0, rollVelocity: 0 }
  flashTime = 0
  flashScale = 1
  /** Each piece of the left gun, by the drawing it shares with its twin in the right hand. */
  private twins = new Map<THREE.BufferGeometry, THREE.Mesh>()

  /** `hand` and `flash` are copies of the right hand's mitten and muzzle flash; the mitten is turned into a left one. */
  constructor(parent: THREE.Object3D, readonly model: Gun, private right: Gun, readonly hand: THREE.Object3D, readonly flash: THREE.Mesh) {
    this.mount.name = 'Left hand revolver'
    this.mount.userData.noCollision = true
    hand.name = 'Left hand mitten'
    hand.scale.x = -1
    flash.visible = false
    this.mount.add(model, hand, flash)
    parent.add(this.mount)
    model.traverse(object => { if (object instanceof THREE.Mesh) this.twins.set(object.geometry, object) })
  }

  /**
   * Look like the right one, piece by piece: the Pack-a-Punch shimmer, a Mythic's dragon, and its moving
   * parts where the right one's are (the cylinder swinging out on a reload).
   */
  match() {
    this.right.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      const twin = this.twins.get(object.geometry)
      if (twin && twin.material !== object.material) twin.material = object.material
    })
    for (const [name, part] of Object.entries(this.right.userData.parts)) {
      const twin = this.model.userData.parts[name]
      if (twin) { twin.position.copy(part.position); twin.quaternion.copy(part.quaternion) }
    }
  }

  reset() {
    this.kick.value = this.kick.velocity = this.kick.roll = this.kick.rollVelocity = 0
    this.flashTime = 0
    this.flash.visible = false
  }

  dispose() {
    this.mount.removeFromParent()
    // The mitten and the flash share the right hand's shapes and ink: only the gun is this one's own.
    this.hand.removeFromParent(); this.flash.removeFromParent()
    disposeGun(this.model)
  }
}
