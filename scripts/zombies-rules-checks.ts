import assert from 'node:assert/strict'
import { MAX_ALIVE, POINTS, PRICES, POWERUPS, ZOMBIE_DAMAGE_SCALE, movementMix, spawnDelay, wallAmmoPrice, zombieHealth, zombiesInRound } from '../src/game/zombies/rules'
import { WEAPON_RULES, HIT_MULTIPLIERS } from '../src/game/balance'

// Health: the published progression, point by point.
const health: Record<number, number> = { 1: 150, 2: 250, 3: 350, 9: 950, 10: 1045, 11: 1150, 12: 1264, 30: 7030, 40: 18234, 50: 47295 }
// From round 10 the exact value is 950 x 1.1^(r-9), a fraction. The published table rounds it
// inconsistently (1149.5 -> 1150 at round 11, but 1264.45 -> 1264 and 47295.9 -> 47295 later), so no
// single rounding rule matches every entry: allow the 1 HP that rounding can move it.
for (const [round, expected] of Object.entries(health)) {
  const r = Number(round), tolerance = r >= 10 ? 1 : 0
  assert(Math.abs(zombieHealth(r) - expected) <= tolerance, `round ${round} health ${zombieHealth(r)} vs published ${expected}`)
}
for (let r = 2; r <= 100; r++) assert(zombieHealth(r) > zombieHealth(r - 1), `health rises every round (round ${r})`)

// Zombie counts: the published early table and the round-10+ formula.
assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(r => zombiesInRound(r, 1)), [6, 8, 13, 18, 24, 27, 28, 28, 29])
assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(r => zombiesInRound(r, 2)), [7, 9, 15, 21, 27, 31, 32, 33, 34])
assert.equal(zombiesInRound(10, 1), 24 + Math.floor(0.5 * 0.18 * 100))
assert.equal(zombiesInRound(20, 1), 60)
assert.equal(zombiesInRound(20, 2), 24 + Math.floor(0.18 * 400))
for (let r = 1; r <= 60; r++) {
  assert(zombiesInRound(r, 2) >= zombiesInRound(r, 1), `more players never means fewer zombies (round ${r})`)
  if (r > 1) assert(zombiesInRound(r, 1) >= zombiesInRound(r - 1, 1), `counts never drop (round ${r})`)
}
assert.equal(zombiesInRound(0, 1), zombiesInRound(1, 1), 'round 0 is clamped to round 1')
assert.equal(zombiesInRound(5, 9), zombiesInRound(5, 4), 'player count clamps to 4')
assert.equal(MAX_ALIVE, 24)

// Spawning speeds up and has a floor.
for (let r = 2; r <= 200; r++) assert(spawnDelay(r) <= spawnDelay(r - 1))
assert.equal(spawnDelay(1), 2)
assert.equal(spawnDelay(500), 0.08)

// Movement mix: always sums to one; early rounds shamble; late rounds are mostly fast.
for (let r = 1; r <= 60; r++) {
  const m = movementMix(r)
  assert(Math.abs(m.walk + m.run + m.sprint - 1) < 1e-9 && m.walk >= 0 && m.run >= 0 && m.sprint >= 0, `round ${r} mix is a distribution`)
}
assert.equal(movementMix(1).walk, 1, 'round 1 zombies all walk')
assert(movementMix(20).sprint > movementMix(10).sprint)

// Economy.
assert.deepEqual({ ...POINTS }, { hit: 10, kill: 60, limbKill: 50, headshotKill: 100, knifeKill: 130, explosiveKill: 50, board: 10 })
assert.equal(PRICES.box, 950)
assert.equal(PRICES.packAPunch, 5000)
assert.equal(wallAmmoPrice(1500), 750)
assert.equal(POWERUPS.maxPerRound, 4)

// Damage scale feels like Call of Duty at round 1: an AK kills a fresh zombie in two body shots or
// one headshot, and the starting pistol needs a few body shots.
const hitsToKill = (damage: number, hp: number) => Math.ceil(hp / damage)
const ak = WEAPON_RULES.ak.damage * ZOMBIE_DAMAGE_SCALE, pistol = WEAPON_RULES.pistol.damage * ZOMBIE_DAMAGE_SCALE
assert.equal(hitsToKill(ak, zombieHealth(1)), 2, 'AK: two body shots at round 1')
assert.equal(hitsToKill(ak * HIT_MULTIPLIERS.head, zombieHealth(1)), 1, 'AK: one headshot at round 1')
assert(hitsToKill(pistol, zombieHealth(1)) >= 2 && hitsToKill(pistol, zombieHealth(1)) <= 3, 'pistol: a few body shots at round 1')
assert(hitsToKill(ak, zombieHealth(10)) >= 8, 'by round 10 zombies are genuinely tougher')

console.log('zombies rules checks passed')
