// Regenerates the icon PNGs from store/icon.svg and takes the Chrome Web Store
// screenshots (1280x800, 24-bit PNG) of the real extension on the real site.
//
//   cd test && npm install && npx playwright install chromium && npm run assets
import { chromium } from 'playwright';
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const store = path.join(root, 'store');
const build = path.join(here, 'build-store');
const profile = path.join(here, '.profile-store');

const BLOCKED_VIDEO = 'dQw4w9WgXcQ';
const BLOCKED_CHANNEL = 'UC4QobU6STFB0P71PMvOGN5A';
const CHANNEL_VIDEO = 'jNQXAC9IVRw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Icons. The 128px file keeps the 16px transparent margin the Web Store asks for.
const svg = readFileSync(path.join(store, 'icon.svg'), 'utf8');
const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const browser = await chromium.launch();
for (const [size, pad] of [[16, 0], [48, 0], [128, 16]]) {
  const art = size - pad * 2;
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{position:absolute;left:${pad}px;top:${pad}px;width:${art}px;height:${art}px}</style><img src="${dataUrl}">`);
  const png = await page.screenshot({ omitBackground: true });
  writeFileSync(path.join(root, 'extension', 'icons', `${size}.png`), png);
  if (size === 128) writeFileSync(path.join(store, 'icon-128.png'), png);
  await page.close();
}
await browser.close();

// ---- Screenshots, using a fixture policy in place of managed storage.
rmSync(build, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
cpSync(path.join(root, 'extension'), build, { recursive: true });
const fixture = { blockedVideos: [BLOCKED_VIDEO], blockedChannels: [BLOCKED_CHANNEL] };
appendFileSync(path.join(build, 'policy.js'), `\nYTB.readManagedPolicy = async () => (${JSON.stringify(fixture)});\n`);
mkdirSync(store, { recursive: true });

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required']
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const blockedPage = `chrome-extension://${new URL(worker.url()).host}/blocked.html`;
// Channel resolution needs a network round trip before the rules are complete.
for (let i = 0; i < 40; i++) {
  if ((await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length === 2) break;
  await sleep(500);
}

const page = await context.newPage();

// 1. A video from a blocked channel, in place of the player.
await page.goto(`https://www.youtube.com/watch?v=${CHANNEL_VIDEO}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('.ytb-overlay')?.isConnected && document.documentElement.classList.contains('ytb-blocked'), null, { timeout: 30000 });
await sleep(3000);
await page.screenshot({ path: path.join(store, 'screenshot-1-blocked-video.png') });

// 2. A blocked video embedded on an ordinary web page.
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><html lang="en-AU"><meta charset="utf-8"><title>Class resources</title>
<style>
  body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#222;background:#f6f7f9}
  header{background:#1a4d8f;color:#fff;padding:18px 48px;font-size:20px;font-weight:600}
  main{max-width:760px;margin:32px auto;padding:0 24px}
  h1{font-size:28px;margin:0 0 8px} p{color:#555}
  iframe{display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:12px;margin:24px 0;background:#000}
</style>
<header>Class resources</header>
<main><h1>Week 4: Watch and discuss</h1><p>Watch the clip below, then write three questions you would ask the presenter.</p>
<iframe src="https://www.youtube-nocookie.com/embed/${BLOCKED_VIDEO}" allowfullscreen></iframe>
<p>Discuss your questions with the person next to you before we share as a class.</p></main></html>`);
}).listen(0);
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'load' });
for (let i = 0; i < 40 && !page.frames().some((f) => f.url().startsWith(blockedPage)); i++) await sleep(250);
await sleep(500);
await page.screenshot({ path: path.join(store, 'screenshot-2-blocked-embed.png') });

server.close();
await context.close();
console.log('icons written to extension/icons and store/, screenshots written to store/');
