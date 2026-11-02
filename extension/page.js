// Main world: runs inside YouTube's own JavaScript context so it can read the
// app's navigation events, page data and player API. It does not touch any
// chrome.* API; the policy arrives from content.js as a JSON string.
//
// Work is event driven. There is no MutationObserver and no polling while a
// page is idle, which keeps the cost on low-end devices close to zero.
(() => {
  'use strict';
  if (window.__ytbLoaded) return;
  window.__ytbLoaded = true;

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
  const DEFAULT_MESSAGE = 'This content has been blocked by your school.';
  const html = document.documentElement;

  let policy = { videos: new Set(), channels: new Set(), handles: new Set(), hideComments: false, hideRecommendations: false, message: '' };
  // Everything learnt about the page currently on screen. Replaced on navigation.
  let page = { key: '', kind: 'other', videoId: null, channelId: null, handle: null, settled: true };
  let blocked = null;
  let overlay = null;
  let overlayTimer = 0;
  let settleTimer = 0;
  let probeTimer = 0;
  let probesLeft = 0;

  // ---------------------------------------------------------------- policy
  document.addEventListener('ytb-policy', (e) => {
    let p;
    try { p = JSON.parse(e.detail); } catch { return; }
    policy = {
      videos: new Set(p.videos), channels: new Set(p.channels), handles: new Set(p.handles),
      hideComments: !!p.hideComments, hideRecommendations: !!p.hideRecommendations, message: p.message || ''
    };
    html.classList.toggle('ytb-hide-comments', policy.hideComments);
    html.classList.toggle('ytb-hide-recs', policy.hideRecommendations);
    evaluate();
    probePlayer();
  });
  document.dispatchEvent(new CustomEvent('ytb-request'));

  // --------------------------------------------------------------- parsing
  function kindOf(pathname) {
    if (pathname === '/watch' || pathname === '/watch_popup' || /^\/(?:embed|shorts|live|v|e)\//.test(pathname)) return 'video';
    if (/^\/(?:channel|c|user)\/|^\/@/.test(pathname)) return 'channel';
    return 'other';
  }
  function videoIdFromUrl(url) {
    const v = url.searchParams.get('v');
    if (v && VIDEO_ID.test(v)) return v;
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }
  function handleFrom(text) {
    const m = typeof text === 'string' && text.match(/\/@([A-Za-z0-9._-]{3,30})(?:[/?#]|$)/);
    return m ? m[1].toLowerCase() : null;
  }
  function channelFromUrl(url) {
    const m = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
    return m ? { channelId: m[1] } : { handle: handleFrom(url.pathname) };
  }

  // Facts carried by a YouTube navigation endpoint (watch, shorts, browse).
  function infoFromEndpoint(ep) {
    const info = {};
    if (!ep) return info;
    const w = ep.watchEndpoint || ep.reelWatchEndpoint;
    if (w && VIDEO_ID.test(w.videoId || '')) info.videoId = w.videoId;
    const b = ep.browseEndpoint;
    if (b && CHANNEL_ID.test(b.browseId || '')) info.channelId = b.browseId;
    if (b) info.handle = handleFrom(b.canonicalBaseUrl);
    return info;
  }

  // Facts carried by a player response (watch pages, embeds, shorts).
  function infoFromPlayerResponse(pr) {
    const info = {};
    const vd = pr && pr.videoDetails;
    if (vd) {
      if (VIDEO_ID.test(vd.videoId || '')) info.videoId = vd.videoId;
      if (CHANNEL_ID.test(vd.channelId || '')) info.channelId = vd.channelId;
    }
    const mf = pr && pr.microformat && pr.microformat.playerMicroformatRenderer;
    if (mf) info.handle = handleFrom(mf.ownerProfileUrl);
    return info;
  }

  // Facts carried by a browse response (channel pages).
  function infoFromBrowseResponse(br) {
    const info = {};
    const md = br && br.metadata && br.metadata.channelMetadataRenderer;
    if (md) {
      if (CHANNEL_ID.test(md.externalId || '')) info.channelId = md.externalId;
      info.handle = handleFrom(md.vanityChannelUrl);
    }
    return info;
  }

  // Facts carried by a watch-next response. On single-page navigation the
  // player response travels separately, but the owner block is always here.
  function infoFromNextResponse(nr) {
    try {
      for (const item of nr.contents.twoColumnWatchNextResults.results.results.contents) {
        const owner = item.videoSecondaryInfoRenderer && item.videoSecondaryInfoRenderer.owner;
        const ep = owner && owner.videoOwnerRenderer && owner.videoOwnerRenderer.navigationEndpoint;
        if (ep) return infoFromEndpoint(ep);
      }
    } catch { /* a different layout */ }
    return {};
  }

  // Last resort: the rendered owner link under the player.
  function infoFromOwnerLink() {
    const a = document.querySelector('ytd-video-owner-renderer a[href]');
    try { return a ? channelFromUrl(new URL(a.getAttribute('href'), location.href)) : {}; } catch { return {}; }
  }

  function infoFromPlayer(player) {
    let info = {};
    try {
      info = infoFromPlayerResponse(player.getPlayerResponse && player.getPlayerResponse());
      const d = player.getVideoData && player.getVideoData();
      if (!info.videoId && d && VIDEO_ID.test(d.video_id || '')) info.videoId = d.video_id;
    } catch { /* player not ready */ }
    return info;
  }

  // ------------------------------------------------------------- decisions
  function decide(info) {
    if (info.videoId && policy.videos.has(info.videoId)) return { kind: 'video', id: info.videoId };
    if (info.channelId && policy.channels.has(info.channelId)) return { kind: 'channel', id: info.channelId };
    if (info.handle && policy.handles.has(info.handle)) return { kind: 'channel', id: '@' + info.handle };
    return null;
  }

  // Start a new page record. `url` defaults to the current location.
  function resetPage(url, info) {
    url = url || new URL(location.href);
    const kind = kindOf(url.pathname);
    const videoId = kind === 'video' ? (info && info.videoId) || videoIdFromUrl(url) : null;
    const key = kind + ':' + (videoId || url.pathname.toLowerCase());
    if (page.key === key) return;
    clearTimeout(settleTimer);
    page = { key, kind, videoId, channelId: null, handle: null, settled: kind === 'other' };
    if (kind === 'channel') Object.assign(page, channelFromUrl(url));
    evaluate();
  }

  // Merge new facts about the current page. A page is "settled" once the
  // channel is known, or it is not a video or channel page at all; only a
  // settled page that matches nothing is unblocked, so a blocked channel's
  // video never plays while its owner is still being looked up.
  function learn(info) {
    let changed = false;
    for (const k of ['videoId', 'channelId', 'handle']) {
      if (info[k] && page[k] !== info[k]) { page[k] = info[k]; changed = true; }
    }
    if (page.channelId && !page.settled) { page.settled = true; changed = true; }
    if (changed) evaluate();
  }

  function settleSoon() {
    // If no channel data ever arrives (unusual page layouts), give up on
    // waiting rather than leaving a stale block in place.
    clearTimeout(settleTimer);
    if (page.settled) return;
    settleTimer = setTimeout(() => { page.settled = true; evaluate(); }, 5000);
  }

  function evaluate() {
    const result = decide(page);
    if (result) block(result);
    else if (page.settled) unblock();
  }

  // ------------------------------------------------------------- blocking
  function mainPlayer() {
    return document.getElementById('movie_player') || document.getElementById('shorts-player');
  }
  function stopPlayer(player) {
    try { if (typeof player.stopVideo === 'function') player.stopVideo(); } catch { /* ignore */ }
    const video = player.querySelector('video');
    if (video) { try { video.pause(); } catch { /* ignore */ } }
  }

  // Built with DOM calls: YouTube enforces Trusted Types, so innerHTML throws here.
  function buildOverlay() {
    const SVG = 'http://www.w3.org/2000/svg';
    const el = document.createElement('div');
    el.className = 'ytb-overlay';
    // Keep clicks from reaching the player's own play/pause handling.
    el.addEventListener('click', (e) => e.stopPropagation());
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(SVG, 'circle');
    for (const [k, v] of [['cx', 32], ['cy', 32], ['r', 28], ['fill', 'none'], ['stroke', '#e53935'], ['stroke-width', 6]]) circle.setAttribute(k, v);
    const slash = document.createElementNS(SVG, 'path');
    for (const [k, v] of [['d', 'M14 14l36 36'], ['stroke', '#e53935'], ['stroke-width', 6], ['stroke-linecap', 'round']]) slash.setAttribute(k, v);
    svg.append(circle, slash);
    const title = document.createElement('p');
    title.className = 'ytb-title';
    const msg = document.createElement('p');
    msg.className = 'ytb-msg';
    el.append(svg, title, msg);
    return el;
  }

  function placeOverlay(attempt) {
    clearTimeout(overlayTimer);
    if (!blocked) return;
    if (!overlay) overlay = buildOverlay();
    overlay.querySelector('.ytb-title').textContent = page.kind === 'channel' ? 'This channel is blocked' : 'This video is blocked';
    overlay.querySelector('.ytb-msg').textContent = policy.message || DEFAULT_MESSAGE;
    overlay.classList.toggle('ytb-fixed', page.kind === 'channel');
    // The overlay lives inside the player element, so it follows the player
    // when YouTube moves it from its first-load placeholder into the page.
    const parent = page.kind === 'channel' ? document.body : mainPlayer();
    if (!parent) {
      // The player is created a little after navigation; retry briefly.
      if (attempt < 40) overlayTimer = setTimeout(() => placeOverlay(attempt + 1), 250);
      return;
    }
    if (overlay.parentElement !== parent) parent.appendChild(overlay);
  }

  function block(result) {
    const same = blocked && blocked.id === result.id && overlay && overlay.isConnected;
    blocked = result;
    html.classList.add('ytb-blocked');
    html.classList.toggle('ytb-blocked-channel', page.kind === 'channel');
    const p = mainPlayer();
    if (p) stopPlayer(p);
    if (!same) placeOverlay(0);
  }

  function unblock() {
    clearTimeout(overlayTimer);
    if (!blocked) return;
    blocked = null;
    html.classList.remove('ytb-blocked', 'ytb-blocked-channel');
    if (overlay) overlay.remove();
  }

  // ------------------------------------------------------------- sources
  // 1. The URL, immediately.
  resetPage();

  // 2. Navigation events from the YouTube app (desktop and shorts).
  document.addEventListener('yt-navigate-start', (e) => {
    const ep = e.detail && e.detail.endpoint;
    const info = infoFromEndpoint(ep);
    const meta = ep && ep.commandMetadata && ep.commandMetadata.webCommandMetadata;
    let url = null;
    if (meta && meta.url) { try { url = new URL(meta.url, location.href); } catch { /* ignore */ } }
    if (url || info.videoId) resetPage(url, info);
    learn(info);
  });

  function onPageData(e) {
    resetPage();
    let data = e && e.detail && e.detail.response;
    if (!data) {
      const pm = document.querySelector('ytd-page-manager');
      try { data = pm && pm.getCurrentData && pm.getCurrentData(); } catch { /* ignore */ }
    }
    if (data && page.kind === 'video') {
      const pr = infoFromPlayerResponse(data.playerResponse);
      if (!page.videoId || !pr.videoId || pr.videoId === page.videoId) learn(pr);
      if (!page.channelId) learn(infoFromNextResponse(data.response));
      if (!page.channelId) learn(infoFromOwnerLink());
    } else if (data && page.kind === 'channel') {
      learn(infoFromBrowseResponse(data.response));
    }
    evaluate();
    probePlayer();
    settleSoon();
  }
  document.addEventListener('yt-page-data-updated', onPageData);
  document.addEventListener('yt-navigate-finish', onPageData);

  // 3. Data embedded in the initial HTML.
  document.addEventListener('DOMContentLoaded', () => {
    resetPage();
    if (page.kind === 'video') {
      const pr = infoFromPlayerResponse(window.ytInitialPlayerResponse);
      if (!page.videoId || !pr.videoId || pr.videoId === page.videoId) learn(pr);
      if (!page.channelId) learn(infoFromNextResponse(window.ytInitialData));
    } else if (page.kind === 'channel') {
      learn(infoFromBrowseResponse(window.ytInitialData));
    }
    probePlayer();
    settleSoon();
  });

  // 4. The player itself: the authority for embeds, playlists and autoplay.
  function checkPlayer(player) {
    const info = infoFromPlayer(player);
    if (decide(info)) stopPlayer(player);
    if (player !== mainPlayer()) return;
    resetPage();
    if (page.kind !== 'video') return;
    if (page.videoId && info.videoId && info.videoId !== page.videoId) return;
    learn(info);
  }

  function probePlayer() {
    clearTimeout(probeTimer);
    probesLeft = 12;
    probeOnce();
  }
  function probeOnce() {
    const p = mainPlayer();
    if (p && typeof p.getPlayerResponse === 'function') checkPlayer(p);
    // YouTube rebuilds the player container on a first load; re-attach if so.
    if (blocked && !(overlay && overlay.isConnected)) placeOverlay(0);
    // Embeds attach the player API a little after the element appears.
    if ((!page.settled || (blocked && !overlay.isConnected)) && probesLeft-- > 0) probeTimer = setTimeout(probeOnce, 500);
  }

  function onMedia(e) {
    const t = e.target;
    const player = t && t.closest && t.closest('.html5-video-player');
    if (player && typeof player.getVideoData === 'function') checkPlayer(player);
  }
  document.addEventListener('play', onMedia, true);
  document.addEventListener('playing', onMedia, true);
})();
