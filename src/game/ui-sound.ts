import { getSettings, volumeFor } from './settings'

/**
 * Menu sounds: a dry paper tick when a button is pressed and a fainter one when the pointer moves onto
 * one, like a pen tapping a page. They play through their own small audio context, because the game's
 * sound engine is paused whenever the menu is open. Mute and the effects volume apply.
 */
const TARGETS = 'button, a[href], select, [role="radio"], [role="tab"], .armory-item, .menu-mode'

let context: AudioContext | null = null
let noise: AudioBuffer | null = null
let hovered: Element | null = null
let lastHover = 0

function audio() {
  if (!context) {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) return null
    context = new Context()
    noise = context.createBuffer(1, Math.floor(context.sampleRate * 0.1), context.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3
  }
  if (context.state === 'suspended') void context.resume().catch(() => {})
  return context
}

/** One tick: a burst of bright noise through a band-pass, and for a press a soft low knock under it. */
function tick(press: boolean) {
  const settings = getSettings()
  const level = settings.muted ? 0 : volumeFor(settings, 'effects')
  if (level <= 0.001) return
  const ctx = audio()
  if (!ctx || !noise) return
  const t = ctx.currentTime
  const source = ctx.createBufferSource(), band = ctx.createBiquadFilter(), gain = ctx.createGain()
  source.buffer = noise
  source.playbackRate.value = press ? 0.9 + Math.random() * 0.1 : 1.4 + Math.random() * 0.2
  band.type = 'bandpass'; band.frequency.value = press ? 2600 : 4200; band.Q.value = 1.2
  gain.gain.setValueAtTime((press ? 0.5 : 0.12) * level, t)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + (press ? 0.07 : 0.035))
  source.connect(band).connect(gain).connect(ctx.destination)
  source.start(t); source.stop(t + 0.1)
  if (!press) return
  const knock = ctx.createOscillator(), knockGain = ctx.createGain()
  knock.type = 'sine'
  knock.frequency.setValueAtTime(180, t); knock.frequency.exponentialRampToValueAtTime(90, t + 0.06)
  knockGain.gain.setValueAtTime(0.35 * level, t)
  knockGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
  knock.connect(knockGain).connect(ctx.destination)
  knock.start(t); knock.stop(t + 0.09)
}

const enabled = (element: Element | null): element is HTMLElement =>
  !!element && !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true'

/** Listen on the whole page once; only real, enabled controls make a sound. */
export function installUiSounds() {
  document.addEventListener('click', event => {
    const target = (event.target as Element | null)?.closest(TARGETS) ?? null
    if (enabled(target)) tick(true)
  }, { capture: true })
  document.addEventListener('pointerover', event => {
    const target = (event.target as Element | null)?.closest(TARGETS) ?? null
    if (target === hovered) return
    hovered = target
    const now = performance.now()
    // Sweeping across a row of buttons should patter, not buzz.
    if (enabled(target) && context && now - lastHover > 45) { lastHover = now; tick(false) }
  })
}
