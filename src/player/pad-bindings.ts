import { getSettings } from '../game/settings'
import type { FirstPersonController } from './controller'
import type { MenuAction, PadAction, PadBindings } from './gamepad'

/**
 * What the game modes expose to a gamepad. Both runtimes have `weapons` publicly; `aiming` is private in
 * both, read here without a type so LT can hold aim over the runtimes' right-click toggle. A runtime that
 * adds a public `aiming` getter keeps working unchanged.
 */
export type PadMission = { weapons: { slots: readonly unknown[]; current: { name: string } | null } } | null

/**
 * Carry out gamepad input by sending the same events the keyboard and mouse send, so the Dead Ink and
 * hostage runtimes need no gamepad code: fire and aim are the mouse buttons on the canvas, the rest are the
 * keys (R reload, F use, V knife, G/Q grenade, T Ink Doll, 1-4 weapon slots, E/Q zoom, M map, Escape back in menus).
 * Movement, look, jump and sprint go straight to the controller, which owns them anyway.
 */
export function padBindings(canvas: HTMLCanvasElement, player: FirstPersonController, mission: PadMission, zombies: boolean): PadBindings {
  const key = (code: string, keyName = code.replace(/^Key|^Digit/, '')) => {
    for (const type of ['keydown', 'keyup'] as const) window.dispatchEvent(new KeyboardEvent(type, { code, key: keyName, bubbles: true, cancelable: true }))
  }
  const mouse = (type: 'mousedown' | 'mouseup', button: number) =>
    canvas.dispatchEvent(new MouseEvent(type, { button, buttons: type === 'mousedown' ? 1 << (button === 2 ? 1 : 0) : 0, bubbles: true, cancelable: true }))
  const aiming = () => !!(mission as { aiming?: boolean } | null)?.aiming
  const scoped = () => aiming() && mission?.weapons.current?.name === 'sniper'
  /** The next slot holding a weapon, as its number key (the runtimes' own switch path). */
  const nextSlot = () => {
    const slots = mission?.weapons.slots ?? [], current = slots.indexOf(mission?.weapons.current ?? null)
    for (let step = 1; step < slots.length; step++) {
      const index = (current + step) % slots.length
      if (slots[index]) return index
    }
    return -1
  }
  const action = (name: PadAction, down: boolean) => {
    player.usingPad = true
    switch (name) {
      case 'fire': mouse(down ? 'mousedown' : 'mouseup', 0); break
      // Held aim over the runtimes' toggle: press turns it on, release turns it off, whatever happened between.
      case 'aim': if (down !== aiming()) { mouse('mousedown', 2); mouse('mouseup', 2) } break
      case 'sprint': player.padSprint = down; break
      case 'jump': player.padJump(); break
      case 'reload': key('KeyR'); break
      case 'use': key('KeyF'); break
      case 'knife': if (zombies) key('KeyV'); break
      case 'grenade': if (zombies) key('KeyG'); break
      // Dead Ink's Ink Doll; in the hostage mission B drops the weapon, as G does.
      case 'special': key(zombies ? 'KeyT' : 'KeyG'); break
      case 'switch': { const slot = nextSlot(); if (slot >= 0) key(`Digit${slot + 1}`); break }
      case 'zoomIn': if (aiming()) key('KeyE'); break
      // Q throws a grenade in Dead Ink unless a sniper is scoped: only ever send it to zoom.
      case 'zoomOut': if (scoped() || (!zombies && aiming())) key('KeyQ'); break
      case 'map': if (!zombies) key('KeyM'); break
      // Straight to the pause menu: a synthetic Escape would also reach the menu, which reads it as Resume.
      case 'pause': player.pause(); break
    }
  }
  const panel = () => document.querySelector<HTMLElement>('#walk-pause')
  const focusables = () => Array.from(panel()?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]') ?? [])
    .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'))
  const menu = (name: MenuAction) => {
    player.usingPad = true
    const list = focusables(), focused = document.activeElement as HTMLElement | null, index = focused ? list.indexOf(focused) : -1
    const move = (by: number) => list[index < 0 ? 0 : (index + by + list.length) % list.length]?.focus({ preventScroll: false })
    switch (name) {
      case 'up': move(-1); break
      case 'down': move(1); break
      case 'left': case 'right': {
        // A slider steps; anything else moves along the row.
        if (focused instanceof HTMLInputElement && focused.type === 'range') {
          if (name === 'left') focused.stepDown(); else focused.stepUp()
          focused.dispatchEvent(new Event('input', { bubbles: true }))
        } else move(name === 'left' ? -1 : 1)
        break
      }
      case 'accept': if (index >= 0) focused!.click(); else move(0); break
      case 'back': key('Escape', 'Escape'); break
      case 'start': {
        const start = document.querySelector<HTMLButtonElement>('#walk-start')
        if (start && !start.disabled && start.getClientRects().length) start.click()
        else key('Escape', 'Escape')
      }
    }
  }
  return {
    playing: () => player.enabled && player.playing && !player.immersive,
    move: (x, forward) => { player.padMove.set(x, forward); if (x || forward) player.usingPad = true },
    look: (yaw, pitch) => { player.usingPad = true; player.padLook(yaw, pitch) },
    lookScale: () => player.lookSensitivity() / getSettings().sensitivity,
    settings: () => { const s = getSettings(); return { sensitivity: s.controllerSensitivity, invertY: s.invertY } },
    action, menu,
    hasTarget: () => !!player.actions.target,
  }
}
