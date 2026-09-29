import type { WeaponItem } from '../src/game/types'

/** Every gun a hand can hold, as the grip solver and its checks see them. */
export const GRIP_GUNS: Pick<WeaponItem, 'name' | 'special'>[] = [
  { name: 'pistol' }, { name: 'burst' }, { name: 'magnum' }, { name: 'smg' }, { name: 'pdw' }, { name: 'ak' }, { name: 'lmg' },
  { name: 'shotgun' }, { name: 'sniper' }, { name: 'lever' }, { name: 'rocket' }, { name: 'cannon', special: 'inkCannon' },
  { name: 'pistol', special: 'rayGun' }, { name: 'ak', special: 'deathMachine' },
]
