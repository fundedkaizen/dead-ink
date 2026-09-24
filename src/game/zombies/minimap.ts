import * as THREE from 'three'
import './zombies.css'
import { HOSTAGE_INK } from '../hostage-actor'
import { getSettings } from '../settings'
import type { NavGraph } from './navgraph'
import { PERKS, perkIcon, type PerkKind } from './perks'

/**
 * The mini map, as in the recent Call of Duty Zombies games: round, in the top-left corner, turning with
 * you so your heading is always up, you an arrow in the middle, about 35 m around you. Ink on paper like
 * the rest of the game: the compound's walls and fences in ink, the buildings you can walk into a shade
 * darker, the zones still shut behind their gates washed grey. Colour only where it means something: the
 * perk machines in their own colours, the Mystery Box's gold question mark, the Pack-a-Punch's shifting
 * colours once it is built, the power switch's amber bolt while the power is off, teammates in the
 * hostage's blue. Buildable parts still lying about are small ink cogs. Perks, the box, the Pack-a-Punch
 * and the parts beyond the rim are pinned to it, pointing the way.
 *
 * The plan is built once, while the map loads: a horizontal cut through everything solid at chest height,
 * the way an architect draws a floor plan, painted into an offscreen canvas at the map's own scale. Each
 * frame (at most 30 times a second) the part around you is drawn into one small 2D canvas, turned: no
 * WebGL work, nothing allocated.
 */

/** Metres from the middle of the map to its rim. */
const MINIMAP_RADIUS = 35
/**
 * Where the plan cuts through the world: at chest height (under the windows, over plinths and crates) for
 * the walls, and low down for what is too low for that cut but still worth seeing: rails, the loading
 * platform, crates, steps.
 */
const CUT = 1.25, LOW_CUT = 0.45
/** The map is redrawn at most this often (seconds). */
const REDRAW = 1 / 30
const TAU = Math.PI * 2
const PAPER = '#ffffff', INK = '#111111', GREY = '#8a8a8a'
/** Buildings you can walk into, a shade darker than the yards. */
const ROOM = '#ebebeb'
/** Zones still shut, and the land outside the fence: ink washed over the paper. */
const SHUT = 'rgba(17, 17, 17, 0.13)', SHUT_ALPHA = 33, OUTSIDE = '#e0e0e0'
/** The Mystery Box's gold and the power marker's amber, as in the world. */
const GOLD = '#e8c46a', AMBER = '#e8b64a'
/** A teammate's arrow: the hostage's blue, as their stickman, name tag and scoreboard line are. */
export const MATE_INK = `#${HOSTAGE_INK.toString(16).padStart(6, '0')}`
/** Line widths in CSS pixels. */
const LINES = { wall: 1.3, prop: 1, gate: 2.6, rim: 1.6 } as const
/** Furniture, stairs and parked things: drawn in grey ink, under the walls (trees and rocks too). */
const PROP_KINDS = new Set(['chair', 'dining-table', 'desk', 'monitor', 'desktop-computer', 'vending-machine', 'mess-service-counter', 'static-prop', 'stairs'])
/** The power marker's bolt (markers.ts POWER_ICON), in its 24-unit box. */
const BOLT = 'M14 2 4 14h6l-2 8 10-12h-6z'

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }

/** A teammate on the map: where they stand, which way they look (camera yaw), and their colour. */
export type MinimapMate = { position: THREE.Vector3; yaw: number; color: string }

/** A buildable part still lying about (PartPickup). */
export type MinimapPart = { readonly id: string; readonly root: THREE.Object3D }

/** What the map shows, read every frame. ZombiesRuntime has all of these. */
export type MinimapStations = {
  readonly perkMachines: readonly { readonly kind: PerkKind; readonly root: THREE.Object3D }[]
  readonly box: { readonly root: THREE.Object3D; readonly state: string } | null
  readonly pack: { readonly root: THREE.Object3D } | null
  readonly packBuilt: boolean
  readonly power: boolean
  readonly zones: { readonly gates: readonly { readonly segment: readonly THREE.Vector3[]; readonly state: string }[] } | null
}

/** The compound seen from above: segments as x1, z1, x2, z2 and buildings as four x, z corners. */
export type FloorPlan = Bounds & { walls: Float32Array; props: Float32Array; rooms: Float32Array }

/**
 * The floor plan: horizontal cuts through the solid parts of the map (Drafts, the way the world is drawn;
 * the same meshes and wire panels the collision world holds). Left out: doors that open (a doorway reads
 * as a gap), Dead Ink's zone gates (the map draws those live), and the stations, which it draws as icons.
 * `walls` is the chest-height cut; `props` is furniture, stairs, trees and rocks at that height plus the
 * low cut of everything but furniture, drawn lighter than the walls.
 */
export function floorPlan(root: THREE.Object3D, bounds: Bounds): FloorPlan {
  root.updateWorldMatrix(true, true)
  const walls: number[] = [], props: number[] = [], rooms: number[] = []
  const box = new THREE.Box3(), corner = new THREE.Vector3()
  const xs = [0, 0, 0], ys = [0, 0, 0], zs = [0, 0, 0]
  /** The segment where a triangle crosses the height `at`, if it does. */
  const cross = (at: number, out: number[]) => {
    let found = 0, x1 = 0, z1 = 0
    for (let v = 0; v < 3; v++) {
      const w = (v + 1) % 3, a = ys[v] - at, b = ys[w] - at
      if ((a >= 0) === (b >= 0)) continue
      const t = a / (a - b), x = xs[v] + (xs[w] - xs[v]) * t, z = zs[v] + (zs[w] - zs[v]) * t
      if (found++ === 0) { x1 = x; z1 = z } else if (Math.abs(x - x1) + Math.abs(z - z1) > 0.01) out.push(x1, z1, x, z)
    }
  }
  const cut = (mesh: THREE.Mesh, high: number[], low: number[] | null) => {
    const geometry = mesh.geometry
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    box.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
    if (box.min.y > CUT || box.max.y < (low ? LOW_CUT : CUT)) return
    const e = mesh.matrixWorld.elements, position = geometry.getAttribute('position'), index = geometry.index
    const count = index ? index.count : position.count
    for (let i = 0; i + 2 < count; i += 3) {
      let top = -Infinity, bottom = Infinity
      for (let v = 0; v < 3; v++) {
        const n = index ? index.getX(i + v) : i + v
        const x = position.getX(n), y = position.getY(n), z = position.getZ(n)
        xs[v] = e[0] * x + e[4] * y + e[8] * z + e[12]
        ys[v] = e[1] * x + e[5] * y + e[9] * z + e[13]
        zs[v] = e[2] * x + e[6] * y + e[10] * z + e[14]
        top = Math.max(top, ys[v]); bottom = Math.min(bottom, ys[v])
      }
      if (bottom < CUT && top >= CUT) cross(CUT, high)
      // The low cut only for what the chest-height cut misses.
      else if (low && bottom < LOW_CUT && top >= LOW_CUT) cross(LOW_CUT, low)
    }
  }
  const visit = (object: THREE.Object3D, drawn: boolean, moving: boolean, locked: boolean, prop: boolean, furniture: boolean) => {
    const data = object.userData
    if (!object.visible || data.noCollision || data.zoneGate || (object as THREE.Camera).isCamera) return
    drawn ||= !!data.environment || data.kind === 'door'
    // A door that opens is a gap in the wall; one locked for good (the secure exit gate) stays a wall.
    moving ||= !!(data.doorHinge || data.dynamicCollision)
    locked ||= !!data.missionLocked
    furniture ||= !!data.furniture || PROP_KINDS.has(data.kind)
    prop ||= furniture || !!data.trees
    const out = prop ? props : walls
    if (Array.isArray(data.footprint) && data.footprint.length === 2) {
      const [w, d] = data.footprint as [number, number]
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        corner.set(sx * w / 2, 0, sz * d / 2).applyMatrix4(object.matrixWorld)
        rooms.push(corner.x, corner.z)
      }
    }
    if (drawn && (!moving || locked)) {
      // Wire panels (fences, gates) exist only as collision: a line from end to end.
      const e = object.matrixWorld.elements
      for (const panel of (data.collisionPanels ?? []) as { a: [number, number]; b: [number, number]; height: number }[]) {
        if (e[13] > CUT || e[13] + panel.height < CUT) continue
        out.push(e[0] * panel.a[0] + e[8] * panel.a[1] + e[12], e[2] * panel.a[0] + e[10] * panel.a[1] + e[14],
          e[0] * panel.b[0] + e[8] * panel.b[1] + e[12], e[2] * panel.b[0] + e[10] * panel.b[1] + e[14])
      }
      if (object instanceof THREE.Mesh && !(object.material instanceof THREE.ShaderMaterial) && !(object as THREE.SkinnedMesh).isSkinnedMesh)
        cut(object, out, furniture ? null : props)
    }
    for (const child of object.children) visit(child, drawn, moving, locked, prop, furniture)
  }
  visit(root, false, false, false, false, false)
  // A margin round the map's bounds, so its edge is still drawn when you stand near it.
  return { minX: bounds.minX - 24, maxX: bounds.maxX + 24, minZ: bounds.minZ - 24, maxZ: bounds.maxZ + 24,
    walls: new Float32Array(walls), props: new Float32Array(props), rooms: new Float32Array(rooms) }
}

/** The plan painted at `scale` device pixels per metre: paper, buildings, grey props, ink walls. */
function paintPlan(plan: FloorPlan, scale: number, dpr: number, graph: NavGraph | null) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((plan.maxX - plan.minX) * scale)
  canvas.height = Math.ceil((plan.maxZ - plan.minZ) * scale)
  const c = canvas.getContext('2d', { alpha: false })!
  c.fillStyle = PAPER
  c.fillRect(0, 0, canvas.width, canvas.height)
  c.setTransform(scale, 0, 0, scale, -plan.minX * scale, -plan.minZ * scale)
  c.fillStyle = ROOM
  c.beginPath()
  const r = plan.rooms
  for (let i = 0; i + 7 < r.length; i += 8) { c.moveTo(r[i], r[i + 1]); c.lineTo(r[i + 2], r[i + 3]); c.lineTo(r[i + 4], r[i + 5]); c.lineTo(r[i + 6], r[i + 7]); c.closePath() }
  c.fill()
  c.lineCap = c.lineJoin = 'round'
  for (const [segments, color, width] of [[plan.props, GREY, LINES.prop], [plan.walls, INK, LINES.wall]] as const) {
    c.strokeStyle = color
    c.lineWidth = width * dpr / scale
    // In batches: one enormous path is slow to stroke.
    for (let start = 0; start < segments.length; start += 16384) {
      c.beginPath()
      for (let i = start; i < Math.min(segments.length, start + 16384); i += 4) { c.moveTo(segments[i], segments[i + 1]); c.lineTo(segments[i + 2], segments[i + 3]) }
      c.stroke()
    }
  }
  // Beyond the zombies' grid nobody walks: washed like a shut zone.
  if (graph) {
    const x0 = graph.minX, z0 = graph.minZ, x1 = graph.minX + graph.nx * graph.cell, z1 = graph.minZ + graph.nz * graph.cell
    c.fillStyle = SHUT
    c.fillRect(plan.minX, plan.minZ, plan.maxX - plan.minX, z0 - plan.minZ)
    c.fillRect(plan.minX, z1, plan.maxX - plan.minX, plan.maxZ - z1)
    c.fillRect(plan.minX, z0, x0 - plan.minX, z1 - z0)
    c.fillRect(x1, z0, plan.maxX - x1, z1 - z0)
  }
  return canvas
}

/** A small offscreen canvas `size` device pixels square, painted once. */
function sprite(size: number, paint: (c: CanvasRenderingContext2D, size: number) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = Math.max(4, Math.round(size))
  const c = canvas.getContext('2d')!
  c.imageSmoothingQuality = 'high'
  paint(c, canvas.width)
  return canvas
}

/** A paper halo round every icon, so it reads on ink walls. */
function halo(c: CanvasRenderingContext2D, size: number) {
  c.fillStyle = PAPER
  c.beginPath(); c.arc(size / 2, size / 2, size / 2, 0, TAU); c.fill()
}

type Sprites = {
  perk: Record<PerkKind, HTMLCanvasElement>; perkRim: Record<PerkKind, HTMLCanvasElement>
  box: HTMLCanvasElement; boxRim: HTMLCanvasElement; pack: HTMLCanvasElement; packRim: HTMLCanvasElement
  part: HTMLCanvasElement; partRim: HTMLCanvasElement; power: HTMLCanvasElement; north: HTMLCanvasElement
}

function makeSprites(icon: number, dpr: number): Sprites {
  const pad = Math.max(1, Math.round(1.3 * dpr)), rim = Math.round(icon * 0.8)
  // A buildable part: a small ink cog with a paper hole.
  const partSprite = (size: number) => sprite(size + pad * 2, (c, s) => {
    halo(c, s)
    const m = s / 2, outer = m - pad, inner = outer * 0.74, teeth = 8, root = Math.PI / teeth * 0.62, tip = Math.PI / teeth * 0.36
    c.fillStyle = INK
    c.beginPath()
    for (let i = 0; i < teeth; i++) {
      const a = i / teeth * TAU
      c.lineTo(m + Math.cos(a - root) * inner, m + Math.sin(a - root) * inner)
      c.lineTo(m + Math.cos(a - tip) * outer, m + Math.sin(a - tip) * outer)
      c.lineTo(m + Math.cos(a + tip) * outer, m + Math.sin(a + tip) * outer)
      c.lineTo(m + Math.cos(a + root) * inner, m + Math.sin(a + root) * inner)
    }
    c.closePath(); c.fill()
    c.fillStyle = PAPER
    c.beginPath(); c.arc(m, m, outer * 0.32, 0, TAU); c.fill()
  })
  const perkSprite = (kind: PerkKind, size: number) => sprite(size + pad * 2, (c, s) => { halo(c, s); c.drawImage(perkIcon(kind), pad, pad, s - pad * 2, s - pad * 2) })
  // An ink crate with the box's gold question mark.
  const boxSprite = (size: number) => sprite(size + pad * 2, (c, s) => {
    const w = s - pad * 2, h = Math.round(w * 0.74), top = (s - h) / 2
    c.fillStyle = PAPER
    c.beginPath(); c.roundRect(0, top - pad, s, h + pad * 2, pad * 2); c.fill()
    c.fillStyle = INK
    c.beginPath(); c.roundRect(pad, top, w, h, Math.max(1, dpr * 1.5)); c.fill()
    c.fillStyle = GOLD
    c.font = `900 ${Math.round(h * 1.02)}px "Arial Black", "Segoe UI", Arial, sans-serif`
    c.textAlign = 'center'; c.textBaseline = 'middle'
    c.fillText('?', s / 2, s / 2 + h * 0.06)
  })
  // The Pack-a-Punch: an ink disc, a ring in its shifting colours, a white bolt.
  const packSprite = (size: number) => sprite(size + pad * 2, (c, s) => {
    halo(c, s)
    const m = s / 2, radius = m - pad
    c.fillStyle = INK
    c.beginPath(); c.arc(m, m, radius, 0, TAU); c.fill()
    const ring = c.createConicGradient(0, m, m)
    for (let i = 0; i <= 6; i++) ring.addColorStop(i / 6, `hsl(${i * 60}, 85%, 58%)`)
    c.strokeStyle = ring
    c.lineWidth = radius * 0.26
    c.beginPath(); c.arc(m, m, radius * 0.8, 0, TAU); c.stroke()
    c.save(); c.translate(m, m); c.scale(radius / 13, radius / 13); c.translate(-12, -12)
    c.fillStyle = PAPER; c.fill(new Path2D(BOLT)); c.restore()
  })
  return {
    perk: Object.fromEntries((Object.keys(PERKS) as PerkKind[]).map(kind => [kind, perkSprite(kind, icon)])) as Record<PerkKind, HTMLCanvasElement>,
    perkRim: Object.fromEntries((Object.keys(PERKS) as PerkKind[]).map(kind => [kind, perkSprite(kind, rim)])) as Record<PerkKind, HTMLCanvasElement>,
    box: boxSprite(icon), boxRim: boxSprite(rim), pack: packSprite(icon), packRim: packSprite(rim),
    part: partSprite(Math.round(icon * 0.8)), partRim: partSprite(Math.round(rim * 0.85)),
    // The power switch: the amber bolt of its world marker.
    power: sprite(icon + pad * 2, (c, s) => {
      c.save(); c.translate(s / 2, s / 2); c.scale(s / 24, s / 24); c.translate(-12, -12)
      const bolt = new Path2D(BOLT)
      c.lineJoin = 'round'
      c.strokeStyle = PAPER; c.lineWidth = 5; c.stroke(bolt)
      c.fillStyle = AMBER; c.fill(bolt)
      c.strokeStyle = INK; c.lineWidth = 1.8; c.stroke(bolt)
      c.restore()
    }),
    // North, on the rim.
    north: sprite(Math.round(icon * 0.72), (c, s) => {
      halo(c, s)
      c.fillStyle = INK
      c.font = `700 ${Math.round(s * 0.78)}px "Segoe UI", Arial, sans-serif`
      c.textAlign = 'center'; c.textBaseline = 'middle'
      c.fillText('N', s / 2, s / 2 + s * 0.04)
    }),
  }
}

type Mark = { kind: string; x: number; y: number; pinned: boolean }

export class Minimap {
  readonly canvas = document.createElement('canvas')
  readonly plan: FloorPlan
  /** Milliseconds the plan took to build, for the checks. */
  readonly buildMs: number
  private context: CanvasRenderingContext2D
  private graph: NavGraph | null
  private home: THREE.Vector3
  private powerPoint: THREE.Vector3 | null
  private planCanvas: HTMLCanvasElement | null = null
  private sprites: Sprites | null = null
  /** The canvas's size in CSS pixels, its pixel ratio and its width in device pixels; device pixels per metre. */
  private css = 0
  private dpr = 1
  private pixels = 0
  private scale = 1
  private clock = REDRAW
  private resizeTimer = 0
  /** Shut zones: a pixel per grid cell, drawn stretched (and so softened) over the plan. */
  private zones: HTMLCanvasElement | null = null
  private zonesKey = -1
  private seen: Uint8Array | null = null
  private queue: Int32Array | null = null
  private open: Uint8Array | null = null
  private around: number[] = []
  /** This frame's view: where you stand, which way the map is turned. */
  private px = 0
  private pz = 0
  private cos = 1
  private sin = 0
  private marks: Mark[] = Array.from({ length: 32 }, () => ({ kind: '', x: 0, y: 0, pinned: false }))
  private markCount = 0

  constructor(parent: HTMLElement, options: { scene: THREE.Object3D; bounds: Bounds; graph: NavGraph | null; home: THREE.Vector3; power: THREE.Vector3 | null }) {
    const started = performance.now()
    this.plan = floorPlan(options.scene, options.bounds)
    this.graph = options.graph
    this.home = options.home.clone()
    this.powerPoint = options.power?.clone() ?? null
    this.canvas.className = 'dead-ink-minimap'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.context = this.canvas.getContext('2d')!
    parent.append(this.canvas)
    this.layout()
    window.addEventListener('resize', this.resized)
    this.buildMs = performance.now() - started
  }

  /** Size the canvas to its CSS box (it is smaller on small screens) and paint the plan and icons for it. */
  private layout() {
    const css = parseFloat(getComputedStyle(this.canvas).width) || 180
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    const pixels = Math.round(css * dpr)
    if (pixels === this.pixels && this.planCanvas) return
    this.css = css; this.dpr = dpr; this.pixels = pixels
    this.canvas.width = this.canvas.height = pixels
    this.scale = pixels / 2 / MINIMAP_RADIUS
    this.planCanvas = paintPlan(this.plan, this.scale, dpr, this.graph)
    this.sprites = makeSprites(Math.round(css * 0.1 * dpr), dpr)
    this.zonesKey = -1
    this.clock = REDRAW
  }

  private resized = () => {
    clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => this.layout(), 200)
  }

  /**
   * Once a frame: you (feet and camera yaw), the stations, the buildable parts still lying about, your
   * teammates. `playing` false (paused, in a menu, dead) skips the drawing; the Mini map setting hides it.
   */
  update(dt: number, position: THREE.Vector3, yaw: number, stations: MinimapStations, parts: readonly MinimapPart[], mates: readonly MinimapMate[], playing: boolean) {
    const on = getSettings().minimap
    if (on === this.canvas.hidden) this.canvas.hidden = !on
    if (!on || !playing) { this.clock = REDRAW; return }
    this.clock += dt
    if (this.clock < REDRAW - 1e-4) return
    this.clock = 0
    this.draw(position, yaw, stations, parts, mates)
  }

  /** The icons the last frame drew, where on the canvas (CSS pixels from its middle; y is down). For the checks. */
  icons() {
    return this.marks.slice(0, this.markCount).map(mark => ({ ...mark, x: mark.x / this.dpr, y: mark.y / this.dpr }))
  }

  private draw(position: THREE.Vector3, yaw: number, stations: MinimapStations, parts: readonly MinimapPart[], mates: readonly MinimapMate[]) {
    const c = this.context, plan = this.planCanvas!, sprites = this.sprites!, dpr = this.dpr
    const size = this.pixels, r = size / 2, s = this.scale, rim = LINES.rim * dpr
    const cos = Math.cos(yaw), sin = Math.sin(yaw)
    this.px = position.x; this.pz = position.z; this.cos = cos; this.sin = sin
    this.markCount = 0
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, size, size)
    c.save()
    c.beginPath(); c.arc(r, r, r - rim / 2, 0, TAU); c.clip()
    c.fillStyle = OUTSIDE
    c.fillRect(0, 0, size, size)
    // The plan, painted at this scale: its pixels are the map's, turned about you. Only the square round
    // the disc is drawn (a circle needs no more, however it is turned).
    const ox = (this.plan.minX - position.x) * s, oz = (this.plan.minZ - position.z) * s
    c.setTransform(cos, sin, -sin, cos, r + cos * ox - sin * oz, r + sin * ox + cos * oz)
    const u = -ox, v = -oz, reach = r + 2
    const x0 = Math.max(0, Math.floor(u - reach)), y0 = Math.max(0, Math.floor(v - reach))
    const x1 = Math.min(plan.width, Math.ceil(u + reach)), y1 = Math.min(plan.height, Math.ceil(v + reach))
    if (x1 > x0 && y1 > y0) c.drawImage(plan, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0)
    // Zones still shut, and the gates that shut them.
    const gates = stations.zones?.gates
    this.shutZones(gates)
    const graph = this.graph
    if (this.zones && graph) c.drawImage(this.zones, (graph.minX - this.plan.minX) * s, (graph.minZ - this.plan.minZ) * s, graph.nx * graph.cell * s, graph.nz * graph.cell * s)
    if (gates) {
      c.strokeStyle = INK; c.lineWidth = LINES.gate * dpr; c.lineCap = 'butt'
      c.beginPath()
      for (let i = 0; i < gates.length; i++) {
        if (gates[i].state !== 'closed') continue
        const a = gates[i].segment[0], b = gates[i].segment[1]
        c.moveTo((a.x - this.plan.minX) * s, (a.z - this.plan.minZ) * s); c.lineTo((b.x - this.plan.minX) * s, (b.z - this.plan.minZ) * s)
      }
      c.stroke()
    }
    // Icons, upright. The power switch only while the power is off, and only within reach of the map.
    c.setTransform(1, 0, 0, 1, 0, 0)
    if (!stations.power && this.powerPoint) this.icon(this.powerPoint, sprites.power, null, 'power')
    for (let i = 0; i < parts.length; i++) if (parts[i].root.visible) this.icon(parts[i].root.position, sprites.part, sprites.partRim, parts[i].id)
    const machines = stations.perkMachines
    for (let i = 0; i < machines.length; i++) this.icon(machines[i].root.position, sprites.perk[machines[i].kind], sprites.perkRim[machines[i].kind], machines[i].kind)
    const box = stations.box
    if (box && box.state !== 'leaving') this.icon(box.root.position, sprites.box, sprites.boxRim, 'box')
    if (stations.pack && stations.packBuilt) this.icon(stations.pack.root.position, sprites.pack, sprites.packRim, 'pack')
    for (let i = 0; i < mates.length; i++) {
      const mate = mates[i], dx = mate.position.x - this.px, dz = mate.position.z - this.pz
      const x = (dx * cos - dz * sin) * s, y = (dx * sin + dz * cos) * s
      this.arrow(x + r, y + r, yaw - mate.yaw, mate.color, 0.85)
      this.mark('mate', x, y, false)
    }
    this.arrow(r, r, 0, INK, 1)
    c.restore()
    // The rim, and north on it.
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.strokeStyle = INK; c.lineWidth = rim
    c.beginPath(); c.arc(r, r, r - rim / 2, 0, TAU); c.stroke()
    const north = sprites.north, reachN = r - rim - north.width / 2
    c.drawImage(north, r + sin * reachN - north.width / 2, r - cos * reachN - north.height / 2)
  }

  /**
   * One icon at a world position. Beyond the rim, `rim` (the smaller icon) is pinned to it; icons without
   * one are left to the rim's clip.
   */
  private icon(at: THREE.Vector3, image: HTMLCanvasElement, rim: HTMLCanvasElement | null, kind: string) {
    const r = this.pixels / 2, dx = at.x - this.px, dz = at.z - this.pz
    let x = (dx * this.cos - dz * this.sin) * this.scale, y = (dx * this.sin + dz * this.cos) * this.scale
    const distance = Math.hypot(x, y), edge = r - LINES.rim * this.dpr - 1
    let pinned = false
    if (distance > edge - image.width / 2) {
      if (!rim) { if (distance > r + image.width) return }
      else {
        const k = (edge - rim.width / 2) / distance
        x *= k; y *= k; image = rim; pinned = true
      }
    }
    this.context.drawImage(image, r + x - image.width / 2, r + y - image.height / 2)
    this.mark(kind, x, y, pinned)
  }

  /** Note what was drawn where (device pixels from the middle), for icons(). */
  private mark(kind: string, x: number, y: number, pinned: boolean) {
    if (this.markCount >= this.marks.length) return
    const mark = this.marks[this.markCount++]
    mark.kind = kind; mark.x = x; mark.y = y; mark.pinned = pinned
  }

  /** An arrow at (x, y) on the canvas, turned `turn` radians clockwise from up. */
  private arrow(x: number, y: number, turn: number, color: string, size: number) {
    const c = this.context, k = Math.min(1.6, Math.max(1.1, this.css / 115)) * size * this.dpr
    const cos = Math.cos(turn) * k, sin = Math.sin(turn) * k
    c.setTransform(cos, sin, -sin, cos, x, y)
    c.beginPath(); c.moveTo(0, -5.5); c.lineTo(4, 4.5); c.lineTo(0, 2.2); c.lineTo(-4, 4.5); c.closePath()
    c.lineJoin = 'round'
    c.strokeStyle = PAPER; c.lineWidth = 2.6; c.stroke()
    c.fillStyle = color; c.fill()
    c.setTransform(1, 0, 0, 1, 0, 0)
  }

  /**
   * Repaint the shut zones when a gate opens or shuts: every grid cell you cannot walk to from the start
   * (through the gates open now) is washed grey. Cells beside a walkable one stay clear, so the walls
   * and fences of the open zones stay crisp.
   */
  private shutZones(gates: readonly { readonly state: string }[] | undefined) {
    const graph = this.graph
    if (!graph) return
    let key = gates ? gates.length * 4096 : 0
    if (gates) for (let i = 0; i < gates.length; i++) if (gates[i].state === 'closed') key += 1 << i
    if (key === this.zonesKey) return
    this.zonesKey = key
    const { nx, nz, cells, size } = graph
    if (!this.seen || this.seen.length !== size) { this.seen = new Uint8Array(size); this.queue = new Int32Array(size); this.open = new Uint8Array(cells) }
    const seen = this.seen, queue = this.queue!, open = this.open!, around = this.around
    seen.fill(0); open.fill(0)
    const start = graph.nearest(this.home, 4)
    if (start >= 0) {
      let head = 0, tail = 0
      queue[tail++] = start; seen[start] = 1
      while (head < tail) {
        const at = queue[head++]
        open[at < cells ? at : graph.raised[at - cells].cell] = 1
        graph.neighbours(at, around)
        for (let i = 0; i < around.length; i++) if (!seen[around[i]]) { seen[around[i]] = 1; queue[tail++] = around[i] }
      }
    }
    if (!this.zones) { this.zones = document.createElement('canvas'); this.zones.width = nx; this.zones.height = nz }
    const c = this.zones.getContext('2d')!, image = c.createImageData(nx, nz), data = image.data
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      let clear = false
      for (let di = -1; di <= 1 && !clear; di++) for (let dk = -1; dk <= 1 && !clear; dk++) {
        const a = i + di, b = k + dk
        clear = a >= 0 && b >= 0 && a < nx && b < nz && open[a * nz + b] === 1
      }
      const p = (k * nx + i) * 4
      data[p] = data[p + 1] = data[p + 2] = 17
      data[p + 3] = clear ? 0 : SHUT_ALPHA
    }
    c.putImageData(image, 0, 0)
  }

  dispose() {
    clearTimeout(this.resizeTimer)
    window.removeEventListener('resize', this.resized)
    this.canvas.remove()
    this.planCanvas = null; this.sprites = null; this.zones = null
  }
}
