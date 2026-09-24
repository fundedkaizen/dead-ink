import * as THREE from 'three'

/**
 * Call of Duty's last stand, in ink. Downed in co-op you lie propped on an elbow with the best pistol you
 * carry (the Ink Ray first), crawl, and shoot, until a teammate holds F over you or you bleed out. The
 * teammate kneels with a syringe of blue (the revive colour, Second Draft's) and drives the plunger home;
 * letting go stops it.
 */

/** A red cross in a ring over a downed teammate: seen through walls, pinned to the screen's edge. */
export const REVIVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#c8322b"/>' +
  '<path d="M10 5.5h4v4.5h4.5v4H14v4.5h-4V14H5.5v-4H10z" fill="#fbfaf5"/></svg>'

const BLUE = 0x2f6fd0
/** Up from below the view, and away again, this fast (seconds). */
const RAISE = 0.18
const LENGTH = 0.11
/** The dose when full: from just behind the needle to the plunger's stopper (metres). */
const DOSE = 0.098

/** The syringe in your hands while you revive, as a camera child: up from below, the plunger driven home as it runs. */
export class ReviveSyringe {
  readonly root = new THREE.Group()
  private plunger = new THREE.Group()
  private dose: THREE.Mesh
  private shown = 0
  private wanted = 0
  private materials: THREE.Material[]

  constructor(camera: THREE.Camera) {
    this.root.name = 'Revive syringe'
    const paper = new THREE.MeshBasicMaterial({ color: 0xfbfaf5, toneMapped: false })
    const ink = new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false })
    const outline = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, toneMapped: false })
    // The far wall of the barrel, pale and solid just inside the outline: seen through the glass it keeps
    // the barrel light (as the perk bottle does), leaving an ink rim at its edges.
    const wall = new THREE.MeshBasicMaterial({ color: 0xeef3f8, side: THREE.BackSide, toneMapped: false })
    const glass = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false })
    const blue = new THREE.MeshBasicMaterial({ color: BLUE, toneMapped: false })
    this.materials = [paper, ink, outline, wall, glass, blue]
    // Built along -Z (pointing away from you), needle first.
    const along = (geometry: THREE.BufferGeometry) => geometry.rotateX(-Math.PI / 2)
    /** A solid part in paper with an ink rim: the same shape a touch bigger, drawn from behind. */
    const inked = (geometry: THREE.BufferGeometry, grow = 1.12) => {
      const group = new THREE.Group()
      const rim = new THREE.Mesh(geometry, outline)
      rim.scale.setScalar(grow)
      group.add(rim, new THREE.Mesh(geometry, paper))
      return group
    }
    const tube = (radius: number, material: THREE.Material, open = false) => new THREE.Mesh(along(new THREE.CylinderGeometry(radius, radius, LENGTH, 20, 1, open)), material)
    const glassFront = tube(0.014, glass, true)
    glassFront.renderOrder = 2
    this.dose = new THREE.Mesh(along(new THREE.CylinderGeometry(0.0118, 0.0118, 1, 16)), blue)
    this.root.add(tube(0.0156, outline), tube(0.0149, wall), this.dose, glassFront)
    // Three ink graduations round the barrel.
    for (const z of [-0.025, 0, 0.025]) {
      const mark = new THREE.Mesh(new THREE.TorusGeometry(0.0143, 0.0007, 4, 20), ink)
      mark.position.z = z
      this.root.add(mark)
    }
    // Needle hub and needle at the front; the finger flange at the back.
    const hub = inked(along(new THREE.CylinderGeometry(0.0045, 0.012, 0.02, 14)))
    hub.position.z = -LENGTH / 2 - 0.01
    const needle = new THREE.Mesh(along(new THREE.CylinderGeometry(0.0009, 0.0013, 0.05, 6)), ink)
    needle.position.z = -LENGTH / 2 - 0.045
    const flange = inked(new THREE.BoxGeometry(0.056, 0.007, 0.01), 1.18)
    flange.position.z = LENGTH / 2
    // The plunger, full: its stopper at the back of the dose, the rod out behind the barrel, a thumb pad,
    // and the thumb on it. It moves as one, by what has been pushed in.
    const stopper = new THREE.Mesh(along(new THREE.CylinderGeometry(0.0119, 0.0119, 0.004, 16)), ink)
    stopper.position.z = DOSE / 2 + 0.002
    const rod = new THREE.Mesh(along(new THREE.CylinderGeometry(0.0035, 0.0035, 0.075, 8)), ink)
    rod.position.z = DOSE / 2 + 0.04
    const pad = inked(along(new THREE.CylinderGeometry(0.013, 0.013, 0.005, 18)), 1.2)
    pad.position.z = DOSE / 2 + 0.08
    const thumb = inked(new THREE.CapsuleGeometry(0.008, 0.03, 3, 8).rotateX(Math.PI / 2 - 0.5), 1.25)
    thumb.position.set(0, 0.012, DOSE / 2 + 0.088)
    this.plunger.add(stopper, rod, pad, thumb)
    // A paper hand round the barrel's back end.
    const fist = inked(new THREE.CapsuleGeometry(0.021, 0.045, 4, 12).rotateX(Math.PI / 2), 1.1)
    fist.position.set(0, -0.004, 0.03)
    this.root.add(hub, needle, flange, this.plunger, fist)
    this.root.traverse(object => { object.userData.noCollision = true; object.frustumCulled = false })
    this.root.visible = false
    camera.add(this.root)
  }

  /** Up it comes (holding F over a downed teammate). */
  start() { this.wanted = 1 }
  /** Away (done, let go, or interrupted). */
  stop() { this.wanted = 0 }

  /** `progress` 0 to 1: how far the revive has run. */
  update(dt: number, progress: number) {
    this.shown = THREE.MathUtils.clamp(this.shown + (this.wanted ? dt : -dt) / RAISE, 0, 1)
    this.root.visible = this.shown > 0
    if (!this.root.visible) return
    const up = this.shown * this.shown * (3 - 2 * this.shown)
    // Low in the right of the view, needle down and in toward whoever is on the floor, with a small tremble.
    this.root.position.set(0.12, -0.13 - (1 - up) * 0.3, -0.33)
    this.root.rotation.set(-0.55, 0.3, 0.12 + Math.sin(performance.now() / 90) * 0.006)
    // What is left of the dose, against the needle end, and the plunger right behind it.
    const left = Math.max(0.002, 1 - THREE.MathUtils.clamp(progress, 0, 1)) * DOSE
    this.dose.scale.set(1, 1, left)
    this.dose.position.z = -DOSE / 2 + left / 2
    this.plunger.position.z = left - DOSE
  }

  dispose() {
    this.root.removeFromParent()
    this.root.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() })
    for (const material of this.materials) material.dispose()
  }
}
