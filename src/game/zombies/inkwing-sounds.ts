import type { SoundEvent } from '../types'
import { Bus, hiss, ticks, tone, type SoundKit } from './sound-kit'

/**
 * The Inkwings' sounds, all synthesised: wing beats of ragged ink-paper, the shriek that warns of a dive,
 * the stoop itself, claws landing, the body bursting into ink with its torn wings fluttering down, the
 * streak and splash as one arrives out of the storm, and the rattle and snap of a bite up close. Screeches
 * are reedy sawtooth shrieks, not voices.
 *
 * Events carry the Inkwing's position. 'inkwing-tell' and 'inkwing-snap' take their wind-up in
 * `duration` (seconds) so the sound lands with the move.
 */
export const INKWING_KINDS = ['inkwing-flap', 'inkwing-tell', 'inkwing-dive', 'inkwing-hit', 'inkwing-death', 'inkwing-arrive', 'inkwing-snap'] as const
/** A flock's wing beats, at most this many in any tenth of a second, so they never crowd out the rest. */
export const FLAP_BUDGET = 4

const flaps = new WeakMap<AudioContext, { window: number; count: number }>()
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Plays an Inkwing's sound; false if the event is not one of theirs. */
export function playInkwing(kit: SoundKit, event: SoundEvent): boolean {
  if (!(INKWING_KINDS as readonly string[]).includes(event.kind)) return false
  if (!kit.noise) return true
  const r = Math.random
  switch (event.kind) {
    case 'inkwing-flap': {
      const now = kit.context.currentTime, budget = flaps.get(kit.context) ?? { window: -1, count: 0 }
      if (now - budget.window >= 0.1) { budget.window = now; budget.count = 0 }
      if (budget.count >= FLAP_BUDGET) return true
      budget.count++; flaps.set(kit.context, budget)
      const bus = new Bus(kit, event, { priority: 'incidental' }), size = 0.85 + r() * 0.3
      // The downstroke, a soft whump of air, and the ragged edge fluttering.
      hiss(bus, { length: 0.16, filter: 'lowpass', sweep: [[0, 900 * size], [0.16, 300]], peak: 0.32, attack: 0.018, rate: 0.7 })
      ticks(bus, { at: 0.012, count: 3, spread: 0.05, band: [2600, 4200], q: 2.5, peak: 0.07, decay: 0.014, rate: 2.2 })
      bus.done()
      break
    }
    case 'inkwing-tell': {
      // The warning, and it has to carry: a rasping shriek that climbs and bends, rattled by a fast
      // vibrato, over a dry rattle that swells until the dive.
      const length = clamp(event.duration ?? 0.5, 0.25, 1.2), bus = new Bus(kit, event, { reach: 8 })
      for (const [detune, peak] of [[1, 0.26], [1.065, 0.18]] as const) {
        tone(bus, { length, type: 'sawtooth', sweep: [[0, 1050 * detune], [length * 0.6, 1750 * detune], [length, 1300 * detune]], peak, attack: 0.03, hold: length * 0.5,
          drive: 5, filter: { type: 'bandpass', frequency: 2300, q: 2.2 }, vibrato: { rate: 27, depth: 70 } })
      }
      hiss(bus, { length, filter: 'bandpass', sweep: 4200, q: 2, peak: 0.12, attack: length * 0.4, tremolo: { rate: 31, depth: 0.8 } })
      bus.done()
      break
    }
    case 'inkwing-dive': {
      // Wings snapping shut, then air tearing past louder and higher as it falls on you, and the pull-up.
      const bus = new Bus(kit, event, { reach: 6 })
      hiss(bus, { length: 0.05, filter: 'highpass', sweep: 1600, peak: 0.18, attack: 0.004, rate: 1.4 })
      hiss(bus, { length: 0.85, filter: 'bandpass', sweep: [[0, 450], [0.6, 2500], [0.85, 1400]], q: 1.2, peak: 0.42, attack: 0.58, rate: 1.1 })
      tone(bus, { at: 0.05, length: 0.8, sweep: [[0, 1700], [0.55, 2700], [0.8, 1300]], peak: 0.05, attack: 0.5 })
      bus.done()
      break
    }
    case 'inkwing-hit': {
      // Claws raking: a bright slash that drops, the blow, and wet ink.
      const bus = new Bus(kit, event)
      hiss(bus, { length: 0.14, filter: 'bandpass', sweep: [[0, 3400], [0.14, 800]], q: 1.4, peak: 0.55, attack: 0.003, rate: 1.3, drive: 3 })
      tone(bus, { length: 0.18, sweep: [[0, 150], [0.15, 55]], peak: 0.55, attack: 0.004 })
      hiss(bus, { at: 0.01, length: 0.12, filter: 'lowpass', sweep: 1300, peak: 0.28, attack: 0.004, rate: 0.9 })
      bus.done()
      break
    }
    case 'inkwing-death': {
      // A last squeal falling away, the body bursting (a wet pop and slap), ink raining down, and the torn
      // wings fluttering after it.
      const bus = new Bus(kit, event, { reach: 5 })
      tone(bus, { length: 0.3, type: 'sawtooth', sweep: [[0, 1500], [0.28, 340]], peak: 0.22, attack: 0.01, drive: 4, filter: { type: 'bandpass', frequency: 1800, q: 1.8 } })
      tone(bus, { length: 0.12, sweep: [[0, 720], [0.07, 110]], peak: 0.6, attack: 0.004 })
      hiss(bus, { length: 0.18, filter: 'bandpass', sweep: [[0, 2400], [0.16, 650]], q: 1.6, peak: 0.7, attack: 0.003, rate: 1.2 })
      ticks(bus, { at: 0.1, count: 5, spread: 0.45, band: [900, 2400], q: 4, peak: 0.22, decay: 0.05, rate: 1.8 })
      ticks(bus, { at: 0.3, count: 5, spread: 0.6, band: [2600, 4200], q: 2.5, peak: 0.07, decay: 0.02, rate: 2.4 })
      bus.done()
      break
    }
    case 'inkwing-arrive': {
      // A streak of ink falling out of the storm, a splash as it lands, drops scattering, and the thing
      // that forms in the splash shrieking.
      const bus = new Bus(kit, event, { reach: 7 })
      hiss(bus, { length: 0.47, filter: 'bandpass', sweep: [[0, 3400], [0.45, 600]], q: 2, peak: 0.36, attack: 0.38, rate: 1.1 })
      tone(bus, { length: 0.46, sweep: [[0, 2300], [0.45, 480]], peak: 0.06, attack: 0.3 })
      hiss(bus, { at: 0.45, length: 0.4, filter: 'lowpass', sweep: [[0, 1100], [0.4, 350]], peak: 0.65, attack: 0.006, rate: 0.8 })
      tone(bus, { at: 0.45, length: 0.26, sweep: [[0, 95], [0.24, 40]], peak: 0.55, attack: 0.006 })
      ticks(bus, { at: 0.5, count: 5, spread: 0.4, band: [900, 2400], q: 4, peak: 0.2, decay: 0.05, rate: 1.8 })
      tone(bus, { at: 0.62, length: 0.24, type: 'sawtooth', sweep: [[0, 1250], [0.12, 1850], [0.24, 1500]], peak: 0.2, attack: 0.02,
        drive: 5, filter: { type: 'bandpass', frequency: 2200, q: 2.2 }, vibrato: { rate: 26, depth: 60 } })
      bus.done()
      break
    }
    case 'inkwing-snap': {
      // The wind-up rattles and rises; the beak snaps shut at its end.
      const windUp = clamp(event.duration ?? 0.35, 0.15, 1), bus = new Bus(kit, event)
      hiss(bus, { length: windUp, filter: 'bandpass', sweep: [[0, 2600], [windUp, 3800]], q: 3, peak: 0.22, attack: windUp * 0.9, rate: 1.5, tremolo: { rate: 34, depth: 0.9 } })
      hiss(bus, { at: windUp, length: 0.02, filter: 'highpass', sweep: 2500, peak: 0.7, attack: 0.002, rate: 1.6 })
      tone(bus, { at: windUp, length: 0.035, type: 'triangle', sweep: [[0, 1900], [0.03, 850]], peak: 0.4, attack: 0.002 })
      bus.done()
      break
    }
  }
  return true
}
