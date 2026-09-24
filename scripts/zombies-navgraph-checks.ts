// The baked zombie navigation graph (public/nav/compound.json) must be what scripts/build-navgraph.ts
// builds from the map and the graph code as they are now: a change to either without a re-bake fails
// here. Rebuilding takes about half a minute. Re-bake with:
//   node scripts/check-player.mjs scripts/build-navgraph.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildNavScene, raisedWays } from './nav-scene'
import { NAV_VERSION, NavGraph, geometryHash, type NavData } from '../src/game/zombies/navgraph'

const baked = JSON.parse(readFileSync('public/nav/compound.json', 'utf8')) as NavData
assert.equal(baked.version, NAV_VERSION, `the bake is navigation data version ${baked.version}, the code reads ${NAV_VERSION}: re-bake`)
const { scene, world, doors, bounds } = buildNavScene()
const hash = geometryHash(scene)
assert.equal(baked.geometry, hash, `the bake is for map geometry ${baked.geometry}, the map is ${hash} now: re-bake`)
const started = performance.now()
const fresh = NavGraph.build(world, bounds, doors, hash, undefined, () => {}, raisedWays(scene, world)).toData()
const seconds = (performance.now() - started) / 1000
for (const field of ['cell', 'minX', 'minZ', 'nx', 'nz', 'heights', 'masks'] as const)
  assert.deepEqual(baked[field], fresh[field], `the baked ${field} differ from a fresh build: re-bake`)
assert.equal(baked.raised.length, fresh.raised.length, `${baked.raised.length / 5} level spots baked, ${fresh.raised.length / 5} built now: re-bake`)
assert.deepEqual(baked.raised, fresh.raised, 'the baked level spots differ from a fresh build: re-bake')
assert.equal(baked.links.length, fresh.links.length, `${baked.links.length} links baked, ${fresh.links.length} built now: re-bake`)
assert.deepEqual(baked.links, fresh.links, 'the baked links differ from a fresh build: re-bake')
console.log(`zombies navgraph checks passed: the bake matches a fresh build (${seconds.toFixed(1)} s), ${fresh.raised.length / 5} level spots, ${fresh.links.length} links`)
world.dispose()
