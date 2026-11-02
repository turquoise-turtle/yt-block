# YouTube Block (managed)

A minimal Manifest V3 Chrome extension for schools. Administrators list YouTube channel IDs and video IDs in the extension's managed policy; students see a simple block image instead of the video, with the comments and recommended videos removed. There is no popup, options page or user-facing control, so students have nothing to switch off.

It is built to be cheap on low-end Chromebooks: direct loads are handled by the browser's network layer before any page script runs, the page script is purely event driven (no polling, no MutationObserver), and feed hiding is a single stylesheet.

## What gets blocked

| Situation | How it is handled |
| --- | --- |
| Typing or clicking a link to a blocked video or channel (`/watch?v=`, `/watch_popup`, `/shorts/`, `/live/`, `/embed/`, `/v/`, `/e/`, `youtu.be`, `/channel/UC…`, `/@handle`) on `youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtube-nocookie.com`, `youtubekids.com` | A `declarativeNetRequest` redirect rule sends the navigation to the extension's block page. YouTube never loads. |
| Embedded players on any website, including `youtube-nocookie.com` embeds and Google Slides or Classroom | The same redirect rule applies to frames. A blocked channel's video in an embed is caught by the page script when the player loads. |
| Moving between videos inside YouTube without a page load (clicking a thumbnail, autoplay, playlists, Shorts scrolling, the mini player) | The page script reads YouTube's own navigation events and player data, stops the player, hides it and shows the block image. |
| Videos from a blocked channel, however the video was reached | The channel ID comes from YouTube's player response, watch-next response or channel metadata, so new uploads are blocked without listing every video. |
| Blocked channels and videos in the home feed, search results, sidebar, playlists and Shorts shelves | Hidden by CSS. |

A channel can be listed by ID (`UC…`) or by handle (`@name`). The service worker resolves each entry to its other form once, by fetching the channel's public page, and caches the result. That is needed because YouTube's player data carries IDs while its links carry handles.

On a blocked video page the player is replaced by the block image and the comments and the recommendation sidebar are removed. The `hideComments` and `hideRecommendations` policies apply the same removal to every video, if the school wants that.

## Policy

The policy is delivered through Chrome's managed storage, so it can only be set by an administrator. The schema is in [extension/schema.json](extension/schema.json); an example is in [policy.example.json](policy.example.json).

| Key | Type | Meaning |
| --- | --- | --- |
| `blockedVideos` | array of strings | Video IDs, or video URLs in any common form. |
| `blockedChannels` | array of strings | Channel IDs (`UC…`), handles (`@name`), or channel URLs. |
| `hideComments` | boolean | Hide comments on every video. Default `false`. |
| `hideRecommendations` | boolean | Hide the home feed, the related-videos sidebar, end screens and autoplay suggestions on every page. Default `false`. |
| `hideInFeeds` | boolean | Hide blocked videos and channels from feeds and search results. Default `true`. Turn off if the list is very large (thousands of entries) and scrolling feels slow. |
| `blockMessage` | string | Text shown under the block image. |

Changes take effect without a restart: Chrome pushes policy updates to the extension, which rewrites its network rules and tells open YouTube tabs.

## Deployment

1. Publish the `extension/` folder to the Chrome Web Store as an unlisted or private item, or self-host a packed `.crx` with an update manifest. Force installation needs one of these; the extension ID comes from the listing.
2. In the Google Admin console go to Devices, Chrome, Apps & extensions, Users & browsers, pick the organisational unit, add the extension by ID and set it to Force install.
3. Open the extension's entry and paste the policy JSON into Policy for extensions. The same screen applies to ChromeOS devices and to managed Chrome on macOS and Windows enrolled in Chrome Browser Cloud Management.
4. For Macs managed by another MDM instead, deliver `ExtensionSettings` (installation mode `force_installed`) in the `com.google.Chrome` preference domain and the policy keys above in the `com.google.Chrome.extensions.<extension id>` preference domain.
5. Check `chrome://policy` on a managed device: the extension's policy appears under its ID with no errors.

Recommended companion policies: `DeveloperToolsAvailability` set to 2 (students cannot open DevTools and disable page scripts), `IncognitoModeAvailability` set to 1 and `BrowserGuestModeEnabled` set to false (force-installed extensions do not run in those modes), and `ExtensionInstallBlocklist` set to `*` with your own allow list so a second extension cannot interfere. The extension does nothing about third-party YouTube front ends; use `URLBlocklist` for those.

## Layout

- [extension/manifest.json](extension/manifest.json): permissions are `storage` and `declarativeNetRequest` plus host access to the YouTube domains. Requires Chrome 111 or later (main-world content scripts).
- [extension/background.js](extension/background.js): service worker. Turns the policy into redirect rules and resolves channel IDs and handles. Idle otherwise.
- [extension/policy.js](extension/policy.js): shared parsing of the policy into clean ID lists.
- [extension/content.js](extension/content.js): isolated-world script. Reads the policy, passes it to the page script, writes the feed-hiding stylesheet.
- [extension/page.js](extension/page.js): main-world script. Listens to YouTube's navigation events and the player, decides, and draws the block image. Built with DOM calls only because YouTube enforces Trusted Types.
- [extension/content.css](extension/content.css): the blocked state, the overlay, and the optional comment and recommendation hiding.
- [extension/blocked.html](extension/blocked.html): the page shown for redirected navigations and embeds.

## Testing

Managed storage cannot be set without operating-system policy, so the end-to-end harness copies the extension into `test/build` with the policy reader replaced by a fixture, loads it into Playwright's Chromium and exercises the real YouTube site: direct loads, embeds served from a local page, in-page navigation, channel pages and search results. Branded Google Chrome 137 and later ignores `--load-extension`, which is why Playwright's Chromium is used.

```bash
cd test && npm install && npx playwright install chromium && npm test
```

Set `HEADED=1` to watch it. Screenshots land in `test/build/shots`.

## Limitations

- `m.youtube.com` and `music.youtube.com` get the network-level blocking and the player-level checks, but their in-page navigation events differ from the desktop site, so a blocked channel's video there may play for a moment before the player check stops it. Desktop YouTube is the target.
- `youtubekids.com` gets network-level blocking only.
- Channel resolution needs one network request per channel entry the first time it is seen. If YouTube refuses the request, that entry still works in the form it was given.
- Chrome allows 1000 regex rules per extension; entries are batched 25 per rule, so roughly 25,000 entries is the practical ceiling.
