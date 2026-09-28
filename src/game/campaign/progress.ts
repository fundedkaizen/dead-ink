import { DIFFICULTIES, type Difficulty } from './types'

/**
 * The rescue campaign's progress in this browser: which missions are open, and each mission's best time and
 * stars per difficulty. Finishing a mission (on any difficulty) opens the next. Kept under its own storage key
 * (save-transfer.ts carries it to a new address). Storage can be missing or blocked, so every access is
 * guarded and the campaign still works for the session in memory.
 */
export const CAMPAIGN_KEY = 'dead-ink-campaign'
export const CAMPAIGN_VERSION = 1

/** Three stars: finished under par time, never raised the alarm, the hostage never hurt. */
export type Stars = [boolean, boolean, boolean]
export type Record_ = { time: number; stars: Stars; completions: number }
export type CampaignProgress = {
  version: number
  /** How many missions are open (the first always is). */
  unlocked: number
  /** mission id -> difficulty -> best. Stars are kept as earned over all runs. */
  best: Record<string, Partial<Record<Difficulty, Record_>>>
  /** What the select screen had chosen last. */
  selected: string | null
  difficulty: Difficulty
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

export const freshProgress = (): CampaignProgress => ({ version: CAMPAIGN_VERSION, unlocked: 1, best: {}, selected: null, difficulty: 'normal' })

const count = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

/** Stored data is untrusted: anything unknown or malformed falls back to the fresh value. */
export function sanitizeProgress(raw: unknown, missions: number): CampaignProgress {
  const progress = freshProgress()
  if (!raw || typeof raw !== 'object') return progress
  const data = raw as Record<string, unknown>
  progress.unlocked = Math.max(1, Math.min(missions, count(data.unlocked, 1)))
  progress.selected = typeof data.selected === 'string' ? data.selected : null
  progress.difficulty = DIFFICULTIES.includes(data.difficulty as Difficulty) ? data.difficulty as Difficulty : 'normal'
  const best = data.best && typeof data.best === 'object' ? data.best as Record<string, unknown> : {}
  for (const [mission, byDifficulty] of Object.entries(best)) {
    if (!byDifficulty || typeof byDifficulty !== 'object') continue
    for (const difficulty of DIFFICULTIES) {
      const entry = (byDifficulty as Record<string, unknown>)[difficulty] as Record<string, unknown> | undefined
      if (!entry || typeof entry !== 'object' || typeof entry.time !== 'number' || !(entry.time > 0)) continue
      const stars = Array.isArray(entry.stars) ? entry.stars : []
      ;(progress.best[mission] ??= {})[difficulty] = { time: entry.time, completions: Math.max(1, count(entry.completions, 1)),
        stars: [stars[0] === true, stars[1] === true, stars[2] === true] }
    }
  }
  return progress
}

export class CampaignStore {
  private memory: CampaignProgress | null = null
  constructor(private missionIds: readonly string[], private store: Store | null = typeof localStorage === 'undefined' ? null : localStorage) {}

  load(): CampaignProgress {
    if (this.memory) return this.memory
    let raw: unknown = null
    try { const text = this.store?.getItem(CAMPAIGN_KEY); raw = text ? JSON.parse(text) : null } catch { /* storage unavailable or corrupt */ }
    this.memory = sanitizeProgress(raw, this.missionIds.length)
    return this.memory
  }

  private save(progress: CampaignProgress) {
    this.memory = progress
    try { this.store?.setItem(CAMPAIGN_KEY, JSON.stringify(progress)) } catch { /* the session keeps it in memory */ }
  }

  /** Mission `id` can be played: it is among the unlocked ones. */
  isUnlocked(id: string) {
    const index = this.missionIds.indexOf(id)
    return index >= 0 && index < this.load().unlocked
  }

  select(id: string, difficulty: Difficulty) {
    if (!this.missionIds.includes(id)) return
    this.save({ ...this.load(), selected: id, difficulty })
  }

  /** The mission to start with: the last chosen one if still open, otherwise the newest open mission. */
  current() {
    const progress = this.load()
    const selected = progress.selected && this.isUnlocked(progress.selected) ? progress.selected : this.missionIds[progress.unlocked - 1]
    return { id: selected, difficulty: progress.difficulty }
  }

  /**
   * A finished mission: keep its best time and every star ever earned there, and open the next mission.
   * Returns whether a new mission opened and whether this run set a new best time.
   */
  complete(id: string, difficulty: Difficulty, time: number, stars: Stars) {
    const progress = structuredClone(this.load())
    const index = this.missionIds.indexOf(id)
    if (index < 0 || !(time > 0)) return { unlocked: null as string | null, best: false }
    const byDifficulty = progress.best[id] ??= {}
    const previous = byDifficulty[difficulty]
    const best = !previous || time < previous.time
    byDifficulty[difficulty] = { time: best ? time : previous!.time, completions: (previous?.completions ?? 0) + 1,
      stars: [0, 1, 2].map(i => stars[i] || !!previous?.stars[i]) as Stars }
    let unlocked: string | null = null
    if (index + 1 < this.missionIds.length && progress.unlocked < index + 2) {
      progress.unlocked = index + 2
      unlocked = this.missionIds[index + 1]
    }
    this.save(progress)
    return { unlocked, best }
  }

  best(id: string, difficulty: Difficulty) { return this.load().best[id]?.[difficulty] ?? null }

  /** Every star of a mission, over its difficulties (the select screen's row). */
  starCount(id: string) {
    return DIFFICULTIES.reduce((sum, difficulty) => sum + (this.best(id, difficulty)?.stars.filter(Boolean).length ?? 0), 0)
  }

  /** Forget the cached copy (a save code was loaded). */
  reload() { this.memory = null }
}

export const formatTime = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole % 3600 / 60), rest = whole % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`
}
