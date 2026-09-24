import type { SoundEvent } from '../types'

type Priority = 'incidental' | 'whiz'
/** Frequencies over time: one value, or [seconds from the start, hertz] points joined by exponential slides. */
export type Sweep = number | readonly (readonly [number, number])[]
/** A vowel's two formants, in hertz. */
export type Vowel = readonly [number, number]
export const VOWEL = { uh: [640, 1190], aa: [760, 1150], oo: [380, 900], ae: [820, 1550] } as const

/**
 * What a creature's sounds need from the audio engine. DeadInkAudio hands over its own: the context, its
 * noise, a placed output for an event, the release of a source's nodes when it ends (which also keeps the
 * voice count), and the music's duck.
 */
export interface SoundKit {
  context: AudioContext
  noise: AudioBuffer | null
  output(event: SoundEvent): { gain: GainNode; panner: PannerNode | null }
  track(source: AudioScheduledSourceNode, nodes: AudioNode[], priority?: Priority): void
  duck?(): void
}

/**
 * One sound in the world. Its layers all run into a single placed output (one panner, not one per layer),
 * released with whichever layer ends last. `reach` is how far it carries at full strength, for the big
 * ones heard across the compound; `priority` 'incidental' lets gunfire take its voices.
 */
export class Bus {
  readonly context: AudioContext
  readonly noise: AudioBuffer | null
  readonly input: GainNode
  /** When it starts. */
  readonly t: number
  private readonly priority?: Priority
  private readonly out: { gain: GainNode; panner: PannerNode | null }
  private readonly layers: { source: AudioScheduledSourceNode; nodes: AudioNode[]; end: number }[] = []

  constructor(private readonly kit: SoundKit, event: SoundEvent, options: { reach?: number; priority?: Priority; level?: number } = {}) {
    this.context = kit.context
    this.noise = kit.noise
    this.t = kit.context.currentTime
    this.out = kit.output(event)
    this.input = this.out.gain
    this.input.gain.value = options.level ?? 1
    if (options.reach && this.out.panner) { this.out.panner.refDistance = options.reach; this.out.panner.rolloffFactor = 1 }
    this.priority = options.priority
  }

  /** A started source and the nodes it feeds, which go when it stops at `end`. */
  keep(source: AudioScheduledSourceNode, nodes: AudioNode[], end: number) {
    this.layers.push({ source, nodes, end })
  }

  /** Hands every layer to the engine; the output goes with the one that ends last. */
  done() {
    const output = [this.out.gain, ...(this.out.panner ? [this.out.panner] : [])]
    if (!this.layers.length) { output.forEach(node => node.disconnect()); return }
    let last = this.layers[0]
    for (const layer of this.layers) if (layer.end > last.end) last = layer
    for (const layer of this.layers) this.kit.track(layer.source, layer === last ? [...layer.nodes, ...output] : layer.nodes, this.priority)
  }
}

const curves = new Map<number, Float32Array<ArrayBuffer>>()
/** Soft clipping: grit and rattle, harder with more drive. */
function shaper(context: AudioContext, drive: number) {
  let curve = curves.get(drive)
  if (!curve) {
    curve = new Float32Array(new ArrayBuffer(1024 * 4))
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / (curve.length - 1) * 2 - 1) * drive)
    curves.set(drive, curve)
  }
  const node = context.createWaveShaper()
  node.curve = curve
  return node
}

/** Silence, up to `peak` over `attack`, held for `hold`, and away to silence by `end`, all exponential. */
function envelope(param: AudioParam, start: number, end: number, peak: number, attack: number, hold = 0) {
  attack = Math.min(attack, (end - start) * 0.9)
  param.setValueAtTime(0.0001, start)
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack)
  if (hold > 0) param.setValueAtTime(peak, Math.min(end - 0.001, start + attack + hold))
  param.exponentialRampToValueAtTime(0.0001, end)
}

function sweep(param: AudioParam, start: number, points: Sweep) {
  if (typeof points === 'number') { param.setValueAtTime(points, start); return }
  points.forEach(([at, value], i) => i ? param.exponentialRampToValueAtTime(value, start + at) : param.setValueAtTime(value, start + at))
}

/** A fast wobble in loudness, `depth` 0..1: rattles, gurgles, a throat full of ink. */
function tremolo(bus: Bus, input: AudioNode, start: number, end: number, wobble: { rate: number; depth: number }, nodes: AudioNode[]) {
  const context = bus.context, gate = context.createGain(), lfo = context.createOscillator(), depth = context.createGain()
  gate.gain.value = 1 - wobble.depth / 2
  lfo.frequency.value = wobble.rate; depth.gain.value = wobble.depth / 2
  lfo.connect(depth).connect(gate.gain)
  input.connect(gate); nodes.push(gate)
  lfo.start(start); lfo.stop(end + 0.02)
  bus.keep(lfo, [depth], end + 0.02)
  return gate
}

/** Noise through a filter whose frequency follows `sweep`: air, breath, splashes, grinding stone. */
export function hiss(bus: Bus, o: { at?: number; length: number; filter: BiquadFilterType; sweep: Sweep; q?: number; peak: number; attack?: number; hold?: number; rate?: number; drive?: number; tremolo?: { rate: number; depth: number } }) {
  const noise = bus.noise
  if (!noise) return
  const context = bus.context, start = bus.t + (o.at ?? 0), end = start + o.length
  const source = context.createBufferSource(), filter = context.createBiquadFilter(), level = context.createGain()
  source.buffer = noise; source.loop = true; source.playbackRate.value = o.rate ?? 1
  filter.type = o.filter; filter.Q.value = o.q ?? 0.7
  sweep(filter.frequency, start, o.sweep)
  envelope(level.gain, start, end, o.peak, o.attack ?? 0.01, o.hold)
  const nodes: AudioNode[] = [filter, level]
  let tail: AudioNode = source.connect(filter)
  if (o.drive) { const drive = shaper(context, o.drive); tail = tail.connect(drive); nodes.push(drive) }
  if (o.tremolo) tail = tremolo(bus, tail, start, end, o.tremolo, nodes)
  tail.connect(level).connect(bus.input)
  source.start(start, Math.random() * Math.max(0, noise.duration - 0.05)); source.stop(end + 0.02)
  bus.keep(source, nodes, end + 0.02)
}

/** An oscillator sliding along `sweep`: squeals, thumps, whistles, shrieks (with drive, a filter and vibrato). */
export function tone(bus: Bus, o: { at?: number; length: number; type?: OscillatorType; sweep: Sweep; peak: number; attack?: number; hold?: number; filter?: { type: BiquadFilterType; frequency: number; q?: number }; drive?: number; vibrato?: { rate: number; depth: number } }) {
  const context = bus.context, start = bus.t + (o.at ?? 0), end = start + o.length
  const osc = context.createOscillator(), level = context.createGain()
  osc.type = o.type ?? 'sine'
  sweep(osc.frequency, start, o.sweep)
  envelope(level.gain, start, end, o.peak, o.attack ?? 0.01, o.hold)
  const nodes: AudioNode[] = [level]
  let tail: AudioNode = osc
  if (o.drive) { const drive = shaper(context, o.drive); tail = tail.connect(drive); nodes.push(drive) }
  if (o.filter) {
    const filter = context.createBiquadFilter()
    filter.type = o.filter.type; filter.frequency.value = o.filter.frequency; filter.Q.value = o.filter.q ?? 0.7
    tail = tail.connect(filter); nodes.push(filter)
  }
  tail.connect(level).connect(bus.input)
  if (o.vibrato) {
    const lfo = context.createOscillator(), depth = context.createGain()
    lfo.frequency.value = o.vibrato.rate; depth.gain.value = o.vibrato.depth
    lfo.connect(depth).connect(osc.frequency)
    lfo.start(start); lfo.stop(end + 0.02)
    bus.keep(lfo, [depth], end + 0.02)
  }
  osc.start(start); osc.stop(end + 0.02)
  bus.keep(osc, nodes, end + 0.02)
}

/** Short clicks of noise scattered over `spread` from one source: drops of ink, stones, fluttering scraps. */
export function ticks(bus: Bus, o: { at: number; count: number; spread: number; band: readonly [number, number]; q?: number; peak: number; decay: number; rate?: number }) {
  const noise = bus.noise
  if (!noise || o.count <= 0) return
  const context = bus.context, begin = bus.t + o.at
  const source = context.createBufferSource(), filter = context.createBiquadFilter(), level = context.createGain()
  source.buffer = noise; source.loop = true; source.playbackRate.value = o.rate ?? 2
  filter.type = 'bandpass'; filter.Q.value = o.q ?? 3
  level.gain.setValueAtTime(0.0001, begin)
  // Never overlapping, so each click keeps its own envelope.
  const times = Array.from({ length: o.count }, () => begin + Math.random() * o.spread).sort((a, b) => a - b)
  let free = begin
  for (const time of times) {
    const at = Math.max(time, free)
    filter.frequency.setValueAtTime(o.band[0] + Math.random() * (o.band[1] - o.band[0]), at)
    level.gain.setValueAtTime(0.0001, at)
    level.gain.exponentialRampToValueAtTime(o.peak * (0.55 + Math.random() * 0.45), at + 0.004)
    level.gain.exponentialRampToValueAtTime(0.0001, at + o.decay)
    free = at + o.decay + 0.003
  }
  source.connect(filter).connect(level).connect(bus.input)
  source.start(begin, Math.random() * Math.max(0, noise.duration - 0.05)); source.stop(free + 0.02)
  bus.keep(source, [filter, level], free + 0.02)
}

/** Bright pings from one oscillator, one per [seconds, hertz] note: rivets popping. */
export function pings(bus: Bus, o: { at?: number; notes: readonly (readonly [number, number])[]; decay: number; peak: number }) {
  const context = bus.context, begin = bus.t + (o.at ?? 0)
  const osc = context.createOscillator(), level = context.createGain()
  osc.type = 'sine'
  level.gain.setValueAtTime(0.0001, begin)
  let free = begin
  for (const [offset, frequency] of o.notes) {
    const at = Math.max(begin + offset, free)
    osc.frequency.setValueAtTime(frequency, at)
    level.gain.setValueAtTime(0.0001, at)
    level.gain.exponentialRampToValueAtTime(o.peak, at + 0.002)
    level.gain.exponentialRampToValueAtTime(0.0001, at + o.decay)
    free = at + o.decay + 0.002
  }
  osc.connect(level).connect(bus.input)
  osc.start(begin); osc.stop(free + 0.02)
  bus.keep(osc, [level], free + 0.02)
}

/**
 * Ink bubbling: short blips from one oscillator, each leaping up in pitch as it bursts. With `accelerate`
 * they crowd in toward the end and climb, a boil building to something breaking the surface.
 */
export function bubbles(bus: Bus, o: { at: number; length: number; count: number; pitch: readonly [number, number]; peak: number; accelerate?: boolean }) {
  const context = bus.context, begin = bus.t + o.at
  const osc = context.createOscillator(), level = context.createGain()
  osc.type = 'sine'
  level.gain.setValueAtTime(0.0001, begin)
  let free = begin
  for (let i = 0; i < o.count; i++) {
    const even = (i + Math.random()) / o.count, u = o.accelerate ? Math.sqrt(even) : even
    const at = Math.max(begin + u * o.length, free), length = 0.03 + Math.random() * 0.04
    const pitch = o.pitch[0] + Math.random() * (o.pitch[1] - o.pitch[0]) * (o.accelerate ? 0.5 + u * 0.5 : 1)
    osc.frequency.setValueAtTime(pitch, at)
    osc.frequency.exponentialRampToValueAtTime(pitch * 1.9, at + length)
    level.gain.setValueAtTime(0.0001, at)
    level.gain.exponentialRampToValueAtTime(o.peak * (0.5 + Math.random() * 0.5), at + 0.004)
    level.gain.exponentialRampToValueAtTime(0.0001, at + length)
    free = at + length + 0.004
  }
  osc.connect(level).connect(bus.input)
  osc.start(begin); osc.stop(free + 0.02)
  bus.keep(osc, [level], free + 0.02)
}

/** Struck iron: inharmonic partials, the higher ones quieter and quicker to die. */
export function partials(bus: Bus, o: { at?: number; base: number; ratios: readonly number[]; decay: number; peak: number }) {
  const context = bus.context, start = bus.t + (o.at ?? 0)
  o.ratios.forEach((ratio, i) => {
    const osc = context.createOscillator(), level = context.createGain()
    const end = start + o.decay / Math.sqrt(1 + i)
    osc.type = 'sine'; osc.frequency.value = o.base * ratio * (0.99 + Math.random() * 0.02)
    envelope(level.gain, start, end, o.peak / (1 + i * 0.6), 0.002)
    osc.connect(level).connect(bus.input)
    osc.start(start); osc.stop(end + 0.02)
    bus.keep(osc, [level], end + 0.02)
  })
}

/**
 * A creature's roar, the zombies' formant voice built bigger: a rasping sawtooth sliding by `glide`, breath,
 * a waveshaper's rattle, two vowel formants over a low body. Not held to the zombies' voice limit, so a
 * boss is never cut off by a crowd of groans; `tremolo` bubbles it.
 */
export function roar(bus: Bus, o: { at?: number; length: number; pitch: number; glide: number; rasp: number; drive: number; vowel: Vowel; level: number; tremolo?: { rate: number; depth: number } }) {
  const noise = bus.noise
  if (!noise) return
  const context = bus.context, start = bus.t + (o.at ?? 0), end = start + o.length
  const saw = context.createOscillator()
  saw.type = 'sawtooth'
  saw.frequency.setValueAtTime(o.pitch, start)
  saw.frequency.linearRampToValueAtTime(o.pitch * (1 + (o.glide - 1) * 0.3), start + o.length * 0.35)
  saw.frequency.exponentialRampToValueAtTime(o.pitch * o.glide, end)
  const wobble = context.createOscillator(), wobbleDepth = context.createGain()
  wobble.frequency.value = 5 + Math.random() * 4; wobbleDepth.gain.value = o.pitch * 0.05
  wobble.connect(wobbleDepth).connect(saw.frequency)
  const breath = context.createBufferSource(), breathLevel = context.createGain()
  breath.buffer = noise; breath.loop = true; breath.playbackRate.value = 1.6
  breathLevel.gain.value = o.rasp
  const mix = context.createGain()
  saw.connect(mix); breath.connect(breathLevel).connect(mix)
  const drive = shaper(context, o.drive), level = context.createGain()
  mix.connect(drive)
  const nodes: AudioNode[] = [wobbleDepth, breathLevel, mix, drive, level]
  o.vowel.forEach((frequency, i) => {
    const band = context.createBiquadFilter()
    band.type = 'bandpass'; band.frequency.value = frequency * (0.92 + Math.random() * 0.16); band.Q.value = i ? 9 : 5
    drive.connect(band).connect(level); nodes.push(band)
  })
  const body = context.createBiquadFilter()
  body.type = 'lowpass'; body.frequency.value = 420
  drive.connect(body).connect(level); nodes.push(body)
  level.gain.setValueAtTime(0.0001, start)
  level.gain.exponentialRampToValueAtTime(o.level, start + Math.min(0.12, o.length * 0.2))
  level.gain.setValueAtTime(o.level, start + o.length * 0.55)
  level.gain.exponentialRampToValueAtTime(0.0001, end)
  const tail = o.tremolo ? tremolo(bus, level, start, end, o.tremolo, nodes) : level
  tail.connect(bus.input)
  for (const source of [saw, wobble, breath]) { source.start(start); source.stop(end + 0.02) }
  bus.keep(saw, nodes, end + 0.02); bus.keep(wobble, [], end + 0.02); bus.keep(breath, [], end + 0.02)
}
