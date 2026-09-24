import type { SoundEvent } from '../types'
import { Bus, VOWEL, bubbles, hiss, partials, pings, roar, ticks, tone, type SoundKit } from './sound-kit'

/**
 * The Brute's sounds, all synthesised: the snort and scraping hoof of its charge, the stomps, the bash,
 * the crash into a wall; tearing a chunk of ground up, the throw and the landing; bullets ringing off its
 * iron mask and the mask coming off; the enrage; sinking into ink, the boil where it will come up, and
 * the eruption; and the ink wave its slam sends out. Its roars are the zombies' formant voice made huge,
 * never cut off by a crowd of groans.
 *
 * Every event carries a position. 'brute-snort' takes the wind-up's length in `duration` (seconds).
 */
export const BRUTE_KINDS = ['brute-snort', 'brute-stomp', 'brute-bash', 'brute-crash', 'brute-rip', 'brute-throw', 'debris-crash', 'brute-clang', 'brute-mask-break',
  'brute-enrage', 'brute-sink', 'brute-rumble', 'brute-emerge', 'ink-wave'] as const
/** Bullets ringing off the mask: at most one clang in this many seconds, however fast the gun. */
export const CLANG_GAP = 0.085

const clangs = new WeakMap<AudioContext, number>()
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Plays one of the Brute's sounds; false if the event is not one of its. */
export function playBrute(kit: SoundKit, event: SoundEvent): boolean {
  if (!(BRUTE_KINDS as readonly string[]).includes(event.kind)) return false
  if (!kit.noise) return true
  const r = Math.random
  switch (event.kind) {
    case 'brute-snort': {
      // A snort through the mask with a low huff under it, a bellow as the head goes down, and a foot
      // scraping back twice, grit dragged over stone with the weight coming down on it.
      const d = clamp(event.duration ?? 0.9, 0.4, 1.6), bus = new Bus(kit, event, { reach: 10 })
      hiss(bus, { length: 0.3, filter: 'bandpass', sweep: [[0, 700], [0.3, 380]], q: 1.4, peak: 0.55, attack: 0.025, rate: 0.8 })
      tone(bus, { length: 0.28, type: 'sawtooth', sweep: [[0, 78], [0.28, 60]], peak: 0.3, attack: 0.03, filter: { type: 'lowpass', frequency: 480 } })
      roar(bus, { at: d * 0.22, length: d * 0.55, pitch: 52, glide: 0.85, rasp: 0.55, drive: 10, vowel: VOWEL.oo, level: 0.65 })
      for (const at of [d * 0.38, d * 0.7]) {
        hiss(bus, { at, length: 0.22, filter: 'bandpass', sweep: [[0, 950], [0.22, 480]], q: 1, peak: 0.42, attack: 0.03, rate: 0.6, drive: 3 })
        tone(bus, { at, length: 0.14, sweep: [[0, 90], [0.12, 42]], peak: 0.4, attack: 0.005 })
      }
      bus.done()
      break
    }
    case 'brute-stomp': {
      // A footfall of the charge, several a second: a deep thud and a crunch of ground.
      const bus = new Bus(kit, event, { reach: 7 }), weight = 0.9 + r() * 0.2
      tone(bus, { length: 0.2, sweep: [[0, 82 * weight], [0.18, 38]], peak: 0.7, attack: 0.004 })
      hiss(bus, { length: 0.12, filter: 'lowpass', sweep: [[0, 800], [0.12, 250]], peak: 0.38, attack: 0.003, rate: 0.6 })
      bus.done()
      break
    }
    case 'brute-bash': {
      // Its bulk hitting a body: a heavy thump, a slap of flesh, a crack.
      const bus = new Bus(kit, event, { reach: 6 })
      tone(bus, { length: 0.24, sweep: [[0, 120], [0.2, 45]], peak: 0.8, attack: 0.004 })
      hiss(bus, { length: 0.16, filter: 'bandpass', sweep: [[0, 1300], [0.15, 380]], q: 1.2, peak: 0.6, attack: 0.003, rate: 0.9 })
      hiss(bus, { at: 0.005, length: 0.035, filter: 'highpass', sweep: 2200, peak: 0.3, attack: 0.002, rate: 1.5 })
      bus.done()
      break
    }
    case 'brute-crash': {
      // Into a wall: a deep boom, the crash of what it hit and the bits coming down, its irons ringing,
      // and a dazed groan.
      const bus = new Bus(kit, event, { reach: 12 })
      tone(bus, { length: 0.7, sweep: [[0, 70], [0.6, 28]], peak: 0.9, attack: 0.005 })
      hiss(bus, { length: 0.55, filter: 'lowpass', sweep: [[0, 1700], [0.5, 380]], peak: 0.8, attack: 0.004, rate: 0.7, drive: 2 })
      ticks(bus, { at: 0.08, count: 8, spread: 0.85, band: [1200, 3000], q: 3, peak: 0.25, decay: 0.05, rate: 2.5 })
      partials(bus, { at: 0.01, base: 380, ratios: [1, 2.76, 5.4], decay: 0.9, peak: 0.12 })
      roar(bus, { at: 0.5, length: 0.9, pitch: 46, glide: 0.75, rasp: 0.4, drive: 6, vowel: VOWEL.oo, level: 0.5 })
      bus.done()
      break
    }
    case 'brute-rip': {
      // Tearing a chunk out of the ground: a grinding crack that climbs, a deep crunch, stones falling off
      // it, and the effort.
      const bus = new Bus(kit, event, { reach: 8 })
      hiss(bus, { length: 0.42, filter: 'bandpass', sweep: [[0, 280], [0.38, 1400]], q: 1.6, peak: 0.6, attack: 0.03, rate: 0.7, drive: 8 })
      tone(bus, { length: 0.3, sweep: [[0, 75], [0.28, 36]], peak: 0.6, attack: 0.006 })
      ticks(bus, { at: 0.12, count: 6, spread: 0.5, band: [1000, 2800], q: 3, peak: 0.2, decay: 0.045, rate: 2.5 })
      roar(bus, { length: 0.45, pitch: 58, glide: 1.1, rasp: 0.5, drive: 8, vowel: VOWEL.uh, level: 0.45 })
      bus.done()
      break
    }
    case 'brute-throw': {
      // The chunk leaving its hand: a heavy whoosh, and a grunt behind it.
      const bus = new Bus(kit, event, { reach: 7 })
      hiss(bus, { length: 0.5, filter: 'bandpass', sweep: [[0, 260], [0.2, 950], [0.5, 320]], q: 1, peak: 0.6, attack: 0.14, rate: 1.2 })
      roar(bus, { length: 0.32, pitch: 62, glide: 0.8, rasp: 0.6, drive: 9, vowel: VOWEL.aa, level: 0.45 })
      bus.done()
      break
    }
    case 'debris-crash': {
      // The chunk landing and bursting: a boom, a crunch, rubble scattering, dust settling.
      const bus = new Bus(kit, event, { reach: 10 })
      tone(bus, { length: 0.55, sweep: [[0, 75], [0.5, 30]], peak: 0.85, attack: 0.004 })
      hiss(bus, { length: 0.38, filter: 'lowpass', sweep: [[0, 2200], [0.35, 480]], peak: 0.7, attack: 0.003, rate: 0.8, drive: 2 })
      ticks(bus, { at: 0.05, count: 10, spread: 0.95, band: [800, 2600], q: 3, peak: 0.3, decay: 0.05, rate: 2.5 })
      hiss(bus, { at: 0.1, length: 0.8, filter: 'highpass', sweep: 1500, peak: 0.08, attack: 0.05 })
      bus.done()
      break
    }
    case 'brute-clang': {
      // A bullet off the iron mask: a bright tick and a riveted plate's clank; now and then a ricochet
      // whines away. Fast guns hit it many times a second, so the clangs are spaced.
      const now = kit.context.currentTime, last = clangs.get(kit.context)
      if (last !== undefined && now - last < CLANG_GAP) return true
      clangs.set(kit.context, now)
      const bus = new Bus(kit, event, { reach: 6 }), pitch = 0.9 + r() * 0.25
      hiss(bus, { length: 0.012, filter: 'highpass', sweep: 3000, peak: 0.35, attack: 0.001, rate: 1.6 })
      partials(bus, { base: 820 * pitch, ratios: [1, 2.32, 4.1], decay: 0.28, peak: 0.16 })
      if (r() < 0.25) tone(bus, { at: 0.01, length: 0.2, sweep: [[0, 2400], [0.2, 1500]], peak: 0.05, attack: 0.01 })
      bus.done()
      break
    }
    case 'brute-mask-break': {
      // The rivets giving way (a sharp crack and pings), the plate ringing as it tears off, whirling through
      // the air and landing a moment later, and the Brute bellowing, bare-faced.
      const bus = new Bus(kit, event, { reach: 10 })
      hiss(bus, { length: 0.05, filter: 'highpass', sweep: 1800, peak: 0.8, attack: 0.002, rate: 1.3 })
      pings(bus, { notes: [[0, 3100], [0.035, 2650], [0.075, 3400]], decay: 0.04, peak: 0.12 })
      partials(bus, { base: 420, ratios: [1, 2.76, 5.4, 8.9], decay: 1.4, peak: 0.3 })
      hiss(bus, { at: 0.05, length: 0.42, filter: 'bandpass', sweep: [[0, 600], [0.2, 1800], [0.42, 500]], q: 1.4, peak: 0.25, attack: 0.15, rate: 1.2 })
      partials(bus, { at: 0.72, base: 300, ratios: [1, 2.3, 4.1], decay: 0.4, peak: 0.2 })
      tone(bus, { at: 0.72, length: 0.14, sweep: [[0, 110], [0.12, 50]], peak: 0.4, attack: 0.004 })
      roar(bus, { at: 0.12, length: 1, pitch: 48, glide: 0.7, rasp: 0.6, drive: 12, vowel: VOWEL.aa, level: 0.75 })
      bus.done()
      break
    }
    case 'brute-enrage': {
      // Huge: two roars a fifth apart, a chest-deep rumble under them, grit, and the chains rattling.
      kit.duck?.()
      const bus = new Bus(kit, event, { reach: 22 })
      roar(bus, { length: 1.4, pitch: 44, glide: 0.72, rasp: 0.7, drive: 16, vowel: VOWEL.aa, level: 0.95 })
      roar(bus, { at: 0.03, length: 1.35, pitch: 66, glide: 0.7, rasp: 0.5, drive: 12, vowel: VOWEL.ae, level: 0.45 })
      tone(bus, { length: 1.4, sweep: [[0, 55], [1.4, 40]], peak: 0.5, attack: 0.1, hold: 0.8 })
      hiss(bus, { length: 1.4, filter: 'bandpass', sweep: 1400, q: 0.8, peak: 0.2, attack: 0.1, hold: 0.8, drive: 6 })
      ticks(bus, { at: 0.1, count: 8, spread: 1.1, band: [3000, 5200], q: 5, peak: 0.1, decay: 0.03, rate: 2.5 })
      bus.done()
      break
    }
    case 'brute-sink': {
      // Going down into the ink: a roar that drowns, bubbling in its throat; the ink sucking at it and
      // closing over it with a slurp; bubbles; a rumble under it all.
      kit.duck?.()
      const bus = new Bus(kit, event, { reach: 16 })
      roar(bus, { length: 1.6, pitch: 50, glide: 0.55, rasp: 0.6, drive: 12, vowel: VOWEL.oo, level: 0.8, tremolo: { rate: 9, depth: 0.7 } })
      hiss(bus, { length: 1.5, filter: 'lowpass', sweep: [[0, 700], [1.5, 260]], peak: 0.35, attack: 0.3, hold: 0.7, rate: 0.6 })
      hiss(bus, { at: 1.35, length: 0.28, filter: 'bandpass', sweep: [[0, 300], [0.25, 1300]], q: 2, peak: 0.4, attack: 0.05, rate: 0.9 })
      bubbles(bus, { at: 0.1, length: 1.5, count: 18, pitch: [140, 420], peak: 0.3 })
      tone(bus, { length: 1.6, sweep: [[0, 48], [1.6, 34]], peak: 0.45, attack: 0.2, hold: 1 })
      bus.done()
      break
    }
    case 'brute-rumble': {
      // Where it will come up, the warning: the ground grumbling louder, ink boiling faster, the ground
      // starting to crack.
      const bus = new Bus(kit, event, { reach: 10 })
      tone(bus, { length: 2.4, sweep: [[0, 36], [2.4, 44]], peak: 0.55, attack: 2 })
      tone(bus, { length: 2.4, sweep: [[0, 53], [2.4, 62]], peak: 0.3, attack: 2 })
      hiss(bus, { length: 2.4, filter: 'lowpass', sweep: [[0, 150], [2.4, 320]], peak: 0.5, attack: 2.1, rate: 0.5 })
      bubbles(bus, { at: 0.2, length: 2.2, count: 30, pitch: [120, 380], peak: 0.28, accelerate: true })
      ticks(bus, { at: 1.6, count: 6, spread: 0.75, band: [600, 1500], q: 3, peak: 0.25, decay: 0.05, rate: 1.5 })
      bus.done()
      break
    }
    case 'brute-emerge': {
      // Bursting out of the ground (its roar comes separately): a boom, a splash of ink, a wet gloop,
      // rubble and drops raining down.
      const bus = new Bus(kit, event, { reach: 14 })
      tone(bus, { length: 0.75, sweep: [[0, 68], [0.65, 30]], peak: 0.9, attack: 0.005 })
      hiss(bus, { length: 0.6, filter: 'lowpass', sweep: [[0, 1500], [0.55, 450]], peak: 0.8, attack: 0.005, rate: 0.7 })
      hiss(bus, { at: 0.02, length: 0.32, filter: 'bandpass', sweep: [[0, 260], [0.3, 950]], q: 2, peak: 0.4, attack: 0.03, rate: 0.8 })
      ticks(bus, { at: 0.1, count: 10, spread: 1.1, band: [800, 2600], q: 3, peak: 0.3, decay: 0.05, rate: 2.5 })
      ticks(bus, { at: 0.3, count: 8, spread: 1, band: [900, 2400], q: 4, peak: 0.2, decay: 0.05, rate: 1.8 })
      bus.done()
      break
    }
    case 'ink-wave': {
      // The slam's wave running out (its boom comes separately): a rushing, gurgling swash that dies at
      // the wave's edge, and drops flung up along its path.
      const bus = new Bus(kit, event, { reach: 9 })
      hiss(bus, { length: 1.25, filter: 'bandpass', sweep: [[0, 380], [0.3, 1150], [1.25, 700]], q: 0.9, peak: 0.5, attack: 0.25, rate: 0.9, tremolo: { rate: 14, depth: 0.45 } })
      hiss(bus, { length: 1.25, filter: 'lowpass', sweep: 320, peak: 0.4, attack: 0.08, hold: 0.5, rate: 0.5 })
      ticks(bus, { at: 0.2, count: 8, spread: 1, band: [900, 2400], q: 4, peak: 0.18, decay: 0.05, rate: 1.8 })
      bus.done()
      break
    }
  }
  return true
}
