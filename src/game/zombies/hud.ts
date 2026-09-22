import './zombies.css'

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
  private floaters: Floater[] = []
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
    this.root.append(this.roundEl, this.pointsEl, this.banner)
    parent.append(this.root)
  }

  /** Big red announcement in the middle of the screen, e.g. "Round 3". */
  announce(text: string, seconds = 3) {
    this.banner.textContent = text
    this.banner.classList.add('show')
    this.bannerTime = seconds
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
    this.shownRound = -1
    this.shownPoints = -1
  }

  dispose() { this.clear(); this.root.remove() }
}
