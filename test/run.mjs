// End-to-end check against the real YouTube site.
//
// Managed storage can only be populated through operating-system policy, so a
// copy of the extension is built in test/build with YTB.readManagedPolicy
// replaced by the fixture below. Everything else is the shipped code.
//
//   cd test && npm install && npm test
//
// Uses Playwright's Chromium (npx playwright install chromium): branded Google
// Chrome 137+ ignores --load-extension. Set HEADED=1 to watch the run.
import { chromium } from 'playwright';
import { cpSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'extension');
const build = path.join(here, 'build');
const profile = path.join(here, '.profile');
const shots = process.env.SHOTS || path.join(here, 'build', 'shots');

const BLOCKED_VIDEO = 'dQw4w9WgXcQ';              // Rick Astley, channel not blocked
const BLOCKED_CHANNEL = 'UC4QobU6STFB0P71PMvOGN5A'; // "jawed"
const CHANNEL_VIDEO = 'jNQXAC9IVRw';              // "Me at the zoo", on that channel
const ALLOWED_VIDEO = '9bZkp7q19f0';              // Gangnam Style

const fixture = {
  blockedVideos: [BLOCKED_VIDEO],
  blockedChannels: [BLOCKED_CHANNEL],
  blockMessage: 'Blocked by the test policy.'
};

rmSync(build, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
cpSync(src, build, { recursive: true });
mkdirSync(shots, { recursive: true });
appendFileSync(path.join(build, 'policy.js'), `\nYTB.readManagedPolicy = async () => (${JSON.stringify(fixture)});\n`);

const context = await chromium.launchPersistentContext(profile, {
  channel: process.env.CHANNEL || 'chromium',
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required']
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const blockedPage = `chrome-extension://${extId}/blocked.html`;
// Give the worker a moment to resolve channels and write its dynamic rules.
await worker.evaluate(() => new Promise((r) => setTimeout(r, 6000)));
const channelMap = await worker.evaluate(() => YTB.readChannelMap());
const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await page.evaluate(fn)) return true; } catch { /* navigating */ }
    await sleep(250);
  }
  return false;
}
const state = (page) => page.evaluate(() => ({
  blocked: document.documentElement.classList.contains('ytb-blocked'),
  channel: document.documentElement.classList.contains('ytb-blocked-channel'),
  overlay: !!document.querySelector('.ytb-overlay')?.isConnected,
  overlayText: document.querySelector('.ytb-overlay')?.textContent.trim(),
  playerHidden: (() => { const p = document.getElementById('movie_player'); return p ? getComputedStyle(p).visibility === 'hidden' : null; })(),
  paused: document.querySelector('#movie_player video')?.paused ?? null,
  comments: (() => { const c = document.querySelector('#comments, ytd-comments'); return c ? getComputedStyle(c).display : 'absent'; })(),
  secondary: (() => { const c = document.querySelector('#secondary'); return c ? getComputedStyle(c).display : 'absent'; })(),
  url: location.href
}));

check('DNR rules written', rules.length === 2, `${rules.length} rules`);
check('channel ID resolved to handle', channelMap[BLOCKED_CHANNEL] === 'jawed', JSON.stringify(channelMap));

const page = await context.newPage();

// 1. Direct loads are redirected by declarativeNetRequest before YouTube loads.
for (const url of [
  `https://www.youtube.com/watch?v=${BLOCKED_VIDEO}`,
  `https://www.youtube.com/watch?app=desktop&v=${BLOCKED_VIDEO}&t=10s`,
  `https://youtu.be/${BLOCKED_VIDEO}?t=5`,
  `https://m.youtube.com/watch?v=${BLOCKED_VIDEO}`,
  `https://www.youtube.com/shorts/${BLOCKED_VIDEO}`,
  `https://www.youtube.com/channel/${BLOCKED_CHANNEL}`,
  `https://www.youtube.com/channel/${BLOCKED_CHANNEL}/videos`
]) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  check(`DNR redirect: ${url}`, page.url().startsWith(blockedPage), page.url());
}
await page.goto(`https://www.youtube.com/watch?v=${BLOCKED_VIDEO}`, { waitUntil: 'load' }).catch(() => {});
check('block page shows policy message', (await page.textContent('#message')).includes('test policy'));
await page.screenshot({ path: path.join(shots, '1-blocked-page.png') });

// 2. A video from a blocked channel, loaded directly: the content script must block it.
await page.goto(`https://www.youtube.com/watch?v=${CHANNEL_VIDEO}`, { waitUntil: 'domcontentloaded' });
await waitFor(page, () => document.documentElement.classList.contains('ytb-blocked') && document.querySelector('.ytb-overlay'));
await sleep(3000);
let s = await state(page);
check('channel video blocked on direct load', s.blocked && s.overlay && s.playerHidden === true, JSON.stringify(s));
check('channel video: player paused', s.paused === true || s.paused === null, `paused=${s.paused}`);
check('channel video: comments hidden', s.comments === 'none' || s.comments === 'absent', s.comments);
check('channel video: recommendations hidden', s.secondary === 'none' || s.secondary === 'absent', s.secondary);
check('channel video: overlay message', (s.overlayText || '').includes('test policy'), s.overlayText);
await page.screenshot({ path: path.join(shots, '2-channel-video.png') });

// 3. Single-page navigation to an allowed video must unblock, and back again must re-block.
await page.evaluate(() => { window.__ytbMarker = true; });
async function spaNavigate(videoId) {
  await page.evaluate((id) => {
    // The same event YouTube's own links fire; handled by ytd-app without a reload.
    document.querySelector('ytd-app').dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true, composed: true,
      detail: { endpoint: { watchEndpoint: { videoId: id }, commandMetadata: { webCommandMetadata: { url: '/watch?v=' + id, webPageType: 'WEB_PAGE_TYPE_WATCH' } } } }
    }));
  }, videoId);
}
await spaNavigate(ALLOWED_VIDEO);
const unblocked = await waitFor(page, () => location.href.includes('9bZkp7q19f0') && !document.documentElement.classList.contains('ytb-blocked'));
await sleep(2000);
s = await state(page);
check('SPA navigate to allowed video unblocks', unblocked && !s.blocked && !s.overlay && s.playerHidden === false, JSON.stringify(s));
check('navigation was in-page (no reload)', await page.evaluate(() => window.__ytbMarker === true));
check('allowed video: comments visible', s.comments !== 'none', s.comments);
await page.screenshot({ path: path.join(shots, '3-allowed-video.png') });

await spaNavigate(CHANNEL_VIDEO);
const reblocked = await waitFor(page, () => location.href.includes('jNQXAC9IVRw') && document.documentElement.classList.contains('ytb-blocked') && document.querySelector('.ytb-overlay')?.isConnected);
await sleep(2000);
s = await state(page);
check('SPA navigate back to blocked channel video re-blocks', reblocked && s.blocked && s.overlay && s.playerHidden === true && s.paused !== false, JSON.stringify(s));
await page.screenshot({ path: path.join(shots, '4-spa-reblocked.png') });

await spaNavigate(BLOCKED_VIDEO);
const vidBlocked = await waitFor(page, () => location.href.includes('dQw4w9WgXcQ') && document.documentElement.classList.contains('ytb-blocked') && document.querySelector('.ytb-overlay')?.isConnected);
s = await state(page);
check('SPA navigate to blocked video ID blocks', vidBlocked && s.blocked && s.paused !== false && await page.evaluate(() => window.__ytbMarker === true), JSON.stringify(s));

// 4. Channel pages. The resolved handle lets DNR catch a direct load; an in-page
//    navigation (as from a channel name under a video) is caught by page data.
await page.goto('https://www.youtube.com/@jawed', { waitUntil: 'domcontentloaded' }).catch(() => {});
check('channel page by handle redirected by DNR (resolved from ID)', page.url().startsWith(blockedPage), page.url());
await page.goto(`https://www.youtube.com/watch?v=${ALLOWED_VIDEO}`, { waitUntil: 'domcontentloaded' });
// The app only handles navigation once its first page has rendered.
await waitFor(page, () => !!document.querySelector('ytd-video-owner-renderer a[href]'));
await sleep(1000);
await page.evaluate(() => {
  document.querySelector('ytd-app').dispatchEvent(new CustomEvent('yt-navigate', {
    bubbles: true, composed: true,
    detail: { endpoint: { browseEndpoint: { browseId: 'UC4QobU6STFB0P71PMvOGN5A', canonicalBaseUrl: '/@jawed' }, commandMetadata: { webCommandMetadata: { url: '/@jawed', webPageType: 'WEB_PAGE_TYPE_CHANNEL' } } } }
  }));
});
const chanBlocked = await waitFor(page, () => location.pathname === '/@jawed' && document.documentElement.classList.contains('ytb-blocked-channel') && document.querySelector('body > .ytb-overlay')?.isConnected);
check('channel page reached in-page blocked via page data', chanBlocked, await page.evaluate(() => location.href + ' ' + document.documentElement.className));
await page.screenshot({ path: path.join(shots, '5-channel-page.png') });

// 5. Feed hiding: search results must not show cards for blocked videos or channels.
async function feedCheck(query, videoId) {
  await page.goto('https://www.youtube.com/results?search_query=' + query, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => document.querySelectorAll('ytd-video-renderer').length > 3);
  return page.evaluate((id) => {
    const cards = [...document.querySelectorAll('ytd-video-renderer')];
    const hit = cards.filter((c) => c.querySelector(`a[href*="v=${id}"]`));
    return { total: cards.length, hits: hit.length, hidden: hit.filter((c) => getComputedStyle(c).display === 'none').length };
  }, videoId);
}
let feed = await feedCheck('never+gonna+give+you+up+rick+astley', BLOCKED_VIDEO);
check('search results hide the blocked video card', feed.hits > 0 && feed.hidden === feed.hits, JSON.stringify(feed));
check('search results still show other cards', feed.total - feed.hits > 0, JSON.stringify(feed));
feed = await feedCheck('me+at+the+zoo+jawed', CHANNEL_VIDEO);
check('search results hide the blocked channel card (via resolved handle)', feed.hits > 0 && feed.hidden === feed.hits, JSON.stringify(feed));

// 6. Embeds: DNR for a blocked video ID, content script for a blocked channel (autoplaying).
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<iframe id="a" width="400" height="225" src="https://www.youtube-nocookie.com/embed/${BLOCKED_VIDEO}"></iframe>
  <iframe id="b" width="400" height="225" src="https://www.youtube.com/embed/${CHANNEL_VIDEO}?autoplay=1&mute=1"></iframe>
  <iframe id="c" width="400" height="225" src="https://www.youtube.com/embed/${ALLOWED_VIDEO}?autoplay=1&mute=1"></iframe>`);
}).listen(0);
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'load' });
await sleep(8000);
const frameA = page.frames().find((f) => f.url().startsWith(blockedPage));
check('embed of blocked video redirected by DNR', !!frameA, page.frames().map((f) => f.url()).join(' | '));
const frameB = page.frames().find((f) => f.url().includes(`/embed/${CHANNEL_VIDEO}`));
const frameC = page.frames().find((f) => f.url().includes(`/embed/${ALLOWED_VIDEO}`));
const sb = frameB ? await frameB.evaluate(() => ({
  blocked: document.documentElement.classList.contains('ytb-blocked'),
  overlay: !!document.querySelector('.ytb-overlay'),
  paused: document.querySelector('video')?.paused ?? null,
  parent: document.getElementById('movie_player')?.parentElement?.id
})) : null;
check('embed of blocked channel video blocked by content script', sb && sb.blocked && sb.overlay && sb.paused !== false, JSON.stringify(sb));
const sc = frameC ? await frameC.evaluate(() => ({
  blocked: document.documentElement.classList.contains('ytb-blocked'),
  paused: document.querySelector('video')?.paused ?? null
})) : null;
check('embed of allowed video plays', sc && !sc.blocked && sc.paused === false, JSON.stringify(sc));
await page.screenshot({ path: path.join(shots, '6-embeds.png') });

await context.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
