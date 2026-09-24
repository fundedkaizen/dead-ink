import * as THREE from 'three'
import { Draft, wallText } from '../../render/ink'
import type { WallSpot } from './placement'

/**
 * The Ink Doll, Dead Ink's Monkey Bomb: a wind-up paper toy that bangs its cymbals where it lands. Every
 * zombie drops what it is doing and goes for it, then it goes off and takes them with it. Bought off a
 * wall in the warehouse, three at a time; a Max Ammo tops them up. Thrown with E (or T, which the pad sends).
 */
export const DECOY = { price: 3000, carry: 3, lure: 7, radius: 7, cooldown: 1 } as const

const ink = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
const paper = new THREE.MeshBasicMaterial({ color: 0xfbfaf5, toneMapped: false })
const brass = new THREE.MeshBasicMaterial({ color: 0xd8b24a, toneMapped: false })
const red = new THREE.MeshBasicMaterial({ color: 0xc8322d, toneMapped: false })
const rim = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false })

/** The doll: a paper body with an ink fez and eyes, a big wind-up key in its back, a cymbal in each hand. */
export function inkDoll() {
  const g = new THREE.Group()
  g.name = 'Ink doll'
  const outline = (mesh: THREE.Mesh, grow = 1.12) => {
    const shell = new THREE.Mesh(mesh.geometry, rim)
    shell.position.copy(mesh.position); shell.rotation.copy(mesh.rotation); shell.scale.copy(mesh.scale).multiplyScalar(grow)
    g.add(shell)
  }
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.1, 12), paper)
  body.position.y = 0.06
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), paper)
  head.position.y = 0.145
  const fez = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.035, 10), red)
  fez.position.y = 0.2
  g.add(body, head, fez)
  outline(body); outline(head); outline(fez, 1.18)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), ink)
    eye.position.set(side * 0.018, 0.152, 0.04)
    g.add(eye)
    // Arms out to the side, a brass cymbal on each; they clap in update().
    const arm = new THREE.Group()
    arm.name = side < 0 ? 'Doll arm left' : 'Doll arm right'
    arm.position.set(side * 0.05, 0.09, 0)
    const limb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.014, 0.014), ink)
    limb.position.x = side * 0.025
    const cymbal = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.004, 16), brass)
    cymbal.rotation.z = Math.PI / 2
    cymbal.position.x = side * 0.052
    arm.add(limb, cymbal)
    g.add(arm)
  }
  const key = new THREE.Group()
  key.name = 'Doll key'
  key.position.set(0, 0.07, -0.06)
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.03, 6), ink)
  shaft.rotation.x = Math.PI / 2
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.005, 6, 14), ink)
  bow.position.z = -0.02
  key.add(shaft, bow)
  g.add(key)
  return g
}

/** Clap the cymbals and turn the key: `t` in seconds since it started. */
export function animateDoll(doll: THREE.Object3D, t: number) {
  const clap = Math.abs(Math.sin(t * 9))
  const left = doll.getObjectByName('Doll arm left'), right = doll.getObjectByName('Doll arm right')
  if (left) left.rotation.y = -0.9 * (1 - clap)
  if (right) right.rotation.y = 0.9 * (1 - clap)
  const key = doll.getObjectByName('Doll key')
  if (key) key.rotation.z = t * 4
}

/** Free a doll's geometry (its materials are shared). */
export function disposeDoll(doll: THREE.Object3D) {
  doll.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
}

/** The wall where you buy them: a paper sheet with a doll on a little shelf and the price. */
export class DollBuy {
  readonly root = new THREE.Group()
  readonly point: THREE.Vector3
  private doll = inkDoll()

  constructor(readonly spot: WallSpot) {
    this.root.name = 'Wall buy · ink dolls'
    this.root.userData.noCollision = true
    const centre = spot.wall.clone().addScaledVector(spot.normal, 0.025).setY(spot.stand.y + 1.35)
    this.root.position.copy(centre)
    this.root.rotation.y = Math.atan2(spot.normal.x, spot.normal.z)
    const sheet = new Draft('Wall buy sheet · ink dolls')
    sheet.box(0.8, 0.62, 0.015, 0, 0, 0, 'paper', 'edge')
    sheet.box(0.3, 0.02, 0.1, 0, -0.08, 0.05, 'paper', 'edge')
    sheet.finish()
    this.root.add(sheet)
    const doll = this.doll
    doll.position.set(0, -0.07, 0.07)
    doll.scale.setScalar(1.4)
    doll.rotation.y = 0.3
    this.root.add(doll, wallText(String(DECOY.price), [0, -0.23, 0.02], 0.14))
    this.point = centre.clone()
  }

  dispose() {
    disposeDoll(this.doll)
    this.root.removeFromParent()
  }
}
