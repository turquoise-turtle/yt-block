// Isolated world: the only side with access to chrome.storage. It reads the
// managed policy, hands it to page.js, and writes the stylesheet that hides
// blocked videos and channels in feeds and search results. Feed hiding is pure
// CSS (:has on the card elements) so no script runs while the page scrolls.
(() => {
  const CARD = ':is(ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer,' +
    'ytd-playlist-video-renderer,ytd-playlist-panel-video-renderer,ytd-reel-item-renderer,yt-lockup-view-model,' +
    'ytm-shorts-lockup-view-model,ytm-shorts-lockup-view-model-v2,ytd-channel-renderer,ytd-grid-channel-renderer)';
  let style = null;

  function feedCss(policy) {
    if (!policy.hideInFeeds) return '';
    const links = [];
    // IDs and handles were validated against strict character sets, so they are safe inside quotes.
    for (const id of policy.videos) links.push(`a[href*="v=${id}"]`, `a[href*="/shorts/${id}"]`);
    for (const id of policy.channels) links.push(`a[href*="/channel/${id}"]`);
    for (const h of policy.handles) links.push(`a[href$="/@${h}" i]`, `a[href*="/@${h}/" i]`, `a[href*="/@${h}?" i]`);
    return links.length ? `${CARD}:has(${links.join(',')}){display:none!important}` : '';
  }

  function publish(policy) {
    document.dispatchEvent(new CustomEvent('ytb-policy', { detail: JSON.stringify(policy) }));
    const css = feedCss(policy);
    if (!style) {
      style = document.createElement('style');
      style.id = 'ytb-feed';
    }
    if (style.textContent !== css) style.textContent = css;
    const root = document.head || document.documentElement;
    if (root && !style.isConnected) root.appendChild(style);
  }

  async function load() {
    const [raw, channelMap] = await Promise.all([YTB.readManagedPolicy(), YTB.readChannelMap()]);
    publish(YTB.normalisePolicy(raw, channelMap));
  }

  document.addEventListener('ytb-request', load);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed' || (area === 'local' && changes.channelMap)) load();
  });
  load();
})();
