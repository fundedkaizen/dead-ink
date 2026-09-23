import { builders, type Gun } from '../lab/weapons/models'
import { buildDeathMachine, buildLmg } from '../lab/weapons/models/automatics'
import { buildRevolver } from '../lab/weapons/models/handguns'
import { buildInkRay } from '../lab/weapons/models/wonder'
import type { WeaponItem, WeaponName } from './types'

/** Mission and lab share original procedural meshes, including the scoped bolt rifle. */
export function createMissionGun(name: WeaponName, special?: WeaponItem['special']): Gun {
  if (special === 'deathMachine') return buildDeathMachine()
  if (special === 'rayGun') return buildInkRay()
  if (name === 'magnum') return buildRevolver()
  if (name === 'lmg') return buildLmg()
  return builders[name]()
}
