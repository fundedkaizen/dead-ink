import '../menu-skin.css'
import './armory.css'
import { RARITY_INFO } from '../../loot'
import type { MenuExtraPage } from '../../menu'
import type { WeaponName } from '../../types'
import { playReelTick, playReelWin, synthContext } from '../../ui-slot-sound'
import { tallySvg } from '../hud'
import { CATALOGUE, cosmeticKey, type CamoId, type ChallengeCamoId, type CosmeticItem, type CosmeticKind, type EquippedCosmetics } from './catalogue'
import { ACCOUNT_CHALLENGES, CHALLENGE_WEAPONS, WEAPON_LABELS, WEAPON_TIERS, accountProgress, masteredCount, tierProgress, weaponMastered, type ChallengeState } from './challenges'
import { camoSwatch, cosmeticIcon } from './icons'
import { CASE, caseOdds, equippedCosmetics, loadProfile, onProfileChange, openCases, ownsCamo, toggleEquip, type CaseOpening, type Profile } from './profile'

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
/** The x5 reels are stacked, so their tiles are smaller (64 px wide plus a 6 px gap). */
const SMALL_TILE = 70
/** How many cases the multi-open button opens. */
const MULTI = 5
/** Spin lengths in ms: one reel; the first of five, each next one stopping STAGGER later; reduced motion. */
const SINGLE_SPIN = 3000, MULTI_SPIN = 2400, STAGGER = 300, SHORT_SPIN = 350
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

/** One reel of an opening: its strip, how far it travels and whether it has stopped. */
type Spin = { opening: CaseOpening; reel: HTMLElement; strip: HTMLElement; tile: number; width: number; distance: number; end: number
  animation: Animation | null; done: boolean }

/** Share of each rarity in a case, for the odds line under the case. */
function odds() {
  return caseOdds().map(({ rarity, share }) => `<span style="--rarity:${RARITY_INFO[rarity].css}">${RARITY_INFO[rarity].label} ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%</span>`).join('')
}

class Armory {
  private body!: HTMLElement
  private kind: Tab = 'watch'
  private gun: WeaponName = 'ak'
  private spinning = false
  private reels!: HTMLElement
  private result!: HTMLElement
  private results!: HTMLElement
  private openButton!: HTMLButtonElement
  private openManyButton!: HTMLButtonElement
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
          <div class="armory-buttons">
            <button class="armory-open" type="button">Open · ${CASE.price} Ink</button>
            <button class="armory-open armory-open-many" type="button">Open ${MULTI} · ${CASE.price * MULTI} Ink</button>
          </div>
        </div>
        <div class="armory-reels" hidden></div>
        <p class="armory-result" role="status"></p>
        <div class="armory-results" hidden></div>
      </section>
      <div class="armory-tabs" role="tablist">${KINDS.map(({ kind, label }) => `<button type="button" role="tab" data-kind="${kind}">${label}</button>`).join('')}</div>
      <div class="armory-guns" hidden>${GUNS.map(({ name, label }) => `<button type="button" data-gun="${name}">${label}</button>`).join('')}</div>
      <p class="armory-hint"></p>
      <div class="armory-grid"></div>
      <div class="armory-challenges" hidden></div>`
    this.reels = body.querySelector('.armory-reels')!
    this.result = body.querySelector('.armory-result')!
    this.results = body.querySelector('.armory-results')!
    this.openButton = body.querySelector('.armory-open')!
    this.openManyButton = body.querySelector('.armory-open-many')!
    this.balance = body.querySelector('.armory-ink strong')!
    this.openButton.addEventListener('click', () => this.open(1))
    this.openManyButton.addEventListener('click', () => this.open(MULTI))
    this.results.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-wear]')
      const item = button && CATALOGUE.find(entry => entry.id === button.dataset.wear)
      if (item && !isEquipped(item, loadProfile().equipped, this.gun)) toggleEquip(item.id, this.gun)
    })
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
    this.openManyButton.disabled = this.spinning || profile.ink < CASE.price * MULTI
    this.openManyButton.title = profile.ink < CASE.price * MULTI ? `You need ${CASE.price * MULTI - profile.ink} more Ink for ${MULTI} cases` : ''
    // The x5 results' Wear buttons follow what is worn now.
    this.results.querySelectorAll<HTMLButtonElement>('[data-wear]').forEach(button => {
      const item = CATALOGUE.find(entry => entry.id === button.dataset.wear)!
      const worn = isEquipped(item, profile.equipped, this.gun)
      button.textContent = worn ? 'Worn' : 'Wear'
      button.setAttribute('aria-pressed', String(worn))
    })
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

  /**
   * Spend the Ink for `count` cases, then let their strips run: fast at first, easing to a stop on the items
   * already won. Several reels stop one after another; a tap on a spinning reel stops it at once.
   */
  private open(count: number) {
    if (this.spinning) return
    const openings = openCases(count)
    if (!openings) return
    this.spinning = true
    this.render()
    const multi = openings.length > 1, size = multi ? SMALL_TILE : TILE
    this.reels.hidden = false
    this.reels.classList.toggle('multi', multi)
    this.result.textContent = ''
    this.results.hidden = true
    this.results.innerHTML = ''
    this.body.querySelector('.armory-case')!.classList.remove('mythic-win')
    this.reels.innerHTML = openings.map(({ item, strip }) => `<div class="armory-reel" style="--rarity:${RARITY_INFO[item.rarity].css}" title="Tap to stop">
      <div class="armory-strip">${strip.map(tile).join('')}</div><i class="armory-marker" aria-hidden="true"></i><i class="armory-burst" aria-hidden="true"></i></div>`).join('')
    // The Open click is the user gesture that lets the page make sound.
    synthContext()
    const start = performance.now()
    const spins = openings.map((opening, i): Spin => {
      const reel = this.reels.children[i] as HTMLElement, strip = reel.querySelector<HTMLElement>('.armory-strip')!
      const width = reel.clientWidth || 600
      // Land somewhere inside the winning tile, not always dead centre, as a real reel would.
      const jitter = (Math.random() - 0.5) * size * 0.6
      const distance = opening.winIndex * size + size / 2 - width / 2 + jitter
      const duration = reducedMotion() ? SHORT_SPIN + i * 60 : multi ? MULTI_SPIN + i * STAGGER : SINGLE_SPIN
      const animation = strip.animate?.([{ transform: 'translateX(0px)' }, { transform: `translateX(${-distance}px)` }],
        { duration, easing: 'cubic-bezier(0.06, 0.72, 0.14, 1)', fill: 'forwards' }) ?? null
      return { opening, reel, strip, tile: size, width, distance, end: start + duration, animation, done: false }
    })
    for (const spin of spins) {
      if (!spin.animation) { this.stopReel(spin, spins); continue }
      spin.animation.onfinish = () => this.stopReel(spin, spins)
      // Skip: the reel jumps to its result (a finished animation fires onfinish, which does the rest).
      spin.reel.addEventListener('pointerdown', () => { if (!spin.done) { spin.end = 0; spin.animation!.finish() } })
    }
    if (spins.some(spin => !spin.done)) this.tickReels(spins)
  }

  /** One reel has stopped on its item: light it up, play its win, and wrap up once the last one stops. */
  private stopReel(spin: Spin, spins: Spin[]) {
    if (spin.done) return
    spin.done = true
    const { item } = spin.opening
    playReelWin(item.rarity)
    spin.strip.style.transform = `translateX(${-spin.distance}px)`
    spin.strip.children[spin.opening.winIndex]?.classList.add('winner')
    spin.reel.classList.add('won')
    spin.reel.removeAttribute('title')
    if (item.rarity === 'mythic') {
      spin.reel.classList.add('mythic')
      this.body.querySelector('.armory-case')!.classList.add('mythic-win')
    }
    if (spins.every(s => s.done)) this.finishOpening(spins.map(s => s.opening))
  }

  private finishOpening(openings: CaseOpening[]) {
    this.spinning = false
    if (openings.length === 1) {
      const { item, duplicate, refund } = openings[0]
      const info = RARITY_INFO[item.rarity]
      this.result.innerHTML = `<strong class="armory-result-rarity" data-rarity="${item.rarity}" style="color:${info.css}">${info.label}</strong> ${escape(item.name)}${duplicate ? ` · already yours, ${refund} Ink back` : ''}
        ${duplicate ? '' : '<button type="button" class="armory-equip">Wear it</button>'}`
      this.result.querySelector('.armory-equip')?.addEventListener('click', () => {
        if (!isEquipped(item, loadProfile().equipped, this.gun)) toggleEquip(item.id, this.gun)
        this.kind = item.kind
        this.render()
      })
    } else {
      const refunds = openings.reduce((sum, opening) => sum + opening.refund, 0)
      const fresh = openings.filter(opening => !opening.duplicate).length
      this.result.textContent = `${fresh} new${refunds ? ` · ${refunds} Ink back for duplicates` : ''}`
      this.results.innerHTML = openings.map(({ item, duplicate, refund }) => {
        const info = RARITY_INFO[item.rarity]
        return `<div class="armory-won" data-rarity="${item.rarity}" style="--rarity:${info.css}" title="${escape(item.blurb)}">
          ${cosmeticIcon(item)}<b>${escape(item.name)}</b><small style="color:${info.css}">${info.label}</small>
          ${duplicate ? `<span class="armory-won-refund">+${refund} Ink</span>` : `<span class="armory-won-new">NEW</span><button type="button" class="armory-equip" data-wear="${item.id}">Wear</button>`}
        </div>`
      }).join('')
      this.results.hidden = false
    }
    this.render()
  }

  /**
   * A slot machine's click for every tile that slides under the marker, read off the strip as it moves, so
   * the ticks slow with the reel. Several reels would click into noise, so there is one tick stream, taken
   * from the reel furthest from stopping. At most one tick every 28 ms while the strip is a blur.
   */
  private tickReels(spins: Spin[]) {
    let source: Spin | null = null, last = -1, lastX = 0, lastTime = performance.now(), lastTick = 0
    const frame = (now: number) => {
      const running = spins.filter(spin => !spin.done && spin.end > 0)
      if (!running.length) return
      const spin = running.reduce((a, b) => b.end > a.end ? b : a)
      const x = -new DOMMatrixReadOnly(getComputedStyle(spin.strip).transform).m41
      const tile = Math.floor((x + spin.width / 2) / spin.tile)
      if (spin !== source) { source = spin; last = tile; lastX = x; lastTime = now }
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
