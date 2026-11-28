// The reaction table: one row per (library, nuclide, reaction that emits
// neutrons), built from each library's index.json, with the filters of
// nuclide_cross_section_plotter's table.
//
// Each column has its own text box and the boxes AND together. A term matches
// a column value exactly when any value equals it (case-insensitive),
// otherwise by prefix, so `C` gives carbon rather than every element from Ca to
// Cu, and `16` gives MT 16 rather than 160-something. Reaction terms ignore
// brackets, so `n,2n` and `(n,2n)` are the same, and match the product alone
// (`2n`, `elastic`, `fission`). Decisions are made once per distinct value and
// applied as lookups, so a keystroke is a loop over small integers even with
// six libraries listed.

import { ATOMIC_SYMBOL, parseNuclide, nucleonsLabel } from './elements.js';
import { LIBRARIES } from './libraries.js';
import { choicesOf, reactionName, choiceId } from './reactions.js';

const LIBRARY_INDEX = new Map(LIBRARIES.map((l, i) => [l.id, i]));

/// Rows of one library's index: `[{lib, z, a, meta, name, mt, delayed}]`.
export function rowsOfIndex(index) {
  const lib = LIBRARY_INDEX.get(index.library);
  if (lib === undefined) throw new Error(`index for unknown library ${index.library}`);
  const rows = [];
  for (const [name, mts] of Object.entries(index.nuclides)) {
    const p = parseNuclide(name);
    if (!p || p.a === 0) continue;
    for (const { mt, delayed } of choicesOf(mts)) rows.push({ lib, z: p.z, a: p.a, meta: p.meta, name, mt, delayed });
  }
  return rows;
}

/// Rows of several libraries in table order: by nuclide, then reaction, then
/// library, so one reaction from every library sits together.
export function mergeRows(rowLists) {
  const all = rowLists.flat();
  all.sort((x, y) => x.z - y.z || x.a - y.a || x.meta - y.meta || x.mt - y.mt
    || Number(x.delayed) - Number(y.delayed) || x.lib - y.lib);
  return all;
}

/// A reaction name as the filter sees it: lowercase, brackets dropped.
export function reactionText(name) {
  return name.toLowerCase().replace(/[()]/g, '').replace(/γ/g, 'gamma');
}

/// Per column: a row's integer key, and the text of a key (memoised).
const COLUMNS = {
  element: { key: (r) => r.z, text: (k) => ATOMIC_SYMBOL[k].toLowerCase() },
  nucleons: { key: (r) => r.a * 16 + r.meta, text: (k) => nucleonsLabel(k >> 4, k & 15).replace(' ', '').toLowerCase() },
  reaction: { key: (r) => r.mt * 2 + (r.delayed ? 1 : 0), text: (k) => reactionText(reactionName(k >> 1, (k & 1) === 1)) },
  mt: { key: (r) => r.mt, text: (k) => String(k) },
};
const textCache = Object.fromEntries(Object.keys(COLUMNS).map((c) => [c, new Map()]));
function keyText(column, k) {
  const cache = textCache[column];
  if (!cache.has(k)) cache.set(k, COLUMNS[column].text(k));
  return cache.get(k);
}

/// The values a term admits in one column: exact match if any value equals it,
/// otherwise every value it is a prefix of. Reaction terms also try the
/// product alone, in the same exact-then-prefix tiers.
export function admitted(values, term, column) {
  const t = column === 'reaction' ? reactionText(term.trim()) : term.trim().toLowerCase();
  if (!t) return null;
  const tiers = [new Set(), new Set(), new Set(), new Set()];
  for (const v of values) {
    const product = column === 'reaction' ? v.slice(v.indexOf(',') + 1) : null;
    if (v === t) tiers[0].add(v);
    else if (product !== null && product === t) tiers[1].add(v);
    else if (v.startsWith(t)) tiers[2].add(v);
    else if (product !== null && product.startsWith(t)) tiers[3].add(v);
  }
  return tiers.find((s) => s.size) ?? new Set();
}

/// Rows passing the filters. `terms` maps column to text; `libraries` is the
/// Set of library ids listed.
export function filterRows(rows, terms, libraries) {
  const libOk = LIBRARIES.map((l) => libraries.has(l.id));
  const tests = [];
  for (const [column, { key }] of Object.entries(COLUMNS)) {
    const term = terms[column];
    if (!term || !term.trim()) continue;
    const keys = new Set();
    for (const r of rows) keys.add(key(r));
    const byText = new Map();
    for (const k of keys) {
      const text = keyText(column, k);
      if (!byText.has(text)) byText.set(text, []);
      byText.get(text).push(k);
    }
    const allowedKeys = new Set();
    for (const text of admitted(byText.keys(), term, column)) for (const k of byText.get(text)) allowedKeys.add(k);
    tests.push((r) => allowedKeys.has(key(r)));
  }
  return rows.filter((r) => libOk[r.lib] && tests.every((t) => t(r)));
}

/// One page of rows and the page arithmetic around it.
/// Drop the delayed-fission rows of nuclides found to have no delayed neutron
/// data for that MT. `known` maps `library/name` to the Set of MTs that do
/// have it; a nuclide not in it has not been checked yet and keeps its rows.
export function dropMissingDelayed(rows, known) {
  if (!known.size) return rows;
  return rows.filter((r) => {
    if (!r.delayed) return true;
    const mts = known.get(`${LIBRARIES[r.lib].id}/${r.name}`);
    return !mts || mts.has(r.mt);
  });
}

export function paginate(rows, page, limit) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(Math.max(0, page), pages - 1);
  const start = current * limit;
  return { rows: rows.slice(start, start + limit), page: current, pages, total };
}

/// A row's id: `endf-b8.1:Fe56:16`, as the URL's `v` spells it.
export const rowId = (r) => `${LIBRARIES[r.lib].id}:${r.name}:${choiceId(r.mt, r.delayed)}`;
