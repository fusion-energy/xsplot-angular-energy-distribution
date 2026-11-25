// Decoding the published Arrow files, in the worker and under Node.
//
// Every section is Arrow IPC with LZ4-frame compressed record batch bodies.
// apache-arrow reads those once a codec is registered for the compression
// type. The same reader accepts a whole file (ARROW1 magic and a footer) and a
// spliced stream (schema, batches, EOS), sniffing which it was given.
//
// The decoder is built from the two libraries rather than importing them here,
// so the worker can pass the vendored builds and the tests the npm packages.
// The same shape as nuclide_cross_section_plotter's `arrow.js`, plus `row`,
// which turns one row into a plain object so the distribution maths in
// `distributions.js` never sees Arrow at all.

/// Build the decoder. `arrow` is the apache-arrow module, `lz4Decompress` a
/// function from LZ4 frame bytes to the decompressed bytes.
export function createArrowDecoder(arrow, lz4Decompress) {
  const { compressionRegistry, CompressionType, RecordBatchReader } = arrow;
  compressionRegistry.set(CompressionType.LZ4_FRAME, {
    decode: (bytes) => lz4Decompress(bytes),
  });

  /// Every record batch in `bytes`, whole file or spliced stream.
  function readBatches(bytes) {
    return [...RecordBatchReader.from(bytes)];
  }

  /// One cell as plain JavaScript: a list becomes a typed array (Float64Array
  /// for f64, Int32Array for i32) or an array of strings, a null stays null.
  function cell(batch, name, row) {
    const vector = batch.getChild(name);
    if (!vector) return null;
    const v = vector.get(row);
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && typeof v.toArray === 'function') {
      const a = v.toArray();
      return ArrayBuffer.isView(a) ? a.slice() : Array.from(a);
    }
    if (typeof v === 'bigint') return Number(v);
    return v;
  }

  /// One row as `{column: value}` over every column of the batch.
  function row(batch, index) {
    const out = {};
    for (const field of batch.schema.fields) out[field.name] = cell(batch, field.name, index);
    return out;
  }

  /// Every row of every batch whose `column` equals `value`.
  function rowsWhere(batches, column, value) {
    const out = [];
    for (const batch of batches) {
      const vector = batch.getChild(column);
      if (!vector) continue;
      for (let i = 0; i < batch.numRows; i++) if (vector.get(i) === value) out.push(row(batch, i));
    }
    return out;
  }

  return { readBatches, cell, row, rowsWhere };
}
