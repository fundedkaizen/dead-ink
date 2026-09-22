import { RARITY_INFO, weaponRules } from '../loot'
import type { WeaponItem } from '../types'

/**
 * Fortnite style hotbar: your four slots along the bottom of the screen, each weapon edged in its
 * rarity colour, the selected one raised. Rebuilt only when something on it actually changed.
 */
const SHORT: Record<WeaponItem['name'], string> = { pistol: 'Pistol', ak: 'AK', smg: 'SMG', shotgun: 'Shotgun', sniper: 'Sniper' }

export class Hotbar {
  readonly root = document.createElement('div')
  private cells: HTMLElement[] = []
  private signature = ''

  constructor(parent: HTMLElement, slots = 4) {
    this.root.className = 'royale-hotbar'
    this.root.setAttribute('aria-label', 'Weapons')
    for (let i = 0; i < slots; i++) {
      const cell = document.createElement('div')
      cell.className = 'royale-slot'
      cell.innerHTML = `<kbd>${i + 1}</kbd><span class="royale-slot-name"></span><span class="royale-slot-ammo"></span>`
      this.root.append(cell)
      this.cells.push(cell)
    }
    parent.append(this.root)
  }

  update(slots: readonly (WeaponItem | null)[], selected: number) {
    const signature = slots.map(item => item ? `${item.name}.${item.rarity ?? ''}.${item.magazine}.${item.reserve}` : '-').join('|') + `#${selected}`
    if (signature === this.signature) return
    this.signature = signature
    slots.forEach((item, i) => {
      const cell = this.cells[i]
      if (!cell) return
      cell.classList.toggle('selected', i === selected)
      cell.classList.toggle('empty', !item)
      cell.style.setProperty('--rarity', item?.rarity ? RARITY_INFO[item.rarity].css : 'var(--ink-rule)')
      cell.querySelector('.royale-slot-name')!.textContent = item ? SHORT[item.name] : ''
      cell.querySelector('.royale-slot-ammo')!.textContent = item ? `${item.magazine}/${item.reserve}` : ''
      cell.title = item ? weaponRules(item).label : 'Empty'
    })
  }

  dispose() { this.root.remove() }
}
