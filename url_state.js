// The page as a URL: what the ridgeline shows, the selected curves of both
// modes and the axis settings, in the hash, so a plot can be linked and comes
// back on reload.
//
//   #v=endf-b8.1:Fe56:16&s=endf-b8.1:Fe56:16:14000000;jeff-4.0:Fe56:16:14000000&a=endf-b8.1:Fe56:2:1000000&m=angle&x=lin&y=lin&e=MeV&n=80&l=endf-b8.1,jeff-4.0
//
//   v  the ridgeline: library:nuclide:reaction, the reaction an MT with a `d`
//      for the delayed neutrons of fission (18d)
//   s  selected curves in energy mode, `;` separated, each
//      library:nuclide:reaction:incident energy in eV
//   a  the same for angle mode
//   m  `angle` when angle mode is showing (energy is the default)
//   x  `lin` for a linear outgoing-energy axis, y `lin` for a linear density axis
//   e  `MeV` for energies in MeV (eV is the default)
//   n  ridges drawn (40 is the default)
//   l  libraries listed in the table (all is the default)
//
// The incident energy is the tabulated value to 12 significant figures; a
// later release that tabulates another one is snapped to the nearest by the
// page, which says so.
// Anything unparseable is dropped rather than failing the page.

import { LIBRARIES, DEFAULT_LIBRARY } from './libraries.js';
import { choiceId, parseChoiceId } from './reactions.js';

const LIBRARY_IDS = new Set(LIBRARIES.map((l) => l.id));
export const DEFAULT_RIDGES = 40;
export const RIDGE_CHOICES = Object.freeze([20, 40, 80, 160, 320]);
const NAME_RE = /^[A-Z][a-z]?\d+(?:_m\d+)?$/;

/// An incident energy as the URL writes it: 12 significant figures, enough to
/// find the tabulated value again (the page matches within 1e-9) without the
/// float noise of a value such as 9.999999999999999e-6.
export const einText = (ein) => String(Number(ein.toPrecision(12)));

/// `{library, name, mt, delayed, ein}` as `library:name:reaction:ein`.
export function selectionText(s) {
  return `${s.library}:${s.name}:${choiceId(s.mt, s.delayed)}:${einText(s.ein)}`;
}

function parseView(text) {
  const parts = (text ?? '').split(':');
  if (parts.length !== 3) return null;
  const [library, name, choice] = parts;
  const c = parseChoiceId(choice);
  if (!LIBRARY_IDS.has(library) || !NAME_RE.test(name) || !c) return null;
  return { library, name, mt: c.mt, delayed: c.delayed };
}

function parseSelections(text) {
  const out = [];
  for (const item of (text ?? '').split(';')) {
    const parts = item.split(':');
    if (parts.length !== 4) continue;
    const view = parseView(parts.slice(0, 3).join(':'));
    const ein = Number(parts[3]);
    if (!view || !Number.isFinite(ein) || ein < 0) continue;
    out.push({ ...view, ein });
  }
  return out;
}

/// The state as a hash; defaults are left out.
export function encodeState(state) {
  const parts = [];
  if (state.view) parts.push(`v=${state.view.library}:${state.view.name}:${choiceId(state.view.mt, state.view.delayed)}`);
  if (state.energy.length) parts.push(`s=${state.energy.map(selectionText).join(';')}`);
  if (state.angle.length) parts.push(`a=${state.angle.map(selectionText).join(';')}`);
  if (state.mode === 'angle') parts.push('m=angle');
  if (!state.xLog) parts.push('x=lin');
  if (!state.yLog) parts.push('y=lin');
  if (state.energyUnit === 'MeV') parts.push('e=MeV');
  if (state.ridges !== DEFAULT_RIDGES) parts.push(`n=${state.ridges}`);
  const libs = LIBRARIES.map((l) => l.id).filter((id) => state.libraries.has(id));
  if (libs.length && libs.length < LIBRARIES.length) parts.push(`l=${libs.join(',')}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

/// The inverse: a full state with defaults for anything absent.
export function decodeState(hash) {
  const state = {
    libraries: new Set(LIBRARIES.map((l) => l.id)),
    view: null,
    mode: 'energy',
    energy: [],
    angle: [],
    xLog: true,
    yLog: true,
    energyUnit: 'eV',
    ridges: DEFAULT_RIDGES,
  };
  const text = (hash ?? '').replace(/^#/, '');
  if (!text) return state;
  const fields = new Map();
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
  }
  if (fields.has('v')) state.view = parseView(fields.get('v'));
  state.energy = parseSelections(fields.get('s'));
  state.angle = parseSelections(fields.get('a'));
  if (fields.get('m') === 'angle') state.mode = 'angle';
  if (fields.get('x') === 'lin') state.xLog = false;
  if (fields.get('y') === 'lin') state.yLog = false;
  if (fields.get('e') === 'MeV') state.energyUnit = 'MeV';
  const n = Number(fields.get('n'));
  if (RIDGE_CHOICES.includes(n)) state.ridges = n;
  if (fields.has('l')) {
    const libs = fields.get('l').split(',').filter((id) => LIBRARY_IDS.has(id));
    state.libraries = new Set(libs.length ? libs : [DEFAULT_LIBRARY]);
  }
  // A view with no ridgeline but selections opens on the first selection's.
  if (!state.view) {
    const first = state[state.mode][0] ?? state.energy[0] ?? state.angle[0];
    if (first) state.view = { library: first.library, name: first.name, mt: first.mt, delayed: first.delayed };
  }
  return state;
}
