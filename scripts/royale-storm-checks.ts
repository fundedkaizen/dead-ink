import assert from 'node:assert/strict'
import { DEFAULT_PHASES, outsideBy, planStorm, stormAt, stormDuration, type Arena } from '../src/game/royale/storm'
import { seeded } from '../src/game/royale/random'

// The compound's real bounds (createMissionWorld).
const ARENA: Arena = { minX: -108, maxX: 183, minZ: -76, maxZ: 78 }
const EPS = 1e-6

for (let seed = 1; seed <= 500; seed++) {
  const plan = planStorm(ARENA, seeded(seed))
  assert.equal(plan.circles.length, DEFAULT_PHASES.length + 1)

  // Nobody starts in the storm: the first circle covers every corner of the arena.
  const first = plan.circles[0]
  for (const [x, z] of [[ARENA.minX, ARENA.minZ], [ARENA.minX, ARENA.maxZ], [ARENA.maxX, ARENA.minZ], [ARENA.maxX, ARENA.maxZ]])
    assert(outsideBy(first, x, z) < 0, `seed ${seed}: corner ${x},${z} starts inside the storm`)

  for (let i = 1; i < plan.circles.length; i++) {
    const outer = plan.circles[i - 1], inner = plan.circles[i]
    // Every circle fits wholly inside the one before it, so standing in the next circle is always safe now.
    assert(Math.hypot(inner.x - outer.x, inner.z - outer.z) + inner.r <= outer.r + EPS, `seed ${seed}: circle ${i} escapes circle ${i - 1}`)
    assert(inner.r < outer.r, `seed ${seed}: circle ${i} does not shrink`)
    assert(inner.x >= ARENA.minX - EPS && inner.x <= ARENA.maxX + EPS && inner.z >= ARENA.minZ - EPS && inner.z <= ARENA.maxZ + EPS,
      `seed ${seed}: circle ${i} is centred off the map`)
  }
  assert.equal(plan.circles[plan.circles.length - 1].r, 0, 'the last circle closes completely, so a match always ends')

  // Continuity over the whole match: the radius never grows, damage never drops, and there are no jumps.
  let lastR = Infinity, lastDamage = 0, last = stormAt(plan, 0)
  for (let t = 0; t <= stormDuration(plan) + 30; t += 0.25) {
    const now = stormAt(plan, t)
    assert(now.circle.r <= lastR + EPS, `seed ${seed}: radius grew at t=${t}`)
    assert(now.damage >= lastDamage, `seed ${seed}: damage dropped at t=${t}`)
    const jump = Math.hypot(now.circle.x - last.circle.x, now.circle.z - last.circle.z) + Math.abs(now.circle.r - last.circle.r)
    assert(jump < 3, `seed ${seed}: storm jumped ${jump.toFixed(2)} m in 0.25 s at t=${t}`)
    assert(now.nextIn >= 0)
    lastR = now.circle.r; lastDamage = now.damage; last = now
  }
  assert(stormAt(plan, stormDuration(plan) + 1).finished)
}

// The schedule itself: grace period first, and gentle early damage.
{
  const plan = planStorm(ARENA, seeded(7))
  const start = stormAt(plan, 0)
  assert(!start.shrinking && start.nextIn === DEFAULT_PHASES[0].hold, 'the match opens with a grace period before any shrink')
  assert(start.damage <= 2, 'early storm is a nudge, not a death sentence')
  const duration = stormDuration(plan)
  assert(duration >= 5 * 60 && duration <= 10 * 60, `match length ${Math.round(duration)} s is between five and ten minutes`)
  assert(stormAt(plan, DEFAULT_PHASES[0].hold + 1).shrinking, 'after the grace period the first shrink begins')
}

// Same seed, same storm: a match can be reproduced exactly.
assert.deepEqual(planStorm(ARENA, seeded(42)), planStorm(ARENA, seeded(42)))
assert.notDeepEqual(planStorm(ARENA, seeded(42)), planStorm(ARENA, seeded(43)))

console.log('royale storm checks passed')
