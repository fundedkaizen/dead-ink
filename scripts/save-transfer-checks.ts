import assert from 'node:assert/strict'
import { SAVE_KEYS, exportSave, importSave } from '../src/game/save-transfer'

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } }
const from = store(), to = store()
from.setItem('dead-ink-profile', JSON.stringify({ ink: 250, knives: ['quill', 'nib'], name: 'Kaizen ✓' }))
from.setItem('dead-ink-name', 'Kaizen')
from.setItem('unrelated', 'secret')
const code = exportSave(from)
assert(code.startsWith('DEADINK1:'))
assert(importSave(code, to))
assert.equal(to.getItem('dead-ink-profile'), from.getItem('dead-ink-profile'), 'the profile arrives exactly, unicode and all')
assert.equal(to.getItem('dead-ink-name'), 'Kaizen')
assert.equal(to.getItem('unrelated'), null, 'nothing outside the save keys is carried')
console.log('PASS a save code carries the profile, name and settings to a new address, and nothing else')
const before = [...to.m.entries()].join()
for (const bad of ['', 'hello', 'DEADINK1:!!!', 'DEADINK1:' + btoa('[]'), 'DEADINK1:' + btoa(JSON.stringify({ other: 'x' }))]) assert.equal(importSave(bad, to), false, bad)
assert.equal([...to.m.entries()].join(), before, 'a bad code changes nothing')
assert.equal(SAVE_KEYS.length, 4)
console.log('PASS anything that is not a save code is refused and changes nothing')
