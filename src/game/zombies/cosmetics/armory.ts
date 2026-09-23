import '../menu-skin.css'
import './armory.css'
import { RARITIES, RARITY_INFO } from '../../loot'
import type { MenuExtraPage } from '../../menu'
import type { WeaponName } from '../../types'
import { tallySvg } from '../hud'
import { CATALOGUE, cosmeticKey, type CosmeticItem, type CosmeticKind, type EquippedCosmetics } from './catalogue'
import { cosmeticIcon } from './icons'
import { CASE, CASE_WEIGHTS, casePool, equippedCosmetics, loadProfile, onProfileChange, openCase, toggleEquip, type Profile } from './profile'

/**
 * The Armory page of the Dead Ink menu (open cases, wear what you own) and the home page's record of
 * your last game. Pure DOM; the viewmodel learns about changes through installCosmetics.
 */

const KINDS: { kind: CosmeticKind; label: string }[] = [
  { kind: 'watch', label: 'Watches' }, { kind: 'charm', label: 'Charms' }, { kind: 'camo', label: 'Camos' }, { kind: 'knife', label: 'Knives' },
]
const GUNS: { name: WeaponName; label: string }[] = [
  { name: 'pistol', label: 'Pistol' }, { name: 'smg', label: 'SMG' }, { name: 'ak', label: 'AK' }, { name: 'shotgun', label: 'Shotgun' }, { name: 'sniper', label: 'Sniper' },
]
const TILE = 120
const reducedMotion = () => document.body.dataset.reducedMotion === 'true'
const ink = (value: number) => value.toLocaleString('en-GB')
const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

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
  private kind: CosmeticKind = 'watch'
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
      <div class="armory-grid"></div>`
    this.strip = body.querySelector('.armory-strip')!
    this.reel = body.querySelector('.armory-reel')!
    this.result = body.querySelector('.armory-result')!
    this.openButton = body.querySelector('.armory-open')!
    this.balance = body.querySelector('.armory-ink strong')!
    this.openButton.addEventListener('click', () => this.open())
    body.querySelectorAll<HTMLElement>('[data-kind]').forEach(button => button.addEventListener('click', () => { this.kind = button.dataset.kind as CosmeticKind; this.render() }))
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
    guns.hidden = this.kind !== 'camo'
    guns.querySelectorAll<HTMLElement>('[data-gun]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.gun === this.gun)))
    this.body.querySelector('.armory-hint')!.textContent = this.kind === 'camo'
      ? 'A camo covers one gun type. Pack-a-Punched guns always wear the Pack-a-Punch camo.'
      : this.kind === 'knife' ? 'Your knife slashes with V and shows off when you stand still.' : 'Click something you own to wear it; click again to take it off.'
    const items = CATALOGUE.filter(entry => entry.kind === this.kind)
    this.body.querySelector('.armory-grid')!.innerHTML = items.map(item => {
      const owned = profile.owned.includes(item.id), worn = owned && isEquipped(item, profile.equipped, this.gun)
      return `<button type="button" class="armory-item${worn ? ' worn' : ''}" data-item="${item.id}" style="--rarity:${RARITY_INFO[item.rarity].css}"
        ${owned ? '' : 'aria-disabled="true"'} aria-pressed="${worn}" title="${escape(item.blurb)}">
        ${cosmeticIcon(item)}
        <span class="armory-name">${owned ? escape(item.name) : 'Locked'}</span>
        <span class="armory-rarity">${RARITY_INFO[item.rarity].label}${worn ? ' · worn' : ''}</span>
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
    const finish = () => {
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
    if (animation) animation.onfinish = finish
    else finish()
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
