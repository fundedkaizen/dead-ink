import { makeClip, type Pose } from '../clip'
import type { Action } from '../registry'

import { hang } from '../hang'
export { hang }

const exhale: Pose = { ...hang, spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] }
const inhale: Pose = {
  ...hang,
  'upper_arm.L': [-76, 0, 3], 'upper_arm.R': [-76, 0, -3],
  spine: [-1, 0, 0], chest: [-2.5, 0, 0], head: [1.5, 0, 0],
}

export const clips = {
  idle: makeClip('idle', [
    { t: 0, pose: exhale },
    { t: 1.7, pose: inhale, root: [0, 0.008, 0] },
  ], { loop: true, duration: 3.6 }),
}

export const actions: Action[] = [
  { group: 'Locomotion', label: 'Idle', hotkey: 'i', run: ({ player }) => { player.play(clips.idle) } },
]
