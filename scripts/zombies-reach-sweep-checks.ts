// The fast version of the zombie reach sweep (the whole map is zombies-reach-sweep.ts, about half an hour,
// report in artifacts/). The same player-side flood fill and real-director play-out, over a few regions
// with every kind of footing: the cell block under the detention guardroom (its stairs, cells and bunks),
// the mess hall (its roof, stairs and furniture) and the warehouse slab with a container. Then named
// places, a cell door the player has shut, and the flow field's fallback for a player off the graph.
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { seeded, shuffled } from '../src/game/shared/random'
import { NavGraph } from '../src/game/zombies/navgraph'
import { setDoorOpen } from '../src/world/doors'
import { at, playerReach, simulate, spawnRegions, staticCheck, sweepDirector, sweepWorld, type Standing, type Verdict } from './reach-sweep'

const started = performance.now()
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const w = sweepWorld()
assert.equal(w.graph.geometry, w.hash, 'the baked navigation graph is for this map (zombies-navgraph-checks has the full staleness check)')
// Every gate open: the regions below span zones.
for (const g of w.zones.gates) w.zones.open(g)
w.zones.update(5)
w.world.refresh()
const sim = await sweepDirector(w, 3)
const regions = spawnRegions(w.graph)
const random = seeded(20260924)
const failures: string[] = []
let played = 0, placesChecked = 0, doubted = 0
const play = (label: string, place: Standing) => {
  const result = simulate(w, sim, place, random)
  played++
  if (result.verdict !== 'ok') failures.push(`${label}: ${result.verdict} at (${at(place)}) after ${result.seconds.toFixed(1)} of ${result.budget.toFixed(1)} s: ${result.note ?? ''}`)
  return result
}

// ---- 1. Regions: flood-fill from the player's side, every place checked against the graph, a sample played out.
const areas: { name: string; start: THREE.Vector3; box: { minX: number; maxX: number; minZ: number; maxZ: number }; sample: number }[] = [
  { name: 'cell block', start: v(117, 0.05, -2), box: { minX: 104, maxX: 130, minZ: -32, maxZ: 2 }, sample: 12 },
  { name: 'mess hall', start: v(-30, 0, -25), box: { minX: -52, maxX: -16, minZ: -60, maxZ: -22 }, sample: 8 },
  { name: 'warehouse', start: v(20, 0, 5), box: { minX: -4, maxX: 56, minZ: -28, maxZ: 6 }, sample: 8 },
]
const levels: string[] = []
for (const area of areas) {
  area.start.y = w.world.floor(area.start.clone().setY(area.start.y + 0.6), 1, 1.5, 0.28)
  const { places } = playerReach(w.world, w.bounds, area.start, w.ways, { region: area.box, leaps: true })
  placesChecked += places.length
  // One place per graph spot the flow starts from (per cell and level where there is none): one the graph
  // alone cannot vouch for over one it can, then the one farthest from its spot.
  const groups = new Map<string, { place: Standing; spot: number; verdict: Verdict; far: number; note?: string }>()
  for (const place of places) {
    const check = staticCheck(w, place, regions)
    const key = check.spot >= 0 ? `s${check.spot}` : `c${Math.floor(place.x / 1.6)},${Math.floor(place.z / 1.6)},${Math.round(place.y)}`
    const far = check.spot >= 0 ? w.graph.point(check.spot).distanceTo(new THREE.Vector3(place.x, place.y, place.z)) : 0
    const prev = groups.get(key)
    if (!prev || (prev.verdict === 'ok' && check.verdict !== 'ok') || (prev.verdict === check.verdict && far > prev.far))
      groups.set(key, { place, spot: check.spot, verdict: check.verdict, far, note: check.note })
  }
  // The real director decides: every place the graph alone cannot vouch for is played out, then a sample
  // of the rest, spots off the ground grid or beside something first (stairs, floors below, furniture).
  const all = shuffled(random, [...groups.values()])
  const doubtful = all.filter(g => g.verdict !== 'ok')
  const special = all.filter(g => g.verdict === 'ok' && (g.spot >= w.graph.cells || w.graph.masks[g.spot] !== 255))
  const plain = all.filter(g => g.verdict === 'ok' && g.spot < w.graph.cells && w.graph.masks[g.spot] === 255)
  for (const g of doubtful) {
    const result = play(area.name, g.place)
    if (result.verdict !== 'ok') failures[failures.length - 1] += ` (the graph: ${g.note})`
  }
  for (const g of [...special, ...plain].slice(0, area.sample)) play(area.name, g.place)
  doubted += doubtful.length
  const depth = places.reduce((low, p) => Math.min(low, p.y), Infinity), height = places.reduce((high, p) => Math.max(high, p.y), -Infinity)
  levels.push(`${area.name} ${places.length} places from ${depth.toFixed(1)} to ${height.toFixed(1)} m`)
}
assert(levels[0] && areas.length === 3)

// ---- 2. The cell block, place by place: down the stairs, into every cell, onto every bunk, and back up.
const cellBlock: [string, THREE.Vector3][] = [
  ['top of the cell block stairs', v(117, -0.6, -11)], ['halfway down the stairs', v(117, -2.1, -14.7)], ['foot of the stairs', v(117, -3.7, -19)],
  ['cell block corridor', v(117, -4.2, -24)], ['cell 01', v(110.5, -4.2, -20.5)], ['cell 02', v(123.5, -4.2, -21.5)],
  ['cell 03', v(110.5, -4.2, -26)], ['cell 04', v(123.5, -4.2, -26)], ['bunk in cell 01', v(109.25, -3.5, -21)],
  ['bunk in cell 04', v(124.75, -3.5, -26)], ['north end of the cell block', v(117, -4.2, -7)],
]
for (const [label, p] of cellBlock) {
  p.y = w.world.floor(p.clone().setY(p.y + 0.4), 0.2, 0.6, 0.28)
  assert(Number.isFinite(p.y), `${label}: somewhere to stand`)
  const spot = w.graph.nearest(p)
  assert(spot >= 0 && Math.abs(w.graph.point(spot).y - p.y) < 0.5, `${label}: on the graph, on its own level (${spot >= 0 ? at(w.graph.point(spot)) : 'no spot'})`)
  play(label, { x: p.x, y: p.y, z: p.z, move: 'walk', oneWay: false })
}
// And back up: a zombie down in the cell block climbs the stairs to a player in the guardroom.
{
  const guardroom = v(113, 0.12, -8)
  w.graph.flow([guardroom])
  const below = w.graph.nearest(v(117, -4.2, -26))
  assert(Number.isFinite(w.graph.distance(below)), 'the cell block leads back up to the guardroom')
  sim.director.clear()
  sim.hits.length = 0
  const zombie = sim.director.spawn(w.graph.point(below), 1e6, 'run', 0)!
  const target = { id: 'p1', feet: guardroom, alive: true }
  let t = 0
  while (t < 20 && !sim.hits.length) { sim.director.update(1 / 60, [target]); t += 1 / 60 }
  played++
  if (!sim.hits.length) failures.push(`back up to the guardroom: no swipe after ${t.toFixed(1)} s, zombie at (${at(zombie.position)})`)
}

// ---- 3. A shut door: the player closes cell 01 behind them; the zombies push it open.
{
  const door = w.doors.find(d => d.name === 'Cell 1 locked door')!
  assert(door, 'cell 01 has its door')
  setDoorOpen(door, false, true)
  w.world.refresh()
  const inside = v(110.2, -4.2, -21.6)
  inside.y = w.world.floor(inside.clone().setY(inside.y + 0.4), 0.2, 0.6, 0.28)
  const result = play('cell 01 with its door shut', { x: inside.x, y: inside.y, z: inside.z, move: 'walk', oneWay: false })
  assert(result.verdict !== 'ok' || door.userData.open, 'the zombies opened the shut cell door to get in')
  setDoorOpen(door, true, true)
  w.world.refresh()
}

// ---- 4. Off the graph: a player where no spot reaches still draws the flow to the closest spot.
{
  // A 5 x 5 grid, 1.6 m cells, walkable only in its middle row, and a player 3 m under the far end.
  const heights = new Float32Array(25).fill(NaN), masks = new Uint8Array(25)
  for (let i = 0; i < 5; i++) heights[i * 5 + 2] = 0
  for (let i = 0; i < 5; i++) masks[i * 5 + 2] = (i < 4 ? 1 : 0) | (i > 0 ? 2 : 0)
  const tiny = new NavGraph(1.6, 0, 0, 5, 5, heights, masks, [])
  const below = v(7.2, -3, 4)
  assert.equal(tiny.nearest(below), -1, 'the player is off the graph (no spot on their level)')
  tiny.flow([below])
  // The row's spots are cells (i, 2): indices 2, 7, 12, 17, 22.
  assert(Number.isFinite(tiny.distance(2)), 'yet every spot has a way to them: the flow starts at the closest spot')
  assert(tiny.downhill(2) === 7 && tiny.distance(22) < tiny.distance(2), 'and leads toward them')
}

const seconds = (performance.now() - started) / 1000
if (failures.length) throw new Error(`zombie reach sweep: ${failures.length} failures\n${failures.join('\n')}`)
console.log(`zombies reach sweep checks passed in ${seconds.toFixed(0)} s: ${placesChecked} places checked against the graph (${levels.join('; ')}), ${played} played out with the real director (${doubted} the graph alone could not vouch for)`)
w.world.dispose()
