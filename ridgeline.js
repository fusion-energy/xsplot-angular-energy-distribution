// The ridgeline: one ridge per tabulated incident energy, for picking curves.
//
// Ridges are evenly spaced, lowest incident energy at the bottom, and each is
// scaled to its own peak: it shows the shape of the distribution, not its size
// (the selected panel shows values). They are drawn from the highest incident
// energy down, each filled opaquely, so a lower ridge passes in front of the
// one above it.
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
/// distribution (0.5 everywhere) is a slim band at a quarter of the ridge
/// height rather than a solid block.
const ANGLE_PEAK_FLOOR = 2;

/// Indices of `tables` to draw: all when there are at most `max`, otherwise
/// about `max`, plus every table whose `ein` is in `keep`. Ascending.
///
/// Half are spread evenly in log incident energy, which covers the whole range;
/// where the tabulated energies are sparse several of those land on the same
/// table, and the rest are then spread evenly through the tables in order,
/// which puts them where the evaluation has the most detail.
export function thin(tables, max, keep = new Set()) {
  const n = tables.length;
  const chosen = new Set();
  if (n <= max) {
    for (let i = 0; i < n; i++) chosen.add(i);
  } else {
    const logs = tables.map((t) => Math.log10(Math.max(t.ein, FLOOR_EV)));
    const lo = logs[0], hi = logs[n - 1];
    const half = Math.max(2, Math.ceil(max / 2));
    let j = 0;
    for (let k = 0; k < half; k++) {
      const target = lo + ((hi - lo) * k) / (half - 1);
      while (j + 1 < n && Math.abs(logs[j + 1] - target) <= Math.abs(logs[j] - target)) j++;
      chosen.add(j);
    }
    const rest = max - chosen.size;
    for (let k = 0; k < rest; k++) chosen.add(Math.round(((n - 1) * (k + 0.5)) / rest));
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

/// The ridge fill, low incident energy to high: muted, so that a selected
/// ridge, drawn in its curve's vivid colour, stands out from all of them.
const RAMP = ['#1f3550', '#24485a', '#2a5a5c', '#3a6a55', '#55764a', '#74793f'];
const OUTLINE = 'rgba(236, 232, 218, 0.9)';

/// The ramp colour at `f` (0 to 1).
function rampColour(f) {
  const t = Math.min(Math.max(f, 0), 1) * (RAMP.length - 1);
  const i = Math.min(Math.floor(t), RAMP.length - 2);
  return blend(RAMP[i + 1], RAMP[i], t - i);
}

/// Up to `count` ridge indices to label, evenly through `n`, always the first
/// and the last.
function labelled(n, count) {
  if (n <= count) return [...Array(n).keys()];
  const step = (n - 1) / (count - 1);
  return [...new Set(Array.from({ length: count }, (_, k) => Math.round(k * step)))];
}

/// The ridgeline figure.
///
/// `tables`: one mode's tables. `selected`: Map from a selected `ein` to its
/// colour. Ridges are evenly spaced, lowest incident energy at the bottom, and
/// the axis is labelled with the incident energies of some of them: tabulated
/// energies cluster (Fe56 elastic has most of its 3979 above 10 keV), and
/// placing ridges at their energy on a log axis left most of the plot empty and
/// the rest crowded. Each ridge rises `overlap` spacings above its baseline.
///
/// Returns `{data, layout, config, ridges}`, `ridges` ascending by incident
/// energy, each `{ein, base, h, xs, ys}` with the drawn x values and the
/// curve's height as a fraction of the ridge, for `pickRidge`.
export function buildRidgeline(tables, {
  mode = 'energy', max = 40, selected = new Map(), xLog = true, energyUnit = 'eV', overlap = 2.4, xTitle = '',
} = {}) {
  const indices = thin(tables, max, new Set(selected.keys()));
  const scale = mode === 'energy' ? ENERGY_UNITS[energyUnit] ?? 1 : 1;
  const logX = mode === 'energy' && xLog;
  const h = overlap;
  const peakFloor = mode === 'angle' ? ANGLE_PEAK_FLOOR : 0;

  const ridges = [];
  for (const i of indices) {
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
    if (!xs.length) continue;
    const norm = Math.max(peak, peakFloor);
    ridges.push({ ein: t.ein, base: ridges.length, h, xs, ys: ys.map((y) => (norm > 0 ? y / norm : 0)) });
  }

  // Highest first, so each lower ridge is drawn over the one above it. A ridge
  // is two traces: the filled shape with no outline, and the outline along the
  // curve alone, so no baseline is drawn under it.
  const n = ridges.length;
  const data = [];
  for (const r of [...ridges].reverse()) {
    const colour = selected.get(r.ein);
    const y = r.ys.map((f) => r.base + r.h * f);
    data.push({
      type: 'scatter', mode: 'lines',
      x: [r.xs[0], ...r.xs, r.xs[r.xs.length - 1]],
      y: [r.base, ...y, r.base],
      fill: 'toself',
      fillcolor: colour ? blend(colour, SURFACE, 0.8) : rampColour(n > 1 ? r.base / (n - 1) : 0.5),
      line: { width: 0 },
      hoverinfo: 'skip', showlegend: false,
    });
    data.push({
      type: 'scatter', mode: 'lines',
      x: r.xs, y,
      line: { color: colour ? '#ffffff' : OUTLINE, width: colour ? 2 : 1 },
      hoverinfo: 'skip', showlegend: false,
    });
  }

  const xRange = logX ? logRange(ridges.map((r) => ({ x: r.xs, y: r.ys }))) : null;
  const ticks = labelled(n, 12);
  const layout = {
    paper_bgcolor: SURFACE,
    plot_bgcolor: SURFACE,
    font: { color: INK_SECONDARY, size: 13 },
    margin: { l: 90, r: 20, t: 10, b: 60 },
    xaxis: {
      type: logX ? 'log' : 'linear',
      gridcolor: GRID, zeroline: false, linecolor: GRID,
      tickfont: { color: INK_SECONDARY },
      title: { text: xTitle, font: { color: INK } },
      exponentformat: 'power',
      fixedrange: true,
      ...(mode === 'angle' ? { range: [-1, 1] } : xRange ? { range: xRange } : {}),
    },
    yaxis: {
      type: 'linear',
      range: [-0.4, Math.max(n - 1, 0) + h + 0.2],
      tickvals: ticks.map((k) => ridges[k].base),
      ticktext: ticks.map((k) => formatEnergy(ridges[k].ein, energyUnit)),
      showgrid: false, zeroline: false, linecolor: GRID,
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
