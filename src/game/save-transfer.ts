/**
 * Moving your progress between addresses or devices. Each web address keeps its own storage, so Dead Ink's
 * profile (unlocks, knives, stats), name, difficulty and settings stay behind when the game moves to a new
 * link. A save code carries exactly those keys, nothing else, as text you can paste anywhere.
 */
export const SAVE_KEYS = ['dead-ink-profile', 'dead-ink-name', 'dead-ink-difficulty', 'stickman-settings'] as const
const PREFIX = 'DEADINK1:'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** The save code for this browser's progress. */
export function exportSave(store: Store = localStorage) {
  const data: Record<string, string> = {}
  for (const key of SAVE_KEYS) { const value = store.getItem(key); if (value !== null) data[key] = value }
  return PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(data))))
}

/** Loads a save code; false (and nothing changed) if it is not one. */
export function importSave(code: string, store: Store = localStorage) {
  const text = code.trim()
  if (!text.startsWith(PREFIX)) return false
  let data: unknown
  try { data = JSON.parse(decodeURIComponent(escape(atob(text.slice(PREFIX.length))))) } catch { return false }
  if (!data || typeof data !== 'object') return false
  const entries = Object.entries(data as Record<string, unknown>).filter(([key, value]) => (SAVE_KEYS as readonly string[]).includes(key) && typeof value === 'string')
  if (!entries.length) return false
  for (const [key, value] of entries) store.setItem(key, value as string)
  return true
}
