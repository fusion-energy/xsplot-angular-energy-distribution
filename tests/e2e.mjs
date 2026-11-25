// Drive the page in headless Chromium against the published data.
//
//   python3 -m http.server 8000 &
//   node tests/e2e.mjs [--url http://127.0.0.1:8000/]
//
// Filters the table to Fe56 (n,2n), shows it, picks a ridge by clicking the
// ridgeline and another by typing an energy, switches to angle mode, then opens
// every example plot and checks it draws the curves its link names. Writes
// screenshots to tests/screenshots/. A failure that names a fetch rather than
// an assertion is the data host, not the page.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

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
const waitTraces = (id, n, timeout = 120000) =>
  page.waitForFunction(([i, k]) => (document.getElementById(i).data?.length ?? 0) >= k, [id, n], { timeout });

try {
  await page.goto(BASE);
  await page.waitForSelector('#rows tr[data-id]', { timeout: 60000 });
  check(true, 'the reaction table loads');

  await page.fill('.filter-input[data-column=element]', 'Fe');
  await page.fill('.filter-input[data-column=nucleons]', '56');
  await page.fill('.filter-input[data-column=reaction]', 'n,2n');
  await page.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length > 0
    && [...document.querySelectorAll('#rows tr[data-id]')].every((tr) => tr.dataset.id.includes(':Fe56:16')));
  const ids = await page.$$eval('#rows tr[data-id]', (trs) => trs.map((t) => t.dataset.id));
  check(ids.includes('endf-b8.1:Fe56:16'), `filters narrow to Fe56 (n,2n): ${ids.join(', ')}`);

  await page.click('#rows tr[data-id="endf-b8.1:Fe56:16"]');
  await waitTraces('ridgeline', 10);
  const ridges = await traces('ridgeline');
  check(ridges >= 30, `the ridgeline draws ${ridges} ridges for Fe56 (n,2n)`);
  check(await hashHas('v=endf-b8.1:Fe56:16'), 'the URL names the ridgeline');

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

  await page.click('label[for=mode-angle]');
  await waitTraces('ridgeline', 10);
  check(await traces('selected') === 0, 'angle mode has its own, empty, selection');
  await page.fill('#ein-value', '14');
  await page.click('#ein-form button[type=submit]');
  await waitTraces('selected', 1);
  check(await hashHas('m=angle', 'a=endf-b8.1:Fe56:16:14000000'), 'angle selection is in the URL');
  await page.screenshot({ path: `${SHOTS}angle.png`, fullPage: true });

  // Elastic has no energy mode: the note replaces the ridgeline.
  await page.fill('.filter-input[data-column=reaction]', 'elastic');
  await page.waitForSelector('#rows tr[data-id="endf-b8.1:Fe56:2"]');
  await page.click('label[for=mode-energy]');
  await page.click('#rows tr[data-id="endf-b8.1:Fe56:2"]');
  await page.waitForFunction(() => !document.getElementById('ridge-note').classList.contains('d-none'), null, { timeout: 120000 });
  check((await page.textContent('#ridge-note')).includes('elastic'), 'elastic in energy mode explains why there is nothing to draw');

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
