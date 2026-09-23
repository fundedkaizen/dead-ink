import * as THREE from 'three'
import { box, dark, gun, metal, part, tube, type Gun } from './common'

/**
 * Dead Ink's wonder weapon, the Ink Ray: a ray gun held like the pistol (same grip, same hand) so every
 * pose carries over. A rounded body with rings, three fins round a flared emitter, and a glass chamber
 * that glows green (colour means it: this is the one gun that is not just a gun).
 */
export function buildInkRay(): Gun {
  const result = gun('pistol', 'pistol', false, [0, 0.06, 0.25], [0.02, 0.07, 0.05], (g, parts) => {
    // Grip and trigger where the pistol's are.
    g.add(box(0.032, 0.11, 0.045, [0, -0.01, -0.005], dark, [-12, 0, 0]))
    g.add(box(0.012, 0.03, 0.03, [0, 0.03, 0.035], metal))
    // The body: a fat rounded cylinder along the barrel, banded with rings.
    const body = new THREE.CylinderGeometry(0.036, 0.042, 0.16, 20)
    g.add(part(body, metal, [0, 0.06, 0.07], [90, 0, 0]))
    for (const z of [0.015, 0.075, 0.13]) g.add(tube(0.045, 0.012, [0, 0.06, z], dark))
    // Emitter: a narrow neck flaring into a bell, with three fins.
    g.add(tube(0.018, 0.05, [0, 0.06, 0.17], dark))
    g.add(part(new THREE.CylinderGeometry(0.03, 0.016, 0.04, 18), metal, [0, 0.06, 0.215], [90, 0, 0]))
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + Math.PI / 2
      g.add(box(0.006, 0.05, 0.07, [Math.cos(a) * 0.04, 0.06 + Math.sin(a) * 0.04, 0.15], dark, [0, 0, (a - Math.PI / 2) * 180 / Math.PI]))
    }
    // The chamber's ink housing; its green glass is added after batching (batched faces are all paper).
    const chamber = new THREE.Group()
    chamber.position.set(0, 0.105, 0.07)
    chamber.add(tube(0.019, 0.105, [0, 0, 0], dark))
    parts.chamber = chamber
    g.add(chamber)
    // Rear knob and sight.
    g.add(part(new THREE.SphereGeometry(0.03, 14, 10), metal, [0, 0.06, -0.015]))
    g.add(box(0.008, 0.02, 0.02, [0, 0.105, 0.0], dark))
  }, 'ink-ray')
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.0205, 0.0205, 0.08, 14), new THREE.MeshBasicMaterial({ color: 0x46e05a, toneMapped: false }))
  glass.rotation.x = Math.PI / 2
  glass.name = 'Ink Ray chamber glow'
  result.userData.parts.chamber.add(glass)
  return result
}
