import { builders, type Gun } from '../lab/weapons/models'
import { buildDeathMachine } from '../lab/weapons/models/automatics'
import type { WeaponItem, WeaponName } from './types'

/** Mission and lab share original procedural meshes, including the scoped bolt rifle. */
export function createMissionGun(name: WeaponName, special?: WeaponItem['special']): Gun {
  return special === 'deathMachine' ? buildDeathMachine() : builders[name]()
}
