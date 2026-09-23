/**
 * Dead Ink's music: whole tracks, made for the game with Suno, streamed from public/music. They play
 * through audio elements rather than the effects engine, which is suspended whenever the game is paused,
 * so the menu theme can play over the menu. Each track has a level for the menu and for play; moving
 * between them crossfades. A track that does not exist yet is simply not played.
 */
export type MusicMode = 'menu' | 'play'

/** The tracks by role. `round` plays in play when it exists; until then the menu theme does, quietly. */
export const TRACKS: { menu: string; round: string | null } = { menu: 'music/mechanical-lullaby.mp3', round: null }
const LEVEL = { menu: 0.6, playUnderMenuTheme: 0.2, round: 0.4 } as const
const FADE_SECONDS = 1.6

export class DeadInkMusic {
  private menu: HTMLAudioElement
  private round: HTMLAudioElement | null
  private mode: MusicMode = 'menu'
  private gains = { menu: 0, round: 0 }
  private volume = 0.55
  private muted = false
  private unlocked = false
  private frame = 0
  private last = 0
  private disposed = false

  constructor(base: string) {
    const track = (path: string) => {
      const audio = new Audio(`${base}${path}`)
      audio.loop = true
      audio.preload = 'auto'
      audio.volume = 0
      return audio
    }
    this.menu = track(TRACKS.menu)
    this.round = TRACKS.round ? track(TRACKS.round) : null
  }

  /** Browsers only start audio after a click or key press; call from one. */
  unlock() {
    if (this.unlocked || this.disposed) return
    this.unlocked = true
    this.tick()
  }

  setMode(mode: MusicMode) { this.mode = mode; this.tick() }
  setVolume(volume: number) { this.volume = volume; this.apply() }
  setMuted(muted: boolean) { this.muted = muted; this.apply() }

  /** A hidden tab is silent. */
  setHidden(hidden: boolean) {
    if (hidden) { this.menu.pause(); this.round?.pause() } else this.tick()
  }

  private targets() {
    if (this.mode === 'menu') return { menu: LEVEL.menu, round: 0 }
    return this.round ? { menu: 0, round: LEVEL.round } : { menu: LEVEL.playUnderMenuTheme, round: 0 }
  }

  /** Fade toward the levels for the current mode, a frame at a time, then stop ticking. */
  private tick = () => {
    if (!this.unlocked || this.disposed || document.hidden) return
    if (this.frame) return
    this.last = performance.now()
    const step = () => {
      const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      const target = this.targets()
      let settled = true
      for (const key of ['menu', 'round'] as const) {
        const delta = target[key] - this.gains[key]
        const move = Math.sign(delta) * Math.min(Math.abs(delta), dt / FADE_SECONDS)
        this.gains[key] += move
        if (Math.abs(target[key] - this.gains[key]) > 1e-3) settled = false
      }
      this.apply()
      this.frame = settled ? 0 : requestAnimationFrame(step)
    }
    this.frame = requestAnimationFrame(step)
  }

  private apply() {
    const master = this.muted ? 0 : this.volume
    for (const [key, audio] of [['menu', this.menu], ['round', this.round]] as const) {
      if (!audio) continue
      const level = master * this.gains[key]
      audio.volume = Math.max(0, Math.min(1, level))
      if (level > 0.001 && audio.paused && this.unlocked && !document.hidden) void audio.play().catch(() => {})
      if (level <= 0.001 && !audio.paused) audio.pause()
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    for (const audio of [this.menu, this.round]) if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
  }
}
