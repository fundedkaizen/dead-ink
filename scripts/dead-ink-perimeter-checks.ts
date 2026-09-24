// Dead Ink keeps players inside the compound's fences. Tries hard to get out, in the world as the runtime
// sets it up (every zone gate open, the boarded windows and the roof wire, the dressing):
// 1. the player's own flood fill (walk, step, drop, jump up, running jumps, ladders, the zip line) from the
//    spawn reaches nowhere outside;
// 2. with the real player body, from high places within a sprint jump of the perimeter (every one along the
//    mess hall roof's parapet, one per 2 m elsewhere; FULL=1 every one, about three minutes), sprint and jump outward:
//    no landing outside;
// 3. the mess hall's roof ladder offers no climb, and a body on a fence top slips off it.
// About a minute. The two ways out it closes: the mess hall roof (ladder, parapet) and walking the fence tops.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { PlayerBody } from '../src/player/body'
import { PlayerActions } from '../src/player/actions'
import { playerReach, sweepWorld, at } from './reach-sweep'

const started = performance.now()
/** The fenced compound, flat: the perimeter fences, the mess hall's road-side walls (the service fence ends at them), the east annex. */
const INSIDE: [number, number][] = [
  [-75.75, -48], [-48.1, -48], [-48.1, -57.3], [-20.3, -57.3], [-20.3, -48], [24.75, -48], [24.75, -37.5], [99, -37.5],
  [99, -57], [164, -57], [164, 18], [99, 18], [99, 49.2], [-20.4, 49.2], [-20.4, 73.5], [-93.75, 73.5], [-93.75, 35.55], [-75.75, 35.55],
]
function edge(x: number, z: number) {
  let best = { d: Infinity, x: 0, z: 0 }
  for (let i = 0, j = INSIDE.length - 1; i < INSIDE.length; j = i++) {
    const [ax, az] = INSIDE[j], [bx, bz] = INSIDE[i], dx = bx - ax, dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    const d = Math.hypot(x - ax - t * dx, z - az - t * dz)
    if (d < best.d) best = { d, x: ax + t * dx, z: az + t * dz }
  }
  return best
}
function contains(x: number, z: number) {
  let inside = false
  for (let i = 0, j = INSIDE.length - 1; i < INSIDE.length; j = i++) {
    const [xi, zi] = INSIDE[i], [xj, zj] = INSIDE[j]
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
/** Beyond the fence line by more than a wall's thickness and a body's radius. */
const outside = (p: { x: number; z: number }) => !contains(p.x, p.z) && edge(p.x, p.z).d > 0.6

const w = sweepWorld()
for (const g of w.zones.gates) w.zones.open(g)
w.zones.update(5)
w.world.refresh()

// ---- 1. The flood fill.
const spawn = new THREE.Vector3(-30, 0, -25)
spawn.y = w.world.floor(spawn.clone().setY(0.6), 1, 1.5, 0.28)
const { places, trace } = playerReach(w.world, w.bounds, spawn, w.ways, { leaps: true })
const out = places.filter(outside)
assert.equal(out.length, 0, `${out.length} places outside the compound, e.g. (${out[0] && at(out[0])}) by ${out[0] && trace(out[0]).slice(-4).map(s => `${s[3]} (${s[0]}, ${s[1].toFixed(2)}, ${s[2]})`).join(' > ')}`)
const roof = places.filter(p => p.y > 6 && p.y < 7 && p.x > -48.2 && p.x < -20.2 && p.z > -57.4 && p.z < -35.8)
assert(roof.length > 200, 'the mess hall roof is still somewhere to stand')

// ---- 2. Sprint and jump off every high place near the perimeter.
const carry = (h: number) => 7.6 * (7 + Math.sqrt(49 + 44 * Math.max(0, h))) / 22
const full = process.env.FULL === '1'
const chosen = new Map<string, (typeof places)[number]>()
for (const p of places) {
  if (p.y < 1 || edge(p.x, p.z).d > carry(p.y + 0.5) + 1) continue
  // Finest along the roof's parapet, where the way out was.
  const size = full || (p.y > 6 && p.y < 7 && edge(p.x, p.z).d < 1.5) ? 1 : 2
  const key = `${Math.round(p.x / size)},${Math.round(p.z / size)},${Math.round(p.y / 2)},${size}`
  const prev = chosen.get(key)
  if (!prev || p.y > prev.y) chosen.set(key, p)
}
const body = new PlayerBody(w.world), capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.28)
const escapes: string[] = []
let tries = 0
for (const p of chosen.values()) {
  const e = edge(p.x, p.z), base = Math.atan2(e.z - p.z, e.x - p.x)
  for (const turn of full ? [-60, -30, 0, 30, 60] : [-45, 0, 45]) {
    const a = base + turn * Math.PI / 180, dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
    for (const back of [0, 1.5]) {
      // A run-up a body stands on and walks straight along to the launch place.
      const start = new THREE.Vector3(p.x - dir.x * back, p.y, p.z - dir.z * back)
      const floor = w.world.floor(start.clone().setY(p.y + 0.4), 0, 0.8, 0, true)
      if (!Number.isFinite(floor) || Math.abs(floor - p.y) > 0.35 || outside(start)) continue
      start.y = floor + 0.01
      let clear = true
      for (let i = 0; i <= 6 && clear; i++) {
        const q = start.clone().lerp(new THREE.Vector3(p.x, Math.max(p.y, start.y), p.z), i / 6)
        capsule.start.set(q.x, q.y + 0.33, q.z); capsule.end.set(q.x, q.y + 1.57, q.z)
        clear = w.world.fits(capsule)
      }
      if (!clear) continue
      // No jump (sprinting off), a jump at the launch place, one 0.3 m on.
      for (const late of full ? [-1, 0, 0.3] : [-1, 0.2]) {
        body.teleport(start)
        body.update(1 / 60, new THREE.Vector3(), false)
        let t = 0, jumped = late < 0, airborne = false
        while (t < 4) {
          if (!jumped && (body.position.x - start.x) * dir.x + (body.position.z - start.z) * dir.z >= back + late - 0.05) jumped = body.jump()
          body.update(1 / 60, dir, true); t += 1 / 60
          if (!body.grounded) airborne = true
          else if (airborne) break
        }
        tries++
        if (outside(body.position)) escapes.push(`from (${at(p)}) heading ${turn} run-up ${back} to (${at(body.position)})`)
      }
    }
  }
}
assert(tries > 1000, `enough attempts (${tries})`)
assert.equal(escapes.length, 0, `${escapes.length} sprint jumps landed outside:\n${escapes.slice(0, 10).join('\n')}`)

// ---- 3. The roof ladder is closed; a fence top will not hold a body.
{
  const actions = new PlayerActions(w.scene, body), camera = new THREE.PerspectiveCamera(75, 1, 0.05, 500)
  const ladder = actions.ladders.find(l => l.name === 'Mess hall · west exterior roof ladder')!
  assert(ladder?.userData.closed, 'the mess hall roof ladder is closed in zombie mode')
  const offered = () => {
    let found = 0
    for (const descending of [false, true]) {
      const end = actions.ladderPoint(ladder, descending)
      body.teleport(end); actions.syncCamera(camera)
      camera.lookAt(end.clone().setY(end.y + (descending ? 0.85 : 1.25)).add(new THREE.Vector3(0.01, 0, 0)))
      camera.updateMatrixWorld(true)
      if (actions.findTarget(camera)?.object === ladder) found++
    }
    return found
  }
  assert.equal(offered(), 0, 'no climb offered at either end of the closed ladder')
  delete ladder.userData.closed
  assert(offered() > 0, 'the same test finds the ladder when it is open')
  ladder.userData.closed = true
  // On the rail yard fence, and 3 cm off its line: off it within a second, down on the ground.
  for (const dz of [0, 0.03]) {
    body.teleport(new THREE.Vector3(40, 2.53, -18.75 + dz))
    for (let i = 0; i < 90; i++) body.update(1 / 60, new THREE.Vector3(1, 0, 0), false)
    assert(body.position.y < 0.2, `a fence top does not hold a body (${at(body.position)})`)
  }
}

console.log(`dead ink perimeter checks passed in ${((performance.now() - started) / 1000).toFixed(0)} s: ${places.length} places, none outside; ${tries} sprint jumps from ${chosen.size} high places near the fence, none out`)
w.world.dispose()
