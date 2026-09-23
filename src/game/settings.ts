/**
 * Player settings shared by both modes: field of view, look sensitivity, graphics quality, volumes and
 * reduced motion. Kept in this browser; storage can be missing or blocked (private windows, previews), so
 * every access is guarded and the settings still work for the session in memory.
 *
 * The menu writes here; runtime code reads `getSettings()` and applies changes through `subscribeSettings`.
 */
export type Quality = 'low' | 'medium' | 'high'
/** Red blood, black ink instead of red, or no blood or gore at all. */
export type Blood = 'red' | 'ink' | 'off'
export const BLOOD_LABELS: Record<Blood, string> = { red: 'Red', ink: 'Ink', off: 'Off' }
export type Settings = {
  /** Vertical field of view in degrees while walking, unscoped. */
  fov: number
  /** Multiplies the look speed everywhere. */
  sensitivity: number
  /** Multiplies the look speed again while aiming down sights (on top of any scope's own slowdown). */
  adsSensitivity: number
  /** Multiplies a gamepad's right-stick look speed (the aiming multiplier applies on top, as for the mouse). */
  controllerSensitivity: number
  /** Pushing the right stick up looks down (gamepad only). */
  invertY: boolean
  blood: Blood
  quality: Quality
  /** 0 to 100. Master scales music and effects. */
  masterVolume: number
  musicVolume: number
  effectsVolume: number
  muted: boolean
  /** Null follows the system's prefers-reduced-motion. */
  reducedMotion: boolean | null
}

/** What the game used before settings existed: 75 degrees walking, 55% volume, full resolution, red blood. */
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  fov: 75, sensitivity: 1, adsSensitivity: 1, controllerSensitivity: 1, invertY: false, blood: 'red', quality: 'high',
  masterVolume: 55, musicVolume: 100, effectsVolume: 100, muted: false, reducedMotion: null,
}
export const SETTING_LIMITS = {
  fov: { min: 60, max: 110, step: 1 },
  sensitivity: { min: 0.2, max: 3, step: 0.05 },
  adsSensitivity: { min: 0.3, max: 1.5, step: 0.05 },
  controllerSensitivity: { min: 0.3, max: 3, step: 0.05 },
  volume: { min: 0, max: 100, step: 1 },
} as const

/**
 * Graphics quality. `pixelRatio` caps the renderer's device-pixel ratio (the biggest cost on the GPU);
 * `floor` is the supersampling floor main.ts applies on non-Retina screens (it used 1.25 before).
 */
export const QUALITY: Record<Quality, { label: string; pixelRatio: number; floor: number; blurb: string }> = {
  low: { label: 'Low', pixelRatio: 1, floor: 1, blurb: 'Fastest. Softer lines.' },
  medium: { label: 'Medium', pixelRatio: 1.5, floor: 1.25, blurb: 'Balanced.' },
  high: { label: 'High', pixelRatio: 2, floor: 1.25, blurb: 'Sharpest lines.' },
}
/** The renderer's pixel ratio for a device and a quality, as main.ts computes it (before its adaptive scale). */
export const pixelRatioFor = (devicePixelRatio: number, quality: Quality) =>
  Math.max(1, Math.min(Math.max(devicePixelRatio, QUALITY[quality].floor), QUALITY[quality].pixelRatio))

const KEY = 'stickman-settings'
const VERSION = 1

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** Stored data is untrusted: anything unknown or out of range falls back to the default or is clamped. */
export function sanitizeSettings(raw: unknown): Settings {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_SETTINGS, L = SETTING_LIMITS
  return {
    fov: Math.round(clamp(data.fov, L.fov.min, L.fov.max, d.fov)),
    sensitivity: clamp(data.sensitivity, L.sensitivity.min, L.sensitivity.max, d.sensitivity),
    adsSensitivity: clamp(data.adsSensitivity, L.adsSensitivity.min, L.adsSensitivity.max, d.adsSensitivity),
    controllerSensitivity: clamp(data.controllerSensitivity, L.controllerSensitivity.min, L.controllerSensitivity.max, d.controllerSensitivity),
    invertY: typeof data.invertY === 'boolean' ? data.invertY : d.invertY,
    blood: data.blood === 'red' || data.blood === 'ink' || data.blood === 'off' ? data.blood : d.blood,
    quality: typeof data.quality === 'string' && data.quality in QUALITY ? data.quality as Quality : d.quality,
    masterVolume: Math.round(clamp(data.masterVolume, 0, 100, d.masterVolume)),
    musicVolume: Math.round(clamp(data.musicVolume, 0, 100, d.musicVolume)),
    effectsVolume: Math.round(clamp(data.effectsVolume, 0, 100, d.effectsVolume)),
    muted: typeof data.muted === 'boolean' ? data.muted : d.muted,
    reducedMotion: typeof data.reducedMotion === 'boolean' ? data.reducedMotion : null,
  }
}

let memory: Settings | null = null
const listeners = new Set<(settings: Settings, changed: (keyof Settings)[]) => void>()

export function getSettings(): Readonly<Settings> {
  if (memory) return memory
  let raw: unknown = null
  try { const text = localStorage.getItem(KEY); raw = text ? JSON.parse(text) : null } catch { /* storage unavailable or corrupt */ }
  memory = sanitizeSettings(raw)
  return memory
}

/** Change some settings; values are clamped. Listeners hear which keys actually changed. */
export function setSettings(patch: Partial<Settings>): Readonly<Settings> {
  const before = getSettings()
  const next = sanitizeSettings({ ...before, ...patch })
  const changed = (Object.keys(next) as (keyof Settings)[]).filter(key => next[key] !== before[key])
  if (!changed.length) return before
  memory = next
  try { localStorage.setItem(KEY, JSON.stringify({ version: VERSION, ...next })) } catch { /* storage unavailable: kept in memory */ }
  for (const listener of listeners) listener(next, changed)
  return next
}

/** Called after every change with the new settings and the keys that changed. Returns an unsubscribe function. */
export function subscribeSettings(listener: (settings: Readonly<Settings>, changed: (keyof Settings)[]) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function resetSettings() { return setSettings({ ...DEFAULT_SETTINGS }) }

/** 0 to 1 for an audio channel: master x channel, or 0 when muted is handled by the caller's setMuted. */
export const volumeFor = (settings: Readonly<Settings>, channel: 'music' | 'effects') =>
  settings.masterVolume / 100 * (channel === 'music' ? settings.musicVolume : settings.effectsVolume) / 100

/**
 * The multiplier for FirstPersonController.lookSensitivity: the weapon's own factor (a sniper scope slows
 * the look by its zoom) x the player's sensitivity x the aim-down-sights multiplier while aiming.
 */
export const lookScale = (weaponFactor: number, aiming: boolean, settings: Readonly<Settings> = getSettings()) =>
  weaponFactor * settings.sensitivity * (aiming ? settings.adsSensitivity : 1)

/** The effective reduced-motion choice: the stored one, or the system's. */
export const prefersReducedMotion = (settings: Readonly<Settings> = getSettings()) =>
  settings.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

/** Checks only: forget the cached settings so the next read goes to storage again. */
export function resetSettingsCache() { memory = null }
