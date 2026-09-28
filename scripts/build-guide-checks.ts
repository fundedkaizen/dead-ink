import assert from 'node:assert/strict'
import { BUILDS, PARTS, type PartId } from '../src/game/zombies/buildables'
import { buildGuide, partToast, partsGot, siteWanted, type BuildState } from '../src/game/zombies/build-guide'

/**
 * Buildable guidance (build-guide.ts), after the owner walked about with every shield part not knowing where
 * they went: the toast for each part, the hint that stays until the build is done, and the glowing spots.
 */
let passed = 0
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`) }
const state = (patch: Partial<BuildState> = {}): BuildState => ({ carried: [], placed: {}, power: 'broken', packBuilt: false, shieldWaiting: false, ...patch })

test('Each shield part says which of three it is and that it goes to the workbench', () => {
  assert.equal(partToast('panel', 1, 3), 'Shield part 1/3: build it at the workbench')
  assert.equal(partToast('grip', 3, 3), 'Shield part 3/3: build it at the workbench')
  assert.equal(partToast('gear', 2, 3), 'Pack-a-Punch part 2/3: build it at its chalk outline')
  assert.equal(partToast('lever', 1, 1), 'Power lever found: fit it on the power switch')
  for (const id of Object.keys(PARTS) as PartId[]) assert(partToast(id, 1, BUILDS[PARTS[id].build].parts.length).length > 10, id)
})

test('Parts count what the team carries and what is already on the bench', () => {
  assert.equal(partsGot(state({ carried: ['panel'] }), 'shield'), 1)
  assert.equal(partsGot(state({ carried: ['panel', 'strap'], placed: { shield: ['grip'] } }), 'shield'), 3)
  assert.equal(partsGot(state({ carried: ['gear'] }), 'shield'), 0)
})

test('With every missing shield part carried, the hint says to build it at the workbench; not before', () => {
  assert.equal(buildGuide(state({ carried: ['panel', 'strap'] })), null, 'two of three: no standing hint yet (the toast said where)')
  const guide = buildGuide(state({ carried: ['panel', 'strap', 'grip'] }))!
  assert.equal(guide.build, 'shield')
  assert.equal(guide.text, 'Build the ink shield at the workbench')
  // Parts already fitted count: the last one carried is enough.
  assert.equal(buildGuide(state({ carried: ['grip'], placed: { shield: ['panel', 'strap'] } }))?.build, 'shield')
  // Built: no hint, unless the shield is waiting on the bench to be taken.
  assert.equal(buildGuide(state({ placed: { shield: ['panel', 'strap', 'grip'] } })), null)
  assert.equal(buildGuide(state({ placed: { shield: ['panel', 'strap', 'grip'] }, shieldWaiting: true }))?.text, 'Take the ink shield from the workbench')
})

test('The same for the Pack-a-Punch and the power lever', () => {
  assert.equal(buildGuide(state({ carried: ['gear', 'plate', 'tank'] }))?.text, 'Build the Pack-a-Punch at its chalk outline')
  assert.equal(buildGuide(state({ carried: ['gear', 'plate', 'tank'], packBuilt: true })), null, 'no hint once the machine stands')
  assert.equal(buildGuide(state({ carried: ['lever'] }))?.text, 'Fit the lever on the power switch')
  assert.equal(buildGuide(state({ carried: ['lever'], power: 'ready' })), null)
  // The shield comes first when two are ready.
  assert.equal(buildGuide(state({ carried: ['gear', 'plate', 'tank', 'panel', 'strap', 'grip'] }))?.build, 'shield')
})

test('A spot glows while the team holds one of its parts, and stops once they are all fitted', () => {
  assert.equal(siteWanted(state(), 'shield'), false)
  assert.equal(siteWanted(state({ carried: ['strap'] }), 'shield'), true, 'from the first part picked up')
  assert.equal(siteWanted(state({ carried: ['strap'] }), 'pack'), false)
  assert.equal(siteWanted(state({ carried: [], placed: { shield: ['panel', 'strap', 'grip'] } }), 'shield'), false)
})

console.log(`build guide checks passed (${passed})`)
