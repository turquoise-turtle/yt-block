# Store assets

Files for the Chrome Web Store listing. They are generated, not hand-edited: run `cd test && npm run assets` to rebuild them after changing the extension or [icon.svg](icon.svg).

| File | Use |
| --- | --- |
| [icon.svg](icon.svg) | Source of the icon. |
| [icon-128.png](icon-128.png) | Store icon: 96 px artwork inside the 16 px margin the store asks for. The same file is `extension/icons/128.png`. |
| [screenshot-1-blocked-video.png](screenshot-1-blocked-video.png) | A blocked channel's video on YouTube, 1280 × 800. |
| [screenshot-2-blocked-embed.png](screenshot-2-blocked-embed.png) | A blocked video embedded on an ordinary web page, 1280 × 800. |

## Licence of the icon

The icon is an original design made from three plain geometric shapes (a circle, a triangle and a diagonal bar) in the style of the standard prohibition sign. It uses no third-party artwork, fonts or trademarks. It is dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), so it can be reused for any purpose without attribution. The rest of the repository is under the MIT licence.

The screenshots show YouTube's own page with the extension running. They are for describing the extension in its store listing.
