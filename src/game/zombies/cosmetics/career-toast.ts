import './career-toast.css'
import { rankBadge, rankName, prestigeBadge } from './career'
import type { LevelUnlock } from './career'
import { synthOutput } from '../../ui-slot-sound'

/**
 * The level-up toast: the new rank badge drawn in, "Level 12", the rank's name and what the level unlocked,
 * sliding in at the top of the screen for a few seconds with a short rising chime. Works over the game (both
 * modes) and over the menus. Does nothing without a document (Node checks).
 */
type Grant = { after: number; unlocks: LevelUnlock[]; refund: number }
let host: HTMLElement | null = null
let hideTimer = 0

function chime() {
  const output = synthOutput('effects', 0.6)
  if (!output) return
  const { context, out } = output, t = context.currentTime
  ;[523.3, 659.3, 784, 1046.5].forEach((f, i) => {
    const tone = context.createOscillator(), gain = context.createGain(), at = t + i * 0.08
    tone.type = 'triangle'; tone.frequency.value = f
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.22, at + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.6)
    tone.connect(gain).connect(out)
    tone.start(at); tone.stop(at + 0.65)
  })
  setTimeout(() => out.disconnect(), 1200)
}

export function showLevelUp(grant: Grant, profile: { prestige: number }) {
  if (typeof document === 'undefined' || !document.body) return
  host ??= Object.assign(document.createElement('div'), { className: 'level-toast' })
  if (!host.isConnected) document.body.append(host)
  host.setAttribute('role', 'status')
  const unlocks = grant.unlocks.map(u => u.label).join(' · ')
  host.innerHTML = `<div class="level-toast-badge">${rankBadge(grant.after, 56)}${prestigeBadge(profile.prestige, 26)}</div>
    <div class="level-toast-text"><small>Level up</small><b>Level ${grant.after}</b><span>${rankName(grant.after)}</span>
    ${unlocks ? `<em>Unlocked: ${unlocks.replace(/[<>&]/g, '')}</em>` : ''}${grant.refund ? `<em>+${grant.refund} Ink for items you had</em>` : ''}</div>`
  host.classList.remove('show')
  void host.offsetWidth
  host.classList.add('show')
  chime()
  clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => host?.classList.remove('show'), 4200)
}
