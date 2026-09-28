import type { Vec3 } from '../../types'
import type { CameraAnchor, CellAnchor, DogAnchor, ExtractionAnchor, GuardAnchor, MapModule, NamedZone, PanelAnchor, SpawnAnchor, BoostAnchor } from '../types'

/**
 * The rail supply compound (src/world/compound.ts and src/game/world.ts): the map every mission so far plays on.
 * Its geometry is built at page load; this module only names places in it. Coordinates are world metres,
 * north is -Z. scripts/rescue-campaign-map-checks.ts walks every anchor against the real collision world.
 */
const FLOOR = 0.12

const spawns: SpawnAnchor[] = [
  { id: 'north-road', label: 'The north road, by the mess hall', position: [-40, 0.15, -62.3], lookAt: [-49, 1.7, -61] },
  { id: 'fuel-belt', label: 'The fuel tanks, west', position: [-86, 0.05, -44], lookAt: [-70, 1.7, -30] },
  { id: 'southwest-corner', label: 'The southwest corner, behind the stores', position: [-88, 0.05, 68], lookAt: [-70, 1.7, 60] },
  { id: 'south-field', label: 'The south field, below the barracks', position: [0, 0.05, 47], lookAt: [10, 1.7, 30] },
  { id: 'rail-siding', label: 'The rail siding, under the wagons', position: [96, 0.05, -34], lookAt: [80, 1.7, -30] },
]

/** The detention block's four cells: their locks sit on the cell doors (world.ts, cell-lock.ts). */
const detentionCell = (n: number): CellAnchor => {
  const left = n % 2 === 1, z = n <= 2 ? -21 : -26, doorX = left ? 113 : 121
  return { id: `detention-${n}`, label: `Cell 0${n}`, area: 'the detention block', station: `hostage-${n}`,
    hostage: [left ? 110.5 : 123.5, -4.2, z], facing: left ? Math.PI / 2 : -Math.PI / 2,
    lock: { position: [doorX, -4.2, z], facing: 0 }, zone: { x: left ? 114.8 : 119.2, z, r: 2.4, maxY: -2 }, chair: n !== 1 }
}
const room = (id: string, label: string, area: string, hostage: Vec3, facing: number, door?: string): CellAnchor => ({
  id, label, area, hostage, facing, door, chair: true,
  lock: { position: [hostage[0] + Math.sin(facing) * 0.75, hostage[1], hostage[2] + Math.cos(facing) * 0.75], facing: facing + Math.PI },
  zone: { x: hostage[0], z: hostage[2], r: 6, maxY: hostage[1] + 2.5, minY: hostage[1] - 1 },
})
const cells: CellAnchor[] = [
  detentionCell(1), detentionCell(2), detentionCell(3), detentionCell(4),
  room('warehouse-east', 'The warehouse stores', 'the east end of the long warehouse', [51.5, 0.65, -5], -Math.PI / 2),
  room('stores-southwest', 'The southwest stores', 'the southwest stores', [-47.5, 0.65, 64], -Math.PI / 2, 'Southwest stores · entry 2'),
  room('shed-west', 'The west equipment shed', 'the west equipment shed', [-68.2, 0.3, -12.3], Math.PI / 2, 'West equipment shed A · entry 1'),
  room('barracks-a', 'Barracks A', 'the south barracks', [8.6, 0.3, 31.2], 0, 'South barracks A · entry 1'),
  room('barracks-b', 'Barracks B', 'the south barracks', [50.6, 0.3, 40.4], Math.PI / 2, 'South barracks B · long wing · entry 1'),
  room('medical-hut', 'The medical hut', 'the east huts', [80, 0.3, 37.2], Math.PI / 2, 'East utility hut B · entry 1'),
  room('gatehouse', 'The gatehouse', 'the inner gatehouse', [-9.2, 0.3, 29.4], Math.PI / 2, 'Inner gatehouse · entry 1'),
  room('admin', 'The records room', 'the administration wing', [-43, 0.3, 27.2], 0, 'West administration wing · entry 1'),
  room('shed-southwest', 'The service shed', 'the southwest service shed', [-86.9, 0.3, 60.6], Math.PI, 'Southwest service shed · entry 1'),
]

const jeepRoute: Vec3[] = [[155, 0.05, 11], [161, 0.05, 11], [169, 0.05, 11], [175, 0.05, 11]]
const helicopter = (id: string, label: string, x: number, z: number, heading: number, call: Vec3): ExtractionAnchor => ({
  id, kind: 'helicopter', label, board: [x + Math.sin(heading + Math.PI / 2) * 2.2, 0.05, z + Math.cos(heading + Math.PI / 2) * 2.2],
  seats: [[x, 0.9, z], [x + Math.sin(heading) * 0.8, 0.9, z + Math.cos(heading) * 0.8]],
  park: [x, 0, z], heading,
  route: [[x, 0, z], [x, 6, z], [x + Math.sin(heading) * 30, 22, z + Math.cos(heading) * 30], [x + Math.sin(heading) * 90, 45, z + Math.cos(heading) * 90]],
  camera: { target: [x, 3, z], offset: [-14, 8, 18] },
  zone: { x, z, r: 11 }, call: { position: call, facing: 0 }, eta: 75,
})
const extractions: ExtractionAnchor[] = [
  { id: 'east-jeep', kind: 'jeep', label: 'The jeep by the east gate', board: [155.02, 0.05, 12.55], seats: [[155.021, 0.371, 11.46], [155.021, 0.371, 10.4]],
    park: jeepRoute[0], heading: 0, route: jeepRoute, camera: { target: [164, 0.8, 11], offset: [-6, 5.6, 14] },
    zone: { x: 155, z: 11, r: 9 }, gate: true },
  helicopter('north-yard-heli', 'A helicopter to the north yard', -36, -20, Math.PI * 0.75, [-44.5, 0, -27.5]),
  helicopter('loading-court-heli', 'A helicopter to the loading court', 28, 15, 0, [18.5, 0, 20.5]),
  helicopter('annex-apron-heli', 'A helicopter to the annex apron', 146, -19, -Math.PI / 2, [138.5, 0, -27]),
]

const cameras: CameraAnchor[] = [
  // The four the jeep mission always had (rescue-layout.ts), then pole cameras for the later missions.
  { id: 'detention-camera', position: [124.9, 3.15, -4.65], yaw: -0.65, arc: 0.65, range: 19 },
  { id: 'jeep-camera', position: [160.6, 3.1, 4.5], yaw: -0.7, arc: 0.75, range: 20 },
  { id: 'security-camera', position: [150.7, 3.15, -40.2], yaw: -0.2, arc: 0.65, range: 18 },
  { id: 'mess-hall-exit-camera', position: [-20.16, 3.45, -35.66], yaw: -1.05, arc: 0.65, range: 23, wallMount: [-20.325, 3.45, -36] },
  { id: 'yard-pole-camera', position: [-26, 3.3, -8], yaw: Math.PI * 0.8, arc: 0.7, range: 20 },
  { id: 'loading-pole-camera', position: [14, 3.3, 24], yaw: Math.PI * 0.6, arc: 0.7, range: 21 },
  { id: 'barracks-pole-camera', position: [32, 3.3, 45], yaw: Math.PI, arc: 0.8, range: 20 },
  { id: 'admin-pole-camera', position: [-16, 3.3, 36], yaw: -Math.PI / 2, arc: 0.6, range: 20 },
  { id: 'stores-pole-camera', position: [-40, 3.3, 72], yaw: -Math.PI * 0.6, arc: 0.6, range: 19 },
  { id: 'huts-pole-camera', position: [95, 3.3, 34], yaw: -Math.PI / 2, arc: 0.7, range: 20 },
  { id: 'rail-pole-camera', position: [62, 3.3, -30], yaw: -Math.PI / 2, arc: 0.8, range: 22 },
  { id: 'annex-gate-camera', position: [97, 3.3, 5], yaw: Math.PI * 0.35, arc: 0.6, range: 18 },
  { id: 'west-shed-camera', position: [-55, 3.3, -3], yaw: -Math.PI * 0.65, arc: 0.7, range: 19 },
]

const panels: PanelAnchor[] = [
  { id: 'fuse-west', kind: 'power', label: 'Cut the power', position: [-26.3, 0, 12.2], facing: Math.PI / 2 },
  { id: 'fuse-annex', kind: 'power', label: 'Cut the power', position: [104.2, 0, -41], facing: -Math.PI / 2 },
  { id: 'fuse-yard', kind: 'power', label: 'Cut the power', position: [64, 0, 9], facing: Math.PI },
  { id: 'intel-admin', kind: 'intel', label: 'Read the laptop', position: [-20, 0.3, 27.9], facing: 0 },
  { id: 'intel-security', kind: 'intel', label: 'Read the logbook', position: [143.2, FLOOR, -43], facing: Math.PI / 2 },
  { id: 'intel-workshop', kind: 'intel', label: 'Read the laptop', position: [73.5, 0, -2.5], facing: 0 },
  { id: 'card-gatehouse', kind: 'keycard', label: 'Take the keycard', position: [-9.2, 0.3, 17.4], facing: 0 },
  { id: 'card-mess', kind: 'keycard', label: 'Take the keycard', position: [-46.6, 0.28, -54.6], facing: 0 },
  { id: 'card-medical', kind: 'keycard', label: 'Take the keycard', position: [92.4, 0.3, 28.2], facing: 0 },
  { id: 'card-shed', kind: 'keycard', label: 'Take the keycard', position: [-57.6, 0.3, 0.4], facing: 0 },
  { id: 'card-crew', kind: 'keycard', label: 'Take the keycard', position: [132.5, 0, -6.5], facing: 0 },
  { id: 'twokey-a', kind: 'twokey', label: 'Turn key A', position: [-27.4, 0.3, 35.2], facing: 0, pair: 'twokey-b' },
  { id: 'twokey-b', kind: 'twokey', label: 'Turn key B', position: [-34.2, 0.3, 35.2], facing: 0, pair: 'twokey-a' },
  { id: 'ammo-yard', kind: 'ammo', label: 'Take ammunition', position: [-12, 0, -38], facing: 0 },
  { id: 'ammo-court', kind: 'ammo', label: 'Take ammunition', position: [46, 0, 20.5], facing: Math.PI },
  { id: 'ammo-annex', kind: 'ammo', label: 'Take ammunition', position: [132, 0, 12.5], facing: Math.PI },
  { id: 'medkit-south', kind: 'supply', label: 'Take field supplies', position: [30, 0, 47], facing: Math.PI },
  { id: 'medkit-west', kind: 'supply', label: 'Take field supplies', position: [-74, 0, 30], facing: 0 },
]

const boosts: BoostAnchor[] = [
  // Over the fence between the rail yard and the water tower yard.
  { id: 'rail-fence', label: 'Over the rail yard fence', from: [22.5, 0.05, -24], to: [27.2, 0.05, -24] },
  // Over the annex fence behind the maintenance shelter, past the rail gap's patrol.
  { id: 'annex-fence', label: 'Over the annex fence', from: [96.8, 0.05, -45], to: [101.4, 0.05, -45] },
  // Over the inner yard's railway fence, from the loading lane to the rail side.
  { id: 'inner-fence', label: 'Over the inner yard fence', from: [70, 0.05, -15.2], to: [70, 0.05, -19.9] },
]

const zones: NamedZone[] = [
  { id: 'rail-yard', label: 'The rail yard', x: 11, z: -30, r: 16 },
  { id: 'south-yard', label: 'The south yard', x: 32, z: 26, r: 18 },
  { id: 'west-yard', label: 'The west yard', x: -50, z: -5, r: 16 },
  { id: 'annex', label: 'The east annex', x: 130, z: -20, r: 26 },
  { id: 'detention', label: 'The detention block', x: 117, z: -17, r: 11 },
  { id: 'loading-court', label: 'The loading court', x: 28, z: 14, r: 14 },
]

const g = (id: string, name: string, patrol: Vec3[], weapon: GuardAnchor['weapon'] = 'ak', extra: Partial<GuardAnchor> = {}): GuardAnchor =>
  ({ id, name, position: [...patrol[0]] as Vec3, patrol, weapon, ...extra })

/** Guards the later missions (and harder difficulties) add to the compound's own garrison. */
const guards: GuardAnchor[] = [
  // Mission 1, harder difficulties: more eyes on the detention approach and the rail line.
  g('annex-rail-watch', 'Annex rail watch', [[104, 0, -30], [112, 0, -30], [112, 0, -36], [104, 0, -36]], 'smg', { tier: 'hard' }),
  g('detention-yard', 'Detention yard patrol', [[128, 0, -2], [128, 0, 12], [112, 0, 12], [112, 0, -2]], 'ak', { tier: 'hard',
    routes: [[[112, 0, 12], [128, 0, 12], [128, 0, -2]]] }),
  g('mess-yard-2', 'Mess-yard second patrol', [[-44, 0, -26], [-30, 0, -26], [-30, 0, -14], [-44, 0, -14]], 'smg', { tier: 'hard' }),
  g('rail-yard-2', 'Rail-yard patrol', [[27, 0, -22], [44, 0, -22], [26, 0, -26]], 'ak', { tier: 'hard' }),
  g('annex-night-1', 'Annex night patrol', [[132, 0, -12], [140, 0, -30], [156, 0, -30], [154, 0, -14]], 'ak', { tier: 'nightmare' }),
  g('annex-night-2', 'Crew-house night patrol', [[134, 0, 14], [152, 0, 14], [152, 0, 16], [134, 0, 16]], 'smg', { tier: 'nightmare' }),
  g('yard-night', 'North-yard night patrol', [[-12, 0, -30], [-12, 0, -12], [-24, 0, -12], [-24, 0, -30]], 'ak', { tier: 'nightmare' }),
  g('warehouse-night', 'Warehouse night watch', [[8, 0, 4], [44, 0, 4]], 'smg', { tier: 'nightmare' }),
  // Around the cells the later missions use.
  g('warehouse-stores', 'Warehouse stores guard', [[48, 0.65, -4], [48, 0.65, -10]], 'smg', { routes: [[[46, 0.65, -11], [51, 0.65, -11]]] }),
  g('warehouse-rear', 'Warehouse rear patrol', [[8, 0, -16], [48, 0, -16]], 'ak'),
  g('stores-yard', 'Stores yard patrol', [[-73, 0, 56], [-42, 0, 56], [-42, 0, 72], [-73, 0, 72]], 'ak', { routes: [[[-42, 0, 72], [-73, 0, 72], [-73, 0, 56]]] }),
  g('stores-inside', 'Stores inside guard', [[-52, 0.65, 64], [-52, 0.65, 60]], 'smg'),
  g('shed-watch', 'Equipment shed watch', [[-66, 0, -5], [-58, 0, -5]], 'pistol', { routes: [[[-66, 0, -16], [-58, 0, -16]]] }),
  g('west-fence', 'West fence patrol', [[-72, 0, -30], [-72, 0, 20]], 'ak'),
  g('south-yard-a', 'South yard patrol', [[4, 0, 46], [28, 0, 46], [28, 0, 26], [4, 0, 26]], 'ak', { routes: [[[28, 0, 26], [4, 0, 26], [4, 0, 46]], [[4, 0, 26], [40, 0, 26]]] }),
  g('south-yard-b', 'Barracks B patrol', [[40, 0, 44], [64, 0, 44], [64, 0, 26], [40, 0, 26]], 'smg', { routes: [[[64, 0, 26], [40, 0, 26], [40, 0, 44]]] }),
  g('barracks-a-inside', 'Barracks A inside guard', [[21.4, 0.3, 30.9], [12.4, 0.3, 30.9]], 'pistol'),
  g('barracks-b-inside', 'Barracks B inside guard', [[52.3, 0.3, 30.6], [52.3, 0.3, 39]], 'smg'),
  g('huts-patrol', 'East huts patrol', [[72, 0, 24], [96, 0, 24], [96, 0, 46], [72, 0, 46]], 'ak', { routes: [[[96, 0, 46], [72, 0, 46], [72, 0, 24]]] }),
  g('medical-inside', 'Medical hut guard', [[88.7, 0.3, 37], [83.7, 0.3, 37]], 'pistol'),
  g('gatehouse-yard', 'Gatehouse yard patrol', [[-18, 0, 14], [4, 0, 14], [4, 0, 38], [-18, 0, 38]], 'ak'),
  g('admin-inside', 'Records room guard', [[-40, 0.3, 28.4], [-36, 0.3, 28.4]], 'smg'),
  g('crew-yard', 'Crew-house yard patrol', [[130, 0, 14], [150, 0, 14], [150, 0, 16], [130, 0, 16]], 'ak'),
  g('security-inside', 'Security cabin night officer', [[148.2, FLOOR, -43.2], [147, FLOOR, -46]], 'pistol'),
  g('annex-apron', 'Annex apron patrol', [[138, 0, -12], [138, 0, -28], [154, 0, -28], [154, 0, -12]], 'ak', { routes: [[[154, 0, -12], [154, 0, -28], [138, 0, -28]]] }),
  g('court-patrol', 'Loading court patrol', [[14, 0, 10], [42, 0, 10], [42, 0, 20], [14, 0, 20]], 'ak'),
  g('court-night', 'Loading court night patrol', [[42, 0, 20], [14, 0, 20]], 'smg', { tier: 'hard' }),
  g('yard-lz', 'North-yard watch', [[-40, 0, -24], [-32, 0, -16]], 'ak', { tier: 'hard' }),
  g('south-night', 'South field patrol', [[0, 0, 40], [60, 0, 40]], 'ak', { tier: 'nightmare' }),
  g('west-night', 'West yard night patrol', [[-56, 0, -24], [-56, 0, 8], [-44, 0, 8], [-44, 0, -24]], 'smg', { tier: 'nightmare' }),
  // Roof and tower marksmen (glints give them away).
  g('mess-roof-sniper', 'Mess-hall roof marksman', [[-30, 6.38, -50]], 'sniper', { role: 'sniper', facing: Math.PI * 0.9 }),
  g('maintenance-roof-sniper', 'Maintenance roof marksman', [[108, 4.2, -44]], 'sniper', { role: 'sniper', facing: Math.PI * 0.6 }),
]

const dogs: DogAnchor[] = [
  { id: 'dog-south-a', route: [[6, 0, 28], [30, 0, 28], [30, 0, 44], [6, 0, 44]] },
  { id: 'dog-south-b', route: [[42, 0, 44], [66, 0, 44], [66, 0, 24], [40, 0, 24]] },
  { id: 'dog-huts', route: [[70, 0, 22], [98, 0, 22], [98, 0, 48], [70, 0, 48]], tier: 'hard' },
  { id: 'dog-yard', route: [[-46, 0, -26], [-26, 0, -26], [-26, 0, -10], [-46, 0, -10]] },
  { id: 'dog-annex', route: [[130, 0, -10], [158, 0, -10], [158, 0, -30], [130, 0, -30]] },
  { id: 'dog-stores', route: [[-74, 0, 56], [-40, 0, 56], [-40, 0, 76], [-74, 0, 76]], tier: 'hard' },
  { id: 'dog-court', route: [[12, 0, 8], [44, 0, 8], [44, 0, 22], [12, 0, 22]], tier: 'nightmare' },
]

const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map(item => [item.id, item])) as Record<string, T>

export const COMPOUND_MAP: MapModule = {
  id: 'compound', name: 'The rail compound', place: 'A rail supply compound',
  spawns: byId(spawns), cells: byId(cells), extractions: byId(extractions), cameras: byId(cameras),
  panels: byId(panels), boosts: byId(boosts), zones: byId(zones), guards: byId(guards), dogs: byId(dogs),
  preview: {
    buildings: [[-34, -46, 28, 21], [25, -7, 56, 13], [16, 36, 20, 14], [55, 35, 12, 18], [44, 30, 10, 8], [-30, 30, 28, 8], [-33, 16, 7, 11],
      [-6, 23, 10, 15], [83, -9, 17, 13], [117, -17, 18, 24], [146, -45, 10, 9], [143, 3, 14, 10], [111, -45, 12, 10],
      [-58, 64, 25, 11], [-85, 52, 9, 20], [86, 29, 15, 6], [86, 39, 15, 6], [-62, -11, 14, 6], [-62, 1.5, 14, 7], [11, -34, 8, 8]],
    bounds: { minX: -100, maxX: 170, minZ: -70, maxZ: 78 },
  },
}
