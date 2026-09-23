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
export type CosmeticItem = { id: string; kind: CosmeticKind; name: string; rarity: Rarity; blurb: string }

export const WATCHES = ['diver', 'president', 'two-tone', 'tactical', 'diamond'] as const
export const CHARMS = ['skull', 'dice', 'ink-drop', 'teddy', 'crane', 'golden-bullet'] as const
export const CAMOS = ['stripes', 'woodland', 'digital', 'obsidian', 'gold'] as const
export const KNIVES = ['combat', 'bayonet', 'cleaver', 'karambit', 'butterfly'] as const
export type WatchId = typeof WATCHES[number]
export type CharmId = typeof CHARMS[number]
export type CamoId = typeof CAMOS[number]
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

/** No brand names or logos: these are drawings of kinds of watch, not of anyone's watch. */
export const CATALOGUE: readonly CosmeticItem[] = [
  item('watch', 'tactical', 'Night Shift', 'common', 'Black tactical watch, rubber strap'),
  item('watch', 'diver', 'Deep Water', 'uncommon', 'Steel diver with a turning bezel'),
  item('watch', 'two-tone', 'Half Measures', 'rare', 'Two-tone steel and gold'),
  item('watch', 'president', 'The Oyster', 'epic', 'Solid gold, fluted bezel, three-link bracelet'),
  item('watch', 'diamond', 'Ice Bezel', 'legendary', 'Gold case, a bezel set with diamonds'),
  item('charm', 'dice', 'Loaded Dice', 'common', 'A pair of dice on a chain'),
  item('charm', 'ink-drop', 'Last Drop', 'common', 'A drop of ink, never dry'),
  item('charm', 'crane', 'Paper Crane', 'uncommon', 'Folded from a page of the notebook'),
  item('charm', 'teddy', 'Little Ted', 'rare', 'A tiny teddy bear'),
  item('charm', 'skull', 'Old Friend', 'epic', 'A grinning skull'),
  item('charm', 'golden-bullet', 'Golden Bullet', 'legendary', 'The one with your name on it'),
  item('camo', 'stripes', 'Tiger Ink', 'common', 'Hand-drawn tiger stripes'),
  item('camo', 'woodland', 'Woodland Ink', 'uncommon', 'Blotted woodland pattern'),
  item('camo', 'digital', 'Pixel Grid', 'rare', 'Squared-off digital pattern'),
  item('camo', 'obsidian', 'Obsidian', 'epic', 'Black glass with pale veins'),
  item('camo', 'gold', 'Gold Leaf', 'legendary', 'Every paper face gilded'),
  item('knife', 'combat', 'Combat Knife', 'common', 'The knife you start with'),
  item('knife', 'bayonet', 'Bayonet', 'uncommon', 'Long fullered blade with a muzzle ring'),
  item('knife', 'cleaver', 'Cleaver', 'rare', 'Heavy square blade'),
  item('knife', 'karambit', 'Karambit', 'epic', 'Curved claw blade with a finger ring'),
  item('knife', 'butterfly', 'Butterfly', 'legendary', 'Two handles that flip open'),
]

/** Owned from the first game, so the Armory is never empty and the knife always has a skin. */
export const STARTING_ITEMS = ['knife:combat']

export const cosmeticById = (id: string) => CATALOGUE.find(entry => entry.id === id)
/** 'watch:diver' -> 'diver'. */
export const cosmeticKey = (id: string) => id.slice(id.indexOf(':') + 1)
