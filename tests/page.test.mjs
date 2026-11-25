// The page's pure modules: reaction choice, the table, the URL and the
// ridgeline geometry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitsNeutrons, choicesOf, reactionName, parseChoiceId } from '../reactions.js';
import { rowsOfIndex, mergeRows, filterRows, paginate, rowId } from '../table.js';
import { encodeState, decodeState, einText } from '../url_state.js';
import { thin, stepify, pickRidge, buildRidgeline, formatEnergy } from '../ridgeline.js';
import { logRange, buildSelectedFigure, blend } from '../plot.js';

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
    xLog: false, yLog: true, energyUnit: 'MeV', ridges: 80,
  };
  const hash = encodeState(state);
  assert.match(hash, /a=jeff-4\.0:Am242_m1:2:0\.00001(&|$)/);
  const back = decodeState(hash);
  assert.deepEqual(back.view, state.view);
  assert.equal(back.mode, 'angle');
  assert.deepEqual(back.energy, state.energy);
  assert.equal(back.angle[0].ein, 1e-5);
  assert.equal(back.xLog, false);
  assert.equal(back.yLog, true);
  assert.equal(back.energyUnit, 'MeV');
  assert.equal(back.ridges, 80);
  assert.deepEqual([...back.libraries], ['endf-b8.1', 'jeff-4.0']);
  assert.equal(encodeState(decodeState('')), '');
  assert.equal(einText(14000000.000000002), '14000000');
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
  assert.ok(chosen.length >= 38 && chosen.length <= 40);
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
  assert.equal(fig.data.length, 3);
});

test('selected ridges take their colour; angle ridges keep isotropy at half height', () => {
  const t = [{ ein: 1, x: Float64Array.from([-1, 1]), p: Float64Array.from([0.5, 0.5]), hist: false }];
  const fig = buildRidgeline(t, { mode: 'angle', selected: new Map([[1, '#3987e5']]) });
  assert.equal(fig.data[0].line.color, '#3987e5');
  assert.deepEqual(fig.ridges[0].ys, [0.5, 0.5]);
});

test('the log range skips the negligible low-energy tail', () => {
  const r = logRange([{ x: [1e-5, 1e3, 1e6, 2e6], y: [1e-12, 1e-3, 1, 0.5] }]);
  assert.ok(r[0] > -1 && r[0] < 3.1);
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
