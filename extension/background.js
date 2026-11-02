// Service worker: converts the managed policy into declarativeNetRequest
// redirect rules so that direct loads of blocked videos, channels and embeds
// never reach YouTube at all. Single-page navigation inside YouTube is handled
// by page.js, because those requests carry the video ID in a POST body.
importScripts('policy.js');

const DNR = chrome.declarativeNetRequest;
const HOST = '^https?://[^/]*youtu(?:be(?:-nocookie|kids)?\\.com|\\.be)/';
const REQUEST_DOMAINS = ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com', 'youtu.be'];
const RESOURCE_TYPES = ['main_frame', 'sub_frame'];
// Chrome allows at most 1000 regex rules per extension, so IDs are batched.
const BATCH = 25;

function videoRegex(ids) {
  // watch?v=ID, watch_popup?v=ID, embed/ID, v/ID, e/ID, shorts/ID, live/ID and youtu.be/ID
  return HOST + '(?:(?:watch|watch_popup)\\?(?:[^#]*&)?v=|embed/|v/|e/|shorts/|live/|)(?:' + ids.join('|') + ')(?:[&#/?]|$)';
}

function channelRegex(entries) {
  return '^https?://[^/]*youtube\\.com/(?:' + entries.join('|') + ')(?:[/?#]|$)';
}

async function rulesFor(items, makeRegex, caseSensitive, rules) {
  if (items.length === 0) return;
  const regexFilter = makeRegex(items);
  const { isSupported } = await DNR.isRegexSupported({ regex: regexFilter, isCaseSensitive: caseSensitive });
  if (!isSupported && items.length > 1) {
    // Too complex for RE2's per-rule memory budget: split and retry.
    const half = Math.ceil(items.length / 2);
    await rulesFor(items.slice(0, half), makeRegex, caseSensitive, rules);
    await rulesFor(items.slice(half), makeRegex, caseSensitive, rules);
    return;
  }
  if (!isSupported) return;
  rules.push({
    id: rules.length + 1,
    priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } },
    condition: {
      regexFilter,
      isUrlFilterCaseSensitive: caseSensitive,
      requestDomains: REQUEST_DOMAINS,
      resourceTypes: RESOURCE_TYPES
    }
  });
}

// Modern YouTube markup links channels by handle, while player data carries
// the channel ID, so each channel entry is resolved to its other form by
// fetching its public page once. Results are cached in chrome.storage.local;
// a failed lookup is retried at the next sync.
async function lookupChannel(url) {
  try {
    const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    const id = text.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/);
    const handle = text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/@([A-Za-z0-9._-]{3,30})"/) ||
      text.match(/"vanityChannelUrl":"https?:\/\/www\.youtube\.com\/@([A-Za-z0-9._-]{3,30})"/);
    return { id: id && id[1], handle: handle && handle[1].toLowerCase() };
  } catch {
    return null;
  }
}

async function resolveChannels(policy) {
  const channelMap = await YTB.readChannelMap();
  let changed = false;
  for (const id of policy.channels) {
    if (id in channelMap) continue;
    const found = await lookupChannel('https://www.youtube.com/channel/' + id);
    if (found && found.handle) { channelMap[id] = found.handle; changed = true; }
  }
  for (const h of policy.handles) {
    if ('@' + h in channelMap) continue;
    const found = await lookupChannel('https://www.youtube.com/@' + h);
    if (found && found.id) { channelMap['@' + h] = found.id; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ channelMap });
  return channelMap;
}

let syncing = null;
function syncRules() {
  // Serialise: a policy change during a sync just queues one more pass.
  if (!syncing) syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const raw = await YTB.readManagedPolicy();
  const channelMap = await resolveChannels(YTB.normalisePolicy(raw));
  const policy = YTB.normalisePolicy(raw, channelMap);
  const rules = [];
  for (let i = 0; i < policy.videos.length; i += BATCH) {
    await rulesFor(policy.videos.slice(i, i + BATCH), videoRegex, true, rules);
  }
  const escape = (text) => text.replace(/[.]/g, '\\.');
  const channelEntries = policy.channels.map((id) => 'channel/' + id).concat(policy.handles.map((h) => '@' + escape(h)));
  for (let i = 0; i < channelEntries.length; i += BATCH) {
    // Handles are case-insensitive on YouTube.
    await rulesFor(channelEntries.slice(i, i + BATCH), channelRegex, false, rules);
  }
  const existing = await DNR.getDynamicRules();
  await DNR.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
}

chrome.runtime.onInstalled.addListener(syncRules);
chrome.runtime.onStartup.addListener(syncRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed') syncRules();
});
