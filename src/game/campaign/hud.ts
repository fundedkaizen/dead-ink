import * as THREE from 'three'
import { StandBar } from '../shared/coop'
import { WorldMarker } from '../zombies/markers'
import type { MissionRuntime } from '../runtime'
import { currentStage, HOSTAGE_BLEED_SECONDS } from './run'
import './campaign.css'

/**
 * The campaign's heads-up display, over the mission HUD: the stage and its objectives (top left), each freed
 * hostage's health and whether he follows or waits (top middle), your tools and stance (bottom), a marker on
 * the objective and on the hostage once you know where he is, a small eye over every guard who is growing
 * suspicious (it fills as he gets surer, red when he is sure), the team's spotter marks, the bar for a held
 * action, and on a touch screen the buttons for crouch, the hostage and a stone.
 */
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12c3-5 7-7 10-7s7 2 10 7c-3 5-7 7-10 7S5 17 2 12z" fill="#fff"/><circle cx="12" cy="12" r="3.4"/></svg>'
const TARGET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 9-7 9-7-9z"/></svg>'
const PERSON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6.5" r="3.4" fill="#2878d0"/><path d="M6 21c0-5 2.5-8 6-8s6 3 6 8z" fill="#2878d0"/></svg>'
const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l8 14H4z" fill="#d4332a"/></svg>'

type Suspicion = { element: HTMLElement; ring: SVGCircleElement }

export class CampaignHud {
  private root = document.createElement('div')
  private objectives = document.createElement('section')
  private hostages = document.createElement('section')
  private tools = document.createElement('div')
  private toast = document.createElement('div')
  private touch = document.createElement('div')
  private bar: StandBar
  private objectiveMarker: WorldMarker
  private hostageMarkers: WorldMarker[] = []
  private suspicion: Suspicion[] = []
  private marks: WorldMarker[] = []
  private toastTimer = 0
  private lastObjectives = ''
  private lastHostages = ''
  private lastTools = ''
  private projected = new THREE.Vector3()
  private abort = new AbortController()

  constructor(private r: MissionRuntime, parent: HTMLElement) {
    this.root.className = 'campaign-hud'
    this.objectives.className = 'campaign-objectives'
    this.objectives.setAttribute('aria-live', 'polite')
    this.hostages.className = 'campaign-hostages'
    this.tools.className = 'campaign-tools'
    this.toast.className = 'campaign-toast'
    this.toast.setAttribute('role', 'status')
    this.toast.hidden = true
    this.touch.className = 'campaign-touch'
    this.touch.innerHTML = '<button type="button" data-key="KeyC">Crouch</button><button type="button" data-key="KeyH">Wait / Follow</button><button type="button" data-key="KeyT">Stone</button><button type="button" data-key="KeyX">Drone</button>'
    this.root.append(this.objectives, this.hostages, this.tools, this.toast, this.touch)
    parent.append(this.root)
    this.bar = new StandBar(this.root)
    this.objectiveMarker = new WorldMarker(this.root, TARGET, 'Objective', 3)
    this.objectiveMarker.element.classList.add('campaign-waypoint')
    // Touch: each button presses its key, for players without a keyboard.
    this.touch.addEventListener('click', event => {
      const key = (event.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key
      if (!key) return
      r.tools?.key(new KeyboardEvent('keydown', { code: key }))
    }, { signal: this.abort.signal })
  }

  /** A line in the middle of the screen for a few seconds (stage changes, keycards, the helicopter). */
  say(text: string, seconds = 4) {
    this.toast.textContent = text
    this.toast.hidden = false
    this.toastTimer = seconds
  }

  update(dt: number) {
    const r = this.r, campaign = r.campaign, run = r.state.run
    const show = !!campaign && !!run && r.player.enabled && r.player.playing && !r.escape.active && r.state.phase === 'active'
    this.root.hidden = !show
    if (!r.player.playing) r.menuRefresh?.()
    if ((this.toastTimer -= dt) <= 0) this.toast.hidden = true
    if (!show || !campaign || !run) { this.hideMarkers(); return }
    const mission = campaign.mission
    // Objectives.
    const stage = currentStage(mission, run)
    const noun = campaign.extraction.kind === 'boat' ? 'Boat' : 'Helicopter'
    const eta = run.called && !run.arrived ? `<p class="campaign-eta">${noun}: ${Math.ceil(run.eta)} s${this.inZone() ? '' : ` · <b>get on the ${noun === 'Boat' ? 'slipway' : 'landing zone'}, the clock is paused</b>`}</p>` : ''
    const objectives = `<p class="campaign-stage">${mission.name} · stage ${Math.min(run.stage + 1, mission.stages.length)} of ${mission.stages.length}</p>
      <h3>${stage.title}</h3><ul>${stage.objectives.map(o => `<li class="${run.done.includes(o.id) ? 'done' : ''}${o.optional ? ' optional' : ''}">${o.text}${o.optional ? ' <i>(optional)</i>' : ''}</li>`).join('')}</ul>${eta}`
    if (objectives !== this.lastObjectives) { this.objectives.innerHTML = objectives; this.lastObjectives = objectives }
    // Hostages.
    const names = mission.hostageName.split(' and ')
    const hostages = r.state.hostages.map((hostage, index) => {
      const vitals = run.hostages[index]
      if (!vitals || hostage.status === 'captive') return ''
      const status = vitals.down === 2 ? 'Dead' : vitals.down ? `Down · ${Math.ceil(vitals.bleed)} s` : hostage.status === 'loaded' ? 'Aboard' : vitals.waiting ? 'Waiting (H: follow)' : 'Following (H: wait)'
      const fraction = vitals.down ? vitals.bleed / HOSTAGE_BLEED_SECONDS : vitals.health / vitals.max
      return `<div class="campaign-hostage${vitals.down ? ' down' : ''}"><span>${names[index] ?? names[0]}</span><div><i style="transform:scaleX(${fraction.toFixed(3)})"></i></div><small>${status}</small></div>`
    }).join('')
    if (hostages !== this.lastHostages) { this.hostages.innerHTML = hostages; this.lastHostages = hostages }
    // Tools.
    const t = r.tools
    const drone = !mission.tools.drone ? '' : t?.flying ? `Drone ${Math.ceil(t.drone)} s (X lands)` : t && t.cooldown > 0 ? `Drone ${Math.ceil(t.cooldown)} s` : 'Drone ready (X)'
    const tools = [t?.crouched ? '<b>Crouched</b> (C)' : 'Standing (C)', `Stones ${campaign.stones} (T)`, `Charges ${campaign.charges} (B)`, drone, r.weapons.current?.suppressed ? 'Suppressed' : '']
      .filter(Boolean).join(' · ')
    if (tools !== this.lastTools) { this.tools.innerHTML = tools; this.lastTools = tools }
    // The held action.
    const hold = campaign.hold
    this.bar.show(hold ? hold.label : null, hold ? hold.elapsed / hold.seconds : 0)
    // Markers: the objective, the hostages, the suspicious guards, the spotter marks.
    this.objectiveMarker.update(r.view, this.objectivePoint())
    this.updateHostageMarkers()
    this.updateSuspicion()
    this.updateMarks()
  }

  private inZone() {
    const campaign = this.r.campaign!, zone = campaign.extraction.zone, feet = this.r.player.body.position
    return Math.hypot(feet.x - zone.x, feet.z - zone.z) <= zone.r
  }

  /** Where the current objective is: the panel to use, the zone to reach, the way out. */
  private objectivePoint(): THREE.Vector3 | null {
    const r = this.r, campaign = r.campaign!, run = r.state.run!, mission = campaign.mission
    const stage = currentStage(mission, run)
    const open = stage.objectives.find(o => !o.optional && !run.done.includes(o.id)) ?? stage.objectives.find(o => !run.done.includes(o.id))
    if (!open) return null
    const map = campaign.map
    switch (open.kind) {
      case 'reach': { const zone = open.zone ? map.zones[open.zone] : undefined; return zone ? new THREE.Vector3(zone.x, 1.5, zone.z) : null }
      case 'use': {
        const feet = r.player.body.position
        // A keycard is to be searched for: its marker shows only once the intel has told you where it is.
        if ((open.panels ?? []).every(id => map.panels[id]?.kind === 'keycard') && !run.revealed) return null
        const stations = r.world.stations.filter(station => (open.panels ?? []).includes(station.id) && station.object.visible !== false)
        stations.sort((a, b) => a.point.distanceTo(feet) - b.point.distanceTo(feet))
        return stations[0]?.point.clone() ?? null
      }
      case 'find': case 'free': return null
      case 'call': return campaign.extraction.call ? new THREE.Vector3(...campaign.extraction.call.position).setY(1.4) : null
      case 'defend': case 'escort': case 'extract': return new THREE.Vector3(...campaign.extraction.board).setY(1.5)
    }
  }

  private updateHostageMarkers() {
    const r = this.r, run = r.state.run!
    while (this.hostageMarkers.length < r.state.hostages.length) {
      const marker = new WorldMarker(this.root, PERSON, 'Hostage', 3)
      marker.element.classList.add('campaign-hostage-marker')
      this.hostageMarkers.push(marker)
    }
    this.hostageMarkers.forEach((marker, index) => {
      const hostage = r.state.hostages[index]
      const known = !!hostage && (hostage.status !== 'captive' ? hostage.status === 'following' : run.revealed || run.found[index])
      const far = hostage && new THREE.Vector3(...hostage.position).distanceTo(r.player.body.position) > 6
      marker.update(r.view, hostage && known && (far || run.hostages[index]?.down) ? new THREE.Vector3(...hostage.position).setY(hostage.position[1] + 2) : null)
      marker.element.classList.toggle('down', !!run.hostages[index]?.down)
    })
  }

  /** An eye over each guard who is growing suspicious: its ring fills as he gets surer. */
  private updateSuspicion() {
    const r = this.r, enemies = r.ai.enemies, camera = r.view
    while (this.suspicion.length < enemies.length) {
      const element = document.createElement('div')
      element.className = 'campaign-eye'
      element.innerHTML = `${EYE}<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" pathLength="100"/></svg>`
      element.hidden = true
      this.root.append(element)
      this.suspicion.push({ element, ring: element.querySelector('.ring circle')! })
    }
    this.suspicion.forEach((entry, index) => {
      const enemy = enemies[index]
      const level = enemy && !['dead', 'reserve'].includes(enemy.state) ? enemy.state === 'combat' ? 1 : enemy.awareness : 0
      const show = level > 0.04 && enemy.position.distanceTo(camera.position) < 70
      const point = show ? this.projected.copy(enemy.position).setY(enemy.position.y + 2.15).project(camera) : null
      if (!point || point.z > 1 || Math.abs(point.x) > 1.05 || Math.abs(point.y) > 1.05) { entry.element.hidden = true; return }
      entry.element.hidden = false
      entry.element.style.transform = `translate(${((point.x + 1) / 2 * innerWidth).toFixed(1)}px, ${((1 - point.y) / 2 * innerHeight).toFixed(1)}px)`
      entry.element.classList.toggle('sure', level >= 0.7)
      entry.ring.style.strokeDasharray = `${(level * 100).toFixed(1)} 100`
    })
  }

  /** The team's spotter marks (the scout drone's, and pings' marks on guards): a red triangle through walls. */
  private updateMarks() {
    const r = this.r, run = r.state.run!
    const marks = (run.marks ?? []).filter(mark => mark.kind === 'guard' && mark.until > r.state.elapsed)
    while (this.marks.length < marks.length) {
      const marker = new WorldMarker(this.root, MARK, 'Marked guard', 2)
      marker.element.classList.add('campaign-mark')
      this.marks.push(marker)
    }
    this.marks.forEach((marker, index) => {
      const mark = marks[index]
      const enemy = mark ? r.ai.enemies[Number(mark.ref)] : undefined
      marker.update(r.view, enemy && !['dead', 'reserve'].includes(enemy.state) ? enemy.position.clone().setY(enemy.position.y + 2.3) : null)
    })
  }

  private hideMarkers() {
    this.objectiveMarker.element.hidden = true
    for (const marker of [...this.hostageMarkers, ...this.marks]) marker.element.hidden = true
    for (const entry of this.suspicion) entry.element.hidden = true
    this.bar.show(null)
  }

  dispose() { this.abort.abort(); this.bar.dispose(); this.root.remove() }
}
