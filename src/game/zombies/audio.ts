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
  longStroke: { notes: [293.7, 370, 440, 587.3, 440, 370, 440, 587.3, 659.3, 587.3, 493.9, 440, 493.9, 587.3, 740, 587.3], step: 0.13 },
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
      'perk-drink', 'perk-jingle', 'pack-work', 'pack-ready', 'boss-roar', 'boss-growl', 'boss-slam', 'box-leave', 'box-open', 'box-spin', 'box-offer', 'ink-burst', 'grenade-blast', 'grenade-throw',
      'headshot-pop', 'gore-rip', 'gib', 'gas-burst', 'blot-gurgle', 'storm', 'doll-clap', 'heartbeat', 'shot-raygun', 'soul', 'soul-in', 'board-tear', 'board-hammer',
      'shot-rocket', 'rocket-boom', 'round-burst']
    if (event.kind === 'door' && this.context && this.active && !this.muted) this.slam(event)
    // The Magnum: the usual report with a chest punch, a hard crack and a rolling echo under it.
    if (event.kind === 'shot-magnum' && context && this.master && this.active && !this.muted && !this.disposed && !this.dying) this.magnum()
    // Upgraded guns, as in Call of Duty: the gun's own report with a bright electric zap on top.
    if (event.packed && event.kind.startsWith('shot-') && event.kind !== 'shot-raygun' && context && this.master && this.active && !this.muted && !this.disposed && !this.dying) this.zap(event)
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
      // Low health: two low thumps, lub-dub, louder the closer you are to going down.
      case 'heartbeat': this.heartbeat(event.intensity ?? 1); break
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
      // Gore: a headshot's wet pop, a limb tearing off, a body blown apart, the Blot bursting and gurgling.
      case 'headshot-pop': this.pop(event, 1); this.splatter(event, 4, 0.09); break
      case 'gore-rip': this.tear(event); this.splatter(event, 3, 0.2); break
      case 'gib': this.pop(event, 0.55); this.tear(event); this.splatter(event, 7, 0.15); break
      case 'gas-burst': this.pop(event, 0.4); this.splatter(event, 5, 0.12); this.hiss(event); break
      case 'blot-gurgle': this.gurgle(event); break
      case 'shot-raygun': this.rayGun(event); break
      // The Ink Rocket: the tube's thump and the motor's whoosh; its burst, a grenade's boom with a harder crack.
      case 'shot-rocket': this.launch(event); break
      case 'rocket-boom': this.boom(event); this.blastCrack(event, 0.9, 0.16); this.dirt(event); break
      // A Deadline round going off: a small, hard pop.
      case 'round-burst': this.blastCrack(event, 0.55, 0.1); this.thump(event, 0.5); break
      // A soul tearing loose and flying off; its arrival: a gulp in the ink and a small bright note.
      case 'soul': this.whoosh(event); this.wail(event); break
      case 'soul-in': this.pop(event, 0.7); this.arpeggio(event, [784, 1174.7], 0.06, 'triangle', 0.12, 0.6); break
      // Boarded windows: a plank ripped off its nails, and one hammered back.
      case 'board-tear': this.crack(event); break
      case 'board-hammer': this.hammer(event); break
    }
  }

  /** A soul leaving a body: a thin ghostly tone sliding up, with a slow wobble. */
  private wail(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const tone = context.createOscillator(), wobble = context.createOscillator(), depth = context.createGain()
    tone.type = 'sine'
    tone.frequency.setValueAtTime(320, t); tone.frequency.exponentialRampToValueAtTime(980, t + 0.55)
    wobble.frequency.value = 7; depth.gain.value = 18
    wobble.connect(depth).connect(tone.frequency)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.16, t + 0.08); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
    tone.connect(gain)
    this.track(tone, [depth, gain, ...(panner ? [panner] : [])]); this.track(wobble, [])
    for (const source of [tone, wobble]) { source.start(t); source.stop(t + 0.72) }
  }

  /**
   * The Ray Gun's report: a resonant sweep falling from a whistle to a growl with a fast wobble in it,
   * over a short punch. The X2 is a little higher and doubled, as Porter's X2 sounds heavier.
   */
  private rayGun(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const packed = !!event.packed, top = packed ? 2100 : 1700
    for (const detune of packed ? [1, 1.012, 0.5] : [1, 1.009]) {
      const { gain, panner } = this.output(event)
      const tone = context.createOscillator(), wobble = context.createOscillator(), depth = context.createGain(), filter = context.createBiquadFilter()
      tone.type = detune === 0.5 ? 'square' : 'sawtooth'
      tone.frequency.setValueAtTime(top * detune, t); tone.frequency.exponentialRampToValueAtTime(190 * detune, t + 0.24)
      wobble.frequency.value = 36; depth.gain.value = 55 * detune
      wobble.connect(depth).connect(tone.frequency)
      filter.type = 'bandpass'; filter.Q.value = 5
      filter.frequency.setValueAtTime(4200, t); filter.frequency.exponentialRampToValueAtTime(650, t + 0.26)
      const level = detune === 0.5 ? 0.18 : 0.34
      gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(level, t + 0.005); gain.gain.exponentialRampToValueAtTime(0.0001, t + (packed ? 0.34 : 0.28))
      tone.connect(filter).connect(gain)
      this.track(tone, [depth, filter, gain, ...(panner ? [panner] : [])]); this.track(wobble, [])
      for (const source of [tone, wobble]) { source.start(t); source.stop(t + 0.36) }
    }
    const { gain: body, panner: bodyPanner } = this.output(event)
    const punch = context.createOscillator()
    punch.type = 'sine'; punch.frequency.setValueAtTime(150, t); punch.frequency.exponentialRampToValueAtTime(55, t + 0.11)
    body.gain.setValueAtTime(0.0001, t); body.gain.exponentialRampToValueAtTime(0.5, t + 0.004); body.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)
    punch.connect(body)
    this.track(punch, [body, ...(bodyPanner ? [bodyPanner] : [])]); punch.start(t); punch.stop(t + 0.15)
  }

  /**
   * The Ink Rocket leaving the tube: a hollow thump, then the motor, a roar of noise whose band climbs as
   * the rocket gets up to speed and fades as it flies off, with a hiss under it.
   */
  private launch(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    this.thump(event, 0.9)
    const { gain, panner } = this.output(event)
    const roar = context.createBufferSource(), band = context.createBiquadFilter()
    roar.buffer = this.noise; roar.playbackRate.value = 1.4
    band.type = 'bandpass'; band.Q.value = 1.1
    band.frequency.setValueAtTime(380, t); band.frequency.exponentialRampToValueAtTime(2600, t + 0.3); band.frequency.exponentialRampToValueAtTime(900, t + 1.1)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.75, t + 0.04); gain.gain.exponentialRampToValueAtTime(0.25, t + 0.45); gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2)
    roar.connect(band).connect(gain)
    this.track(roar, [band, gain, ...(panner ? [panner] : [])]); roar.start(t); roar.stop(t + 1.25)
    const { gain: air, panner: airPanner } = this.output(event)
    const hiss = context.createBufferSource(), high = context.createBiquadFilter()
    hiss.buffer = this.noise; hiss.playbackRate.value = 2.4
    high.type = 'highpass'; high.frequency.value = 3200
    air.gain.setValueAtTime(0.0001, t); air.gain.exponentialRampToValueAtTime(0.22, t + 0.02); air.gain.exponentialRampToValueAtTime(0.0001, t + 0.8)
    hiss.connect(high).connect(air)
    this.track(hiss, [high, air, ...(airPanner ? [airPanner] : [])], 'incidental'); hiss.start(t); hiss.stop(t + 0.82)
    this.duckMusic()
  }

  /** A blast's hard crack: a very short burst of bright noise, `length` seconds. */
  private blastCrack(event: SoundEvent, level: number, length: number) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const snap = context.createBufferSource(), high = context.createBiquadFilter()
    snap.buffer = this.noise; snap.playbackRate.value = 1.6
    high.type = 'highpass'; high.frequency.value = 1400
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(level, t + 0.003); gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
    snap.connect(high).connect(gain)
    this.track(snap, [high, gain, ...(panner ? [panner] : [])]); snap.start(t); snap.stop(t + length + 0.02)
  }

  /** A low thump, felt more than heard: a sine dropping fast. */
  private thump(event: SoundEvent, level: number) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const low = context.createOscillator()
    low.type = 'sine'; low.frequency.setValueAtTime(110, t); low.frequency.exponentialRampToValueAtTime(38, t + 0.24)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(level, t + 0.006); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
    low.connect(gain)
    this.track(low, [gain, ...(panner ? [panner] : [])]); low.start(t); low.stop(t + 0.32)
  }

  /**
   * The Pack-a-Punch layer, as upgraded guns sound in Call of Duty: under the gun's own report, a resonant
   * synth "pew" falling from a whistle to a growl, a bright ring at its start and a short low punch. Loud
   * enough to hear over the shot, short enough for a machine gun.
   */
  private zap(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const level = Math.min(3, event.packed ?? 1)
    const { gain, panner } = this.output(event)
    const pew = context.createOscillator(), filter = context.createBiquadFilter()
    pew.type = 'sawtooth'
    pew.frequency.setValueAtTime(1400 + level * 150, t); pew.frequency.exponentialRampToValueAtTime(280, t + 0.17)
    filter.type = 'lowpass'; filter.Q.value = 9
    filter.frequency.setValueAtTime(5200, t); filter.frequency.exponentialRampToValueAtTime(700, t + 0.18)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.32, t + 0.004); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.21)
    pew.connect(filter).connect(gain)
    this.track(pew, [filter, gain, ...(panner ? [panner] : [])], 'incidental'); pew.start(t); pew.stop(t + 0.22)
    const { gain: ring, panner: ringPanner } = this.output(event)
    const tsing = context.createOscillator()
    tsing.type = 'sine'
    tsing.frequency.setValueAtTime(3300, t); tsing.frequency.exponentialRampToValueAtTime(1800, t + 0.07)
    ring.gain.setValueAtTime(0.0001, t); ring.gain.exponentialRampToValueAtTime(0.13, t + 0.003); ring.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
    tsing.connect(ring)
    this.track(tsing, [ring, ...(ringPanner ? [ringPanner] : [])], 'incidental'); tsing.start(t); tsing.stop(t + 0.1)
    const { gain: body, panner: bodyPanner } = this.output(event)
    const punch = context.createOscillator()
    punch.type = 'sine'
    punch.frequency.setValueAtTime(140, t); punch.frequency.exponentialRampToValueAtTime(60, t + 0.08)
    body.gain.setValueAtTime(0.0001, t); body.gain.exponentialRampToValueAtTime(0.3, t + 0.004); body.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    punch.connect(body)
    this.track(punch, [body, ...(bodyPanner ? [bodyPanner] : [])], 'incidental'); punch.start(t); punch.stop(t + 0.11)
  }


  /** A plank torn off: the nails' squeal, a sharp crack, splinters, and the plank's own hollow knock. */
  private crack(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain: squeal, panner: squealPanner } = this.output(event)
    const nail = context.createOscillator(), band = context.createBiquadFilter()
    nail.type = 'sawtooth'
    nail.frequency.setValueAtTime(1500 + Math.random() * 400, t); nail.frequency.exponentialRampToValueAtTime(900, t + 0.09)
    band.type = 'bandpass'; band.frequency.value = 1700; band.Q.value = 6
    squeal.gain.setValueAtTime(0.0001, t); squeal.gain.exponentialRampToValueAtTime(0.08, t + 0.02); squeal.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    nail.connect(band).connect(squeal)
    this.track(nail, [band, squeal, ...(squealPanner ? [squealPanner] : [])], 'incidental'); nail.start(t); nail.stop(t + 0.11)
    const at = t + 0.07
    const { gain, panner } = this.output(event)
    const snap = context.createBufferSource(), high = context.createBiquadFilter()
    snap.buffer = this.noise; snap.playbackRate.value = 1.4
    high.type = 'highpass'; high.frequency.value = 1400
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.8, at + 0.002); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07)
    snap.connect(high).connect(gain)
    this.track(snap, [high, gain, ...(panner ? [panner] : [])]); snap.start(at); snap.stop(at + 0.08)
    for (let i = 0; i < 6; i++) {
      const tick = at + 0.01 + Math.random() * 0.14
      const { gain: splinter, panner: splinterPanner } = this.output(event)
      const chip = context.createBufferSource(), chipBand = context.createBiquadFilter()
      chip.buffer = this.noise; chip.playbackRate.value = 2.4
      chipBand.type = 'bandpass'; chipBand.frequency.value = 2200 + Math.random() * 2600; chipBand.Q.value = 5
      splinter.gain.setValueAtTime(0.0001, tick); splinter.gain.exponentialRampToValueAtTime(0.22, tick + 0.002); splinter.gain.exponentialRampToValueAtTime(0.0001, tick + 0.025)
      chip.connect(chipBand).connect(splinter)
      this.track(chip, [chipBand, splinter, ...(splinterPanner ? [splinterPanner] : [])], 'incidental'); chip.start(tick); chip.stop(tick + 0.03)
    }
    const { gain: body, panner: bodyPanner } = this.output(event)
    const knock = context.createOscillator()
    knock.type = 'triangle'; knock.frequency.setValueAtTime(240, at); knock.frequency.exponentialRampToValueAtTime(110, at + 0.12)
    body.gain.setValueAtTime(0.0001, at); body.gain.exponentialRampToValueAtTime(0.45, at + 0.006); body.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
    knock.connect(body)
    this.track(knock, [body, ...(bodyPanner ? [bodyPanner] : [])]); knock.start(at); knock.stop(at + 0.17)
  }

  /** A plank hammered back: two blows, each a click of the head and the thud of wood taking the nail. */
  private hammer(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    for (const [delay, level] of [[0.12, 0.7], [0.27, 0.85]] as const) {
      const at = t + delay
      const { gain: click, panner: clickPanner } = this.output(event)
      const head = context.createBufferSource(), high = context.createBiquadFilter()
      head.buffer = this.noise; head.playbackRate.value = 2
      high.type = 'highpass'; high.frequency.value = 2500
      click.gain.setValueAtTime(0.0001, at); click.gain.exponentialRampToValueAtTime(0.45 * level, at + 0.001); click.gain.exponentialRampToValueAtTime(0.0001, at + 0.03)
      head.connect(high).connect(click)
      this.track(head, [high, click, ...(clickPanner ? [clickPanner] : [])], 'incidental'); head.start(at); head.stop(at + 0.035)
      const { gain: thud, panner: thudPanner } = this.output(event)
      const wood = context.createOscillator(), ring = context.createBiquadFilter()
      wood.type = 'triangle'; wood.frequency.setValueAtTime(310, at); wood.frequency.exponentialRampToValueAtTime(140, at + 0.09)
      ring.type = 'bandpass'; ring.frequency.value = 480; ring.Q.value = 3
      thud.gain.setValueAtTime(0.0001, at); thud.gain.exponentialRampToValueAtTime(0.7 * level, at + 0.004); thud.gain.exponentialRampToValueAtTime(0.0001, at + 0.13)
      wood.connect(ring).connect(thud)
      this.track(wood, [ring, thud, ...(thudPanner ? [thudPanner] : [])]); wood.start(at); wood.stop(at + 0.14)
    }
  }

  /**
   * A wet pop: a cork-like thump that drops in pitch, a slap of bright noise, a low body. `pitch` 1 is a
   * head; lower is bigger and wetter.
   */
  private pop(event: SoundEvent, pitch: number) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const cork = context.createOscillator()
    cork.type = 'sine'
    cork.frequency.setValueAtTime(820 * pitch, t); cork.frequency.exponentialRampToValueAtTime(120 * pitch, t + 0.07)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.75, t + 0.004); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    cork.connect(gain)
    this.track(cork, [gain, ...(panner ? [panner] : [])]); cork.start(t); cork.stop(t + 0.13)
    const { gain: slap, panner: slapPanner } = this.output(event)
    const wet = context.createBufferSource(), band = context.createBiquadFilter()
    wet.buffer = this.noise; wet.playbackRate.value = 1.2
    band.type = 'bandpass'; band.Q.value = 1.6
    band.frequency.setValueAtTime(2600 * pitch, t); band.frequency.exponentialRampToValueAtTime(700 * pitch, t + 0.14)
    slap.gain.setValueAtTime(0.0001, t); slap.gain.exponentialRampToValueAtTime(0.9, t + 0.003); slap.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    wet.connect(band).connect(slap)
    this.track(wet, [band, slap, ...(slapPanner ? [slapPanner] : [])]); wet.start(t); wet.stop(t + 0.2)
    const { gain: body, panner: bodyPanner } = this.output(event)
    const low = context.createOscillator()
    low.type = 'sine'; low.frequency.setValueAtTime(110 * Math.sqrt(pitch), t); low.frequency.exponentialRampToValueAtTime(45, t + 0.16)
    body.gain.setValueAtTime(0.0001, t); body.gain.exponentialRampToValueAtTime(0.6, t + 0.006); body.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
    low.connect(body)
    this.track(low, [body, ...(bodyPanner ? [bodyPanner] : [])]); low.start(t); low.stop(t + 0.22)
  }

  /** Ink landing: short wet ticks scattered over the next moment. */
  private splatter(event: SoundEvent, count: number, delay: number) {
    const context = this.context!, t = context.currentTime
    for (let i = 0; i < count; i++) {
      const at = t + delay + Math.random() * 0.45
      const { gain, panner } = this.output(event)
      const drop = context.createBufferSource(), band = context.createBiquadFilter()
      drop.buffer = this.noise; drop.playbackRate.value = 1.8
      band.type = 'bandpass'; band.frequency.value = 900 + Math.random() * 1500; band.Q.value = 4
      gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.28, at + 0.004); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06)
      drop.connect(band).connect(gain)
      this.track(drop, [band, gain, ...(panner ? [panner] : [])], 'incidental'); drop.start(at); drop.stop(at + 0.07)
    }
  }

  /** Something torn: a ripping band of noise sweeping up, over a thud. */
  private tear(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const rip = context.createBufferSource(), band = context.createBiquadFilter(), shaper = this.waveshaper(4)
    rip.buffer = this.noise; rip.playbackRate.value = 0.9
    band.type = 'bandpass'; band.Q.value = 2.2
    band.frequency.setValueAtTime(380, t); band.frequency.exponentialRampToValueAtTime(1900, t + 0.16)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.55, t + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24)
    rip.connect(band).connect(shaper).connect(gain)
    this.track(rip, [band, shaper, gain, ...(panner ? [panner] : [])]); rip.start(t); rip.stop(t + 0.26)
    const { gain: thud, panner: thudPanner } = this.output(event)
    const low = context.createOscillator()
    low.type = 'sine'; low.frequency.setValueAtTime(90, t); low.frequency.exponentialRampToValueAtTime(40, t + 0.2)
    thud.gain.setValueAtTime(0.0001, t); thud.gain.exponentialRampToValueAtTime(0.6, t + 0.01); thud.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
    low.connect(thud)
    this.track(low, [thud, ...(thudPanner ? [thudPanner] : [])]); low.start(t); low.stop(t + 0.27)
  }

  /** Gas escaping: a long hiss that settles, low and breathy. */
  private hiss(event: SoundEvent) {
    const context = this.context!, t = context.currentTime
    const { gain, panner } = this.output(event)
    const air = context.createBufferSource(), band = context.createBiquadFilter()
    air.buffer = this.noise; air.loop = true; air.playbackRate.value = 1.3
    band.type = 'bandpass'; band.Q.value = 0.8
    band.frequency.setValueAtTime(3800, t + 0.05); band.frequency.exponentialRampToValueAtTime(900, t + 1.8)
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.32, t + 0.08); gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.2)
    air.connect(band).connect(gain)
    this.track(air, [band, gain, ...(panner ? [panner] : [])]); air.start(t); air.stop(t + 2.25)
  }

  /** The Blot's voice: a throat full of ink, bubbling. */
  private gurgle(event: SoundEvent) {
    const context = this.context!, t = context.currentTime, length = 1 + Math.random() * 0.6
    const { gain, panner } = this.output(event)
    const throat = context.createOscillator(), bubbles = context.createOscillator(), depth = context.createGain(), bubbling = context.createGain(), low = context.createBiquadFilter()
    throat.type = 'sawtooth'
    throat.frequency.setValueAtTime(70 + Math.random() * 25, t); throat.frequency.exponentialRampToValueAtTime(48, t + length)
    // Bubbles: the throat chopped on and off a dozen times a second.
    bubbles.type = 'square'; bubbles.frequency.value = 9 + Math.random() * 6
    bubbling.gain.value = 0.55; depth.gain.value = 0.45
    bubbles.connect(depth).connect(bubbling.gain)
    low.type = 'lowpass'; low.frequency.value = 520; low.Q.value = 6
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.4, t + 0.1); gain.gain.setValueAtTime(0.4, t + length * 0.6); gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
    throat.connect(low).connect(bubbling).connect(gain)
    this.track(throat, [low, bubbling, gain, ...(panner ? [panner] : [])]); this.track(bubbles, [depth])
    for (const source of [throat, bubbles]) { source.start(t); source.stop(t + length + 0.02) }
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
  private magnum() {
    const context = this.context!, t = context.currentTime
    // Punch: a fast drop from a low tone, felt more than heard.
    const { gain: punchGain } = this.output({ kind: 'shot-magnum' })
    const punch = context.createOscillator()
    punch.type = 'sine'
    punch.frequency.setValueAtTime(120, t); punch.frequency.exponentialRampToValueAtTime(42, t + 0.22)
    punchGain.gain.setValueAtTime(0.0001, t); punchGain.gain.exponentialRampToValueAtTime(0.75, t + 0.006); punchGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
    punch.connect(punchGain)
    this.track(punch, [punchGain]); punch.start(t); punch.stop(t + 0.32)
    // Crack: a very short burst of bright noise.
    const { gain: crackGain } = this.output({ kind: 'shot-magnum' })
    const crack = context.createBufferSource(), high = context.createBiquadFilter()
    crack.buffer = this.noise; crack.playbackRate.value = 1.3
    high.type = 'highpass'; high.frequency.value = 1800
    crackGain.gain.setValueAtTime(0.0001, t); crackGain.gain.exponentialRampToValueAtTime(0.6, t + 0.002); crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
    crack.connect(high).connect(crackGain)
    this.track(crack, [high, crackGain]); crack.start(t); crack.stop(t + 0.08)
    // Echo: the shot rolling off the buildings, twice, darker each time.
    for (const [delay, level, cutoff] of [[0.02, 0.28, 1100], [0.24, 0.14, 700]] as const) {
      const { gain } = this.output({ kind: 'shot-magnum' })
      const tail = context.createBufferSource(), low = context.createBiquadFilter()
      tail.buffer = this.noise; tail.playbackRate.value = 0.55
      low.type = 'lowpass'; low.frequency.setValueAtTime(cutoff, t + delay); low.frequency.exponentialRampToValueAtTime(160, t + delay + 0.9)
      gain.gain.setValueAtTime(0.0001, t + delay); gain.gain.exponentialRampToValueAtTime(level, t + delay + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.95)
      tail.connect(low).connect(gain)
      this.track(tail, [low, gain], 'incidental'); tail.start(t + delay); tail.stop(t + delay + 1)
    }
  }

  private heartbeat(strength: number) {
    const context = this.context!, t = context.currentTime
    for (const [delay, level] of [[0, 1], [0.14, 0.6]] as const) {
      const { gain } = this.output({ kind: 'heartbeat' })
      const thump = context.createOscillator(), low = context.createBiquadFilter()
      thump.type = 'sine'
      thump.frequency.setValueAtTime(55, t + delay); thump.frequency.exponentialRampToValueAtTime(40, t + delay + 0.09)
      low.type = 'lowpass'; low.frequency.value = 200
      const peak = Math.max(0.0002, 0.55 * level * Math.min(1, strength))
      gain.gain.setValueAtTime(0.0001, t + delay); gain.gain.exponentialRampToValueAtTime(peak, t + delay + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.11)
      thump.connect(low).connect(gain)
      this.track(thump, [low, gain]); thump.start(t + delay); thump.stop(t + delay + 0.12)
    }
  }

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
