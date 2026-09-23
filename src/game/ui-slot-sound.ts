import type { Rarity } from './loot'
import { getSettings, volumeFor } from './settings'

/**
 * Synthesised interface sounds (no files): the Armory case reel's ticks and its win chimes. The case
 * spins in the menu, where the game's own audio may not be running, so this keeps one small audio
 * context of its own, opened on the Open click (a user gesture). Every sound reads the saved settings
 * when it starts: muted plays nothing, otherwise master x the given channel.
 */
let shared: AudioContext | null = null

/** The page's synth context, or null where Web Audio is missing. Call from a user gesture the first time. */
export function synthContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context) return null
  try { shared ??= new Context() } catch { return null }
  if (shared.state === 'suspended') void shared.resume().catch(() => {})
  return shared
}

/** A gain node at the player's volume for `channel`, into the speakers; null when muted or silent. */
export function synthOutput(channel: 'music' | 'effects', level = 1): { context: AudioContext; out: GainNode } | null {
  const settings = getSettings()
  const volume = settings.muted ? 0 : volumeFor(settings, channel) * level
  if (volume <= 0.001) return null
  const context = synthContext()
  if (!context) return null
  const out = context.createGain()
  out.gain.value = volume
  out.connect(context.destination)
  return { context, out }
}

/** A short burst of white noise, shared by every click. */
let noise: AudioBuffer | null = null
function noiseBuffer(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise
  noise = context.createBuffer(1, Math.floor(context.sampleRate * 0.05), context.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return noise
}

/**
 * One tile passing the marker: a dry mechanical click (a noise tick through a band-pass) with a little
 * wooden knock under it, like a slot machine's reel clicking over its pawl. `speed` 0..1 is how fast the
 * reel is running: slow ticks ring a touch lower and louder, as the last few before the stop do.
 */
export function playReelTick(speed: number) {
  const sound = synthOutput('effects', 0.55)
  if (!sound) return
  const { context, out } = sound, t = context.currentTime
  const slow = 1 - Math.max(0, Math.min(1, speed))
  const click = context.createBufferSource()
  click.buffer = noiseBuffer(context)
  const band = context.createBiquadFilter()
  band.type = 'bandpass'; band.frequency.value = 3200 - slow * 900 + Math.random() * 300; band.Q.value = 2.2
  const clickGain = context.createGain()
  clickGain.gain.setValueAtTime(0.55 + slow * 0.35, t)
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.03)
  click.connect(band).connect(clickGain).connect(out)
  click.start(t, Math.random() * 0.02, 0.035)
  const knock = context.createOscillator()
  knock.type = 'triangle'
  knock.frequency.setValueAtTime(820 - slow * 220, t)
  knock.frequency.exponentialRampToValueAtTime(420, t + 0.04)
  const knockGain = context.createGain()
  knockGain.gain.setValueAtTime(0.18 + slow * 0.2, t)
  knockGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  knock.connect(knockGain).connect(out)
  knock.start(t); knock.stop(t + 0.06)
  setTimeout(() => out.disconnect(), 200)
}

/** Semitones above A4 to a frequency. */
const hz = (semitones: number) => 440 * 2 ** (semitones / 12)

/**
 * What each rarity's win plays: an arpeggio climbing to a held chord. Rarer is longer, higher, brighter
 * and fuller: grey a single soft note; green two; blue three; purple four with a shimmer; gold a fanfare
 * of five, a ringing chord and a sparkle running up over it.
 */
export const REEL_WINS: Record<Rarity, { notes: number[]; step: number; hold: number; bright: number; level: number; sparkle: boolean }> = {
  common: { notes: [3], step: 0, hold: 0.35, bright: 0.2, level: 0.5, sparkle: false },
  uncommon: { notes: [3, 7], step: 0.09, hold: 0.45, bright: 0.3, level: 0.6, sparkle: false },
  rare: { notes: [3, 7, 10], step: 0.085, hold: 0.6, bright: 0.45, level: 0.7, sparkle: false },
  epic: { notes: [3, 7, 10, 15], step: 0.08, hold: 0.85, bright: 0.6, level: 0.8, sparkle: true },
  legendary: { notes: [-2, 3, 7, 10, 15], step: 0.075, hold: 1.4, bright: 0.85, level: 0.95, sparkle: true },
  mythic: { notes: [-2, 3, 7, 10, 15, 19], step: 0.07, hold: 1.8, bright: 1, level: 1, sparkle: true },
}

/** The reel stops: a win chime matched to the rarity of what it stopped on. */
export function playReelWin(rarity: Rarity) {
  const win = REEL_WINS[rarity]
  const sound = synthOutput('effects', win.level * 0.6)
  if (!sound) return
  const { context, out } = sound, t0 = context.currentTime + 0.01
  // A soft stop thunk first: the reel's brake.
  const thunk = context.createOscillator(), thunkGain = context.createGain()
  thunk.type = 'sine'; thunk.frequency.setValueAtTime(180, t0); thunk.frequency.exponentialRampToValueAtTime(70, t0 + 0.12)
  thunkGain.gain.setValueAtTime(0.5, t0); thunkGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16)
  thunk.connect(thunkGain).connect(out); thunk.start(t0); thunk.stop(t0 + 0.18)
  const end = t0 + win.step * (win.notes.length - 1) + win.hold
  win.notes.forEach((semitone, i) => {
    const start = t0 + 0.05 + i * win.step
    // A bell: a sine with a quieter bright partial, struck and ringing out; the last note rings longest.
    const last = i === win.notes.length - 1
    const ring = last ? win.hold : win.hold * 0.6
    for (const [ratio, amount, type] of [[1, 0.32, 'sine'], [2, 0.12 * win.bright, 'triangle'], [3.01, 0.05 * win.bright, 'sine']] as const) {
      const osc = context.createOscillator(), gain = context.createGain()
      osc.type = type
      osc.frequency.value = hz(semitone + 3) * ratio
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(amount, start + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.001, start + ring)
      osc.connect(gain).connect(out)
      osc.start(start); osc.stop(start + ring + 0.05)
    }
  })
  // The rarer wins hold a chord under the last note: a warm pad that swells and fades.
  if (win.notes.length >= 4) {
    const start = t0 + 0.05 + win.step * (win.notes.length - 1)
    for (const semitone of [-9, -2, 3, 7]) {
      const osc = context.createOscillator(), gain = context.createGain(), filter = context.createBiquadFilter()
      osc.type = 'sawtooth'
      osc.frequency.value = hz(semitone + 3)
      osc.detune.value = (Math.random() - 0.5) * 12
      filter.type = 'lowpass'; filter.frequency.setValueAtTime(600, start); filter.frequency.linearRampToValueAtTime(900 + 2400 * win.bright, start + 0.35)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.05, start + 0.12)
      gain.gain.exponentialRampToValueAtTime(0.001, start + win.hold + 0.3)
      osc.connect(filter).connect(gain).connect(out)
      osc.start(start); osc.stop(start + win.hold + 0.4)
    }
  }
  // Purple and gold: a sparkle of quick high notes running up over the chord.
  if (win.sparkle) {
    const count = rarity === 'epic' ? 6 : 12
    for (let i = 0; i < count; i++) {
      const start = t0 + 0.12 + win.step * (win.notes.length - 1) + i * 0.045
      const osc = context.createOscillator(), gain = context.createGain()
      osc.type = 'sine'
      osc.frequency.value = hz(27 + [0, 4, 7, 12, 16, 19][i % 6] + (i >= 6 ? 12 : 0))
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.05, start + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22)
      osc.connect(gain).connect(out)
      osc.start(start); osc.stop(start + 0.25)
    }
  }
  setTimeout(() => out.disconnect(), (end - context.currentTime + 0.8) * 1000)
}
