import * as THREE from 'three'
import { box, dark, gun, metal, part, path, tube, wood, type Gun, type V } from './common'

/**
 * Dead Ink's newer wall and box guns, drawn like the rest: paper faces, black contours, parts that move
 * (slide, magazine, bolt, lever, hammer) kept as their own groups so the first-person code can animate them.
 * Every piece is batched per moving part (common.ts), so a gun is a handful of draw calls however many
 * screws, pins and serrations it has.
 *
 *   buildBurstPistol  a long-slide service pistol: ported compensator, three-dot sights, fire selector, extended magazine
 *   buildPdw          a compact personal-defence SMG: ribbed receiver, railed top with a ring sight, flash hider, folded stock
 *   buildLeverRifle   a lever-action rifle: engraved receiver, octagonal barrel, buckhorn sights, tube magazine, loop lever and hammer
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

/** A screw head on a side face (+X or -X), its slot drawn across it. */
function screw(g: THREE.Object3D, side: 1 | -1, y: number, z: number, x: number, seed: number, r = 0.0042, turn = 0.6) {
  g.add(part(new THREE.CylinderGeometry(r, r, 0.002, 10), metal, [x + side * 0.001, y, z], [0, 0, 90]))
  g.add(line([[x + side * 0.0022, y - Math.sin(turn) * r * 0.8, z - Math.cos(turn) * r * 0.8], [x + side * 0.0022, y + Math.sin(turn) * r * 0.8, z + Math.cos(turn) * r * 0.8]], seed, 0.8))
}

/** A pin through the frame: a small round end on each side. */
function pin(g: THREE.Object3D, y: number, z: number, half: number, r = 0.0032) {
  for (const side of [-1, 1]) g.add(part(new THREE.CylinderGeometry(r, r, 0.002, 10), dark, [side * half, y, z], [0, 0, 90]))
}

/** Open-ended barrel with a recessed dark bore, so the muzzle sits on the visible opening. */
function bore(g: THREE.Object3D, radius: number, from: number, to: number, y: number, segments = 16) {
  g.add(part(new THREE.CylinderGeometry(radius, radius, to - from, segments, 1, true), metal, [0, y, (from + to) / 2], [90, 0, 0]))
  g.add(part(new THREE.RingGeometry(radius * 0.62, radius, segments), metal, [0, y, to]))
  g.add(part(new THREE.CircleGeometry(radius * 0.62, segments), dark, [0, y, to - 0.012]))
}

/**
 * The burst pistol: the service pistol's grip and frame under a longer slide that ends in a ported
 * compensator; three-dot sights, a fire selector with its three marks, slide stop and takedown levers, a
 * stippled grip with screwed panels, and a magazine that sticks out of the grip with witness holes down its
 * side. Held like the pistol.
 */
export function buildBurstPistol(): Gun {
  const axis = 0.084, muzzleZ = 0.236
  return gun('pistol', 'pistol', false, [0, axis, muzzleZ], [0.023, 0.089, 0.025], (g, parts) => {
    const grip = new THREE.Group()
    grip.rotation.x = THREE.MathUtils.degToRad(-14)
    grip.add(box(0.035, 0.108, 0.04, [0, 0, 0], dark))
    // Stippled panels screwed to each side, finger grooves down the front strap, a flared beavertail.
    for (const side of [-1, 1] as const) {
      grip.add(box(0.002, 0.076, 0.031, [side * 0.0182, -0.004, 0], dark))
      for (let row = 0; row < 7; row++) for (let col = 0; col < 3; col++) {
        grip.add(part(new THREE.CircleGeometry(0.0014, 5), metal, [side * 0.0194, -0.036 + row * 0.01, -0.009 + col * 0.009 + (row % 2) * 0.004], [0, side * 90, 0]))
      }
      screw(grip, side, 0.026, 0, side * 0.0192, 1310 + (side > 0 ? 1 : 0), 0.0035)
      screw(grip, side, -0.034, 0, side * 0.0192, 1312 + (side > 0 ? 1 : 0), 0.0035)
    }
    for (let i = 0; i < 3; i++) grip.add(line([[-0.014, -0.025 + i * 0.02, 0.0205], [0, -0.028 + i * 0.02, 0.0215], [0.014, -0.025 + i * 0.02, 0.0205]], 1320 + i, 1))
    grip.add(silhouette([[-0.02, 0.05], [-0.042, 0.058], [-0.046, 0.052], [-0.024, 0.04]], 0.03, dark))
    g.add(grip)

    // The extended magazine: longer than the grip, a base pad that sticks out below the fist, witness holes down one side.
    const magazine = new THREE.Group()
    magazine.rotation.x = grip.rotation.x
    magazine.add(box(0.027, 0.13, 0.03, [0, -0.028, 0], metal))
    magazine.add(box(0.034, 0.014, 0.04, [0, -0.096, 0], dark))
    magazine.add(box(0.036, 0.004, 0.042, [0, -0.1045, 0], metal))
    for (let i = 0; i < 4; i++) magazine.add(part(new THREE.CircleGeometry(0.0022, 8), dark, [0.0137, -0.045 - i * 0.012, 0.004], [0, 90, 0]))
    magazine.add(line([[0.0142, -0.085, -0.01], [0.0142, -0.085, 0.01]], 1330, 0.9))
    parts.magazine = magazine
    magazine.userData.grip = new THREE.Vector3(0, -0.096, 0)
    g.add(magazine)

    // Frame, dust cover with its accessory rail, the trigger guard's squared front, the magazine release.
    g.add(box(0.036, 0.026, 0.19, [0, 0.045, 0.058], dark))
    g.add(box(0.03, 0.008, 0.06, [0, 0.028, 0.13], dark))
    for (let i = 0; i < 4; i++) g.add(box(0.032, 0.004, 0.006, [0, 0.022, 0.108 + i * 0.014], metal))
    g.add(box(0.017, 0.008, 0.061, [0, -0.014, 0.049], dark))
    g.add(box(0.017, 0.049, 0.008, [0, 0.0065, 0.0795], dark))
    for (let i = 0; i < 4; i++) g.add(line([[0.009, -0.01 + i * 0.008, 0.0835], [-0.009, -0.01 + i * 0.008, 0.0835]], 1340 + i, 0.8))
    g.add(box(0.017, 0.03, 0.008, [0, -0.003, 0.019], dark))
    g.add(part(new THREE.CylinderGeometry(0.0045, 0.0045, 0.006, 10), metal, [-0.02, 0.028, 0.02], [0, 0, 90]))
    // The trigger with its safety blade.
    const trigger = new THREE.Group()
    trigger.position.set(0, 0.02, 0.047)
    trigger.add(box(0.007, 0.023, 0.008, [0, 0, 0], metal, [-18, 0, 0]))
    trigger.add(box(0.0025, 0.016, 0.009, [0, -0.002, 0.003], dark, [-18, 0, 0]))
    g.add(trigger)
    // The fire selector: a round switch with three pips (single, burst, safe) and marks engraved beside them.
    g.add(part(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 14), metal, [0.02, 0.05, 0.01], [0, 0, 90]))
    g.add(box(0.003, 0.004, 0.012, [0.0225, 0.052, 0.014], dark))
    for (let i = 0; i < 3; i++) g.add(part(new THREE.SphereGeometry(0.0017, 6, 4), dark, [0.0205, 0.06, 0.0 + i * 0.007]))
    g.add(line([[0.0202, 0.066, -0.002], [0.0202, 0.066, 0.003]], 1350, 0.8))
    g.add(line([[0.0202, 0.066, 0.005], [0.0202, 0.066, 0.009]], 1351, 0.8))
    g.add(line([[0.0202, 0.066, 0.012], [0.0202, 0.066, 0.016]], 1352, 0.8))
    // The slide stop and takedown levers on the left, each with its pin.
    g.add(box(0.003, 0.006, 0.03, [-0.0195, 0.052, 0.055], metal))
    g.add(part(new THREE.CylinderGeometry(0.004, 0.004, 0.003, 10), metal, [-0.0195, 0.052, 0.07], [0, 0, 90]))
    g.add(box(0.003, 0.008, 0.012, [-0.0195, 0.045, 0.095], metal))
    pin(g, 0.036, 0.07, 0.0185)

    // The slide: longer than the pistol's, serrations front and back, cut windows, the ejection port and its
    // extractor, three-dot sights, and flutes engraved along its flank.
    const slide = new THREE.Group()
    slide.add(box(0.04, 0.034, 0.262, [0, 0.083, 0.068]))
    slide.add(box(0.036, 0.011, 0.262, [0, 0.104, 0.068]))
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 6; i++) slide.add(box(0.002, 0.026, 0.003, [side * 0.0205, 0.083, -0.052 + i * 0.007], dark))
      for (let i = 0; i < 4; i++) slide.add(box(0.002, 0.018, 0.003, [side * 0.0205, 0.085, 0.158 + i * 0.007], dark))
      slide.add(box(0.002, 0.012, 0.05, [side * 0.0205, 0.094, 0.1], dark))
    }
    slide.add(box(0.002, 0.017, 0.05, [0.0206, 0.088, 0.04], dark))
    slide.add(box(0.003, 0.004, 0.02, [0.0212, 0.098, 0.02], metal))
    // Two engraved flutes along the left flank.
    slide.add(line([[-0.0212, 0.078, 0.02], [-0.0212, 0.078, 0.135]], 1360, 0.9))
    slide.add(line([[-0.0212, 0.072, 0.02], [-0.0212, 0.072, 0.135]], 1361, 0.9))
    // Rear sight: two posts, a white dot on each; front sight: one post and its dot.
    slide.add(box(0.036, 0.007, 0.014, [0, 0.113, -0.052], dark))
    for (const x of [-0.012, 0.012]) {
      slide.add(box(0.007, 0.012, 0.014, [x, 0.118, -0.052], dark))
      slide.add(part(new THREE.CircleGeometry(0.0022, 10), metal, [x, 0.121, -0.0448], [0, 180, 0]))
    }
    slide.add(box(0.008, 0.014, 0.012, [0, 0.116, 0.186], dark))
    slide.add(part(new THREE.CircleGeometry(0.0022, 10), metal, [0, 0.119, 0.1798], [0, 180, 0]))
    parts.slide = slide
    slide.userData.grip = new THREE.Vector3(0.035, 0.142, -0.03)
    g.add(slide)

    // The compensator: a squared block ahead of the slide, three ports in its top, vents down each side, a set
    // screw, and the barrel's crowned muzzle inside it.
    g.add(box(0.034, 0.03, 0.036, [0, axis, 0.218]))
    for (let i = 0; i < 3; i++) g.add(box(0.02, 0.003, 0.005, [0, axis + 0.0152, 0.206 + i * 0.01], dark))
    for (const side of [-1, 1] as const) for (let i = 0; i < 2; i++) g.add(box(0.002, 0.012, 0.005, [side * 0.0172, axis + 0.002, 0.21 + i * 0.012], dark))
    screw(g, -1, axis - 0.01, 0.228, -0.0172, 1370, 0.003)
    g.add(part(new THREE.RingGeometry(0.0055, 0.009, 12), metal, [0, axis, muzzleZ]))
    g.add(part(new THREE.RingGeometry(0.0045, 0.0055, 12), dark, [0, axis, muzzleZ + 0.0002]))
    g.add(part(new THREE.CircleGeometry(0.0045, 12), dark, [0, axis, muzzleZ - 0.01]))
    g.add(tube(0.005, 0.016, [0, 0.063, 0.2], dark))
  }, 'burst-pistol')
}

/**
 * The PDW: a squared receiver with a long straight magazine, a stubby shrouded barrel ending in a slotted
 * flash hider, a full-length rail carrying a hooded ring sight, pins and screws through the receiver, an
 * ejection port with its dust cover, a selector and magazine release, a folding stock hinged at the back and
 * a sling loop. Held like the SMG, in the firing hand, the other hand only for reloads.
 */
export function buildPdw(): Gun {
  const lift = 0.024, axis = 0.062 + lift, muzzleZ = 0.262
  return gun('smg', 'pistol', false, [0, axis, muzzleZ], [0.03, 0.074 + lift, 0.05], (g, parts) => {
    const upper = new THREE.Group()
    upper.position.y = lift
    g.add(upper)
    // A chunky receiver with a sloping front and a flat top.
    upper.add(silhouette([[-0.1, 0.03], [-0.1, 0.1], [0.14, 0.1], [0.17, 0.082], [0.17, 0.03]], 0.056, metal))
    // Ribbed sides, and the pins and screws that hold it together.
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 3; i++) upper.add(line([[side * 0.0285, 0.05 + i * 0.012, -0.08], [side * 0.0285, 0.05 + i * 0.012, 0.13]], 1400 + i + (side > 0 ? 10 : 0), 0.9))
      screw(upper, side, 0.088, -0.07, side * 0.0282, 1420 + (side > 0 ? 1 : 0))
      screw(upper, side, 0.088, 0.12, side * 0.0282, 1422 + (side > 0 ? 1 : 0))
    }
    pin(upper, 0.04, -0.05, 0.0285)
    pin(upper, 0.04, 0.09, 0.0285)
    // The ejection port and its dust cover, hinged along the bottom.
    upper.add(box(0.002, 0.018, 0.05, [0.0285, 0.07, 0.05], dark))
    upper.add(box(0.003, 0.004, 0.052, [0.0292, 0.0605, 0.05], metal))
    // A full-length rail on top, its teeth cut across it and its ends squared.
    upper.add(box(0.05, 0.008, 0.24, [0, 0.104, 0.03], dark))
    for (let i = 0; i < 12; i++) upper.add(box(0.052, 0.004, 0.007, [0, 0.109, -0.08 + i * 0.02], metal))
    for (const z of [-0.09, 0.15]) upper.add(box(0.054, 0.012, 0.006, [0, 0.106, z], metal))
    // The shrouded barrel: a vented tube ahead of the receiver, then a flash hider with four slots.
    upper.add(tube(0.017, 0.07, [0, 0.062, 0.205]))
    for (let i = 0; i < 4; i++) upper.add(box(0.036, 0.004, 0.006, [0, 0.062, 0.18 + i * 0.014], dark))
    upper.add(tube(0.012, 0.024, [0, 0.062, 0.25]))
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4
      upper.add(box(0.003, 0.003, 0.018, [Math.cos(a) * 0.0122, 0.062 + Math.sin(a) * 0.0122, 0.252], dark, [0, 0, i * 90 + 45]))
    }
    bore(upper, 0.008, 0.25, muzzleZ, 0.062, 12)
    // The ring sight: a hooded ring on a riser with windage and elevation knobs, a dot and cross hairs inside.
    upper.add(box(0.02, 0.012, 0.034, [0, 0.114, 0.03], dark))
    upper.add(box(0.012, 0.012, 0.02, [0, 0.124, 0.03], dark))
    upper.add(part(new THREE.TorusGeometry(0.014, 0.0038, 8, 24), metal, [0, 0.142, 0.03]))
    upper.add(part(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 18, 1, true), metal, [0, 0.142, 0.036], [90, 0, 0]))
    upper.add(part(new THREE.SphereGeometry(0.0022, 6, 4), dark, [0, 0.142, 0.03]))
    upper.add(line([[-0.009, 0.142, 0.03], [-0.004, 0.142, 0.03]], 1430, 0.7))
    upper.add(line([[0.004, 0.142, 0.03], [0.009, 0.142, 0.03]], 1431, 0.7))
    upper.add(part(new THREE.CylinderGeometry(0.004, 0.004, 0.006, 10), dark, [0.018, 0.142, 0.026], [0, 0, 90]))
    upper.add(part(new THREE.CylinderGeometry(0.004, 0.004, 0.006, 10), dark, [0, 0.16, 0.026]))
    // The folded stock: two rails along the left, a hinge of three knuckles at the back, a butt plate, and a
    // sling loop behind it.
    upper.add(box(0.008, 0.008, 0.13, [-0.034, 0.05, -0.05], dark))
    upper.add(box(0.008, 0.008, 0.13, [-0.034, 0.085, -0.05], dark))
    upper.add(box(0.01, 0.05, 0.012, [-0.034, 0.068, -0.115], dark))
    for (let i = 0; i < 3; i++) upper.add(part(new THREE.CylinderGeometry(0.006, 0.006, 0.01, 12), metal, [-0.03, 0.045 + i * 0.012, -0.1]))
    upper.add(part(new THREE.TorusGeometry(0.009, 0.0022, 6, 16), metal, [0, 0.04, -0.106], [0, 90, 0]))
    // The charging handle on top at the back, with the bolt face showing in the ejection port: the bolt
    // runs back with every shot.
    const bolt = new THREE.Group()
    bolt.position.set(0, 0.105 + lift, -0.075)
    bolt.add(box(0.03, 0.01, 0.018, [0, 0.004, 0], dark))
    for (let i = 0; i < 3; i++) bolt.add(line([[-0.012, 0.0095, -0.005 + i * 0.005], [0.012, 0.0095, -0.005 + i * 0.005]], 1440 + i, 0.7))
    bolt.add(box(0.002, 0.014, 0.03, [0.0272, -0.035, 0.125], metal))
    parts.bolt = bolt
    bolt.userData.grip = new THREE.Vector3(0, 0.012, 0)
    g.add(bolt)

    // Pistol grip with finger grooves and a textured back, the trigger in its guard, the selector.
    g.add(box(0.034, 0.12, 0.05, [0, 0.008, 0], dark, [-10, 0, 0]))
    for (const side of [-1, 1]) g.add(box(0.003, 0.06, 0.034, [side * 0.018, -0.008, 0], metal, [-10, 0, 0]))
    for (let i = 0; i < 3; i++) g.add(line([[-0.016, -0.035 + i * 0.02, 0.026], [0, -0.039 + i * 0.02, 0.028], [0.016, -0.035 + i * 0.02, 0.026]], 1450 + i, 1))
    for (let i = 0; i < 5; i++) g.add(line([[-0.014, -0.04 + i * 0.012, -0.026], [0.014, -0.04 + i * 0.012, -0.026]], 1460 + i, 0.7))
    g.add(box(0.012, 0.008, 0.07, [0, -0.02, 0.055], dark))
    g.add(box(0.012, 0.05, 0.008, [0, 0.005, 0.09], dark))
    g.add(box(0.007, 0.026, 0.007, [0, 0.025, 0.045], metal, [-15, 0, 0]))
    g.add(part(new THREE.CylinderGeometry(0.0065, 0.0065, 0.004, 12), metal, [-0.0295, 0.062, 0.012], [0, 0, 90]))
    g.add(box(0.003, 0.004, 0.014, [-0.0315, 0.064, 0.017], dark, [-30, 0, 0]))
    g.add(box(0.012, 0.006, 0.018, [0, 0.02, 0.108], metal))

    // The long straight magazine, well ahead of the grip, withdrawn down on a reload: ribs, witness holes, a base plate.
    const magazine = new THREE.Group()
    magazine.position.set(0, -0.045, 0.125)
    magazine.add(box(0.026, 0.19, 0.034, [0, -0.07, 0], metal))
    magazine.add(box(0.032, 0.01, 0.04, [0, -0.168, 0], dark))
    magazine.add(box(0.034, 0.003, 0.042, [0, -0.175, 0], metal))
    for (const side of [-1, 1]) magazine.add(line([[side * 0.0135, -0.02, 0.008], [side * 0.0135, -0.15, 0.008]], 1470 + (side > 0 ? 1 : 0), 0.9))
    for (let i = 0; i < 5; i++) magazine.add(part(new THREE.CircleGeometry(0.0022, 8), dark, [0.0132, -0.04 - i * 0.022, -0.006], [0, 90, 0]))
    parts.magazine = magazine
    magazine.userData.grip = new THREE.Vector3(0, -0.15, 0)
    g.add(magazine)
    g.add(box(0.036, 0.03, 0.05, [0, 0.03, 0.125], dark))
  }, 'pdw')
}

/**
 * The lever-action rifle: a wooden butt with a screwed butt plate and checkering at the wrist, an engraved
 * receiver with side-plate screws, a saddle ring and a loading gate on its right side, an octagonal barrel
 * over the tube magazine held by two bands, a buckhorn rear sight with its elevation ladder and a hooded
 * front bead, the fore-end capped in steel, and the loop lever and hammer, both worked after every shot.
 * Held in both hands like the shotgun.
 */
export function buildLeverRifle(): Gun {
  const axis = 0.09, muzzleZ = 0.72
  const result = gun('shotgun', 'shotgun', true, [0, axis, muzzleZ], [0.024, 0.1, 0.06], (g, parts) => {
    g.add(silhouette([
      [-0.26, -0.04], [-0.26, 0.068], [-0.18, 0.074], [-0.09, 0.064], [-0.045, 0.058], [-0.01, 0.056],
      [-0.01, 0.02], [-0.03, -0.035], [-0.058, 0.004], [-0.1, 0.025], [-0.185, -0.028],
    ], 0.04))
    // The steel butt plate and its two screws, and checkering across the wrist.
    g.add(box(0.044, 0.11, 0.012, [0, 0.014, -0.265], dark))
    for (const y of [0.05, -0.022]) g.add(part(new THREE.CylinderGeometry(0.004, 0.004, 0.002, 10), metal, [0, y, -0.2715], [90, 0, 0]))
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 5; i++) {
        g.add(line([[side * 0.0205, -0.012 + i * 0.008, -0.07], [side * 0.0205, 0.022 + i * 0.008, -0.03]], 1480 + i + (side > 0 ? 10 : 0), 0.7))
        g.add(line([[side * 0.0205, 0.022 + i * 0.008, -0.07], [side * 0.0205, -0.012 + i * 0.008, -0.03]], 1490 + i + (side > 0 ? 10 : 0), 0.7))
      }
    }
    // The receiver: flat sides engraved with a scroll, side-plate screws, the tang and its screw on top.
    g.add(box(0.042, 0.068, 0.16, [0, 0.074, 0.06]))
    for (const side of [-1, 1] as const) {
      g.add(line([[side * 0.0215, 0.06, 0.02], [side * 0.0215, 0.078, 0.04], [side * 0.0215, 0.066, 0.07], [side * 0.0215, 0.084, 0.1]], 1500 + (side > 0 ? 1 : 0), 1))
      g.add(line([[side * 0.0215, 0.09, 0.0], [side * 0.0215, 0.098, 0.02], [side * 0.0215, 0.09, 0.04]], 1502 + (side > 0 ? 1 : 0), 0.8))
      screw(g, side, 0.056, 0.0, side * 0.021, 1504 + (side > 0 ? 1 : 0))
      screw(g, side, 0.056, 0.125, side * 0.021, 1506 + (side > 0 ? 1 : 0))
      screw(g, side, 0.092, 0.06, side * 0.021, 1508 + (side > 0 ? 1 : 0), 0.0035)
    }
    g.add(box(0.016, 0.006, 0.05, [0, 0.106, -0.02]))
    g.add(part(new THREE.CylinderGeometry(0.004, 0.004, 0.002, 10), metal, [0, 0.11, -0.03]))
    // The saddle ring on its stud, on the left.
    g.add(part(new THREE.TorusGeometry(0.012, 0.0022, 6, 18), metal, [-0.026, 0.05, 0.0], [0, 90, 0]))
    g.add(part(new THREE.CylinderGeometry(0.003, 0.003, 0.006, 8), dark, [-0.0235, 0.061, 0.0], [0, 0, 90]))
    // The loading gate on the right: a spring cover over the port, where the free hand pushes rounds in.
    g.add(box(0.002, 0.018, 0.034, [0.0215, 0.06, 0.1], dark))
    g.add(box(0.002, 0.014, 0.03, [0.0222, 0.06, 0.1], metal))
    g.add(part(new THREE.CylinderGeometry(0.0025, 0.0025, 0.002, 8), dark, [0.0232, 0.06, 0.088], [0, 0, 90]))
    const loadingPort = new THREE.Object3D()
    loadingPort.position.set(0.026, 0.06, 0.1)
    loadingPort.userData.grip = new THREE.Vector3()
    parts.loadingPort = loadingPort
    g.add(loadingPort)
    // The hammer, its spur checkered: it rocks back as the lever is worked.
    const hammer = new THREE.Group()
    hammer.position.set(0, 0.106, -0.004)
    // At rest, cocked back.
    hammer.rotation.x = -0.55
    hammer.add(box(0.01, 0.026, 0.012, [0, 0.008, -0.004], dark, [-25, 0, 0]))
    hammer.add(box(0.014, 0.006, 0.016, [0, 0.02, -0.012], dark, [-10, 0, 0]))
    for (let i = 0; i < 3; i++) hammer.add(line([[-0.006, 0.0235, -0.018 + i * 0.005], [0.006, 0.0235, -0.018 + i * 0.005]], 1510 + i, 0.6))
    parts.hammer = hammer
    g.add(hammer)
    // The octagonal barrel (an eight-sided tube) and the tube magazine under it with its cap, held to the
    // fore-end by two bands, each with a screw.
    g.add(part(new THREE.CylinderGeometry(0.012, 0.012, muzzleZ - 0.14, 8, 1, true), metal, [0, axis, (0.14 + muzzleZ) / 2], [90, 22.5, 0]))
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4
      g.add(line([[Math.cos(a) * 0.0118, axis + Math.sin(a) * 0.0118, 0.15], [Math.cos(a) * 0.0118, axis + Math.sin(a) * 0.0118, muzzleZ - 0.004]], 1520 + i, 0.6))
    }
    g.add(part(new THREE.RingGeometry(0.007, 0.012, 8), metal, [0, axis, muzzleZ], [0, 0, 22.5]))
    g.add(part(new THREE.CircleGeometry(0.007, 12), dark, [0, axis, muzzleZ - 0.012]))
    g.add(tube(0.0085, 0.52, [0, 0.063, 0.4], dark))
    g.add(tube(0.0095, 0.014, [0, 0.063, 0.664], metal))
    g.add(part(new THREE.CylinderGeometry(0.0035, 0.0035, 0.002, 8), dark, [0, 0.063, 0.6715], [90, 0, 0]))
    for (const z of [0.36, 0.64]) {
      g.add(box(0.03, 0.05, 0.012, [0, 0.076, z], dark))
      g.add(part(new THREE.CylinderGeometry(0.003, 0.003, 0.002, 8), metal, [0.0155, 0.07, z], [0, 0, 90]))
    }
    g.add(silhouette([[0.14, 0.05], [0.14, 0.086], [0.38, 0.086], [0.4, 0.07], [0.38, 0.05]], 0.038))
    g.add(box(0.04, 0.038, 0.012, [0, 0.068, 0.395], metal))
    // Sights: a buckhorn rear with its notch, stepped elevation ladder and screw; a hooded front bead on a ramp.
    g.add(silhouette([[0.195, 0], [0.205, 0], [0.205, 0.012], [0.201, 0.018], [0.2, 0.012], [0.199, 0.018], [0.195, 0.012]], 0.03, dark, [0, axis + 0.012, 0]))
    for (let i = 0; i < 3; i++) g.add(box(0.012, 0.002, 0.004, [0, axis + 0.013 + i * 0.002, 0.212 + i * 0.004], metal))
    g.add(part(new THREE.CylinderGeometry(0.0025, 0.0025, 0.002, 8), dark, [0.012, axis + 0.016, 0.2], [0, 0, 90]))
    g.add(silhouette([[muzzleZ - 0.04, 0], [muzzleZ - 0.012, 0], [muzzleZ - 0.012, 0.012], [muzzleZ - 0.03, 0.006]], 0.008, dark, [0, axis + 0.011, 0]))
    g.add(part(new THREE.SphereGeometry(0.0026, 8, 6), metal, [0, axis + 0.026, muzzleZ - 0.02]))
    g.add(part(new THREE.CylinderGeometry(0.008, 0.008, 0.016, 12, 1, true), metal, [0, axis + 0.024, muzzleZ - 0.02], [90, 0, 0]))

    // The lever: a loop behind the trigger that swings down and forward on its pivot, and back; its latch
    // and pivot pin.
    const lever = new THREE.Group()
    lever.position.set(0, 0.03, 0.09)
    lever.add(box(0.01, 0.008, 0.12, [0, -0.012, -0.06], dark))
    lever.add(part(new THREE.TorusGeometry(0.03, 0.005, 8, 22, Math.PI * 1.2), metal, [0, -0.045, -0.105], [0, 90, 0]))
    lever.add(box(0.008, 0.03, 0.008, [0, -0.028, -0.02], metal))
    lever.add(box(0.012, 0.006, 0.01, [0, -0.02, -0.135], metal))
    lever.userData.grip = new THREE.Vector3(0, -0.06, -0.1)
    parts.lever = lever
    g.add(lever)
    pin(g, 0.03, 0.09, 0.0215, 0.0035)
    g.add(box(0.005, 0.02, 0.005, [0, 0.03, 0.05], metal, [-18, 0, 0]))
  }, 'lever-rifle')
  // The support hand under the fore-end.
  result.userData.support = new THREE.Vector3(0, 0.0, 0.3)
  return result
}
