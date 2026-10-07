// Preloaded with --import during a FULL green run when test.import_graph is on.
// Records every file each process loads; lib/import-graph.mjs aggregates the records.
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = process.env.TURBO_GRAPH_DIR;
if (dir) {
  if (typeof module.registerHooks !== 'function') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'unsupported'), process.version);
  } else {
    const seen = new Set();
    // synchronous hooks see import and require alike
    module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const r = nextResolve(specifier, context);
        if (typeof r?.url === 'string' && r.url.startsWith('file:')) seen.add(fileURLToPath(r.url));
        return r;
      },
    });
    process.on('exit', () => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ entry: process.argv[1] ? path.resolve(process.argv[1]) : null, files: [...seen] }));
      } catch {
        // a missing record only means the next run is full
      }
    });
  }
}
