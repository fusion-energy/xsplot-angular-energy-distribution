// Downloading the selected curves, as JSON or CSV.
//
// One object (or one block of rows) per curve, each carrying its own
// provenance: library and release, reaction, incident energy, frame and units,
// so a file can be read a year later without the page.

/// `curves`: array of {nuclide, library, release, mt, reaction, emission,
/// mode, frame, incident_energy_eV, x, p} with x and p typed arrays.
export function curvesToJson(curves) {
  const out = curves.map((c) => ({
    nuclide: c.nuclide,
    library: c.library,
    release: c.release,
    mt: c.mt,
    reaction: c.reaction,
    emission: c.emission,
    quantity: c.mode === 'energy' ? 'outgoing energy distribution' : 'angular distribution',
    frame: c.frame,
    incident_energy_eV: c.incident_energy_eV,
    x_name: c.mode === 'energy' ? 'outgoing_energy_eV' : 'cosine',
    probability_density_units: c.mode === 'energy' ? '1/eV' : '1/unit cosine',
    x: Array.from(c.x),
    probability_density: Array.from(c.p),
  }));
  return JSON.stringify(out, null, 1);
}

/// Long-form CSV: one row per point, the curve columns repeated.
export function curvesToCsv(curves) {
  const lines = ['nuclide,library,release,mt,reaction,emission,quantity,frame,incident_energy_eV,x_name,x,probability_density,probability_density_units'];
  for (const c of curves) {
    const energy = c.mode === 'energy';
    const head = [
      c.nuclide, c.library, c.release, c.mt, `"${c.reaction}"`, c.emission,
      energy ? 'outgoing energy distribution' : 'angular distribution', c.frame ?? '', c.incident_energy_eV,
      energy ? 'outgoing_energy_eV' : 'cosine',
    ].join(',');
    const units = energy ? '1/eV' : '1/unit cosine';
    for (let i = 0; i < c.x.length; i++) lines.push(`${head},${c.x[i]},${c.p[i]},${units}`);
  }
  return lines.join('\n') + '\n';
}

/// Save text as a file through a temporary link (browser only).
export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
