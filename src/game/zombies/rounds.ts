import { MAX_ALIVE, ROUND_BREAK, spawnDelay, zombiesInRound } from './rules'

/**
 * The round loop, as Call of Duty Zombies runs it: a short calm, then a round's worth of zombies fed
 * in one at a time (never more than MAX_ALIVE at once), and the round ends when the last one dies.
 * Pure state and a step function, so the whole loop is checked in Node.
 */
export type RoundState = {
  round: number
  phase: 'break' | 'active'
  /** Seconds left in the break. */
  timer: number
  /** Zombies of this round not yet spawned. */
  toSpawn: number
  /** Seconds until the next spawn is due. */
  spawnTimer: number
}

export type RoundEvents = { spawn: number; roundStarted?: number; roundEnded?: number }

/** Seconds before round 1 starts: long enough to look around, short enough not to wait. */
export const FIRST_ROUND_DELAY = 5

export const newGame = (): RoundState => ({ round: 0, phase: 'break', timer: FIRST_ROUND_DELAY, toSpawn: 0, spawnTimer: 0 })

/**
 * Advance the loop by `dt` seconds. `alive` is how many zombies are alive right now, `players` how
 * many are playing. Returns how many zombies to spawn this step, and any round change. The caller
 * must hand back any spawn it could not place (`returnSpawns`), so a round never ends short.
 */
export function stepRounds(state: RoundState, dt: number, alive: number, players: number): RoundEvents {
  const events: RoundEvents = { spawn: 0 }
  if (!(dt > 0)) return events
  if (state.phase === 'break') {
    state.timer -= dt
    if (state.timer > 0) return events
    state.round++
    state.phase = 'active'
    state.toSpawn = zombiesInRound(state.round, players)
    state.spawnTimer = 0
    events.roundStarted = state.round
  }
  state.spawnTimer -= dt
  while (state.spawnTimer <= 0 && state.toSpawn > 0 && alive + events.spawn < MAX_ALIVE) {
    events.spawn++
    state.toSpawn--
    state.spawnTimer += spawnDelay(state.round)
  }
  // Nothing more due while the crowd is full: do not bank spawns into a burst for later.
  if (state.spawnTimer < 0) state.spawnTimer = 0
  if (state.toSpawn === 0 && alive + events.spawn === 0) {
    events.roundEnded = state.round
    state.phase = 'break'
    state.timer = ROUND_BREAK
  }
  return events
}

/** Spawns the caller could not place go back into the round, to be tried again shortly. */
export function returnSpawns(state: RoundState, count: number) {
  if (count <= 0 || state.phase !== 'active') return
  state.toSpawn += count
  state.spawnTimer = Math.max(state.spawnTimer, 0.5)
}
