/**
 * Ink drawings for the two mode cards on the title screen. Black strokes on paper; red only where it means
 * danger (the zombie's eyes, Dead Ink's round tally, the searchlight's alarm). No text inside the drawings,
 * so the menu's word count stays honest. 320 x 150 units, scaled to the card.
 */
const INK = 'currentColor'
const RED = '#d4332a'
const line = (d: string, width = 3, color = INK, dash = '') =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`

/** A zombie shambling out of an ink pool under an ink moon, hands clawing up from the ground, the round tally in red. */
export const DEAD_INK_ART = `<svg class="mode-art-svg" viewBox="0 0 320 150" aria-hidden="true" focusable="false">
  <path d="M34 34a22 22 0 1 0 26-24 17 17 0 1 1-26 24z" fill="${INK}" opacity="0.85"/>
  <circle cx="92" cy="30" r="2" fill="${INK}"/><circle cx="104" cy="44" r="1.4" fill="${INK}"/><circle cx="214" cy="24" r="1.8" fill="${INK}"/>
  ${line('M258 30l2 34M270 29l1 35M282 30l-1 34M294 31l0 33', 3.4, RED)}
  ${line('M250 58l52-22', 3.4, RED)}
  <path d="M86 132c14-8 40-10 66-8s46 2 62 8c6 3-2 8-18 9-30 2-80 2-104-1-10-1-12-5-6-8z" fill="${INK}"/>
  <circle cx="70" cy="128" r="3" fill="${INK}"/><circle cx="232" cy="131" r="4" fill="${INK}"/><circle cx="244" cy="126" r="2" fill="${INK}"/>
  ${line('M4 136c40-3 70 2 110-1s80-2 120 0 60 2 86-1', 2)}
  <circle cx="156" cy="44" r="13" fill="var(--paper, #fff)" stroke="${INK}" stroke-width="3"/>
  <circle cx="160" cy="42" r="2.6" fill="${RED}"/><circle cx="151" cy="43" r="2.2" fill="${RED}"/>
  ${line('M150 51c3 2 7 2 10 0')}
  ${line('M154 57c-2 14-2 26-4 42')}
  ${line('M154 66c12-2 24-4 38-2l10 3M204 67l6-4M204 67l7 1M204 67l5 5', 3)}
  ${line('M153 72c10 4 22 6 34 8l8 4M195 84l6-2M195 84l5 4', 3)}
  ${line('M150 99c-6 10-10 20-14 30M150 99c8 6 14 10 14 14s-2 10-4 16', 3)}
  ${line('M106 134c-2-10 0-18 2-26M108 108l-5-8M108 108l1-10M108 108l5-8M108 108l7-4', 2.6)}
  ${line('M212 134c1-8 0-14-2-20M210 114l-6-6M210 114l0-9M210 114l5-7', 2.6)}
</svg>`

/** A watchtower's searchlight sweeping the yard while a soldier leads the hostage along a dashed route to the gate. */
export const HOSTAGE_ART = `<svg class="mode-art-svg" viewBox="0 0 320 150" aria-hidden="true" focusable="false">
  ${line('M4 132c50-2 100 1 150-1s110 2 162-1', 2)}
  ${line('M22 132l12-78M70 132l-12-78M28 100h36M31 82l30 16M61 82l-30 16', 2.6)}
  <path d="M18 54h58v-8H18z" fill="var(--paper, #fff)" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>
  ${line('M14 46l33-18 33 18', 2.6)}
  <path d="M62 50l92 60 18-22z" fill="${INK}" opacity="0.08"/>
  ${line('M62 50l92 60M62 50l110 38', 1.4, INK, '4 5')}
  <circle cx="62" cy="50" r="4" fill="${RED}"/>
  ${line('M250 132V62M300 132V62M250 70h50M250 84h50M250 98h50M250 112h50M250 126h50', 2)}
  ${line('M250 62l8-8 8 8 8-8 8 8 8-8 8 8', 1.6)}
  ${line('M96 128c30-2 60-6 90-14s40-18 54-30', 2, INK, '2 8')}
  ${line('M232 74l12 8-14 4', 2.4)}
  <circle cx="176" cy="66" r="9" fill="var(--paper, #fff)" stroke="${INK}" stroke-width="3"/>
  ${line('M174 75l-8 26M172 82l16 4 16-4M188 86l14-6M166 101l14 12 2 16M166 101l-12 10-10 18', 3)}
  ${line('M192 79l18-6', 4)}
  <circle cx="136" cy="80" r="8" fill="${INK}"/>
  ${line('M134 88l-4 22M132 94l12 2M132 96l10 6M130 110l10 8 0 12M130 110l-10 8-6 12', 3)}
  ${line('M144 96c10-4 18-8 28-12', 1.4, INK, '3 3')}
</svg>`
