import assert from 'node:assert/strict'
import * as THREE from 'three'
import { DeadInkAudio } from '../src/game/zombies/audio'
import { BRUTE_KINDS, CLANG_GAP } from '../src/game/zombies/brute-sounds'
import { FLAP_BUDGET, INKWING_KINDS } from '../src/game/zombies/inkwing-sounds'

class Param {
  value = 0
  events: { kind: string; value: number; time: number }[] = []
  setValueAtTime(value: number, time: number) { this.value = value; this.events.push({ kind: 'set', value, time }) }
  exponentialRampToValueAtTime(value: number, time: number) { this.value = value; this.events.push({ kind: 'exponential', value, time }) }
  linearRampToValueAtTime(value: number, time: number) { this.value = value; this.events.push({ kind: 'linear', value, time }) }
  cancelScheduledValues() {}
}
class Node {
  disconnected = false
  connections: Node[] = []
  connect(target: Node) { this.connections.push(target); return target }
  disconnect() { this.disconnected = true }
}
class Gain extends Node { gain = new Param() }
class Filter extends Node { frequency = new Param(); Q = new Param(); type = '' }
class Panner extends Node {
  positionX = new Param(); positionY = new Param(); positionZ = new Param()
  panningModel = ''; distanceModel = ''; refDistance = 0; maxDistance = 0; rolloffFactor = 0
}
class Shaper extends Node { curve: Float32Array | null = null }
class Source extends Node {
  buffer: unknown
  loop = false
  playbackRate = new Param()
  frequency = new Param()
  type = 'sine'
  onended: (() => void) | null = null
  stopped = false
  startTime = 0
  stopTime = 0
  start(time = 0) { this.startTime = time }
  stop(time?: number) { this.stopTime = time ?? 0; if (time === undefined) { this.stopped = true; this.onended?.() } }
}
class FakeAudioContext {
  static latest: FakeAudioContext
  currentTime = 0
  sampleRate = 1000
  state = 'suspended'
  destination = new Node()
  nodes: Node[] = []
  listener = Object.fromEntries(['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map(name => [name, new Param()]))
  constructor() { FakeAudioContext.latest = this }
  keep<T extends Node>(node: T) { this.nodes.push(node); return node }
  createGain() { return this.keep(new Gain()) }
  createBiquadFilter() { return this.keep(new Filter()) }
  createPanner() { return this.keep(new Panner()) }
  createBufferSource() { return this.keep(new Source()) }
  createOscillator() { return this.keep(new Source()) }
  createWaveShaper() { return this.keep(new Shaper()) }
  createBuffer(_channels: number, length: number, rate: number) { const data = new Float32Array(length); return { duration: length / rate, getChannelData: () => data } }
  async decodeAudioData(data: ArrayBuffer) { return Object.assign(this.createBuffer(1, 1200, 1000), { url: new TextDecoder().decode(data) }) }
  async resume() { this.state = 'running' }
  async suspend() { this.state = 'suspended' }
  async close() { this.state = 'closed' }
}
Object.assign(globalThis, { AudioContext: FakeAudioContext, fetch: async () => ({ ok: false }) })

// The Inkwings' and the Brute's synths (inkwing-sounds.ts, brute-sounds.ts) through Dead Ink's engine.
const audio = new DeadInkAudio()
audio.setActive(true); await audio.unlock()
audio.update(new THREE.PerspectiveCamera())
const context = FakeAudioContext.latest
const near = () => new THREE.Vector3(3, 0, 0)
const fresh = (from: number) => context.nodes.slice(from)
const sources = (nodes: Node[]) => nodes.filter(node => node instanceof Source) as Source[]
const endAll = (nodes: Node[]) => sources(nodes).forEach(source => source.onended?.())

for (const kind of [...INKWING_KINDS, ...BRUTE_KINDS]) {
  context.currentTime += 1
  const mark = context.nodes.length, before = audio.diagnostics.sources
  audio.play({ kind, position: near(), radius: 60 })
  const made = fresh(mark), started = sources(made)
  assert(audio.diagnostics.sources > before, `${kind} plays`)
  assert.equal(made.filter(node => node instanceof Panner).length, 1, `${kind}: one placed output for all its layers`)
  for (const source of started) {
    assert(source.stopTime > source.startTime && source.stopTime - context.currentTime < 3, `${kind}: every layer stops within 3 s`)
  }
  const peaks = made.filter(node => node instanceof Gain).flatMap(node => (node as Gain).gain.events.map(event => event.value))
  assert(peaks.every(value => value > 0 && value <= 1), `${kind}: every level is positive and at most full scale`)
  endAll(made)
  assert.equal(audio.diagnostics.sources, before, `${kind}: every layer is released when it ends`)
  assert(made.every(node => node.disconnected), `${kind}: every node is disconnected when it ends`)
}
console.log(`PASS all ${INKWING_KINDS.length + BRUTE_KINDS.length} creature sounds play through one output each, stay under full scale and clean up`)

const lastStop = (kind: string, duration: number) => {
  context.currentTime += 1
  const mark = context.nodes.length
  audio.play({ kind, position: near(), duration })
  const made = fresh(mark), end = Math.max(...sources(made).map(source => source.stopTime)) - context.currentTime
  endAll(made)
  return end
}
assert(lastStop('brute-snort', 1.4) > lastStop('brute-snort', 0.72) + 0.2, 'the charge wind-up follows its length')
assert(Math.abs(lastStop('inkwing-snap', 0.6) - lastStop('inkwing-snap', 0.3) - 0.3) < 0.05, 'the snap lands at the end of its wind-up')
console.log('PASS the charge wind-up and the snap follow the move\'s timing')

context.currentTime += 1
let mark = context.nodes.length, before = audio.diagnostics.sources
for (let i = 0; i < 10; i++) audio.play({ kind: 'brute-clang', position: near() })
const oneClang = audio.diagnostics.sources - before
assert(oneClang > 0 && oneClang <= 5, 'ten bullets on the mask at once ring one clang')
context.currentTime += CLANG_GAP + 0.01
audio.play({ kind: 'brute-clang', position: near() })
assert(audio.diagnostics.sources > before + oneClang, 'the next clang rings once the gap has passed')
endAll(fresh(mark))
mark = context.nodes.length; before = audio.diagnostics.sources
for (let i = 0; i < 12; i++) audio.play({ kind: 'inkwing-flap', position: near() })
const flapped = sources(fresh(mark)).length
assert(flapped > 0 && flapped <= FLAP_BUDGET * 2, `a flock's wing beats are capped (${flapped} sources)`)
endAll(fresh(mark))
console.log('PASS clangs are spaced and a flock\'s wing beats are capped')

before = audio.diagnostics.sources
audio.play({ kind: 'inkwing-flap', position: new THREE.Vector3(40, 0, 0), radius: 25 })
audio.play({ kind: 'brute-stomp', position: new THREE.Vector3(80, 0, 0), radius: 45 })
assert.equal(audio.diagnostics.sources, before, 'out of earshot, nothing plays')
audio.setMuted(true); audio.play({ kind: 'brute-enrage', position: near() }); assert.equal(audio.diagnostics.sources, before, 'muted, nothing plays'); audio.setMuted(false)
console.log('PASS distant and muted creature sounds stay silent')
