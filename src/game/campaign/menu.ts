import type { MenuCopy, MenuState } from '../menu'
import type { MissionRuntime } from '../runtime'
import type { MissionState } from '../mission'
import { DIFFICULTIES, DIFFICULTY_LABELS, type Difficulty, type MapModule, type MissionDef } from './types'
import { MISSIONS, mapFor } from './missions'
import { formatTime } from './progress'
import { STEALTH_BLURBS } from './stealth'
import { rulesFor } from './difficulty'

/**
 * The campaign on the pause menu: a Missions page (every mission in order, locked or open, its stars and best
 * time on each difficulty, a small map of it and its briefing, and Play), the current mission under the title,
 * and the summary when a mission is won (time, stars, how quietly, the awards, Ink and XP, Next mission).
 */
const star = (on: boolean) => `<span class="${on ? '' : 'off'}">★</span>`
const escape = (text: string) => text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

export function campaignMenuCopy(r: MissionRuntime, copy: MenuCopy): MenuCopy {
  let page: HTMLElement | null = null, home: HTMLElement | null = null
  let chosen: string | null = null, difficulty: Difficulty = 'normal'
  let lastHome = ''
  const campaign = () => r.campaign!

  const renderPage = () => {
    if (!page) return
    const store = campaign().store
    chosen ??= campaign().mission.id
    const mission = MISSIONS.find(m => m.id === chosen) ?? MISSIONS[0]
    const guest = !!r.coop?.isGuest && !!r.coop.paired
    const list = MISSIONS.map(m => {
      const open = store.isUnlocked(m.id)
      const stars = DIFFICULTIES.map(d => store.best(m.id, d)?.stars ?? [false, false, false]).flat()
      return `<li><button type="button" class="campaign-mission" data-mission="${m.id}" aria-pressed="${m.id === mission.id}" ${open ? '' : 'disabled'}>
        <span class="number">${m.number}</span>
        <span><strong>${escape(m.name)}</strong><small>${open ? `${escape(m.estimate)} · ${campaign().store.best(m.id, difficulty) ? `best ${formatTime(campaign().store.best(m.id, difficulty)!.time)} on ${DIFFICULTY_LABELS[difficulty]}` : 'not finished yet'}` : `Locked · finish mission ${m.number - 1} to open it`}</small></span>
        <span class="stars" aria-label="${stars.filter(Boolean).length} of 9 stars">${stars.map(star).join('')}</span></button></li>`
    }).join('')
    const bests = DIFFICULTIES.map(d => {
      const best = store.best(mission.id, d)
      return `<div><dt>${DIFFICULTY_LABELS[d]}</dt><dd>${best ? `${formatTime(best.time)} ${best.stars.map(star).join('')}` : '—'}</dd></div>`
    }).join('')
    page.innerHTML = `<div class="campaign-page">
      <div class="campaign-difficulty" role="group" aria-label="Difficulty">${DIFFICULTIES.map(d => `<button type="button" data-difficulty="${d}" aria-pressed="${d === difficulty}">${DIFFICULTY_LABELS[d]}</button>`).join('')}</div>
      <p class="campaign-legend">${difficultyNote(difficulty)}</p>
      <ol class="campaign-list">${list}</ol>
      <div class="campaign-detail">
        <div>${previewSvg(mission, mapFor(mission))}<p class="campaign-legend"><span>▲ Way in</span><span>□ Where he may be held</span><span>✚ Way out</span><span>● Objectives</span></p></div>
        <div><p><b>${mission.number}. ${escape(mission.name)}</b> · ${escape(mission.estimate)}</p><p>${escape(mission.briefing)}</p>
          <p>Stars: finish under ${formatTime(mission.par[difficulty])} · never raise the alarm · the hostage never hurt.</p>
          <dl class="campaign-bests">${bests}</dl>
          <div class="mission-actions">${guest ? '<p>The host picks the mission; yours follows theirs.</p>' : `<button type="button" class="menu-primary" data-play ${store.isUnlocked(mission.id) ? '' : 'disabled'}>Play ${escape(mission.name)} · ${DIFFICULTY_LABELS[difficulty]}</button>`}</div>
        </div>
      </div></div>`
  }

  const renderHome = () => {
    if (!home) return
    const c = campaign(), run = r.state.run
    let html = ''
    if (c.loading || !r.ready) html = '<div class="campaign-home"><p class="campaign-now">Loading the mission…</p></div>'
    else if (r.state.phase === 'complete' && c.summary) {
      const s = c.summary
      const next = c.next()
      html = `<div class="campaign-home campaign-summary">
        <p class="stars" aria-label="${s.stars.filter(Boolean).length} of 3 stars">${s.stars.map(star).join('')}</p>
        <p class="campaign-now"><b>${escape(s.mission.name)}</b> on ${DIFFICULTY_LABELS[s.difficulty]} · <b>${s.rating}</b>: ${STEALTH_BLURBS[s.rating]}</p>
        <p class="campaign-now">${s.best ? 'A new best time. ' : ''}+${s.ink} Ink · +${s.xp} XP${s.unlocked ? ` · <b>${escape(MISSIONS.find(m => m.id === s.unlocked)?.name ?? '')}</b> is open` : ''}</p>
        ${s.awards.length ? `<ul>${s.awards.map(a => `<li>${escape(a)}</li>`).join('')}</ul>` : ''}
        ${next && !(r.coop?.isGuest && r.coop.paired) ? `<button type="button" class="menu-secondary" data-next="${next}">Next mission: ${escape(MISSIONS.find(m => m.id === next)!.name)}</button>` : ''}
        <button type="button" class="menu-quiet" data-open-missions>All missions</button></div>`
    } else if (run) {
      html = `<div class="campaign-home"><p class="campaign-now">Mission ${c.mission.number} of ${MISSIONS.length}: <b>${escape(c.mission.name)}</b> · ${DIFFICULTY_LABELS[run.difficulty]} · ${escape(c.mission.estimate)}</p>
        ${r.state.elapsed < 1 ? `<p class="campaign-now">${escape(c.mission.briefing)}</p>` : ''}
        <button type="button" class="menu-quiet" data-open-missions>Missions and difficulty</button></div>`
    }
    if (html === lastHome) return
    lastHome = html
    home.innerHTML = html
    renderField()
  }

  /** The Mission page (M): this mission's name, its stages so far, and its tips, over the field map. */
  let lastField = ''
  const renderField = () => {
    const c = campaign(), run = r.state.run
    const page = document.querySelector<HTMLElement>('[data-menu-page="mission"]')
    if (!page || !run) return
    const stages = c.mission.stages.map((stage, i) => `<li class="${i < run.stage ? 'done' : i === run.stage ? 'now' : ''}">${escape(stage.title)}</li>`).join('')
    const html = `<summary>${escape(c.mission.name)}: stages and tips</summary><p>${escape(c.mission.briefing)}</p><ol class="campaign-stages">${stages}</ol>
      <p>Crouch (C) to move quietly and stay low; lean round corners (Q, E); a guard's eye fills as he grows sure of you. Throw a stone (T) to pull a guard away, fly the drone (X) to mark the guards, take them down from behind (F), and breach a locked door (B). Tell ${escape(c.mission.hostageName)} to wait or follow (H).</p>`
    if (html === lastField) return
    lastField = html
    const tips = page.querySelector<HTMLDetailsElement>('.mission-tips')
    if (tips) { tips.innerHTML = html; tips.open = true }
    const title = page.querySelector<HTMLElement>('#mission-page-title')
    if (title) title.textContent = `Mission ${c.mission.number}: ${c.mission.name}`
  }

  const play = async (id: string, d: Difficulty) => {
    if (r.coop?.isGuest && r.coop.paired) return
    campaign().store.select(id, d)
    // Already loaded and not yet begun: nothing to reload.
    const fresh = campaign().mission.id === id && campaign().run?.difficulty === d && r.state.phase === 'active' && r.state.elapsed < 1
    if (!fresh) await r.loadMission(id, d)
    chosen = id; difficulty = d
    renderPage()
    lastHome = ''
    // Back to the home page, where Begin mission starts it.
    document.querySelector<HTMLElement>('[data-menu-page="campaign"] [data-menu-back]')?.click()
  }

  const pageDef = {
    id: 'campaign', label: 'Missions', title: 'Missions',
    build: (body: HTMLElement) => {
      page = body
      body.addEventListener('click', event => {
        const target = event.target as HTMLElement
        const pick = target.closest<HTMLElement>('[data-mission]')
        if (pick && !(pick as HTMLButtonElement).disabled) { chosen = pick.dataset.mission!; renderPage(); return }
        const level = target.closest<HTMLElement>('[data-difficulty]')
        if (level) { difficulty = level.dataset.difficulty as Difficulty; renderPage(); return }
        if (target.closest('[data-play]') && chosen) void play(chosen, difficulty)
      })
    },
    show: () => { chosen = campaign().mission.id; difficulty = campaign().run?.difficulty ?? campaign().store.load().difficulty; renderPage() },
  }

  const result: MenuCopy = {
    ...copy,
    pages: [pageDef, ...(copy.pages ?? [])],
    home: slot => {
      home = slot
      slot.addEventListener('click', event => {
        const target = event.target as HTMLElement
        const next = target.closest<HTMLElement>('[data-next]')?.dataset.next
        if (next) { void play(next, campaign().run?.difficulty ?? 'normal'); return }
        if (target.closest('[data-open-missions]')) document.querySelector<HTMLElement>('[data-menu-open="campaign"]')?.click()
      })
      renderHome()
    },
    recap: (state: MenuState) => {
      const s = campaign().summary
      const full = state as MissionState
      if (!s) return [['Time', formatTime(full.elapsed)], ['Kills', String(full.kills)], ['Health', `${Math.ceil(full.health)}%`]]
      return [['Time', formatTime(s.time)], ['Stealth', s.rating], ['Hostage', `${s.hostageHealth}%`], ['Kills', String(s.kills)], ['Takedowns', String(s.stats.takedowns)], ['Alarms', String(s.stats.alarms)]]
    },
    controls: [...(copy.controls ?? []), ['Crouch', 'C'], ['Lean', 'Q / E (not aiming)'], ['Throw a stone', 'T'], ['Breach charge', 'B'], ['Hostage: wait / follow', 'H'],
      ['Scout drone', 'X'], ['Ping / mark', 'Middle mouse or Z'], ['Takedown (behind a guard)', 'F']],
  }
  // The premise under the title names the mission in play.
  Object.defineProperty(result, 'premise', { get: () => {
    const c = r.campaign
    return c?.run ? `Find ${c.mission.hostageName}. Get out together.` : copy.premise
  } })
  // The home slot follows the game (the menu calls update every frame it shows).
  r.menuRefresh = renderHome
  return result
}

function difficultyNote(difficulty: Difficulty) {
  const rules = rulesFor(difficulty)
  return difficulty === 'normal' ? 'Normal: the guards take a moment to be sure of what they see.'
    : difficulty === 'hard' ? `Hard: more guards and dogs, sharper eyes and aim, ${rules.reinforcements} reinforcements, the hostage has ${rules.hostageHealth} health. Rewards ×${rules.reward}.`
    : `Nightmare: the full night garrison, quick to notice, deadly aim, ${rules.reinforcements} reinforcements, the hostage has ${rules.hostageHealth} health. Rewards ×${rules.reward}.`
}

/** A small plan of the mission: buildings, the ways in, the cells he may be in, the way out, the objectives. */
export function previewSvg(mission: MissionDef, map: MapModule) {
  const { minX, maxX, minZ, maxZ } = map.preview.bounds
  const width = 300, scale = width / (maxX - minX), height = Math.round((maxZ - minZ) * scale)
  const x = (v: number) => ((v - minX) * scale).toFixed(1), z = (v: number) => ((v - minZ) * scale).toFixed(1)
  const buildings = map.preview.buildings.map(([bx, bz, w, d]) => `<rect x="${x(bx - w / 2)}" y="${z(bz - d / 2)}" width="${(w * scale).toFixed(1)}" height="${(d * scale).toFixed(1)}" fill="#f4f4f4" stroke="#9a9a9a" stroke-width="0.8"/>`).join('')
  const spawns = mission.spawns.map(id => map.spawns[id]).filter(Boolean).map(s => `<path d="M${x(s.position[0])} ${(+z(s.position[2]) - 5).toFixed(1)}l4 7h-8z" fill="#111"/>`).join('')
  const cells = mission.cells.map(id => map.cells[id]).filter(Boolean).map(c => `<rect x="${(+x(c.hostage[0]) - 3).toFixed(1)}" y="${(+z(c.hostage[2]) - 3).toFixed(1)}" width="6" height="6" fill="none" stroke="#2878d0" stroke-width="1.4"/>`).join('')
  const out = map.extractions[mission.extraction]
  // The way out's label sits on whichever side of its mark has room.
  const flip = out ? +x(out.park[0]) > width - 60 : false
  const exit = out ? `<g transform="translate(${x(out.park[0])},${z(out.park[2])})"><circle r="6" fill="#fff" stroke="#111" stroke-width="1.2"/><path d="M-3 0h6M0 -3v6" stroke="#111" stroke-width="1.6"/></g><text text-anchor="${flip ? 'end' : 'start'}" x="${(+x(out.park[0]) + (flip ? -8 : 8)).toFixed(1)}" y="${(+z(out.park[2]) + 3).toFixed(1)}">${out.kind === 'jeep' ? 'Jeep' : out.kind === 'boat' ? 'Boat' : 'Helicopter'}</text>` : ''
  const panels = mission.panels.map(id => map.panels[id]).filter(p => p && ['power', 'intel', 'twokey'].includes(p.kind)).map(p => `<circle cx="${x(p.position[0])}" cy="${z(p.position[2])}" r="2.4" fill="#111"/>`).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Map of ${mission.name}: north is up">${buildings}${cells}${panels}${spawns}${exit}</svg>`
}
