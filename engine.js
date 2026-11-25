// Fetching and decoding a nuclide's secondary-neutron data from the published
// Arrow directories.
//
// Each library is published as immutable releases under `<library>/<release>/`;
// `<library>/latest.json` names the current one and its `manifest.json`, which
// lists the byte size and sha256 of every file in the release. Both are read
// once per library per session, so every file the page shows comes from one
// release and is checked against the manifest before it is decoded: a wrong
// byte still frames as Arrow and would decode into wrong numbers.
//
// The distributions of a nuclide are in two sections of its directory:
// `products.arrow` (tens of kB: which particles each reaction emits, and their
// yields) and `distributions.arrow` (one record batch holding every
// distribution of every reaction, 15 MB for Fe56). Unlike the cross sections,
// `version.json` carries no byte-range index for these, so the whole of both is
// downloaded, once per nuclide, with progress reported as it arrives.
//
// What `reactions.arrow` says about the reaction (its label, Q value and
// whether its distributions are in the centre-of-mass frame) is read with one
// ranged request for that reaction's smallest record batch, using the index in
// `version.json`, as nuclide_cross_section_plotter does for cross sections.
//
// Nothing here touches the DOM or `self`; the same code runs in the worker and
// under Node.

import { LIBRARIES } from './libraries.js';
import { buildView, topEnergy } from './distributions.js';

export const ORIGIN = 'https://yamc-data.xsplot.com';
/// The release `format_version`s this page can read.
export const SUPPORTED_FORMAT_VERSIONS = Object.freeze([2]);
const KNOWN_LIBRARIES = new Set(LIBRARIES.map((l) => l.id));
/// The 8-byte Arrow end-of-stream marker.
const EOS = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
/// Decoded nuclides kept in memory (each is tens of MB once decompressed).
const NUCLIDE_CACHE = 2;

/// Lower-case hex sha256 of `bytes`.
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/// Build the engine around a decoder from `createArrowDecoder`.
export function createEngine({ origin = ORIGIN, fetchImpl = fetch, decoder }) {
  if (!decoder) throw new Error('createEngine needs a decoder');

  /// Per-library `latest.json` and manifest, as in-flight promises.
  const releases = new Map();
  const manifests = new Map();
  /// Decoded nuclides by `${library}/${name}`, least recently used first.
  const nuclides = new Map();

  function checkLibrary(library) {
    if (!KNOWN_LIBRARIES.has(library)) {
      throw new Error(`unknown library ${library}; one of ${[...KNOWN_LIBRARIES].join(', ')}`);
    }
  }

  /// Memoise an async load by key, forgetting it on failure so a transient
  /// network error does not poison it for the session.
  function memo(map, key, load) {
    if (!map.has(key)) map.set(key, load().catch((err) => { map.delete(key); throw err; }));
    return map.get(key);
  }

  async function getJson(target) {
    const resp = await fetchImpl(target);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} fetching ${target}`);
    return resp.json();
  }

  /// The current release of a library: its parsed `latest.json`.
  function ensureRelease(library) {
    checkLibrary(library);
    return memo(releases, library, async () => {
      const target = `${origin}/${library}/latest.json`;
      const latest = await getJson(target);
      if (latest?.schema !== 'yamc-data-latest' || typeof latest.release !== 'string' || !latest.release) {
        throw new Error(`${target} does not name a release`);
      }
      if (latest.keyword !== library) throw new Error(`${target} is for ${latest.keyword}, not ${library}`);
      if (!SUPPORTED_FORMAT_VERSIONS.includes(latest.format_version)) {
        throw new Error(`${library} release ${latest.release} is data format ${latest.format_version}; ` +
          `this page reads format ${SUPPORTED_FORMAT_VERSIONS.join(', ')}`);
      }
      return latest;
    });
  }

  /// The release manifest of a library as `Map(path -> {bytes, sha256})`,
  /// itself checked against the sha256 `latest.json` gives for it.
  function ensureManifest(library) {
    return memo(manifests, library, async () => {
      const latest = await ensureRelease(library);
      const target = `${origin}/${library}/${latest.manifest}`;
      const resp = await fetchImpl(target);
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} fetching ${target}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (latest.manifest_sha256) {
        const got = await sha256Hex(bytes);
        if (got !== latest.manifest_sha256) throw new Error(`${target} has sha256 ${got}, latest.json says ${latest.manifest_sha256}`);
      }
      const manifest = JSON.parse(new TextDecoder().decode(bytes));
      return new Map(manifest.files.map((f) => [f.path, f]));
    });
  }

  /// The published neutron index of a library: `{release, dataVersion,
  /// nuclides: {name: [mt...]}}`.
  async function loadIndex(library) {
    const latest = await ensureRelease(library);
    const index = await getJson(`${origin}/${library}/${latest.release}/neutron/index.json`);
    if (index?.format !== 1 || index.particle !== 'neutron') throw new Error(`${library} index.json is not a format 1 neutron index`);
    const nuclides = {};
    for (const [name, entry] of Object.entries(index.nuclides)) nuclides[name] = entry.mts;
    return { library, release: latest.release, dataVersion: index.data_version ?? null, nuclides };
  }

  /// Fetch one file of a release whole, reporting `(loaded, total)` as it
  /// arrives, and check it against the manifest.
  async function fetchVerified(library, path, onProgress) {
    const [latest, manifest] = await Promise.all([ensureRelease(library), ensureManifest(library)]);
    const entry = manifest.get(path);
    if (!entry) throw new Error(`${path} is not in the ${library} ${latest.release} release`);
    const target = `${origin}/${library}/${latest.release}/${path}`;
    const resp = await fetchImpl(target);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} fetching ${target}`);
    let bytes;
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      bytes = new Uint8Array(entry.bytes);
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.length > bytes.length) throw new Error(`${target} is longer than the ${entry.bytes} bytes the manifest gives`);
        bytes.set(value, loaded);
        loaded += value.length;
        onProgress?.(loaded, entry.bytes);
      }
      if (loaded !== entry.bytes) throw new Error(`${target} came back ${loaded} bytes, the manifest gives ${entry.bytes}`);
    } else {
      bytes = new Uint8Array(await resp.arrayBuffer());
      onProgress?.(bytes.length, entry.bytes);
    }
    const got = await sha256Hex(bytes);
    if (got !== entry.sha256) throw new Error(`${target} has sha256 ${got}, the manifest says ${entry.sha256}`);
    return bytes;
  }

  /// The decoded products and distributions of a nuclide, cached.
  ///
  /// `onProgress(loaded, total)` covers both files together.
  async function ensureNuclide(library, name, onProgress) {
    checkLibrary(library);
    const key = `${library}/${name}`;
    if (nuclides.has(key)) {
      const hit = nuclides.get(key);
      nuclides.delete(key);
      nuclides.set(key, hit);
      return hit;
    }
    const manifest = await ensureManifest(library);
    const productsPath = `neutron/${name}.arrow/products.arrow`;
    const distributionsPath = `neutron/${name}.arrow/distributions.arrow`;
    if (!manifest.has(productsPath) || !manifest.has(distributionsPath)) {
      throw new Error(`${name} in ${library} publishes no secondary distributions`);
    }
    const total = manifest.get(productsPath).bytes + manifest.get(distributionsPath).bytes;
    const progress = [0, 0];
    const report = (i) => (loaded) => { progress[i] = loaded; onProgress?.(progress[0] + progress[1], total); };
    const loading = Promise.all([
      fetchVerified(library, productsPath, report(0)),
      fetchVerified(library, distributionsPath, report(1)),
    ]).then(([p, d]) => {
      const products = decoder.readBatches(p);
      const distributions = decoder.readBatches(d);
      return { library, name, products, distributions };
    });
    nuclides.set(key, loading);
    loading.catch(() => nuclides.delete(key));
    while (nuclides.size > NUCLIDE_CACHE) nuclides.delete(nuclides.keys().next().value);
    return loading;
  }

  /// What `reactions.arrow` says about one reaction: `{label, q, centerOfMass}`,
  /// or null when it cannot be read with a small range request.
  async function reactionMeta(library, name, mt) {
    const latest = await ensureRelease(library);
    const base = `${origin}/${library}/${latest.release}/neutron/${name}.arrow`;
    const vresp = await fetchImpl(`${base}/version.json`);
    if (!vresp.ok) return null;
    const version = await vresp.json();
    const index = version?.reaction_ranges;
    const byTemperature = index?.mts?.[String(mt)];
    if (!index?.schema || !byTemperature) return null;
    // Any temperature says the same about the frame and Q; take the smallest.
    const entries = Object.values(byTemperature).filter((e) => Array.isArray(e) && e.length === 3);
    if (!entries.length) return null;
    const batch = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
    const parts = [index.schema, batch];
    const bodies = [];
    for (const [off, length, sha] of parts) {
      const controller = new AbortController();
      const resp = await fetchImpl(`${base}/reactions.arrow`, {
        headers: { Range: `bytes=${off}-${off + length - 1}` }, signal: controller.signal,
      });
      // A whole 40 MB object in place of the slice is not worth reading for
      // three scalars: the page goes without them.
      if (resp.status !== 206) { controller.abort(); return null; }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length !== length || (await sha256Hex(bytes)) !== sha) return null;
      bodies.push(bytes);
    }
    const stream = new Uint8Array(bodies[0].length + bodies[1].length + EOS.length);
    stream.set(bodies[0], 0);
    stream.set(bodies[1], bodies[0].length);
    stream.set(EOS, bodies[0].length + bodies[1].length);
    const [b] = decoder.readBatches(stream);
    return {
      label: decoder.cell(b, 'label', 0),
      q: decoder.cell(b, 'Q_value', 0),
      centerOfMass: decoder.cell(b, 'center_of_mass', 0),
    };
  }

  /// The distributions of one reaction's outgoing neutrons.
  ///
  /// `delayed` picks the delayed-neutron groups of a fission reaction rather
  /// than the prompt neutron. Returns `{library, release, dataVersion, name,
  /// mt, delayed, law, groups, label, q, centerOfMass, energy, angle}`, the
  /// last two as `distributions.js` describes them.
  async function view(library, name, mt, delayed, onProgress) {
    const [latest, nuclide, meta] = await Promise.all([
      ensureRelease(library),
      ensureNuclide(library, name, onProgress),
      reactionMeta(library, name, mt).catch(() => null),
    ]);
    const products = decoder.rowsWhere(nuclide.products, 'reaction_mt', mt)
      .filter((p) => p.particle === 'neutron' && (delayed ? p.emission_mode === 'delayed' : p.emission_mode !== 'delayed'));
    if (!products.length) {
      throw new Error(`${name} ${delayed ? 'delayed' : ''} MT ${mt} in ${library} has no outgoing neutron distribution`.replace('  ', ' '));
    }
    const distributions = decoder.rowsWhere(nuclide.distributions, 'reaction_mt', mt);
    // A law with no incident grid of its own (n-body) runs to the top of the
    // nuclide's data, which elastic scattering always spans.
    const emax = topEnergy(distributions.some((r) => r.type !== 'nbody') || mt === 2
      ? distributions : decoder.rowsWhere(nuclide.distributions, 'reaction_mt', 2));
    const v = buildView(products, distributions, emax);
    return {
      library, release: latest.release, dataVersion: latest.release, name, mt, delayed,
      label: meta?.label ?? null, q: meta?.q ?? null, centerOfMass: meta?.centerOfMass ?? null,
      ...v,
    };
  }

  return { ensureRelease, ensureManifest, loadIndex, ensureNuclide, reactionMeta, view };
}
