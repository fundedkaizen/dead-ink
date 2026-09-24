// Run with agent-browser eval --stdin on a freshly loaded dev /?mode=zombies page, after
// window.__environment.mission.ready. Draws the co-op partner (src/game/zombies/partner-poses.ts) in one pose
// from the front, the side and above, with the game's own renderer, as a sheet over the page; screenshot it.
// Pick the pose first:  window.__partnerPoseCapture = { name: 'down', time: 2.4, label: 'last stand' }
// (name and time as window.__partnerPoses.at takes them). Reload the page when done.
(async () => {
  const env = window.__environment, api = window.__partnerPoses
  if (!env?.mission?.ready || !api) throw new Error('Needs a dev /?mode=zombies page after mission.ready')
  const { name = 'down', time = 2.4, label = name } = window.__partnerPoseCapture ?? {}
  const avatar = await api.at(name, time)
  const renderer = env.renderer, scene = env.scene, camera = env.camera.active
  const V = camera.position.constructor
  const actor = avatar.actor, root = actor.root
  root.updateMatrixWorld(true)
  // Aim at the body's middle, between the hips and the head, whatever the pose.
  const hips = actor.rig.bones.hips.getWorldPosition(new V()), head = actor.rig.bones.head.getWorldPosition(new V())
  const target = hips.clone().lerp(head, 0.45)
  const facing = new V(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y)), side = new V(facing.z, 0, -facing.x)
  const views = [
    ['front', target.clone().addScaledVector(facing, 3.0).add(new V(0, 0.8, 0))],
    ['side', target.clone().addScaledVector(side, 3.0).add(new V(0, 0.6, 0))],
    ['above', target.clone().add(new V(0, 3.6, 0)).addScaledVector(facing, 0.4)],
  ]
  const saved = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), aspect: camera.aspect, fov: camera.fov }
  // Three views across the window.
  const w = Math.floor(Math.min(480, (window.innerWidth - 16) / views.length)), h = Math.round(w * 0.75), pad = 30
  const sheet = document.createElement('canvas'), g = sheet.getContext('2d')
  sheet.width = w * views.length; sheet.height = h + pad
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, sheet.width, sheet.height)
  renderer.setSize(w, h, false)
  camera.aspect = w / h; camera.fov = 40; camera.updateProjectionMatrix()
  try {
    views.forEach(([view, eye], i) => {
      camera.position.copy(eye)
      camera.up.set(0, 1, 0)
      if (view === 'above') camera.up.copy(facing).negate()
      camera.lookAt(target)
      camera.updateMatrixWorld(true)
      renderer.render(scene, camera)
      g.drawImage(renderer.domElement, i * w, pad, w, h)
      g.fillStyle = '#111'; g.font = '16px sans-serif'; g.fillText(`${label}: ${view}`, i * w + 10, 20)
    })
  } finally {
    // The game sizes its canvas to the window (main.ts resize()); put the camera back as it was.
    renderer.setSize(window.innerWidth, window.innerHeight, false)
    camera.position.copy(saved.position); camera.quaternion.copy(saved.quaternion); camera.up.copy(saved.up)
    camera.aspect = saved.aspect; camera.fov = saved.fov; camera.updateProjectionMatrix()
    env.invalidate()
  }
  document.querySelector('#partner-pose-sheet')?.remove()
  const cover = document.createElement('div')
  cover.id = 'partner-pose-sheet'
  // Visible even before the page's first frame lifts the loading card (index.html hides the rest until then).
  cover.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;background:#fff;visibility:visible'
  cover.append(sheet)
  document.body.append(cover)
  return { name, time, phase: avatar.poses.phase, target: target.toArray().map(v => +v.toFixed(2)), sheet: [sheet.width, sheet.height] }
})()
