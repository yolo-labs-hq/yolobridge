import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Renders the Worker from install.sh, landing.html and icons/. Shared by the
// build and the tests. Same shape as yolostart-sh/build-worker.mjs, minus the
// release assets: yolo-bridge itself ships through npm, so this site serves only
// the installer, the landing page and its icons.
export async function buildWorker(outputDirectory) {
  const script = await readFile(new URL('./install.sh', import.meta.url), 'utf8');
  const banner = script.match(/cat <<'BANNER'\n([\s\S]*?)\nBANNER\n/)?.[1];
  if (!banner) throw Error('Installer banner missing');
  const template = await readFile(new URL('./landing.html', import.meta.url), 'utf8');
  for (const slot of ['<!-- INSTALL_BANNER -->', '<!-- OCTOPUS_SVG -->', '<!-- ICON_SVG -->']) {
    if (template.split(slot).length !== 2) throw Error(`Landing slot ${slot} missing or duplicated`);
  }
  const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const svg = await readFile(new URL('./icons/octopus.svg', import.meta.url), 'utf8');
  // The same octopus, inline as the page's mark: drop the XML prolog and mark it
  // decorative (the wordmark beside it carries the name).
  const octopus = svg.replace(/^<\?xml[^>]*>\s*/, '').replace('<svg ', '<svg class="mark" aria-hidden="true" focusable="false" ');
  const landing = template.replace('<!-- INSTALL_BANNER -->', () => escapeHtml(banner))
    .replace('<!-- OCTOPUS_SVG -->', () => octopus)
    .replace('<!-- ICON_SVG -->', () => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
  const icons = {};
  for (const [path, type] of [['favicon.ico', 'image/x-icon'], ['apple-touch-icon.png', 'image/png'], ['og.png', 'image/png']]) {
    icons['/' + path] = {type, bytes: (await readFile(new URL('./icons/' + path, import.meta.url))).toString('base64')};
  }
  await mkdir(outputDirectory, {recursive: true});
  await writeFile(
    new URL('worker.mjs', outputDirectory),
  `// Generated from install.sh and landing.html; do not edit.
const script = ${JSON.stringify(script)};
const landing = ${JSON.stringify(landing)};
const icons = ${JSON.stringify(icons)};
export default { fetch(request) {
  const url = new URL(request.url);
  if (icons[url.pathname]) {
    const icon = icons[url.pathname];
    return new Response(Uint8Array.from(atob(icon.bytes), c => c.charCodeAt(0)), {headers:{'Content-Type':icon.type, 'Cache-Control':'public, max-age=86400', 'X-Content-Type-Options':'nosniff'}});
  }
  if (url.pathname !== '/' && url.pathname !== '/install.sh') return new Response('Not found', {status:404});
  // A browser gets the landing page; curl (and anything else) gets the exact
  // installer bytes. /install.sh and /?raw always serve the script.
  const isBrowser = request.headers.get('sec-fetch-dest') === 'document'
    || (request.headers.get('accept') ?? '').includes('text/html');
  // Link-preview and search crawlers need the HTML (its og:/twitter: tags), but
  // most send Accept: */* like curl. A narrow allow-list of their user agents
  // gets the landing page; curl, wget and every other client still get the
  // exact installer. Backslash-free on purpose: this source is emitted through
  // a template literal.
  const isPreviewBot = /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|linkedinbot|discordbot|telegrambot|whatsapp|skypeuripreview|iframely|embedly|pinterest|redditbot|applebot|googlebot|google-inspectiontool|bingbot|duckduckbot|yandexbot|mastodon|bluesky|cardyb|vkshare/i.test(request.headers.get('user-agent') ?? '');
  const html = url.pathname === '/' && !url.searchParams.has('raw') && (isBrowser || isPreviewBot);
  return new Response(html ? landing : script, {headers:{
    'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Vary': 'Accept, Sec-Fetch-Dest, User-Agent',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }});
} };
`,
  );
}
