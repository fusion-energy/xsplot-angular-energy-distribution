// The selected panel: every curve the user picked, at its true values.
//
// Colour follows the curve, not its position: each keeps the slot it was given
// when first selected until it is removed, so adding or removing a neighbour
// never repaints the rest, and its ridge is drawn in the same colour. Eight
// hues in fixed order; the ninth curve onward reuses them with a different
// dash. The palette and surface colours are those of
// nuclide_cross_section_plotter, so the sites look like one.

export const PALETTE = Object.freeze([
  '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767',
]);
const DASHES = ['solid', 'dash', 'dot', 'dashdot'];
export const SURFACE = '#1a1a19';
export const GRID = '#33332f';
export const INK = '#ffffff';
export const INK_SECONDARY = '#c3c2b7';

/// Energy units on offer, with the factor from the data's eV.
export const ENERGY_UNITS = Object.freeze({ eV: 1, MeV: 1e-6 });

/// Colour and dash for the n-th curve.
export function styleFor(slot) {
  return { color: PALETTE[slot % PALETTE.length], dash: DASHES[Math.floor(slot / PALETTE.length) % DASHES.length] };
}

/// `colour` mixed into `background` at `amount` (0 to 1), as an opaque hex.
export function blend(colour, background, amount) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = rgb(colour), b = rgb(background);
  return `#${a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount)).toString(16).padStart(2, '0')).join('')}`;
}

/// On a log outgoing-energy axis, the part of a spectrum below this fraction of
/// its peak is not worth the axis room (tables often start at 1e-5 eV).
export const LOG_RANGE_FRACTION = 1e-4;
/// The span of x worth showing on a log axis: from the lowest x where any curve
/// reaches LOG_RANGE_FRACTION of its own peak to the highest x drawn, as
/// log10 values with a margin; null when nothing is positive.
export function logRange(curves) {
  let lo = Infinity, hi = -Infinity;
  for (const { x, y } of curves) {
    let peak = 0;
    for (let i = 0; i < y.length; i++) if (y[i] > peak) peak = y[i];
    for (let i = 0; i < x.length; i++) {
      if (!(x[i] > 0)) continue;
      if (x[i] > hi) hi = x[i];
      if (y[i] >= peak * LOG_RANGE_FRACTION && x[i] < lo) lo = x[i];
    }
  }
  if (!(lo < hi)) return null;
  const a = Math.log10(lo), b = Math.log10(hi);
  const pad = (b - a) * 0.03;
  return [a - pad, b + pad];
}

/// Axis titles for a mode.
export function axisTitles(mode, energyUnit) {
  return mode === 'energy'
    ? { x: `Outgoing energy (${energyUnit})`, y: `Probability density (1/${energyUnit})` }
    : { x: 'Scattering cosine, cos θ', y: 'Probability density (per unit cos θ)' };
}

/// `series`: array of {name, x, p, hist, slot}, energies in eV and densities
/// per eV in energy mode. Returns {data, layout, config}.
export function buildSelectedFigure(series, { mode = 'energy', xLog = true, yLog = true, energyUnit = 'eV' } = {}) {
  const scale = mode === 'energy' ? ENERGY_UNITS[energyUnit] ?? 1 : 1;
  const logX = mode === 'energy' && xLog;
  const titles = axisTitles(mode, energyUnit);
  const xLabel = mode === 'energy' ? `E′ %{x:.4g} ${energyUnit}` : 'cos θ %{x:.3f}';
  const data = series.map((s) => {
    const { color, dash } = styleFor(s.slot);
    const x = [], y = [];
    for (let i = 0; i < s.x.length; i++) {
      const xv = s.x[i] * scale;
      const yv = s.p[i] / scale;
      if (logX && !(xv > 0)) continue;
      if (yLog && !(yv > 0)) continue;
      x.push(xv);
      y.push(yv);
    }
    return {
      type: 'scatter',
      mode: 'lines',
      name: s.name,
      x, y,
      line: { color, dash, width: 2, shape: s.hist ? 'hv' : 'linear' },
      hovertemplate: `${xLabel}<br>%{y:.4g}<extra>${s.name}</extra>`,
    };
  });
  const axis = (log, title) => ({
    type: log ? 'log' : 'linear',
    gridcolor: GRID, zerolinecolor: GRID, linecolor: GRID,
    tickfont: { color: INK_SECONDARY },
    title: { text: title, font: { color: INK } },
    exponentformat: 'power',
  });
  const xRange = logX && data.length ? logRange(data) : null;
  const layout = {
    paper_bgcolor: SURFACE,
    plot_bgcolor: SURFACE,
    font: { color: INK_SECONDARY, size: 13 },
    margin: { l: 80, r: 20, t: 20, b: 60 },
    xaxis: { ...axis(logX, titles.x), ...(mode === 'angle' ? { range: [-1.02, 1.02] } : xRange ? { range: xRange } : {}) },
    yaxis: axis(yLog, titles.y),
    showlegend: true,
    legend: { orientation: 'h', y: -0.18, yanchor: 'top', font: { color: INK } },
    hovermode: 'closest',
    hoverlabel: { bgcolor: '#26262a', bordercolor: GRID, font: { color: INK } },
    uirevision: `${mode}-${logX}-${yLog}-${energyUnit}`,
  };
  if (!series.length) {
    layout.annotations = [{
      text: 'Click ridges on the left to add them here',
      showarrow: false, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
      font: { color: INK_SECONDARY, size: 15 },
    }];
    layout.xaxis.showticklabels = false;
    layout.yaxis.showticklabels = false;
  }
  const config = { responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['select2d', 'lasso2d'] };
  return { data, layout, config };
}
