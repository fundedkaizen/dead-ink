import * as THREE from 'three'
import { box, gun, metal, part, path, tube, type Gun, type V } from './common'

/** The bore line: the barrel runs along +Z at this height above the grip. */
const AXIS = 0.1
/** The Ink Cannon's ink: a deep violet-blue, the colour of fountain-pen ink, and its only colour. */
export const CANNON_INK = 0x3b2bd6
export const CANNON_INK_PACKED = 0xd4332a
let materials: { ink: THREE.MeshBasicMaterial; inkPacked: THREE.MeshBasicMaterial; glass: THREE.MeshBasicMaterial } | null = null
function inks() {
  if (materials) return materials
  const ink = new THREE.MeshBasicMaterial({ color: CANNON_INK, toneMapped: false })
  const inkPacked = new THREE.MeshBasicMaterial({ color: CANNON_INK_PACKED, toneMapped: false })
  const glass = new THREE.MeshBasicMaterial({ color: 0xdfe4ff, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false })
  // The ink in the tank sloshes a little: its colour breathes, held still under reduced motion.
  for (const [material, hex] of [[ink, CANNON_INK], [inkPacked, CANNON_INK_PACKED]] as const) {
    const base = new THREE.Color(hex)
    material.onBeforeRender = () => {
      const still = typeof document !== 'undefined' && document.body?.dataset.reducedMotion === 'true'
      const t = still ? 0 : performance.now() / 1000
      material.color.copy(base).multiplyScalar(0.85 + 0.2 * Math.sin(t * 2.4))
    }
  }
  materials = { ink, inkPacked, glass }
  return materials
}

const ring = (r: number, t: number, pos: V, rot: V = [90, 0, 0]) => part(new THREE.TorusGeometry(r, t, 8, 28), metal, pos, rot)

/**
 * Dead Ink's second wonder weapon, the Ink Cannon: a stubby hand cannon with a flared bell mouth, a glass
 * ink tank riding on top of the breech, brass bands round the barrel and a pump grip underneath. Held in
 * both hands. The tank's ink level (`parts.tank`'s `level` child) rises while the trigger is held to charge,
 * and the grip canister (`parts.magazine`) drops out on a reload. Paper and ink, the ink its only colour.
 */
export function buildInkCannon(packed = false): Gun {
  const muzzleZ = 0.44
  const result = gun('shotgun', 'shotgun', true, [0, AXIS, muzzleZ], [0.03, AXIS, 0.02], (g, parts) => {
    // The pistol grip and a short, thick stock shoulder.
    const grip = new THREE.Group()
    grip.rotation.x = THREE.MathUtils.degToRad(-12)
    grip.add(part(new THREE.CapsuleGeometry(0.02, 0.07, 6, 14).scale(0.95, 1, 1.15), metal, [0, -0.004, 0]))
    for (const [i, y] of [-0.026, -0.006, 0.014].entries()) grip.add(path([new THREE.Vector3(-0.014, y, 0.019), new THREE.Vector3(0, y - 0.003, 0.023), new THREE.Vector3(0.014, y, 0.019)], 1600 + i, 1.1))
    g.add(grip)
    g.add(box(0.05, 0.05, 0.12, [0, 0.07, -0.1]))
    g.add(box(0.056, 0.074, 0.02, [0, 0.062, -0.165]))
    // The trigger in a round guard.
    g.add(part(new THREE.TorusGeometry(0.022, 0.0035, 8, 24, Math.PI), metal, [0, 0.03, 0.035], [0, 90, 180]))
    g.add(box(0.006, 0.024, 0.006, [0, 0.03, 0.04], metal, [-20, 0, 0]))

    // The breech: a fat drum the barrel grows out of, riveted round its face.
    g.add(part(new THREE.CylinderGeometry(0.058, 0.058, 0.12, 28), metal, [0, AXIS, 0.03], [90, 0, 0]))
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2
      g.add(part(new THREE.SphereGeometry(0.004, 6, 4), metal, [Math.cos(a) * 0.05, AXIS + Math.sin(a) * 0.05, 0.091]))
    }
    // The barrel tapers out of the drum, banded twice, then flares into the bell mouth with a heavy lip.
    g.add(part(new THREE.CylinderGeometry(0.036, 0.046, 0.2, 24, 1, true), metal, [0, AXIS, 0.19], [90, 0, 0]))
    g.add(ring(0.045, 0.007, [0, AXIS, 0.12]))
    g.add(ring(0.039, 0.006, [0, AXIS, 0.26]))
    g.add(part(new THREE.CylinderGeometry(0.066, 0.036, 0.15, 28, 1, true), metal, [0, AXIS, 0.36], [90, 0, 0]))
    g.add(ring(0.066, 0.008, [0, AXIS, muzzleZ - 0.002]))
    // The bore, dark inside the bell.
    g.add(part(new THREE.CircleGeometry(0.034, 24), metal, [0, AXIS, 0.29]))

    // The pump grip under the barrel, ribbed, where the support hand sits.
    const pump = new THREE.Group()
    pump.position.set(0, AXIS - 0.058, 0.2)
    pump.add(box(0.044, 0.036, 0.11, [0, 0, 0]))
    for (let i = 0; i < 5; i++) pump.add(box(0.046, 0.004, 0.004, [0, -0.018, -0.044 + i * 0.022]))
    g.add(pump)
    g.add(box(0.012, 0.03, 0.02, [0, AXIS - 0.035, 0.2]))

    // The ink tank on the breech: a glass drum in a frame, the ink inside (added after batching).
    const tank = new THREE.Group()
    tank.position.set(0, AXIS + 0.08, 0.02)
    tank.add(ring(0.036, 0.005, [0, 0, 0.055], [0, 0, 0]))
    tank.add(ring(0.036, 0.005, [0, 0, -0.055], [0, 0, 0]))
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + Math.PI / 4
      tank.add(tube(0.003, 0.11, [Math.cos(a) * 0.036, Math.sin(a) * 0.036, 0], metal))
    }
    tank.add(box(0.02, 0.03, 0.02, [0, -0.045, 0]))
    parts.tank = tank
    g.add(tank)
    // A filler cap and a pressure gauge on the tank.
    g.add(part(new THREE.CylinderGeometry(0.011, 0.013, 0.012, 14), metal, [0, AXIS + 0.124, 0.02]))
    g.add(part(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 18), metal, [0.04, AXIS + 0.055, -0.04], [0, 0, 90]))
    g.add(path([new THREE.Vector3(0.0445, AXIS + 0.055, -0.04), new THREE.Vector3(0.0445, AXIS + 0.063, -0.034)], 1630, 1.3))

    // The canister: a fat cartridge of ink that seats in the side of the breech, the Ink Cannon's magazine.
    const canister = new THREE.Group()
    canister.position.set(-0.058, AXIS - 0.01, 0.0)
    canister.add(tube(0.02, 0.07, [0, 0, 0], metal, [90, 0, 0]))
    canister.add(ring(0.02, 0.004, [0, 0, 0.03], [0, 0, 0]))
    canister.add(ring(0.02, 0.004, [0, 0, -0.03], [0, 0, 0]))
    canister.userData.grip = new THREE.Vector3(-0.01, -0.02, 0)
    parts.magazine = canister
    g.add(canister)
  }, 'ink-cannon')
  // The ink: in the tank (its level rises as a shot charges) and in the mouth of the bell.
  const { ink, inkPacked, glass } = inks()
  const colour = packed ? inkPacked : ink
  const tank = result.userData.parts.tank
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.104, 22, 1, true).rotateX(Math.PI / 2), glass)
  shell.name = 'Ink Cannon tank glass'
  shell.userData.noCollision = true
  tank.add(shell)
  const level = new THREE.Group()
  level.name = 'Ink Cannon tank level'
  const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.1, 22).rotateX(Math.PI / 2), colour)
  fill.name = 'Ink Cannon ink'
  level.add(fill)
  level.position.y = -0.012
  level.scale.y = 0.55
  tank.add(level)
  tank.userData.level = level
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.032, 24), colour)
  mouth.name = 'Ink Cannon mouth ink'
  mouth.position.set(0, AXIS, 0.292)
  result.add(mouth)
  result.userData.support = new THREE.Vector3(0, AXIS - 0.08, 0.2)
  return result
}

/**
 * Show how charged a shot is: the ink in the tank rises from its resting level to the brim, and the tank
 * swells a little at full charge. `charge` 0 to 1.
 */
export function setCannonCharge(model: THREE.Object3D, charge: number) {
  const tank = (model as Gun).userData.parts?.tank
  const level = tank?.userData.level as THREE.Object3D | undefined
  if (!tank || !level) return
  const c = THREE.MathUtils.clamp(charge, 0, 1)
  level.scale.y = 0.55 + 0.45 * c
  level.position.y = -0.012 * (1 - c)
  tank.scale.setScalar(1 + 0.08 * c * c)
}
