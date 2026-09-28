import * as THREE from 'three'
import type { MissionRuntime } from '../runtime'
import { ENEMY_COMBAT } from '../balance'

/**
 * What the campaign draws in the world so the angles can be read: a faint ink fan in front of any guard who is
 * looking for you (suspicious, searching, fighting, or growing sure he saw something), each camera's sweep on
 * the ground, the glint of a marksman's scope when it points your way, and the helicopter coming down and
 * lifting off with its rotors turning.
 */
const GUARD_HALF_ANGLE = 55 * Math.PI / 180, CAMERA_HALF_ANGLE = 28 * Math.PI / 180
const INK = 0x000000, DANGER = 0xc8322b

/** A fan on the ground, darkest at the guard and fading out toward its reach (vertex alpha). */
function fanGeometry(halfAngle: number, segments = 18) {
  const positions: number[] = [], colors: number[] = [], index: number[] = []
  const rings = [0, 0.35, 1], alpha = [1, 0.55, 0]
  for (const [r, radius] of rings.entries()) for (let i = 0; i <= segments; i++) {
    const a = -halfAngle + i / segments * halfAngle * 2
    positions.push(Math.sin(a) * radius, 0, Math.cos(a) * radius)
    colors.push(1, 1, 1, alpha[r])
  }
  const row = segments + 1
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < segments; i++) {
    const a = r * row + i, b = a + row
    index.push(a, b, a + 1, a + 1, b, b + 1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setIndex(index)
  return geometry
}
/** The fan's two edges, fading out along their length. */
function fanOutline(halfAngle: number) {
  const positions: number[] = [], colors: number[] = []
  for (const side of [-1, 1]) {
    positions.push(0, 0, 0, Math.sin(side * halfAngle) * 0.8, 0, Math.cos(side * halfAngle) * 0.8)
    colors.push(1, 1, 1, 1, 1, 1, 1, 0)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  return geometry
}

type Cone = { group: THREE.Group; fill: THREE.Mesh; edge: THREE.LineSegments; fillMaterial: THREE.MeshBasicMaterial; edgeMaterial: THREE.LineBasicMaterial }

export class CampaignVisuals {
  private root = new THREE.Group()
  private guardFan = fanGeometry(GUARD_HALF_ANGLE)
  private guardEdge = fanOutline(GUARD_HALF_ANGLE)
  private cameraFan = fanGeometry(CAMERA_HALF_ANGLE)
  private cameraEdge = fanOutline(CAMERA_HALF_ANGLE)
  private guardCones: Cone[] = []
  private cameraCones = new Map<string, Cone>()
  private glints: THREE.Sprite[] = []
  private glintMaterial: THREE.SpriteMaterial
  private clock = 0
  private landing = 0
  private arrived = false

  constructor(private r: MissionRuntime, scene: THREE.Scene) {
    this.root.name = 'Campaign sight lines'
    this.root.userData.noCollision = true
    scene.add(this.root)
    this.glintMaterial = new THREE.SpriteMaterial({ map: glintTexture(), transparent: true, depthWrite: false, sizeAttenuation: false, toneMapped: false })
  }

  private cone(fan: THREE.BufferGeometry, edge: THREE.BufferGeometry): Cone {
    const fillMaterial = new THREE.MeshBasicMaterial({ color: INK, vertexColors: true, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    const edgeMaterial = new THREE.LineBasicMaterial({ color: INK, vertexColors: true, transparent: true, opacity: 0.35, toneMapped: false })
    const group = new THREE.Group()
    const fill = new THREE.Mesh(fan, fillMaterial), line = new THREE.LineSegments(edge, edgeMaterial)
    fill.renderOrder = 3; line.renderOrder = 3
    group.add(fill, line)
    group.userData.noCollision = true
    this.root.add(group)
    return { group, fill, edge: line, fillMaterial, edgeMaterial }
  }

  /** Where a player's round meets a camera (before any wall or guard), for shooting cameras out. */
  cameraHit(origin: THREE.Vector3, direction: THREE.Vector3, wall: number, body: number) {
    const ray = new THREE.Ray(origin, direction.clone().normalize()), point = new THREE.Vector3()
    for (const { spec, rig } of this.r.security.list()) {
      if (this.r.security.destroyed.has(spec.id)) continue
      const centre = rig.pivot.getWorldPosition(new THREE.Vector3())
      centre.add(new THREE.Vector3(Math.sin(rig.pivot.rotation.y) * 0.25, 0, Math.cos(rig.pivot.rotation.y) * 0.25))
      if (!ray.intersectSphere(new THREE.Sphere(centre, 0.42), point)) continue
      const distance = point.distanceTo(origin)
      if (distance <= Math.min(wall + 0.3, body)) return spec.id
    }
    return null
  }

  update(dt: number) {
    const r = this.r, run = r.state.run
    this.clock += dt
    this.root.visible = !!run && !r.escape.active
    if (!run) return
    // Guards' cones.
    const enemies = r.ai.enemies
    while (this.guardCones.length < enemies.length) this.guardCones.push(this.cone(this.guardFan, this.guardEdge))
    this.guardCones.forEach((cone, index) => {
      const enemy = enemies[index]
      const alert = enemy && !['dead', 'reserve'].includes(enemy.state) &&
        (['suspicious', 'investigate', 'search', 'combat'].includes(enemy.state) || enemy.awareness > 0.08)
      cone.group.visible = !!alert && enemy.spec.role !== 'sniper'
      if (!cone.group.visible) return
      const combat = enemy.state === 'combat'
      const range = ENEMY_COMBAT.passiveRange * r.ai.options.sight * (combat ? 0.9 : 0.75)
      cone.group.position.copy(enemy.position).setY(enemy.position.y + 0.06)
      cone.group.rotation.y = enemy.yaw
      cone.group.scale.set(range, 1, range)
      const strength = combat ? 1 : Math.max(0.35, enemy.awareness)
      cone.fillMaterial.color.setHex(combat || enemy.awareness > 0.7 ? DANGER : INK)
      cone.edgeMaterial.color.copy(cone.fillMaterial.color)
      cone.fillMaterial.opacity = 0.06 + 0.1 * strength
      cone.edgeMaterial.opacity = 0.15 + 0.3 * strength
    })
    // Cameras' sweeps on the ground.
    const live = new Set<string>()
    if (r.state.camerasActive) for (const { spec, rig } of r.security.list()) {
      if (r.security.destroyed.has(spec.id)) continue
      live.add(spec.id)
      let cone = this.cameraCones.get(spec.id)
      if (!cone) { cone = this.cone(this.cameraFan, this.cameraEdge); this.cameraCones.set(spec.id, cone) }
      const floor = r.player.world.floor(new THREE.Vector3(spec.position[0], spec.position[1] - 0.5, spec.position[2]), 0.5, spec.position[1] + 1)
      cone.group.position.set(spec.position[0], (Number.isFinite(floor) ? floor : 0) + 0.05, spec.position[2])
      cone.group.rotation.y = rig.pivot.rotation.y
      const reach = Math.sqrt(Math.max(1, spec.range * spec.range - (spec.position[1] - 1.6) ** 2))
      cone.group.scale.set(reach, 1, reach)
      const alarm = r.state.alarm === 'active'
      cone.fillMaterial.color.setHex(alarm ? DANGER : INK); cone.edgeMaterial.color.setHex(alarm ? DANGER : INK)
      cone.fillMaterial.opacity = 0.07; cone.edgeMaterial.opacity = 0.22
    }
    for (const [id, cone] of this.cameraCones) cone.group.visible = live.has(id)
    this.updateGlints()
    this.updateVehicle(dt)
  }

  /** A marksman's scope catches the light when he looks your way: a short amber star every couple of seconds. */
  private updateGlints() {
    const r = this.r, eye = r.view.position
    const snipers = r.ai.enemies.filter(enemy => enemy.spec.role === 'sniper')
    while (this.glints.length < snipers.length) {
      const sprite = new THREE.Sprite(this.glintMaterial)
      sprite.scale.setScalar(0.045); sprite.renderOrder = 4
      this.root.add(sprite); this.glints.push(sprite)
    }
    this.glints.forEach((sprite, index) => {
      const enemy = snipers[index]
      sprite.visible = false
      if (!enemy || ['dead', 'reserve'].includes(enemy.state)) return
      const head = enemy.position.clone().setY(enemy.position.y + 1.55)
      const toMe = eye.clone().sub(head), distance = toMe.length()
      if (distance > ENEMY_COMBAT.sniperEngagedRange) return
      const facing = (Math.sin(enemy.yaw) * toMe.x + Math.cos(enemy.yaw) * toMe.z) / Math.max(1e-3, Math.hypot(toMe.x, toMe.z))
      if (facing < Math.cos(30 * Math.PI / 180)) return
      const phase = (this.clock + index * 0.9) % 2.3
      if (phase > 0.28 && enemy.state !== 'combat') return
      if (!r.player.world.visible(eye, head, enemy.actor.root)) return
      sprite.visible = true
      sprite.position.copy(head).addScaledVector(toMe.normalize(), 0.35)
    })
  }

  /** The helicopter comes down once it has arrived, rotors turning; its rotors race as it lifts off. */
  private updateVehicle(dt: number) {
    const r = this.r, campaign = r.campaign, run = r.state.run
    if (!campaign || !run) return
    const vehicle = campaign.props.vehicles.get(campaign.mission.extraction)
    if (!vehicle) return
    if (run.arrived && !this.arrived) { this.arrived = true; this.landing = 0 }
    if (!run.arrived) { this.arrived = false; return }
    if (!r.escape.active) {
      this.landing = Math.min(1, this.landing + dt / 5)
      const t = 1 - (1 - this.landing) ** 3
      const park = campaign.extraction.park
      vehicle.position.set(park[0], park[1] + (1 - t) * 34, park[2])
      vehicle.rotation.set(0, campaign.extraction.heading + (1 - t) * 0.6, 0)
    }
    this.spin(vehicle, dt, 1)
  }

  private spin(vehicle: THREE.Object3D, dt: number, speed: number) {
    const rotors = vehicle.userData.rotors as THREE.Object3D[] | undefined
    if (!rotors) return
    rotors[0].rotation.y += dt * 22 * speed
    rotors[1].rotation.x += dt * 30 * speed
  }

  /** During the escape: a flying vehicle's rotors race. */
  escape(dt: number) {
    const campaign = this.r.campaign
    const vehicle = campaign?.props.vehicles.get(campaign.mission.extraction)
    if (vehicle) this.spin(vehicle, dt, 1.4)
  }

  reset() { this.arrived = false; this.landing = 0 }

  dispose() {
    this.root.removeFromParent()
    for (const cone of [...this.guardCones, ...this.cameraCones.values()]) { cone.fillMaterial.dispose(); cone.edgeMaterial.dispose() }
    for (const geometry of [this.guardFan, this.guardEdge, this.cameraFan, this.cameraEdge]) geometry.dispose()
    this.glintMaterial.map?.dispose(); this.glintMaterial.dispose()
  }
}

/** A four-pointed amber star with an ink rim, so it shows on white paper. */
function glintTexture() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const context = canvas.getContext('2d')
  if (!context) return null
  context.translate(32, 32)
  context.beginPath()
  for (let i = 0; i < 8; i++) {
    const radius = i % 2 ? 7 : 29, angle = i * Math.PI / 4
    context.lineTo(Math.sin(angle) * radius, -Math.cos(angle) * radius)
  }
  context.closePath()
  context.fillStyle = '#ffb000'
  context.strokeStyle = '#111'
  context.lineWidth = 3
  context.fill(); context.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
