import { mkdir } from 'node:fs/promises';
import { buildWorker } from './build-worker.mjs';
// Google Analytics tag for the landing page, from config/analytics.json (see
// scripts/analytics/). The public mirror has no scripts/analytics: no tag there.
// GA_MEASUREMENT_ID overrides the file; GA_MEASUREMENT_ID=off builds without it.
async function analyticsHtml(site) {
  if (process.env.GA_MEASUREMENT_ID === 'off') return '';
  let mod;
  try { mod = await import('../scripts/analytics/head-html.mjs'); } catch { return ''; }
  return mod.analyticsHeadHtml(site);
}

const dist = new URL('./dist/', import.meta.url);
// The Host bundle shape wants an assets dir; this site has no static assets.
await mkdir(new URL('assets/', dist), {recursive: true});
await buildWorker(dist, {analyticsHtml: await analyticsHtml('yolobridge')});
console.log('[yolobridge-sh] wrote dist/worker.mjs');
