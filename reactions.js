// Which reactions emit neutrons, and what the table calls them.
//
// A library's `index.json` lists every MT a nuclide publishes a cross section
// for, which includes sums (MT 1, 3, 4), gas production (203-207) and heating
// (301, 444, 901) that have no outgoing-neutron distribution. The table lists
// only the MTs that can emit a neutron: elastic, MT 5 (the evaluation's
// "anything" channel), fission and every channel whose name has neutrons in
// its products ((n,2n), (n,np), (n,n1) ... (n,nc)). Whether a listed reaction
// really carries a neutron distribution is only known from the nuclide's
// `products.arrow`, which is read when the row is opened; a reaction that has
// none says so then. Checked against the published products of Fe56, U235 and
// Li7 in ENDF/B-VIII.1, where the rule gives exactly the MTs that have one.
//
// Fission is offered twice, as prompt and as delayed neutrons: the two have
// different spectra and are separate products in the data.

import { MT_NAMES } from './mt_names.js';

/// MTs that emit neutrons although their name does not start (n,<k>n...).
const ALWAYS = new Set([2, 5, 18, 19]);
/// MTs whose name starts with neutrons but which are sums, never products.
const NEVER = new Set([3, 4]);
/// Fission MTs, which also have delayed neutrons.
export const FISSION_MTS = new Set([18, 19, 20, 21, 38]);

/// True for an MT that can emit a neutron.
export function emitsNeutrons(mt) {
  mt = Number(mt);
  if (ALWAYS.has(mt)) return true;
  if (NEVER.has(mt)) return false;
  return /^\(n,\d*n/.test(MT_NAMES[mt] ?? '');
}

/// The reaction name a row shows: `(n,2n)`, `(n,fission) prompt`.
export function reactionName(mt, delayed = false) {
  const name = MT_NAMES[mt] ?? `MT ${mt}`;
  if (!FISSION_MTS.has(Number(mt))) return name;
  return `${name} ${delayed ? 'delayed' : 'prompt'}`;
}

/// The choices a nuclide's MT list offers: `[{mt, delayed}]`, fission twice.
export function choicesOf(mts) {
  const out = [];
  for (const mt of [...mts].sort((a, b) => a - b)) {
    if (!emitsNeutrons(mt)) continue;
    out.push({ mt, delayed: false });
    if (FISSION_MTS.has(mt)) out.push({ mt, delayed: true });
  }
  return out;
}

/// The id of a choice, as the URL spells it: `16`, `18d`.
export const choiceId = (mt, delayed) => `${mt}${delayed ? 'd' : ''}`;

/// Parse a choice id back, or null.
export function parseChoiceId(text) {
  const m = /^(\d+)(d?)$/.exec(text ?? '');
  return m ? { mt: Number(m[1]), delayed: m[2] === 'd' } : null;
}
