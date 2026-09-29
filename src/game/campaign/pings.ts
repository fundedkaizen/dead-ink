import * as THREE from 'three'
import { createPings, type PingTarget, type Pings } from '../shared/pings'
import { PLAYER_CSS } from '../shared/coop'
import type { MissionRuntime } from '../runtime'

/**
 * Pings in the rescue (shared/pings.ts): middle mouse, Z or the phone button marks what you look at for the team.
 * A guard gets a marker that follows him, and a spotter mark (the red triangle, through walls, for thirty
 * seconds); a camera, a door (and whether it is locked), the hostage and the mission's panels get a named
 * marker; anything else is a spot on the ground.
 */
export function createRescuePings(r: MissionRuntime, hud: HTMLElement): Pings {
  const pings = createPings({
    camera: r.view, parent: hud, me: () => r.coop?.link.id ?? 0,
    colorOf: player => PLAYER_CSS[player] ?? PLAYER_CSS[0],
    nameOf: player => r.coop?.mates.get(player)?.state?.name ?? `Player ${player + 1}`,
    send: message => { if (r.coop?.paired) r.coop.link.send(message) },
    pick: (origin, direction) => pick(r, origin, direction),
    resolve: id => {
      const [kind, index] = id.split(':')
      if (kind === 'g') {
        const enemy = r.ai.enemies[Number(index)]
        return enemy && !['dead', 'reserve'].includes(enemy.state) ? enemy.position.clone().setY(enemy.position.y + 1.9) : null
      }
      if (kind === 'h') {
        const hostage = r.state.hostages[Number(index)]
        return hostage ? new THREE.Vector3(...hostage.position).setY(hostage.position[1] + 1.9) : null
      }
      return null
    },
  })
  return pings
}

function pick(r: MissionRuntime, origin: THREE.Vector3, direction: THREE.Vector3): PingTarget | null {
  const range = 120
  const wall = r.player.world.rayDistance(origin, direction, range)
  // A guard in the line of sight: marked for the team.
  const body = r.ai.aimDistance(origin, direction, wall)
  if (body < wall) {
    const point = origin.clone().addScaledVector(direction, body)
    let best = -1, distance = Infinity
    r.ai.enemies.forEach((enemy, index) => {
      if (['dead', 'reserve'].includes(enemy.state)) return
      const d = Math.hypot(enemy.position.x - point.x, enemy.position.z - point.z)
      if (d < distance) { distance = d; best = index }
    })
    if (best >= 0 && distance < 1.5) {
      const enemy = r.ai.enemies[best]
      r.campaign?.act(`mark:guard:${best}`)
      return { kind: 'enemy', position: enemy.position.clone().setY(enemy.position.y + 1.9), label: enemy.spec.role === 'sniper' ? 'Marksman' : 'Guard', id: `g:${best}` }
    }
  }
  const ray = new THREE.Ray(origin, direction.clone().normalize())
  const near = (point: THREE.Vector3, radius: number) => {
    const along = point.clone().sub(origin).dot(ray.direction)
    return along > 0 && along <= Math.min(range, wall + 1.2) && ray.distanceSqToPoint(point) <= radius * radius ? along : Infinity
  }
  let found: PingTarget | null = null, closest = Infinity
  const consider = (along: number, target: PingTarget) => { if (along < closest) { closest = along; found = target } }
  // Cameras, the hostages, the mission's panels and doors near the line of sight.
  for (const { spec } of r.security.list()) {
    if (r.security.destroyed.has(spec.id)) continue
    const at = new THREE.Vector3(...spec.position)
    consider(near(at, 0.9), { kind: 'item', position: at, label: 'Camera' })
  }
  r.state.hostages.forEach((hostage, index) => {
    const at = new THREE.Vector3(...hostage.position).setY(hostage.position[1] + 1)
    const names = r.campaign?.mission.hostageName.split(' and ') ?? ['Hostage']
    consider(near(at, 0.9), { kind: 'item', position: at.clone().setY(at.y + 0.9), label: names[index] ?? names[0], id: `h:${index}` })
  })
  for (const station of r.world.stations) {
    if (r.campaign && !r.campaign.active(station) || station.object.visible === false) continue
    consider(near(station.point, 0.7), { kind: 'item', position: station.point.clone(), label: stationName(station.kind) })
  }
  for (const door of r.player.actions.doors) {
    const at = door.localToWorld(new THREE.Vector3(0, 1.2, 0))
    consider(near(at, 1.1), { kind: 'item', position: at, label: door.userData.missionLocked ? 'Locked door' : 'Door' })
  }
  if (found) return found
  if (wall >= range) return null
  return { kind: 'spot', position: origin.clone().addScaledVector(direction, wall) }
}

function stationName(kind: string) {
  return ({ hostage: 'Cell lock', cameras: 'Camera computer', alarm: 'Alarm panel', gate: 'Gate switch', jeep: 'Way out', supply: 'Supplies', distraction: 'Bell',
    power: 'Fuse box', intel: 'Intel', keycard: 'Keycard', twokey: 'Key panel', ammo: 'Ammunition', heli: 'Radio' } as Record<string, string>)[kind] ?? 'Here'
}
