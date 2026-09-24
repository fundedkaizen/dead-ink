import * as THREE from 'three'
import { box, gun, metal, part, path, type Gun, type V } from './common'

/** The bore line runs along +Z at this height above the firing grip. */
const AXIS = 0.08
/** The launch tube's radius; the warhead is fatter than the tube, as an RPG's is. */
const TUBE = 0.029
/** Where the tube's mouth is, and so where a loaded warhead sits. */
const MOUTH = 0.43

/** A band round the bore line. */
const band = (radius: number, z: number, y = AXIS, thickness = 0.0032) => part(new THREE.TorusGeometry(radius, thickness, 8, 32), metal, [0, y, z])
/** A cylinder or cone on the bore line: `front` and `rear` radii, centred at `z`. */
const round = (front: number, rear: number, length: number, z: number, y = AXIS, open = false) =>
  part(new THREE.CylinderGeometry(front, rear, length, 28, 1, open), metal, [0, y, z], [90, 0, 0])

/**
 * The warhead, from its base at the tube's mouth (z 0) forward: a thin tail boom that sits in the tube, a
 * fat body with two bands, a cone and the fuze at its tip. Drawn on the launcher and in flight alike.
 */
function warhead(g: THREE.Object3D) {
  g.add(round(0.014, 0.014, 0.16, -0.02, 0))
  g.add(round(0.037, 0.018, 0.03, 0.045, 0))
  g.add(round(0.043, 0.037, 0.12, 0.12, 0))
  g.add(round(0.012, 0.043, 0.13, 0.245, 0))
  g.add(round(0.006, 0.01, 0.03, 0.325, 0))
  g.add(band(0.0415, 0.085, 0))
  g.add(band(0.0438, 0.172, 0))
}

/**
 * Dead Ink's Ink Rocket, only ever from the Mystery Box: a shoulder launcher drawn after the RPG of Call of
 * Duty's zombies. A long tube flaring at the back, a heat shield wrapped round its middle, a pistol grip
 * and a front grip under it, a sight on its left (the side that faces the middle of the screen), and the
 * warhead sticking out of its mouth: its own part, so a reload can slide a fresh one in. Held like the AK
 * (a two-handed gun, the left hand on the front grip); paper and ink, no colour.
 */
export function buildInkRocket(): Gun {
  const result = gun('ak', 'ak', true, [0, AXIS, MOUTH], [0.05, AXIS, -0.1], (g, parts) => {
    // The tube, open at its mouth, with a lip round it and the dark of the bore just inside.
    g.add(round(TUBE, TUBE, 0.72, 0.07, AXIS, true))
    g.add(band(TUBE + 0.002, MOUTH - 0.004, AXIS, 0.004))
    g.add(part(new THREE.RingGeometry(TUBE * 0.78, TUBE, 28), metal, [0, AXIS, MOUTH]))
    g.add(part(new THREE.CircleGeometry(TUBE * 0.78, 28), metal, [0, AXIS, MOUTH - 0.03]))
    // The blast cone at the back, open, with a rim.
    g.add(round(TUBE, 0.047, 0.12, -0.35, AXIS, true))
    g.add(band(0.047, -0.41, AXIS, 0.004))
    // The heat shield: a sleeve round the middle, banded at both ends, its wrap drawn along it.
    g.add(round(0.036, 0.036, 0.3, -0.02))
    for (const z of [-0.17, 0.13]) g.add(band(0.037, z))
    for (const [i, a] of [0.6, 1.9, 3.3, 4.4].entries()) {
      const x = Math.cos(a) * 0.0368, y = AXIS + Math.sin(a) * 0.0368
      g.add(path([new THREE.Vector3(x, y, -0.155), new THREE.Vector3(x, y, 0.115)], 7100 + i, 1))
    }
    // The pistol grip, raked like the AK's, joined up to the tube by a block, with its guard and trigger.
    const grip = new THREE.Group()
    grip.rotation.x = THREE.MathUtils.degToRad(-14)
    grip.add(box(0.032, 0.104, 0.04, [0, -0.006, 0]))
    for (const y of [-0.03, -0.01, 0.01]) grip.add(path([new THREE.Vector3(-0.0162, y, 0.012), new THREE.Vector3(-0.0162, y - 0.004, -0.012)], 7110 + Math.round(y * 1000), 1))
    g.add(grip)
    g.add(box(0.028, 0.034, 0.05, [0, 0.03, 0.006]))
    g.add(part(new THREE.TorusGeometry(0.02, 0.0034, 8, 28, Math.PI), metal, [0, 0.016, 0.04], [0, 90, 180]))
    g.add(box(0.006, 0.022, 0.006, [0, 0.02, 0.046], metal, [-24, 0, 0]))
    // The front grip under the tube, clamped round it.
    g.add(box(0.028, 0.07, 0.034, [0, 0.012, 0.22], metal, [-6, 0, 0]))
    g.add(box(0.03, 0.016, 0.046, [0, AXIS - TUBE - 0.005, 0.22]))
    g.add(band(TUBE + 0.004, 0.22, AXIS, 0.005))
    // Sights: a rear leaf over the grip, a post near the mouth.
    g.add(box(0.022, 0.014, 0.008, [0, AXIS + 0.043, 0.0]))
    g.add(box(0.02, 0.01, 0.026, [0, AXIS + TUBE + 0.004, 0.36]))
    g.add(box(0.006, 0.026, 0.008, [0, AXIS + TUBE + 0.022, 0.36]))
    // A sight on its left, on a bracket: a box with a lens at each end.
    g.add(box(0.026, 0.012, 0.03, [0.045, AXIS + 0.004, 0.04]))
    g.add(box(0.02, 0.032, 0.074, [0.062, AXIS + 0.018, 0.04]))
    g.add(part(new THREE.CylinderGeometry(0.009, 0.009, 0.026, 16), metal, [0.062, AXIS + 0.022, -0.01], [90, 0, 0]))
    g.add(part(new THREE.CircleGeometry(0.007, 16), metal, [0.062, AXIS + 0.022, -0.0235], [0, 180, 0]))
    g.add(part(new THREE.CircleGeometry(0.009, 16), metal, [0.062, AXIS + 0.022, 0.0775]))
    // The warhead in its mouth: what a reload slides in and a shot sends away.
    const loaded = new THREE.Group()
    loaded.position.set(0, AXIS, MOUTH)
    warhead(loaded)
    // Where the free hand holds a fresh one while it slides it in: under the body.
    loaded.userData.grip = new THREE.Vector3(0, -0.05, 0.12)
    parts.warhead = loaded
    g.add(loaded)
  }, 'ink-rocket')
  // The support palm on the front grip.
  result.userData.support = new THREE.Vector3(0, -0.02, 0.22)
  return result
}

/**
 * The rocket in flight: the launcher's warhead with its four tail fins open. Its origin is the warhead's
 * base, as on the launcher, so it leaves the tube from exactly where it sat; nose along +Z.
 */
export function buildRocketRound(): Gun {
  return gun('ak', 'ak', false, [0, 0, 0.34], [0, 0, 0], g => {
    warhead(g)
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4
      const at: V = [Math.sin(a) * 0.026, Math.cos(a) * 0.026, -0.085]
      g.add(box(0.003, 0.03, 0.05, at, metal, [0, 0, -THREE.MathUtils.radToDeg(a)]))
    }
  }, 'ink-rocket-round')
}
