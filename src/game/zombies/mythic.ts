import * as THREE from 'three'
import { metal } from '../../lab/weapons/models/common'
import { RARITY_INFO } from '../loot'
import { synthOutput } from '../ui-slot-sound'

/**
 * Dead Ink's Mythic tier, above Legendary: about one Mystery Box roll in a thousand. Its colour is a
 * magenta that no other tier uses, running from crimson to violet; its guns wear an ink dragon coiled
 * round them; the box makes a moment of it; and it has its own sting.
 */
export const MYTHIC = {
  color: RARITY_INFO.mythic.color,
  css: RARITY_INFO.mythic.css,
  /** The two ends of its shimmer. */
  crimson: 0xff2d55,
  violet: 0x8b3dff,
  /** CSS gradient for text and edges. */
  gradient: 'linear-gradient(90deg, #ff2d55, #e0268f 45%, #8b3dff)',
} as const

/**
 * The box's Mythic reveal: the reel runs `slow` seconds longer and eases down to a crawl, the box
 * flickers in the tier's colour over its last `tease` seconds, and on landing a burst and a tall beam
 * play out over `burst` seconds while the gun pops up and turns once.
 */
export const MYTHIC_REVEAL = { slow: 1.8, tease: 1.3, burst: 1.8, beam: 16 } as const

// ---------------------------------------------------------------- the dragon skin

/** Seconds for the shimmer, shared by every dragon; advanced as it draws, still under reduced motion. */
const dragonTime = { value: 0 }
const reducedMotion = () => typeof document !== 'undefined' && document.body?.dataset.reducedMotion === 'true'
const dragonMaterials = new Map<string, THREE.MeshBasicMaterial>()

/** Where the dragon lies on a gun, in gun space: its head behind the muzzle, its tail at the butt, coiled round the bore line. */
function dragonFrame(model: THREE.Object3D) {
  const muzzle = (model.userData.muzzle as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0.05, 0.3)
  model.updateWorldMatrix(true, true)
  const inverse = model.matrixWorld.clone().invert(), box = new THREE.Box3(), piece = new THREE.Box3(), local = new THREE.Matrix4()
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.material !== metal) return
    object.geometry.boundingBox ?? object.geometry.computeBoundingBox()
    box.union(piece.copy(object.geometry.boundingBox!).applyMatrix4(local.multiplyMatrices(inverse, object.matrixWorld)))
  })
  const tail = Math.min(box.isEmpty() ? muzzle.z - 0.4 : box.min.z + 0.01, muzzle.z - 0.12)
  // The head rides where the gun is still thick, a fifth of the way back from the muzzle.
  return { head: tail + (muzzle.z - tail) * 0.8, tail, axis: muzzle.y }
}

/**
 * The Mythic skin: an ink dragon coiled round the gun from butt to muzzle. Batched gun faces carry no
 * UVs, so like the camos it is drawn from gun-space position: the angle round the bore line against a
 * helix along it gives the body, which tapers to the tail and ends in a horned head behind the muzzle.
 * Its scales are inked arcs, hatched where they overlap; a spiked crest runs down its back and plates
 * down its belly; a crimson-to-violet shimmer runs head-ward along it. Everything else stays paper.
 * `packed` swaps the shimmer for the Pack-a-Punch's run of colours, so an upgraded Mythic keeps its
 * dragon and still reads as upgraded.
 */
export function dragonMaterial(frame: { head: number; tail: number; axis: number }, packed = false) {
  const key = `${frame.head.toFixed(3)}:${frame.tail.toFixed(3)}:${frame.axis.toFixed(3)}:${packed}`
  const cached = dragonMaterials.get(key)
  if (cached) return cached
  const material = metal.clone()
  material.name = 'Mythic dragon'
  material.userData.mythicDragon = true
  material.defines = { DRAGON_PACKED: packed ? 1 : 0 }
  const uniforms = {
    dragonTime,
    dragonHead: { value: frame.head }, dragonTail: { value: frame.tail }, dragonAxis: { value: frame.axis },
    dragonCrimson: { value: new THREE.Color(MYTHIC.crimson) }, dragonViolet: { value: new THREE.Color(MYTHIC.violet) },
  }
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vDragonPosition;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vDragonPosition = position;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vDragonPosition;
        uniform float dragonTime, dragonHead, dragonTail, dragonAxis;
        uniform vec3 dragonCrimson, dragonViolet;
        float dragonHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec3 dragonHue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
        // Returns the dragon's colour over paper at this point of the gun.
        vec3 dragonSkin(vec3 p) {
          const float PITCH = 0.5;
          const vec3 INK = vec3(0.012);
          float length_ = max(dragonHead - dragonTail, 0.08);
          float fromHead = dragonHead - p.z;
          if (fromHead < 0.0 || p.z < dragonTail) return vec3(1.0);
          float along = clamp((p.z - dragonTail) / length_, 0.0, 1.0);
          // The coil: the angle round the bore line, against a helix turning along it. The head is set on
          // the gun's right side, a little up: the side first person sees, and the side the box shows.
          float phi = atan(p.y - dragonAxis, p.x);
          float d = mod(phi - (p.z - dragonHead) * PI2 / PITCH - 0.35 + PI, PI2) - PI;
          // Body width in radians: a head that swells behind a rounded snout, a neck, a body tapering to the tail.
          float head = smoothstep(0.0, 0.022, fromHead) * (1.0 - smoothstep(0.07, 0.092, fromHead));
          float body = mix(0.15, 1.15, smoothstep(0.0, 0.4, along)) * smoothstep(0.075, 0.11, fromHead);
          float width = max(body, head * 1.4 * sqrt(clamp(fromHead / 0.025, 0.0, 1.0)));
          float v = d / max(width, 0.001);
          // The crest: a row of spikes along its back, higher toward the head.
          float spikeRow = 1.0 - abs(fract(p.z / 0.016) * 2.0 - 1.0);
          float crest = step(1.0, v) * step(v, 1.0 + (0.2 + 0.35 * along) * spikeRow) * step(0.1, fromHead);
          // Horns: two swept back from the top of the head.
          float hornT = clamp((fromHead - 0.05) / 0.065, 0.0, 1.0);
          float horn = step(0.05, fromHead) * step(fromHead, 0.115) * step(0.7, v) * step(v, 0.7 + 0.9 * (1.0 - hornT));
          vec3 colour = vec3(1.0);
          if (crest + horn > 0.0) return mix(INK, dragonCrimson * 0.35, horn * 0.4);
          if (abs(v) > 1.0) return colour;
          // The tier's colour runs along it, with a bright shimmer travelling head-ward.
          #if DRAGON_PACKED == 1
            vec3 tint = dragonHue(fract(along * 1.3 - dragonTime * 0.25));
          #else
            vec3 tint = mix(dragonCrimson, dragonViolet, 0.5 + 0.5 * sin(along * 7.0 - dragonTime * 1.7));
          #endif
          float wave = fract(along * 0.9 - dragonTime * 0.32);
          float shimmer = pow(max(0.0, 1.0 - abs(wave - 0.5) * 7.0), 2.0);
          colour = mix(vec3(1.0), tint, 0.78 + 0.2 * shimmer);
          colour += shimmer * 0.45 * mix(tint, vec3(1.0), 0.6);
          float isHead = step(fromHead, 0.082);
          if (isHead > 0.5) {
            // The head: smooth skin hatched along the jaw, a glowing slit eye, a mouth line, a nostril.
            float jaw = step(fract((p.z + v * 0.012) / 0.0036), 0.3) * step(v, -0.25);
            colour = mix(colour, INK, jaw * 0.85);
            vec2 eye = vec2((fromHead - 0.042) / 0.011, (v - 0.3) / 0.24);
            float eyeR = length(eye);
            colour = mix(colour, mix(vec3(1.0, 0.9, 0.35), dragonCrimson, 0.35) * 1.4, step(eyeR, 1.0));
            colour = mix(colour, INK, step(abs(eye.x), 0.22) * step(eyeR, 1.0));
            colour = mix(colour, INK, step(abs(eyeR - 1.05), 0.2));
            colour = mix(colour, INK, step(abs(v + 0.08), 0.07) * step(fromHead, 0.05));
            // Teeth along the mouth line.
            float teeth = step(abs(v + 0.08 + 0.12 * (1.0 - abs(fract(fromHead / 0.007) * 2.0 - 1.0))), 0.05) * step(fromHead, 0.045) * step(v, -0.08);
            colour = mix(colour, INK, teeth);
            colour = mix(colour, INK, step(length(vec2((fromHead - 0.011) / 0.0042, (v - 0.35) / 0.12)), 1.0));
          } else {
            // Scales: overlapping arcs in staggered rows, hatched in their shadowed lower half.
            vec2 q = vec2(p.z / 0.011, v * 2.4);
            q.x += 0.5 * mod(floor(q.y), 2.0);
            vec2 f = fract(q) - vec2(0.5, 0.0);
            float r = length(f * vec2(1.0, 1.15));
            float arc = 1.0 - smoothstep(0.035, 0.085, abs(r - 0.5));
            float hatch = step(0.6, fract((p.z * 0.9 + v * 0.014) / 0.0026)) * smoothstep(0.24, 0.4, r) * step(r, 0.5);
            // Belly plates: straight bars across the lower third instead of scales.
            float belly = step(v, -0.5);
            float plate = step(0.8, fract(p.z / 0.009));
            float marks = mix(max(arc, hatch * 0.75), plate, belly);
            colour = mix(colour, INK, marks * (0.9 - 0.25 * shimmer));
          }
          // The ink outline round the whole body.
          colour = mix(colour, INK, smoothstep(0.78, 0.9, abs(v)));
          return colour;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = dragonSkin(vDragonPosition);`)
  }
  material.customProgramCacheKey = () => `dead-ink-dragon:${packed ? 1 : 0}`
  material.onBeforeRender = () => { dragonTime.value = reducedMotion() ? 2 : performance.now() / 1000 % 1000 }
  dragonMaterials.set(key, material)
  return material
}

/** Coil the dragon round a gun's paper faces. `packed` for an upgraded Mythic. Returns false when there was no paper to paint. */
export function applyDragonSkin(model: THREE.Object3D, packed = false) {
  const skin = dragonMaterial(dragonFrame(model), packed)
  let painted = false
  model.traverse(object => { if (object instanceof THREE.Mesh && object.material === metal) { object.material = skin; painted = true } })
  return painted
}

/** Back to plain paper. */
export function removeDragonSkin(model: THREE.Object3D) {
  model.traverse(object => { if (object instanceof THREE.Mesh && (object.material as THREE.Material).userData?.mythicDragon) object.material = metal })
}

// ---------------------------------------------------------------- the sting

/** Seconds the Mythic sting lasts. */
export const MYTHIC_STING = 3.8

/** Semitones from A4 to a frequency. */
const hz = (semitones: number) => 440 * 2 ** (semitones / 12)

/** A small generated hall: decaying noise, so the chords bloom rather than stop. */
let hall: AudioBuffer | null = null
function hallBuffer(context: AudioContext) {
  if (hall && hall.sampleRate === context.sampleRate) return hall
  const length = Math.floor(context.sampleRate * 2.6)
  hall = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = hall.getChannelData(channel)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6
  }
  return hall
}

/**
 * The Mythic sting, synthesised: about 3.8 s of brass and choir. A low boom and a minor chord swelling
 * in (D minor), a lift to B-flat major, and a bright D major that rings out over a shimmer: dark to
 * triumphant, the box's moment. Brass is detuned saws through a filter that opens as it swells; the
 * choir is soft vowel-filtered voices with vibrato; both go through a generated hall. Plays at the
 * player's music volume; silent when muted.
 */
export function playMythicSting() {
  const sound = synthOutput('music', 0.7)
  if (!sound) return false
  const { context, out } = sound, t0 = context.currentTime + 0.03
  const dry = context.createGain(), wet = context.createGain(), reverb = context.createConvolver()
  dry.gain.value = 0.75; wet.gain.value = 0.45
  reverb.buffer = hallBuffer(context)
  dry.connect(out); wet.connect(reverb).connect(out)
  const bus = context.createGain()
  bus.connect(dry); bus.connect(wet)
  // The master envelope: in, and a long fade at the end.
  bus.gain.setValueAtTime(0.0001, t0)
  bus.gain.exponentialRampToValueAtTime(1, t0 + 0.25)
  bus.gain.setValueAtTime(1, t0 + MYTHIC_STING - 1.3)
  bus.gain.exponentialRampToValueAtTime(0.0001, t0 + MYTHIC_STING)

  // Chords as semitones from A4: D minor, B-flat major, D major.
  const chords: { at: number; to: number; notes: number[]; swell: number }[] = [
    { at: 0, to: 1.25, notes: [-19, -12, -7, -4, 0, 5], swell: 0.7 },
    { at: 1.2, to: 2.2, notes: [-23, -11, -7, -2, 1, 5], swell: 0.35 },
    { at: 2.15, to: MYTHIC_STING, notes: [-19, -12, -7, -3, 0, 5, 9], swell: 0.2 },
  ]
  const brass = (semitone: number, at: number, to: number, swell: number, level: number) => {
    const filter = context.createBiquadFilter(), gain = context.createGain()
    filter.type = 'lowpass'; filter.Q.value = 1.2
    filter.frequency.setValueAtTime(350, at)
    filter.frequency.exponentialRampToValueAtTime(2600, at + swell + 0.25)
    filter.frequency.exponentialRampToValueAtTime(1400, to)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(level, at + swell)
    gain.gain.setValueAtTime(level, Math.max(at + swell, to - 0.12))
    gain.gain.exponentialRampToValueAtTime(0.0001, to + 0.25)
    filter.connect(gain).connect(bus)
    for (const detune of [-9, 0, 8]) {
      const osc = context.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = hz(semitone)
      osc.detune.value = detune
      osc.connect(filter)
      osc.start(at); osc.stop(to + 0.3)
    }
  }
  const choir = (semitone: number, at: number, to: number, swell: number, level: number) => {
    // A voice: a soft saw through two vowel formants ("ah"), with a slow vibrato.
    const osc = context.createOscillator(), vibrato = context.createOscillator(), depth = context.createGain()
    osc.type = 'sawtooth'; osc.frequency.value = hz(semitone)
    vibrato.frequency.value = 5 + Math.random(); depth.gain.value = hz(semitone) * 0.006
    vibrato.connect(depth).connect(osc.frequency)
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(level, at + swell + 0.15)
    gain.gain.setValueAtTime(level, Math.max(at + swell + 0.15, to - 0.1))
    gain.gain.exponentialRampToValueAtTime(0.0001, to + 0.4)
    for (const [frequency, q, amount] of [[800, 6, 1], [1150, 8, 0.6], [2900, 10, 0.25]] as const) {
      const formant = context.createBiquadFilter(), f = context.createGain()
      formant.type = 'bandpass'; formant.frequency.value = frequency; formant.Q.value = q
      f.gain.value = amount
      osc.connect(formant).connect(f).connect(gain)
    }
    gain.connect(bus)
    osc.start(at); vibrato.start(at); osc.stop(to + 0.5); vibrato.stop(to + 0.5)
  }
  for (const chord of chords) {
    const at = t0 + chord.at, to = t0 + chord.to
    chord.notes.forEach((semitone, i) => {
      if (i < 4) brass(semitone, at, to, chord.swell, i === 0 ? 0.07 : 0.05)
      if (i >= 2) choir(semitone + 12, at, to, chord.swell, 0.09)
    })
  }
  // Booms under the first and last chords: a falling sine and a thump of filtered noise.
  for (const at of [t0, t0 + 2.15]) {
    const osc = context.createOscillator(), gain = context.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(95, at); osc.frequency.exponentialRampToValueAtTime(38, at + 0.9)
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.7, at + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.3)
    osc.connect(gain).connect(bus); osc.start(at); osc.stop(at + 1.4)
    const noise = context.createBufferSource(), low = context.createBiquadFilter(), thump = context.createGain()
    noise.buffer = hallBuffer(context)
    low.type = 'lowpass'; low.frequency.value = 260
    thump.gain.setValueAtTime(0.9, at); thump.gain.exponentialRampToValueAtTime(0.0001, at + 0.5)
    noise.connect(low).connect(thump).connect(bus); noise.start(at, 0, 0.6)
  }
  // The shimmer over the final chord: quick high notes climbing the D major, like light on metal.
  for (let i = 0; i < 16; i++) {
    const at = t0 + 2.25 + i * 0.06
    const osc = context.createOscillator(), gain = context.createGain()
    osc.type = 'sine'
    osc.frequency.value = hz(17 + [0, 4, 7, 12][i % 4] + 12 * Math.floor(i / 8))
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.045, at + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5)
    osc.connect(gain).connect(bus); osc.start(at); osc.stop(at + 0.55)
  }
  setTimeout(() => out.disconnect(), (MYTHIC_STING + 3) * 1000)
  return true
}
