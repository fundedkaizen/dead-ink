import './summary.css'
import type { MenuCopy, MenuState } from '../menu'
import { WEAPON_LABELS } from './cosmetics/challenges'
import { camoSwatch } from './cosmetics/icons'
import { lastReport, type GameReport } from './cosmetics/progression'

/**
 * Dead Ink's game-over page: the round reached (and a New record stamp when it beats the best), the game's
 * numbers, the Ink it paid line by line, and the challenges it completed. The menu adds Play again and
 * Main menu under it. Pass DEAD_INK_GAME_OVER as the menu copy's `gameOver`.
 */

const number = (value: number) => Math.round(value).toLocaleString('en-GB')
const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Before the runtime reports the game (or if it never does), the menu state still has the round, kills,
 * headshots and time: show those, with the Ink those earn, and say nothing about what is unknown.
 */
export function reportFromState(state: MenuState): GameReport {
  const s = state as MenuState & { round?: number; headshots?: number }
  const round = s.round ?? 0, kills = s.kills ?? 0, headshots = s.headshots ?? 0
  return {
    round, kills, headshots, shotsFired: 0, shotsHit: 0, accuracy: null, elapsed: s.elapsed ?? 0, bestWeapon: null,
    inkLines: [
      { label: 'Rounds', detail: `${round} × 10`, ink: round * 10 },
      { label: 'Kills', detail: `${kills} × 1`, ink: kills },
      { label: 'Headshots', detail: `${headshots} × 2`, ink: headshots * 2 },
    ],
    inkTotal: round * 10 + kills + headshots * 2, challenges: [], previousBest: 0, newRecord: false,
  }
}

export function summaryHtml(report: GameReport) {
  const accuracy = report.accuracy === null ? '–' : `${Math.round(report.accuracy * 100)}%`
  const stats: [string, string, string?][] = [
    ['Kills', number(report.kills)],
    ['Headshots', number(report.headshots), report.kills ? `${Math.round(report.headshots / report.kills * 100)}% of kills` : undefined],
    ['Accuracy', accuracy, report.shotsFired ? `${number(report.shotsHit)} of ${number(report.shotsFired)} shots` : undefined],
    ['Time survived', formatTime(report.elapsed)],
    ['Best weapon', report.bestWeapon ? WEAPON_LABELS[report.bestWeapon.weapon] : '–', report.bestWeapon ? `${number(report.bestWeapon.kills)} kills` : undefined],
  ]
  const best = Math.max(report.previousBest, report.round)
  const challenges = report.challenges.length
    ? `<ul class="summary-challenge-list">${report.challenges.map(unlock => `<li>
        <span class="summary-swatch">${unlock.camo ? camoSwatch(unlock.camo) : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c3 5 7 9 7 13a7 7 0 0 1-14 0c0-4 4-8 7-13z" fill="currentColor"/></svg>'}</span>
        <span><b>${escape(unlock.title)}</b><small>${escape(unlock.detail)}</small></span></li>`).join('')}</ul>`
    : '<p class="summary-empty">None this game. Every gun’s camo challenges are in the Armory.</p>'
  return `
    <div class="summary-hero">
      <div class="summary-round">
        <span class="summary-label">Round reached</span>
        <b>${number(report.round)}</b>
        ${report.newRecord ? '<em class="summary-record">New record</em>' : ''}
      </div>
      <div class="summary-best">
        <span class="summary-label">Best round</span>
        <strong>${number(best)}</strong>
        <small>${report.newRecord ? (report.previousBest ? `was ${number(report.previousBest)}` : 'your first') : `${number(best - report.round)} to beat it`}</small>
      </div>
    </div>
    <dl class="summary-stats">${stats.map(([label, value, note]) => `<div><dt>${label}</dt><dd>${value}</dd>${note ? `<dd class="summary-note">${note}</dd>` : ''}</div>`).join('')}</dl>
    <div class="summary-columns">
      <section class="summary-ink" aria-labelledby="summary-ink-title">
        <h3 id="summary-ink-title">Ink earned</h3>
        <table><tbody>
          ${report.inkLines.map(line => `<tr><th scope="row">${escape(line.label)}</th><td class="summary-detail">${escape(line.detail)}</td><td>+${number(line.ink)}</td></tr>`).join('')}
        </tbody><tfoot><tr><th scope="row">Total</th><td></td><td>+${number(report.inkTotal)}</td></tr></tfoot></table>
      </section>
      <section class="summary-challenges" aria-labelledby="summary-challenges-title">
        <h3 id="summary-challenges-title">Challenges completed</h3>
        ${challenges}
      </section>
    </div>`
}

let body: HTMLElement | null = null

/** Render a report into the page now (used by the menu, and to stage the page with made-up numbers). */
export function showSummary(report: GameReport) {
  if (!body) return
  body.innerHTML = summaryHtml(report)
  body.scrollTop = 0
}

export const DEAD_INK_GAME_OVER: NonNullable<MenuCopy['gameOver']> = {
  build: slot => { body = slot; slot.classList.add('summary') },
  show: state => showSummary(lastReport() ?? reportFromState(state)),
}
