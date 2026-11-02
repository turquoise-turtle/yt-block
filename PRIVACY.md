# Privacy Policy

**YouTube Block (managed)** does not collect, transmit, or store any personal data about the people who use the browser it is installed in.

The extension reads the address and player information of YouTube pages and embedded YouTube players, solely to compare the video and channel IDs against the block list set by the school's administrator. That comparison happens on the device. The IDs of the videos and channels a person watches are not recorded, logged, or sent anywhere.

The block list comes from the browser's managed policy storage, which only an administrator can set. The extension reads it and never changes it.

The extension makes one kind of network request. When a channel is listed in the policy, it fetches that channel's public page on `youtube.com` once, without cookies or any sign-in, to learn the channel's other identifier (its ID or its handle). The request contains only the channel identifier the administrator listed, and it is sent only to YouTube. The result is kept in `chrome.storage.local` on the device, is never read by anyone other than the extension itself, and is removed when the extension is uninstalled.

The extension does not use analytics, crash reporting, advertising, or any form of remote logging, and it has no back-end of its own.

**In short:** nothing about what anyone watches leaves the device. The only thing the extension sends is a request to YouTube for each channel the administrator has chosen to block.

---

*Last updated: November 2026*
