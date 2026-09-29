import './pages.css'
import { RARITY_INFO } from '../../loot'
import type { MenuExtraPage } from '../../menu'
import { playReelWin, synthContext } from '../../ui-slot-sound'
import { DIFFICULTY } from '../rules'
import { LEVEL_UNLOCKS, MAX_LEVEL, MAX_PRESTIGE, PRESTIGE, PRESTIGE_TITLES, STARTING_PISTOLS, canPrestige, levelOf, nextUnlock, prestigeBadge, prestigeMultiplier,
  rankBadge, rankName, titlesFor } from './career'
import { cosmeticIcon } from './icons'
import { loadProfile, onProfileChange, prestigeNow, setLoadout, type Profile } from './profile'
import { RECORD_CATEGORIES, RECORD_MAPS, formatRecord, recordKey, type RecordMode } from './records'
import { buyOffer, dailyOffers, msUntilRefresh, permanentOffers, shopDay, type Offer } from './shop'

/**
 * Dead Ink's menu pages beside the Armory: the Shop (buy a cosmetic outright), the Career (level, rank,
 * prestige, unlocks, loadout) and the Records (high scores). Pure DOM over the profile.
 */
const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const number = (value: number) => Math.round(value).toLocaleString('en-GB')
const INK_DROP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c3 5 7 9 7 13a7 7 0 0 1-14 0c0-4 4-8 7-13z" fill="currentColor"/></svg>'

/** A pistol, for a starting-pistol unlock, and a calling card, for a title unlock. 48 x 48. */
const PISTOL_GLYPH = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 16h34v8H22l-3 14h-8l3-14H6z" fill="#fff" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M40 18h3" stroke="currentColor" stroke-width="2.4"/></svg>'
const CARD_GLYPH = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="12" width="38" height="24" rx="3" fill="#fff" stroke="currentColor" stroke-width="2.4"/><path d="M11 20h20M11 27h26" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M34 16l2 4 4 .5-3 2.6.8 4-3.8-2-3.8 2 .8-4-3-2.6 4-.5z" fill="#e8a317" stroke="currentColor" stroke-width="1"/></svg>'

// ---------------------------------------------------------------- Shop

/**
 * The shop's stall, drawn in ink over the offers: a striped awning on two posts with its scalloped edge, a
 * hanging sign, a counter with planks, and a few things on it (a jar of ink, a stack of cases, a bell).
 */
const STALL = `<svg class="shop-stall" viewBox="0 0 360 120" aria-hidden="true">
  <g fill="none" stroke="#111" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 34h324l-10 22H28z" fill="#fff"/>
    ${Array.from({ length: 9 }, (_, i) => `<path d="M${18 + i * 36} 34h18l-${i === 0 ? 0 : 1} 22h-17z" fill="#111" stroke="none"/>`).join('')}
    <path d="M28 56${Array.from({ length: 9 }, () => ` q16.5 14 33 0`).join('')}" fill="#fff"/>
    <path d="M40 60v58M320 60v58"/>
    <path d="M150 8h60v20h-60z" fill="#fff"/><path d="M160 8l-6-6M200 8l6-6"/>
    <path d="M18 96h324v10H18z" fill="#fff"/><path d="M40 101h280" stroke-width="1.2"/>
    <path d="M70 96v-20h26v20" fill="#fff"/><path d="M70 82h26M76 76v-6h14v6" stroke-width="1.6"/>
    <path d="M250 96v-14h40v14M254 82v-10h32v10M258 72v-8h24v8" fill="#fff" stroke-width="2"/>
    <path d="M300 96a10 10 0 0 1 20 0z" fill="#fff"/><path d="M310 86v-5"/><circle cx="310" cy="79" r="2" fill="#111"/>
    <path d="M78 86c3-4 7-4 10 0" stroke-width="1.4"/>
  </g>
  <text x="180" y="23" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="13" fill="#111">INK &amp; CO.</text>
</svg>`

class Shop {
  private body: HTMLElement | null = null
  private status = ''
  private timer = 0

  build(body: HTMLElement) {
    this.body = body
    body.classList.add('shop')
    body.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-buy]')
      if (!button || button.disabled) return
      synthContext()
      const result = buyOffer(button.dataset.buy!)
      if (result.ok) { playReelWin(result.item.rarity); this.status = `${result.item.name} is yours. Wear it from the Armory.` }
      else this.status = result.reason === 'ink' ? 'Not enough Ink yet.' : result.reason === 'owned' ? 'You already own that.' : 'That offer has gone.'
      this.render()
    })
    onProfileChange(() => this.render())
    this.render()
  }

  private card(offer: Offer, profile: Profile) {
    const { item, price } = offer, owned = profile.owned.includes(item.id), info = RARITY_INFO[item.rarity]
    const short = profile.ink < price
    return `<article class="shop-offer${offer.featured ? ' featured' : ''}${owned ? ' owned' : ''}" style="--rarity:${info.css}">
      ${offer.featured ? '<em class="shop-flag">Featured · 25% off</em>' : offer.permanent ? '<em class="shop-flag shelf">Only in the Shop</em>' : ''}
      <span class="shop-tag" aria-hidden="true"><i></i>${offer.featured ? `<s>${number(Math.round(price / (1 - 0.25) / 50) * 50)}</s>` : ''}${number(price)}</span>
      ${owned ? '<span class="shop-stamp" aria-hidden="true">Owned</span>' : ''}
      <div class="shop-art">${cosmeticIcon(item)}</div>
      <b>${escape(item.name)}</b>
      <small><span style="color:${info.css}">${info.label}</span> ${item.kind === 'gloves' ? 'gloves' : item.kind}</small>
      <p>${escape(item.blurb)}</p>
      <button type="button" data-buy="${item.id}" ${owned || short ? 'disabled' : ''} title="${owned ? 'Owned' : short ? `You need ${number(price - profile.ink)} more Ink` : ''}">
        ${owned ? 'Owned' : `${INK_DROP} ${number(price)}`}</button>
    </article>`
  }

  render() {
    const body = this.body
    if (!body) return
    const profile = loadProfile(), hours = Math.floor(msUntilRefresh() / 3_600_000), minutes = Math.floor(msUntilRefresh() / 60_000) % 60
    body.innerHTML = `
      ${STALL}
      <div class="armory-bank"><span class="armory-ink">${INK_DROP}<strong>${number(profile.ink)}</strong> Ink</span>
        <small>Harder difficulties pay more Ink: ${Object.entries(DIFFICULTY).map(([key, d]) => `${d.label} ×${({ casual: 0.75, normal: 1, hardcore: 1.35, realistic: 1.75 } as Record<string, number>)[key]}`).join(', ')}${profile.prestige ? `, and your prestige adds ${Math.round((prestigeMultiplier(profile.prestige) - 1) * 100)}%` : ''}.</small></div>
      <section class="shop-section" aria-labelledby="shop-today">
        <header><h3 id="shop-today">Today's offers</h3><span class="shop-clock">New offers in ${hours} h ${minutes} min</span></header>
        <div class="shop-grid">${dailyOffers(shopDay()).map(offer => this.card(offer, profile)).join('')}</div>
      </section>
      <section class="shop-section" aria-labelledby="shop-shelf">
        <header><h3 id="shop-shelf">Always here</h3></header>
        <div class="shop-grid">${permanentOffers().map(offer => this.card(offer, profile)).join('')}</div>
      </section>
      <p class="shop-status" role="status">${escape(this.status)}</p>`
    clearTimeout(this.timer)
    // Keep the clock honest while the page stays open.
    this.timer = window.setTimeout(() => { if (body.isConnected && !body.closest('[hidden]')) this.render() }, 60_000)
  }
}
const shop = new Shop()
export const SHOP_PAGE: MenuExtraPage = { id: 'shop', label: 'Shop', title: 'Shop', build: body => shop.build(body), show: () => shop.render() }

// ---------------------------------------------------------------- Career

class Career {
  private body: HTMLElement | null = null
  private confirming = false

  build(body: HTMLElement) {
    this.body = body
    body.classList.add('career')
    body.addEventListener('click', event => {
      const target = event.target as HTMLElement
      const pistol = target.closest<HTMLElement>('[data-pistol]'), title = target.closest<HTMLElement>('[data-title]')
      if (pistol) setLoadout({ pistol: pistol.dataset.pistol as Profile['loadout']['pistol'] })
      else if (title) setLoadout({ title: title.dataset.title === '' ? null : title.dataset.title! })
      else if (target.closest('.career-prestige')) { this.confirming = true; this.render() }
      else if (target.closest('.career-prestige-yes')) { this.confirming = false; synthContext(); if (prestigeNow()) playReelWin('legendary') }
      else if (target.closest('.career-prestige-no')) { this.confirming = false; this.render() }
    })
    onProfileChange(() => this.render())
    this.render()
  }

  render() {
    const body = this.body
    if (!body) return
    const profile = loadProfile(), info = levelOf(profile.xp), next = nextUnlock(Math.max(profile.peakLevel, info.level))
    const nextHere = LEVEL_UNLOCKS.find(u => u.level > info.level) ?? null
    const ready = canPrestige(profile.xp, profile.prestige)
    const titles = titlesFor(profile.peakLevel, profile.prestige)
    const unlocks = LEVEL_UNLOCKS.map(u => {
      const got = u.level <= profile.peakLevel
      const art = u.kind === 'item' ? cosmeticIcon({ id: u.item, kind: u.item.split(':')[0] as 'gloves', name: '', rarity: 'common', blurb: '' }) : u.kind === 'pistol' ? PISTOL_GLYPH : CARD_GLYPH
      return `<li class="${got ? 'got' : ''}"><span class="career-unlock-level">${u.level}</span><span class="career-unlock-art">${art}</span><span>${escape(u.label)}</span></li>`
    }).join('')
    body.innerHTML = `
      <section class="career-hero">
        <div class="career-badges">${rankBadge(info.level, 92)}${prestigeBadge(profile.prestige, 44)}</div>
        <div class="career-rank">
          <small>${profile.prestige ? `Prestige ${profile.prestige} · ` : ''}${profile.loadout.title ? `“${escape(profile.loadout.title)}”` : 'No calling card'}</small>
          <b>Level ${info.level}</b><span>${rankName(info.level)}</span>
          <div class="career-bar" role="progressbar" aria-label="XP to the next level" aria-valuemin="0" aria-valuemax="${info.needed || 1}" aria-valuenow="${info.into}">
            <i style="width:${(info.fraction * 100).toFixed(1)}%"></i></div>
          <small class="career-xp">${info.max ? `Level ${MAX_LEVEL}: the top. ${profile.prestige < MAX_PRESTIGE ? 'Prestige to start again.' : 'Prestige Master.'}` : `${number(info.into)} / ${number(info.needed)} XP to level ${info.level + 1}`}</small>
          <small class="career-next">${nextHere ? `Next unlock at level ${nextHere.level}: <b>${escape(nextHere.label)}</b>` : next ? `Next unlock at level ${next.level}: <b>${escape(next.label)}</b>` : 'Every level unlock is yours.'}</small>
        </div>
      </section>
      <section class="career-prestige-box">
        <div><h3>Prestige ${profile.prestige < MAX_PRESTIGE ? profile.prestige + 1 : MAX_PRESTIGE}</h3>
          <p>${profile.prestige >= MAX_PRESTIGE ? 'You have taken every prestige. Ink Immortal.' : `At level ${MAX_LEVEL}: back to level 1, everything you unlocked kept, a new badge, the title “${PRESTIGE_TITLES[Math.min(MAX_PRESTIGE, profile.prestige + 1)]}”, +${number(PRESTIGE.ink)} Ink now and +${Math.round(PRESTIGE.inkBonus * 100)}% Ink from every game after.`}</p></div>
        ${this.confirming && ready ? `<div class="career-confirm"><b>Start again from level 1?</b><button type="button" class="career-prestige-yes">Prestige</button><button type="button" class="career-prestige-no">Not yet</button></div>`
          : `<button type="button" class="career-prestige" ${ready ? '' : 'disabled'}>${ready ? 'Prestige' : profile.prestige >= MAX_PRESTIGE ? 'Maxed' : `Reach level ${MAX_LEVEL}`}</button>`}
      </section>
      <section class="career-loadout">
        <h3>Start with</h3>
        <div class="career-choices">${STARTING_PISTOLS.map(p => {
          const open = p.level <= profile.peakLevel, on = profile.loadout.pistol === p.id
          return `<button type="button" data-pistol="${p.id}" aria-pressed="${on}" ${open ? '' : 'disabled'}>${escape(p.label)}${open ? '' : ` · level ${p.level}`}</button>`
        }).join('')}</div>
        <h3>Calling card</h3>
        <div class="career-choices">
          <button type="button" data-title="" aria-pressed="${!profile.loadout.title}">None</button>
          ${titles.map(t => `<button type="button" data-title="${escape(t)}" aria-pressed="${profile.loadout.title === t}">${escape(t)}</button>`).join('')}
        </div>
      </section>
      <section class="career-unlocks"><h3>Level unlocks</h3><ol>${unlocks}</ol></section>
      <p class="career-foot">XP: 10 a kill, 5 more for a headshot, a bonus each round, 250 a challenge, 100 an award. ${number(profile.lifetimeXp)} XP earned in all.</p>`
  }
}
const career = new Career()
export const CAREER_PAGE: MenuExtraPage = { id: 'career', label: 'Career', title: 'Career', build: body => career.build(body), show: () => career.render() }

// ---------------------------------------------------------------- Records

class Records {
  private body: HTMLElement | null = null
  private mode: RecordMode = 'solo'
  private difficulty = 'normal'
  private map = 'compound'

  build(body: HTMLElement) {
    this.body = body
    body.classList.add('records')
    body.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-mode],[data-difficulty]')
      if (!button) return
      if (button.dataset.mode) this.mode = button.dataset.mode as RecordMode
      if (button.dataset.difficulty) this.difficulty = button.dataset.difficulty
      this.render()
    })
    onProfileChange(() => this.render())
    this.render()
  }

  render() {
    const body = this.body
    if (!body) return
    const table = loadProfile().records[recordKey(this.map, this.mode, this.difficulty)] ?? {}
    const date = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    body.innerHTML = `
      <p class="records-map">${escape(RECORD_MAPS[this.map] ?? this.map)}</p>
      <div class="records-filters">
        <div class="career-choices" role="group" aria-label="Mode">${(['solo', 'coop'] as const).map(m => `<button type="button" data-mode="${m}" aria-pressed="${this.mode === m}">${m === 'solo' ? 'Solo' : 'Co-op'}</button>`).join('')}</div>
        <div class="career-choices" role="group" aria-label="Difficulty">${Object.entries(DIFFICULTY).map(([key, d]) => `<button type="button" data-difficulty="${key}" aria-pressed="${this.difficulty === key}">${d.label}</button>`).join('')}</div>
      </div>
      <div class="records-grid">${RECORD_CATEGORIES.map(category => {
        const list = table[category.id] ?? []
        return `<section class="records-table"><h3>${category.label}</h3>${list.length ? `<ol>${list.map((entry, i) =>
          `<li class="${i === 0 ? 'top' : ''}"><span class="records-rank">${i + 1}</span><b>${formatRecord(category.id, entry.value)}</b><small>${category.id === 'kills' ? `round ${entry.round}` : category.id === 'bestRound' ? `${number(entry.kills)} kills` : `${number(entry.kills)} kills`} · ${date(entry.date)}</small></li>`).join('')}</ol>`
          : '<p class="records-empty">No games yet.</p>'}</section>`
      }).join('')}</div>`
  }
}
const records = new Records()
export const RECORDS_PAGE: MenuExtraPage = { id: 'records', label: 'Records', title: 'Records', build: body => records.build(body), show: () => records.render() }
