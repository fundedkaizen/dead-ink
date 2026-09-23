import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, QUALITY, getSettings, lookScale, pixelRatioFor, resetSettingsCache, sanitizeSettings, setSettings, subscribeSettings, volumeFor } from '../src/game/settings'
import { LOW_HEALTH, heartbeat, lowHealthLevel } from '../src/game/zombies/lowhealth'

let failures = 0
function test(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}`, error) }
}

// Storage is a stub that can be switched off, as a private window would.
const store = new Map<string, string>()
let storageWorks = true
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
  if (!storageWorks) throw new Error('storage blocked')
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
} })

test('Defaults match the game before settings existed', () => {
  store.clear(); resetSettingsCache()
  const settings = getSettings()
  assert.deepEqual(settings, DEFAULT_SETTINGS)
  assert.equal(settings.fov, 75, 'the walking camera used 75 degrees')
  assert.equal(settings.masterVolume, 55, 'the volume slider started at 55%')
})

test('Settings persist, and listeners hear exactly what changed', () => {
  store.clear(); resetSettingsCache()
  const heard: string[][] = []
  const stop = subscribeSettings((_, changed) => heard.push(changed))
  setSettings({ fov: 96, quality: 'low' })
  setSettings({ fov: 96 })
  stop()
  setSettings({ muted: true })
  assert.deepEqual(heard, [['fov', 'quality']], 'no event for a no-op; none after unsubscribing')
  resetSettingsCache()
  const saved = getSettings()
  assert.equal(saved.fov, 96); assert.equal(saved.quality, 'low'); assert.equal(saved.muted, true)
  assert.equal(JSON.parse(store.get('stickman-settings')!).version, 1)
})

test('Stored values are clamped and junk falls back to defaults', () => {
  const settings = sanitizeSettings({ fov: 500, sensitivity: -3, adsSensitivity: 'fast', quality: 'ultra', masterVolume: 37.6, reducedMotion: 'yes' })
  assert.equal(settings.fov, 110); assert.equal(settings.sensitivity, 0.2); assert.equal(settings.adsSensitivity, 1)
  assert.equal(settings.quality, 'high'); assert.equal(settings.masterVolume, 38); assert.equal(settings.reducedMotion, null)
  store.set('stickman-settings', 'not json'); resetSettingsCache()
  assert.deepEqual(getSettings(), DEFAULT_SETTINGS)
})

test('Controller sensitivity, invert Y and blood are stored and checked like the rest', () => {
  assert.equal(DEFAULT_SETTINGS.controllerSensitivity, 1); assert.equal(DEFAULT_SETTINGS.invertY, false); assert.equal(DEFAULT_SETTINGS.blood, 'red')
  const clamped = sanitizeSettings({ controllerSensitivity: 9, invertY: 'yes', blood: 'green' })
  assert.equal(clamped.controllerSensitivity, 3); assert.equal(clamped.invertY, false); assert.equal(clamped.blood, 'red')
  store.clear(); resetSettingsCache()
  setSettings({ controllerSensitivity: 1.75, invertY: true, blood: 'ink' })
  resetSettingsCache()
  const saved = getSettings()
  assert.equal(saved.controllerSensitivity, 1.75); assert.equal(saved.invertY, true); assert.equal(saved.blood, 'ink')
  assert.equal(sanitizeSettings({ blood: 'off' }).blood, 'off')
})

test('Without storage the settings still work in memory', () => {
  storageWorks = false; resetSettingsCache()
  try {
    setSettings({ fov: 80 })
    assert.equal(getSettings().fov, 80)
  } finally { storageWorks = true }
})

test('Sensitivity, aiming, volume and quality helpers', () => {
  const s = sanitizeSettings({ sensitivity: 1.5, adsSensitivity: 0.5, masterVolume: 50, musicVolume: 40, effectsVolume: 100 })
  assert.equal(lookScale(1, false, s), 1.5)
  assert.equal(lookScale(0.25, true, s), 0.25 * 1.5 * 0.5, 'a scope’s slowdown, then the player’s, then the aiming multiplier')
  assert.equal(volumeFor(s, 'music'), 0.2); assert.equal(volumeFor(s, 'effects'), 0.5)
  assert.equal(pixelRatioFor(1, 'high'), 1.25, 'High keeps the old 1.25 supersampling floor')
  assert.equal(pixelRatioFor(3, 'high'), 2)
  assert.equal(pixelRatioFor(3, 'medium'), 1.5)
  assert.equal(pixelRatioFor(3, 'low'), 1); assert.equal(pixelRatioFor(1, 'low'), 1)
  assert(QUALITY.low.pixelRatio < QUALITY.medium.pixelRatio && QUALITY.medium.pixelRatio < QUALITY.high.pixelRatio)
})

test('Low-health ink starts below half health, grows toward death, and the heartbeat has two thumps', () => {
  assert.equal(lowHealthLevel(1), 0); assert.equal(lowHealthLevel(LOW_HEALTH.threshold), 0)
  assert(lowHealthLevel(0.4) > 0 && lowHealthLevel(0.4) < lowHealthLevel(0.2) && lowHealthLevel(0.2) < lowHealthLevel(0))
  assert.equal(lowHealthLevel(0), 1); assert.equal(lowHealthLevel(-1), 1)
  assert.equal(heartbeat(0.06), 1)
  assert(heartbeat(0.26) > 0.5 && heartbeat(0.26) < 1, 'the second thump is softer')
  assert.equal(heartbeat(0.6), 0, 'and then rest')
})

if (failures) { console.error(`${failures} settings check(s) failed`); process.exit(1) }
console.log('All settings checks passed.')
