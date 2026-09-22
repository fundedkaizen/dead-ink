// Bakes the zombie navigation graph for the compound into public/nav/compound.json.
// Run after changing map geometry:  node scripts/check-player.mjs scripts/build-navgraph.ts
// zombies-navgraph-checks fails if the baked file no longer matches the geometry.
import { mkdirSync, writeFileSync } from 'node:fs'
import { buildNavScene } from './nav-scene'
import { NavGraph, geometryHash } from '../src/game/zombies/navgraph'

const started = performance.now()
const { scene, world, doors, bounds } = buildNavScene()
const graph = NavGraph.build(world, bounds, doors, geometryHash(scene), undefined, message => console.log(message))
const seconds = (performance.now() - started) / 1000
const data = graph.toData()
const json = JSON.stringify(data)
mkdirSync('public/nav', { recursive: true })
writeFileSync('public/nav/compound.json', json)
const { sizes } = graph.regions()
const walkable = sizes.reduce((a, b) => a + b, 0)
console.log(`baked public/nav/compound.json in ${seconds.toFixed(1)} s: ${graph.nx} x ${graph.nz} spots, ${walkable} walkable, `
  + `${data.links.length} doorway links, ${sizes.length} regions (largest ${(Math.max(...sizes) / walkable * 100).toFixed(1)}%), `
  + `${(json.length / 1024).toFixed(0)} KB, geometry ${data.geometry}`)
world.dispose()
