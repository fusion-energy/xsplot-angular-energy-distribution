// Drive the page in headless Chromium against the published data.
//
//   python3 -m http.server 8000 &
//   node tests/e2e.mjs [--url http://127.0.0.1:8000/]
//
// Filters the table to Fe56 (n,2n), shows it, picks a ridge by clicking the
// ridgeline and another by typing an energy, downloads the curves, switches to
// angle mode, then opens every example plot and checks it draws the curves its
// link names and lists its libraries first in the citations. Writes
// screenshots to tests/screenshots/. A failure that names a fetch rather than
// an assertion is the data host, not the page.

import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const urlArg = process.argv.indexOf('--url');
const BASE = urlArg > 0 ? process.argv[urlArg + 1] : 'http://127.0.0.1:8000/';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1500 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

function check(cond, message) {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}
const traces = (id) => page.evaluate((i) => document.getElementById(i).data?.length ?? 0, id);
const named = (id) => page.evaluate((i) => (document.getElementById(i).data ?? []).map((d) => d.name), id);
const hash = () => page.evaluate(() => location.hash);
/// The hash is written 150 ms after a change, so wait for it.
const hashHas = async (...parts) => {
  try {
    await page.waitForFunction((ps) => ps.every((p) => location.hash.includes(p)), parts, { timeout: 5000 });
    return true;
  } catch { return false; }
};
/// The libraries the citation list marks as in the plot, in its order.
const cited = () => page.$$eval('#cite-list .cite-entry.in-plot', (es) => es.map((e) => e.dataset.library));
const waitCited = (ids) => page.waitForFunction((want) => {
  const got = [...document.querySelectorAll('#cite-list .cite-entry.in-plot')].map((e) => e.dataset.library);
  return got.length === want.length && want.every((id) => got.includes(id));
}, ids, { timeout: 10000 });
const waitTraces = (id, n, timeout = 120000) =>
  page.waitForFunction(([i, k]) => (document.getElementById(i).data?.length ?? 0) >= k, [id, n], { timeout });

try {
  await page.goto(BASE);
  await page.waitForSelector('#rows tr[data-id]', { timeout: 60000 });
  check(true, 'the reaction table loads');
  check(await page.$$eval('#cite-list .cite-entry', (es) => es.length) === 6 && (await cited()).length === 0,
    'the citation list names all six libraries, none in a plot yet');
  const cellTitle = await page.getAttribute('#rows tr[data-id] td:last-child', 'title');
  check(/Cite/.test(cellTitle ?? ''), `a Library cell's hover text cites it: ${cellTitle}`);
  const menuTitles = await page.$$eval('#library-menu label', (ls) => ls.map((l) => l.title));
  check(menuTitles.length === 6 && menuTitles.every((t) => /doi:10\./.test(t)), 'every library in the filter menu has a citation as hover text');
  await page.click('footer [data-scroll-to=cite]');
  await page.waitForFunction(() => { const r = document.getElementById('cite').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
  check(await hash() === '', 'the footer Cite link scrolls to the citations and leaves the URL alone');

  await page.fill('.filter-input[data-column=element]', 'Fe');
  await page.fill('.filter-input[data-column=nucleons]', '56');
  await page.fill('.filter-input[data-column=reaction]', 'n,2n');
  await page.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length > 0
    && [...document.querySelectorAll('#rows tr[data-id]')].every((tr) => tr.dataset.id.includes(':Fe56:16')));
  const ids = await page.$$eval('#rows tr[data-id]', (trs) => trs.map((t) => t.dataset.id));
  check(ids.includes('endf-b8.1:Fe56:16'), `filters narrow to Fe56 (n,2n): ${ids.join(', ')}`);

  check(await page.isChecked('#mode-angle'), 'the page opens in angle mode');
  await page.click('label[for=mode-energy]');
  await page.click('#rows tr[data-id="endf-b8.1:Fe56:16"]');
  await waitTraces('ridgeline', 10);
  const ridges = await traces('ridgeline');
  check(ridges >= 30, `the ridgeline draws ${ridges} ridges for Fe56 (n,2n)`);
  check(await hashHas('v=endf-b8.1:Fe56:16'), 'the URL names the ridgeline');
  await waitCited(['endf-b8.1']);
  check(await page.$eval('#cite-list .cite-entry', (e) => e.dataset.library) === 'endf-b8.1',
    'showing a reaction lists its library first in the citations, marked as in the plot');

  // Click in the middle of the plot area: some ridge is under it.
  const box = await page.evaluate(() => {
    const gd = document.getElementById('ridgeline');
    const r = gd.getBoundingClientRect();
    const s = gd._fullLayout._size;
    return { x: r.left + s.l + s.w * 0.3, y: r.top + s.t + s.h * 0.5 };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForFunction(() => document.getElementById('hover-label').textContent.includes('click to add'));
  check(true, `hovering names a ridge: ${await page.textContent('#hover-label')}`);
  await page.mouse.click(box.x, box.y);
  await waitTraces('selected', 1);
  check(await traces('selected') === 1, 'clicking a ridge adds its curve to the selected panel');

  await page.fill('#ein-value', '14');
  await page.click('#ein-form button[type=submit]');
  await waitTraces('selected', 2);
  const names = await named('selected');
  check(names.some((n) => n.includes('14 MeV') || n.includes('1.4e7 eV')), `typing 14 MeV adds the 14 MeV curve: ${names.join(' | ')}`);
  check(await hashHas('s=endf-b8.1:Fe56:16:', 'endf-b8.1:Fe56:16:14000000'), `the URL carries the selection: ${await hash()}`);
  await page.screenshot({ path: `${SHOTS}energy.png`, fullPage: true });

  const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.click('#download-json')]);
  const json = JSON.parse(readFileSync(await jsonDownload.path(), 'utf8'));
  check(json.length === 2 && json.every((c) => c.citations?.[0]?.doi === '10.1016/j.nds.2026.04.001' && c.terms),
    'the JSON download carries each curve\'s citations and terms');
  const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.click('#download-csv')]);
  const csv = readFileSync(await csvDownload.path(), 'utf8').trim().split('\n');
  check(csv[0].endsWith(',cite') && csv.slice(1).every((l) => l.endsWith('https://doi.org/10.11578/endf/2571019')),
    'every CSV row ends with the DOI links of its library');

  await page.click('label[for=mode-angle]');
  await waitTraces('ridgeline', 10);
  check(await traces('selected') === 0, 'angle mode has its own, empty, selection');
  await page.fill('#ein-value', '14');
  await page.click('#ein-form button[type=submit]');
  await waitTraces('selected', 1);
  check(await hashHas('a=endf-b8.1:Fe56:16:14000000') && !(await hash()).includes('m='),
    'angle selection is in the URL, and angle, the default mode, is left out of it');
  await page.screenshot({ path: `${SHOTS}angle.png`, fullPage: true });

  // Elastic has no energy mode: the note replaces the ridgeline and offers
  // the angle data instead.
  await page.fill('.filter-input[data-column=reaction]', 'elastic');
  await page.waitForSelector('#rows tr[data-id="endf-b8.1:Fe56:2"]');
  await page.click('label[for=mode-energy]');
  await page.click('#rows tr[data-id="endf-b8.1:Fe56:2"]');
  await page.waitForFunction(() => !document.getElementById('ridge-note').classList.contains('d-none'), null, { timeout: 120000 });
  const emptyNote = (await page.textContent('#ridge-note')).trim();
  check(emptyNote.startsWith('This reaction has no outgoing energy data, but it does have angle data.'),
    `elastic in energy mode says the angle data is there: ${emptyNote}`);
  await page.screenshot({ path: `${SHOTS}empty-energy.png`, fullPage: true });
  await page.click('#ridge-note-toggle');
  await waitTraces('ridgeline', 10);
  check(await page.isChecked('#mode-angle') && await page.isHidden('#ridge-note'),
    'its Toggle to angle data button switches to angle mode and draws the ridgeline');

  // Every example plot draws the curves its link names.
  const examples = await page.$$eval('#examples a', (as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent })));
  for (const ex of examples) {
    const params = new URLSearchParams(ex.href.slice(1));
    const want = (params.get('s') ?? params.get('a') ?? '').split(';').filter(Boolean).length;
    await page.goto(`${BASE}${ex.href}`);
    await waitTraces('selected', want, 240000);
    await waitTraces('ridgeline', 1, 240000);
    const notice = await page.textContent('#notice');
    const error = await page.textContent('#error');
    check(await traces('selected') === want && !error.trim() && !notice.trim(),
      `example ${ex.text.trim()} draws ${want} curves with no error or snapping notice`);
    const libraries = [...new Set([params.get('v'), ...(params.get('s') ?? params.get('a') ?? '').split(';')].filter(Boolean).map((t) => t.split(':')[0]))];
    await waitCited(libraries);
    check(true, `example ${ex.text.trim()} lists ${(await cited()).join(', ')} first in the citations`);
    await page.screenshot({ path: `${SHOTS}example-${ex.text.match(/\d/)[0]}.png`, fullPage: true });
  }
  check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.join(' | ')}` : ''}`);
} catch (err) {
  await page.screenshot({ path: `${SHOTS}failure.png`, fullPage: true });
  console.error(err.message);
  if (consoleErrors.length) console.error('console:', consoleErrors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
