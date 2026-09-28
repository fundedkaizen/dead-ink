import * as THREE from 'three'
import { box, dark, gun, metal, part, path, tube, wood, type Gun, type V } from './common'

/**
 * Dead Ink's newer wall and box guns, drawn like the rest: paper faces, black contours, parts that move
 * (slide, magazine, lever) kept as their own groups so the first-person code can animate them.
 *
 *   buildBurstPistol  a long-slide service pistol with a ported compensator and an extended magazine
 *   buildPdw          a compact personal-defence SMG: squared receiver, long straight magazine, ring sight
 *   buildLeverRifle   a lever-action rifle: wooden stock and fore-end, octagonal barrel, tube magazine, loop lever
 */

/** Extrude a side silhouette ([Z, Y] points) across the gun's width: stocks and plates. */
function silhouette(points: [number, number][], width: number, material = wood, pos: V = [0, 0, 0]) {
  const shape = new THREE.Shape()
  points.forEach(([z, y], i) => i ? shape.lineTo(-z, y) : shape.moveTo(-z, y))
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false })
  geometry.rotateY(Math.PI / 2).translate(-width / 2, 0, 0)
  return part(geometry, material, pos)
}

const line = (points: V[], seed: number, width = 1.1) => path(points.map(p => new THREE.Vector3(...p)), seed, width)

/** Open-ended barrel with a recessed dark bore, so the muzzle sits on the visible opening. */
function bore(g: THREE.Object3D, radius: number, from: number, to: number, y: number, segments = 16) {
  g.add(part(new THREE.CylinderGeometry(radius, radius, to - from, segments, 1, true), metal, [0, y, (from + to) / 2], [90, 0, 0]))
  g.add(part(new THREE.RingGeometry(radius * 0.62, radius, segments), metal, [0, y, to]))
  g.add(part(new THREE.CircleGeometry(radius * 0.62, segments), dark, [0, y, to - 0.012]))
}

/**
 * The burst pistol: the service pistol's grip and frame under a longer slide that ends in a ported
 * compensator, a selector on the frame and a magazine that sticks out of the grip. Held like the pistol.
 */
export function buildBurstPistol(): Gun {
  const axis = 0.084, muzzleZ = 0.236
  return gun('pistol', 'pistol', false, [0, axis, muzzleZ], [0.023, 0.089, 0.025], (g, parts) => {
    const grip = new THREE.Group()
    grip.rotation.x = THREE.MathUtils.degToRad(-14)
    grip.add(box(0.035, 0.108, 0.04, [0, 0, 0], dark))
    // Stippled panels: rows of short dashes on each side.
    for (const side of [-1, 1]) {
      grip.add(box(0.002, 0.076, 0.031, [side * 0.0182, -0.004, 0], dark))
      for (let i = 0; i < 4; i++) grip.add(line([[side * 0.0195, -0.03 + i * 0.016, -0.01], [side * 0.0195, -0.03 + i * 0.016, 0.01]], 1300 + i + (side > 0 ? 10 : 0), 0.9))
    }
    g.add(grip)

    // The extended magazine: longer than the grip, a base pad that sticks out below the fist.
    const magazine = new THREE.Group()
    magazine.rotation.x = grip.rotation.x
    magazine.add(box(0.027, 0.13, 0.03, [0, -0.028, 0], metal))
    magazine.add(box(0.034, 0.014, 0.04, [0, -0.096, 0], dark))
    magazine.add(line([[0.0142, -0.085, -0.01], [0.0142, -0.085, 0.01]], 1320, 0.9))
    parts.magazine = magazine
    magazine.userData.grip = new THREE.Vector3(0, -0.096, 0)
    g.add(magazine)

    // Frame, dust cover with a short rail, and the trigger guard's open loop.
    g.add(box(0.036, 0.026, 0.19, [0, 0.045, 0.058], dark))
    g.add(box(0.03, 0.008, 0.06, [0, 0.028, 0.13], dark))
    for (let i = 0; i < 4; i++) g.add(box(0.032, 0.004, 0.006, [0, 0.022, 0.108 + i * 0.014], metal))
    g.add(box(0.017, 0.008, 0.061, [0, -0.014, 0.049], dark))
    g.add(box(0.017, 0.049, 0.008, [0, 0.0065, 0.0795], dark))
    g.add(box(0.017, 0.03, 0.008, [0, -0.003, 0.019], dark))
    g.add(box(0.007, 0.023, 0.008, [0, 0.02, 0.047], metal, [-18, 0, 0]))
    // The fire selector: a round switch on the frame with three pips (single, burst, safe).
    g.add(part(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 14), metal, [0.02, 0.05, 0.01], [0, 0, 90]))
    g.add(box(0.003, 0.004, 0.012, [0.0225, 0.052, 0.014], dark))
    for (let i = 0; i < 3; i++) g.add(part(new THREE.SphereGeometry(0.0017, 6, 4), dark, [0.0205, 0.06, 0.0 + i * 0.007]))

    // The slide: longer than the pistol's, with serrations front and back, cut windows and its sights.
    const slide = new THREE.Group()
    slide.add(box(0.04, 0.034, 0.262, [0, 0.083, 0.068]))
    slide.add(box(0.036, 0.011, 0.262, [0, 0.104, 0.068]))
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) slide.add(box(0.002, 0.026, 0.003, [side * 0.0205, 0.083, -0.05 + i * 0.008], dark))
      for (let i = 0; i < 3; i++) slide.add(box(0.002, 0.018, 0.003, [side * 0.0205, 0.085, 0.16 + i * 0.008], dark))
      slide.add(box(0.002, 0.012, 0.05, [side * 0.0205, 0.094, 0.1], dark))
    }
    slide.add(box(0.036, 0.007, 0.014, [0, 0.113, -0.052], dark))
    slide.add(box(0.007, 0.012, 0.014, [-0.012, 0.118, -0.052], dark))
    slide.add(box(0.007, 0.012, 0.014, [0.012, 0.118, -0.052], dark))
    slide.add(box(0.008, 0.014, 0.012, [0, 0.116, 0.186], dark))
    parts.slide = slide
    slide.userData.grip = new THREE.Vector3(0.035, 0.142, -0.03)
    g.add(slide)

    // The compensator: a squared block ahead of the slide, three ports cut in its top.
    g.add(box(0.034, 0.03, 0.036, [0, axis, 0.218]))
    for (let i = 0; i < 3; i++) g.add(box(0.02, 0.003, 0.005, [0, axis + 0.0152, 0.206 + i * 0.01], dark))
    g.add(part(new THREE.RingGeometry(0.0055, 0.009, 12), metal, [0, axis, muzzleZ]))
    g.add(part(new THREE.CircleGeometry(0.0055, 12), dark, [0, axis, muzzleZ - 0.01]))
    g.add(tube(0.005, 0.016, [0, 0.063, 0.2], dark))
  }, 'burst-pistol')
}

/**
 * The PDW: a squared receiver with a long straight magazine, a stubby shrouded barrel, a folding stock
 * and a ring sight on top. Held like the SMG, in the firing hand, the other hand only for reloads.
 */
export function buildPdw(): Gun {
  const lift = 0.024, axis = 0.062 + lift, muzzleZ = 0.25
  return gun('smg', 'pistol', false, [0, axis, muzzleZ], [0.03, 0.074 + lift, 0.05], (g, parts) => {
    const upper = new THREE.Group()
    upper.position.y = lift
    g.add(upper)
    // A chunky receiver with a sloping front and a flat top rail.
    upper.add(silhouette([[-0.1, 0.03], [-0.1, 0.1], [0.14, 0.1], [0.17, 0.082], [0.17, 0.03]], 0.056, metal))
    upper.add(box(0.05, 0.008, 0.2, [0, 0.104, 0.02], dark))
    for (let i = 0; i < 8; i++) upper.add(box(0.052, 0.004, 0.006, [0, 0.109, -0.06 + i * 0.022], metal))
    // Ribbed sides: grooves along the receiver.
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) upper.add(line([[side * 0.0285, 0.05 + i * 0.012, -0.08], [side * 0.0285, 0.05 + i * 0.012, 0.13]], 1400 + i + (side > 0 ? 10 : 0), 0.9))
    // The shrouded barrel: a vented tube ahead of the receiver.
    upper.add(tube(0.017, 0.07, [0, 0.062, 0.205]))
    for (let i = 0; i < 4; i++) upper.add(box(0.036, 0.004, 0.006, [0, 0.062, 0.18 + i * 0.014], dark))
    bore(upper, 0.009, 0.235, muzzleZ, 0.062, 12)
    // The ring sight: a round hood on a riser, a dot in the middle.
    upper.add(box(0.02, 0.018, 0.03, [0, 0.12, 0.03], dark))
    upper.add(part(new THREE.TorusGeometry(0.014, 0.0038, 8, 24), metal, [0, 0.142, 0.03]))
    upper.add(part(new THREE.SphereGeometry(0.0022, 6, 4), dark, [0, 0.142, 0.03]))
    // The folded stock: two rails and a butt plate along the left side.
    upper.add(box(0.008, 0.008, 0.13, [-0.034, 0.05, -0.05], dark))
    upper.add(box(0.008, 0.008, 0.13, [-0.034, 0.085, -0.05], dark))
    upper.add(box(0.01, 0.05, 0.012, [-0.034, 0.068, -0.115], dark))
    // The charging handle on top at the back.
    const bolt = new THREE.Group()
    bolt.position.set(0, 0.105 + lift, -0.075)
    bolt.add(box(0.03, 0.01, 0.018, [0, 0.004, 0], dark))
    parts.bolt = bolt
    bolt.userData.grip = new THREE.Vector3(0, 0.012, 0)
    g.add(bolt)

    // Pistol grip and trigger guard.
    g.add(box(0.034, 0.12, 0.05, [0, 0.008, 0], dark, [-10, 0, 0]))
    for (const side of [-1, 1]) g.add(box(0.003, 0.06, 0.034, [side * 0.018, -0.008, 0], metal, [-10, 0, 0]))
    g.add(box(0.012, 0.008, 0.07, [0, -0.02, 0.055], dark))
    g.add(box(0.012, 0.05, 0.008, [0, 0.005, 0.09], dark))
    g.add(box(0.007, 0.026, 0.007, [0, 0.025, 0.045], metal, [-15, 0, 0]))

    // The long straight magazine, well ahead of the grip, withdrawn down on a reload.
    const magazine = new THREE.Group()
    magazine.position.set(0, -0.045, 0.125)
    magazine.add(box(0.026, 0.19, 0.034, [0, -0.07, 0], metal))
    magazine.add(box(0.032, 0.01, 0.04, [0, -0.168, 0], dark))
    for (const side of [-1, 1]) magazine.add(line([[side * 0.0135, -0.02, 0.008], [side * 0.0135, -0.15, 0.008]], 1430 + (side > 0 ? 1 : 0), 0.9))
    parts.magazine = magazine
    magazine.userData.grip = new THREE.Vector3(0, -0.15, 0)
    g.add(magazine)
    g.add(box(0.036, 0.03, 0.05, [0, 0.03, 0.125], dark))
  }, 'pdw')
}

/**
 * The lever-action rifle: a wooden butt and fore-end, a receiver with a loading gate on its right side, an
 * octagonal barrel over the tube magazine, open sights, and the loop lever under the grip, worked after
 * every shot. Held in both hands like the shotgun.
 */
export function buildLeverRifle(): Gun {
  const axis = 0.09, muzzleZ = 0.72
  const result = gun('shotgun', 'shotgun', true, [0, axis, muzzleZ], [0.024, 0.1, 0.06], (g, parts) => {
    g.add(silhouette([
      [-0.26, -0.04], [-0.26, 0.068], [-0.18, 0.074], [-0.09, 0.064], [-0.045, 0.058], [-0.01, 0.056],
      [-0.01, 0.02], [-0.03, -0.035], [-0.058, 0.004], [-0.1, 0.025], [-0.185, -0.028],
    ], 0.04))
    g.add(box(0.044, 0.11, 0.012, [0, 0.014, -0.265], dark))
    // The receiver: flat sides with a scroll engraved on each, and the loading gate on the right.
    g.add(box(0.042, 0.068, 0.16, [0, 0.074, 0.06]))
    for (const side of [-1, 1]) {
      g.add(line([[side * 0.0215, 0.06, 0.02], [side * 0.0215, 0.078, 0.04], [side * 0.0215, 0.066, 0.07], [side * 0.0215, 0.084, 0.1]], 1500 + (side > 0 ? 1 : 0), 1))
    }
    g.add(box(0.002, 0.018, 0.034, [0.0215, 0.06, 0.1], dark))
    const loadingPort = new THREE.Object3D()
    loadingPort.position.set(0.026, 0.06, 0.1)
    loadingPort.userData.grip = new THREE.Vector3()
    parts.loadingPort = loadingPort
    g.add(loadingPort)
    // The hammer at the back of the receiver.
    g.add(box(0.01, 0.024, 0.014, [0, 0.112, -0.012], dark, [-25, 0, 0]))
    // The octagonal barrel (an eight-sided tube) and the tube magazine under it, banded to the fore-end.
    g.add(part(new THREE.CylinderGeometry(0.012, 0.012, muzzleZ - 0.14, 8, 1, true), metal, [0, axis, (0.14 + muzzleZ) / 2], [90, 22.5, 0]))
    g.add(part(new THREE.RingGeometry(0.007, 0.012, 8), metal, [0, axis, muzzleZ], [0, 0, 22.5]))
    g.add(part(new THREE.CircleGeometry(0.007, 12), dark, [0, axis, muzzleZ - 0.012]))
    g.add(tube(0.0085, 0.52, [0, 0.063, 0.4], dark))
    for (const z of [0.36, 0.64]) g.add(box(0.03, 0.05, 0.012, [0, 0.076, z], dark))
    g.add(silhouette([[0.14, 0.05], [0.14, 0.086], [0.38, 0.086], [0.4, 0.07], [0.38, 0.05]], 0.038))
    // Open sights: a buckhorn at the back of the barrel and a blade at the muzzle.
    g.add(box(0.026, 0.012, 0.006, [0, axis + 0.018, 0.2], dark))
    g.add(box(0.004, 0.016, 0.01, [0, axis + 0.018, muzzleZ - 0.02], dark))

    // The lever: a loop behind the trigger that swings down and forward on its pivot, and back.
    const lever = new THREE.Group()
    lever.position.set(0, 0.03, 0.09)
    lever.add(box(0.01, 0.008, 0.12, [0, -0.012, -0.06], dark))
    lever.add(part(new THREE.TorusGeometry(0.03, 0.005, 8, 22, Math.PI * 1.2), metal, [0, -0.045, -0.105], [0, 90, 0]))
    lever.add(box(0.008, 0.03, 0.008, [0, -0.028, -0.02], metal))
    lever.userData.grip = new THREE.Vector3(0, -0.06, -0.1)
    parts.lever = lever
    g.add(lever)
    g.add(box(0.005, 0.02, 0.005, [0, 0.03, 0.05], metal, [-18, 0, 0]))
  }, 'lever-rifle')
  // The support hand under the fore-end.
  result.userData.support = new THREE.Vector3(0, 0.0, 0.3)
  return result
}
