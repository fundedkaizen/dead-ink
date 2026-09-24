import { PACKED_NAMES, RARITY_INFO, weaponRules } from '../loot'
import type { WeaponItem } from '../types'

/**
 * Fortnite style hotbar: your four slots along the bottom of the screen, each weapon edged in its
 * rarity colour, the selected one raised. Rebuilt only when something on it actually changed. A Mythic
 * gun says so, its name in the tier's crimson-to-violet.
 */
const MYTHIC_TEXT = 'linear-gradient(90deg, #ff2d55, #e0268f 45%, #8b3dff)'
const SHORT: Record<WeaponItem['name'], string> = { pistol: 'Pistol', ak: 'AK', smg: 'SMG', shotgun: 'Shotgun', sniper: 'Sniper', magnum: 'Magnum', lmg: 'LMG', rocket: 'Ink Rocket' }

export class Hotbar {
  readonly root = document.createElement('div')
  private cells: HTMLElement[] = []
  private signature = ''

  constructor(parent: HTMLElement, slots = 4) {
    this.root.className = 'hud-hotbar'
    this.root.setAttribute('aria-label', 'Weapons')
    for (let i = 0; i < slots; i++) {
      const cell = document.createElement('div')
      cell.className = 'hud-slot'
      cell.innerHTML = `<kbd>${i + 1}</kbd><span class="hud-slot-name"></span><span class="hud-slot-ammo"></span>`
      this.root.append(cell)
      this.cells.push(cell)
    }
    parent.append(this.root)
  }

  update(slots: readonly (WeaponItem | null)[], selected: number) {
    const signature = slots.map(item => item ? `${item.name}.${item.special ?? ''}.${item.packed ? 'p' : ''}.${item.rarity ?? ''}.${item.magazine}.${item.reserve}` : '-').join('|') + `#${selected}`
    if (signature === this.signature) return
    this.signature = signature
    // Cells past the slots you have (a perk can add one) stay hidden.
    this.cells.forEach((cell, i) => { cell.hidden = i >= slots.length })
    slots.forEach((item, i) => {
      const cell = this.cells[i]
      if (!cell) return
      cell.classList.toggle('selected', i === selected)
      cell.classList.toggle('empty', !item)
      cell.style.setProperty('--rarity', item?.rarity ? RARITY_INFO[item.rarity].css : 'var(--ink-rule)')
      // The Death Machine power-up never runs dry; the Ink Ray counts its charges like any gun.
      const name = cell.querySelector<HTMLElement>('.hud-slot-name')!
      const mythic = item?.rarity === 'mythic' && !item.special
      name.textContent = item ? item.special === 'deathMachine' ? 'Death Machine' : item.special === 'rayGun' ? item.packed ? 'Ink Ray X2' : 'Ink Ray'
        : `${mythic ? 'Mythic ' : ''}${item.packed ? PACKED_NAMES[item.name] : SHORT[item.name]}` : ''
      name.style.backgroundImage = mythic ? MYTHIC_TEXT : ''
      name.style.backgroundClip = name.style.webkitBackgroundClip = mythic ? 'text' : ''
      name.style.color = mythic ? 'transparent' : ''
      cell.querySelector('.hud-slot-ammo')!.textContent = item ? item.special === 'deathMachine' ? '∞' : `${item.magazine}/${item.reserve}` : ''
      cell.title = item ? weaponRules(item).label : 'Empty'
    })
  }

  dispose() { this.root.remove() }
}
