# Neutron angle and energy distribution plotter

Where the neutrons from a nuclear reaction go, and how fast. For any reaction
that emits neutrons, in any of six evaluated nuclear data libraries, the page
plots the probability density of the outgoing neutron's energy, or of the
cosine of its scattering angle, at each incident energy the evaluation
tabulates. A sister of the
[nuclide cross section plotter](https://github.com/fusion-energy/nuclide_cross_section_plotter.rs)
and [materials_for_mc_online](https://github.com/shimwell/materials_for_mc_online)
on [xsplot.com](https://xsplot.com), and built the same way: a static site with
no build step, plain JavaScript modules, Bootstrap and Plotly, every file it
loads served from this repository.

## Using it

1. **Pick a reaction** in the table: filter by element, mass number, reaction
   (`n,2n`, `elastic`, `fission`) or MT, and choose which libraries are listed.
   Only reactions that emit neutrons are listed. Fission is listed twice, for
   its prompt and its delayed neutrons.
2. **Pick incident energies** on the ridgeline: one ridge per tabulated incident
   energy, placed at that energy on a log axis and scaled to its own peak, so
   it shows how the shape changes. Click a ridge to add it to the panel on the
   right, click again to remove it, or type an energy to add the nearest
   tabulated one. Switch between **Outgoing energy** and **Angle**; each mode
   keeps its own selection.
3. **Read values** off the selected panel, which plots the true probability
   density (per eV or MeV, or per unit cosine). Curves from different nuclides,
   reactions and libraries share it: pick a reaction in the table again and
   keep adding. Download what is drawn as JSON or CSV.

Everything is in the URL hash, so any plot can be sent as a link:

```
#v=endf-b8.1:Fe56:16&s=endf-b8.1:Fe56:16:14000000;jeff-4.0:Fe56:16:14000000&e=MeV
```

`v` is the reaction on the ridgeline, `s` and `a` the selected curves of the
energy and angle modes (`library:nuclide:MT:incident energy in eV`, the MT
followed by `d` for delayed fission neutrons), `m=angle` the mode, and `x`,
`y`, `e`, `n` and `l` the axes, energy unit, number of ridges and the libraries
listed. See `url_state.js`.

## What is drawn

The distributions are read from each nuclide's `products.arrow` and
`distributions.arrow`, the same files the
[yamc](https://github.com/fusion-neutronics/yamc-and-yani) Monte Carlo code
samples from, and unpacked the way its reader
(`crates/yamc-nuclide/src/arrow/nuclide_arrow.rs`) does:

| Law in the data | Outgoing energy | Angle |
| --- | --- | --- |
| uncorrelated, tabulated energy | the tables | the tables, or isotropic |
| uncorrelated, discrete level (MT 51 to 90) | a single value; the formula is shown | the tables |
| uncorrelated, no energy law (elastic) | none; the angle sets it | the tables |
| uncorrelated, Maxwell / evaporation / Watt | computed from the tabulated parameters | the tables, or isotropic |
| correlated angle-energy | the tables | averaged over outgoing energy |
| Kalbach-Mann | the tables | from r and a, averaged over outgoing energy |
| n-body phase space | computed from the law | isotropic |

Densities are normalised to one. Discrete lines inside a continuous table are
left out and counted in the notes above the ridgeline. Delayed fission
neutrons are the precursor groups summed, weighted by their yields. The frame
(centre-of-mass or laboratory) is read from the reaction's `center_of_mass`
flag in `reactions.arrow` and shown in the notes and on the angle axis.
Incident energies are the tabulated ones; nothing is interpolated between
them.

## Where the data comes from

The Arrow files published at
`https://yamc-data.xsplot.com/<library>/<release>/neutron/<Nuclide>.arrow/`.
Each library is published as immutable releases; `<library>/latest.json` names
the current one and its `manifest.json`, which gives the size and sha256 of
every file. The page reads both once per library and checks every file it
downloads against the manifest.

The table is built from each library's `index.json`. A nuclide's
distributions are one record batch with no byte-range index, so the first
reaction picked from a nuclide downloads its whole `distributions.arrow` (15 MB
for Fe56, much less for most), with a progress bar; every other reaction of
that nuclide is then free. The reaction's label, Q value and frame come from
one HTTP range request into `reactions.arrow`, using the index in
`version.json`.

Libraries: ENDF/B-VIII.1, JEFF-4.0, JENDL-5.0, TENDL-2025, TENDL-2017 and
FENDL-3.2d.

## Files

- `index.html`, `style.css`, `app.js`: the page and its controller
- `worker.js`: Web Worker that fetches and decodes; `deps.browser.js` names the vendored builds it uses
- `engine.js`: releases, manifests, checked downloads and the range request for reaction metadata
- `arrow.js`: Arrow decoding; `distributions.js`: the distribution laws, as tables
- `reactions.js`: which reactions emit neutrons; `table.js`: the reaction table
- `ridgeline.js`, `plot.js`: the two figures; `url_state.js`, `download.js`: the link and the exports
- `libraries.js`, `mt_names.js`, `elements.js`: copied from nuclide_cross_section_plotter
- `vendor/`: Bootstrap, Plotly, apache-arrow and lz4js at pinned versions
- `tests/`: Node unit tests and a Playwright end-to-end run

## Running locally

```bash
python3 -m http.server 8000
```

then open [http://localhost:8000](http://localhost:8000). The page fetches its
data from the network.

## Tests

```bash
npm ci
npm test                 # the distribution laws, table, URL and ridgeline, no network
npx playwright install chromium
python3 -m http.server 8000 &
node tests/e2e.mjs       # drives the page in headless Chromium against the published data
```

## Browser support

The page uses a module Web Worker: Chrome and Edge 80+, Firefox 114+, Safari 15+.
