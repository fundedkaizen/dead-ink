// The full zombie reach sweep over the whole compound. Every place a player can stand (flood-filled from the
// spawn with the player's own moves), checked against the navigation graph, then a representative of each
// graph spot (every raised, sunken or walled-in one, every failure, and a spread of open ground) played out
// with the real director. Writes artifacts/zombies-reach-sweep.md and .json. Takes about half an hour:
//   node scripts/check-player.mjs scripts/zombies-reach-sweep.ts
// SWEEP_OUT=name writes artifacts/name.md/.json instead; SWEEP_LIMIT=n caps the director runs per zone setup.
// The fast regression version is zombies-reach-sweep-checks.ts (part of npm test).
import { mkdirSync, writeFileSync } from 'node:fs'
import * as THREE from 'three'
import { seeded } from '../src/game/shared/random'
import { at, playerReach, simulate, spawnRegions, staticCheck, sweepDirector, sweepWorld, VERDICTS, type SimResult, type Standing, type Verdict } from './reach-sweep'

const started = performance.now()
const out = process.env.SWEEP_OUT ?? 'zombies-reach-sweep'
const limit = Number(process.env.SWEEP_LIMIT ?? Infinity)
const w = sweepWorld()
const sim = await sweepDirector(w, 3)
const spawn = new THREE.Vector3(-30, 0, -25)
spawn.y = w.world.floor(spawn.clone().setY(0.6), 1, 1.5, 0.28)
const key = (p: Standing) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`

type Row = { place: Standing; setup: string; spot: number; graph: Verdict; graphNote?: string; sim?: SimResult; verdict: Verdict; note?: string }
const rows: Row[] = []
const placeCounts: Record<string, Record<Verdict, number>> = {}
const seen = new Set<string>()
const setups: { name: string; apply: () => void }[] = [
  { name: 'start zone, every gate shut', apply: () => w.zones.closeAll() },
  { name: 'every gate open (the rest of the map)', apply: () => { for (const g of w.zones.gates) w.zones.open(g); w.zones.update(5) } },
]
for (const setup of setups) {
  setup.apply()
  w.world.refresh()
  const { places } = playerReach(w.world, w.bounds, spawn, w.ways, { leaps: true })
  const regions = spawnRegions(w.graph)
  const counts = Object.fromEntries(VERDICTS.map(v => [v, 0])) as Record<Verdict, number>
  // One representative per graph spot the flow would start from (per cell and level when there is none):
  // a failing place over a passing one, then the one farthest from its spot.
  const groups = new Map<string, { place: Standing; spot: number; verdict: Verdict; note?: string; far: number }>()
  for (const place of places) {
    if (seen.has(key(place))) continue
    seen.add(key(place))
    const check = staticCheck(w, place, regions)
    counts[check.verdict]++
    const group = check.spot >= 0 ? `s${check.spot}` : `c${Math.floor(place.x / 1.6)},${Math.floor(place.z / 1.6)},${Math.round(place.y)}`
    const far = check.spot >= 0 ? w.graph.point(check.spot).distanceTo(new THREE.Vector3(place.x, place.y, place.z)) : 0
    const prev = groups.get(group)
    if (!prev || (prev.verdict === 'ok' && check.verdict !== 'ok') || (prev.verdict === check.verdict && far > prev.far))
      groups.set(group, { place, spot: check.spot, verdict: check.verdict, note: check.note, far })
  }
  placeCounts[setup.name] = counts
  // Played out: every failure, every spot off the open ground grid or beside something, a spread of the rest.
  const chosen = [...groups.values()].filter(g => {
    if (g.verdict !== 'ok' || g.spot < 0 || g.spot >= w.graph.cells || w.graph.masks[g.spot] !== 255) return true
    const i = Math.floor(g.spot / w.graph.nz), k = g.spot % w.graph.nz
    return i % 4 === 0 && k % 4 === 0
  }).slice(0, limit)
  const random = seeded(20260924)
  let done = 0
  for (const g of chosen) {
    const result = simulate(w, sim, g.place, random)
    const failed = result.verdict !== 'ok'
    rows.push({ place: g.place, setup: setup.name, spot: g.spot, graph: g.verdict, graphNote: g.note, sim: result,
      verdict: failed && g.verdict !== 'ok' ? g.verdict : result.verdict, note: failed ? (g.verdict !== 'ok' ? g.note : result.note) : undefined })
    if (++done % 250 === 0) console.log(`  ${setup.name}: ${done} of ${chosen.length} played out`)
  }
  console.log(`${setup.name}: ${places.length} places, ${groups.size} spots, ${chosen.length} played out`)
}

const tally = (list: Row[]) => Object.fromEntries(VERDICTS.map(v => [v, list.filter(r => r.verdict === v).length])) as Record<Verdict, number>
const failures = rows.filter(r => r.verdict !== 'ok')
const soft = {
  relocated: rows.filter(r => r.sim && r.sim.relocated > 0).length,
  idle: rows.filter(r => r.sim && r.sim.idle > 2.5).length,
  detour: rows.filter(r => r.sim && r.sim.detour > 2.5).length,
}
const minutes = (performance.now() - started) / 60000
const summary = { minutes: +minutes.toFixed(1), places: placeCounts, playedOut: rows.length, verdicts: tally(rows), soft }
mkdirSync('artifacts', { recursive: true })
writeFileSync(`artifacts/${out}.json`, JSON.stringify({ summary, failures: failures.map(r => ({ at: [r.place.x, r.place.y, r.place.z], setup: r.setup, verdict: r.verdict, graph: r.graph, move: r.place.move, oneWay: r.place.oneWay, note: r.note, sim: r.sim })) }, null, 1))
const lines = [
  `# Zombie reach sweep`, '',
  `${new Date().toISOString()}, ${minutes.toFixed(1)} min. Every place a player can stand, flood-filled from the spawn (-30, 0, -25) with the player's moves (walk, step, drop, jump up, running jump, ladders, zip line), per zone setup.`, '',
  '## Graph coverage (every place, 0.5 m lattice)', '',
  '| setup | ok | off-graph | unreachable |', '|---|---|---|---|',
  ...Object.entries(placeCounts).map(([name, c]) => `| ${name} | ${c.ok} | ${c['off-graph']} | ${c.unreachable} |`), '',
  `## Played out with the real director (${rows.length} places: one per graph spot that is raised, sunken, walled or failing, and a spread of open ground)`, '',
  '| verdict | places |', '|---|---|', ...VERDICTS.map(v => `| ${v} | ${summary.verdicts[v]} |`), '',
  `Soft flags: ${soft.relocated} needed a stranded zombie relocated, ${soft.idle} had a zombie standing idle over 2.5 s, ${soft.detour} had a zombie walk over 2.5 times its walking distance.`, '',
  '## Failures', '',
  ...failures.map(r => `- **${r.verdict}** at (${at(r.place)}) [${r.setup}; reached by ${r.place.move}${r.place.oneWay ? ', one-way' : ''}]: ${r.note ?? ''}`),
]
writeFileSync(`artifacts/${out}.md`, lines.join('\n') + '\n')
console.log(JSON.stringify(summary))
w.world.dispose()
