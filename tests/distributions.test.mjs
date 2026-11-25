// The distribution maths on synthetic rows laid out as distributions.arrow
// lays them out, with answers that can be worked by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildView, parseDistribution, normalizeTable, evalTable, evalTab1, kalbach, combineModes, yieldFunction,
  topEnergy, MU_POINTS,
} from '../distributions.js';

const f64 = (a) => Float64Array.from(a);
const i32 = (a) => Int32Array.from(a);
const close = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} ${a} != ${b}`);

/// Integral of a table as it declares itself.
function area(t) {
  let s = 0;
  for (let i = 0; i + 1 < t.x.length; i++) {
    const dx = t.x[i + 1] - t.x[i];
    s += t.hist ? t.p[i] * dx : 0.5 * (t.p[i] + t.p[i + 1]) * dx;
  }
  return s;
}
/// Mean of x over a lin-lin table by the trapezoid rule.
function mean(t) {
  let s = 0;
  for (let i = 0; i + 1 < t.x.length; i++) s += 0.5 * (t.x[i] * t.p[i] + t.x[i + 1] * t.p[i + 1]) * (t.x[i + 1] - t.x[i]);
  return s;
}

test('normalizeTable makes lin-lin and histogram tables integrate to one', () => {
  const lin = { x: f64([0, 1, 2]), p: f64([0, 4, 0]), hist: false };
  assert.ok(normalizeTable(lin));
  close(area(lin), 1);
  close(lin.p[1], 1);
  const hist = { x: f64([0, 1, 3]), p: f64([2, 1, 0]), hist: true };
  assert.ok(normalizeTable(hist));
  close(area(hist), 1);
  assert.equal(normalizeTable({ x: f64([0, 1]), p: f64([0, 0]), hist: false }), false);
});

test('evalTable interpolates lin-lin, holds a histogram, and is zero outside', () => {
  const t = { x: f64([0, 1, 2]), p: f64([0, 2, 0]), hist: false };
  assert.deepEqual(Array.from(evalTable(t, [-1, 0, 0.5, 1, 1.5, 2, 3])), [0, 0, 1, 2, 1, 0, 0]);
  const h = { x: f64([0, 1, 2]), p: f64([3, 5, 0]), hist: true };
  assert.deepEqual(Array.from(evalTable(h, [0, 0.5, 1, 1.5])), [3, 3, 5, 5]);
});

test('evalTab1 follows its interpolation regions and clamps outside', () => {
  const x = [1, 2, 4, 8], y = [1, 3, 3, 9];
  assert.equal(evalTab1(x, y, [2, 4], [1, 2], 1.5), 1); // histogram region
  assert.equal(evalTab1(x, y, [2, 4], [1, 2], 6), 6); // lin-lin region
  assert.equal(evalTab1(x, y, [4], [2], 0), 1);
  assert.equal(evalTab1(x, y, [4], [2], 99), 9);
  close(evalTab1([1, 100], [0, 2], [2], [3], 10), 1); // lin in log x
  close(evalTab1([1, 100], [1, 100], [2], [5], 10), 10); // log-log
});

test('kalbach is a normalised density for any r and a', () => {
  for (const [r, a] of [[0, 0], [0.3, 1.5], [1, 4], [0.9, 0.01]]) {
    let s = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) s += kalbach(-1 + (2 * (i + 0.5)) / n, r, a) * (2 / n);
    close(s, 1, 1e-5, `r=${r} a=${a}`);
  }
  assert.equal(kalbach(0.7, 0.5, 0), 0.5);
});

test('yieldFunction reads polynomial and tabulated yields', () => {
  close(yieldFunction({ yield_type: 'Polynomial', yield_data: f64([2, 0.5]) })(4), 4);
  const tab = yieldFunction({ yield_type: 'Tabulated1D', yield_data: f64([0, 10, 1, 3]), yield_shape: i32([2, 2]), yield_breakpoints: i32([2]), yield_interpolation: i32([2]) });
  close(tab(5), 2);
  assert.equal(yieldFunction({ yield_type: 'Unknown' })(1), 1);
});

const elasticRow = {
  type: 'uncorrelated', reaction_mt: 2, product_idx: 0, dist_idx: 0,
  // two incident energies; the first isotropic, the second linear in mu
  angle_energies: f64([1, 1e6]),
  angle_mu_data: f64([-1, 1, -1, 1, /* pdf */ 0.5, 0.5, 0.25, 0.75, /* cdf */ 0, 1, 0, 1]),
  angle_mu_offsets: i32([0, 2]),
  angle_mu_interpolation: i32([2, 2]),
  energy_dist_type: null,
};

test('uncorrelated angle tables are read per incident energy; no energy law says why', () => {
  const d = parseDistribution(elasticRow);
  assert.equal(d.angle.tables.length, 2);
  assert.deepEqual(Array.from(d.angle.tables[1].x), [-1, 1]);
  close(d.angle.tables[1].p[1], 0.75);
  assert.equal(d.energy.tables.length, 0);
  assert.match(d.energy.note, /elastic/);
});

test('continuous tabular energy leaves discrete lines out and normalises the rest', () => {
  const row = {
    type: 'uncorrelated', angle_energies: f64([]),
    energy_dist_type: 'continuous',
    energy_dist_energies: f64([1e6, 2e6]),
    // table 0: x 0..2 (3 points); table 1: one discrete line then x 0..1 (3 points)
    energy_dist_data: f64([0, 1, 2, 5e5, 0, 1, /* p */ 0, 1, 0, 0.7, 2, 2, /* c */ 0, 0.5, 1, 0.7, 0.85, 1]),
    energy_dist_offsets: i32([0, 3]),
    energy_dist_out_interp: i32([2, 1]),
    energy_dist_n_discrete: i32([0, 1]),
  };
  const d = parseDistribution(row);
  assert.equal(d.energy.tables.length, 2);
  assert.equal(d.energy.discreteDropped, 1);
  assert.deepEqual(Array.from(d.energy.tables[1].x), [0, 1]);
  assert.equal(d.energy.tables[1].hist, true);
  for (const t of d.energy.tables) close(area(t), 1);
  assert.match(d.angle.note, /isotropic/);
});

test('a level law explains its single outgoing energy', () => {
  const d = parseDistribution({ type: 'uncorrelated', angle_energies: f64([]), energy_dist_type: 'level', energy_mass_ratio: 0.9655, energy_threshold: 862000 });
  assert.equal(d.energy.tables.length, 0);
  assert.match(d.energy.note, /single outgoing energy/);
  assert.match(d.energy.note, /0\.9655/);
});

test('an evaporation spectrum has mean 2θ when E − U is far above θ', () => {
  const theta = 1e5;
  const d = parseDistribution({
    type: 'uncorrelated', angle_energies: f64([]), energy_dist_type: 'evaporation',
    energy_param_x: f64([1e7, 2e7]), energy_param_y: f64([theta, theta]), energy_restriction_u: 0,
  });
  assert.equal(d.energy.tables.length, 2);
  close(mean(d.energy.tables[1]), 2 * theta, 1e-2);
  close(area(d.energy.tables[0]), 1);
});

test('a Maxwell spectrum has mean 1.5θ', () => {
  const theta = 1.3e6;
  const d = parseDistribution({
    type: 'uncorrelated', angle_energies: f64([]), energy_dist_type: 'maxwell',
    energy_param_x: f64([1e5, 3e8]), energy_param_y: f64([theta, theta]), energy_restriction_u: 0,
  });
  close(mean(d.energy.tables[1]), 1.5 * theta, 1e-2);
});

/// A correlated row: one incident energy, two outgoing points, each with its
/// own mu table (forward for the first, backward for the second).
const correlatedRow = {
  type: 'correlated',
  corr_energies: f64([1.4e7]),
  // rows: x, p, c, mu_interp, mu_offset
  corr_eout_data: f64([1e6, 3e6, /* p */ 0.5, 0.5, /* c */ 0, 1, /* interp */ 2, 2, /* offsets */ 0, 2]),
  corr_eout_offsets: i32([0]),
  corr_eout_interp: i32([1]), // histogram: all weight on the first point
  corr_eout_n_discrete: i32([0]),
  corr_mu_data: f64([-1, 1, -1, 1, /* pdf */ 0, 1, 1, 0, /* cdf */ 0, 1, 0, 1]),
  corr_mu_offsets: i32([0, 2]),
  corr_mu_interp: i32([2, 2]),
};

test('correlated: energy tables as tabulated, angle averaged over outgoing energy', () => {
  const d = parseDistribution(correlatedRow);
  assert.equal(d.energy.tables.length, 1);
  assert.equal(d.energy.tables[0].hist, true);
  assert.equal(d.angle.tables.length, 1);
  const a = d.angle.tables[0];
  assert.equal(a.x.length, MU_POINTS);
  close(area(a), 1);
  // Histogram outgoing energies put all the weight on the first point, whose
  // mu table rises linearly to the front: p(mu) = (1 + mu) / 2.
  close(a.p[MU_POINTS - 1], 1, 1e-6);
  close(a.p[0], 0, 1e-6);
});

test('Kalbach-Mann: angle averaged from r and a, energy from the table', () => {
  const row = {
    type: 'kalbach-mann',
    km_energies: f64([1.4e7]),
    km_data: f64([0, 1e6, /* p */ 1e-6, 1e-6, /* c */ 0, 1, /* r */ 0, 0, /* a */ 2, 2]),
    km_offsets: i32([0]), km_interp: i32([2]), km_n_discrete: i32([0]),
  };
  const d = parseDistribution(row);
  const a = d.angle.tables[0];
  close(area(a), 1, 1e-4);
  // r = 0: symmetric about mu = 0.
  close(a.p[0], a.p[MU_POINTS - 1], 1e-12);
  close(a.p[(MU_POINTS - 1) / 2], kalbach(0, 0, 2), 1e-3);
});

test('n-body phase space ends at E′max and is isotropic', () => {
  const d = parseDistribution({ type: 'nbody', nbody_n: 3, nbody_total_mass: 2, nbody_atomic_weight_ratio: 1.996, nbody_q_value: -2.2246e6 }, 2e7);
  assert.ok(d.energy.tables.length > 10);
  const last = d.energy.tables[d.energy.tables.length - 1];
  close(last.ein, 2e7, 1e-9);
  const emax = (1 / 2) * ((1.996 / 2.996) * 2e7 - 2.2246e6);
  close(last.x[last.x.length - 1], emax, 1e-9);
  assert.match(d.angle.note, /isotropic/);
});

test('combineModes sums groups by weight on the union of their points', () => {
  const a = { tables: [{ ein: 1, x: f64([0, 1]), p: f64([1, 1]), hist: false }], note: null, discreteDropped: 0 };
  const b = { tables: [{ ein: 1, x: f64([1, 2]), p: f64([1, 1]), hist: false }], note: null, discreteDropped: 0 };
  const m = combineModes([{ mode: a, weight: () => 3 }, { mode: b, weight: () => 1 }]);
  assert.equal(m.tables.length, 1);
  const t = m.tables[0];
  close(area(t), 1);
  // Three quarters of the probability below x = 1, and the density steps
  // there rather than ramping: 3/4 to the left, 1/4 to the right.
  let below = 0;
  for (let i = 0; i + 1 < t.x.length && t.x[i + 1] < 1; i++) below += 0.5 * (t.p[i] + t.p[i + 1]) * (t.x[i + 1] - t.x[i]);
  close(below, 0.75, 1e-6);
  close(evalTable(t, [0.5])[0], 0.75, 1e-6);
  close(evalTable(t, [1.5])[0], 0.25, 1e-6);
});

test('buildView weights delayed groups by yield and refuses an empty choice', () => {
  const group = (idx, yieldValue, lo, hi) => ({
    product: { product_idx: idx, particle: 'neutron', emission_mode: 'delayed', yield_type: 'Polynomial', yield_data: f64([yieldValue]) },
    row: {
      type: 'uncorrelated', reaction_mt: 18, product_idx: idx, dist_idx: 0, angle_energies: f64([]),
      energy_dist_type: 'continuous', energy_dist_energies: f64([1e-5, 2e7]),
      energy_dist_data: f64([lo, hi, lo, hi, 1, 0, 1, 0, 0, 1, 0, 1]), energy_dist_offsets: i32([0, 2]),
      energy_dist_out_interp: i32([1, 1]), energy_dist_n_discrete: i32([0, 0]),
    },
  });
  const g1 = group(1, 0.001, 0, 1e5);
  const g2 = group(2, 0.003, 1e5, 2e5);
  const v = buildView([g1.product, g2.product], [g1.row, g2.row]);
  assert.equal(v.groups, 2);
  assert.equal(v.energy.tables.length, 2);
  const t = v.energy.tables[0];
  close(area(t), 1);
  // A quarter of the delayed neutrons come from group 1, below 100 keV.
  close(t.p[0] * 1e5, 0.25, 1e-9);
  assert.match(v.angle.note, /isotropic/);
  assert.throws(() => buildView([], []), /no outgoing neutron/);
});

test('topEnergy finds the highest tabulated incident energy', () => {
  assert.equal(topEnergy([elasticRow, correlatedRow]), 1.4e7);
  assert.equal(topEnergy([{ type: 'nbody' }]), 2e7);
});
