import assert from 'node:assert/strict'
import { RECORD_CATEGORIES, TOP, formatRecord, recordKey, sanitizeRecords, submitRun, type RecordTable } from '../src/game/zombies/cosmetics/records'
import { loadProfile, resetProfileCache, submitRecords } from '../src/game/zombies/cosmetics/profile'
import { beginGame, lastReport, recordGameEnd, recordRound, setAwards } from '../src/game/zombies/cosmetics/progression'
import { ZOMBIE_AWARDS, awardsFor, sanitizeAwards, type AwardStats } from '../src/game/shared/awards'

/** High scores (records.ts) and end-of-game awards (shared/awards.ts). */
let passed = 0
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`) }
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }) })
const fresh = () => { store.clear(); resetProfileCache() }
const KEY = recordKey('compound', 'solo', 'normal')

// ---------------------------------------------------------------- records

test('Four tables per map, mode and difficulty: best round, fastest to 10 and 20, most kills', () => {
  assert.deepEqual(RECORD_CATEGORIES.map(c => c.id), ['bestRound', 'round10', 'round20', 'kills'])
  assert.notEqual(recordKey('compound', 'solo', 'normal'), recordKey('compound', 'coop', 'normal'))
  assert.notEqual(recordKey('compound', 'solo', 'normal'), recordKey('compound', 'solo', 'hardcore'))
})

test('A game takes its places: more is better for rounds and kills, less for the times; the top ten only', () => {
  let table: RecordTable = {}
  const first = submitRun(table, KEY, { round: 12, kills: 300, reached10: 600, date: 1 })
  table = first.table
  assert.deepEqual(first.placed.map(p => [p.category, p.rank]), [['bestRound', 1], ['round10', 1], ['kills', 1]], 'no round 20 time without reaching it')
  const second = submitRun(table, KEY, { round: 15, kills: 200, reached10: 540, date: 2 })
  table = second.table
  assert.deepEqual(second.placed.map(p => [p.category, p.rank]), [['bestRound', 1], ['round10', 1], ['kills', 2]])
  assert.deepEqual(table[KEY].round10!.map(e => e.value), [540, 600], 'faster first')
  // Fill past ten: only the best ten stay, and a worse game places nowhere.
  for (let i = 0; i < 12; i++) table = submitRun(table, KEY, { round: 20 + i, kills: 1000 + i, date: 10 + i }).table
  assert.equal(table[KEY].bestRound!.length, TOP)
  assert.equal(table[KEY].bestRound![0].value, 31)
  const worse = submitRun(table, KEY, { round: 3, kills: 10, date: 99 })
  assert.deepEqual(worse.placed, [])
  // A tie keeps the older game ahead.
  const tie = submitRun(table, KEY, { round: 31, kills: 0, date: 100 })
  assert.equal(tie.placed[0].rank, 2)
  assert.equal(tie.table[KEY].bestRound![0].date, 21)
})

test('Stored records are untrusted: junk drops, lists are sorted and cut to ten', () => {
  const clean = sanitizeRecords({ [KEY]: { bestRound: [{ value: 3, date: 1, round: 3, kills: 1 }, { value: 9, date: 2, round: 9, kills: 5 }, { value: -1 }, 'x'],
    kills: Array.from({ length: 30 }, (_, i) => ({ value: i, date: i, round: 1, kills: i })), nonsense: [1] }, 'bad key': { bestRound: [] }, other: 5 })
  assert.deepEqual(Object.keys(clean), [KEY])
  assert.deepEqual(clean[KEY].bestRound!.map(e => e.value), [9, 3])
  assert.equal(clean[KEY].kills!.length, TOP)
  assert.equal(clean[KEY].kills![0].value, 29)
  assert.deepEqual(sanitizeRecords('nope'), {})
  assert.equal(formatRecord('round10', 605), '10:05')
  assert.equal(formatRecord('bestRound', 14), 'Round 14')
})

test('Game over files the game in the right table and the summary says New best', () => {
  fresh()
  beginGame()
  recordRound(10, 432.4)
  const report = recordGameEnd({ round: 11, kills: 150, headshots: 30, mode: 'coop', difficulty: 'hardcore' })
  assert.equal(report.recordKey, recordKey('compound', 'coop', 'hardcore'))
  assert.deepEqual(report.records!.map(p => [p.category, p.rank]), [['bestRound', 1], ['round10', 1], ['kills', 1]])
  assert.equal(loadProfile().records[report.recordKey!].round10![0].value, 432.4)
  resetProfileCache()
  assert.equal(loadProfile().records[report.recordKey!].bestRound![0].value, 11, 'kept in the profile')
  assert.deepEqual(submitRecords(recordKey('compound', 'coop', 'hardcore'), { round: 5, kills: 400 }).map(p => [p.category, p.rank]), [['bestRound', 2], ['kills', 1]])
})

// ---------------------------------------------------------------- awards

const four: AwardStats[] = [
  { player: 0, name: 'Kai', color: '#2878d0', values: { kills: 210, headshots: 60, revives: 1, spent: 18000, clutch: 2, downs: 3 } },
  { player: 1, name: 'Ana', color: '#2e9b45', values: { kills: 180, headshots: 75, revives: 4, spent: 9000, dollKills: 12, downs: 2 } },
  { player: 2, name: 'Sam', color: '#e08a1e', values: { kills: 90, headshots: 10, revives: 0, spent: 30000, explosiveKills: 40, downs: 4 } },
  { player: 3, name: 'Lee', color: '#9b4fd6', values: { kills: 40, headshots: 2, revives: 0, spent: 500, downs: 5 } },
]

test('Every player gets one or two awards, in their colour, in player order', () => {
  const result = awardsFor(four)
  assert.deepEqual(result.map(r => r.player), [0, 1, 2, 3])
  for (const r of result) assert(r.awards.length >= 1 && r.awards.length <= 2, `${r.name}: ${r.awards.length}`)
  assert.equal(result[1].color, '#2e9b45')
  const ids = (i: number) => result[i].awards.map(a => a.id)
  assert(ids(0).includes('kills'), 'Kai: most kills')
  assert(ids(1).includes('revives') || ids(1).includes('headshots') || ids(1).includes('dolls'), 'Ana wins hers')
  assert(ids(2).includes('boom') || ids(2).includes('spent'), 'Sam: demolition or big spender')
  assert.deepEqual(ids(3), ['standing'], 'Lee won nothing: still gets one')
  assert.equal(result[0].awards.find(a => a.id === 'kills')!.detail, '210 kills')
})

test('Alone: no team awards, the best one or two of what you did', () => {
  const [solo] = awardsFor([{ player: 0, name: 'Kai', values: { kills: 120, headshots: 30, revives: 3, dollKills: 4, downs: 0 } }])
  assert(!solo.awards.some(a => a.id === 'revives' || a.id === 'survivor'), 'team awards need a team')
  assert(solo.awards.length >= 1 && solo.awards.length <= 2)
})

test('Minimums and ties: nobody is Headhunter for one headshot; tied players both win', () => {
  const low = awardsFor([{ player: 0, name: 'A', values: { kills: 3, headshots: 1 } }, { player: 1, name: 'B', values: { kills: 2, headshots: 1 } }])
  assert(!low.some(r => r.awards.some(a => a.id === 'headshots')))
  const tied = awardsFor([{ player: 0, name: 'A', values: { kills: 50 } }, { player: 1, name: 'B', values: { kills: 50 } }, { player: 2, name: 'C', values: { kills: 20 } }])
  assert(tied[0].awards.some(a => a.id === 'kills') && tied[1].awards.some(a => a.id === 'kills') && !tied[2].awards.some(a => a.id === 'kills'))
  // Everyone level: nobody gets it (every player went down once).
  const level = awardsFor([{ player: 0, name: 'A', values: { kills: 5, downs: 1 } }, { player: 1, name: 'B', values: { kills: 9, downs: 1, wonderKills: 9 } }])
  assert(!level.some(r => r.awards.some(a => a.id === 'survivor')), 'no Survivor when all went down the same')
  assert.deepEqual(level[1].awards.map(a => a.id), ['kills', 'wonder'])
  assert(ZOMBIE_AWARDS.length >= 8)
  assert(ZOMBIE_AWARDS.some(a => a.id === 'clutch') && ZOMBIE_AWARDS.some(a => a.id === 'dolls') && ZOMBIE_AWARDS.some(a => a.id === 'spent'))
})

test('Awards from the host survive the wire only when well formed, and land in the summary', () => {
  const sent = JSON.parse(JSON.stringify(awardsFor(four)))
  assert.deepEqual(sanitizeAwards(sent), awardsFor(four).map(r => ({ ...r, awards: r.awards })))
  assert.deepEqual(sanitizeAwards('x'), [])
  assert.deepEqual(sanitizeAwards([{ player: 9, awards: [] }, { player: 1, name: '<b>', awards: [{ title: 'T', detail: 'd', id: 'x' }], color: 'red' }]),
    [{ player: 1, name: '<b>', color: undefined, awards: [{ id: 'x', title: 'T', detail: 'd' }] }])
  fresh()
  beginGame()
  recordGameEnd({ round: 2, kills: 5, headshots: 0, name: 'Ana', player: 1, stats: { revives: 1 } })
  assert.equal(lastReport()!.awards![0].name, 'Ana', 'the report starts with this player\'s own')
  setAwards(awardsFor(four))
  assert.equal(lastReport()!.awards!.length, 4, 'the host\'s replace them')
})

console.log(`records and awards checks passed (${passed})`)
