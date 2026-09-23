import { MissionAudio } from '../audio'
import type { SoundEvent } from '../types'

/**
 * Dead Ink's sounds on top of the mission's (guns, footsteps, hits, bodies): zombie voices, the ground
 * breaking as one climbs out, power-ups, the Nuke, and the round stings. All synthesised, so nothing
 * needs downloading; a recorded file for any kind can replace its synthesis later.
 *
 * Voices are formant synthesis: a rasping sawtooth that slides in pitch, breath noise, a waveshaper for
 * the rattle, and two vowel formants. Groans are low and long, sprinter screams high and harsh.
 */
const VOICE_LIMIT = 6
/** Footsteps sit lower than in the mission: a crowd of zombies' steps adds up fast. */
const FOOTSTEP_VOLUME: Record<string, number> = { footstep: 0.65, 'enemy-footstep': 0.55 }
const VOWELS = { uh: [640, 1190], aa: [760, 1150], oo: [380, 900], ae: [820, 1550] } as const
/** The Mystery Box's spin tune: 24 notes of a wind-up music box in A minor, 3.1 s. Original. */
const BOX_TUNE: readonly number[] = [
  880, 1046.5, 1318.5, 1760, 1661.2, 1318.5, 1046.5, 987.8,
  880, 1046.5, 1318.5, 1975.5, 1760, 1318.5, 1046.5, 1174.7,
  1318.5, 1174.7, 1046.5, 987.8, 880, 830.6, 880, 1760,
]
/** Each perk machine's own little tune (original, sixteen notes: a phrase and its answer). */
const JINGLES: Record<string, { notes: readonly number[]; step: number }> = {
  thickInk: { notes: [196, 233.1, 261.6, 233.1, 196, 174.6, 196, 146.8, 196, 233.1, 293.7, 261.6, 233.1, 196, 233.1, 196], step: 0.24 },
  quickDip: { notes: [523.3, 659.3, 784, 1046.5, 784, 659.3, 784, 1046.5, 1174.7, 1046.5, 880, 784, 880, 1046.5, 1318.5, 1046.5], step: 0.11 },
  doubleLine: { notes: [392, 392, 523.3, 392, 392, 587.3, 523.3, 440, 392, 392, 659.3, 587.3, 523.3, 440, 493.9, 523.3], step: 0.15 },
  secondDraft: { notes: [440, 554.4, 659.3, 880, 659.3, 554.4, 440, 329.6, 440, 554.4, 659.3, 739.99, 659.3, 554.4, 493.9, 440], step: 0.17 },
  spareNib: { notes: [329.6, 415.3, 493.9, 415.3, 329.6, 246.9, 329.6, 493.9, 554.4, 493.9, 415.3, 329.6, 369.99, 415.3, 493.9, 659.3], step: 0.16 },
}
type Voice = { pitch: number; glide: number; length: number; rasp: number; drive: number; vowel: readonly [number, number]; level: number }

export class DeadInkAudio extends MissionAudio {
  // Dead Ink has real music tracks (music.ts), so the generated phrase stays off.
  protected generatedMusic = false
  private voices = new Set<AudioScheduledSourceNode>()
  private curve: Float32Array<ArrayBuffer> | null = null

  play(event: SoundEvent) {
    const context = this.context
    const handled = ['zombie-groan', 'zombie-scream', 'zombie-snarl', 'zombie-swipe', 'zombie-rise', 'powerup-drop', 'powerup-grab', 'nuke', 'round-start', 'round-end',
      'perk-drink', 'perk-jingle', 'pack-work', 'pack-ready', 'boss-roar', 'boss-growl', 'boss-slam', 'box-leave', 'box-open', 'box-spin', 'box-offer', 'ink-burst', 'grenade-blast', 'grenade-throw']
    if (event.kind === 'door' && this.context && this.active && !this.muted) this.slam(event)
    if (!handled.includes(event.kind)) { super.play(FOOTSTEP_VOLUME[event.kind] ? { ...event, volume: FOOTSTEP_VOLUME[event.kind] } : event); return }
    if (!context || !this.master || !this.active || this.muted || this.volume <= 0 || this.disposed || this.dying) return
    if (event.position && event.position.distanceTo(this.listenerPosition) > (event.radius ?? 60)) return
    if (this.sources.size >= 72) return
    if (this.sample(event)) return
    const r = Math.random
    switch (event.kind) {
      case 'zombie-groan': this.voice(event, { pitch: 62 + r() * 34, glide: 0.72 + r() * 0.2, length: 1 + r() * 0.9, rasp: 0.35, drive: 5, vowel: r() < 0.5 ? VOWELS.uh : VOWELS.oo, level: 0.5 }); break
      case 'zombie-scream': this.voice(event, { pitch: 170 + r() * 80, glide: 0.62 + r() * 0.15, length: 0.65 + r() * 0.35, rasp: 0.65, drive: 11, vowel: r() < 0.5 ? VOWELS.aa : VOWELS.ae, level: 0.62 }); break
      case 'zombie-snarl': this.voice(event, { pitch: 105 + r() * 30, glide: 1.25, length: 0.32, rasp: 0.8, drive: 9, vowel: VOWELS.aa, level: 0.6 }); break
      case 'zombie-swipe': this.whoosh(event); break
      case 'zombie-rise': this.dirt(event); this.voice(event, { pitch: 58 + r() * 20, glide: 0.8, length: 1.4, rasp: 0.4, drive: 6, vowel: VOWELS.oo, level: 0.45 }, 0.25); break
      case 'powerup-drop': this.shimmer(event); break
      case 'powerup-grab': this.arpeggio(event, [659.3, 880, 1318.5], 0.07, 'triangle', 0.22); break
      case 'nuke': this.boom(event); break
      // The Ink Storm rolling in: thunder, then the rain of grit.
      case 'storm': this.boom(event); this.dirt(event); break
      // The Ink Doll's cymbals: a bright, short crash of hiss.
      case 'doll-clap': this.clash(event); break
      case 'round-start': this.bell(event, [55, 82.4, 110], 3.2, 0.5); break
      // The round is over, not won: a low minor chord under a tolling, slightly sour bell.
      case 'round-end': this.bell(event, [73.4, 87.3, 110, 103.8], 4.2, 0.55); break
      case 'perk-drink': this.glugs(event); break
      case 'perk-jingle': { const tune = JINGLES[event.voice ?? '']; if (tune) this.melody(event, tune.notes, tune.step, 0.09); break }
      case 'pack-work': this.pound(event); break
      case 'pack-ready': this.arpeggio(event, [523.3, 659.3, 784, 1046.5, 1318.5], 0.06, 'triangle', 0.18, 0.9); break
      // The Brute: the same voice as the others, an octave and more down, and much louder.
      case 'boss-roar': this.voice(event, { pitch: 40 + r() * 8, glide: 0.62, length: 2.3, rasp: 0.7, drive: 14, vowel: VOWELS.aa, level: 1 }); break
      case 'boss-growl': this.voice(event, { pitch: 36 + r() * 10, glide: 0.8, length: 1.4, rasp: 0.5, drive: 9, vowel: VOWELS.oo, level: 0.8 }); break
      case 'boss-slam': this.boom(event); this.dirt(event); break
      // The box leaving: a music box winding down, out of tune.
      case 'box-leave': this.arpeggio(event, [987.8, 932.3, 880, 830.6, 784, 698.5, 622.3], 0.19, 'sine', 0.14, 1.1); break
      case 'box-open': this.creak(event); break
      case 'ink-burst': this.dirt(event); this.whoosh(event); break
      case 'grenade-blast': this.boom(event); this.dirt(event); break
      case 'grenade-throw': this.whoosh(event); break
      // The spin: a wind-up music box, original tune, the length of the spin.
      case 'box-spin': this.melody(event, BOX_TUNE, 0.13, 0.08); break
      case 'box-offer': this.arpeggio(event, [880, 1108.7, 1318.5, 1760], 0.05, 'triangle', 0.2, 0.8); break
    }
  }

  /** A music-box tune from a point in the world: a perk machine's jingle. */
  private melody(event: SoundEvent, notes: readonly number[], step: number, level: number) {
    const context = this.context!, t = context.currentTime
    notes.forEach((frequency, i) => {
      const start = t + i * step
      for (const [ratio, weight] of [[1, 1], [2, 0.35], [3.01, 0.12]] as const) {
        const { gain, panner } = this.output(event)
        const tone = context.createOscillator()
        tone.type = 'sine'; tone.frequency.value = frequency * ratio
        gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(level * weight, start + 0.008)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + step * 2.4)
        tone.connect(gain)
        this.track(tone, [gain, ...(panner ? [panner] : [])])
        tone.start(start); tone.stop(start + step * 2.5)
      }
    })
  }

  /** The lid: a wooden creak and a breath of air. */
  private creak(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const saw = context.createOscillator(), band = context.createBiquadFilter()
    saw.type = 'sawtooth'
    saw.frequency.setValueAtTime(70, t); saw.frequency.linearRampToValueAtTime(110, t + 0.35); saw.frequency.linearRampToValueAtTime(85, t + 0.5)
    band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 4
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.18, t + 0.05); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
    saw.connect(band).connect(gain)
    this.track(saw, [band, gain, ...(panner ? [panner] : [])])
    saw.start(t); saw.stop(t + 0.57)
    this.whoosh(event)
  }

  /**
   * Drinking: three gulps (a throat's pitch drop with a wet click at the start of each), then the
   * swallow and a breath out.
   */
  private glugs(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    for (let i = 0; i < 3; i++) {
      const at = t + 0.5 + i * 0.3
      const { gain } = this.output({ kind: event.kind })
      const throat = context.createOscillator(), shape = context.createBiquadFilter()
      throat.type = 'triangle'
      throat.frequency.setValueAtTime(190 - i * 12, at); throat.frequency.exponentialRampToValueAtTime(85, at + 0.16)
      shape.type = 'lowpass'; shape.frequency.value = 700; shape.Q.value = 8
      gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.9, at + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2)
      throat.connect(shape).connect(gain)
      this.track(throat, [shape, gain]); throat.start(at); throat.stop(at + 0.22)
      const { gain: click } = this.output({ kind: event.kind })
      const wet = context.createBufferSource(), band = context.createBiquadFilter()
      wet.buffer = this.noise; wet.playbackRate.value = 2.5
      band.type = 'bandpass'; band.frequency.value = 1400; band.Q.value = 5
      click.gain.setValueAtTime(0.0001, at); click.gain.exponentialRampToValueAtTime(0.35, at + 0.005); click.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
      wet.connect(band).connect(click)
      this.track(wet, [band, click]); wet.start(at); wet.stop(at + 0.06)
    }
    // "Ahh": a breath out after the last gulp.
    const at = t + 1.45
    const { gain } = this.output({ kind: event.kind })
    const breath = context.createBufferSource(), band = context.createBiquadFilter()
    breath.buffer = this.noise; breath.playbackRate.value = 1.1
    band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 1.2
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.45, at + 0.08); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5)
    breath.connect(band).connect(gain)
    this.track(breath, [band, gain]); breath.start(at); breath.stop(at + 0.52)
  }

  /** A door swinging to: a creak and a heavy wooden knock at the end. */
  private slam(event: SoundEvent) {
    this.creak(event)
    const context = this.context!, at = context.currentTime + 0.45
    const { gain, panner } = this.output(event)
    const knock = context.createOscillator()
    knock.type = 'sine'; knock.frequency.setValueAtTime(140, at); knock.frequency.exponentialRampToValueAtTime(55, at + 0.18)
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.7, at + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3)
    knock.connect(gain)
    this.track(knock, [gain, ...(panner ? [panner] : [])]); knock.start(at); knock.stop(at + 0.32)
  }

  /** The Pack-a-Punch at work: heavy strokes of the press under a rising whine. */
  private pound(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    for (let i = 0; i < 6; i++) {
      const at = t + 0.3 + i * 0.45
      const { gain, panner } = this.output(event)
      const thud = context.createOscillator()
      thud.type = 'sine'; thud.frequency.setValueAtTime(120, at); thud.frequency.exponentialRampToValueAtTime(45, at + 0.18)
      gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.8, at + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25)
      thud.connect(gain)
      this.track(thud, [gain, ...(panner ? [panner] : [])])
      thud.start(at); thud.stop(at + 0.27)
    }
    const { gain, panner } = this.output(event)
    const whine = context.createOscillator()
    whine.type = 'triangle'; whine.frequency.setValueAtTime(220, t); whine.frequency.exponentialRampToValueAtTime(880, t + 3.1)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.08, t + 0.4); gain.gain.setValueAtTime(0.08, t + 2.9); gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.2)
    whine.connect(gain)
    this.track(whine, [gain, ...(panner ? [panner] : [])])
    whine.start(t); whine.stop(t + 3.25)
  }

  private waveshaper(drive: number) {
    if (!this.curve || this.curve[0] !== -Math.tanh(drive)) {
      const curve = new Float32Array(new ArrayBuffer(1024 * 4))
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / (curve.length - 1) * 2 - 1) * drive)
      this.curve = curve
    }
    const shaper = this.context!.createWaveShaper()
    shaper.curve = this.curve
    return shaper
  }

  /** A zombie's voice: rasping, sliding, rattling, shaped into a vowel. */
  private voice(event: SoundEvent, v: Voice, delay = 0) {
    const context = this.context!
    if (this.voices.size >= VOICE_LIMIT) return
    const t = context.currentTime + delay, end = t + v.length
    const { gain, panner } = this.output(event)
    const saw = context.createOscillator()
    saw.type = 'sawtooth'
    saw.frequency.setValueAtTime(v.pitch, t)
    saw.frequency.linearRampToValueAtTime(v.pitch * (1 + (v.glide - 1) * 0.3), t + v.length * 0.35)
    saw.frequency.exponentialRampToValueAtTime(v.pitch * v.glide, end)
    // Unsteady pitch: a wobble, and a slower drift.
    const wobble = context.createOscillator(), wobbleDepth = context.createGain()
    wobble.frequency.value = 6 + Math.random() * 5
    wobbleDepth.gain.value = v.pitch * 0.05
    wobble.connect(wobbleDepth).connect(saw.frequency)
    const breath = context.createBufferSource(), breathLevel = context.createGain()
    breath.buffer = this.noise; breath.loop = true; breath.playbackRate.value = 1.6
    breathLevel.gain.value = v.rasp
    const mix = context.createGain()
    saw.connect(mix); breath.connect(breathLevel).connect(mix)
    const shaper = this.waveshaper(v.drive)
    mix.connect(shaper)
    const formants = v.vowel.map((frequency, i) => {
      const band = context.createBiquadFilter()
      band.type = 'bandpass'; band.frequency.value = frequency * (0.92 + Math.random() * 0.16); band.Q.value = i ? 9 : 5
      shaper.connect(band).connect(gain)
      return band
    })
    const body = context.createBiquadFilter()
    body.type = 'lowpass'; body.frequency.value = 420
    shaper.connect(body).connect(gain)
    // Swells in, rattles, trails off.
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(v.level, t + Math.min(0.12, v.length * 0.2))
    gain.gain.setValueAtTime(v.level, t + v.length * 0.55)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    const nodes: AudioNode[] = [wobbleDepth, breathLevel, mix, shaper, ...formants, body, gain, ...(panner ? [panner] : [])]
    this.track(saw, nodes); this.track(wobble, []); this.track(breath, [])
    this.voices.add(saw)
    saw.addEventListener('ended', () => this.voices.delete(saw))
    for (const source of [saw, wobble, breath]) { source.start(t); source.stop(end + 0.02) }
    this.duckMusic()
  }

  /** The claw's swing through the air. */
  private whoosh(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const noise = context.createBufferSource(), band = context.createBiquadFilter()
    noise.buffer = this.noise; noise.playbackRate.value = 2.2
    band.type = 'bandpass'; band.Q.value = 1.4
    band.frequency.setValueAtTime(500, t); band.frequency.exponentialRampToValueAtTime(2600, t + 0.12); band.frequency.exponentialRampToValueAtTime(700, t + 0.26)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.5, t + 0.06); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
    noise.connect(band).connect(gain)
    this.track(noise, [band, gain, ...(panner ? [panner] : [])], 'incidental')
    noise.start(t); noise.stop(t + 0.3)
  }

  /** Ground breaking: a thud, then clods pattering down. */
  /** A small cymbal: a bright band of hiss that rings off quickly, with a metallic ping on top. */
  private clash(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const hiss = context.createBufferSource(), high = context.createBiquadFilter()
    hiss.buffer = this.noise; hiss.playbackRate.value = 1.6
    high.type = 'highpass'; high.frequency.value = 5200
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.35, t + 0.004); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
    hiss.connect(high).connect(gain)
    const ping = context.createOscillator()
    ping.type = 'square'; ping.frequency.value = 2950 + Math.random() * 200
    const pingGain = context.createGain()
    pingGain.gain.setValueAtTime(0.04, t); pingGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    ping.connect(pingGain).connect(gain)
    this.track(hiss, [high, gain, ...(panner ? [panner] : [])], 'incidental')
    this.track(ping, [pingGain], 'incidental')
    hiss.start(t); hiss.stop(t + 0.3); ping.start(t); ping.stop(t + 0.13)
  }

  private dirt(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const thud = context.createBufferSource(), low = context.createBiquadFilter()
    thud.buffer = this.noise; thud.playbackRate.value = 0.5
    low.type = 'lowpass'; low.frequency.value = 260
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.9, t + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
    thud.connect(low).connect(gain)
    this.track(thud, [low, gain, ...(panner ? [panner] : [])], 'incidental')
    thud.start(t); thud.stop(t + 0.72)
    for (let i = 0; i < 7; i++) {
      const at = t + 0.18 + Math.random() * 0.8
      const { gain: tick, panner: tickPanner } = this.output(event)
      const clod = context.createBufferSource(), band = context.createBiquadFilter()
      clod.buffer = this.noise; clod.playbackRate.value = 3
      band.type = 'bandpass'; band.frequency.value = 1400 + Math.random() * 1800; band.Q.value = 3
      tick.gain.setValueAtTime(0.0001, at); tick.gain.exponentialRampToValueAtTime(0.25, at + 0.005); tick.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
      clod.connect(band).connect(tick)
      this.track(clod, [band, tick, ...(tickPanner ? [tickPanner] : [])], 'incidental')
      clod.start(at); clod.stop(at + 0.06)
    }
  }

  /** A power-up appearing: glittering partials that shimmer and fade. */
  private shimmer(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    for (const [i, frequency] of [1318.5, 1760, 2217.5, 2637].entries()) {
      const { gain, panner } = this.output(event)
      const tone = context.createOscillator(), tremolo = context.createOscillator(), depth = context.createGain()
      tone.type = 'sine'; tone.frequency.value = frequency
      tremolo.frequency.value = 9 + i * 2.3; depth.gain.value = 0.04
      tremolo.connect(depth).connect(gain.gain)
      const start = t + i * 0.06
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.07, start + 0.03); gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.3)
      tone.connect(gain)
      this.track(tone, [depth, gain, ...(panner ? [panner] : [])]); this.track(tremolo, [])
      for (const source of [tone, tremolo]) { source.start(start); source.stop(start + 1.35) }
    }
  }

  private arpeggio(event: SoundEvent, notes: number[], step: number, type: OscillatorType, level: number, decay = 0.45) {
    const context = this.context!, t = context.currentTime
    notes.forEach((frequency, i) => {
      const { gain, panner } = this.output({ kind: event.kind })
      const tone = context.createOscillator()
      tone.type = type; tone.frequency.value = frequency
      const start = t + i * step
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(level, start + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, start + decay)
      tone.connect(gain)
      this.track(tone, [gain, ...(panner ? [panner] : [])])
      tone.start(start); tone.stop(start + decay + 0.02)
    })
  }

  /** A low, inharmonic bell with a long tail: the round begins. */
  private bell(event: SoundEvent, fundamentals: number[], decay: number, level: number) {
    const context = this.context!, t = context.currentTime
    for (const fundamental of fundamentals) for (const [ratio, weight] of [[1, 1], [2.76, 0.5], [5.4, 0.25]] as const) {
      const { gain } = this.output({ kind: event.kind })
      const tone = context.createOscillator()
      tone.type = 'sine'; tone.frequency.value = fundamental * ratio
      const peak = level * weight / fundamentals.length
      gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(peak, t + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, t + decay / ratio ** 0.4)
      tone.connect(gain)
      this.track(tone, [gain])
      tone.start(t); tone.stop(t + decay + 0.05)
    }
    this.duckMusic()
  }

  /** The Nuke: a crack, a falling boom, a long rumble. */
  private boom(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain } = this.output({ kind: event.kind })
    const low = context.createOscillator()
    low.type = 'sine'
    low.frequency.setValueAtTime(95, t); low.frequency.exponentialRampToValueAtTime(26, t + 1.4)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(1, t + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
    low.connect(gain)
    this.track(low, [gain]); low.start(t); low.stop(t + 1.65)
    const { gain: roar } = this.output({ kind: event.kind })
    const rumble = context.createBufferSource(), filter = context.createBiquadFilter()
    rumble.buffer = this.noise; rumble.playbackRate.value = 0.6
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(2400, t); filter.frequency.exponentialRampToValueAtTime(180, t + 2.6)
    roar.gain.setValueAtTime(0.0001, t); roar.gain.exponentialRampToValueAtTime(0.9, t + 0.01); roar.gain.exponentialRampToValueAtTime(0.0001, t + 2.8)
    rumble.connect(filter).connect(roar)
    this.track(rumble, [filter, roar]); rumble.start(t); rumble.stop(t + 2.85)
    this.duckMusic()
  }
}
