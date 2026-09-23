/**
 * Dead Ink's music: whole tracks made for the game with Suno, streamed from public/music through audio
 * elements rather than the effects engine (which is suspended whenever the game is paused, and the menu
 * theme must play over the menu).
 *
 * As in Call of Duty, a round itself has no music, only its sounds: a theme over the menu, a sting as a
 * round starts, a jingle while the box spins, the Brute's own track while it lives, a requiem when you
 * die, and one hidden song for whoever finds the Easter egg.
 */
export type MusicMode = 'menu' | 'play' | 'boss' | 'dead'
type Bed = 'menu' | 'boss' | 'dead'
export type Sting = 'roundStart' | 'boxSpin' | 'song'

const BEDS: Record<Bed, { file: string; level: number }> = {
  menu: { file: 'music/mechanical-lullaby.mp3', level: 0.6 },
  boss: { file: 'music/boss.mp3', level: 0.5 },
  dead: { file: 'music/game-over.mp3', level: 0.6 },
}
const STINGS: Record<Sting, { file: string; level: number }> = {
  roundStart: { file: 'music/round-start.mp3', level: 0.75 },
  boxSpin: { file: 'music/box-spin.mp3', level: 0.6 },
  song: { file: 'music/easter-egg.mp3', level: 0.7 },
}
const FADE_SECONDS = 1.6

export class DeadInkMusic {
  private beds = {} as Record<Bed, HTMLAudioElement>
  private stings = {} as Record<Sting, HTMLAudioElement>
  private gains: Record<Bed, number> = { menu: 0, boss: 0, dead: 0 }
  private mode: MusicMode = 'menu'
  private volume = 0.55
  private muted = false
  private unlocked = false
  private frame = 0
  private last = 0
  private disposed = false

  constructor(base: string) {
    const load = (file: string, loop: boolean) => {
      const audio = new Audio(`${base}${file}`)
      audio.loop = loop
      audio.preload = loop ? 'auto' : 'auto'
      audio.volume = 0
      return audio
    }
    for (const [bed, { file }] of Object.entries(BEDS) as [Bed, { file: string }][]) this.beds[bed] = load(file, true)
    for (const [sting, { file }] of Object.entries(STINGS) as [Sting, { file: string }][]) this.stings[sting] = load(file, false)
  }

  /** Browsers only start audio after a click or key press; call from one. */
  unlock() {
    if (this.unlocked || this.disposed) return
    this.unlocked = true
    this.tick()
  }

  setMode(mode: MusicMode) { if (mode !== this.mode) { this.mode = mode; this.tick() } }
  setVolume(volume: number) { this.volume = volume; this.apply() }
  setMuted(muted: boolean) { this.muted = muted; this.apply() }

  /** Play a one-shot from the start (the hidden song stops everything else while it plays). */
  sting(name: Sting) {
    if (!this.unlocked || this.disposed || this.muted) return
    const audio = this.stings[name]
    audio.currentTime = 0
    audio.volume = Math.min(1, this.volume * STINGS[name].level)
    void audio.play().catch(() => {})
    if (name === 'song') this.tick()
  }

  stopStings() { for (const audio of Object.values(this.stings)) { audio.pause(); audio.currentTime = 0 } }

  /** A hidden tab is silent. */
  setHidden(hidden: boolean) {
    if (hidden) for (const audio of [...Object.values(this.beds), ...Object.values(this.stings)]) audio.pause()
    else this.tick()
  }

  private songPlaying() { return !this.stings.song.paused }

  private targets(): Record<Bed, number> {
    const off = { menu: 0, boss: 0, dead: 0 }
    if (this.songPlaying() || this.mode === 'play') return off
    return { ...off, [this.mode]: BEDS[this.mode as Bed].level }
  }

  /** Fade toward the levels for the current mode, a frame at a time, then stop ticking. */
  private tick = () => {
    if (!this.unlocked || this.disposed || document.hidden || this.frame) return
    this.last = performance.now()
    const step = () => {
      const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      const target = this.targets()
      let settled = !this.songPlaying()
      for (const bed of Object.keys(this.gains) as Bed[]) {
        const delta = target[bed] - this.gains[bed]
        this.gains[bed] += Math.sign(delta) * Math.min(Math.abs(delta), dt / FADE_SECONDS)
        if (Math.abs(target[bed] - this.gains[bed]) > 1e-3) settled = false
      }
      this.apply()
      this.frame = settled ? 0 : requestAnimationFrame(step)
    }
    this.frame = requestAnimationFrame(step)
  }

  private apply() {
    const master = this.muted ? 0 : this.volume
    for (const bed of Object.keys(this.beds) as Bed[]) {
      const audio = this.beds[bed], level = master * this.gains[bed]
      audio.volume = Math.max(0, Math.min(1, level))
      if (level > 0.001 && audio.paused && this.unlocked && !document.hidden) void audio.play().catch(() => {})
      if (level <= 0.001 && !audio.paused) audio.pause()
    }
    for (const [name, audio] of Object.entries(this.stings) as [Sting, HTMLAudioElement][]) audio.volume = Math.min(1, master * STINGS[name].level)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    for (const audio of [...Object.values(this.beds), ...Object.values(this.stings)]) { audio.pause(); audio.removeAttribute('src'); audio.load() }
  }
}
