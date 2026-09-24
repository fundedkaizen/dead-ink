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
 * a non-lethal hit is 10; a kill is 60 in the torso, 50 in a limb, 100 with a headshot, 130 with the
 * knife and 50 with an explosive (a grenade, a rocket, any blast); each board repaired 10. Call of
 * Duty's neck kill (70) has no zone here, so it pays as the torso. A kill's value replaces its lethal
 * hit's 10 rather than adding to it.
 */
export const POINTS = { hit: 10, kill: 60, limbKill: 50, headshotKill: 100, knifeKill: 130, explosiveKill: 50, board: 10 } as const
export const STARTING_POINTS = 500

/**
 * Prices. VERIFIED (gamerguides.com, Black Ops II): Mystery Box 950, Pack-a-Punch 5000,
 * Jugger-Nog 2500, Speed Cola 3000, Double Tap 2000, Quick Revive 500 solo / 1500 co-op, Mule Kick 4000.
 * Wall-buy and door prices are ours, in the range those games use.
 */
export const PRICES = {
  box: 950, packAPunch: 5000,
  perks: { thickInk: 2500, quickDip: 3000, doubleLine: 2000, secondDraftSolo: 500, secondDraftCoop: 1500, spareNib: 4000, longStroke: 2000 },
  wall: { pistol: 500, smg: 1000, ak: 1200, shotgun: 1500, sniper: 1500, magnum: 2000, lmg: 4500 },
  door: { cheap: 750, standard: 1000, expensive: 1250 },
} as const
/** Refilling a wall weapon's ammo costs half its price, as in Call of Duty. */
export const wallAmmoPrice = (price: number) => Math.ceil(price / 2)

/**
 * Power-ups. VERIFIED (search results citing the Call of Duty wiki): at most 4 per round, an
 * uncollected power-up vanishes after 30 s, Nuke gives every player 400 points, Carpenter 200.
 * UNVERIFIED: Insta-Kill, Double Points and the Death Machine last 30 s; a guaranteed drop whenever team
 * points pass a threshold that starts at 2000 and grows per drop, plus a small chance on any kill. Tuned
 * down by play (Call of Duty's x1.14 and 2-3% felt like too many): x1.22 and 1%.
 */
export const POWERUPS = {
  maxPerRound: 4, lifetime: 30, nukePoints: 400, carpenterPoints: 200,
  timed: 30, firstThreshold: 2000, thresholdGrowth: 1.22, randomChance: 0.01,
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
 * like Call of Duty's Brutus or Panzer Soldat. Our own design, tuned by play, not taken from a source.
 *
 * It does not hold the round up: the round ends when its own zombies are dead, and the Brute carries on
 * into the next rounds until it is killed, one at a time. It has the health of a boss (`health`: this many
 * zombies' worth for the round it arrives in, more with more players), bullets do not stagger it, and
 * every attack is telegraphed: a heavy swing, a ground slam whose ink wave you jump, a charge in a
 * straight line, and a chunk of debris for a player out of reach. Below `enrage.below` of its health it
 * enrages. Its iron mask takes head shots until it breaks off; then its head is a weak spot. Truly stuck,
 * it burrows into the ink in plain view and comes up near a player. Killing it pays and drops a Max Ammo.
 * Distances are metres, times seconds, damage before difficulty (a player has 100, 250 with Thick Ink).
 */
export const BOSS = {
  every: 5, delay: 8, points: 500,
  /** Its size against a man's; its walk, and enraged. A walking player (4.2) still gets away. */
  scale: 1.5, speed: 2.9, enragedSpeed: 3.9,
  /** Zombies' worth of health for its round, never under `least`; each player past the first adds `perPlayer`. */
  zombies: 40, least: 15000, perPlayer: 0.6,
  health: (round: number, players = 1): number => Math.round(Math.max(BOSS.least, zombieHealth(round) * BOSS.zombies)
    * (1 + BOSS.perPlayer * (Math.min(4, Math.max(1, Math.floor(players))) - 1))),
  /** The swing: starts within `range`, lands after `windup` if you are still within `reach`. */
  attack: { range: 2.2, windup: 0.55, reach: 2.7, swing: 1.0, recover: 0.7, damage: 85, knock: 3 },
  /**
   * The slam: fists raised for `windup`, then down. Within `inner` the fists hurt at once (less further
   * out); then an ink wave runs out along the ground at `speed` to `radius` and hurts anyone standing when
   * it passes (`wave`, less toward its edge). Jump it. `lag`: how late a teammate's jump may be seen and
   * still count, for the time their news takes to reach the host.
   */
  slam: { cooldown: 9, windup: 1.0, trigger: 5, inner: 2.4, damage: 70, radius: 11, speed: 9, wave: 45, waveEdge: 0.55, recover: 0.8, lag: 0.3 },
  /**
   * The charge: planted for `windup` (it turns to follow you until `lock` before the end, then its line is
   * fixed), then a straight run at `speed` for up to `length`. Zombies in its way are thrown aside; a player
   * it runs into takes `damage` and is thrown `knock` m/s. Into a wall, it is stunned for `crash`.
   */
  charge: { cooldown: 11, windup: 0.9, lock: 0.3, speed: 12, near: 7, far: 22, length: 24, width: 1.3, damage: 75, knock: 8, recover: 0.8, crash: 1.6 },
  /**
   * The throw, for a player out of reach (further than `near`, or up where it cannot follow): it tears a
   * chunk out of the ground and throws it over `windup` (let go at `release` of it). A direct hit does
   * `damage`, the splash within `splash` a share of it.
   */
  throw: { cooldown: 7, windup: 1.1, release: 0.8, near: 12, far: 34, damage: 60, splash: 1.8, splashShare: 0.45, gravity: 14 },
  /** Enraged: cooldowns and wind-ups shortened by these; a roar of `roar` seconds as it turns. */
  enrage: { below: 0.35, cooldowns: 0.6, windups: 0.8, roar: 1.4 },
  /**
   * The mask: health as a share of the Brute's. A head shot while it holds does its full damage to the mask
   * and only a body shot's to the Brute; broken, the Brute reels for `stagger` and head shots do `weakSpot`
   * times a head shot's damage.
   */
  mask: { share: 0.12, stagger: 1.2, weakSpot: 1.6 },
  /**
   * The burrow: stuck (no closer for `stuck` seconds, `enragedStuck` enraged, or no way to anyone for
   * `lost`), it sinks into a pool of ink over `sink`, stays under for `under` while a pool bubbles where it
   * will come up, `near` to `far` from a player, then climbs out. Not again for `cooldown`.
   */
  burrow: { stuck: 12, enragedStuck: 8, lost: 5, sink: 1.6, under: 2.4, near: 6, far: 12, cooldown: 25, depth: 6 },
  /** At least this long between two of its special attacks, so they never chain unanswerably. */
  gap: 1.2,
} as const
export const isBossRound = (round: number) => round > 0 && round % BOSS.every === 0

/**
 * The Ink Storm, Dead Ink's answer to Call of Duty's hellhound rounds: now and then ink floods the
 * compound and the light goes, and the Inkwings come out of it (flyers.ts): ink creatures on ragged wings
 * that circle and dive at you, with a few sprinters running under them. Clear it and a Max Ammo drops where
 * the last one fell. Our own design: round 7, then every seventh round, never on a Brute round. `health` is
 * the sprinters' share of a zombie's; `spawnDelay` scales the round's spawn delay between arrivals (a group
 * of Inkwings is one arrival).
 */
export const STORM = { first: 7, every: 7, health: 0.6, spawnDelay: 1.5 } as const
export const isStormRound = (round: number) =>
  round >= STORM.first && (round - STORM.first) % STORM.every === 0 && !isBossRound(round)
/** Which storm a round's is: 1 on round 7, 2 on round 14, and so on. */
export const stormNumber = (round: number) => Math.max(1, Math.floor((Math.floor(round) - STORM.first) / STORM.every) + 1)

/**
 * What a storm brings. Our own numbers, tuned in the storm simulation of scripts/dead-ink-flyers-checks.ts:
 * `flyers` Inkwings for one player on the first storm and `perStorm` more on each storm after it, times
 * `players` for one to four players; sprinters, a `sprinters` share of the Inkwings; each Inkwing's health a
 * `health` share of a zombie's, `perPlayer` more for each player past the first; they come in groups of
 * `group` (fewest, most).
 */
export const INKWINGS = { flyers: 10, perStorm: 3, players: [1, 1.7, 2.3, 2.9], sprinters: 0.2, health: 0.5, perPlayer: 0.15, group: [2, 4] } as const
export function stormPack(round: number, players: number) {
  const n = Math.min(4, Math.max(1, Math.floor(players)))
  const flyers = Math.round((INKWINGS.flyers + INKWINGS.perStorm * (stormNumber(round) - 1)) * INKWINGS.players[n - 1])
  return { flyers, sprinters: Math.round(flyers * INKWINGS.sprinters) }
}
export const inkwingHealth = (round: number, players: number) =>
  Math.round(zombieHealth(round) * INKWINGS.health * (1 + INKWINGS.perPlayer * (Math.min(4, Math.max(1, Math.floor(players))) - 1)))

/**
 * Difficulty, our own: health and damage multipliers on Call of Duty's numbers, how many rounds earlier
 * (or later) sprinters take over, and how fast zombies come. Normal is Call of Duty as it is.
 */
export type Difficulty = 'casual' | 'normal' | 'hardcore' | 'realistic'
export const DIFFICULTY: Record<Difficulty, { label: string; health: number; damage: number; sprintShift: number; spawnDelay: number; blurb: string }> = {
  casual: { label: 'Casual', health: 0.7, damage: 0.68, sprintShift: -4, spawnDelay: 1.15, blurb: 'Weaker zombies; three hits to go down.' },
  normal: { label: 'Normal', health: 1, damage: 1, sprintShift: 0, spawnDelay: 1, blurb: 'Call of Duty as it is.' },
  hardcore: { label: 'Hardcore', health: 1.25, damage: 1, sprintShift: 3, spawnDelay: 0.8, blurb: 'Tougher, faster, sooner.' },
  realistic: { label: 'Realistic', health: 1.5, damage: 2, sprintShift: 5, spawnDelay: 0.7, blurb: 'One hit downs you without Thick Ink.' },
}
