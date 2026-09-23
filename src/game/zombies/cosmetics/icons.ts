import { RARITY_INFO } from '../../loot'
import { cosmeticKey, type CosmeticItem } from './catalogue'

/**
 * Flat ink drawings of every cosmetic for the Armory and the case strip: black strokes on paper, gold
 * only on the items that are gold. 48 x 48 units.
 */
const GOLD = RARITY_INFO.legendary.css
const stroke = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'
const paper = 'fill="var(--paper, #fff)" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"'

function watch(id: string) {
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
}

const KNIVES: Record<string, string> = {
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
