import { builders, type Gun } from '../lab/weapons/models'
import { buildDeathMachine, buildLmg } from '../lab/weapons/models/automatics'
import { buildInkCannon } from '../lab/weapons/models/cannon'
import { buildBurstPistol, buildLeverRifle, buildPdw } from '../lab/weapons/models/dead-ink-guns'
import { buildRevolver } from '../lab/weapons/models/handguns'
import { buildInkRocket } from '../lab/weapons/models/launcher'
import { buildInkRay } from '../lab/weapons/models/wonder'
import type { WeaponItem, WeaponName } from './types'

/**
 * Mission and lab share original procedural meshes, including the scoped bolt rifle. `packed` only changes
 * the Ink Cannon, whose ink turns red once it is the Ink Deluge.
 */
export function createMissionGun(name: WeaponName, special?: WeaponItem['special'], packed = false): Gun {
  if (special === 'deathMachine') return buildDeathMachine()
  if (special === 'rayGun') return buildInkRay()
  if (special === 'inkCannon' || name === 'cannon') return buildInkCannon(packed)
  if (name === 'magnum') return buildRevolver()
  if (name === 'lmg') return buildLmg()
  if (name === 'rocket') return buildInkRocket()
  if (name === 'burst') return buildBurstPistol()
  if (name === 'pdw') return buildPdw()
  if (name === 'lever') return buildLeverRifle()
  return builders[name]()
}
