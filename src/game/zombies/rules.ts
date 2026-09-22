/**
 * Dead Ink round rules, modelled on Call of Duty Zombies (World at War through Black Ops III).
 *
 * Every number carries its source. VERIFIED means cross-checked against published sources on
 * 2026-09-22; UNVERIFIED means recalled from the original game scripts and not yet confirmed, and is
 * a candidate to check against the official Black Ops III Mod Tools scripts.
 * Pure data and pure functions only, so every rule is checked in Node.
 */

/**
 * Zombie health. VERIFIED (Steam guide "Zombie Mode Weapon Damage/Health/Data", zombacus.com,
 * simplecalculators.uk): 150 on round 1, +100 per round through round 9 (950), then x1.1 per round.
 */
export function zombieHealth(round: number) {
  const r = Math.max(1, Math.floor(round))
  if (r < 10) return 150 + 100 * (r - 1)
  let health = 950
  for (let i = 10; i <= r; i++) health *= 1.1
  return Math.floor(health)
}

/**
 * Zombies per round, by player count. VERIFIED (jackhanke.github.io "The Math of COD Zombies",
 * citing zombacus.com): rounds 1-9 come from a fixed table; from round 10 it is
 * 24 + floor(0.5 * 0.18 r^2) solo and 24 + floor((n - 1) * 0.18 r^2) for n = 2..4. That follows from
 * the scripts' constants: 24 base, 6 zombies per player, multiplier (r / 5) * (0.15 r).
 */
const EARLY_COUNTS: Record<number, number[]> = {
  1: [6, 8, 13, 18, 24, 27, 28, 28, 29],
  2: [7, 9, 15, 21, 27, 31, 32, 33, 34],
  3: [9, 10, 18, 25, 32, 38, 40, 43, 45],
  4: [10, 12, 21, 29, 37, 45, 49, 52, 56],
}
export function zombiesInRound(round: number, players: number) {
  const r = Math.max(1, Math.floor(round)), n = Math.min(4, Math.max(1, Math.floor(players)))
  if (r < 10) return EARLY_COUNTS[n][r - 1]
  return 24 + Math.floor((n === 1 ? 0.5 : n - 1) * 0.18 * r * r)
}

/** Most zombies alive at once. UNVERIFIED: the scripts' zombie_max_ai, commonly cited as 24. */
export const MAX_ALIVE = 24

/**
 * Seconds between spawns. UNVERIFIED: recalled as 2 s on round 1, x0.95 each round, never below 0.08.
 */
export function spawnDelay(round: number) {
  return Math.max(0.08, 2 * 0.95 ** (Math.max(1, Math.floor(round)) - 1))
}

/** Seconds of calm between rounds. UNVERIFIED: recalled as 10 s (zombie_between_round_time). */
export const ROUND_BREAK = 10

/**
 * How zombies move this round: the share that walk, run and sprint. APPROXIMATION, not a source value:
 * early rounds shamble, runners appear from round 3 or so, sprinters in the high single digits,
 * which is how Call of Duty Zombies plays.
 */
export function movementMix(round: number) {
  const r = Math.max(1, Math.floor(round))
  const sprint = Math.min(0.7, Math.max(0, (r - 7) * 0.08))
  const run = Math.min(1 - sprint, Math.max(0, (r - 2) * 0.18))
  return { walk: Math.max(0, 1 - run - sprint), run, sprint }
}

/**
 * Points. VERIFIED (gamerguides.com Black Ops II zombies guide; callofduty.fandom.com Points page):
 * a non-lethal hit is 10; a kill is 60, a headshot kill 100, a knife kill 130; each board repaired 10.
 * Here a kill's value replaces its lethal hit's 10 rather than adding to it.
 */
export const POINTS = { hit: 10, kill: 60, headshotKill: 100, knifeKill: 130, board: 10 } as const
export const STARTING_POINTS = 500

/**
 * Prices. VERIFIED (gamerguides.com, Black Ops II): Mystery Box 950, Pack-a-Punch 5000,
 * Jugger-Nog 2500, Speed Cola 3000, Double Tap 2000, Quick Revive 500 solo / 1500 co-op, Mule Kick 4000.
 * Wall-buy and door prices are ours, in the range those games use.
 */
export const PRICES = {
  box: 950, packAPunch: 5000,
  perks: { thickInk: 2500, quickDip: 3000, doubleLine: 2000, secondDraftSolo: 500, secondDraftCoop: 1500, spareNib: 4000 },
  wall: { pistol: 500, smg: 1000, ak: 1200, shotgun: 1500, sniper: 1500 },
  door: { cheap: 750, standard: 1000, expensive: 1250 },
} as const
/** Refilling a wall weapon's ammo costs half its price, as in Call of Duty. */
export const wallAmmoPrice = (price: number) => Math.ceil(price / 2)

/**
 * Power-ups. VERIFIED (search results citing the Call of Duty wiki): at most 4 per round, an
 * uncollected power-up vanishes after 30 s, Nuke gives every player 400 points, Carpenter 200.
 * UNVERIFIED: Insta-Kill, Double Points and the Death Machine last 30 s; a guaranteed drop whenever team
 * points pass a threshold that starts at 2000 and grows x1.14 per drop, plus a 3% chance on any kill.
 */
export const POWERUPS = {
  maxPerRound: 4, lifetime: 30, nukePoints: 400, carpenterPoints: 200,
  timed: 30, firstThreshold: 2000, thresholdGrowth: 1.14, randomChance: 0.03,
} as const
export type PowerupKind = 'maxAmmo' | 'instaKill' | 'doublePoints' | 'nuke' | 'carpenter' | 'deathMachine'

/**
 * Player health. VERIFIED (gamerguides.com): two zombie hits down a player without the health perk.
 * Black Ops III's Jugger-Nog raises health to 250 (commonly cited; the Black Ops II guide says the
 * perk triples health), so five hits.
 */
export const PLAYER_HEALTH = { base: 100, thickInk: 250, zombieHit: 50, regenDelay: 3, regenPerSecond: 60 } as const

/**
 * Dead Ink's own damage scale for player weapons. The guns were balanced against 100-health guards;
 * Call of Duty's guns hit much harder relative to zombie health. At x3.5 a round-1 zombie (150) takes
 * about two AK body shots or one headshot, as in Call of Duty. Tuned by play, not taken from a source.
 */
export const ZOMBIE_DAMAGE_SCALE = 3.5

/**
 * The Brute, Dead Ink's boss: every fifth round it climbs out of the ground partway into the round,
 * like Call of Duty's Brutus or Panzer Soldat. Our own design, tuned by play: slow and relentless, a
 * telegraphed swing that takes most of your health, and a ground slam that hits everything near it.
 * The round is not over until it is dead; killing it pays and drops a Max Ammo.
 */
export const BOSS = {
  every: 5, delay: 8, points: 500, scale: 1.9, speed: 2.4,
  health: (round: number) => 2000 + 600 * round,
  attack: { range: 2.3, windup: 0.6, reach: 2.9, swing: 1.0, recover: 0.8, damage: 80 },
  slam: { every: 10, windup: 1.0, radius: 6.5, damage: 70 },
} as const
export const isBossRound = (round: number) => round > 0 && round % BOSS.every === 0
