import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { buildWorker } from '../build-worker.mjs';

const out = new URL('../.test-dist/worker/', import.meta.url);
await rm(out, {recursive: true, force: true});
await buildWorker(out);
const worker = (await import(new URL('worker.mjs', out))).default;
const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
const get = (path, headers = {}) => worker.fetch(new Request('https://yolobridge.sh' + path, {headers}));
const browser = {accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document'};

test('curl gets the exact installer bytes', async () => {
  const response = await get('/', {accept: '*/*'});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await response.text(), script);
});

test('a browser gets the landing page with the command, banner and repo link', async () => {
  const response = await get('/', browser);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await response.text();
  assert.match(html, /curl -fsSL https:\/\/yolobridge\.sh \| sh/);
  assert.match(html, /npm install -g @yolo-labs\/yolobridge/);
  assert.match(html, /github\.com\/yolo-labs-hq\/yolobridge/);
  assert.match(html, /YOUR AGENT JOINS THE WORKSPACE/);
  assert.doesNotMatch(html, /<!-- (INSTALL_BANNER|OCTOPUS_SVG|ICON_SVG) -->/);
  assert.doesNotMatch(html, /yolostart\.sh \| sh|npx yolostart/);
});

test('/install.sh and /?raw serve the script even to a browser', async () => {
  for (const path of ['/install.sh', '/?raw']) assert.equal(await (await get(path, browser)).text(), script);
});

test('responses vary on the negotiation headers and are never cached', async () => {
  const response = await get('/', browser);
  assert.equal(response.headers.get('vary'), 'Accept, Sec-Fetch-Dest, User-Agent');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('ordinary clients get the script; link-preview crawlers get the tagged page', async () => {
  for (const agent of ['curl/8.5.0', 'Wget/1.21', 'Mozilla/5.0', 'libcurl/8']) {
    assert.equal(await (await get('/', {'user-agent': agent, accept: '*/*'})).text(), script, agent);
  }
  for (const agent of ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Twitterbot/1.0', 'facebookexternalhit/1.1',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0)', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)']) {
    const response = await get('/', {'user-agent': agent, accept: '*/*'});
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', agent);
    const html = await response.text();
    assert.match(html, /<meta property="og:image" content="https:\/\/yolobridge\.sh\/og\.png">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/yolobridge\.sh\/">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/yolobridge\.sh\/">/);
  }
  assert.equal(await (await get('/install.sh', {'user-agent': 'Twitterbot/1.0'})).text(), script);
});

test('the social card is a 1200x630 PNG', async () => {
  const response = await get('/og.png');
  assert.equal(response.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, await readFile(new URL('../icons/og.png', import.meta.url)));
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
});

test('icons are served; anything else is 404', async () => {
  const icon = await get('/favicon.ico');
  assert.equal(icon.headers.get('content-type'), 'image/x-icon');
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()), await readFile(new URL('../icons/favicon.ico', import.meta.url)));
  assert.equal((await get('/releases/latest.txt')).status, 404);
});
