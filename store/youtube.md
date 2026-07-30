# YouTube upload details

Paste the resulting watch URL into the Chrome Web Store listing's "Official
video" field. The store accepts a YouTube link, not a file upload.

No chapters. YouTube requires at least three, each ten seconds or longer, and
this video runs 45 seconds with scenes shorter than that. Adding them anyway
just makes the chapter bar refuse to appear.

## Title

```
Unlock Copy: select and copy on sites that block it (Chrome and Firefox)
```

## Description

```
Some sites switch off text selection, take away the right-click menu, or swallow
Ctrl+C. Unlock Copy puts them back. One click, no account.

Everything in this video is a real capture. The article is locked the way real
pages are, with a CSS lock it reasserts through a MutationObserver plus copy,
selectstart, contextmenu and keydown handlers. The drag that fails is a real
drag that selected nothing. The one that works is the same drag after the
extension ran.

WHAT IT DOES

Restores text selection, copying, the right-click menu and keyboard shortcuts.
Strips the "read more at..." text some sites bolt onto whatever you copied.
Leaves copy buttons, rich text editors and password managers doing their job.

WHY IT WORKS WHERE OTHERS STOP

The selection stylesheet goes into the user origin. Browsers rank that above
anything a page can write, including the page's own !important rules and its
inline styles, so a site that fights back still loses. The usual approach
injects an ordinary stylesheet and gets beaten by any page that tries harder.

"Always unlock this site" registers a script that runs before the site's own
code on your next visit. That ordering is the whole game: when a page installs
its blocker before anything else runs, nothing arriving later can undo it.

PERMISSIONS

A fresh install can't read any website. It asks for the tab you're looking at
when you click the button, permission to inject its own code, and somewhere to
keep your settings. Site access is requested one site at a time, by name, and
only when you ask for it.

Nothing is collected and nothing is sent anywhere. That's enforced rather than
promised: the build fails if a networking call appears anywhere in the source.

WHAT IT CAN'T DO

Text painted into a canvas or shipped as an image isn't text, so nothing can
copy it. Text placed by CSS pseudo-element content is unselectable by design.
Frames from another site stay locked unless you unlock that site too.

Free and open source under the MIT licence. Read it, or file a bug:
https://github.com/TiltedLunar123/unlock-copy
```

## Tags

```
unlock copy, enable right click, allow copy, enable copy paste, copy blocked text,
chrome extension, firefox addon, browser extension, text selection, right click enabler,
open source extension, manifest v3
```

## Settings

- Visibility: Public. The store will not accept an unlisted or private video.
- Category: Science & Technology
- Audience: not made for kids
- Licence: Standard YouTube licence
- Shorts: no. It is 16:9 and 45 seconds, so it belongs on the main channel.
