import { builders, type Gun } from '../lab/weapons/models'
import { buildDeathMachine } from '../lab/weapons/models/automatics'
import { buildInkRay } from '../lab/weapons/models/wonder'
import type { WeaponItem, WeaponName } from './types'

/** Mission and lab share original procedural meshes, including the scoped bolt rifle. */
export function createMissionGun(name: WeaponName, special?: WeaponItem['special']): Gun {
  return special === 'deathMachine' ? buildDeathMachine() : special === 'rayGun' ? buildInkRay() : builders[name]()
}
