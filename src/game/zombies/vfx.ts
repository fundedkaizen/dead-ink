import * as THREE from 'three'
import { Draft, type Point } from '../../render/ink'
import { penPalette } from '../../render/ballpoint'
import type { CollisionWorld } from '../../player/collision'

/**
 * Dead Ink's big effects: the Nuke's mushroom cloud, grenade blasts, and the grenade itself. Everything
 * is pooled and instanced, so a blast costs the same draw calls as ten, and meshes hide themselves while
 * idle so they cost nothing at all between uses.
 *
 * Smoke is drawn the way the rest of the world is: white paper puffs with an ink outline and ink hatching
 * on the side away from the light, going darker the heavier the smoke. Colour appears only for heat
 * (orange, like the muzzle sparks) and fades out of the smoke within a second.
 */

const INK = new THREE.Color(penPalette.ink)
const PAPER = new THREE.Color(penPalette.paper)
const HEAT = new THREE.Color(0xffb13b)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const easeOut = (v: number) => 1 - (1 - clamp01(v)) ** 3
const smooth = THREE.MathUtils.smoothstep

// ---------------------------------------------------------------- shared pieces

/**
 * Hatched ink puffs. Per instance, `puff` is: x tone (0 paper white .. 1 black ink), y dissolve (0 whole
 * .. 1 gone, eaten away in blotches), z a seed for its lumps, w heat (fills it orange).
 */
function puffMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { paper: { value: PAPER.clone() }, ink: { value: INK.clone() }, heat: { value: HEAT.clone() } },
    vertexShader: `
      attribute vec4 puff;
      varying vec3 vViewNormal;
      varying vec3 vWorldNormal;
      varying vec3 vView;
      varying vec3 vLocal;
      varying vec4 vPuff;
      varying float vNear;
      void main() {
        vPuff = puff;
        vLocal = position;
        // Lumpy billows, different on every puff.
        float lump = sin(position.x * 4.1 + puff.z * 17.0) * sin(position.y * 3.7 + puff.z * 7.0) * sin(position.z * 4.3 + puff.z * 11.0);
        vec3 p = position * (1.0 + 0.2 * lump);
        vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vec4 view = viewMatrix * world;
        mat3 turn = mat3(modelMatrix) * mat3(instanceMatrix);
        vWorldNormal = normalize(turn * normal);
        vViewNormal = normalize(mat3(viewMatrix) * vWorldNormal);
        vView = -view.xyz;
        // Smoke right at the camera thins away, so a grenade at your feet does not blind you.
        vNear = smoothstep(0.5, 3.5, -view.z);
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform vec3 paper;
      uniform vec3 ink;
      uniform vec3 heat;
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
        float grain = noise(vLocal * 2.6 + vPuff.z * 9.0) * 0.7 + noise(vLocal * 6.0 - vPuff.z * 3.0) * 0.3;
        float gone = max(vPuff.y, 1.0 - vNear);
        if (grain < gone) discard;
        float light = clamp(dot(normalize(vWorldNormal), normalize(vec3(0.35, 0.9, 0.25))) * 0.5 + 0.5, 0.0, 1.0);
        float dark = clamp((1.0 - light) * 0.85 + vPuff.x * 0.8 - 0.12, 0.0, 1.0);
        // Screen-space pen hatching: one direction, then crossed, then solid ink.
        float along = gl_FragCoord.x + gl_FragCoord.y, across = gl_FragCoord.x - gl_FragCoord.y;
        float inked = max(step(fract(along / 7.0), (dark - 0.2) * 0.45), step(fract(across / 7.0), (dark - 0.55) * 0.6));
        if (dark > 0.94) inked = 1.0;
        inked *= 1.0 - vPuff.w * 0.85;
        // An ink contour where the puff turns away, and a ragged one where it is being eaten away.
        float rim = 1.0 - abs(dot(normalize(vViewNormal), normalize(vView)));
        if (rim > 0.74 || grain < gone + 0.035) inked = 1.0;
        gl_FragColor = vec4(mix(mix(paper, heat, vPuff.w), ink, inked), 1.0);
        #include <colorspace_fragment>
      }`,
  })
}

function puffMesh(name: string, capacity: number) {
  const geometry = new THREE.IcosahedronGeometry(1, 3)
  geometry.setAttribute('puff', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage))
  const mesh = new THREE.InstancedMesh(geometry, puffMaterial(), capacity)
  return setup(mesh, name)
}

/** Burst and blot sprites, side by side: [comic flash | ink splash]. */
function spriteSheet() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 256
  const c = canvas.getContext('2d')!
  // The flash: black spikes, an orange ring, a white-hot core.
  c.translate(128, 128)
  c.fillStyle = '#000'
  c.beginPath()
  for (let i = 0; i < 32; i++) {
    const a = i / 32 * Math.PI * 2, r = i % 2 ? 52 : (i % 4 ? 100 : 124)
    c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r)
  }
  c.closePath(); c.fill()
  c.fillStyle = '#ffb13b'; c.beginPath(); c.arc(0, 0, 58, 0, Math.PI * 2); c.fill()
  c.fillStyle = '#fff'; c.beginPath(); c.arc(0, 0, 38, 0, Math.PI * 2); c.fill()
  // The splash: a ragged ink blot with flung drops.
  c.setTransform(1, 0, 0, 1, 384, 128)
  c.fillStyle = '#000'
  c.beginPath()
  for (let i = 0; i <= 48; i++) {
    const a = i / 48 * Math.PI * 2
    const r = 70 + Math.sin(a * 7) * 14 + Math.sin(a * 13 + 1) * 9 + (i % 6 === 0 ? 30 : 0)
    c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r)
  }
  c.closePath(); c.fill()
  for (let i = 0; i < 18; i++) {
    const a = i * 2.39996, d = 96 + (i * 37 % 26)
    c.beginPath(); c.arc(Math.cos(a) * d, Math.sin(a) * d, 3 + (i * 13 % 8), 0, Math.PI * 2); c.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Camera-facing sprites. Per instance, `sprite` is: x alpha, y spin, z frame (0 flash, 1 splash), w dissolve. */
function spriteMesh(name: string, capacity: number) {
  const geometry = new THREE.PlaneGeometry(1, 1)
  geometry.setAttribute('sprite', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage))
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: spriteSheet() } },
    vertexShader: `
      attribute vec4 sprite;
      varying vec2 vUv;
      varying vec4 vSprite;
      varying float vNear;
      void main() {
        vSprite = sprite;
        vUv = vec2((uv.x + sprite.z) * 0.5, uv.y);
        float size = length(instanceMatrix[0].xyz);
        vec4 centre = viewMatrix * modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        // A burst right in your face would fill the screen with ink: fade it when the camera is inside it.
        vNear = smoothstep(0.2, 0.7, -centre.z / size);
        float c = cos(sprite.y), s = sin(sprite.y);
        centre.xy += mat2(c, s, -s, c) * position.xy * size;
        gl_Position = projectionMatrix * centre;
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec4 vSprite;
      varying float vNear;
      void main() {
        vec4 texel = texture2D(map, vUv);
        float grain = fract(sin(dot(floor(vUv * 64.0), vec2(12.9898, 78.233))) * 43758.5453);
        if (grain < vSprite.w) discard;
        gl_FragColor = vec4(texel.rgb, texel.a * vSprite.x * vNear);
        if (gl_FragColor.a < 0.02) discard;
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.renderOrder = 13
  return setup(mesh, name)
}

function ringMesh(name: string, capacity: number, inner = 0.9) {
  const mesh = new THREE.InstancedMesh(new THREE.RingGeometry(inner, 1, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), capacity)
  mesh.setColorAt(0, INK)
  return setup(mesh, name)
}

function setup<T extends THREE.InstancedMesh>(mesh: T, name: string) {
  mesh.name = name
  mesh.userData.noCollision = true
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.visible = false
  return mesh
}

function finish(mesh: THREE.InstancedMesh, count: number, ...attributes: string[]) {
  mesh.count = count
  mesh.visible = count > 0
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  for (const name of attributes) mesh.geometry.getAttribute(name).needsUpdate = true
}

function release(mesh: THREE.InstancedMesh) {
  mesh.removeFromParent()
  mesh.geometry.dispose()
  const material = mesh.material as THREE.Material & { uniforms?: { map?: { value: THREE.Texture | null } } }
  material.uniforms?.map?.value?.dispose()
  material.dispose()
  mesh.dispose()
}

// ---------------------------------------------------------------- the Nuke

const CLOUD_LIFE = 4.8
const CLOUDS = 2
const STEM = 36, CAP_AROUND = 14, CAP_TUBE = 4, CROWN = 7, SKIRT = 34
const PER_CLOUD = STEM + CAP_AROUND * CAP_TUBE + CROWN + SKIRT

type Cloud = { origin: THREE.Vector3; age: number; scale: number; seed: number }

/**
 * A Call of Duty style mushroom cloud, rising in the distance when the Nuke is picked up: a comic flash,
 * a fireball that climbs on a stem and rolls out into a cap, a surge of dust round its foot and a shock
 * ring racing out over the ground. About 72 m tall at scale 1 so it reads from across the map; it thins
 * away into the paper after ~4.5 s. Three draw calls while it plays, none after.
 */
export class MushroomCloud {
  readonly puffs = puffMesh('Nuke mushroom cloud', CLOUDS * PER_CLOUD)
  readonly sprites = spriteMesh('Nuke flash', CLOUDS)
  readonly rings = ringMesh('Nuke shock ring', CLOUDS * 2, 0.95)
  private clouds: Cloud[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private point = new THREE.Vector3()
  private color = new THREE.Color()

  constructor(scene: THREE.Object3D) {
    scene.add(this.puffs, this.sprites, this.rings)
  }

  /** Set it off at `position` (on the ground). Scale 1 is ~72 m tall; keep it 150-300 m from the player. */
  trigger(position: THREE.Vector3, scale = 1) {
    this.clouds.push({ origin: position.clone(), age: 0, scale, seed: Math.random() * 100 })
    if (this.clouds.length > CLOUDS) this.clouds.shift()
  }

  /** 0..1: how white the screen should flash right now, for a HUD overlay if the caller wants one. */
  get screenFlash() {
    return this.clouds.reduce((most, cloud) => Math.max(most, 1 - smooth(cloud.age, 0.05, 0.7)), 0)
  }

  get active() { return this.clouds.length > 0 }

  update(dt: number) {
    const delta = Math.min(dt, 0.05)
    this.clouds = this.clouds.filter(cloud => (cloud.age += delta) < CLOUD_LIFE)
    const tones = this.puffs.geometry.getAttribute('puff') as THREE.InstancedBufferAttribute
    let n = 0
    const put = (x: number, y: number, z: number, size: number, tone: number, dissolve: number, seed: number, heat: number) => {
      if (dissolve >= 1 || size <= 0) return
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, seed * 6.28)
      this.puffs.setMatrixAt(n, this.matrix.compose(this.point.set(x, y, z), this.quaternion, this.scale.setScalar(size)))
      tones.setXYZW(n, tone, dissolve, seed, heat)
      n++
    }
    let sprites = 0, rings = 0
    for (const cloud of this.clouds) {
      const t = cloud.age, s = cloud.scale, { x: ox, y: oy, z: oz } = cloud.origin
      const rise = easeOut(t / 3.1), height = s * (8 + 64 * rise)
      const spread = s * (7 + 22 * easeOut(t / 2.7)), tube = spread * 0.42
      const hot = 1 - smooth(t, 0.1, 1.2)
      const thin = (k: number) => smooth(t + k * 0.5, 3.1, CLOUD_LIFE)
      // Stem, wide at the foot and pinched under the cap.
      for (let i = 0; i < STEM; i++) {
        const k = i / STEM, y = height * k * 0.92
        if (y > height - tube * 0.6) continue
        const around = s * (2.2 + 5 * (1 - k) ** 3), a = i * 2.4 + t * 0.6 + cloud.seed
        const size = s * (4.4 + 3.6 * (1 - k)) * Math.min(1, t / 0.5 + 0.2)
        put(ox + Math.cos(a) * around, oy + y, oz + Math.sin(a) * around, size, 0.72 - 0.35 * k, thin(i % 3 / 3), cloud.seed + i, hot * (k > 0.6 ? 0.8 : 0.3))
      }
      // Cap: a rolling ring of billows, pale on top and dark underneath.
      for (let i = 0; i < CAP_AROUND; i++) for (let j = 0; j < CAP_TUBE; j++) {
        const phi = i / CAP_AROUND * Math.PI * 2 + cloud.seed, theta = j / CAP_TUBE * Math.PI * 2 + t * 0.9 + i * 0.4
        const reach = spread * 0.55 + tube * Math.cos(theta)
        const size = tube * (0.95 + 0.25 * Math.sin(i * 3.1 + j))
        put(ox + Math.cos(phi) * reach, oy + height + tube * Math.sin(theta) * 0.75, oz + Math.sin(phi) * reach,
          size, 0.3 - 0.28 * Math.sin(theta), thin((i + j) % 4 / 4), cloud.seed + i * 5 + j, hot)
      }
      for (let i = 0; i < CROWN; i++) {
        const a = i / CROWN * Math.PI * 2, r = i ? tube * 0.8 : 0
        put(ox + Math.cos(a) * r, oy + height + tube * (i ? 0.55 : 0.8), oz + Math.sin(a) * r, tube * 1.05, 0.08, thin(i % 2 / 2), cloud.seed + 50 + i, hot)
      }
      // The dust surge rolling out from its foot.
      for (let i = 0; i < SKIRT; i++) {
        const a = i / SKIRT * Math.PI * 2 + cloud.seed, r = s * (5 + 48 * easeOut(t / 3.2)) * (0.85 + (i % 3) * 0.1)
        const size = s * (7.5 - 2.5 * easeOut(t / 3)) * Math.min(1, t / 0.3)
        put(ox + Math.cos(a) * r, oy + size * 0.45, oz + Math.sin(a) * r, size, 0.35, smooth(t + (i % 4) * 0.2, 2.4, 4.2), cloud.seed + 80 + i, 0)
      }
      // The flash, hung in the fireball.
      if (t < 0.8) {
        const sprite = this.sprites.geometry.getAttribute('sprite') as THREE.InstancedBufferAttribute
        this.sprites.setMatrixAt(sprites, this.matrix.compose(this.point.set(ox, oy + height * 0.8 + s * 4, oz), this.quaternion.identity(), this.scale.setScalar(s * 110 * (0.35 + easeOut(t / 0.18) * 0.65))))
        sprite.setXYZW(sprites, 1 - smooth(t, 0.2, 0.8), t * 0.4, 0, smooth(t, 0.35, 0.8))
        sprites++
      }
      // Two shock rings over the ground, the second slower and wider.
      for (const [reach, life] of [[190, 2.2], [120, 3]] as const) {
        if (t > life) continue
        const k = t / life
        this.rings.setMatrixAt(rings, this.matrix.compose(this.point.set(ox, oy + 0.1, oz), this.quaternion.identity(), this.scale.setScalar(s * reach * easeOut(k) + 0.1)))
        this.rings.setColorAt(rings, this.color.copy(INK).lerp(PAPER, k * k))
        rings++
      }
    }
    finish(this.puffs, n, 'puff')
    finish(this.sprites, sprites, 'sprite')
    finish(this.rings, rings)
  }

  clear() { this.clouds = []; this.update(0) }

  dispose() {
    this.clouds = []
    for (const mesh of [this.puffs, this.sprites, this.rings]) release(mesh)
  }
}

// ---------------------------------------------------------------- grenades

const BLASTS = 10
const SMOKE = 16, CHUNKS = 20, SPARKS = 28
const SCORCHES = 16, SCORCH_LIFE = 12
const BLAST_LIFE = 0.6

type Blast = { position: THREE.Vector3; floor: number; radius: number; age: number; spin: number }
type Smoke = { position: THREE.Vector3; velocity: THREE.Vector3; size: number; grow: number; age: number; life: number; tone: number; seed: number }
type Chunk = { position: THREE.Vector3; velocity: THREE.Vector3; spin: THREE.Vector3; rotation: THREE.Euler; floor: number; size: number; age: number; life: number; bounced: boolean }
type Spark = { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number }
type Scorch = { position: THREE.Vector3; angle: number; size: number; age: number }

/** A charred starburst for the ground under a blast. */
function scorchShape() {
  const points: THREE.Vector2[] = []
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * Math.PI * 2
    let r = 0.5 + Math.sin(a * 5 + 0.7) * 0.07 + Math.sin(a * 13) * 0.04
    if (i % 4 === 0) r += 0.25 + (i * 7 % 5) * 0.08
    points.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r))
  }
  const geometry = new THREE.ShapeGeometry(new THREE.Shape(points))
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

/**
 * A grenade going off: a white-hot comic flash, an ink splash thrown out at the camera, black debris
 * that arcs and bounces, hot sparks, rolling hatched smoke, a ring over the ground and a scorch mark that
 * fades back into the paper. Pass the collision world to find the ground under the blast.
 */
export class Explosion {
  readonly smoke = puffMesh('Grenade smoke', BLASTS * SMOKE)
  readonly sprites = spriteMesh('Grenade flash and splash', BLASTS * 2)
  readonly chunks: THREE.InstancedMesh
  readonly sparks: THREE.InstancedMesh
  readonly rings = ringMesh('Grenade shock rings', BLASTS, 0.92)
  readonly scorches: THREE.InstancedMesh
  private blasts: Blast[] = []
  private puffs: Smoke[] = []
  private debris: Chunk[] = []
  private hot: Spark[] = []
  private marks: Scorch[] = []
  private matrix = new THREE.Matrix4()
  private quaternion = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private point = new THREE.Vector3()
  private color = new THREE.Color()
  private forward = new THREE.Vector3(0, 0, 1)
  private probe = new THREE.Vector3()

  constructor(scene: THREE.Object3D, private world?: CollisionWorld) {
    this.chunks = setup(new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: INK, toneMapped: false }), BLASTS * CHUNKS), 'Grenade debris')
    this.sparks = setup(new THREE.InstancedMesh(new THREE.BoxGeometry(0.02, 0.02, 1),
      new THREE.MeshBasicMaterial({ color: HEAT, toneMapped: false, transparent: true, depthWrite: false }), BLASTS * SPARKS), 'Grenade sparks')
    this.sparks.renderOrder = 12
    this.scorches = setup(new THREE.InstancedMesh(scorchShape(), new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), SCORCHES), 'Grenade scorch marks')
    this.scorches.setColorAt(0, INK)
    this.scorches.renderOrder = 1
    scene.add(this.smoke, this.sprites, this.chunks, this.sparks, this.rings, this.scorches)
  }

  /** Blow up at `position` with a lethal `radius` in metres; the effect scales with it. */
  emit(position: THREE.Vector3, radius = 4) {
    let floor = position.y
    if (this.world) {
      const ground = this.world.floor(this.probe.copy(position).setY(position.y + 0.3), 0.3, 3)
      if (Number.isFinite(ground)) floor = ground
    }
    const r = radius, up = Math.max(position.y, floor + 0.15)
    this.blasts.push({ position: position.clone().setY(up), floor, radius: r, age: 0, spin: Math.random() * 6 })
    if (this.blasts.length > BLASTS) this.blasts.shift()
    const direction = new THREE.Vector3()
    for (let i = 0; i < SMOKE; i++) {
      direction.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize()
      const size = r * (0.06 + Math.random() * 0.04)
      this.puffs.push({ position: new THREE.Vector3(position.x, up + size * 0.4, position.z).addScaledVector(direction, r * 0.1 * Math.random()),
        velocity: direction.clone().multiplyScalar(r * (0.5 + Math.random() * 0.9)).setY(r * (0.3 + Math.random() * 0.7)),
        size, grow: size * (2.8 + Math.random()), age: 0, life: 1.3 + Math.random() * 1.0, tone: 0.15 + Math.random() * 0.35, seed: Math.random() * 100 })
    }
    for (let i = 0; i < CHUNKS; i++) {
      direction.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize()
      this.debris.push({ position: new THREE.Vector3(position.x, up + 0.1, position.z),
        velocity: direction.clone().multiplyScalar(2.5 + Math.random() * r * 1.8).setY(3 + Math.random() * 6),
        spin: new THREE.Vector3(Math.random() * 16 - 8, Math.random() * 16 - 8, Math.random() * 16 - 8),
        rotation: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        floor: floor + 0.03, size: 0.03 + Math.random() * 0.07, age: 0, life: 1.3 + Math.random() * 0.9, bounced: false })
    }
    for (let i = 0; i < SPARKS; i++) {
      direction.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize()
      this.hot.push({ position: new THREE.Vector3(position.x, up + 0.15, position.z), velocity: direction.clone().multiplyScalar(9 + Math.random() * 16).setY(direction.y * 14 + 2),
        age: 0, life: 0.15 + Math.random() * 0.35 })
    }
    this.marks.push({ position: new THREE.Vector3(position.x, floor + 0.014, position.z), angle: Math.random() * Math.PI * 2, size: r * (0.55 + Math.random() * 0.15), age: 0 })
    if (this.puffs.length > BLASTS * SMOKE) this.puffs.splice(0, this.puffs.length - BLASTS * SMOKE)
    if (this.debris.length > BLASTS * CHUNKS) this.debris.splice(0, this.debris.length - BLASTS * CHUNKS)
    if (this.hot.length > BLASTS * SPARKS) this.hot.splice(0, this.hot.length - BLASTS * SPARKS)
    if (this.marks.length > SCORCHES) this.marks.shift()
  }

  get active() { return this.blasts.length + this.puffs.length + this.debris.length + this.hot.length + this.marks.length > 0 }

  update(dt: number) {
    const delta = Math.min(dt, 0.05)
    this.quaternion.identity()

    // Flash, then the ink splash, then the ring.
    this.blasts = this.blasts.filter(blast => (blast.age += delta) < BLAST_LIFE)
    const sprite = this.sprites.geometry.getAttribute('sprite') as THREE.InstancedBufferAttribute
    let sprites = 0, rings = 0
    for (const blast of this.blasts) {
      const t = blast.age, r = blast.radius
      if (t < 0.16) {
        this.sprites.setMatrixAt(sprites, this.matrix.compose(this.point.copy(blast.position).setY(blast.position.y + r * 0.2), this.quaternion, this.scale.setScalar(r * (0.9 + easeOut(t / 0.05) * 0.9))))
        sprite.setXYZW(sprites++, 1 - smooth(t, 0.06, 0.16), blast.spin, 0, 0)
      }
      if (t > 0.03 && t < 0.55) {
        this.sprites.setMatrixAt(sprites, this.matrix.compose(this.point.copy(blast.position).setY(blast.position.y + r * 0.25), this.quaternion, this.scale.setScalar(r * (0.5 + 1.3 * easeOut((t - 0.03) / 0.25)))))
        sprite.setXYZW(sprites++, 1, blast.spin + 1.3, 1, smooth(t, 0.14, 0.55))
      }
      if (t < 0.35) {
        const k = t / 0.35
        this.rings.setMatrixAt(rings, this.matrix.compose(this.point.copy(blast.position).setY(blast.floor + 0.04), this.quaternion, this.scale.setScalar(r * (0.2 + 1.5 * easeOut(k)))))
        this.rings.setColorAt(rings++, this.color.copy(INK).lerp(PAPER, k * k))
      }
    }
    finish(this.sprites, sprites, 'sprite')
    finish(this.rings, rings)

    // Smoke rolls out, slows, rises and thins away.
    this.puffs = this.puffs.filter(puff => (puff.age += delta) < puff.life)
    const tones = this.smoke.geometry.getAttribute('puff') as THREE.InstancedBufferAttribute
    this.puffs.forEach((puff, i) => {
      puff.velocity.multiplyScalar(Math.exp(-3.2 * delta))
      puff.velocity.y += 1.1 * delta
      puff.position.addScaledVector(puff.velocity, delta)
      const k = puff.age / puff.life
      const size = THREE.MathUtils.lerp(puff.size, puff.grow, easeOut(k * 1.6))
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, puff.seed)
      this.smoke.setMatrixAt(i, this.matrix.compose(puff.position, this.quaternion, this.scale.setScalar(size)))
      tones.setXYZW(i, puff.tone, smooth(k, 0.35, 1), puff.seed, 1 - smooth(puff.age, 0.04, 0.22))
    })
    finish(this.smoke, this.puffs.length, 'puff')

    // Debris arcs, bounces once and lies still before it shrinks away.
    this.debris = this.debris.filter(chunk => (chunk.age += delta) < chunk.life)
    this.debris.forEach((chunk, i) => {
      if (chunk.position.y > chunk.floor || chunk.velocity.y > 0) {
        chunk.velocity.y -= 16 * delta
        chunk.position.addScaledVector(chunk.velocity, delta)
        chunk.rotation.x += chunk.spin.x * delta; chunk.rotation.y += chunk.spin.y * delta; chunk.rotation.z += chunk.spin.z * delta
        if (chunk.position.y < chunk.floor) {
          chunk.position.y = chunk.floor
          if (chunk.bounced) chunk.velocity.set(0, 0, 0)
          else { chunk.bounced = true; chunk.velocity.set(chunk.velocity.x * 0.4, -chunk.velocity.y * 0.3, chunk.velocity.z * 0.4); chunk.spin.multiplyScalar(0.4) }
        }
      }
      this.scale.setScalar(chunk.size * (1 - smooth(chunk.age, chunk.life - 0.35, chunk.life)))
      this.chunks.setMatrixAt(i, this.matrix.compose(chunk.position, this.quaternion.setFromEuler(chunk.rotation), this.scale))
    })
    finish(this.chunks, this.debris.length)

    // Sparks: short hot streaks along their flight.
    this.hot = this.hot.filter(spark => (spark.age += delta) < spark.life)
    this.hot.forEach((spark, i) => {
      spark.velocity.y -= 12 * delta
      spark.position.addScaledVector(spark.velocity, delta)
      const speed = spark.velocity.length()
      this.quaternion.setFromUnitVectors(this.forward, this.point.copy(spark.velocity).divideScalar(speed))
      this.scale.set(1, 1, Math.min(0.6, speed * 0.03) * (1 - spark.age / spark.life))
      this.sparks.setMatrixAt(i, this.matrix.compose(spark.position, this.quaternion, this.scale))
    })
    finish(this.sparks, this.hot.length)

    // Scorch marks fade from ink back into the paper.
    this.marks = this.marks.filter(mark => (mark.age += delta) < SCORCH_LIFE)
    this.marks.forEach((mark, i) => {
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, mark.angle)
      this.scale.setScalar(mark.size * (0.5 + 0.5 * easeOut(mark.age / 0.12)))
      this.scorches.setMatrixAt(i, this.matrix.compose(mark.position, this.quaternion, this.scale))
      this.scorches.setColorAt(i, this.color.copy(INK).lerp(PAPER, smooth(mark.age, SCORCH_LIFE - 5, SCORCH_LIFE)))
    })
    finish(this.scorches, this.marks.length)
  }

  clear() { this.blasts = []; this.puffs = []; this.debris = []; this.hot = []; this.marks = []; this.update(0) }

  dispose() {
    this.clear()
    for (const mesh of [this.smoke, this.sprites, this.chunks, this.sparks, this.rings, this.scorches]) release(mesh)
  }
}

// ---------------------------------------------------------------- the grenade

/**
 * An ink-drawn frag grenade, about 9 cm tall: a segmented egg body, the fuze on top, the spoon lever
 * down one side and the pull ring through the pin. Origin at the body's centre, lever on +X, fuze up +Y.
 * A single Draft: three draw calls. Decorative, so it never collides.
 */
export function createGrenadeModel() {
  const g = new Draft('Frag grenade')
  g.userData.noCollision = true
  const r = 0.029, stretch = 1.18, top = r * stretch
  const body = new THREE.SphereGeometry(r, 20, 14)
  body.scale(1, stretch, 1)
  g.solid(body, [0, 0, 0], 'paper', false, [0, 0, 0], true)
  // The frag grid: rings of latitude and a few meridians, shading on the side away from the light.
  for (const k of [-0.62, -0.25, 0.12, 0.48]) {
    const y = k * top, rr = r * Math.sqrt(1 - k * k) + 0.0005
    g.ring(rr, y, 0, 0, 'detail', 28)
  }
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2
    const arc: Point[] = []
    for (let s = 0; s <= 10; s++) {
      const k = -0.9 + s / 10 * 1.6, rr = r * Math.sqrt(1 - k * k) + 0.0006
      arc.push([Math.cos(a) * rr, k * top, Math.sin(a) * rr])
    }
    g.line(arc, 'detail')
  }
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.95 + i * 0.12
    g.line([[Math.cos(a) * r * 1.01, -top * 0.5, Math.sin(a) * r * 1.01], [Math.cos(a + 0.2) * r * 1.01, top * 0.2, Math.sin(a + 0.2) * r * 1.01]], 'mesh')
  }
  // Fuze and its collar.
  g.cylinder(0.0095, 0.012, 0, top + 0.004, 0)
  g.cylinder(0.007, 0.008, 0, top + 0.014, 0)
  // The spoon: a thin strip from the fuze head, bent down the body's +X side.
  const spoon: Point[] = [[0.004, top + 0.019, 0], [0.013, top + 0.016, 0], [r * 0.72, top * 0.72, 0], [r * 1.02, top * 0.3, 0], [r * 1.06, -top * 0.1, 0], [r * 0.98, -top * 0.45, 0]]
  for (let i = 1; i < spoon.length; i++) g.beam(spoon[i - 1].map((v, j) => j === 0 ? v + 0.0015 : v) as Point, spoon[i].map((v, j) => j === 0 ? v + 0.0015 : v) as Point, 0.0035, 'paper', 'detail')
  g.box(0.004, 0.003, 0.011, r * 0.98, -top * 0.45, 0, 'paper', 'detail')
  // Pin through the fuze, and the pull ring hanging off it on -X.
  g.line([[-0.012, top + 0.006, 0], [0.012, top + 0.006, 0]], 'edge')
  const ring: Point[] = []
  for (let i = 0; i < 20; i++) {
    const a = i / 20 * Math.PI * 2
    ring.push([-0.012 - 0.011 + Math.cos(a) * 0.011, top + 0.006 + Math.sin(a) * 0.011, Math.sin(a) * 0.003])
  }
  g.line(ring, 'edge', true)
  const model = g.finish()
  model.traverse(object => { object.userData.noCollision = true })
  return model
}
