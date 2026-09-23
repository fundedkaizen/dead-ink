import * as THREE from 'three'
import { penPalette } from '../../render/ballpoint'
import { zombieEyeMaterial } from '../../render/ink'
import type { EnemyActor } from '../actors'

/**
 * The Blot: Dead Ink's gas zombie, in the manner of Call of Duty's Nova crawlers. Swollen with ink, it
 * limps and drips, and when it dies its belly bursts into a cloud of poison ink that hurts any player
 * inside it (zombies do not mind). Kill it far away, or stay out of the cloud.
 *
 * Numbers are our own design, tuned by play, not taken from a source.
 */
export const BLOT = {
  /** From this round on, a share of the zombies are Blots: 5% at round 8, rising to 12% by round 20. */
  firstRound: 8, share: 0.05, shareMax: 0.12, fullRound: 20,
  /** Its health against an ordinary zombie's this round, and its speed in metres per second. */
  health: 1.4, speed: 1.35,
} as const

/** The cloud: radius in metres, seconds it lasts, a player's damage per second at its heart (before difficulty). */
export const GAS = { radius: 3.5, seconds: 6, damagePerSecond: 15, clouds: 6, puffs: 26 } as const

/** The share of this round's zombies that are Blots (0 before round 8). */
export function blotShare(round: number) {
  const r = Math.floor(round)
  if (r < BLOT.firstRound) return 0
  const k = Math.min(1, (r - BLOT.firstRound) / (BLOT.fullRound - BLOT.firstRound))
  return BLOT.share + (BLOT.shareMax - BLOT.share) * k
}

/** Whether the next zombie spawned this round is a Blot. */
export function rollBlot(round: number, random: () => number) {
  return random() < blotShare(round)
}

// ---------------------------------------------------------------- the Blot's look

/**
 * The swollen belly: a black ink bladder on the spine, with lumps, two red sores (red is danger, and the
 * Blot is the one zombie you must not kill up close) and ink hanging off it in drips. Made once per pooled
 * actor, shown only while it is a Blot.
 */
export function setBloat(actor: EnemyActor, on: boolean) {
  let bloat = actor.root.userData.bloat as THREE.Group | undefined
  if (!bloat && !on) return
  if (!bloat) {
    bloat = new THREE.Group()
    bloat.name = 'Blot belly'
    const ink = new THREE.MeshBasicMaterial({ color: penPalette.character, toneMapped: false })
    const ball = new THREE.SphereGeometry(1, 18, 14)
    const belly = new THREE.Mesh(ball, ink)
    belly.position.set(0, 0.02, 0.2)
    belly.scale.set(0.28, 0.3, 0.25)
    bloat.add(belly)
    // Lumps swelling out of it.
    for (const [x, y, z, r] of [[0.16, 0.12, 0.3, 0.09], [-0.18, -0.04, 0.28, 0.1], [0.05, -0.16, 0.36, 0.08], [-0.08, 0.2, 0.32, 0.07]] as const) {
      const lump = new THREE.Mesh(ball, ink)
      lump.position.set(x, y, z); lump.scale.setScalar(r)
      bloat.add(lump)
    }
    const sore = zombieEyeMaterial()
    for (const [x, y, z, r] of [[0.1, 0.03, 0.45, 0.035], [-0.12, 0.14, 0.4, 0.028]] as const) {
      const spot = new THREE.Mesh(ball, sore)
      spot.position.set(x, y, z); spot.scale.set(r, r, r * 0.6)
      bloat.add(spot)
    }
    // Ink hanging off the underside in drips.
    const cone = new THREE.ConeGeometry(1, 1, 8).rotateX(Math.PI)
    for (const [x, z, h] of [[0.06, 0.3, 0.16], [-0.1, 0.26, 0.11], [0.15, 0.2, 0.09]] as const) {
      const drip = new THREE.Mesh(cone, ink)
      drip.position.set(x, -0.2 - h * 0.35, z); drip.scale.set(0.028, h, 0.028)
      bloat.add(drip)
    }
    bloat.traverse(o => { o.userData.noCollision = true })
    // Laid out facing the character's front (+Z) and up (+Y) in its bind pose, whatever the spine bone's own axes.
    const spine = actor.rig.bones.spine, skeleton = actor.rig.mesh.skeleton
    const inverse = skeleton.boneInverses[skeleton.bones.indexOf(spine)]
    if (inverse) bloat.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(inverse))
    spine.add(bloat)
    actor.root.userData.bloat = bloat
  }
  bloat.visible = on
}

/** Where ink drips off a Blot, in world space. */
export function bloatDripPoint(actor: EnemyActor, out = new THREE.Vector3()) {
  const bloat = actor.root.userData.bloat as THREE.Group | undefined
  out.set((Math.random() - 0.5) * 0.25, -0.26, 0.2 + Math.random() * 0.14)
  return bloat ? bloat.localToWorld(out) : actor.rig.bones.spine.getWorldPosition(out)
}

/** The centre of the belly, in world space: where it bursts. */
export function bloatCentre(actor: EnemyActor, out = new THREE.Vector3()) {
  const bloat = actor.root.userData.bloat as THREE.Group | undefined
  return bloat ? bloat.localToWorld(out.set(0, 0.02, 0.25)) : actor.rig.bones.spine.getWorldPosition(out)
}

// ---------------------------------------------------------------- the cloud

const INK = new THREE.Color(penPalette.ink), PAPER = new THREE.Color(penPalette.paper)
/** A deep, dirty red in the hatching's gaps: this smoke hurts. */
const DANGER = new THREE.Color(0x8c2a22)
const smooth = THREE.MathUtils.smoothstep
const easeOut = (v: number) => 1 - (1 - Math.min(1, Math.max(0, v))) ** 3

/**
 * Dark hatched ink puffs, the same drawing as the grenade smoke (vfx.ts) turned the other way: mostly
 * ink, cross-hatched even on the lit side, the paper between the lines stained red, and slow, heavy
 * billows. Per instance, `puff` is: x tone (0 paper .. 1 ink), y dissolve, z seed, w unused.
 */
function gasMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { paper: { value: PAPER.clone() }, ink: { value: INK.clone() }, danger: { value: DANGER.clone() }, time: { value: 0 } },
    vertexShader: `
      attribute vec4 puff;
      uniform float time;
      varying vec3 vViewNormal;
      varying vec3 vWorldNormal;
      varying vec3 vView;
      varying vec3 vLocal;
      varying vec4 vPuff;
      varying float vNear;
      void main() {
        vPuff = puff;
        vLocal = position;
        // Slow, heavy billows that keep rolling.
        float lump = sin(position.x * 3.3 + puff.z * 17.0 + time * 0.9) * sin(position.y * 2.9 + puff.z * 7.0 - time * 0.7) * sin(position.z * 3.6 + puff.z * 11.0);
        vec3 p = position * (1.0 + 0.24 * lump);
        vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vec4 view = viewMatrix * world;
        mat3 turn = mat3(modelMatrix) * mat3(instanceMatrix);
        vWorldNormal = normalize(turn * normal);
        vViewNormal = normalize(mat3(viewMatrix) * vWorldNormal);
        vView = -view.xyz;
        // Right at the camera it thins away; the screen effect tells you you are inside.
        vNear = smoothstep(0.3, 2.2, -view.z);
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform vec3 paper;
      uniform vec3 ink;
      uniform vec3 danger;
      varying vec3 vViewNormal;
      varying vec3 vWorldNormal;
      varying vec3 vView;
      varying vec3 vLocal;
      varying vec4 vPuff;
      varying float vNear;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
          mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
      void main() {
        float grain = noise(vLocal * 2.2 + vPuff.z * 9.0) * 0.7 + noise(vLocal * 5.0 - vPuff.z * 3.0) * 0.3;
        float gone = max(vPuff.y, 1.0 - vNear);
        if (grain < gone) discard;
        float light = clamp(dot(normalize(vWorldNormal), normalize(vec3(0.35, 0.9, 0.25))) * 0.5 + 0.5, 0.0, 1.0);
        float dark = clamp((1.0 - light) * 0.8 + vPuff.x * 0.75 - 0.1, 0.0, 1.0);
        // Pen hatching, tighter than the grenade smoke's: one way, crossed, then solid ink.
        float along = gl_FragCoord.x + gl_FragCoord.y, across = gl_FragCoord.x - gl_FragCoord.y;
        float inked = max(step(fract(along / 6.0), (dark - 0.15) * 0.6), step(fract(across / 6.0), (dark - 0.6) * 0.8));
        if (dark > 0.93) inked = 1.0;
        // A thin ink contour, ragged where it is being eaten away, as wisps rather than rocks.
        float rim = 1.0 - abs(dot(normalize(vViewNormal), normalize(vView)));
        if (rim > 0.86 || grain < gone + 0.04) inked = 1.0;
        gl_FragColor = vec4(mix(mix(paper, danger, 0.55), ink, inked), 1.0);
        #include <colorspace_fragment>
      }`,
  })
}

/** A ragged pool of ink on the ground under a cloud, radius about 1. */
function poolGeometry() {
  const points: THREE.Vector2[] = []
  for (let i = 0; i < 48; i++) {
    const a = i / 48 * Math.PI * 2
    const r = 0.8 + Math.sin(a * 4 + 0.6) * 0.1 + Math.sin(a * 9 + 1.7) * 0.06 + (i % 6 === 0 ? 0.14 : 0)
    points.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r))
  }
  const geometry = new THREE.ShapeGeometry(new THREE.Shape(points))
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

type Cloud = { centre: THREE.Vector3; drift: THREE.Vector3; age: number; seed: number }

export class GasClouds {
  readonly puffs: THREE.InstancedMesh
  readonly pools: THREE.InstancedMesh
  private clouds: Cloud[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private point = new THREE.Vector3()
  private color = new THREE.Color()
  private time = 0

  constructor(scene: THREE.Object3D) {
    const capacity = GAS.clouds * GAS.puffs
    const geometry = new THREE.IcosahedronGeometry(1, 3)
    geometry.setAttribute('puff', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage))
    this.puffs = setup(new THREE.InstancedMesh(geometry, gasMaterial(), capacity), 'Poison ink gas')
    this.pools = setup(new THREE.InstancedMesh(poolGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), GAS.clouds), 'Poison ink pools')
    this.pools.setColorAt(0, INK)
    this.pools.renderOrder = 1
    scene.add(this.puffs, this.pools)
  }

  /** A Blot burst here (`position` on the ground). The oldest cloud gives way past the cap. */
  emit(position: THREE.Vector3) {
    const angle = Math.random() * Math.PI * 2
    this.clouds.push({ centre: position.clone(), drift: new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(0.18 + Math.random() * 0.14), age: 0, seed: Math.random() * 100 })
    if (this.clouds.length > GAS.clouds) this.clouds.shift()
  }

  get count() { return this.clouds.length }
  get active() { return this.clouds.length > 0 }

  /** Its reach this moment: it bursts out to full size in well under a second. */
  private radius(cloud: Cloud) { return GAS.radius * (0.6 + 0.4 * easeOut(cloud.age / 0.6)) }
  /** How thick it is this moment: full, then thinning over its last second and a half. */
  private density(cloud: Cloud) { return smooth(cloud.age, 0, 0.25) * (1 - smooth(cloud.age, GAS.seconds - 1.5, GAS.seconds)) }

  /**
   * How deep in gas `point` is (a player's eye or chest), 0..1: 1 anywhere in the inner half of a fresh
   * cloud, fading to 0 at its edge, and with the cloud as it thins. The thickest cloud counts.
   */
  exposure(point: THREE.Vector3) {
    let most = 0
    for (const cloud of this.clouds) {
      const up = point.y - cloud.centre.y
      if (up < -1 || up > 3.4) continue
      const r = this.radius(cloud), d = Math.hypot(point.x - cloud.centre.x, point.z - cloud.centre.z)
      if (d >= r) continue
      most = Math.max(most, (1 - smooth(d, r * 0.5, r)) * this.density(cloud))
    }
    return most
  }

  update(dt: number) {
    const delta = Math.min(dt, 0.05)
    this.time += delta
    ;(this.puffs.material as THREE.ShaderMaterial).uniforms.time.value = this.time
    this.clouds = this.clouds.filter(cloud => (cloud.age += delta) < GAS.seconds)
    const tones = this.puffs.geometry.getAttribute('puff') as THREE.InstancedBufferAttribute
    let n = 0, pools = 0
    for (const cloud of this.clouds) {
      // It drifts, slowing as it spreads.
      cloud.centre.addScaledVector(cloud.drift, delta * (0.4 + 0.6 * smooth(cloud.age, 0, 1.5)))
      const t = cloud.age, r = this.radius(cloud), grow = 0.3 + 0.7 * easeOut(t / 0.7)
      for (let i = 0; i < GAS.puffs; i++) {
        // Spread evenly over the disc (golden angle), rolling slowly round. Each puff keeps welling up from
        // the ground, swelling as it rises and thinning away at the top, so the cloud churns instead of sitting.
        const out = Math.sqrt((i + 0.5) / GAS.puffs)
        const a = i * 2.39996 + cloud.seed + t * (i % 2 ? 0.2 : -0.14)
        const reach = r * 0.82 * out * grow
        const phase = ((i * 0.618034 + t / 2.4) % 1 + 1) % 1
        const size = (0.5 + 0.3 * ((i * 0.53) % 1)) * (1.1 - 0.15 * out) * grow * (0.7 + 0.6 * phase)
        const y = cloud.centre.y + size * 0.35 + phase * (2.4 - 1.1 * out)
        // Eaten away as it rises; everything thins out over the cloud's last seconds.
        const dissolve = Math.max(0.06 + 0.8 * smooth(phase, 0.45, 1), smooth(t, GAS.seconds - 2.4 - (i % 4) * 0.35, GAS.seconds - (i % 3) * 0.15))
        if (dissolve >= 1) continue
        this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, cloud.seed + i)
        this.puffs.setMatrixAt(n, this.matrix.compose(this.point.set(cloud.centre.x + Math.cos(a) * reach, y, cloud.centre.z + Math.sin(a) * reach), this.quaternion, this.scale.set(size, size * 0.85, size)))
        tones.setXYZW(n, 0.5 + 0.4 * (1 - phase) * ((i * 0.29) % 1 * 0.5 + 0.5), dissolve, cloud.seed + i * 3.1, 0)
        n++
      }
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, cloud.seed)
      this.pools.setMatrixAt(pools, this.matrix.compose(this.point.copy(cloud.centre).setY(cloud.centre.y + 0.015), this.quaternion, this.scale.set(r * 0.62, 1, r * 0.62)))
      this.pools.setColorAt(pools++, this.color.copy(INK).lerp(PAPER, smooth(t, GAS.seconds - 2.5, GAS.seconds)))
    }
    finish(this.puffs, n, tones)
    finish(this.pools, pools)
  }

  clear() { this.clouds = []; finish(this.puffs, 0); finish(this.pools, 0) }

  dispose() {
    this.clear()
    for (const mesh of [this.puffs, this.pools]) { mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose() }
  }
}

function setup(mesh: THREE.InstancedMesh, name: string) {
  mesh.name = name
  mesh.userData.noCollision = true
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.visible = false
  return mesh
}

function finish(mesh: THREE.InstancedMesh, count: number, attribute?: THREE.BufferAttribute) {
  mesh.count = count
  mesh.visible = count > 0
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  if (attribute) attribute.needsUpdate = true
}
