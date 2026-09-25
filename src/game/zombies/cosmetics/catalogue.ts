import type { Rarity } from '../../loot'
import type { WeaponName } from '../../types'

/**
 * Dead Ink's cosmetics. Looks only: nothing here changes damage, handling or points, so a case can
 * never be a way to buy power.
 *
 * Every item is drawn in the game's ink. Colour appears only where rarity earns it (a gold watch, a
 * golden bullet), the same way loot rarity colours guns.
 */
export type CosmeticKind = 'watch' | 'charm' | 'camo' | 'knife'
/** `challenge`: earned only from challenges (never in a case), and owned per gun rather than outright. */
export type CosmeticItem = { id: string; kind: CosmeticKind; name: string; rarity: Rarity; blurb: string; challenge?: true }

export const WATCHES = ['diver', 'president', 'two-tone', 'tactical', 'diamond', 'skeleton'] as const
export const CHARMS = ['skull', 'dice', 'ink-drop', 'teddy', 'crane', 'golden-bullet', 'ink-heart'] as const
export const CASE_CAMOS = ['stripes', 'woodland', 'digital', 'obsidian', 'gold', 'nebula'] as const
/** Challenge camos, Tier 1 to Tier 4 of each gun's challenges, then Diamond for mastering every gun. */
export const CHALLENGE_CAMOS = ['crosshatch', 'blueprint', 'red-ink', 'black-gold', 'diamond'] as const
export const CAMOS = [...CASE_CAMOS, ...CHALLENGE_CAMOS] as const
export const KNIVES = ['combat', 'bayonet', 'cleaver', 'karambit', 'butterfly', 'heartline'] as const
export type WatchId = typeof WATCHES[number]
export type CharmId = typeof CHARMS[number]
export type CamoId = typeof CAMOS[number]
export type ChallengeCamoId = typeof CHALLENGE_CAMOS[number]
export type KnifeId = typeof KNIVES[number]

/** What the first-person arms wear. `camos` is per gun type; a Pack-a-Punched gun ignores it. */
export type EquippedCosmetics = {
  watch: WatchId | null
  charm: CharmId | null
  camos: Partial<Record<WeaponName, CamoId | null>>
  knife: KnifeId
}
export const NO_COSMETICS: EquippedCosmetics = { watch: null, charm: null, camos: {}, knife: 'combat' }

const item = (kind: CosmeticKind, id: string, name: string, rarity: Rarity, blurb: string): CosmeticItem =>
  ({ id: `${kind}:${id}`, kind, name, rarity, blurb })

function challengeCamo(id: string, name: string, rarity: Rarity, blurb: string): CosmeticItem {
  return { ...item('camo', id, name, rarity, blurb), challenge: true }
}

/** No brand names or logos: these are drawings of kinds of watch, not of anyone's watch. */
export const CATALOGUE: readonly CosmeticItem[] = [
  item('watch', 'tactical', 'Night Shift', 'common', 'Black tactical watch, rubber strap'),
  item('watch', 'diver', 'Deep Water', 'uncommon', 'Steel diver with a turning bezel'),
  item('watch', 'two-tone', 'Half Measures', 'rare', 'Two-tone steel and gold'),
  item('watch', 'president', 'The Oyster', 'epic', 'Solid gold, fluted bezel, three-link bracelet'),
  item('watch', 'diamond', 'Ice Bezel', 'legendary', 'Gold case, a bezel set with diamonds'),
  item('watch', 'skeleton', 'Rose Skeleton', 'mythic', 'Open pink-gold case, every gear turning on show'),
  item('charm', 'dice', 'Loaded Dice', 'common', 'A pair of dice on a chain'),
  item('charm', 'ink-drop', 'Last Drop', 'common', 'A drop of ink, never dry'),
  item('charm', 'crane', 'Paper Crane', 'uncommon', 'Folded from a page of the notebook'),
  item('charm', 'teddy', 'Little Ted', 'rare', 'A tiny teddy bear'),
  item('charm', 'skull', 'Old Friend', 'epic', 'A grinning skull'),
  item('charm', 'golden-bullet', 'Golden Bullet', 'legendary', 'The one with your name on it'),
  item('charm', 'ink-heart', 'Ink Heart', 'mythic', 'A locket holding a heart of ink that glows'),
  item('camo', 'stripes', 'Tiger Ink', 'common', 'Hand-drawn tiger stripes'),
  item('camo', 'woodland', 'Woodland Ink', 'uncommon', 'Blotted woodland pattern'),
  item('camo', 'digital', 'Pixel Grid', 'rare', 'Squared-off digital pattern'),
  item('camo', 'obsidian', 'Obsidian', 'epic', 'Black glass with pale veins'),
  item('camo', 'gold', 'Gold Leaf', 'legendary', 'Every paper face gilded'),
  item('camo', 'nebula', 'Ink Nebula', 'mythic', 'Pink and violet ink swirling, full of stars'),
  challengeCamo('crosshatch', 'Crosshatch', 'uncommon', 'Dense pen hatching, drawn over and over'),
  challengeCamo('blueprint', 'Blueprint', 'rare', 'White construction lines on blue paper'),
  challengeCamo('red-ink', 'Red Ink', 'epic', 'Paper soaked through with red'),
  challengeCamo('black-gold', 'Black Gold', 'legendary', 'Black lacquer veined with gold'),
  challengeCamo('diamond', 'Diamond', 'legendary', 'Cut facets that catch the light'),
  item('knife', 'combat', 'Combat Knife', 'common', 'The knife you start with'),
  item('knife', 'bayonet', 'Bayonet', 'uncommon', 'Long fullered blade with a muzzle ring'),
  item('knife', 'cleaver', 'Cleaver', 'rare', 'Heavy square blade'),
  item('knife', 'karambit', 'Karambit', 'epic', 'Curved claw blade with a finger ring'),
  item('knife', 'butterfly', 'Butterfly', 'legendary', 'Two handles that flip open'),
  item('knife', 'heartline', 'Heartline', 'mythic', 'A karambit whose edge glows pink'),
]

/** Owned from the first game, so the Armory is never empty and the knife always has a skin. */
export const STARTING_ITEMS = ['knife:combat']

export const cosmeticById = (id: string) => CATALOGUE.find(entry => entry.id === id)
export const isChallengeCamo = (id: string): id is ChallengeCamoId => (CHALLENGE_CAMOS as readonly string[]).includes(id)
/** 'watch:diver' -> 'diver'. */
export const cosmeticKey = (id: string) => id.slice(id.indexOf(':') + 1)
