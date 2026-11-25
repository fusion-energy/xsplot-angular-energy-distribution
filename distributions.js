// Secondary neutron distributions, from the rows of `products.arrow` and
// `distributions.arrow` to plain tables of probability density.
//
// Every distribution comes out in one shape per mode:
//
//   {tables: [{ein, x, p, hist}], note, discreteDropped}
//
// one table per tabulated incident energy `ein` (eV): `x` the outgoing energy
// (eV) in energy mode or the scattering cosine in angle mode, `p` the
// probability density over `x` (per eV, or per unit cosine), normalised to
// one, and `hist` true when the evaluation interpolates `p` as a histogram
// rather than linearly. A mode the data cannot fill has no tables and a `note`
// saying why (elastic scattering has no outgoing-energy spread; a fission
// neutron is emitted isotropically).
//
// The column layouts are those `yamc-nuclide` reads (crates/yamc-nuclide/src/
// arrow/nuclide_arrow.rs, `parse_distribution` and what it calls); the
// comments name the Rust each block follows. Nothing here touches Arrow, the
// network or the DOM: a row is a plain object of columns, so the arithmetic is
// tested under Node.
//
// What is computed rather than read:
//
// * Angle mode for correlated and Kalbach-Mann data: the angular distribution
//   is given per outgoing energy, so it is averaged over the outgoing-energy
//   spectrum at each incident energy onto a grid of MU_POINTS cosines.
// * The analytic energy laws (Maxwell, evaporation, Watt, n-body phase
//   space): evaluated on a grid of outgoing energies at each incident energy
//   the law is tabulated at (n-body: on NBODY_POINTS incident energies up to
//   the nuclide's highest tabulated incident energy, since the law has no
//   incident grid of its own).
// * Several distributions for one product (an applicability table weighting
//   each by incident energy) and several products for one choice (the delayed
//   neutron precursor groups, weighted by their yields) are summed into one
//   table per incident energy.

/// Cosine grid for distributions averaged over outgoing energy.
export const MU_POINTS = 201;
/// Outgoing-energy points for an analytic spectrum (geometric plus linear).
const ANALYTIC_POINTS = 120;
/// Incident energies the n-body law is evaluated at, and the highest used when
/// the caller does not say how far the nuclide's data reaches.
const NBODY_POINTS = 40;
const NBODY_EMAX = 2e7;

// --- small helpers ------------------------------------------------------------

const len = (a) => (a ? a.length : 0);
const at = (a, i, fallback) => (a && i < a.length ? a[i] : fallback);

/// Normalise a table in place so its density integrates to one, histogram or
/// lin-lin as it declares. Returns false when it integrates to zero.
export function normalizeTable(t) {
  const { x, p } = t;
  let integral = 0;
  for (let i = 0; i + 1 < x.length; i++) {
    const dx = x[i + 1] - x[i];
    integral += t.hist ? p[i] * dx : 0.5 * (p[i] + p[i + 1]) * dx;
  }
  if (!(integral > 0) || !Number.isFinite(integral)) return false;
  for (let i = 0; i < p.length; i++) p[i] /= integral;
  return true;
}

/// A table from parallel slices, normalised; null if it has no area.
function table(ein, x, p, hist) {
  const t = { ein, x: Float64Array.from(x), p: Float64Array.from(p), hist };
  return t.x.length >= 2 && normalizeTable(t) ? t : null;
}

/// The density of table `t` at `xs` (ascending), zero outside its range. A
/// histogram's last point closes its last bin, so it is zero there too.
export function evalTable(t, xs) {
  const out = new Float64Array(xs.length);
  const { x, p } = t;
  const n = x.length;
  if (n === 0) return out;
  let i = 0;
  for (let k = 0; k < xs.length; k++) {
    const v = xs[k];
    if (v < x[0] || v > x[n - 1]) continue;
    while (i + 1 < n - 1 && x[i + 1] <= v) i++;
    if (v >= x[n - 1]) { out[k] = t.hist ? 0 : p[n - 1]; continue; }
    const dx = x[i + 1] - x[i];
    if (t.hist || dx <= 0) out[k] = p[i];
    else out[k] = p[i] + ((p[i + 1] - p[i]) * (v - x[i])) / dx;
  }
  return out;
}

/// ENDF TAB1 evaluation: `x`, `y` with region breakpoints `nbt` and
/// interpolation codes `interp` (1 histogram, 2 lin-lin, 3 lin-log, 4 log-lin,
/// 5 log-log). Clamped to the end values outside the table.
export function evalTab1(x, y, nbt, interp, v) {
  const n = len(x);
  if (!n) return 0;
  if (v <= x[0]) return y[0];
  if (v >= x[n - 1]) return y[n - 1];
  let i = 0;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] <= v) lo = mid; else hi = mid; }
  i = lo;
  let code = 2;
  if (len(nbt)) {
    for (let r = 0; r < nbt.length; r++) { if (i + 1 < nbt[r]) { code = at(interp, r, 2); break; } code = at(interp, r, 2); }
  }
  const x0 = x[i], x1 = x[i + 1], y0 = y[i], y1 = y[i + 1];
  switch (code) {
    case 1: return y0;
    case 3: return x0 > 0 && x1 > 0 ? y0 + ((y1 - y0) * Math.log(v / x0)) / Math.log(x1 / x0) : y0;
    case 4: return y0 > 0 && y1 > 0 ? y0 * Math.exp((Math.log(y1 / y0) * (v - x0)) / (x1 - x0)) : y0;
    case 5: return x0 > 0 && x1 > 0 && y0 > 0 && y1 > 0 ? y0 * Math.exp((Math.log(y1 / y0) * Math.log(v / x0)) / Math.log(x1 / x0)) : y0;
    default: return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
  }
}

/// A TAB1 stored as `data` = [x..., y...] with `shape` [2, n] (the products
/// yield and distributions applicability columns), as a function of energy.
export function tab1Function(data, shape, breakpoints, interpolation) {
  if (!len(data)) return null;
  const n = len(shape) >= 2 ? shape[1] : data.length / 2;
  if (data.length < 2 * n) return null;
  const x = data.slice(0, n);
  const y = data.slice(n, 2 * n);
  return (e) => evalTab1(x, y, breakpoints, interpolation, e);
}

/// A product's yield as a function of incident energy: a polynomial in E or a
/// TAB1. Unknown or empty means one.
export function yieldFunction(product) {
  const data = product.yield_data;
  if (product.yield_type === 'Polynomial' && len(data)) {
    return (e) => { let s = 0, pw = 1; for (const c of data) { s += c * pw; pw *= e; } return s; };
  }
  if (product.yield_type === 'Tabulated1D') {
    const f = tab1Function(data, product.yield_shape, product.yield_breakpoints, product.yield_interpolation);
    if (f) return f;
  }
  return () => 1;
}

const emptyMode = (note) => ({ tables: [], note, discreteDropped: 0 });

// --- tabulated laws -----------------------------------------------------------

/// Tables of `x`/`p` packed as one C-order (rows, total) array with per-table
/// offsets into a row: the layout of `angle_mu_data` (rows 3: x, pdf, cdf),
/// `energy_dist_data` (3) and `km_data` (5). `nDiscrete` leading points of a
/// table are discrete lines (a probability, not a density) and are left out of
/// the density; their count is returned.
function packedTables(energies, data, offsets, interp, rows, nDiscrete) {
  const total = Math.floor(len(data) / rows);
  const tables = [];
  let dropped = 0;
  for (let idx = 0; idx < len(energies); idx++) {
    const start = at(offsets, idx, 0);
    const end = idx + 1 < len(offsets) ? offsets[idx + 1] : total;
    const nd = Math.min(at(nDiscrete, idx, 0), end - start);
    dropped += nd > 0 ? 1 : 0;
    const from = start + Math.max(0, nd);
    const x = data.subarray ? data.subarray(from, end) : data.slice(from, end);
    const p = data.subarray ? data.subarray(total + from, total + end) : data.slice(total + from, total + end);
    const t = table(energies[idx], x, p, at(interp, idx, 2) === 1);
    if (t) tables.push(t);
  }
  return { tables, dropped };
}

/// `parse_uncorrelated`, angle half.
function uncorrelatedAngle(row) {
  if (!len(row.angle_energies)) {
    return emptyMode('This product is emitted isotropically: the evaluation gives no angular distribution, so every direction is equally likely.');
  }
  const { tables } = packedTables(row.angle_energies, row.angle_mu_data, row.angle_mu_offsets, row.angle_mu_interpolation, 3, null);
  return { tables, note: tables.length ? null : 'The angular tables are empty.', discreteDropped: 0 };
}

/// `parse_energy_distribution`.
function uncorrelatedEnergy(row) {
  const kind = row.energy_dist_type;
  switch (kind) {
    case null:
    case undefined:
      return emptyMode('This reaction tabulates no outgoing-energy distribution. For elastic scattering the outgoing energy follows from the scattering angle alone, so its angular distribution (Angle mode) is the whole story.');
    case 'continuous': {
      const { tables, dropped } = packedTables(row.energy_dist_energies, row.energy_dist_data, row.energy_dist_offsets,
        row.energy_dist_out_interp, 3, row.energy_dist_n_discrete);
      return { tables, note: null, discreteDropped: dropped };
    }
    case 'level': {
      const ratio = row.energy_mass_ratio ?? 0;
      const threshold = row.energy_threshold ?? 0;
      return emptyMode(`Inelastic scattering to a discrete level: each incident energy E gives a single outgoing energy, E′ = ${fmt(ratio)} × (E − ${fmtEnergy(threshold)}) in the centre-of-mass frame, so there is no spread to plot. Its angular distribution is in Angle mode.`);
    }
    case 'maxwell':
    case 'evaporation':
    case 'watt':
      return analyticSpectrum(row, kind);
    default:
      return emptyMode(`Outgoing-energy law "${kind}" is not drawn by this page.`);
  }
}

/// `parse_correlated`: energy tables straight from `corr_eout_data`, angle
/// averaged over outgoing energy.
function correlated(row) {
  const energies = row.corr_energies ?? [];
  const eout = row.corr_eout_data ?? new Float64Array(0);
  const offsets = row.corr_eout_offsets ?? [];
  const totalEout = Math.floor(len(eout) / 5);
  const muData = row.corr_mu_data ?? new Float64Array(0);
  const totalMu = Math.floor(len(muData) / 3);
  // One value per outgoing-energy point, globally over the row; the float copy
  // in rows 4 and 3 of corr_eout_data for a file that predates the int columns.
  const muOffsetAt = (k) => (len(row.corr_mu_offsets) === totalEout ? Math.max(0, row.corr_mu_offsets[k]) : eout[4 * totalEout + k]);
  const muInterpAt = (k) => (len(row.corr_mu_interp) === totalEout ? row.corr_mu_interp[k] : eout[3 * totalEout + k]);

  const energyTables = [];
  const angleTables = [];
  let dropped = 0;
  const grid = muGrid();
  for (let idx = 0; idx < energies.length; idx++) {
    const es = at(offsets, idx, 0);
    const ee = idx + 1 < offsets.length ? offsets[idx + 1] : totalEout;
    const nd = Math.min(at(row.corr_eout_n_discrete, idx, 0), ee - es);
    if (nd > 0) dropped++;
    const hist = at(row.corr_eout_interp, idx, 2) === 1;
    const x = eout.subarray(es, ee);
    const p = eout.subarray(totalEout + es, totalEout + ee);
    const t = table(energies[idx], x.subarray(nd), p.subarray(nd), hist);
    if (t) energyTables.push(t);

    // Angle: each outgoing point's mu table weighted by the probability of
    // that outgoing energy. The end of a point's mu table is the start of the
    // next point's, including across incident energies (the Rust comment on
    // U238 MT5 explains why the last one is not the end of the array).
    const weights = pointWeights(x, p, nd, hist);
    const acc = new Float64Array(grid.length);
    let wsum = 0;
    for (let j = 0; j < ee - es; j++) {
      const w = weights[j];
      if (!(w > 0)) continue;
      const k = es + j;
      const ms = muOffsetAt(k);
      const me = j + 1 < ee - es ? muOffsetAt(k + 1) : ee < totalEout ? muOffsetAt(ee) : totalMu;
      let density;
      if (ms < totalMu && me <= totalMu && me > ms + 1) {
        const mt = { x: muData.subarray(ms, me), p: Float64Array.from(muData.subarray(totalMu + ms, totalMu + me)), hist: muInterpAt(k) === 1 };
        if (!normalizeTable(mt)) continue;
        density = evalTable(mt, grid);
      } else {
        density = new Float64Array(grid.length).fill(0.5);
      }
      for (let g = 0; g < grid.length; g++) acc[g] += w * density[g];
      wsum += w;
    }
    if (wsum > 0) {
      const t2 = table(energies[idx], grid, acc, false);
      if (t2) angleTables.push(t2);
    }
  }
  return {
    energy: { tables: energyTables, note: null, discreteDropped: dropped },
    angle: { tables: angleTables, note: null, discreteDropped: 0, averaged: true },
  };
}

/// `parse_kalbach_mann`: energy tables from `km_data`; angle from the
/// Kalbach-Mann form a/(2 sinh a) (cosh aμ + r sinh aμ) at each outgoing point,
/// averaged over the outgoing spectrum.
function kalbachMann(row) {
  const energies = row.km_energies ?? [];
  const data = row.km_data ?? new Float64Array(0);
  const offsets = row.km_offsets ?? [];
  const total = Math.floor(len(data) / 5);
  const grid = muGrid();
  const energyTables = [];
  const angleTables = [];
  let dropped = 0;
  for (let idx = 0; idx < energies.length; idx++) {
    const s = at(offsets, idx, 0);
    const e = idx + 1 < offsets.length ? offsets[idx + 1] : total;
    const nd = Math.min(at(row.km_n_discrete, idx, 0), e - s);
    if (nd > 0) dropped++;
    const hist = at(row.km_interp, idx, 2) === 1;
    const x = data.subarray(s, e);
    const p = data.subarray(total + s, total + e);
    const r = data.subarray(3 * total + s, 3 * total + e);
    const a = data.subarray(4 * total + s, 4 * total + e);
    const t = table(energies[idx], x.subarray(nd), p.subarray(nd), hist);
    if (t) energyTables.push(t);

    const weights = pointWeights(x, p, nd, hist);
    const acc = new Float64Array(grid.length);
    let wsum = 0;
    for (let j = 0; j < e - s; j++) {
      const w = weights[j];
      if (!(w > 0)) continue;
      for (let g = 0; g < grid.length; g++) acc[g] += w * kalbach(grid[g], r[j], a[j]);
      wsum += w;
    }
    if (wsum > 0) {
      const t2 = table(energies[idx], grid, acc, false);
      if (t2) angleTables.push(t2);
    }
  }
  return {
    energy: { tables: energyTables, note: null, discreteDropped: dropped },
    angle: { tables: angleTables, note: null, discreteDropped: 0, averaged: true },
  };
}

/// The Kalbach-Mann angular density at cosine `mu`.
export function kalbach(mu, r, a) {
  if (!(Math.abs(a) > 1e-9)) return 0.5;
  return (a / (2 * Math.sinh(a))) * (Math.cosh(a * mu) + r * Math.sinh(a * mu));
}

/// The probability of each outgoing point of a table: a discrete line's own
/// probability for the first `nd`, then the density times the width the point
/// stands for (its bin for a histogram, half of each neighbouring interval for
/// lin-lin).
function pointWeights(x, p, nd, hist) {
  const n = x.length;
  const w = new Float64Array(n);
  for (let j = 0; j < Math.min(nd, n); j++) w[j] = p[j];
  for (let j = Math.max(nd, 0); j < n; j++) {
    if (hist) {
      w[j] = j + 1 < n ? p[j] * (x[j + 1] - x[j]) : 0;
    } else {
      const left = j > nd ? x[j] - x[j - 1] : 0;
      const right = j + 1 < n ? x[j + 1] - x[j] : 0;
      w[j] = p[j] * 0.5 * (left + right);
    }
  }
  return w;
}

function muGrid() {
  return Float64Array.from({ length: MU_POINTS }, (_, i) => -1 + (2 * i) / (MU_POINTS - 1));
}

// --- analytic laws ------------------------------------------------------------

/// Outgoing energies from 0 to `emax`: geometric near zero (for a log axis)
/// merged with linear (for a linear one).
function analyticGrid(emax) {
  const pts = new Set([0, emax]);
  const lo = emax * 1e-6;
  for (let i = 0; i < ANALYTIC_POINTS; i++) {
    pts.add(lo * Math.pow(emax / lo, i / (ANALYTIC_POINTS - 1)));
    pts.add((emax * i) / (ANALYTIC_POINTS - 1));
  }
  return Float64Array.from([...pts].filter((v) => v >= 0 && v <= emax)).sort();
}

const linlin = (xs, ys) => (e) => evalTab1(xs, ys, null, null, e);

/// Maxwell, evaporation and Watt spectra (ENDF MF5 LF 7, 9, 11), restricted to
/// 0 ≤ E′ ≤ E − U, at each incident energy their parameter is tabulated at.
function analyticSpectrum(row, kind) {
  const xs = row.energy_param_x ?? [];
  const ys = row.energy_param_y ?? [];
  const u = row.energy_restriction_u ?? 0;
  const first = linlin(xs, ys);
  const second = kind === 'watt' ? linlin(row.energy_param2_x ?? [], row.energy_param2_y ?? []) : null;
  const tables = [];
  for (const ein of xs) {
    const emax = ein - u;
    if (!(emax > 0)) continue;
    const grid = analyticGrid(emax);
    const p = new Float64Array(grid.length);
    const theta = first(ein);
    for (let i = 0; i < grid.length; i++) {
      const e = grid[i];
      if (kind === 'maxwell') p[i] = Math.sqrt(e) * Math.exp(-e / theta);
      else if (kind === 'evaporation') p[i] = e * Math.exp(-e / theta);
      else p[i] = Math.exp(-e / theta) * Math.sinh(Math.sqrt(second(ein) * e));
    }
    const t = table(ein, grid, p, false);
    if (t) tables.push(t);
  }
  const name = { maxwell: 'Maxwell', evaporation: 'evaporation', watt: 'Watt' }[kind];
  return { tables, note: null, discreteDropped: 0, analytic: `${name} spectrum, computed from its tabulated parameters` };
}

/// `parse_nbody`: N-body phase space (ENDF MF6 LAW 6), density
/// √E′ (E′max − E′)^(3N/2 − 4) with E′max = (Ap − 1)/Ap · (A/(A+1) · E + Q).
function nbody(row, top = NBODY_EMAX) {
  const n = row.nbody_n ?? 0;
  const ap = row.nbody_total_mass ?? 0;
  const awr = row.nbody_atomic_weight_ratio ?? 0;
  const q = row.nbody_q_value ?? 0;
  if (!(n >= 2) || !(ap > 1) || !(awr > 0)) return emptyMode('The n-body phase-space parameters are incomplete.');
  const emaxOf = (e) => ((ap - 1) / ap) * ((awr / (awr + 1)) * e + q);
  const threshold = q < 0 ? (-q * (awr + 1)) / awr : 1e-5;
  const lo = threshold * 1.001;
  const tables = [];
  for (let i = 0; i < NBODY_POINTS; i++) {
    const ein = lo * Math.pow(top / lo, i / (NBODY_POINTS - 1));
    const emax = emaxOf(ein);
    if (!(emax > 0)) continue;
    const grid = analyticGrid(emax);
    const p = new Float64Array(grid.length);
    const power = 1.5 * n - 4;
    for (let k = 0; k < grid.length; k++) p[k] = Math.sqrt(grid[k]) * Math.pow(Math.max(0, emax - grid[k]), power);
    const t = table(ein, grid, p, false);
    if (t) tables.push(t);
  }
  return { tables, note: null, discreteDropped: 0, analytic: `${n}-body phase-space law, computed at ${NBODY_POINTS} incident energies up to ${fmtEnergy(top)}` };
}

// --- one row, one product, one choice -------------------------------------------

const LAW_NAMES = {
  uncorrelated: 'uncorrelated angle and energy',
  correlated: 'correlated angle-energy',
  'kalbach-mann': 'Kalbach-Mann systematics',
  nbody: 'n-body phase space',
};

/// One `distributions.arrow` row as `{law, energy, angle}`. `emax` is the top
/// incident energy of the nuclide's data, for the laws with no incident grid.
export function parseDistribution(row, emax = NBODY_EMAX) {
  switch (row.type) {
    case 'uncorrelated':
      return { law: lawName(row), energy: uncorrelatedEnergy(row), angle: uncorrelatedAngle(row) };
    case 'correlated':
      return { law: LAW_NAMES.correlated, ...correlated(row) };
    case 'kalbach-mann':
      return { law: LAW_NAMES['kalbach-mann'], ...kalbachMann(row) };
    case 'nbody':
      return {
        law: LAW_NAMES.nbody,
        energy: nbody(row, emax),
        angle: emptyMode('The n-body phase-space law emits isotropically in the centre-of-mass frame.'),
      };
    default:
      throw new Error(`distribution type "${row.type}" is not one this page reads`);
  }
}

function lawName(row) {
  const e = row.energy_dist_type;
  const energy = {
    continuous: 'tabulated energy', level: 'discrete level', maxwell: 'Maxwell spectrum',
    evaporation: 'evaporation spectrum', watt: 'Watt spectrum',
  }[e];
  return energy ? `${LAW_NAMES.uncorrelated} (${energy})` : e ? `${LAW_NAMES.uncorrelated} (${e})` : 'angular distribution only';
}

/// The table at or below `ein` (the incident axis as a histogram), else the
/// first; null when `ein` is outside the set's range.
function tableAt(tables, ein) {
  if (!tables.length) return null;
  const first = tables[0].ein;
  const last = tables[tables.length - 1].ein;
  if (ein < first * (1 - 1e-9) || ein > last * (1 + 1e-9)) return null;
  let best = tables[0];
  for (const t of tables) { if (t.ein <= ein * (1 + 1e-12)) best = t; else break; }
  return best;
}

/// Sum weighted tables onto the union of their points.
///
/// A lin-lin table that does not fall to zero at an end steps there, which a
/// shared grid would smear into a ramp across the neighbouring interval; a
/// point just outside each such end keeps the step.
export function sumTables(parts, ein) {
  if (parts.length === 1) return { ...parts[0].t, ein };
  const xs = new Set();
  for (const { t } of parts) {
    for (const v of t.x) xs.add(v);
    if (t.hist || !t.x.length) continue;
    const n = t.x.length;
    const eps = (v) => 1e-9 * Math.max(Math.abs(v), 1e-12);
    if (t.p[0] !== 0) xs.add(t.x[0] - eps(t.x[0]));
    if (t.p[n - 1] !== 0) xs.add(t.x[n - 1] + eps(t.x[n - 1]));
  }
  const grid = Float64Array.from(xs).sort();
  const p = new Float64Array(grid.length);
  const hist = parts.every(({ t }) => t.hist);
  for (const { t, w } of parts) {
    const d = evalTable(t, grid);
    for (let i = 0; i < grid.length; i++) p[i] += w * d[i];
  }
  return table(ein, grid, p, hist);
}

/// Combine modes, each with a weight function of incident energy, into one
/// mode: a table at every incident energy any of them has, summing the tables
/// in force there by weight. A single mode is returned as it is.
export function combineModes(weighted) {
  const withTables = weighted.filter(({ mode }) => mode.tables.length);
  if (!withTables.length) return weighted[0]?.mode ?? emptyMode('No data.');
  if (withTables.length === 1 && weighted.length === 1) return withTables[0].mode;
  const eins = [...new Set(withTables.flatMap(({ mode }) => mode.tables.map((t) => t.ein)))].sort((a, b) => a - b);
  const tables = [];
  for (const ein of eins) {
    const parts = [];
    for (const { mode, weight } of withTables) {
      const w = weight(ein);
      const t = w > 0 ? tableAt(mode.tables, ein) : null;
      if (t) parts.push({ t, w });
    }
    if (!parts.length) continue;
    const t = sumTables(parts, ein);
    if (t) tables.push(t);
  }
  const first = withTables[0].mode;
  return {
    tables,
    note: null,
    discreteDropped: withTables.reduce((n, { mode }) => n + mode.discreteDropped, 0),
    averaged: withTables.some(({ mode }) => mode.averaged),
    analytic: first.analytic,
  };
}

/// The view of one reaction's outgoing neutrons.
///
/// `products`: the `products.arrow` rows of the chosen neutrons (the one
/// prompt neutron product, or every delayed group); `distributions`: their
/// `distributions.arrow` rows. `emax` is the top incident energy of the
/// nuclide's data (see `topEnergy`). Returns `{law, energy, angle, groups}`.
export function buildView(products, distributions, emax = NBODY_EMAX) {
  if (!products.length) throw new Error('no outgoing neutron for this choice');
  const perProduct = products.map((product) => {
    const rows = distributions
      .filter((d) => d.product_idx === product.product_idx)
      .sort((a, b) => a.dist_idx - b.dist_idx);
    if (!rows.length) throw new Error(`product ${product.product_idx} has no distribution rows`);
    const parsed = rows.map((r) => ({ ...parseDistribution(r, emax), applicability: tab1Function(r.applicability_data, r.applicability_shape, r.applicability_breakpoints, r.applicability_interpolation) }));
    const weightOf = (p) => (rows.length > 1 && p.applicability ? p.applicability : () => 1);
    return {
      product,
      law: [...new Set(parsed.map((p) => p.law))].join(' + '),
      energy: combineModes(parsed.map((p) => ({ mode: p.energy, weight: weightOf(p) }))),
      angle: combineModes(parsed.map((p) => ({ mode: p.angle, weight: weightOf(p) }))),
    };
  });
  const weightOf = (pp) => (perProduct.length > 1 ? yieldFunction(pp.product) : () => 1);
  return {
    law: [...new Set(perProduct.map((p) => p.law))].join(' + '),
    groups: perProduct.length,
    energy: combineModes(perProduct.map((pp) => ({ mode: pp.energy, weight: weightOf(pp) }))),
    angle: combineModes(perProduct.map((pp) => ({ mode: pp.angle, weight: weightOf(pp) }))),
  };
}

/// The highest incident energy any distribution row tabulates, or the n-body
/// default when none does.
export function topEnergy(rows) {
  let top = 0;
  for (const r of rows) {
    for (const col of ['angle_energies', 'energy_dist_energies', 'corr_energies', 'km_energies', 'energy_param_x']) {
      const a = r[col];
      if (a && a.length) top = Math.max(top, a[a.length - 1]);
    }
  }
  return top > 0 ? top : NBODY_EMAX;
}

// --- formatting -----------------------------------------------------------------

function fmt(v) {
  return Number(v).toPrecision(5).replace(/\.?0+(e|$)/, '$1');
}

/// An energy in eV as the most readable of eV, keV and MeV.
export function fmtEnergy(ev) {
  const a = Math.abs(ev);
  if (a >= 1e6) return `${fmt(ev / 1e6)} MeV`;
  if (a >= 1e3) return `${fmt(ev / 1e3)} keV`;
  return `${fmt(ev)} eV`;
}
