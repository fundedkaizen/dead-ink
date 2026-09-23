import './zombies.css'
import type { PowerupKind } from './rules'
import { POWERUP_INFO, powerupIcon } from './powerups'
import { PERKS, perkIcon, type PerkKind } from './perks'

/**
 * Dead Ink's own HUD, on top of the shared mission HUD (health, magazine) and combat HUD (hit markers,
 * damage arcs, hotbar): the round counter, points, and round announcements.
 *
 * The round counter is Call of Duty's: tally marks for rounds 1 to 5, then numerals, in red, because red
 * is the colour of danger and the round number IS the danger level.
 */
export function tallySvg(round: number) {
  const strokes: string[] = []
  const n = Math.min(5, Math.max(0, round))
  for (let i = 0; i < Math.min(4, n); i++) {
    const x = 10 + i * 13, lean = (i % 2 ? 1.5 : -1.2)
    strokes.push(`<path d="M${x} 8 Q${x + lean} 30 ${x - lean * 0.5} 54" />`)
  }
  if (n === 5) strokes.push('<path d="M3 44 Q30 30 58 16" />')
  return `<svg viewBox="0 0 62 62" aria-hidden="true">${strokes.join('')}</svg>`
}

type Floater = { element: HTMLElement; age: number }

export class ZombieHud {
  readonly root = document.createElement('div')
  private roundEl = document.createElement('div')
  private pointsEl = document.createElement('div')
  private pointsValue = document.createElement('strong')
  private banner = document.createElement('div')
  private powerupsEl = document.createElement('div')
  private powerupCells = new Map<PowerupKind, { cell: HTMLElement; time: HTMLElement }>()
  private perksEl = document.createElement('div')
  private grenadesEl = document.createElement('div')
  private partsEl = document.createElement('div')
  private questEl = document.createElement('div')
  private scoresEl = document.createElement('div')
  private shownScores = ''
  private shownQuest = ''
  private shownBossLabel = 'THE BRUTE'
  private shieldEl = document.createElement('div')
  private shownParts = ''
  private shownShield = -2
  private shownGrenades = -1
  private bossEl = document.createElement('div')
  private bossFill = document.createElement('div')
  private shownBoss = -1
  private shownPerks = ''
  private floaters: Floater[] = []
  private flashTimer = 0
  private reviveTimer = 0
  private shownRound = -1
  private shownPoints = -1
  private bannerTime = 0

  constructor(parent: HTMLElement) {
    this.root.className = 'dead-ink-hud'
    this.roundEl.className = 'dead-ink-round'
    this.roundEl.setAttribute('role', 'status')
    this.pointsEl.className = 'dead-ink-points'
    this.pointsEl.append(this.pointsValue)
    this.banner.className = 'dead-ink-banner'
    this.banner.setAttribute('role', 'status')
    this.powerupsEl.className = 'dead-ink-powerups'
    this.perksEl.className = 'dead-ink-perks'
    this.perksEl.setAttribute('aria-label', 'Perks')
    this.bossEl.className = 'dead-ink-boss'
    this.bossEl.setAttribute('role', 'meter')
    this.bossEl.innerHTML = '<span>THE BRUTE</span><div class="dead-ink-boss-bar"></div>'
    this.bossEl.querySelector('.dead-ink-boss-bar')!.append(this.bossFill)
    this.bossEl.hidden = true
    this.grenadesEl.className = 'dead-ink-grenades'
    this.grenadesEl.setAttribute('role', 'status')
    this.pointsEl.append(this.grenadesEl)
    this.partsEl.className = 'dead-ink-parts'
    this.partsEl.setAttribute('role', 'status')
    this.shieldEl.className = 'dead-ink-shield'
    this.shieldEl.setAttribute('role', 'meter')
    this.shieldEl.innerHTML = '<svg viewBox="0 0 24 28" aria-hidden="true"><path d="M12 1 L22 5 V13 C22 20 17 25 12 27 C7 25 2 20 2 13 V5 Z"/></svg><i><b></b></i>'
    this.shieldEl.hidden = true
    this.questEl.className = 'dead-ink-quest'
    this.questEl.setAttribute('role', 'status')
    this.scoresEl.className = 'dead-ink-scores'
    this.scoresEl.setAttribute('role', 'status')
    this.scoresEl.hidden = true
    this.root.append(this.partsEl, this.shieldEl, this.questEl, this.scoresEl)
    this.root.append(this.roundEl, this.pointsEl, this.banner, this.powerupsEl, this.perksEl, this.bossEl)
    parent.append(this.root)
  }

  /** Big announcement in the middle of the screen: red for rounds ("Round 3"), green for power-ups. */
  announce(text: string, seconds = 3, tone: 'danger' | 'powerup' | string = 'danger') {
    this.banner.textContent = text
    this.banner.classList.toggle('powerup', tone === 'powerup')
    // Any other tone is a colour: a perk announces itself in its own.
    this.banner.style.color = tone === 'danger' || tone === 'powerup' ? '' : tone
    this.banner.classList.add('show')
    this.bannerTime = seconds
  }

  /** The timed power-ups running now, each with its icon and seconds left; blinking near the end. */
  powerups(active: readonly { kind: PowerupKind; left: number }[]) {
    for (const [kind, { cell }] of this.powerupCells) {
      if (active.some(a => a.kind === kind)) continue
      cell.remove(); this.powerupCells.delete(kind)
    }
    for (const { kind, left } of active) {
      let entry = this.powerupCells.get(kind)
      if (!entry) {
        const cell = document.createElement('div'), image = document.createElement('img'), time = document.createElement('span')
        cell.className = 'dead-ink-powerup'
        image.src = powerupIcon(kind).toDataURL()
        image.alt = POWERUP_INFO[kind].label
        cell.append(image, time)
        this.powerupsEl.append(cell)
        entry = { cell, time }
        this.powerupCells.set(kind, entry)
      }
      entry.time.textContent = String(Math.ceil(left))
      entry.cell.classList.toggle('ending', left < 5)
    }
  }

  /** Your perks, as badges in their colours, bottom left above your health. */
  perks(kinds: readonly PerkKind[]) {
    const key = kinds.join(',')
    if (key === this.shownPerks) return
    this.shownPerks = key
    this.perksEl.replaceChildren(...kinds.map(kind => {
      const image = document.createElement('img')
      image.src = perkIcon(kind).toDataURL()
      image.alt = image.title = PERKS[kind].name
      return image
    }))
  }

  /** Grenades you are carrying, as little ink frags beside your points. */
  grenades(count: number, dolls = 0) {
    if (count * 10 + dolls === this.shownGrenades) return
    this.shownGrenades = count * 10 + dolls
    const frag = '<svg viewBox="0 0 20 24" aria-hidden="true"><rect x="7" y="1" width="6" height="4" rx="1"/><path d="M13 4 L17 9" /><ellipse cx="10" cy="14" rx="7" ry="8.5"/><line x1="3" y1="14" x2="17" y2="14" class="band"/></svg>'
    // The Ink Doll: a round head in a fez on a little body, cymbals out.
    const doll = '<svg class="doll" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="1" width="6" height="4" class="fez"/><circle cx="12" cy="9" r="4.5" class="face"/><rect x="8" y="14" width="8" height="9" class="face"/><line x1="2" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="22" y2="16"/></svg>'
    this.grenadesEl.innerHTML = frag.repeat(Math.max(0, count)) + doll.repeat(Math.max(0, dolls))
    const dollText = dolls ? `, ${dolls} ink doll${dolls === 1 ? '' : 's'}` : ''
    this.grenadesEl.setAttribute('aria-label', `${count} grenade${count === 1 ? '' : 's'}${dollText}`)
  }

  /** The buildable parts you are carrying, as small ink tags by the perks. */
  parts(labels: string[]) {
    const key = labels.join('|')
    if (key === this.shownParts) return
    this.shownParts = key
    this.partsEl.innerHTML = labels.map(label => `<span>${label.replace(/[<>&"]/g, '')}</span>`).join('')
    this.partsEl.setAttribute('aria-label', labels.length ? `Carrying ${labels.join(', ')}` : 'No parts')
  }

  /** Co-op: every player's points stacked by your own, Call of Duty style; null hides it (solo). */
  scoreboard(rows: { name: string; points: number; me: boolean; down: boolean }[] | null) {
    const key = rows ? rows.map(r => `${r.name}:${r.points}:${r.me}:${r.down}`).join('|') : ''
    if (key === this.shownScores) return
    this.shownScores = key
    this.scoresEl.hidden = !rows
    if (!rows) return
    const clean = (text: string) => text.replace(/[<>&"]/g, '')
    this.scoresEl.innerHTML = rows.map(r => `<div class="${r.me ? 'me' : ''}${r.down ? ' down' : ''}"><span>${r.me ? '▸ ' : ''}${clean(r.name)}</span><strong>${r.points}</strong></div>`).join('')
  }

  /** The main quest's next step, a quiet line under the round; null hides it. */
  quest(text: string | null) {
    const shown = text ?? ''
    if (shown === this.shownQuest) return
    this.shownQuest = shown
    this.questEl.textContent = shown
    this.questEl.hidden = !text
  }

  /** The shield on your back and how much it has left; null hides it. */
  shield(fraction: number | null) {
    const shown = fraction === null ? -1 : Math.round(fraction * 100)
    if (shown === this.shownShield) return
    this.shownShield = shown
    this.shieldEl.hidden = fraction === null
    if (fraction === null) return
    ;(this.shieldEl.querySelector('b') as HTMLElement).style.width = `${Math.max(0, Math.min(100, shown))}%`
    this.shieldEl.setAttribute('aria-label', `Shield ${shown}%`)
  }

  /** The Brute's health across the top of the screen while it lives; null hides it. */
  boss(fraction: number | null, label = 'THE BRUTE') {
    if (label !== this.shownBossLabel) {
      this.shownBossLabel = label
      this.bossEl.querySelector('span')!.textContent = label
      this.shownBoss = -2
    }
    const shown = fraction === null ? -1 : Math.round(fraction * 200)
    if (shown === this.shownBoss) return
    this.shownBoss = shown
    this.bossEl.hidden = fraction === null
    if (fraction === null) return
    this.bossFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`
    this.bossEl.setAttribute('aria-label', `The Brute, ${Math.round(fraction * 100)}% health`)
  }

  /** The Nuke's blast: the page flashes to a negative for a moment. */
  flash() {
    document.body.dataset.deadInkNuke = 'true'
    this.flashTimer = 0.7
  }

  /** Second Draft: the world drains to grey while you are down, then floods back tinted blue. */
  revive() {
    document.body.dataset.deadInkRevive = 'true'
    this.reviveTimer = 2.4
  }

  /** A "+60" that pops beside the points and floats away. */
  gain(amount: number) {
    if (!(amount > 0)) return
    const element = document.createElement('span')
    element.className = 'dead-ink-gain'
    element.textContent = `+${amount}`
    this.pointsEl.append(element)
    this.floaters.push({ element, age: 0 })
  }

  /** A spend: shown briefly in red. */
  spend(amount: number) {
    if (!(amount > 0)) return
    const element = document.createElement('span')
    element.className = 'dead-ink-gain spend'
    element.textContent = `-${amount}`
    this.pointsEl.append(element)
    this.floaters.push({ element, age: 0 })
  }

  update(dt: number, round: number, points: number) {
    if (round !== this.shownRound) {
      this.shownRound = round
      this.roundEl.innerHTML = round <= 0 ? '' : round <= 5 ? tallySvg(round) : `<span>${round}</span>`
      this.roundEl.setAttribute('aria-label', round > 0 ? `Round ${round}` : 'Get ready')
    }
    if (points !== this.shownPoints) {
      this.shownPoints = points
      this.pointsValue.textContent = String(points)
      this.pointsEl.setAttribute('aria-label', `${points} points`)
    }
    if (this.bannerTime > 0) {
      this.bannerTime -= dt
      if (this.bannerTime <= 0) this.banner.classList.remove('show')
    }
    if (this.flashTimer > 0) {
      this.flashTimer -= dt
      if (this.flashTimer <= 0) delete document.body.dataset.deadInkNuke
    }
    if (this.reviveTimer > 0) {
      this.reviveTimer -= dt
      if (this.reviveTimer <= 0) delete document.body.dataset.deadInkRevive
    }
    for (const floater of this.floaters) {
      floater.age += dt
      floater.element.style.transform = `translateY(${-floater.age * 40}px)`
      floater.element.style.opacity = String(Math.max(0, 1 - floater.age / 1.1))
    }
    for (const floater of this.floaters.filter(f => f.age >= 1.1)) floater.element.remove()
    this.floaters = this.floaters.filter(f => f.age < 1.1)
  }

  clear() {
    for (const floater of this.floaters) floater.element.remove()
    this.floaters = []
    this.banner.classList.remove('show')
    this.bannerTime = 0
    this.powerups([])
    this.perks([])
    this.boss(null)
    this.shownGrenades = -1
    this.flashTimer = 0
    delete document.body.dataset.deadInkNuke
    this.reviveTimer = 0
    delete document.body.dataset.deadInkRevive
    this.shownRound = -1
    this.shownPoints = -1
  }

  dispose() { this.clear(); this.root.remove() }
}
