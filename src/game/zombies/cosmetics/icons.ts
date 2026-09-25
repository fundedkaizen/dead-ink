import { RARITY_INFO } from '../../loot'
import { cosmeticKey, type CosmeticItem } from './catalogue'

/**
 * Flat ink drawings of every cosmetic for the Armory and the case strip: black strokes on paper, gold
 * only on the items that are gold. 48 x 48 units.
 */
const GOLD = RARITY_INFO.legendary.css
const stroke = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'
const paper = 'fill="var(--paper, #fff)" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"'
/** Mythic: the rarity's pink, pink-gold metal and a deep violet ink. The classes animate in armory.css. */
const PINK = RARITY_INFO.mythic.css, ROSE = '#e9a6a1', VIOLET = '#1c0a24'

/** A gear centred on (x, y) that turns (class mythic-spin, or mythic-spin-back for the one meshing against it). */
function gear(x: number, y: number, r: number, teeth: number, back: boolean) {
  const cogs = Array.from({ length: teeth }, (_, i) => {
    const a = i * Math.PI * 2 / teeth
    return `M${(x + Math.sin(a) * r).toFixed(2)} ${(y - Math.cos(a) * r).toFixed(2)}L${(x + Math.sin(a) * (r + 1.6)).toFixed(2)} ${(y - Math.cos(a) * (r + 1.6)).toFixed(2)}`
  }).join('')
  const spokes = [0, 1, 2].map(i => { const a = i * Math.PI * 2 / 3; return `M${x} ${y}L${(x + Math.sin(a) * r).toFixed(2)} ${(y - Math.cos(a) * r).toFixed(2)}` }).join('')
  return `<g class="${back ? 'mythic-spin-back' : 'mythic-spin'}"><path d="${cogs}" stroke="${ROSE}" stroke-width="1.5"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${ROSE}" stroke-width="1.3"/><path d="${spokes}" stroke="${ROSE}" stroke-width="0.8"/>
    <circle cx="${x}" cy="${y}" r="1.1" fill="${PINK}"/></g>`
}

/** Mythic watch: a pink-gold skeleton, its gears turning through the open dial. */
const skeleton = () => `<rect x="17" y="2" width="14" height="44" rx="3" fill="${ROSE}" stroke="currentColor" stroke-width="2.2"/>
    <path d="M17 9h14M17 15h14M17 33h14M17 39h14" stroke="currentColor" stroke-width="1.2"/>
    <circle cx="24" cy="24" r="14" fill="${ROSE}" stroke="currentColor" stroke-width="2.2"/>
    <circle cx="24" cy="24" r="10.5" fill="${VIOLET}" stroke="currentColor" stroke-width="1.4"/>
    ${gear(20.5, 26, 4.2, 10, false)}${gear(28, 21.5, 3, 8, true)}${gear(25.5, 30.2, 2, 6, true)}
    <path d="M24 24l-5.5-3.5M24 24l6.5-5.5" stroke="#ffd6ea" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M38 22v4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`

const HEART = 'M24 42C11 33 7 24 9.5 18.5 12 13 20 12 24 18.5 28 12 36 13 38.5 18.5 41 24 37 33 24 42z'

function watch(id: string) {
  if (id === 'skeleton') return skeleton()
  const metal = id === 'president' || id === 'diamond' ? GOLD : 'var(--paper, #fff)'
  const dial = id === 'tactical' || id === 'diver' ? '#333' : id === 'president' || id === 'diamond' ? '#f2dca0' : 'var(--paper, #fff)'
  const hands = id === 'tactical' || id === 'diver' ? '#fff' : 'currentColor'
  const band = id === 'tactical' ? '#555' : id === 'two-tone' ? GOLD : metal
  const gems = id === 'diamond' ? Array.from({ length: 12 }, (_, i) => {
    const a = i * Math.PI / 6
    return `<circle cx="${(24 + Math.sin(a) * 11.5).toFixed(1)}" cy="${(24 - Math.cos(a) * 11.5).toFixed(1)}" r="1.6" fill="#e6f6ff" stroke="currentColor" stroke-width="0.8"/>`
  }).join('') : ''
  return `<rect x="17" y="2" width="14" height="44" rx="3" fill="${band}" stroke="currentColor" stroke-width="2.2"/>
    ${id !== 'tactical' ? '<path d="M17 9h14M17 15h14M17 33h14M17 39h14" stroke="currentColor" stroke-width="1.2"/>' : ''}
    <circle cx="24" cy="24" r="13.5" fill="${metal}" stroke="currentColor" stroke-width="2.2"/>
    <circle cx="24" cy="24" r="9.5" fill="${dial}" stroke="currentColor" stroke-width="1.4"/>${gems}
    <path d="M24 24l-5-3M24 24l6-5" stroke="${hands}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M37.5 22v4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`
}

const CHARMS: Record<string, string> = {
  'ink-heart': `<path d="${HEART}" fill="${PINK}" class="mythic-halo" transform="translate(24 27) scale(1.3) translate(-24 -27)"/>
    <path d="M24 3v9" ${stroke}/><path d="${HEART}" fill="${ROSE}" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="${HEART}" fill="${VIOLET}" transform="translate(24 28) scale(0.68) translate(-24 -28)"/>
    <path d="${HEART}" fill="${PINK}" class="mythic-pulse" transform="translate(24 29) scale(0.36) translate(-24 -29)"/>`,
  skull: `<path d="M24 4v6" ${stroke}/><path d="M13 24a11 11 0 1 1 22 0c0 4-2 6-4 7v5H17v-5c-2-1-4-3-4-7z" ${paper}/>
    <circle cx="19.5" cy="25" r="3" fill="currentColor"/><circle cx="28.5" cy="25" r="3" fill="currentColor"/><path d="M22 36v-3M26 36v-3" ${stroke}/>`,
  dice: `<path d="M24 3v7" ${stroke}/><rect x="9" y="12" width="17" height="17" rx="3" transform="rotate(-12 17 20)" ${paper}/>
    <rect x="22" y="24" width="15" height="15" rx="3" transform="rotate(14 29 31)" ${paper}/>
    <circle cx="13.5" cy="17.5" r="1.8" fill="currentColor"/><circle cx="17.5" cy="20.5" r="1.8" fill="currentColor"/><circle cx="21.5" cy="23.5" r="1.8" fill="currentColor"/>
    <circle cx="27" cy="29" r="1.6" fill="currentColor"/><circle cx="31" cy="34" r="1.6" fill="currentColor"/>`,
  'ink-drop': `<path d="M24 3v7" ${stroke}/><path d="M24 12c5 8 10 13 10 20a10 10 0 0 1-20 0c0-7 5-12 10-20z" fill="currentColor"/>
    <path d="M19 31a5 5 0 0 0 3 5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
  teddy: `<path d="M24 2v6" ${stroke}/><circle cx="16.5" cy="11" r="3.5" ${paper}/><circle cx="31.5" cy="11" r="3.5" ${paper}/>
    <circle cx="24" cy="16" r="8" ${paper}/><ellipse cx="24" cy="33" rx="10" ry="11" ${paper}/>
    <circle cx="13" cy="29" r="3.5" ${paper}/><circle cx="35" cy="29" r="3.5" ${paper}/><circle cx="18" cy="43" r="3.5" ${paper}/><circle cx="30" cy="43" r="3.5" ${paper}/>
    <circle cx="21" cy="15" r="1.3" fill="currentColor"/><circle cx="27" cy="15" r="1.3" fill="currentColor"/><circle cx="24" cy="19" r="1.6" fill="currentColor"/>`,
  crane: `<path d="M24 2v12" ${stroke}/><path d="M4 30l20-4 20 4-20 6z" ${paper}/><path d="M24 26l-8-12 8 4z" ${paper}/><path d="M24 26l10-16-2 16z" ${paper}/>
    <path d="M44 30l2-9-5 1" ${stroke}/><path d="M4 30l-1-8" ${stroke}/>`,
  'golden-bullet': `<path d="M24 2v6" ${stroke}/><path d="M18 20h12v22H18z" fill="${GOLD}" stroke="currentColor" stroke-width="2.2"/>
    <path d="M18 20c0-6 3-10 6-12 3 2 6 6 6 12z" fill="${GOLD}" stroke="currentColor" stroke-width="2.2"/><path d="M17 42h14" ${stroke}/><path d="M18 25h12" stroke="currentColor" stroke-width="1.2"/>`,
}

const CAMOS: Record<string, string> = {
  nebula: `<defs><clipPath id="camo-n"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath>
      <radialGradient id="camo-n-pink" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${PINK}"/><stop offset="1" stop-color="${PINK}" stop-opacity="0"/></radialGradient>
      <radialGradient id="camo-n-violet" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#6a1fd0"/><stop offset="1" stop-color="#6a1fd0" stop-opacity="0"/></radialGradient></defs>
    <g clip-path="url(#camo-n)"><rect x="4" y="8" width="40" height="32" fill="#0d0418"/>
    <g class="mythic-swirl"><circle cx="16" cy="18" r="15" fill="url(#camo-n-violet)"/><circle cx="32" cy="30" r="13" fill="url(#camo-n-pink)"/>
      <path d="M6 30c6-10 18-12 22-4s-6 10-10 5 4-12 14-10 10 8 8 12" fill="none" stroke="${PINK}" stroke-width="2.4" stroke-linecap="round" opacity="0.9"/>
      <path d="M10 14c8-4 16 2 22-2s10 2 12 6" fill="none" stroke="#b58cff" stroke-width="1.6" stroke-linecap="round" opacity="0.8"/></g>
    <g class="camo-glint" fill="#fff"><path d="M13 14l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/><path d="M36 17l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/><path d="M24 33l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></g>
    <circle cx="9" cy="35" r="0.7" fill="#fff"/><circle cx="29" cy="12" r="0.6" fill="#fff"/><circle cx="41" cy="36" r="0.7" fill="#fff"/><circle cx="20" cy="24" r="0.5" fill="#fff"/></g>
    <rect x="4" y="8" width="40" height="32" rx="3" fill="none" stroke="currentColor" stroke-width="1.2"/>`,
  stripes: `<defs><clipPath id="camo-a"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath></defs><g clip-path="url(#camo-a)"><rect x="4" y="8" width="40" height="32" fill="#fff"/>
    <path d="M2 20c6-2 8 4 14 0M8 34c6-3 10 3 16-2M20 14c5 2 9-3 14 0M26 28c6-3 9 3 16-1M30 42c4-2 8 2 14-1" stroke="#111" stroke-width="4" fill="none" stroke-linecap="round"/></g>`,
  woodland: `<defs><clipPath id="camo-b"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath></defs><g clip-path="url(#camo-b)"><rect x="4" y="8" width="40" height="32" fill="#fff"/>
    <path d="M4 14c6-4 12 2 16-2s8 6 4 10-12 2-16 0-8-4-4-8z" fill="#bbb"/><path d="M24 26c6-4 14-2 16 4s-6 8-12 6-8-6-4-10z" fill="#6b6b6b"/>
    <path d="M10 30c3-2 6 0 7 3s-4 4-6 3-3-4-1-6zM32 12c2-2 6-1 6 2s-3 4-5 3-2-3-1-5z" fill="#121212"/></g>`,
  digital: `<defs><clipPath id="camo-c"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath></defs><g clip-path="url(#camo-c)"><rect x="4" y="8" width="40" height="32" fill="#fff"/>
    ${[[6, 10, '#777'], [10, 10, '#777'], [10, 14, '#191919'], [22, 12, '#c4c4c4'], [26, 12, '#c4c4c4'], [26, 16, '#777'], [34, 22, '#191919'], [38, 22, '#191919'],
      [38, 26, '#777'], [14, 26, '#c4c4c4'], [14, 30, '#191919'], [18, 30, '#777'], [26, 32, '#c4c4c4'], [30, 32, '#191919'], [6, 34, '#777'], [34, 10, '#c4c4c4']]
      .map(([x, y, c]) => `<rect x="${x}" y="${y}" width="4" height="4" fill="${c}"/>`).join('')}</g>`,
  obsidian: `<rect x="4" y="8" width="40" height="32" rx="3" fill="#18141f"/><path d="M8 16l10 6 4 10 12 4M22 22l14-8M30 36l6 2" stroke="#d7cbe6" stroke-width="1.3" fill="none"/>`,
  gold: `<rect x="4" y="8" width="40" height="32" rx="3" fill="${GOLD}"/><path d="M10 14l28 20M16 12l24 17M8 21l22 17" stroke="#fff3c9" stroke-width="1.2" opacity="0.8"/>`,
  crosshatch: `<defs><clipPath id="camo-f"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath></defs><g clip-path="url(#camo-f)"><rect x="4" y="8" width="40" height="32" fill="#fff"/>
    <path d="${Array.from({ length: 12 }, (_, i) => `M${i * 5 - 10} 40l26 -32`).join('')}" stroke="#111" stroke-width="1.1"/>
    <path d="${Array.from({ length: 7 }, (_, i) => `M${i * 5 + 14} 8l24 32`).join('')}" stroke="#111" stroke-width="1.1"/>
    <path d="M22 24h24M22 28h24M24 32h22M26 36h20" stroke="#111" stroke-width="1"/></g>`,
  blueprint: `<defs><clipPath id="camo-g"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath></defs><g clip-path="url(#camo-g)"><rect x="4" y="8" width="40" height="32" fill="#153e8f"/>
    <path d="M4 14h40M4 26h40M4 32h40M4 38h40M10 8v32M16 8v32M28 8v32M34 8v32M40 8v32" stroke="#9fc3ff" stroke-width="0.4" opacity="0.7"/>
    <path d="M4 20h40M22 8v32" stroke="#e8f1ff" stroke-width="1.2"/><circle cx="31" cy="27" r="7.5" fill="none" stroke="#e8f1ff" stroke-width="1.2"/>
    <path d="M9 34l9-9 4 4" fill="none" stroke="#e8f1ff" stroke-width="1.2"/></g>`,
  'red-ink': `<defs><clipPath id="camo-h"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath></defs><g clip-path="url(#camo-h)"><rect x="4" y="8" width="40" height="32" fill="#fbf4f1"/>
    <path d="M4 22c6-6 12-2 16-8s12-4 14 2 8 6 10 4v20H4z" fill="#d4332a"/><path d="M12 40c2-6 8-8 12-5s10-2 12 5z" fill="#5a0a08"/>
    <circle cx="11" cy="14" r="1.6" fill="#d4332a"/><circle cx="38" cy="13" r="1.2" fill="#d4332a"/><circle cx="30" cy="11" r="0.9" fill="#d4332a"/></g>`,
  'black-gold': `<rect x="4" y="8" width="40" height="32" rx="3" fill="#0d0d0d"/>
    <path d="M6 30c6-2 8-10 14-10s8 8 14 6 6-10 10-12M14 40c2-6 6-8 10-8M28 8c0 6 4 8 8 12" fill="none" stroke="${GOLD}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M20 20l-4-8M34 26l6 8" stroke="${GOLD}" stroke-width="0.8" opacity="0.8"/>`,
  diamond: `<defs><clipPath id="camo-i"><rect x="4" y="8" width="40" height="32" rx="3"/></clipPath></defs><g clip-path="url(#camo-i)">
    <rect x="4" y="8" width="40" height="32" fill="#cfe0f7"/>
    <path d="M4 8h16l-6 12z" fill="#e6f0ff"/><path d="M20 8h14l-8 14z" fill="#9fbde6"/><path d="M34 8h10v14l-12-2z" fill="#eef6ff"/>
    <path d="M4 8l10 12-10 8z" fill="#b8cfee"/><path d="M14 20l12 2-6 12z" fill="#f7fbff"/><path d="M26 22l8-14-2 12z" fill="#c9dcf6"/>
    <path d="M32 20l12 2v18l-12-4z" fill="#a9c4ea"/><path d="M4 28l10-8 6 14-16 6z" fill="#e7f1ff"/><path d="M20 34l6-12 6-2v16l-12 4z" fill="#bcd3f2"/>
    <path d="M4 8h16l-6 12zM20 8h14l-8 14zM14 20l12 2-6 12zM26 22l6-2 12 2M32 20v16M4 28l10-8M20 34l12 2" fill="none" stroke="#56688a" stroke-width="0.6"/>
    <g class="camo-glint" fill="#fff"><path d="M16 17l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/><path d="M36 29l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/><path d="M25 32l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/></g></g>
    <rect x="4" y="8" width="40" height="32" rx="3" fill="none" stroke="#56688a" stroke-width="1"/>`,
}

/** A camo swatch by id, for the Challenges tab and the game-over summary. */
export const camoSwatch = (camo: string) => `<svg viewBox="0 4 48 40" aria-hidden="true">${CAMOS[camo] ?? ''}</svg>`

const KNIVES: Record<string, string> = {
  heartline: `<circle cx="9" cy="32" r="5" fill="var(--paper, #fff)" stroke="${ROSE}" stroke-width="3"/><circle cx="9" cy="32" r="6.4" fill="none" stroke="currentColor" stroke-width="1"/>
    <path d="M13 30l12-3 2 6-12 3z" ${paper}/>
    <path d="M27 33c7 0 11 1 15 6" fill="none" stroke="${PINK}" stroke-width="6" stroke-linecap="round" class="mythic-halo"/>
    <path d="M26 27c8-2 14 2 16 12-4-5-8-6-15-6z" fill="${VIOLET}" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M27.5 33.2c7 0 10.5 1.3 14 5" fill="none" stroke="${PINK}" stroke-width="2" stroke-linecap="round" class="mythic-pulse"/>`,
  combat: `<path d="M4 30h14v6H4z" ${paper}/><path d="M18 27v12" ${stroke}/><path d="M20 30h18l6-4v-2c-6 1-14 2-24 2z" ${paper}/><path d="M8 30v6M12 30v6" stroke="currentColor" stroke-width="1.2"/>`,
  bayonet: `<path d="M2 30h13v6H2z" ${paper}/><path d="M15 25v14" ${stroke}/><circle cx="15" cy="22" r="3" ${paper}/><path d="M17 30h24l5 3-5 3H17z" ${paper}/><path d="M20 33h20" stroke="currentColor" stroke-width="1.4"/>`,
  cleaver: `<path d="M4 34h12v5H4z" ${paper}/><path d="M16 22h26v18H16z" ${paper}/><circle cx="37" cy="27" r="2.4" ${paper}/><path d="M16 38h26" stroke="currentColor" stroke-width="1.2"/>`,
  karambit: `<circle cx="9" cy="32" r="5" ${paper}/><path d="M13 30l12-3 2 6-12 3z" ${paper}/><path d="M26 27c8-2 14 2 16 12-4-5-8-6-15-6z" ${paper}/>`,
  butterfly: `<path d="M4 29h20v4H4zM4 33h20v4H4z" ${paper}/><circle cx="24" cy="33" r="1.6" fill="currentColor"/><path d="M25 31h15l5 2-5 3H25z" ${paper}/><path d="M8 29v8M13 29v8" stroke="currentColor" stroke-width="1.1"/>`,
}

export function cosmeticIcon(item: CosmeticItem) {
  const id = cosmeticKey(item.id)
  const body = item.kind === 'watch' ? watch(id) : item.kind === 'charm' ? CHARMS[id] : item.kind === 'camo' ? CAMOS[id] : KNIVES[id]
  return `<svg viewBox="0 0 48 48" aria-hidden="true">${body ?? ''}</svg>`
}
