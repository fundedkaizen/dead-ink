import '../menu-skin.css'
import './armory.css'
import { RARITIES, RARITY_INFO } from '../../loot'
import type { MenuExtraPage } from '../../menu'
import type { WeaponName } from '../../types'
import { playReelTick, playReelWin, synthContext } from '../../ui-slot-sound'
import { tallySvg } from '../hud'
import { CATALOGUE, cosmeticKey, type CamoId, type ChallengeCamoId, type CosmeticItem, type CosmeticKind, type EquippedCosmetics } from './catalogue'
import { ACCOUNT_CHALLENGES, CHALLENGE_WEAPONS, WEAPON_LABELS, WEAPON_TIERS, accountProgress, masteredCount, tierProgress, weaponMastered, type ChallengeState } from './challenges'
import { camoSwatch, cosmeticIcon } from './icons'
import { CASE, CASE_WEIGHTS, casePool, equippedCosmetics, loadProfile, onProfileChange, openCase, ownsCamo, toggleEquip, type Profile } from './profile'

/**
 * The Armory page of the Dead Ink menu (open cases, wear what you own) and the home page's record of
 * your last game. Pure DOM; the viewmodel learns about changes through installCosmetics.
 */

type Tab = CosmeticKind | 'challenges'
const KINDS: { kind: Tab; label: string }[] = [
  { kind: 'watch', label: 'Watches' }, { kind: 'charm', label: 'Charms' }, { kind: 'camo', label: 'Camos' }, { kind: 'knife', label: 'Knives' },
  { kind: 'challenges', label: 'Challenges' },
]
const GUNS: { name: WeaponName; label: string }[] = [
  { name: 'pistol', label: 'Pistol' }, { name: 'smg', label: 'SMG' }, { name: 'ak', label: 'AK' }, { name: 'shotgun', label: 'Shotgun' }, { name: 'sniper', label: 'Sniper' },
  { name: 'magnum', label: 'Magnum' }, { name: 'lmg', label: 'LMG' },
]
const TILE = 120
const reducedMotion = () => document.body.dataset.reducedMotion === 'true'
const ink = (value: number) => value.toLocaleString('en-GB')
const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const number = (value: number) => value.toLocaleString('en-GB')

/** What unlocks a challenge camo on a gun, for its locked tile: "Tier 2: 100 headshot kills". */
function unlockHint(camo: ChallengeCamoId) {
  if (camo === 'diamond') return 'Tier 4 on every gun'
  const tier = WEAPON_TIERS.find(t => t.camo === camo)!
  return `Tier ${tier.tier}: ${tier.label(tier.goal)}`
}

/** A progress bar: ink fill on paper, the count beside it. `aria` names what it measures. */
function bar(value: number, goal: number, aria: string, done: boolean) {
  const pct = goal ? Math.min(100, value / goal * 100) : 0
  return `<span class="challenge-bar${done ? ' done' : ''}" role="progressbar" aria-label="${escape(aria)}" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${value}">
    <i style="width:${pct.toFixed(1)}%"></i></span><span class="challenge-count">${done ? 'Done' : `${number(value)} / ${number(goal)}`}</span>`
}

/** The Challenges tab: the chosen gun's four tiers, Diamond, and the account challenges that pay Ink. */
function challengesHtml(state: ChallengeState, gun: WeaponName) {
  const tiers = WEAPON_TIERS.map(tier => {
    const p = tierProgress(state, gun, tier)
    const status = p.done ? 'done' : p.blocked ? 'blocked' : 'open'
    return `<li class="challenge-row" data-status="${status}">
      <span class="challenge-swatch${p.done ? '' : ' locked'}">${camoSwatch(tier.camo)}</span>
      <span class="challenge-text"><b>Tier ${tier.tier} · ${escape(CATALOGUE.find(i => i.id === `camo:${tier.camo}`)!.name)}</b>
        <small>${escape(tier.label(tier.goal))}${p.blocked && !p.done ? ` · after Tier ${tier.tier - 1}` : ''}</small></span>
      <span class="challenge-progress">${bar(p.value, p.goal, `${WEAPON_LABELS[gun]} tier ${tier.tier}`, p.done)}</span>
    </li>`
  }).join('')
  const mastered = masteredCount(state), all = CHALLENGE_WEAPONS.length
  const diamondDone = state.done.includes('diamond')
  const pips = CHALLENGE_WEAPONS.map(name => `<i class="${weaponMastered(state, name) ? 'on' : ''}" title="${WEAPON_LABELS[name]}${weaponMastered(state, name) ? ': mastered' : ''}"></i>`).join('')
  const account = ACCOUNT_CHALLENGES.map(challenge => {
    const p = accountProgress(state, challenge)
    return `<li class="challenge-row account" data-status="${p.done ? 'done' : 'open'}">
      <span class="challenge-text"><b>${escape(challenge.title)}</b><small>${escape(challenge.label)}</small></span>
      <span class="challenge-reward">+${number(challenge.ink)} Ink</span>
      <span class="challenge-progress">${bar(p.value, p.goal, challenge.label, p.done)}</span>
    </li>`
  }).join('')
  return `<ol class="challenge-list" aria-label="${WEAPON_LABELS[gun]} camo challenges">${tiers}</ol>
    <div class="challenge-diamond${diamondDone ? ' done' : ''}">
      <span class="challenge-swatch${diamondDone ? '' : ' locked'}">${camoSwatch('diamond')}</span>
      <span class="challenge-text"><b>Diamond</b><small>Finish Tier 4 on every gun. Diamond then works on all of them.</small></span>
      <span class="challenge-pips" role="img" aria-label="${mastered} of ${all} guns mastered">${pips}<em>${mastered} / ${all}</em></span>
    </div>
    <h3 class="challenge-heading">Account</h3>
    <ol class="challenge-list">${account}</ol>`
}

function isEquipped(item: CosmeticItem, equipped: EquippedCosmetics, gun: WeaponName) {
  const key = cosmeticKey(item.id)
  if (item.kind === 'watch') return equipped.watch === key
  if (item.kind === 'charm') return equipped.charm === key
  if (item.kind === 'knife') return equipped.knife === key
  return equipped.camos[gun] === key
}

const tile = (item: CosmeticItem) => `<div class="armory-tile" style="--rarity:${RARITY_INFO[item.rarity].css}">
  ${cosmeticIcon(item)}<span>${escape(item.name)}</span></div>`

/** Share of each rarity in a case, for the odds line under the case. */
function odds() {
  const present = RARITIES.filter(rarity => casePool().some(entry => entry.rarity === rarity))
  const total = present.reduce((sum, rarity) => sum + CASE_WEIGHTS[rarity], 0)
  return present.map(rarity => `<span style="--rarity:${RARITY_INFO[rarity].css}">${RARITY_INFO[rarity].label} ${(CASE_WEIGHTS[rarity] / total * 100).toFixed(CASE_WEIGHTS[rarity] / total < 0.1 ? 1 : 0)}%</span>`).join('')
}

class Armory {
  private body!: HTMLElement
  private kind: Tab = 'watch'
  private gun: WeaponName = 'ak'
  private spinning = false
  private strip!: HTMLElement
  private reel!: HTMLElement
  private result!: HTMLElement
  private openButton!: HTMLButtonElement
  private balance!: HTMLElement

  build(body: HTMLElement) {
    this.body = body
    body.classList.add('armory')
    body.innerHTML = `
      <div class="armory-bank">
        <span class="armory-ink"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c3 5 7 9 7 13a7 7 0 0 1-14 0c0-4 4-8 7-13z" fill="currentColor"/></svg>
          <strong></strong> Ink</span>
        <small>Earned every game: 10 a round, 1 a kill, 2 a headshot.</small>
      </div>
      <section class="armory-case" aria-label="${CASE.name}">
        <div class="armory-case-head">
          <div><h3>${CASE.name}</h3><p class="armory-odds">${odds()}</p></div>
          <button class="armory-open" type="button">Open · ${CASE.price} Ink</button>
        </div>
        <div class="armory-reel" hidden><div class="armory-strip"></div><i class="armory-marker" aria-hidden="true"></i></div>
        <p class="armory-result" role="status"></p>
      </section>
      <div class="armory-tabs" role="tablist">${KINDS.map(({ kind, label }) => `<button type="button" role="tab" data-kind="${kind}">${label}</button>`).join('')}</div>
      <div class="armory-guns" hidden>${GUNS.map(({ name, label }) => `<button type="button" data-gun="${name}">${label}</button>`).join('')}</div>
      <p class="armory-hint"></p>
      <div class="armory-grid"></div>
      <div class="armory-challenges" hidden></div>`
    this.strip = body.querySelector('.armory-strip')!
    this.reel = body.querySelector('.armory-reel')!
    this.result = body.querySelector('.armory-result')!
    this.openButton = body.querySelector('.armory-open')!
    this.balance = body.querySelector('.armory-ink strong')!
    this.openButton.addEventListener('click', () => this.open())
    body.querySelectorAll<HTMLElement>('[data-kind]').forEach(button => button.addEventListener('click', () => { this.kind = button.dataset.kind as Tab; this.render() }))
    body.querySelectorAll<HTMLElement>('[data-gun]').forEach(button => button.addEventListener('click', () => { this.gun = button.dataset.gun as WeaponName; this.render() }))
    body.querySelector('.armory-grid')!.addEventListener('click', event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-item]')
      if (card && !card.hasAttribute('aria-disabled')) toggleEquip(card.dataset.item!, this.gun)
    })
    onProfileChange(() => this.render())
    this.render()
  }

  render() {
    if (!this.body) return
    const profile = loadProfile()
    this.balance.textContent = ink(profile.ink)
    this.openButton.disabled = this.spinning || profile.ink < CASE.price
    this.openButton.title = profile.ink < CASE.price ? `You need ${CASE.price - profile.ink} more Ink` : ''
    this.body.querySelectorAll<HTMLElement>('[data-kind]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.kind === this.kind)))
    const guns = this.body.querySelector<HTMLElement>('.armory-guns')!
    guns.hidden = this.kind !== 'camo' && this.kind !== 'challenges'
    guns.querySelectorAll<HTMLElement>('[data-gun]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.gun === this.gun))
      button.classList.toggle('mastered', weaponMastered(profile.challenges, button.dataset.gun as WeaponName))
    })
    this.body.querySelector('.armory-hint')!.textContent = this.kind === 'camo'
      ? 'A camo covers one gun type. Challenge camos are earned per gun. Pack-a-Punched guns wear the Pack-a-Punch camo.'
      : this.kind === 'challenges' ? `Each gun's tiers unlock a camo for that gun, in order. Tier 4 on all ${CHALLENGE_WEAPONS.length} guns unlocks Diamond.`
      : this.kind === 'knife' ? 'Your knife slashes with V and shows off when you stand still.' : 'Click something you own to wear it; click again to take it off.'
    const grid = this.body.querySelector<HTMLElement>('.armory-grid')!, challenges = this.body.querySelector<HTMLElement>('.armory-challenges')!
    grid.hidden = this.kind === 'challenges'
    challenges.hidden = this.kind !== 'challenges'
    if (this.kind === 'challenges') { challenges.innerHTML = challengesHtml(profile.challenges, this.gun); grid.innerHTML = ''; return }
    const items = CATALOGUE.filter(entry => entry.kind === this.kind)
    grid.innerHTML = items.map(item => {
      const key = cosmeticKey(item.id)
      const owned = item.kind === 'camo' ? ownsCamo(profile, key as CamoId, this.gun) : profile.owned.includes(item.id)
      const worn = owned && isEquipped(item, profile.equipped, this.gun)
      // A locked challenge camo says what earns it; a locked case item stays a mystery.
      const name = owned || item.challenge ? escape(item.name) : 'Locked'
      const line = !owned && item.challenge ? escape(unlockHint(key as ChallengeCamoId)) : `${RARITY_INFO[item.rarity].label}${worn ? ' · worn' : ''}`
      return `<button type="button" class="armory-item${worn ? ' worn' : ''}${item.challenge ? ' challenge' : ''}${key === 'diamond' ? ' diamond' : ''}" data-item="${item.id}" style="--rarity:${RARITY_INFO[item.rarity].css}"
        ${owned ? '' : 'aria-disabled="true"'} aria-pressed="${worn}" title="${escape(item.blurb)}">
        ${cosmeticIcon(item)}
        <span class="armory-name">${name}</span>
        <span class="armory-rarity">${line}</span>
      </button>`
    }).join('')
  }

  /** Spend the Ink, then let the strip run: fast at first, easing to a stop on the item already won. */
  private open() {
    if (this.spinning) return
    const opening = openCase()
    if (!opening) return
    this.spinning = true
    this.render()
    const { item, strip, winIndex, duplicate, refund } = opening
    this.reel.hidden = false
    this.reel.classList.remove('won')
    this.reel.style.setProperty('--rarity', RARITY_INFO[item.rarity].css)
    this.result.textContent = ''
    this.strip.innerHTML = strip.map(tile).join('')
    const width = this.reel.clientWidth || 600
    // Land somewhere inside the winning tile, not always dead centre, as a real reel would.
    const jitter = (Math.random() - 0.5) * TILE * 0.6
    const distance = winIndex * TILE + TILE / 2 - width / 2 + jitter
    const duration = reducedMotion() ? 350 : 5200
    // The Open click is the user gesture that lets the page make sound.
    synthContext()
    let ticking = true
    const finish = () => {
      ticking = false
      playReelWin(item.rarity)
      this.strip.style.transform = `translateX(${-distance}px)`
      this.strip.children[winIndex]?.classList.add('winner')
      this.reel.classList.add('won')
      const info = RARITY_INFO[item.rarity]
      this.result.innerHTML = `<strong style="color:${info.css}">${info.label}</strong> ${escape(item.name)}${duplicate ? ` · already yours, ${refund} Ink back` : ''}
        ${duplicate ? '' : '<button type="button" class="armory-equip">Wear it</button>'}`
      this.result.querySelector('.armory-equip')?.addEventListener('click', () => {
        if (!isEquipped(item, loadProfile().equipped, this.gun)) toggleEquip(item.id, this.gun)
        this.kind = item.kind
        this.render()
      })
      this.spinning = false
      this.render()
    }
    const animation = this.strip.animate?.([{ transform: 'translateX(0px)' }, { transform: `translateX(${-distance}px)` }],
      { duration, easing: 'cubic-bezier(0.06, 0.72, 0.14, 1)', fill: 'forwards' })
    if (animation) {
      animation.onfinish = finish
      this.tickReel(width, () => ticking)
    } else finish()
  }

  /**
   * A slot machine's click for every tile that slides under the marker, read off the strip as it
   * moves, so the ticks slow with the reel. At most one every 28 ms while the strip is a blur.
   */
  private tickReel(width: number, running: () => boolean) {
    let last = -1, lastX = 0, lastTime = performance.now(), lastTick = 0
    const frame = (now: number) => {
      if (!running()) return
      const x = -new DOMMatrixReadOnly(getComputedStyle(this.strip).transform).m41
      const tile = Math.floor((x + width / 2) / TILE)
      const speed = Math.abs(x - lastX) / Math.max(1, now - lastTime)
      if (last >= 0 && tile !== last && now - lastTick >= 28) { playReelTick(Math.min(1, speed / 2.5)); lastTick = now }
      last = tile; lastX = x; lastTime = now
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }
}

const armory = new Armory()

/** Dead Ink's Armory: add to the menu copy's `pages`. */
export const ARMORY_PAGE: MenuExtraPage = { id: 'armory', label: 'Armory', title: 'Armory', build: body => armory.build(body), show: () => armory.render() }

/** Dead Ink's home page record: best round as tally marks, the last game and the Ink balance. */
export function deadInkHome(slot: HTMLElement) {
  slot.classList.add('dead-ink-record')
  const render = (profile: Profile) => {
    const last = profile.last
    slot.innerHTML = `
      <div class="dead-ink-best"><span>Best round</span><b>${profile.bestRound ? (profile.bestRound <= 5 ? tallySvg(profile.bestRound) : `<em>${profile.bestRound}</em>`) : '<em>–</em>'}</b></div>
      <div><span>Last game</span><strong>${last ? `Round ${last.round} · ${last.kills} kills` : 'None yet'}</strong>${last ? `<small>+${ink(last.ink)} Ink</small>` : ''}</div>
      <div><span>Ink</span><strong>${ink(profile.ink)}</strong></div>`
  }
  render(loadProfile())
  onProfileChange(render)
}

/**
 * Turn on Dead Ink's cosmetics: the menu skin, and the equipped watch, charm, camos and knife on the
 * first-person arms, kept in step with the Armory. Returns a function that takes it all off again.
 */
export function installCosmetics(weapons: { setCosmetics(cosmetics: EquippedCosmetics | null): void }) {
  applyDeadInkMenuSkin()
  weapons.setCosmetics(equippedCosmetics())
  const stop = onProfileChange(() => weapons.setCosmetics(equippedCosmetics()))
  return () => { stop(); weapons.setCosmetics(null); delete document.body.dataset.deadInk }
}

/** Scope the Dead Ink menu skin to this page; the hostage mission never sets it. */
export function applyDeadInkMenuSkin() { document.body.dataset.deadInk = 'true' }
