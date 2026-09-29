/**
 * High scores: for each map, mode (solo or co-op) and difficulty, the ten best of four things: the best round
 * reached, the fastest to round 10, the fastest to round 20, and the most kills in a game.
 *
 * Pure data and functions, checked in Node. The table lives in the profile (profile.ts), so it travels
 * with a save code.
 */
export type RecordMode = 'solo' | 'coop'
export type RecordCategory = 'bestRound' | 'round10' | 'round20' | 'kills'
/** One placing: the number, when, and the game's round and kills for context. */
export type RecordEntry = { value: number; date: number; round: number; kills: number }
/** Keyed by recordKey(map, mode, difficulty). */
export type RecordTable = Record<string, Partial<Record<RecordCategory, RecordEntry[]>>>

export const TOP = 10
export const RECORD_CATEGORIES: readonly { id: RecordCategory; label: string; better: 'high' | 'low'; unit: 'round' | 'time' | 'kills' }[] = [
  { id: 'bestRound', label: 'Best round', better: 'high', unit: 'round' },
  { id: 'round10', label: 'Fastest to round 10', better: 'low', unit: 'time' },
  { id: 'round20', label: 'Fastest to round 20', better: 'low', unit: 'time' },
  { id: 'kills', label: 'Most kills', better: 'high', unit: 'kills' },
]
export const RECORD_MAPS: Record<string, string> = { compound: 'The Compound' }

export const recordKey = (map: string, mode: RecordMode, difficulty: string) => `${map}|${mode}|${difficulty}`

/** A finished game, as the records see it. `reached10`/`reached20`: seconds into the game each round started. */
export type RecordRun = { round: number; kills: number; reached10?: number | null; reached20?: number | null; date?: number }
/** Where this game placed: each category it made the top ten of, and its place (1 is the best). */
export type Placing = { category: RecordCategory; rank: number; value: number }

const good = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * Put a finished game into the table (a new table; the old one is left as it was). Returns the table and every
 * top-ten place it took. Ties keep the older entry ahead. A game that did not reach round 10 has no time for it.
 */
export function submitRun(table: RecordTable, key: string, run: RecordRun): { table: RecordTable; placed: Placing[] } {
  const date = run.date ?? Date.now()
  const round = Math.max(0, Math.floor(run.round) || 0), kills = Math.max(0, Math.floor(run.kills) || 0)
  const values: Partial<Record<RecordCategory, number>> = { bestRound: round || undefined, kills: kills || undefined,
    round10: round >= 10 && good(run.reached10) ? Math.round(run.reached10 * 10) / 10 : undefined,
    round20: round >= 20 && good(run.reached20) ? Math.round(run.reached20 * 10) / 10 : undefined }
  const next: RecordTable = { ...table, [key]: { ...(table[key] ?? {}) } }
  const placed: Placing[] = []
  for (const category of RECORD_CATEGORIES) {
    const value = values[category.id]
    if (value === undefined) continue
    const list = [...(next[key][category.id] ?? [])]
    const entry: RecordEntry = { value, date, round, kills }
    // After every entry that is as good or better (the older one stays ahead on a tie).
    let at = list.findIndex(e => category.better === 'high' ? value > e.value : value < e.value)
    if (at < 0) at = list.length
    if (at >= TOP) continue
    list.splice(at, 0, entry)
    next[key][category.id] = list.slice(0, TOP)
    placed.push({ category: category.id, rank: at + 1, value })
  }
  return { table: next, placed }
}

/** Stored data is untrusted: only known categories, whole entries, each list sorted and cut to ten. */
export function sanitizeRecords(raw: unknown): RecordTable {
  const table: RecordTable = {}
  if (!raw || typeof raw !== 'object') return table
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.split('|').length !== 3 || !value || typeof value !== 'object') continue
    const clean: Partial<Record<RecordCategory, RecordEntry[]>> = {}
    for (const category of RECORD_CATEGORIES) {
      const list = (value as Record<string, unknown>)[category.id]
      if (!Array.isArray(list)) continue
      const entries = list.filter((e): e is RecordEntry => !!e && typeof e === 'object' && good(e.value) && good(e.date) && good(e.round) && good(e.kills))
        .map(e => ({ value: e.value, date: e.date, round: Math.floor(e.round), kills: Math.floor(e.kills) }))
      entries.sort((a, b) => category.better === 'high' ? b.value - a.value : a.value - b.value)
      if (entries.length) clean[category.id] = entries.slice(0, TOP)
    }
    if (Object.keys(clean).length) table[key] = clean
  }
  return table
}

/** "12:05" for a time, "Round 14", "312 kills". */
export function formatRecord(category: RecordCategory, value: number) {
  const unit = RECORD_CATEGORIES.find(c => c.id === category)!.unit
  if (unit === 'time') { const s = Math.max(0, Math.round(value)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  return unit === 'round' ? `Round ${value}` : `${value.toLocaleString('en-GB')} kills`
}
