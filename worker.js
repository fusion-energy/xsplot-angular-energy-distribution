// Web Worker hosting the data engine.
//
// The page never decodes anything itself: a nuclide's distributions are
// megabytes of LZ4-compressed Arrow, and turning them into tables would stall
// the page. Requests carry a requestId and get exactly one reply with the same
// id (plus any number of progress messages); typed arrays cross as
// transferred buffers.
//
//   in  {type: 'index', requestId, library}
//   out {type: 'index', requestId, index}
//   in  {type: 'view', requestId, library, name, mt, delayed}
//   out {type: 'progress', requestId, loaded, total}
//   out {type: 'view', requestId, view}
//   out {type: 'error', requestId, error}
// A single {type: 'ready'} is posted once the libraries have loaded.

import { arrow, lz4Decompress } from './deps.browser.js';
import { createArrowDecoder } from './arrow.js';
import { createEngine } from './engine.js';

const decoder = createArrowDecoder(arrow, lz4Decompress);
const engine = createEngine({ decoder });

/// Every buffer under the tables of a view, to transfer rather than copy.
function buffersOf(view) {
  const out = [];
  for (const mode of [view.energy, view.angle]) for (const t of mode.tables) out.push(t.x.buffer, t.p.buffer);
  return out;
}

self.postMessage({ type: 'ready' });

self.onmessage = async (event) => {
  const { type, requestId } = event.data ?? {};
  try {
    switch (type) {
      case 'index': {
        const index = await engine.loadIndex(event.data.library);
        self.postMessage({ type: 'index', requestId, index });
        break;
      }
      case 'view': {
        const { library, name, mt, delayed } = event.data;
        let last = 0;
        const onProgress = (loaded, total) => {
          const now = Date.now();
          if (now - last < 100 && loaded < total) return;
          last = now;
          self.postMessage({ type: 'progress', requestId, loaded, total });
        };
        const view = await engine.view(library, name, mt, delayed, onProgress);
        self.postMessage({ type: 'view', requestId, view }, buffersOf(view));
        break;
      }
      default:
        throw new Error(`unknown request type ${type}`);
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId, error: String(err?.message ?? err) });
  }
};
