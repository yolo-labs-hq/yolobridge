import { mkdir } from 'node:fs/promises';
import { buildWorker } from './build-worker.mjs';

const dist = new URL('./dist/', import.meta.url);
// The Host bundle shape wants an assets dir; this site has no static assets.
await mkdir(new URL('assets/', dist), {recursive: true});
await buildWorker(dist);
console.log('[yolobridge-sh] wrote dist/worker.mjs');
