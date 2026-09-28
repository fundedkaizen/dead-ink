/**
 * End-of-game awards, for both modes: Most kills, Headhunter, Best reviver, Big spender, Clutch, Doll master
 * and the rest. Each player gets their best one or two, shown in their colour. In co-op the host works them
 * out from every player's numbers and sends the result to everyone, so every screen shows the same awards.
 *
 * ```ts
 * const results = awardsFor([
 *   { player: 0, name: 'Kai', color: '#2878d0', values: { kills: 212, headshots: 60, revives: 3 } },
 *   { player: 1, name: 'Ana', color: '#2e9b45', values: { kills: 180, headshots: 71, spent: 24000 } },
 * ])                        // Dead Ink's awards; a mode passes its own list as the second argument
 * // results[i] = { player, name, color, awards: [{ id, title, detail }] } in player order
 * ```
 *
 * Pure: no storage, no DOM. Values a player has no number for simply do not count for them.
 */
export type AwardValues = Partial<Record<string, number>>
export type AwardStats = { player: number; name: string; color?: string; values: AwardValues }
export type AwardDef = {
  id: string
  title: string
  /** The line under the title, from the winning number. */
  detail: (value: number) => string
  /** Which number decides it, and whether more or less is better. */
  stat: string
  better: 'high' | 'low'
  /** The least a winner needs (a high award), so nobody wins "Most headshots" with one. */
  min?: number
  /** Only in a game with two players or more (Best reviver makes no sense alone). */
  team?: boolean
}
export type Award = { id: string; title: string; detail: string }
export type PlayerAwards = { player: number; name: string; color?: string; awards: Award[] }

const n = (value: number) => Math.round(value).toLocaleString('en-GB')

/** Dead Ink's awards, most prized first (a tie in strength goes to the one higher up). */
export const ZOMBIE_AWARDS: readonly AwardDef[] = [
  { id: 'kills', title: 'Most kills', stat: 'kills', better: 'high', min: 1, detail: v => `${n(v)} kills` },
  { id: 'clutch', title: 'Clutch', stat: 'clutch', better: 'high', min: 3, detail: v => `${n(v)} kills with their back to the wall` },
  { id: 'revives', title: 'Best reviver', stat: 'revives', better: 'high', min: 1, team: true, detail: v => `${n(v)} teammate${v === 1 ? '' : 's'} picked up` },
  { id: 'headshots', title: 'Headhunter', stat: 'headshots', better: 'high', min: 5, detail: v => `${n(v)} headshot kills` },
  { id: 'wonder', title: 'Wonder worker', stat: 'wonderKills', better: 'high', min: 5, detail: v => `${n(v)} kills with a wonder weapon` },
  { id: 'dolls', title: 'Doll master', stat: 'dollKills', better: 'high', min: 3, detail: v => `${n(v)} kills with Ink Dolls` },
  { id: 'boom', title: 'Demolition', stat: 'explosiveKills', better: 'high', min: 10, detail: v => `${n(v)} kills with explosives` },
  { id: 'spent', title: 'Big spender', stat: 'spent', better: 'high', min: 1000, detail: v => `${n(v)} points spent` },
  { id: 'accuracy', title: 'Sharpshooter', stat: 'accuracy', better: 'high', min: 35, detail: v => `${n(v)}% of shots hit` },
  { id: 'knife', title: 'Up close', stat: 'knifeKills', better: 'high', min: 5, detail: v => `${n(v)} knife kills` },
  { id: 'planks', title: 'Carpenter', stat: 'planks', better: 'high', min: 5, detail: v => `${n(v)} planks nailed back` },
  { id: 'box', title: 'Box addict', stat: 'boxSpins', better: 'high', min: 3, detail: v => `${n(v)} spins of the box` },
  { id: 'survivor', title: 'Survivor', stat: 'downs', better: 'low', team: true, detail: v => v === 0 ? 'never went down' : `down only ${n(v)} time${v === 1 ? '' : 's'}` },
]

/** Given to a player who won nothing, so every player has at least one. */
export const STILL_STANDING = (kills: number): Award => ({ id: 'standing', title: 'In it together', detail: `${n(kills)} kills for the team` })

/**
 * Every player's best one or two awards. An award goes to whoever has the best number for it (tied players
 * both win it). A player who wins several keeps the ones they won by the widest margin; one who wins none
 * gets "In it together".
 */
export function awardsFor(stats: readonly AwardStats[], defs: readonly AwardDef[] = ZOMBIE_AWARDS, perPlayer = 2): PlayerAwards[] {
  const players = [...stats].sort((a, b) => a.player - b.player)
  const won = new Map<number, { award: Award; strength: number; order: number }[]>()
  defs.forEach((def, order) => {
    if (def.team && players.length < 2) return
    const entries = players.map(p => ({ p, v: p.values[def.stat] }))
      .filter((e): e is { p: AwardStats; v: number } => typeof e.v === 'number' && Number.isFinite(e.v) && (def.better === 'low' || e.v >= (def.min ?? 0)))
    if (!entries.length || (def.better === 'high' && entries.every(e => e.v <= 0))) return
    entries.sort((a, b) => def.better === 'high' ? b.v - a.v : a.v - b.v)
    const best = entries[0].v, runnerUp = entries.find(e => e.v !== best)?.v
    // How convincingly it was won: against the runner-up, or the award's minimum when nobody came close.
    const strength = def.better === 'high' ? best / Math.max(1, runnerUp ?? def.min ?? 1) : (Math.max(0, runnerUp ?? best * 2) + 1) / (best + 1)
    for (const entry of entries.filter(e => e.v === best)) {
      const list = won.get(entry.p.player) ?? []
      list.push({ award: { id: def.id, title: def.title, detail: def.detail(best) }, strength, order })
      won.set(entry.p.player, list)
    }
  })
  return players.map(p => {
    const list = (won.get(p.player) ?? []).sort((a, b) => b.strength - a.strength || a.order - b.order).slice(0, Math.max(1, perPlayer))
    return { player: p.player, name: p.name, color: p.color, awards: list.length ? list.map(w => w.award) : [STILL_STANDING(p.values.kills ?? 0)] }
  })
}

/** Stored or received awards are untrusted: keep only well-formed ones, at most four players of two each. */
export function sanitizeAwards(raw: unknown): PlayerAwards[] {
  if (!Array.isArray(raw)) return []
  const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : ''
  return raw.slice(0, 4).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const e = entry as Record<string, unknown>
    const player = Number(e.player)
    if (!Number.isInteger(player) || player < 0 || player > 3 || !Array.isArray(e.awards)) return []
    const awards = e.awards.slice(0, 2).flatMap(a => a && typeof a === 'object' && typeof (a as Award).title === 'string'
      ? [{ id: text((a as Award).id, 24), title: text((a as Award).title, 40), detail: text((a as Award).detail, 80) }] : [])
    return [{ player, name: text(e.name, 16) || `Player ${player + 1}`, color: /^#[0-9a-f]{6}$/i.test(String(e.color)) ? String(e.color) : undefined, awards }]
  })
}
