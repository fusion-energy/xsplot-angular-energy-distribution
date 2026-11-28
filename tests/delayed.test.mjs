import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delayedNeutronMts } from '../engine.js';
import { dropMissingDelayed } from '../table.js';
import { LIBRARIES } from '../libraries.js';

test('the delayed-neutron MTs are the reactions with a delayed neutron product', () => {
  assert.deepEqual(delayedNeutronMts([
    { reaction_mt: 20, particle: 'neutron', emission_mode: 'delayed' },
    { reaction_mt: 19, particle: 'neutron', emission_mode: 'delayed' },
    { reaction_mt: 19, particle: 'neutron', emission_mode: 'delayed' },
    { reaction_mt: 18, particle: 'neutron', emission_mode: 'prompt' },
    { reaction_mt: 18, particle: 'photon', emission_mode: 'delayed' },
  ]), [19, 20]);
  assert.deepEqual(delayedNeutronMts([]), []);
});

test('delayed rows are dropped only for nuclides checked and found without the data', () => {
  const rows = [
    { lib: 0, name: 'U240', mt: 18, delayed: false },
    { lib: 0, name: 'U240', mt: 18, delayed: true },
    { lib: 0, name: 'U240', mt: 19, delayed: true },
    { lib: 0, name: 'U235', mt: 18, delayed: true },
  ];
  assert.equal(dropMissingDelayed(rows, new Map()), rows);
  const known = new Map([[`${LIBRARIES[0].id}/U240`, new Set([19])]]);
  const kept = dropMissingDelayed(rows, known).map((r) => `${r.name}:${r.mt}${r.delayed ? 'd' : ''}`);
  assert.deepEqual(kept, ['U240:18', 'U240:19d', 'U235:18d']);
});
