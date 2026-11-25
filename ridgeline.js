// The ridgeline: one ridge per tabulated incident energy, for picking curves.
//
// Each ridge sits at its incident energy on a logarithmic vertical axis, so the
// axis reads as incident energy, and is scaled to its own peak: it shows the
// shape of the distribution, not its size (the selected panel shows values).
// Ridges are drawn from the highest incident energy down, each filled with the
// background, so a lower ridge passes in front of the one above it.
//
// A table can hold thousands of incident energies (Fe56 elastic has 3979), so
// the ridges drawn are thinned to about `max`, evenly spaced in log energy,
// always keeping any incident energy that is selected.
//
// Clicking is resolved here from the cursor position rather than from Plotly's
// click events, which only fire on a data point: a ridge is a thin line and
// hard to hit. `pickRidge` takes the cursor in data coordinates and returns
// the ridge whose curve passes closest under it.

import { ENERGY_UNITS, SURFACE, GRID, INK, INK_SECONDARY, blend, logRange } from './plot.js';

/// The minimum incident energy used for a ridge's position, so an incident
/// energy of 0 (some angular tables start there) still has a place on a log axis.
const FLOOR_EV = 1e-5;
/// The smallest density an angular ridge is scaled to, so an isotropic
/// distribution (0.5 everywhere) is a ridge at half height rather than a box.
const ANGLE_PEAK_FLOOR = 1;
const UNSELECTED_LINE = '#9a9a90';

/// Indices of `tables` to draw: all when there are at most `max`, otherwise
/// about `max` spread evenly in log incident energy, plus every table whose
/// `ein` is in `keep`. Ascending.
export function thin(tables, max, keep = new Set()) {
  const n = tables.length;
  const chosen = new Set();
  if (n <= max) {
    for (let i = 0; i < n; i++) chosen.add(i);
  } else {
    const logs = tables.map((t) => Math.log10(Math.max(t.ein, FLOOR_EV)));
    const lo = logs[0], hi = logs[n - 1];
    let j = 0;
    for (let k = 0; k < max; k++) {
      const target = lo + ((hi - lo) * k) / (max - 1);
      while (j + 1 < n && Math.abs(logs[j + 1] - target) <= Math.abs(logs[j] - target)) j++;
      chosen.add(j);
    }
  }
  tables.forEach((t, i) => { if (keep.has(t.ein)) chosen.add(i); });
  return [...chosen].sort((a, b) => a - b);
}

/// A histogram table as the corners of its steps; a lin-lin one unchanged.
export function stepify(x, p, hist) {
  if (!hist || x.length < 2) return { x: Array.from(x), y: Array.from(p) };
  const xs = [], ys = [];
  for (let i = 0; i + 1 < x.length; i++) {
    xs.push(x[i], x[i + 1]);
    ys.push(p[i], p[i]);
  }
  return { x: xs, y: ys };
}

/// An energy in eV, written in `unit` ('eV' or 'MeV') with a sensible
/// precision; MeV below 1 keV falls back to eV so it does not read as 0.
export function formatEnergy(ev, unit = 'eV') {
  const fmt = (v) => {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(3).replace(/\.?0+e/, 'e').replace('e+', 'e');
    return String(Number(v.toPrecision(4)));
  };
  if (unit === 'MeV' && Math.abs(ev) >= 1e3) return `${fmt(ev / 1e6)} MeV`;
  return `${fmt(ev)} eV`;
}

/// Ticks for the incident-energy axis between `lo` and `hi` (log10 eV):
/// decades, or 1-2-5 when fewer than three decades fit.
function energyTicks(lo, hi, unit) {
  const pick = (mults) => {
    const vals = [];
    for (let k = Math.floor(lo) - 1; k <= Math.ceil(hi) + 1; k++) {
      for (const m of mults) {
        const v = k + Math.log10(m);
        if (v >= lo && v <= hi) vals.push(v);
      }
    }
    return vals;
  };
  let vals = pick([1]);
  if (vals.length < 3) vals = pick([1, 2, 5]);
  if (vals.length < 3) vals = pick([1, 1.5, 2, 3, 5, 7]);
  return { tickvals: vals, ticktext: vals.map((v) => formatEnergy(Math.pow(10, v), unit)) };
}

/// The median gap between consecutive distinct values, or `fallback`.
function medianGap(sorted, fallback) {
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > 1e-9) gaps.push(sorted[i] - sorted[i - 1]);
  if (!gaps.length) return fallback;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/// The ridgeline figure.
///
/// `tables`: one mode's tables. `selected`: Map from a selected `ein` to its
/// colour. A ridge is `overlap` times the median gap between drawn ridges, so
/// where incident energies cluster the ridges overlap as much as anywhere else. Returns `{data, layout, config, ridges}`, `ridges` ascending by
/// incident energy, each `{ein, base, h, xs, ys}` with the drawn x values and
/// the curve's height as a fraction of the ridge, for `pickRidge`.
export function buildRidgeline(tables, {
  mode = 'energy', max = 40, selected = new Map(), xLog = true, energyUnit = 'eV', overlap = 1.8, xTitle = '',
} = {}) {
  const indices = thin(tables, max, new Set(selected.keys()));
  const scale = mode === 'energy' ? ENERGY_UNITS[energyUnit] ?? 1 : 1;
  const logX = mode === 'energy' && xLog;
  const bases = indices.map((i) => Math.log10(Math.max(tables[i].ein, FLOOR_EV)));
  const lo = bases.length ? Math.min(...bases) : 0;
  const hi = bases.length ? Math.max(...bases) : 1;
  const h = Math.max(medianGap(bases, 0.5) * overlap, 1e-3);
  const peakFloor = mode === 'angle' ? ANGLE_PEAK_FLOOR : 0;

  const ridges = [];
  indices.forEach((i, k) => {
    const t = tables[i];
    const steps = stepify(t.x, t.p, t.hist);
    const xs = [], ys = [];
    let peak = 0;
    for (let j = 0; j < steps.x.length; j++) {
      const x = steps.x[j] * scale;
      if (logX && !(x > 0)) continue;
      xs.push(x);
      ys.push(steps.y[j]);
      if (steps.y[j] > peak) peak = steps.y[j];
    }
    if (!xs.length) return;
    const norm = Math.max(peak, peakFloor);
    const frac = ys.map((y) => (norm > 0 ? y / norm : 0));
    ridges.push({ ein: t.ein, base: bases[k], h, xs, ys: frac });
  });

  // Highest first, so each lower ridge is drawn over the one above it.
  const data = [...ridges].reverse().map((r) => {
    const colour = selected.get(r.ein);
    const x = [...r.xs, r.xs[r.xs.length - 1], r.xs[0]];
    const y = [...r.ys.map((f) => r.base + r.h * f), r.base, r.base];
    return {
      type: 'scatter',
      mode: 'lines',
      x, y,
      fill: 'toself',
      fillcolor: colour ? blend(colour, SURFACE, 0.35) : SURFACE,
      line: { color: colour ?? UNSELECTED_LINE, width: colour ? 2.2 : 1 },
      hoverinfo: 'skip',
      showlegend: false,
    };
  });

  const xRange = logX ? logRange(ridges.map((r) => ({ x: r.xs, y: r.ys }))) : null;
  const top = hi + h * 1.05;
  const bottom = lo - Math.max((hi - lo) * 0.03, 0.05);
  const ticks = energyTicks(bottom, top, energyUnit);
  const layout = {
    paper_bgcolor: SURFACE,
    plot_bgcolor: SURFACE,
    font: { color: INK_SECONDARY, size: 13 },
    margin: { l: 90, r: 20, t: 20, b: 60 },
    xaxis: {
      type: logX ? 'log' : 'linear',
      gridcolor: GRID, zerolinecolor: GRID, linecolor: GRID,
      tickfont: { color: INK_SECONDARY },
      title: { text: xTitle, font: { color: INK } },
      exponentformat: 'power',
      fixedrange: true,
      ...(mode === 'angle' ? { range: [-1.02, 1.02] } : xRange ? { range: xRange } : {}),
    },
    yaxis: {
      type: 'linear',
      range: [bottom, top],
      tickvals: ticks.tickvals, ticktext: ticks.ticktext,
      gridcolor: GRID, zeroline: false, linecolor: GRID,
      tickfont: { color: INK_SECONDARY },
      title: { text: 'Incident energy', font: { color: INK } },
      fixedrange: true,
    },
    hovermode: false,
    dragmode: false,
    showlegend: false,
    shapes: [],
  };
  const config = { responsive: true, displaylogo: false, displayModeBar: false, staticPlot: false };
  return { data, layout, config, ridges };
}

/// The ridge under the cursor at (`x`, `y`) in data coordinates: among ridges
/// whose band holds `y`, the one whose curve at `x` is nearest; otherwise the
/// ridge whose baseline is the highest below the cursor; null if the cursor is
/// below every ridge's band.
export function pickRidge(ridges, x, y) {
  let best = null;
  let bestDistance = Infinity;
  for (const r of ridges) {
    if (y < r.base - r.h * 0.05 || y > r.base + r.h * 1.05) continue;
    const curve = r.base + r.h * heightAt(r, x);
    const d = Math.abs(y - curve);
    if (d < bestDistance) { bestDistance = d; best = r; }
  }
  if (best) return best;
  let below = null;
  for (const r of ridges) if (r.base <= y && (!below || r.base > below.base)) below = r;
  return below;
}

/// The curve height (0 to 1) of a ridge at `x`, linear between drawn points,
/// zero outside them.
function heightAt(r, x) {
  const { xs, ys } = r;
  if (!xs.length || x < xs[0] || x > xs[xs.length - 1]) return 0;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const dx = xs[hi] - xs[lo];
  return dx > 0 ? ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / dx : Math.max(ys[lo], ys[hi]);
}
