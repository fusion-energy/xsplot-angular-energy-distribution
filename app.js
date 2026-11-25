// The page: a searchable table of reactions that emit neutrons, a ridgeline of
// the chosen reaction's distribution at every incident energy, and a panel of
// the curves picked from it. All fetching and decoding happens in worker.js;
// this file owns the DOM.

import { LIBRARIES, libraryLabel } from './libraries.js';
import { rowsOfIndex, mergeRows, filterRows, paginate, rowId } from './table.js';
import { reactionName, choiceId } from './reactions.js';
import { encodeState, decodeState, RIDGE_CHOICES, selectionText } from './url_state.js';
import { buildRidgeline, pickRidge, formatEnergy } from './ridgeline.js';
import { buildSelectedFigure, styleFor, axisTitles, SURFACE, INK_SECONDARY } from './plot.js';
import { curvesToJson, curvesToCsv, downloadText } from './download.js';
import { ATOMIC_SYMBOL, nucleonsLabel } from './elements.js';

const PAGE_SIZE = 10;
/// Decoded views kept on this side (the ridgeline's, and those curves come from).
const VIEW_CACHE = 8;
const MODES = ['energy', 'angle'];
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- state ------------------------------------------------------------------

const state = { ...decodeState(location.hash), filters: {}, page: 0 };

const viewKey = (v) => `${v.library}:${v.name}:${choiceId(v.mt, v.delayed)}`;
const sameView = (a, b) => a && b && viewKey(a) === viewKey(b);
const selKey = (mode, s) => `${mode}|${selectionText(s)}`;

/// Table rows per library once its index has arrived, and the merged list.
const indexRows = new Map();
const indexLoads = new Map();
let allRows = [];
let filtered = [];

/// Decoded views by key, as promises, least recently used first.
const views = new Map();
/// The view the ridgeline shows, once loaded, and the ridges it drew.
let currentView = null;
let currentRidges = [];
let hovered = null;

/// Curves by selection key: the table picked from a view, with provenance.
const curves = new Map();
const curveErrors = new Map();
/// Colour slot per selection key; a removed curve frees its slot.
const slots = new Map();

// --- worker -------------------------------------------------------------------

const worker = new Worker('./worker.js', { type: 'module' });
const pending = new Map();
const workerReady = new Promise((resolve) => {
  worker.addEventListener('message', function once(e) {
    if (e.data?.type === 'ready') { worker.removeEventListener('message', once); resolve(); }
  });
});

worker.onmessage = (e) => {
  const msg = e.data;
  if (!msg.requestId) return;
  const p = pending.get(msg.requestId);
  if (!p) return;
  if (msg.type === 'progress') { p.onProgress?.(msg.loaded, msg.total); return; }
  pending.delete(msg.requestId);
  if (msg.type === 'error') p.reject(new Error(msg.error)); else p.resolve(msg);
};
worker.onerror = (e) => showError(`The data worker failed: ${e.message}`);

function ask(type, payload = {}, onProgress = null) {
  return workerReady.then(() => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pending.set(requestId, { resolve, reject, onProgress });
    worker.postMessage({ type, requestId, ...payload });
  }));
}

// --- busy, progress, messages -------------------------------------------------

let busyCount = 0;
function busy(on, message) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  if (message) $('busy-text').textContent = message;
  $('busy').classList.toggle('d-none', busyCount === 0);
}

/// Downloads in flight: label -> {loaded, total}.
const downloads = new Map();
function renderProgress() {
  const wrap = $('progress-wrap');
  const active = [...downloads.entries()].filter(([, d]) => d.total > 0 && d.loaded < d.total);
  if (!active.length) { wrap.classList.add('d-none'); return; }
  const loaded = active.reduce((n, [, d]) => n + d.loaded, 0);
  const total = active.reduce((n, [, d]) => n + d.total, 0);
  const mb = (b) => (b / 1e6).toFixed(1);
  $('progress-text').textContent = active.length === 1
    ? `Downloading the ${active[0][0]} distributions: ${mb(loaded)} of ${mb(total)} MB (each nuclide is downloaded once)`
    : `Downloading the distributions of ${active.length} nuclides: ${mb(loaded)} of ${mb(total)} MB`;
  $('progress-bar').style.width = `${(100 * loaded) / total}%`;
  wrap.classList.remove('d-none');
}

const errors = new Set();
function showError(message) {
  errors.add(message);
  $('error').textContent = [...errors].join('\n');
  $('error').classList.remove('d-none');
}
function clearErrors() {
  errors.clear();
  $('error').textContent = '';
  $('error').classList.add('d-none');
}
const notices = new Set();
function addNotice(message) {
  notices.add(message);
  $('notice').textContent = [...notices].join('\n');
  $('notice').classList.remove('d-none');
}
function clearNotices() {
  notices.clear();
  $('notice').classList.add('d-none');
}

// --- indexes and the table --------------------------------------------------------

function loadIndex(library) {
  if (indexRows.has(library) || indexLoads.has(library)) return;
  busy(true, `Loading the reaction list for ${libraryLabel(library)}...`);
  const p = ask('index', { library }).then(({ index }) => {
    indexRows.set(library, rowsOfIndex(index));
    allRows = mergeRows(LIBRARIES.filter((l) => indexRows.has(l.id)).map((l) => indexRows.get(l.id)));
    renderTable();
  }).catch((err) => {
    showError(`Could not load the reaction list for ${libraryLabel(library)}: ${err.message}`);
  }).finally(() => { indexLoads.delete(library); busy(false); });
  indexLoads.set(library, p);
}

function loadEnabledLibraries() {
  for (const lib of LIBRARIES) if (state.libraries.has(lib.id)) loadIndex(lib.id);
}

function renderTable() {
  const tbody = $('rows');
  if (!allRows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-secondary">Loading the reaction list...</td></tr>';
    $('pagination').innerHTML = '';
    return;
  }
  filtered = filterRows(allRows, state.filters, state.libraries);
  const page = paginate(filtered, state.page, PAGE_SIZE);
  state.page = page.page;
  const current = state.view ? viewKey(state.view) : null;
  const html = page.rows.map((r) => {
    const id = rowId(r);
    const reaction = reactionName(r.mt, r.delayed);
    const lib = LIBRARIES[r.lib];
    const isCurrent = id === current;
    const label = `Show ${r.name} ${reaction} from ${lib.label}`;
    return `<tr data-id="${id}" class="${isCurrent ? 'current-view' : ''}" role="button">
      <td class="row-show"><button class="btn btn-sm ${isCurrent ? 'btn-light' : 'btn-outline-light'}" type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${isCurrent ? 'Showing' : 'Show'}</button></td>
      <td>${ATOMIC_SYMBOL[r.z]}</td>
      <td class="mono">${nucleonsLabel(r.a, r.meta)}</td>
      <td>${escapeHtml(reaction)}</td>
      <td class="mono">${r.mt}</td>
      <td>${lib.label}</td>
    </tr>`;
  });
  if (!html.length) html.push('<tr><td colspan="6" class="text-center text-secondary">No reactions match these filters.</td></tr>');
  tbody.innerHTML = html.join('');
  $('counter').textContent = `${page.total.toLocaleString()} reactions match`;
  renderPagination(page);
}

function renderPagination({ page, pages }) {
  const item = (label, target, disabled = false, active = false, aria = '') =>
    `<li class="page-item${disabled ? ' disabled' : ''}${active ? ' active' : ''}"><a class="page-link" href="#" data-page="${target}" ${aria}>${label}</a></li>`;
  const parts = [item('&laquo;', 0, page === 0, false, 'aria-label="first"'), item('&lsaquo;', page - 1, page === 0, false, 'aria-label="previous"')];
  const from = Math.max(0, page - 2), to = Math.min(pages - 1, from + 4);
  for (let p = from; p <= to; p++) parts.push(item(String(p + 1), p, false, p === page));
  parts.push(item('&rsaquo;', page + 1, page >= pages - 1, false, 'aria-label="next"'), item('&raquo;', pages - 1, page >= pages - 1, false, 'aria-label="last"'));
  $('pagination').innerHTML = parts.join('');
}

// --- views --------------------------------------------------------------------------

/// The decoded view of a reaction, fetched once and kept for a while.
function getView(v) {
  const key = viewKey(v);
  if (views.has(key)) {
    const hit = views.get(key);
    views.delete(key);
    views.set(key, hit);
    return hit;
  }
  const label = `${v.name} (${libraryLabel(v.library)})`;
  const p = ask('view', { library: v.library, name: v.name, mt: v.mt, delayed: v.delayed }, (loaded, total) => {
    downloads.set(label, { loaded, total });
    renderProgress();
  }).then(({ view }) => view).finally(() => { downloads.delete(label); renderProgress(); });
  views.set(key, p);
  p.catch(() => views.delete(key));
  while (views.size > VIEW_CACHE) views.delete(views.keys().next().value);
  return p;
}

const frameText = (view) => (view.centerOfMass === true ? 'centre-of-mass frame' : view.centerOfMass === false ? 'laboratory frame' : 'frame not known');
const frameShort = (view) => (view.centerOfMass === true ? 'CM' : view.centerOfMass === false ? 'lab' : '');

/// Show a reaction in the ridgeline.
async function showView(v) {
  state.view = v;
  currentView = null;
  currentRidges = [];
  renderTable();
  syncUrl();
  $('view-title').textContent = `${v.name} ${reactionName(v.mt, v.delayed)} · ${libraryLabel(v.library)}`;
  $('view-notes').textContent = 'Loading...';
  drawRidgeline();
  try {
    const view = await getView(v);
    if (!sameView(state.view, v)) return;
    currentView = view;
  } catch (err) {
    if (!sameView(state.view, v)) return;
    $('view-notes').textContent = '';
    showError(err.message);
  }
  renderViewInfo();
  drawRidgeline();
}

function renderViewInfo() {
  const v = currentView;
  if (!v) return;
  const mode = v[state.mode];
  $('view-title').textContent = `${v.name} ${reactionName(v.mt, v.delayed)} · ${libraryLabel(v.library)} (release ${v.release})`;
  const notes = [
    `${v.law}${v.groups > 1 ? `, ${v.groups} precursor groups weighted by their yields` : ''}`,
    frameText(v),
  ];
  if (v.q !== null && v.q !== undefined) notes.push(`Q = ${formatEnergy(v.q, state.energyUnit)}`);
  if (mode.tables.length) notes.push(`${mode.tables.length} incident energies tabulated`);
  if (mode.averaged) notes.push('angle averaged over the outgoing-energy spectrum');
  if (mode.analytic) notes.push(mode.analytic);
  if (mode.discreteDropped) notes.push(`discrete lines at ${mode.discreteDropped} incident energies are not drawn`);
  $('view-notes').textContent = notes.join(' · ');
}

// --- ridgeline ------------------------------------------------------------------------

/// Selected incident energies of the shown view in the current mode, with colours.
function selectedInView() {
  const out = new Map();
  if (!state.view) return out;
  for (const s of state[state.mode]) {
    if (!sameView(s, state.view)) continue;
    out.set(s.ein, styleFor(slotOf(selKey(state.mode, s))).color);
  }
  return out;
}

function emptyFigure(message) {
  return {
    data: [],
    layout: {
      paper_bgcolor: SURFACE, plot_bgcolor: SURFACE,
      margin: { l: 20, r: 20, t: 20, b: 20 },
      xaxis: { visible: false }, yaxis: { visible: false },
      annotations: message ? [{ text: message, showarrow: false, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, font: { color: INK_SECONDARY, size: 15 } }] : [],
    },
    config: { displayModeBar: false, responsive: true },
  };
}

function drawRidgeline() {
  const note = $('ridge-note');
  note.classList.add('d-none');
  currentRidges = [];
  hovered = null;
  $('hover-label').textContent = '';
  let fig;
  if (!state.view) {
    fig = emptyFigure('Pick a reaction in the table above');
  } else if (!currentView) {
    fig = emptyFigure(errors.size ? '' : 'Loading...');
  } else {
    const mode = currentView[state.mode];
    if (!mode.tables.length) {
      fig = emptyFigure('');
      note.textContent = mode.note ?? 'Nothing to draw in this mode.';
      note.classList.remove('d-none');
    } else {
      const titles = axisTitles(state.mode, state.energyUnit);
      const frame = frameShort(currentView);
      fig = buildRidgeline(mode.tables, {
        mode: state.mode, max: state.ridges, selected: selectedInView(),
        xLog: state.xLog, energyUnit: state.energyUnit,
        xTitle: frame ? `${titles.x} (${frame})` : titles.x,
      });
      currentRidges = fig.ridges;
    }
  }
  Plotly.react('ridgeline', fig.data, fig.layout, fig.config);
  renderRidgeList();
}

function renderRidgeList() {
  const list = $('ridge-list');
  if (!currentRidges.length) { list.innerHTML = '<span class="text-secondary">No ridges drawn.</span>'; return; }
  const selected = selectedInView();
  list.innerHTML = currentRidges.map((r, i) => {
    const id = `ridge-${i}`;
    return `<div class="form-check"><input class="form-check-input" type="checkbox" id="${id}" data-ein="${r.ein}"${selected.has(r.ein) ? ' checked' : ''}>
      <label class="form-check-label" for="${id}">${formatEnergy(r.ein, state.energyUnit)}</label></div>`;
  }).join('');
}

/// The cursor over the ridgeline in data coordinates, or null outside the plot.
function cursorData(event) {
  const gd = $('ridgeline');
  const fl = gd._fullLayout;
  if (!fl || !fl.xaxis || !fl._size) return null;
  const rect = gd.getBoundingClientRect();
  const px = event.clientX - rect.left - fl._size.l;
  const py = event.clientY - rect.top - fl._size.t;
  if (px < 0 || py < 0 || px > fl._size.w || py > fl._size.h) return null;
  return { x: fl.xaxis.p2d(px), y: fl.yaxis.p2d(py) };
}

let hoverFrame = 0;
function onRidgeHover(event) {
  if (!currentRidges.length) return;
  const at = cursorData(event);
  const ridge = at ? pickRidge(currentRidges, at.x, at.y) : null;
  if (ridge === hovered) return;
  hovered = ridge;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const selected = ridge && selectedInView().has(ridge.ein);
    $('hover-label').textContent = ridge ? `${formatEnergy(ridge.ein, state.energyUnit)} · click to ${selected ? 'remove' : 'add'}` : '';
    const shapes = ridge ? [{
      type: 'line', xref: 'paper', x0: 0, x1: 1, y0: ridge.base, y1: ridge.base,
      line: { color: '#ffe9a8', width: 1.5, dash: 'dot' },
    }] : [];
    Plotly.relayout('ridgeline', { shapes });
  });
}

function onRidgeClick(event) {
  if (!currentRidges.length) return;
  const at = cursorData(event);
  const ridge = at ? pickRidge(currentRidges, at.x, at.y) : null;
  if (ridge) toggleSelection(ridge.ein);
}

// --- selection ------------------------------------------------------------------------

function slotOf(key) {
  if (!slots.has(key)) {
    const used = new Set(slots.values());
    let s = 0;
    while (used.has(s)) s++;
    slots.set(key, s);
  }
  return slots.get(key);
}

/// Add or remove a curve of the shown view at incident energy `ein`.
function toggleSelection(ein, { add = null } = {}) {
  if (!state.view || !currentView) return;
  const list = state[state.mode];
  const i = list.findIndex((s) => sameView(s, state.view) && s.ein === ein);
  if (i >= 0 && add !== true) {
    slots.delete(selKey(state.mode, list[i]));
    list.splice(i, 1);
  } else if (i < 0 && add !== false) {
    const s = { library: state.view.library, name: state.view.name, mt: state.view.mt, delayed: state.view.delayed, ein };
    list.push(s);
    rememberCurve(state.mode, s, currentView);
  }
  drawRidgeline();
  updateSelected();
  syncUrl();
}

/// Store the curve of selection `s` from `view`, snapping its incident energy
/// to the nearest tabulated one. Returns false when the view has no tables in
/// that mode.
function rememberCurve(mode, s, view) {
  const tables = view[mode].tables;
  if (!tables.length) {
    curveErrors.set(selKey(mode, s), `${s.name} ${reactionName(s.mt, s.delayed)} (${libraryLabel(s.library)}): ${view[mode].note ?? 'nothing to draw'}`);
    return false;
  }
  let best = tables[0];
  const target = Math.log(Math.max(s.ein, 1e-12));
  for (const t of tables) {
    if (Math.abs(Math.log(Math.max(t.ein, 1e-12)) - target) < Math.abs(Math.log(Math.max(best.ein, 1e-12)) - target)) best = t;
  }
  if (Math.abs(best.ein - s.ein) <= 1e-9 * Math.max(best.ein, 1e-12)) {
    s.ein = best.ein;
  } else {
    const before = selKey(mode, s);
    addNotice(`${s.name} ${reactionName(s.mt, s.delayed)} (${libraryLabel(s.library)}): the link asked for ${formatEnergy(s.ein, 'MeV')}; the nearest tabulated incident energy is ${formatEnergy(best.ein, 'MeV')}, which is drawn.`);
    if (slots.has(before)) { const slot = slots.get(before); slots.delete(before); s.ein = best.ein; slots.set(selKey(mode, s), slot); } else s.ein = best.ein;
  }
  curves.set(selKey(mode, s), {
    x: best.x, p: best.p, hist: best.hist, ein: best.ein,
    library: s.library, release: view.release, name: s.name, mt: s.mt, delayed: s.delayed,
    frame: frameText(view), frameShort: frameShort(view),
  });
  return true;
}

/// Fetch whatever the selected curves of the current mode still need, then draw.
async function updateSelected() {
  const mode = state.mode;
  const missing = state[mode].filter((s) => !curves.has(selKey(mode, s)) && !curveErrors.has(selKey(mode, s)));
  const byView = new Map();
  for (const s of missing) {
    const k = viewKey(s);
    if (!byView.has(k)) byView.set(k, []);
    byView.get(k).push(s);
  }
  drawSelected();
  if (!byView.size) return;
  await Promise.all([...byView.values()].map(async (sels) => {
    try {
      const view = await getView(sels[0]);
      for (const s of sels) rememberCurve(mode, s, view);
    } catch (err) {
      for (const s of sels) curveErrors.set(selKey(mode, s), `${s.name} ${reactionName(s.mt, s.delayed)} (${libraryLabel(s.library)}): ${err.message}`);
    }
    // Dedupe: snapping can make two selections the same.
    const seen = new Set();
    state[mode] = state[mode].filter((s) => { const k = selKey(mode, s); if (seen.has(k)) return false; seen.add(k); return true; });
    if (state.mode === mode) { drawSelected(); drawRidgeline(); }
  }));
  syncUrl();
}

function curveName(c) {
  const frame = state.mode === 'angle' && c.frameShort ? ` (${c.frameShort})` : '';
  return `${c.name} ${reactionName(c.mt, c.delayed)} ${libraryLabel(c.library)} · ${formatEnergy(c.ein, state.energyUnit)}${frame}`;
}

function drawSelected() {
  const mode = state.mode;
  const series = [];
  const rowsHtml = [];
  const errs = [];
  for (const s of state[mode]) {
    const key = selKey(mode, s);
    const c = curves.get(key);
    if (!c) {
      if (curveErrors.has(key)) errs.push(curveErrors.get(key));
      const label = `${s.name} ${reactionName(s.mt, s.delayed)} ${libraryLabel(s.library)} · ${formatEnergy(s.ein, state.energyUnit)}`;
      rowsHtml.push(`<tr><td></td><td class="small">${escapeHtml(label)} <span class="text-secondary">${curveErrors.has(key) ? '(not available)' : '(loading...)'}</span></td>
        <td class="text-end"><button class="btn btn-sm btn-outline-light" type="button" data-remove="${escapeHtml(key)}">Remove</button></td></tr>`);
      continue;
    }
    const slot = slotOf(key);
    const name = curveName(c);
    series.push({ name, x: c.x, p: c.p, hist: c.hist, slot });
    const { color } = styleFor(slot);
    const showing = sameView(s, state.view);
    rowsHtml.push(`<tr><td><span class="swatch" style="background:${color}"></span></td><td class="small">${escapeHtml(name)}</td>
      <td class="text-end text-nowrap">${showing ? '' : `<button class="btn btn-sm btn-outline-light me-1" type="button" data-show="${escapeHtml(key)}" title="Show this reaction in the ridgeline">Ridgeline</button>`}<button class="btn btn-sm btn-outline-light" type="button" data-remove="${escapeHtml(key)}">Remove</button></td></tr>`);
  }
  $('selected-rows').innerHTML = rowsHtml.join('');
  const { data, layout, config } = buildSelectedFigure(series, { mode, xLog: state.xLog, yLog: state.yLog, energyUnit: state.energyUnit });
  Plotly.react('selected', data, layout, config);
  $('download-json').disabled = $('download-csv').disabled = series.length === 0;
  for (const e of errs) showError(e);
}

function exportCurves() {
  const mode = state.mode;
  return state[mode].map((s) => curves.get(selKey(mode, s))).filter(Boolean).map((c) => ({
    nuclide: c.name, library: c.library, release: c.release, mt: c.mt,
    reaction: reactionName(c.mt, c.delayed), emission: c.delayed ? 'delayed' : 'prompt',
    mode, frame: c.frame, incident_energy_eV: c.ein, x: c.x, p: c.p,
  }));
}

// --- URL ---------------------------------------------------------------------------

let urlTimer = null;
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const target = `${location.pathname}${location.search}${encodeState(state)}`;
    if (`${location.pathname}${location.search}${location.hash}` !== target) history.replaceState(null, '', target);
  }, 150);
}

function applyUrl() {
  const decoded = decodeState(location.hash);
  const viewChanged = !sameView(decoded.view, state.view) || (!decoded.view) !== (!state.view);
  Object.assign(state, {
    libraries: decoded.libraries, mode: decoded.mode, energy: decoded.energy, angle: decoded.angle,
    xLog: decoded.xLog, yLog: decoded.yLog, energyUnit: decoded.energyUnit, ridges: decoded.ridges,
  });
  slots.clear();
  clearErrors();
  clearNotices();
  curveErrors.clear();
  renderControls();
  loadEnabledLibraries();
  if (viewChanged) {
    if (decoded.view) showView(decoded.view); else { state.view = null; currentView = null; drawRidgeline(); renderTable(); }
  } else {
    renderViewInfo();
    drawRidgeline();
    renderTable();
  }
  updateSelected();
}

// --- controls -----------------------------------------------------------------------

function renderControls() {
  for (const box of document.querySelectorAll('#library-menu input')) box.checked = state.libraries.has(box.value);
  const n = state.libraries.size;
  $('library-filter').textContent = n === LIBRARIES.length ? 'All libraries' : n === 1 ? libraryLabel([...state.libraries][0]) : `${n} of ${LIBRARIES.length}`;
  $('library-filter').classList.toggle('narrowed', n < LIBRARIES.length);
  $(`mode-${state.mode}`).checked = true;
  $('x-scale').textContent = state.xLog ? 'X: log' : 'X: linear';
  $('x-scale').disabled = state.mode === 'angle';
  $('y-scale').textContent = state.yLog ? 'Y: log' : 'Y: linear';
  $('x-unit').textContent = `Energy: ${state.energyUnit}`;
  $('ridge-count').value = String(state.ridges);
}

/// The library filter: a dropdown of checkboxes, at least one ticked. The menu
/// is fixed to the viewport so the table wrapper cannot clip it.
function libraryDropdown(onChange) {
  const menu = $('library-menu');
  const button = $('library-filter');
  menu.innerHTML = LIBRARIES.map((l) => `<div class="form-check">
      <input class="form-check-input" type="checkbox" id="lib-${l.id}" value="${l.id}">
      <label class="form-check-label" for="lib-${l.id}">${l.label}</label></div>`).join('');
  const openMenu = () => {
    const r = button.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - 220)}px`;
    menu.classList.remove('d-none');
    button.setAttribute('aria-expanded', 'true');
  };
  const closeMenu = () => { menu.classList.add('d-none'); button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', (e) => { e.stopPropagation(); if (menu.classList.contains('d-none')) openMenu(); else closeMenu(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== button) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', closeMenu, true);
  menu.addEventListener('change', (e) => {
    if (!e.target.matches('input')) return;
    if (e.target.checked) state.libraries.add(e.target.value); else state.libraries.delete(e.target.value);
    if (!state.libraries.size) { state.libraries.add(e.target.value); e.target.checked = true; return; }
    onChange();
  });
}

function buildControls() {
  libraryDropdown(() => {
    state.page = 0;
    renderControls();
    loadEnabledLibraries();
    renderTable();
    syncUrl();
  });

  let filterTimer = null;
  const filterInputs = [...document.querySelectorAll('.filter-input')];
  const applyFilters = () => {
    for (const input of filterInputs) state.filters[input.dataset.column] = input.value;
    state.page = 0;
    renderTable();
  };
  for (const input of filterInputs) {
    input.addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(applyFilters, 120); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(filterTimer); applyFilters(); } });
  }

  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const [library, name, choice] = tr.dataset.id.split(':');
    const m = /^(\d+)(d?)$/.exec(choice);
    clearErrors();
    showView({ library, name, mt: Number(m[1]), delayed: m[2] === 'd' });
  });
  $('pagination').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-page]');
    if (!a) return;
    e.preventDefault();
    if (a.closest('.page-item').classList.contains('disabled')) return;
    state.page = Number(a.dataset.page);
    renderTable();
  });

  for (const mode of MODES) {
    $(`mode-${mode}`).addEventListener('change', () => {
      state.mode = mode;
      clearErrors();
      renderControls();
      renderViewInfo();
      drawRidgeline();
      updateSelected();
      syncUrl();
    });
  }
  $('x-scale').addEventListener('click', () => { state.xLog = !state.xLog; renderControls(); drawRidgeline(); drawSelected(); syncUrl(); });
  $('y-scale').addEventListener('click', () => { state.yLog = !state.yLog; renderControls(); drawSelected(); syncUrl(); });
  $('x-unit').addEventListener('click', () => {
    state.energyUnit = state.energyUnit === 'eV' ? 'MeV' : 'eV';
    renderControls(); renderViewInfo(); drawRidgeline(); drawSelected(); syncUrl();
  });
  $('ridge-count').innerHTML = RIDGE_CHOICES.map((n) => `<option value="${n}">${n}</option>`).join('');
  $('ridge-count').addEventListener('change', (e) => { state.ridges = Number(e.target.value); drawRidgeline(); syncUrl(); });

  const gd = $('ridgeline');
  gd.addEventListener('mousemove', onRidgeHover);
  gd.addEventListener('mouseleave', () => { hovered = null; $('hover-label').textContent = ''; if (currentRidges.length) Plotly.relayout('ridgeline', { shapes: [] }); });
  gd.addEventListener('click', onRidgeClick);
  $('ridge-list').addEventListener('change', (e) => {
    if (!e.target.matches('input[data-ein]')) return;
    toggleSelection(Number(e.target.dataset.ein), { add: e.target.checked });
  });
  $('ein-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = Number($('ein-value').value) * Number($('ein-unit').value);
    if (!currentView || !Number.isFinite(value) || value < 0) return;
    const tables = currentView[state.mode].tables;
    if (!tables.length) return;
    const target = Math.log(Math.max(value, 1e-12));
    const best = tables.reduce((a, t) => (Math.abs(Math.log(Math.max(t.ein, 1e-12)) - target) < Math.abs(Math.log(Math.max(a.ein, 1e-12)) - target) ? t : a));
    toggleSelection(best.ein, { add: true });
  });

  $('selected-rows').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    const show = e.target.closest('[data-show]');
    const mode = state.mode;
    if (remove) {
      const key = remove.dataset.remove;
      state[mode] = state[mode].filter((s) => selKey(mode, s) !== key);
      slots.delete(key);
      curveErrors.delete(key);
      drawRidgeline();
      drawSelected();
      syncUrl();
    } else if (show) {
      const s = state[mode].find((x) => selKey(mode, x) === show.dataset.show);
      if (s) showView({ library: s.library, name: s.name, mt: s.mt, delayed: s.delayed });
    }
  });
  $('clear').addEventListener('click', () => {
    for (const s of state[state.mode]) slots.delete(selKey(state.mode, s));
    state[state.mode] = [];
    clearErrors();
    drawRidgeline();
    drawSelected();
    syncUrl();
  });
  const stem = () => `xsplot_${state.mode === 'energy' ? 'energy' : 'angle'}_distributions`;
  $('download-json').addEventListener('click', () => downloadText(`${stem()}.json`, curvesToJson(exportCurves()), 'application/json'));
  $('download-csv').addEventListener('click', () => downloadText(`${stem()}.csv`, curvesToCsv(exportCurves()), 'text/csv'));
  window.addEventListener('hashchange', applyUrl);
}

// --- start -------------------------------------------------------------------------

buildControls();
renderControls();
renderTable();
loadEnabledLibraries();
if (state.view) showView(state.view); else drawRidgeline();
updateSelected();
