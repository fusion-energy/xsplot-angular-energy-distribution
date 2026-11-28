// The page's pure modules: reaction choice, the table, the URL and the
// ridgeline geometry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitsNeutrons, choicesOf, reactionName, parseChoiceId } from '../reactions.js';
import { rowsOfIndex, mergeRows, filterRows, paginate, rowId } from '../table.js';
import { encodeState, decodeState, einText } from '../url_state.js';
import { thin, stepify, pickRidge, buildRidgeline, formatEnergy } from '../ridgeline.js';
import { logRange, buildSelectedFigure, blend, quantile } from '../plot.js';

// The MTs published for Fe56, U235 and Li7 in ENDF/B-VIII.1, and the ones
// whose products.arrow carries an outgoing neutron.
const FE56 = [1, 2, 3, 4, 5, 16, 27, ...Array.from({ length: 39 }, (_, i) => 51 + i), 91, 101, 102, 103, 107, 111, 203, 204, 205, 206, 207, 301, 444, 600, 649, 800, 849, 901];
const U235 = [1, 2, 3, 4, 5, 16, 17, 18, 27, ...Array.from({ length: 39 }, (_, i) => 51 + i), 91, 101, 102, 103, 107, 203, 204, 205, 206, 207, 301, 444, 901];
const LI7 = [1, 2, 3, 4, 16, 24, 25, 27, ...Array.from({ length: 32 }, (_, i) => 51 + i), 101, 102, 104, 203, 204, 205, 207, 301, 444, 901];

test('the MTs kept are exactly those products.arrow gives a neutron', () => {
  const kept = (mts) => mts.filter(emitsNeutrons);
  assert.deepEqual(kept(FE56), [2, 5, 16, ...Array.from({ length: 39 }, (_, i) => 51 + i), 91]);
  assert.deepEqual(kept(U235), [2, 5, 16, 17, 18, ...Array.from({ length: 39 }, (_, i) => 51 + i), 91]);
  assert.deepEqual(kept(LI7), [2, 16, 24, 25, ...Array.from({ length: 32 }, (_, i) => 51 + i)]);
});

test('fission is offered as prompt and delayed', () => {
  const c = choicesOf([18, 102]);
  assert.deepEqual(c, [{ mt: 18, delayed: false }, { mt: 18, delayed: true }]);
  assert.equal(reactionName(18, true), '(n,fission) delayed');
  assert.equal(reactionName(16), '(n,2n)');
  assert.deepEqual(parseChoiceId('18d'), { mt: 18, delayed: true });
  assert.equal(parseChoiceId('x'), null);
});

const index = (library, nuclides) => ({ library, nuclides });

test('the table filters like the cross section plotter', () => {
  const rows = mergeRows([
    rowsOfIndex(index('endf-b8.1', { Fe56: FE56, Fe54: [2, 16], C12: [2, 5, 51], Ca40: [2] })),
    rowsOfIndex(index('jeff-4.0', { Fe56: [2, 16] })),
  ]);
  const ids = (terms, libs = ['endf-b8.1', 'jeff-4.0']) => filterRows(rows, terms, new Set(libs)).map(rowId);
  // Same reaction from two libraries sits together.
  assert.deepEqual(ids({ element: 'fe', nucleons: '56', reaction: '(n,2n)' }), ['endf-b8.1:Fe56:16', 'jeff-4.0:Fe56:16']);
  // `C` is carbon exactly, not calcium too.
  assert.ok(ids({ element: 'C' }).every((id) => id.includes(':C12:')));
  // The product alone, and the MT box.
  assert.deepEqual(ids({ nucleons: '56', reaction: 'elastic' }), ['endf-b8.1:Fe56:2', 'jeff-4.0:Fe56:2']);
  assert.deepEqual(ids({ element: 'Fe', nucleons: '56', mt: '16' }, ['jeff-4.0']), ['jeff-4.0:Fe56:16']);
  const page = paginate(filterRows(rows, {}, new Set(['endf-b8.1'])), 1, 10);
  assert.equal(page.page, 1);
  assert.equal(page.rows.length, 10);
});

test('the URL round-trips and leaves defaults out', () => {
  const state = {
    libraries: new Set(['endf-b8.1', 'jeff-4.0']),
    view: { library: 'endf-b8.1', name: 'U235', mt: 18, delayed: true },
    mode: 'angle',
    energy: [{ library: 'endf-b8.1', name: 'Fe56', mt: 16, delayed: false, ein: 14e6 }],
    angle: [{ library: 'jeff-4.0', name: 'Am242_m1', mt: 2, delayed: false, ein: 9.999999999999999e-6 }],
    xLog: false, yLog: false, energyUnit: 'MeV', ridges: 80,
  };
  const hash = encodeState(state);
  assert.match(hash, /a=jeff-4\.0:Am242_m1:2:0\.00001(&|$)/);
  const back = decodeState(hash);
  assert.deepEqual(back.view, state.view);
  assert.equal(back.mode, 'angle');
  assert.deepEqual(back.energy, state.energy);
  assert.equal(back.angle[0].ein, 1e-5);
  assert.equal(back.xLog, false);
  assert.equal(back.yLog, false);
  assert.match(hash, /y=lin/);
  assert.equal(decodeState('').yLog, true);
  assert.equal(back.energyUnit, 'MeV');
  assert.equal(back.ridges, 80);
  assert.deepEqual([...back.libraries], ['endf-b8.1', 'jeff-4.0']);
  assert.equal(encodeState(decodeState('')), '');
  assert.equal(einText(14000000.000000002), '14000000');
});

test('angle is the default mode, and energy mode is spelled m=energy', () => {
  assert.equal(decodeState('').mode, 'angle');
  assert.equal(decodeState('#m=energy').mode, 'energy');
  const s = decodeState('#v=endf-b8.1:Fe56:16');
  assert.equal(encodeState(s), '#v=endf-b8.1:Fe56:16');
  s.mode = 'energy';
  assert.equal(encodeState(s), '#v=endf-b8.1:Fe56:16&m=energy');
});

test('the URL drops what it cannot read and opens a ridgeline for bare selections', () => {
  const s = decodeState('#s=endf-b8.1:Fe56:16:14000000;nope:Fe56:16:1;endf-b8.1:fe56:16:1;endf-b8.1:Fe56:16:-3&n=7');
  assert.equal(s.energy.length, 1);
  assert.deepEqual(s.view, { library: 'endf-b8.1', name: 'Fe56', mt: 16, delayed: false });
  assert.equal(s.ridges, 40);
});

const tables = (eins) => eins.map((ein) => ({ ein, x: Float64Array.from([0, 1, 2]), p: Float64Array.from([0, 1, 0]), hist: false }));

test('thinning spreads ridges in log energy and keeps selected ones', () => {
  const t = tables(Array.from({ length: 1000 }, (_, i) => Math.pow(10, -5 + (13 * i) / 999)));
  const chosen = thin(t, 40);
  assert.ok(chosen.length >= 36 && chosen.length <= 40, String(chosen.length));
  assert.equal(chosen[0], 0);
  assert.equal(chosen[chosen.length - 1], 999);
  const kept = thin(t, 40, new Set([t[500].ein]));
  assert.ok(kept.includes(500));
  assert.deepEqual(thin(tables([1, 2, 3]), 40), [0, 1, 2]);
});

test('stepify draws a histogram as steps', () => {
  assert.deepEqual(stepify([0, 1, 2], [3, 5, 0], true), { x: [0, 1, 1, 2], y: [3, 3, 5, 5] });
  assert.deepEqual(stepify([0, 1], [3, 5], false), { x: [0, 1], y: [3, 5] });
});

test('pickRidge finds the ridge whose curve is under the cursor', () => {
  const fig = buildRidgeline(tables([1e6, 2e6, 4e6]), { mode: 'energy', xLog: false });
  const [a, b] = fig.ridges;
  // At the peak of ridge a, which rises into ridge b's band, a is picked.
  assert.equal(pickRidge(fig.ridges, 1, a.base + a.h * 0.98), a);
  // Just above b's baseline away from a's peak, b is picked.
  assert.equal(pickRidge(fig.ridges, 0.05, b.base + 0.01 * b.h), b);
  assert.equal(pickRidge(fig.ridges, 1, a.base - 5), null);
  assert.equal(fig.data.length, 6);
});

test('selected ridges take their colour; isotropic angle ridges are a quarter high', () => {
  const t = [
    { ein: 1, x: Float64Array.from([-1, 1]), p: Float64Array.from([0.5, 0.5]), hist: false },
    { ein: 2, x: Float64Array.from([-1, 1]), p: Float64Array.from([0.5, 0.5]), hist: false },
  ];
  const fig = buildRidgeline(t, { mode: 'angle', selected: new Map([[1, '#3987e5']]) });
  // Two traces a ridge, then the selected row's band and its outline on top.
  assert.equal(fig.data.length, 6);
  assert.equal(fig.data[2].fillcolor, blend('#3987e5', '#1a1a19', 0.55));
  assert.notEqual(fig.data[0].fillcolor, fig.data[2].fillcolor);
  assert.match(fig.data[4].fillcolor, /^rgba\(57, 135, 229, /);
  assert.deepEqual(fig.data[5].line, { color: '#3987e5', width: 3, dash: 'solid' });
  assert.deepEqual(fig.ridges[0].ys, [0.25, 0.25]);
  // Evenly spaced; the selected row's label is in its colour, and the plain
  // label next to it is dropped so the two do not collide.
  assert.deepEqual(fig.ridges.map((r) => r.base), [0, 1]);
  assert.deepEqual(fig.layout.yaxis.ticktext, ['<b><span style="color:#3987e5">1 eV</span></b>']);
});

test('curves from other reactions are overlaid on the nearest ridge, or counted out', () => {
  const t = tables([1e6, 1e7, 2e7]);
  const overlays = [
    { ein: 1.05e7, colour: '#d95926', x: Float64Array.from([0, 1, 2]), p: Float64Array.from([0, 1, 0]), hist: false },
    { ein: 1e9, colour: '#199e70', x: Float64Array.from([0, 1]), p: Float64Array.from([1, 1]), hist: false },
  ];
  const fig = buildRidgeline(t, { mode: 'energy', xLog: false, overlays });
  assert.equal(fig.overlaid, 1);
  assert.equal(fig.outside, 1);
  const dotted = fig.data.filter((d) => d.line?.dash === 'dot');
  assert.equal(dotted.length, 1);
  // On the 10 MeV row (base 1), peaking at the ridge height above it.
  assert.equal(Math.min(...dotted[0].y), 1);
  assert.equal(Math.max(...dotted[0].y), 1 + fig.ridges[1].h);
});

test('the log range skips the negligible low-energy tail', () => {
  // A histogram first bin from 1e-5 eV holding 1e-6 of the probability, as
  // spectra in the data have: the axis starts where the probability does.
  const r = logRange([{ x: [1e-5, 1e3, 1e3, 1e6, 2e6], y: [1e-15, 1e-15, 1e-6, 1, 0.5] }]);
  assert.ok(r[0] > 2.5 && r[0] < 3.5, String(r));
  assert.ok(r[1] > Math.log10(2e6));
  assert.equal(logRange([{ x: [0], y: [1] }]), null);
});

test('the selected figure converts units and keeps log axes positive', () => {
  const { data, layout } = buildSelectedFigure(
    [{ name: 'a', x: Float64Array.from([0, 1e6]), p: Float64Array.from([1e-6, 1e-6]), hist: false, slot: 0 }],
    { mode: 'energy', xLog: true, energyUnit: 'MeV' });
  assert.deepEqual(data[0].x, [1]);
  assert.deepEqual(data[0].y, [1]);
  assert.match(layout.yaxis.title.text, /1\/MeV/);
});

test('formatting', () => {
  assert.equal(formatEnergy(14e6, 'MeV'), '14 MeV');
  assert.equal(formatEnergy(1e-5, 'MeV'), '1e-5 eV');
  assert.equal(formatEnergy(14e6, 'eV'), '1.4e7 eV');
  assert.equal(blend('#ffffff', '#000000', 0.5), '#808080');
});

test('thinning fills in where tabulated energies cluster', () => {
  // Four sparse low energies, then a thousand between 1 and 10 MeV.
  const eins = [1e-5, 1e-3, 1e-1, 1e1, ...Array.from({ length: 1000 }, (_, i) => 1e6 + 9e6 * (i / 999))];
  const chosen = thin(tables(eins), 40);
  assert.ok(chosen.length >= 36, String(chosen.length));
  assert.ok(chosen.filter((i) => i >= 4).length >= 30);
});

test('quantile reads the probability below a point', () => {
  assert.equal(quantile([0, 2], [1, 1], 0.25), 0.5);
  assert.equal(quantile([0, 1], [0, 0], 0.5), null);
});
