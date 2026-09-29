/**
 * The Career: levels 1 to 55 earned with XP, a rank name and an ink badge for each, and prestige 1 to 10.
 * Prestige starts the levels again from 1, keeps everything unlocked, and pays a badge and a bonus: Ink at
 * once and a little more Ink from every game after.
 *
 * Pure numbers and data, checked in Node. profile.ts keeps the XP and prestige; grantXp (profile.ts) is the
 * way in for both modes.
 */

export const MAX_LEVEL = 55
export const MAX_PRESTIGE = 10

/**
 * XP from one level to the next: 600 to leave level 1, 90 more for each level after. Level 55 is 161,190 XP,
 * about twenty-five games to round 15 (a game there earns about 6,000).
 */
export const xpToNext = (level: number) => 600 + 90 * (Math.max(1, Math.floor(level)) - 1)

/** Total XP needed to reach `level` from nothing. */
export function xpForLevel(level: number) {
  const target = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level)))
  let total = 0
  for (let l = 1; l < target; l++) total += xpToNext(l)
  return total
}
export const MAX_XP = xpForLevel(MAX_LEVEL)

export type LevelInfo = { level: number; into: number; needed: number; fraction: number; max: boolean }

/** Where `xp` stands: the level, XP into it, XP it needs, and the fraction done (1 at level 55). */
export function levelOf(xp: number): LevelInfo {
  let left = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0)), level = 1
  while (level < MAX_LEVEL && left >= xpToNext(level)) { left -= xpToNext(level); level++ }
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, into: 0, needed: 0, fraction: 1, max: true }
  return { level, into: left, needed: xpToNext(level), fraction: left / xpToNext(level), max: false }
}

/** Eleven ranks of five levels each, from a scribble to a master of the ink. */
export const RANKS = ['Scribbler', 'Doodler', 'Sketcher', 'Outliner', 'Inker', 'Letterer', 'Illustrator', 'Penman', 'Etcher', 'Engraver', 'Master Inker'] as const
const NUMERALS = ['I', 'II', 'III', 'IV', 'V']
export const rankIndex = (level: number) => Math.min(RANKS.length - 1, Math.floor((Math.min(MAX_LEVEL, Math.max(1, level)) - 1) / 5))
/** "Sketcher III" for level 13. */
export const rankName = (level: number) => `${RANKS[rankIndex(level)]} ${NUMERALS[(Math.max(1, Math.min(MAX_LEVEL, level)) - 1) % 5]}`

/** Every prestige pays this much Ink at once, and each adds this share to every game's Ink after. */
export const PRESTIGE = { ink: 1000, inkBonus: 0.05 } as const
export const prestigeMultiplier = (prestige: number) => 1 + PRESTIGE.inkBonus * Math.min(MAX_PRESTIGE, Math.max(0, Math.floor(prestige) || 0))
/** A prestige can be taken at level 55, up to prestige 10. */
export const canPrestige = (xp: number, prestige: number) => levelOf(xp).max && prestige < MAX_PRESTIGE

/** The guns you can start a game with; the pistol from the start, the others from a Career level. */
export type StartingPistol = 'pistol' | 'burst' | 'magnum'
export const STARTING_PISTOLS: readonly { id: StartingPistol; label: string; level: number }[] = [
  { id: 'pistol', label: 'Pistol', level: 1 },
  { id: 'burst', label: 'Burst pistol', level: 10 },
  { id: 'magnum', label: 'Magnum', level: 30 },
]

export type LevelUnlock =
  | { level: number; kind: 'item'; item: string; label: string }
  | { level: number; kind: 'pistol'; pistol: StartingPistol; label: string }
  | { level: number; kind: 'title'; title: string; label: string }

/** What each level unlocks, kept through prestige. Items already owned from a case pay back as a duplicate would. */
export const LEVEL_UNLOCKS: readonly LevelUnlock[] = [
  { level: 2, kind: 'title', title: 'Fresh Ink', label: 'Calling card: Fresh Ink' },
  { level: 4, kind: 'item', item: 'watch:tactical', label: 'Night Shift watch' },
  { level: 6, kind: 'item', item: 'charm:dice', label: 'Loaded Dice charm' },
  { level: 8, kind: 'title', title: 'Page Turner', label: 'Calling card: Page Turner' },
  { level: 10, kind: 'pistol', pistol: 'burst', label: 'Start with the Burst pistol' },
  { level: 12, kind: 'item', item: 'camo:ink-wash', label: 'Ink Wash camo' },
  { level: 14, kind: 'item', item: 'camo:stripes', label: 'Tiger Ink camo' },
  { level: 16, kind: 'title', title: 'Night Shift', label: 'Calling card: Night Shift' },
  { level: 18, kind: 'item', item: 'charm:ink-drop', label: 'Last Drop charm' },
  { level: 20, kind: 'item', item: 'camo:newsprint', label: 'Newsprint camo' },
  { level: 22, kind: 'title', title: 'Inkslinger', label: 'Calling card: Inkslinger' },
  { level: 24, kind: 'item', item: 'knife:bayonet', label: 'Bayonet knife' },
  { level: 26, kind: 'item', item: 'charm:crane', label: 'Paper Crane charm' },
  { level: 28, kind: 'item', item: 'camo:woodland', label: 'Woodland Ink camo' },
  { level: 30, kind: 'pistol', pistol: 'magnum', label: 'Start with the Magnum' },
  { level: 32, kind: 'title', title: 'Deadline Dodger', label: 'Calling card: Deadline Dodger' },
  { level: 34, kind: 'item', item: 'watch:diver', label: 'Deep Water watch' },
  { level: 36, kind: 'item', item: 'camo:topo', label: 'Contour Map camo' },
  { level: 38, kind: 'item', item: 'charm:teddy', label: 'Little Ted charm' },
  { level: 40, kind: 'title', title: 'Brute Hunter', label: 'Calling card: Brute Hunter' },
  { level: 42, kind: 'item', item: 'knife:cleaver', label: 'Cleaver knife' },
  { level: 44, kind: 'item', item: 'camo:digital', label: 'Pixel Grid camo' },
  { level: 46, kind: 'title', title: 'Last Edition', label: 'Calling card: Last Edition' },
  { level: 48, kind: 'item', item: 'camo:obsidian', label: 'Obsidian camo' },
  { level: 50, kind: 'item', item: 'camo:circuit', label: 'Circuit Ink camo' },
  { level: 52, kind: 'item', item: 'charm:skull', label: 'Old Friend charm' },
  { level: 55, kind: 'title', title: 'Master Inker', label: 'Calling card: Master Inker' },
]

/** Each prestige's calling card title. */
export const PRESTIGE_TITLES = ['', 'Second Draft', 'Third Coat', 'Fourth Proof', 'Fifth Edition', 'Sixth Sense', 'Seventh Seal',
  'Eighth Wonder', 'Ninth Life', 'Tenth Circle', 'Ink Immortal'] as const

/** Unlocks from level `from` (exclusive) to `to` (inclusive): what a level-up just earned. */
export const unlocksBetween = (from: number, to: number) => LEVEL_UNLOCKS.filter(u => u.level > from && u.level <= to)
/** Everything unlocked by the highest level ever reached. */
export const unlockedBy = (peak: number) => LEVEL_UNLOCKS.filter(u => u.level <= peak)
/** The next unlock after `level` (null once everything is unlocked). */
export const nextUnlock = (peak: number) => LEVEL_UNLOCKS.find(u => u.level > peak) ?? null

/** Titles available: every level's reached, and each prestige's taken. */
export function titlesFor(peak: number, prestige: number) {
  return [...unlockedBy(peak).flatMap(u => u.kind === 'title' ? [u.title] : []), ...PRESTIGE_TITLES.slice(1, Math.max(0, prestige) + 1)]
}
export const pistolsFor = (peak: number) => STARTING_PISTOLS.filter(p => p.level <= peak)

/**
 * XP a game pays as it goes, and at its end. Kills are the steady drip; rounds the milestones; finishing a
 * challenge or an award a bonus.
 */
export const XP = { kill: 10, headshot: 5, knife: 10, roundBase: 25, roundStep: 5, gameEnd: 100, challenge: 250, award: 100 } as const
export const xpForRound = (round: number) => XP.roundBase + XP.roundStep * Math.max(0, Math.floor(round))

// ---------------------------------------------------------------- badges

const RANK_INK = ['#8c8c8c', '#8c8c8c', '#3fae49', '#3fae49', '#2f7fe0', '#2f7fe0', '#9b4fd6', '#9b4fd6', '#e8a317', '#e8a317', '#e0268f']

/**
 * A rank's badge, drawn in ink: a shield that gains a chevron each level of its rank, and grows wings,
 * a crown and a star as the ranks climb; its rim takes the rarity colour of that stage. 48 x 48.
 */
export function rankBadge(level: number, size = 40) {
  const lv = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level) || 1)), rank = rankIndex(lv), step = (lv - 1) % 5 + 1
  const rim = RANK_INK[rank]
  const chevrons = Array.from({ length: step }, (_, i) => `<path d="M15 ${31 - i * 4.2}l9 -4.5 9 4.5" fill="none" stroke="#111" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
  const wings = rank >= 3 ? `<path d="M9 18c-5-1-7 3-6 7 3-2 5-2 6-1M39 18c5-1 7 3 6 7-3-2-5-2-6-1" fill="#fff" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/>` : ''
  const crown = rank >= 6 ? `<path d="M17 9l3 4 4-6 4 6 3-4v6H17z" fill="${rim}" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/>` : ''
  const star = rank >= 9 ? `<path d="M24 1.5l1.5 3.3 3.5.4-2.6 2.4.7 3.5-3.1-1.8-3.1 1.8.7-3.5-2.6-2.4 3.5-.4z" fill="${rim}" stroke="#111" stroke-width="1"/>` : ''
  return `<svg class="rank-badge" viewBox="0 0 48 48" width="${size}" height="${size}" role="img" aria-label="Level ${lv}, ${rankName(lv)}">
    ${wings}<path d="M11 14h26v13c0 9-6 14-13 18-7-4-13-9-13-18z" fill="#fff" stroke="${rim}" stroke-width="5" stroke-linejoin="round"/>
    <path d="M11 14h26v13c0 9-6 14-13 18-7-4-13-9-13-18z" fill="none" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/>
    ${chevrons}${crown}${star}</svg>`
}

const PRESTIGE_INK = ['#111', '#3fae49', '#2f7fe0', '#9b4fd6', '#e8a317', '#d4332a', '#1aa39a', '#e0268f', '#6a1fd0', '#111', '#e8a317']

/** A prestige's badge: an ink seal with its number, gilded at 10. 48 x 48. Prestige 0 draws nothing. */
export function prestigeBadge(prestige: number, size = 40) {
  const p = Math.max(0, Math.min(MAX_PRESTIGE, Math.floor(prestige) || 0))
  if (!p) return ''
  const ink = PRESTIGE_INK[p]
  const points = Array.from({ length: 12 }, (_, i) => {
    const a = i / 12 * Math.PI * 2, r = i % 2 ? 17 : 21
    return `${(24 + Math.sin(a) * r).toFixed(1)},${(24 - Math.cos(a) * r).toFixed(1)}`
  }).join(' ')
  return `<svg class="prestige-badge" viewBox="0 0 48 48" width="${size}" height="${size}" role="img" aria-label="Prestige ${p}">
    <polygon points="${points}" fill="${ink}" stroke="#111" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="24" cy="24" r="12" fill="#fff" stroke="#111" stroke-width="1.8"/>
    ${p === MAX_PRESTIGE ? '<circle cx="24" cy="24" r="14.5" fill="none" stroke="#fff3c9" stroke-width="1.4"/>' : ''}
    <text x="24" y="29" text-anchor="middle" font-size="14" font-weight="800" font-family="Georgia, serif" fill="#111">${p}</text></svg>`
}
