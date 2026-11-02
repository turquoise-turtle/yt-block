// Shared by the service worker, the content script and the block page.
// Turns whatever an administrator typed into the policy into clean ID lists.
const YTB = {
  VIDEO_ID: /^[A-Za-z0-9_-]{11}$/,
  CHANNEL_ID: /^UC[A-Za-z0-9_-]{22}$/,
  HANDLE: /^@[A-Za-z0-9._-]{3,30}$/,

  readChannelMap() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('channelMap', (items) => resolve((!chrome.runtime.lastError && items && items.channelMap) || {}));
      } catch {
        resolve({});
      }
    });
  },

  readManagedPolicy() {
    return new Promise((resolve) => {
      try {
        chrome.storage.managed.get(null, (items) => resolve(chrome.runtime.lastError ? {} : items || {}));
      } catch {
        resolve({});
      }
    });
  },

  toList(value) {
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
    if (typeof value === 'string') return value.split(/[\s,]+/);
    return [];
  },

  parseUrl(text) {
    try {
      return new URL(/^[a-z]+:\/\//i.test(text) ? text : 'https://' + text);
    } catch {
      return null;
    }
  },

  // Accepts a bare ID or any of the usual video URL shapes.
  extractVideoId(text) {
    text = text.trim();
    if (YTB.VIDEO_ID.test(text)) return text;
    const url = YTB.parseUrl(text);
    if (!url) return null;
    const v = url.searchParams.get('v');
    if (v && YTB.VIDEO_ID.test(v)) return v;
    const path = url.hostname === 'youtu.be' ? '/x/' + url.pathname.slice(1) : url.pathname;
    const m = path.match(/^\/(?:embed|shorts|live|v|e|x)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
    return m ? m[1] : null;
  },

  // Returns { id } for UC... IDs or { handle } (lower case, no @) for handles.
  extractChannel(text) {
    text = text.trim();
    if (YTB.CHANNEL_ID.test(text)) return { id: text };
    if (YTB.HANDLE.test(text)) return { handle: text.slice(1).toLowerCase() };
    const url = YTB.parseUrl(text);
    if (!url) return null;
    let m = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
    if (m) return { id: m[1] };
    m = url.pathname.match(/^\/(@[A-Za-z0-9._-]{3,30})(?:[/?#]|$)/);
    if (m) return { handle: m[1].slice(1).toLowerCase() };
    return null;
  },

  // channelMap is kept in chrome.storage.local by the service worker: each
  // blocked channel ID maps to its handle and each handle to its ID, so a
  // channel listed either way is matched by URL, by page data and in feeds.
  normalisePolicy(raw, channelMap) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const videos = new Set();
    const channels = new Set();
    const handles = new Set();
    for (const entry of YTB.toList(raw.blockedVideos)) {
      const id = YTB.extractVideoId(entry);
      if (id) videos.add(id);
    }
    for (const entry of YTB.toList(raw.blockedChannels)) {
      const c = YTB.extractChannel(entry);
      if (c && c.id) channels.add(c.id);
      else if (c && c.handle) handles.add(c.handle);
    }
    if (channelMap && typeof channelMap === 'object') {
      for (const id of [...channels]) if (channelMap[id]) handles.add(channelMap[id]);
      for (const h of [...handles]) if (channelMap['@' + h]) channels.add(channelMap['@' + h]);
    }
    return {
      videos: [...videos],
      channels: [...channels],
      handles: [...handles],
      hideComments: raw.hideComments === true,
      hideRecommendations: raw.hideRecommendations === true,
      hideInFeeds: raw.hideInFeeds !== false,
      message: typeof raw.blockMessage === 'string' ? raw.blockMessage.slice(0, 500) : ''
    };
  }
};
