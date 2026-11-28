// The downloads: every curve carries its provenance and what to cite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curvesToJson, curvesToCsv } from '../download.js';
import { citationsFor, termsFor } from '../citations.js';

const curve = (library, mode) => ({
  nuclide: 'Fe56', library, release: '2026-11-13', mt: 16, reaction: '(n,2n)', emission: 'prompt',
  mode, frame: 'laboratory frame', incident_energy_eV: 14e6,
  x: new Float64Array([1, 2]), p: new Float64Array([0.5, 0.5]),
});

test('each JSON curve carries the citations and terms of its library', () => {
  const out = JSON.parse(curvesToJson([curve('jendl-5.0', 'energy'), curve('jeff-4.0', 'angle')]));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].citations, citationsFor('jendl-5.0'));
  assert.equal(out[0].citations[0].doi, '10.1080/00223131.2022.2141903');
  assert.equal(out[0].terms, termsFor('jendl-5.0'));
  assert.match(out[1].terms, /CC BY 4\.0/);
  assert.deepEqual(out[1].citations.map((c) => c.doi), ['10.82555/e9ajn-a3p20']);
  assert.deepEqual(out[0].x, [1, 2]);
  assert.equal(out[1].quantity, 'angular distribution');
});

test('every CSV row ends with the DOI links of its library', () => {
  const lines = curvesToCsv([curve('endf-b8.1', 'energy'), curve('tendl-2025', 'angle')]).trim().split('\n');
  const header = lines[0].split(',');
  assert.equal(header.at(-1), 'cite');
  assert.equal(lines.length, 5);
  // Split on commas outside quotes: the reaction, "(n,2n)", holds one.
  const fields = (line) => line.match(/("[^"]*"|[^,]*)(,|$)/g).filter((f) => f !== '').length;
  for (const line of lines.slice(1)) assert.equal(fields(line), header.length, line);
  assert.ok(lines[1].endsWith(',1/eV,https://doi.org/10.1016/j.nds.2026.04.001 https://doi.org/10.11578/endf/2571019'));
  assert.ok(lines[4].endsWith(',1/unit cosine,https://doi.org/10.1016/j.nds.2012.11.002 https://doi.org/10.1016/j.nds.2019.01.002'));
});
