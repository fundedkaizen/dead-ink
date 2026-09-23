import './menu.css'
import { missionObjective, type MissionState } from './mission'
import { DEAD_INK_ART, HOSTAGE_ART } from './mode-art'
import { BLOOD_LABELS, QUALITY, SETTING_LIMITS, getSettings, prefersReducedMotion, setSettings, type Blood, type Quality, type Settings } from './settings'

/** The built-in pages, plus any a mode adds through `MenuCopy.pages`. */
type MenuPage = 'home' | 'mission' | 'controls' | 'settings' | 'vr' | 'restart' | 'gameover' | (string & {})
type MenuCallbacks = { retry: () => void; restart: () => void }

/** What the menu reads from game state. The hostage mission passes its full MissionState. */
export type MenuState = Pick<MissionState, 'phase' | 'health' | 'elapsed' | 'kills'>

/** The two game modes, as the title screen's cards show them. */
export type GameMode = 'hostage' | 'zombies'
export const MODES: Record<GameMode, { name: string; kind: string; blurb: string; href: string; art: string }> = {
  hostage: { name: 'Hostage mission', kind: 'Hostage mission', blurb: 'A stealth rescue mission.', href: './', art: HOSTAGE_ART },
  zombies: { name: 'Dead Ink', kind: 'Zombies', blurb: 'Zombies, round after round.', href: '?mode=zombies', art: DEAD_INK_ART },
}

/**
 * The words on the menu. Modes other than the hostage mission (Dead Ink) supply their own;
 * MISSION_COPY holds the mission's original strings verbatim, so its menu reads exactly as before.
 */
export type MenuCopy = {
  title: string; premise: string; begin: string; resume: string; restart: string
  deadTitle: string; completeTitle: string; completePremise: string
  objective: (state: MenuState) => string
  /** Which mode this is, for the title screen's mode cards. Defaults to what the URL says (?mode=zombies). */
  mode?: GameMode
  /** Recap rows on the win screen; the mission's Time / Kills / Health recap when absent. */
  recap?: (state: MenuState) => [string, string][]
  /** The mission's field-map page. Off for modes whose map it does not describe. */
  missionPage?: boolean
  /** A menu button (while paused) that switches to the other game mode; the title screen shows the mode cards. */
  modeLink?: { label: string; href: string }
  /** A line shown on the death screen (the mission shows none). */
  deadPremise?: (state: MenuState) => string
  /**
   * A full game-over page (Dead Ink's summary). When present, dying opens it, with Play again and Main menu,
   * instead of the home page's death state. `build` fills its body once; `show` runs each time a game ends.
   */
  gameOver?: { build: (body: HTMLElement) => void; show: (state: MenuState) => void }
  /** The warning on the restart confirmation page. */
  restartWarning?: string
  /** Extra rows for the Controls page, as [action, key]. */
  controls?: [string, string][]
  /** Pages a mode adds (Dead Ink's Armory), each opened from a link on the home page. */
  pages?: MenuExtraPage[]
  /** Fills a slot on the home page under the premise (Dead Ink's last game and Ink). */
  home?: (slot: HTMLElement) => void
  /** Show a music volume (modes with music). Defaults to on for Dead Ink. */
  music?: boolean
}
/** `build` fills the page once; `show` runs each time it opens. The page's own heading is `title`. */
export type MenuExtraPage = { id: string; label: string; title: string; build: (body: HTMLElement) => void; show?: () => void }
export const MISSION_COPY: MenuCopy = {
  title: 'Operation Safe Return', premise: 'Find the hostage. Get out together.',
  begin: 'Begin mission', resume: 'Resume mission', restart: 'Restart mission',
  deadTitle: 'No way through.', completeTitle: 'Hostage safe.', completePremise: 'You both made it out.',
  // Only the mission uses this copy, and the mission always passes its full MissionState.
  objective: state => missionObjective(state as MissionState),
  mode: 'hostage',
  missionPage: true,
  restartWarning: 'Your current mission progress will be reset.',
  modeLink: { label: 'Dead Ink', href: '?mode=zombies' },
}

const currentMode = (copy: MenuCopy): GameMode =>
  copy.mode ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mode') === 'zombies' ? 'zombies' : 'hostage')

const back = '<button class="menu-back" data-menu-back><span aria-hidden="true">←</span> Back <kbd>Esc</kbd></button>'

/** A labelled slider row on the Settings page, its value written beside it. */
const slider = (id: string, label: string, min: number, max: number, step: number) => `<div class="settings-row">
    <label for="${id}">${label}</label>
    <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" />
    <output id="${id}-value" for="${id}"></output>
  </div>`
const toggle = (id: string, label: string, checked = false) => `<div class="settings-row settings-toggle">
    <label for="${id}">${label}</label><input id="${id}" type="checkbox" ${checked ? 'checked' : ''} /></div>`

/** Slider settings: which input edits which key, and how its value reads. */
type SliderSetting = { id: string; key: 'fov' | 'sensitivity' | 'adsSensitivity' | 'controllerSensitivity' | 'masterVolume' | 'musicVolume' | 'effectsVolume'; format: (value: number) => string }
const SLIDERS: SliderSetting[] = [
  { id: 'settings-fov', key: 'fov', format: v => `${Math.round(v)}°` },
  { id: 'settings-sensitivity', key: 'sensitivity', format: v => `${v.toFixed(2)}×` },
  { id: 'settings-ads', key: 'adsSensitivity', format: v => `${v.toFixed(2)}×` },
  { id: 'settings-controller', key: 'controllerSensitivity', format: v => `${v.toFixed(2)}×` },
  { id: 'mission-volume', key: 'masterVolume', format: v => `${Math.round(v)}%` },
  { id: 'settings-music', key: 'musicVolume', format: v => `${Math.round(v)}%` },
  { id: 'settings-effects', key: 'effectsVolume', format: v => `${Math.round(v)}%` },
]

/** One decision at a time; reference material never blocks entering the game. */
export class MissionMenu {
  private card = document.querySelector<HTMLElement>('.walk-card')!
  private pause = document.querySelector<HTMLElement>('#walk-pause')!
  private abort = new AbortController()
  private page: MenuPage = 'home'
  private phase: MissionState['phase'] = 'active'
  private hasPlayed = false
  private wasPlaying = false
  private loaded = false
  private loadError = ''
  /** After a game over, the player chose Main menu: the home page is the title screen again. */
  private mainMenu = false
  private returnFocus: HTMLElement | null = null
  private last: { state: MenuState; data: { playing: boolean; enabled: boolean; ready: boolean } } | null = null
  private title: HTMLElement
  private premise: HTMLElement
  private retry: HTMLButtonElement
  private restart: HTMLButtonElement
  private playAgain: HTMLButtonElement | null

  constructor(private start: HTMLButtonElement, map: string, reducedMotion: boolean, callbacks: MenuCallbacks, private copy: MenuCopy = MISSION_COPY) {
    const mode = currentMode(copy), otherMode: GameMode = mode === 'zombies' ? 'hostage' : 'zombies'
    const here = MODES[mode], other = MODES[otherMode]
    const music = copy.music ?? mode === 'zombies'
    this.card.classList.add('menu-card')
    this.pause.classList.add('menu-host')
    this.card.dataset.page = 'home'
    this.card.dataset.title = 'true'
    this.card.dataset.menuMode = mode
    this.card.setAttribute('role', 'dialog')
    this.card.setAttribute('aria-modal', 'true')
    this.card.setAttribute('aria-labelledby', 'mission-menu-title')
    this.card.innerHTML = `
      <section data-menu-page="home">
        <div class="menu-modes">
          <div class="menu-mode is-current" aria-current="true">
            <div class="menu-mode-art" aria-hidden="true">${here.art}</div>
            <div class="menu-mode-body">
              <p class="menu-mode-kind">${here.kind}</p>
              <h1 id="mission-menu-title">${copy.title}</h1>
              <p id="mission-premise">${copy.premise}</p>
              ${copy.home ? '<div class="menu-home-extra"></div>' : ''}
              <div id="mission-debrief" role="status" hidden></div>
              <div class="mission-actions">
                <div class="mission-start-slot"></div>
                <button id="mission-retry" class="menu-primary" hidden>Try again</button>
                <button id="mission-restart" class="menu-quiet" hidden>Restart mission</button>
              </div>
            </div>
          </div>
          <a class="menu-mode is-other" href="${other.href}" data-mode-card="${otherMode}">
            <span class="menu-mode-art" aria-hidden="true">${other.art}</span>
            <span class="menu-mode-name">${other.name}</span>
            <span class="menu-mode-blurb">${other.blurb}</span>
          </a>
        </div>
        <nav class="mission-menu-links" aria-label="Mission menu">
          ${copy.missionPage === false ? '' : '<button data-menu-open="mission">Mission</button>'}
          ${copy.modeLink ? `<button data-mode-href="${copy.modeLink.href}">${copy.modeLink.label}</button>` : ''}
          ${(copy.pages ?? []).map(page => `<button data-menu-open="${page.id}">${page.label}</button>`).join('')}
          <button data-menu-open="controls">Controls</button>
          <button data-menu-open="settings">Settings</button>
        </nav>
      </section>
      <section data-menu-page="mission" hidden>
        ${back}
        <h2 id="mission-page-title">The rescue</h2>
        <p id="mission-current-objective">Find detention and reach the cells.</p>
        <div class="field-map">${map}</div>
        <p class="map-legend"><span>— Rail route</span><span>┄ Service route</span><span>▲ You</span></p>
        <details class="mission-tips"><summary>Route tips</summary>
          <p>Take the mess-hall roof to the rail line, or the west service gate to the covered lanes.</p>
          <p>The office terminal stops cameras for 60 seconds. Security shuts them down permanently. Open the exit gate before the rescue.</p>
          <p>The jeep is southeast of detention. If the hostage falls behind, return to him and lead him onward. Alarms bring reinforcements; you don’t need to fight everyone.</p>
        </details>
      </section>
      <section data-menu-page="controls" hidden>
        ${back}
        <h2 id="controls-page-title">Controls</h2>
        <dl class="mission-keys">
          <div><dt>Move</dt><dd><kbd>W A S D</kbd></dd></div>
          <div><dt>Look</dt><dd><kbd>Mouse</kbd></dd></div>
          <div><dt>Fire</dt><dd><kbd>Left click</kbd></dd></div>
          <div><dt>Toggle aim</dt><dd><kbd>Right click</kbd></dd></div>
          <div><dt>Interact / pick up</dt><dd><kbd>F</kbd></dd></div>
          <div><dt>Reload</dt><dd><kbd>R</kbd></dd></div>
          <div><dt>Sprint</dt><dd><kbd>Shift</kbd></dd></div>
          <div><dt>Jump</dt><dd><kbd>Space</kbd></dd></div>
          <div><dt>Switch weapon</dt><dd><kbd>1–4</kbd></dd></div>
          <div><dt>Drop weapon</dt><dd><kbd>G</kbd></dd></div>
          <div><dt>Scope zoom</dt><dd><kbd>Q / E / Wheel</kbd></dd></div>
          ${copy.missionPage === false ? '' : '<div><dt>Mission map</dt><dd><kbd>M</kbd></dd></div>'}
          <div><dt>Pause</dt><dd><kbd>Esc</kbd></dd></div>
          ${(copy.controls ?? []).map(([action, key]) => `<div><dt>${action}</dt><dd><kbd>${key}</kbd></dd></div>`).join('')}
        </dl>
      </section>
      <section data-menu-page="settings" hidden>
        ${back}
        <h2 id="settings-page-title">Settings</h2>
        <div class="settings-groups">
          <fieldset class="settings-group mission-settings"><legend>Game</legend></fieldset>
          <fieldset class="settings-group"><legend>Look</legend>
            ${slider('settings-fov', 'Field of view', SETTING_LIMITS.fov.min, SETTING_LIMITS.fov.max, SETTING_LIMITS.fov.step)}
            ${slider('settings-sensitivity', 'Mouse sensitivity', SETTING_LIMITS.sensitivity.min, SETTING_LIMITS.sensitivity.max, SETTING_LIMITS.sensitivity.step)}
            ${slider('settings-ads', 'Aiming sensitivity', SETTING_LIMITS.adsSensitivity.min, SETTING_LIMITS.adsSensitivity.max, SETTING_LIMITS.adsSensitivity.step)}
            ${slider('settings-controller', 'Controller sensitivity', SETTING_LIMITS.controllerSensitivity.min, SETTING_LIMITS.controllerSensitivity.max, SETTING_LIMITS.controllerSensitivity.step)}
            ${toggle('settings-invert-y', 'Invert Y (controller)', getSettings().invertY)}
          </fieldset>
          <fieldset class="settings-group"><legend>Graphics</legend>
            <div class="settings-row">
              <span id="settings-quality-label">Quality</span>
              <div class="settings-segments" role="radiogroup" aria-labelledby="settings-quality-label">
                ${(Object.keys(QUALITY) as Quality[]).map(q => `<button type="button" role="radio" data-quality="${q}">${QUALITY[q].label}</button>`).join('')}
              </div>
              <output id="settings-quality-value"></output>
            </div>
            <div class="settings-row">
              <span id="settings-blood-label">Blood</span>
              <div class="settings-segments" role="radiogroup" aria-labelledby="settings-blood-label">
                ${(Object.keys(BLOOD_LABELS) as Blood[]).map(b => `<button type="button" role="radio" data-blood="${b}">${BLOOD_LABELS[b]}</button>`).join('')}
              </div>
            </div>
            ${toggle('mission-motion', 'Reduced motion', reducedMotion)}
          </fieldset>
          <fieldset class="settings-group"><legend>Audio</legend>
            ${slider('mission-volume', 'Master volume', 0, 100, 1)}
            ${music ? slider('settings-music', 'Music', 0, 100, 1) : ''}
            ${slider('settings-effects', 'Effects', 0, 100, 1)}
            ${toggle('mission-mute', 'Mute', getSettings().muted)}
          </fieldset>
        </div>
      </section>
      <section data-menu-page="vr" hidden>
        ${back}
        <h2 id="vr-page-title">Explore in VR</h2>
        <p>Walk through the compound with your headset. Your mission stays paused.</p>
        <div class="mission-vr-slot"></div>
      </section>
      <section data-menu-page="restart" hidden>
        ${back}
        <h2 id="restart-page-title">Start over?</h2>
        <p>${copy.restartWarning ?? 'Your current mission progress will be reset.'}</p>
        <div class="mission-actions">
          <button id="mission-cancel-restart" class="menu-primary">Cancel</button>
          <button id="mission-confirm-restart" class="menu-secondary">${copy.restart}</button>
        </div>
      </section>
      ${copy.gameOver ? `<section data-menu-page="gameover" hidden>
        <h2 id="gameover-page-title">${copy.deadTitle}</h2>
        <div class="menu-gameover-body"></div>
        <div class="menu-gameover-actions">
          <button id="menu-play-again" class="menu-primary">Play again</button>
          <button id="menu-main-menu" class="menu-secondary">Main menu</button>
        </div>
      </section>` : ''}
      ${(copy.pages ?? []).map(page => `<section data-menu-page="${page.id}" hidden>
        ${back}
        <h2 id="${page.id}-page-title">${page.title}</h2>
        <div class="menu-extra-page"></div>
      </section>`).join('')}`
    this.card.querySelector('.mission-start-slot')!.append(start)
    // Move the existing controls so the WebXR click handler keeps the browser's
    // user activation and session lifecycle, inside the same menu.
    this.card.querySelector('.mission-vr-slot')!.append(document.querySelector('#vr-panel')!)
    for (const page of copy.pages ?? []) page.build(this.element(`[data-menu-page="${page.id}"] .menu-extra-page`))
    if (copy.home) copy.home(this.element('.menu-home-extra'))
    if (copy.gameOver) copy.gameOver.build(this.element('.menu-gameover-body'))
    this.title = this.element('#mission-menu-title')
    this.premise = this.element('#mission-premise')
    this.retry = this.element('#mission-retry')
    this.restart = this.element('#mission-restart')
    this.playAgain = this.card.querySelector('#menu-play-again')
    const options = { signal: this.abort.signal }
    this.card.querySelectorAll<HTMLElement>('[data-menu-open]').forEach(button => {
      button.addEventListener('click', () => this.show(button.dataset.menuOpen as MenuPage, button), options)
    })
    this.card.querySelectorAll('[data-menu-back]').forEach(button => {
      button.addEventListener('click', () => this.back(), options)
    })
    this.card.querySelector<HTMLElement>('[data-mode-href]')?.addEventListener('click', event => {
      location.href = (event.currentTarget as HTMLElement).dataset.modeHref!
    }, options)
    const retry = () => { this.mainMenu = false; callbacks.retry() }
    this.retry.addEventListener('click', retry, options)
    this.playAgain?.addEventListener('click', retry, options)
    this.card.querySelector('#menu-main-menu')?.addEventListener('click', () => this.toMainMenu(), options)
    this.restart.addEventListener('click', () => {
      if (this.phase === 'complete') callbacks.restart()
      else this.show('restart', this.restart)
    }, options)
    this.element('#mission-confirm-restart').addEventListener('click', callbacks.restart, options)
    this.element('#mission-cancel-restart').addEventListener('click', () => this.back(), options)
    this.bindSettings(reducedMotion)
    window.addEventListener('keydown', this.keyDown, { ...options, capture: true })
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string) { return this.card.querySelector<T>(selector)! }

  /**
   * The Settings page edits the shared settings store (src/game/settings.ts). Master volume, mute and
   * reduced motion keep the ids the HUD listens to; once the HUD has wired them (right after this
   * constructor), the stored values are sent through them so audio and motion start as the player left them.
   */
  private bindSettings(systemReducedMotion: boolean) {
    const options = { signal: this.abort.signal }
    const settings = getSettings()
    for (const { id, key, format } of SLIDERS) {
      const input = this.card.querySelector<HTMLInputElement>(`#${id}`)
      if (!input) continue
      const output = this.element(`#${id}-value`)
      input.value = String(settings[key]); output.textContent = format(settings[key])
      input.addEventListener('input', () => {
        const value = Number(input.value)
        output.textContent = format(value)
        setSettings({ [key]: value } as Partial<Settings>)
      }, options)
    }
    const qualityOutput = this.element('#settings-quality-value')
    const renderQuality = () => {
      const quality = getSettings().quality
      this.card.querySelectorAll<HTMLElement>('[data-quality]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.quality === quality)))
      qualityOutput.textContent = QUALITY[quality].blurb
    }
    this.card.querySelectorAll<HTMLElement>('[data-quality]').forEach(button => button.addEventListener('click', () => {
      setSettings({ quality: button.dataset.quality as Quality }); renderQuality()
    }, options))
    renderQuality()
    const renderBlood = () => {
      const blood = getSettings().blood
      this.card.querySelectorAll<HTMLElement>('[data-blood]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.blood === blood)))
    }
    this.card.querySelectorAll<HTMLElement>('[data-blood]').forEach(button => button.addEventListener('click', () => {
      setSettings({ blood: button.dataset.blood as Blood }); renderBlood()
    }, options))
    renderBlood()
    const invertY = this.element<HTMLInputElement>('#settings-invert-y')
    invertY.addEventListener('change', () => setSettings({ invertY: invertY.checked }), options)
    const mute = this.element<HTMLInputElement>('#mission-mute'), motion = this.element<HTMLInputElement>('#mission-motion')
    mute.addEventListener('change', () => setSettings({ muted: mute.checked }), options)
    motion.addEventListener('change', () => setSettings({ reducedMotion: motion.checked }), options)
    const wanted = prefersReducedMotion(settings)
    queueMicrotask(() => {
      if (this.abort.signal.aborted) return
      this.element('#mission-volume').dispatchEvent(new Event('input', { bubbles: true }))
      if (mute.checked) mute.dispatchEvent(new Event('change', { bubbles: true }))
      if (wanted !== systemReducedMotion) { motion.checked = wanted; motion.dispatchEvent(new Event('change', { bubbles: true })) }
    })
  }

  private show(page: MenuPage, source?: HTMLElement, focus = true) {
    if (source) this.returnFocus = source
    this.page = page
    this.card.dataset.page = page
    this.card.querySelectorAll<HTMLElement>('[data-menu-page]').forEach(section => {
      section.hidden = section.dataset.menuPage !== page
      if (!section.hidden) section.scrollTop = 0
    })
    this.card.setAttribute('aria-labelledby', page === 'home' ? 'mission-menu-title' : `${page}-page-title`)
    this.pause.scrollTop = 0
    this.copy.pages?.find(extra => extra.id === page)?.show?.()
    if (focus) {
      if (page === 'home') this.focusPrimary()
      else if (page === 'gameover') this.playAgain?.focus({ preventScroll: true })
      else this.element<HTMLButtonElement>(`[data-menu-page="${page}"] ${page === 'restart' ? '#mission-cancel-restart' : '[data-menu-back]'}`).focus({ preventScroll: true })
    }
  }

  private back() {
    // Leaving the game-over summary is the Main menu.
    if (this.page === 'gameover') { this.toMainMenu(); return }
    this.show('home', undefined, false)
    if (this.returnFocus && !this.returnFocus.hidden) this.returnFocus.focus({ preventScroll: true })
    else this.focusPrimary()
    this.returnFocus = null
  }

  /** From the game-over page to the title screen, where Start begins a new game. */
  private toMainMenu() {
    this.mainMenu = true
    this.returnFocus = null
    this.show('home', undefined, false)
    // The game has stopped rendering by now, so refresh the page here rather than wait for a frame.
    if (this.last) this.update(this.last.state, this.last.data)
    this.focusPrimary()
  }

  /** The title screen (mode cards, the mode's record): before the first game, and Main menu after a game over. */
  private get titleScreen() { return (!this.hasPlayed && this.phase === 'active') || (this.mainMenu && this.phase === 'dead') }

  showMap() { this.returnFocus = null; this.show('mission') }
  setPlaying(playing: boolean) {
    if (playing) {
      this.hasPlayed = true
      this.returnFocus = null
      this.card.dataset.title = 'false'
      this.show('home', undefined, false)
    } else if (this.wasPlaying) {
      this.show('home', undefined, false)
      this.focusPrimary()
    }
    this.wasPlaying = playing
  }
  focusPrimary() {
    const primary = this.page === 'gameover' && this.playAgain ? this.playAgain
      : this.phase === 'dead' ? this.retry : this.phase === 'complete' ? this.restart : this.start
    if (!this.pause.hidden && !this.pause.inert && !primary.hidden && !primary.disabled) primary.focus({ preventScroll: true })
  }
  ready() { this.loaded = true; this.start.disabled = false; this.start.textContent = this.copy.begin; if (this.page === 'home') this.focusPrimary() }
  error(message: string) { this.loadError = message; this.start.textContent = 'Unable to load'; this.start.disabled = true; this.show('home'); this.showError() }
  private showError() { const debrief = this.element('#mission-debrief'); debrief.hidden = false; delete debrief.dataset.summary; debrief.textContent = this.loadError }
  reset() { this.phase = 'active'; this.loadError = ''; this.mainMenu = false; this.show('home', undefined, false) }

  update(state: MenuState, data: { playing: boolean; enabled: boolean; ready: boolean }) {
    this.last = { state, data }
    if (data.playing) {
      this.hasPlayed = true
      if (!this.wasPlaying) this.show('home', undefined, false)
      this.wasPlaying = true
      this.card.dataset.title = 'false'
      return
    }
    const justPaused = this.wasPlaying
    this.wasPlaying = false
    if (this.phase !== state.phase) {
      this.phase = state.phase
      this.mainMenu = false
      if (state.phase === 'dead' && this.copy.gameOver) {
        this.show('gameover', undefined, false)
        this.copy.gameOver.show(state)
      } else this.show('home', undefined, false)
    }
    const dead = state.phase === 'dead', complete = state.phase === 'complete', title = this.titleScreen
    this.card.dataset.title = String(title)
    this.title.textContent = title ? this.copy.title : dead ? this.copy.deadTitle : complete ? this.copy.completeTitle : this.hasPlayed ? 'Paused.' : this.copy.title
    this.premise.hidden = dead && !title && !this.copy.deadPremise
    this.premise.textContent = title ? this.copy.premise : dead && this.copy.deadPremise ? this.copy.deadPremise(state) : complete ? this.copy.completePremise : this.hasPlayed ? this.copy.objective(state) : this.copy.premise
    this.start.hidden = dead || complete
    this.start.disabled = !data.ready || !this.loaded
    if (!this.loadError && this.loaded) this.start.textContent = this.hasPlayed ? this.copy.resume : this.copy.begin
    this.retry.hidden = !dead
    this.retry.disabled = !data.ready
    this.retry.textContent = title ? this.copy.begin : 'Try again'
    this.restart.hidden = dead || (!complete && !this.hasPlayed)
    this.restart.disabled = !data.ready
    this.restart.className = complete ? 'menu-primary' : 'menu-quiet'
    this.restart.textContent = complete ? 'Play again' : this.copy.restart
    if (this.playAgain) this.playAgain.disabled = !data.ready
    const debrief = this.element('#mission-debrief')
    debrief.hidden = !complete
    if (complete) {
      const time = `${Math.floor(state.elapsed / 60)}:${String(Math.floor(state.elapsed % 60)).padStart(2, '0')}`
      const health = Math.ceil(Math.max(0, Math.min(100, state.health)))
      const summary = `${time}|${state.kills}|${health}`
      if (debrief.dataset.summary !== summary) {
        debrief.dataset.summary = summary
        const rows: [string, string][] = this.copy.recap?.(state) ?? [['Time', time], ['Kills', String(state.kills)], ['Health', `${health}%`]]
        debrief.innerHTML = `<dl class="mission-recap" aria-label="Mission recap">
          ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
        </dl>`
      }
    }
    if (this.loadError) this.showError()
    this.element('#mission-current-objective').textContent = this.copy.objective(state)
    if (data.enabled && ((justPaused && !dead) || complete) && this.page === 'home' && !this.card.contains(document.activeElement)) this.focusPrimary()
  }

  private keyDown = (event: KeyboardEvent) => {
    if (this.pause.hidden || this.pause.inert || document.querySelector<HTMLElement>('#walk-hud')!.hidden || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.repeat) return
      if (this.page !== 'home') this.back()
      else if (this.hasPlayed && this.phase === 'active') this.start.click()
      return
    }
    // M is the mission map; modes without the map page (Dead Ink) leave the key alone.
    if (event.code === 'KeyM' && (this.page === 'home' || this.page === 'mission') && this.copy.missionPage !== false) {
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.repeat) return
      if (this.page === 'home') this.showMap()
      else if (this.hasPlayed && this.phase === 'active') this.start.click()
      else this.back()
      return
    }
    // Tab cycles through every control, the other mode's card included; the arrow keys walk the buttons.
    const focusables = Array.from(this.card.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]'))
      .filter(el => el.getClientRects().length > 0)
    if (event.key === 'Tab') {
      const index = focusables.indexOf(document.activeElement as HTMLElement)
      if (index === -1 || (event.shiftKey ? index === 0 : index === focusables.length - 1)) {
        event.preventDefault(); focusables[event.shiftKey ? focusables.length - 1 : 0]?.focus()
      }
    } else if (['ArrowUp', 'ArrowDown'].includes(event.key) && ['home', 'restart', 'gameover'].includes(this.page)) {
      const buttons = focusables.filter(el => el.tagName === 'BUTTON')
      const index = buttons.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }

  dispose() { this.abort.abort(); this.card.classList.remove('menu-card'); this.pause.classList.remove('menu-host') }
}
