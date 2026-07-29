# Unlock Copy

Restores text selection, copy, right-click and keyboard shortcuts on sites that block
them. Chrome and Firefox, Manifest V3.

No account, no tracking, and no access to any site until you point it at one.

## What it fixes

Sites block copying in a surprising number of ways, and most extensions in this category
only handle the easy ones. This handles all of these, each covered by a test:

| Technique | Handled |
| --- | --- |
| `oncopy` / `oncontextmenu` / `onselectstart` inline attributes | yes |
| `addEventListener('copy', e => e.preventDefault())` on document, bubble or capture | yes |
| the same listener on `window` in capture, registered before anything else | yes, with "always unlock" |
| `document.oncopy = () => false` | yes |
| CSS `user-select: none`, including `!important` and inline styles | yes |
| `::selection { background: transparent }` | yes |
| keyboard interception of Ctrl+C, Ctrl+A, Ctrl+X | yes |
| a timer that clears your selection as you make it | yes |
| copy handlers that swap in "read more at ..." attribution | yes |
| open shadow DOM | yes |
| closed shadow DOM | with "always unlock", for roots created after page load |
| same-origin iframes | yes |
| a `MutationObserver` that re-applies the block | yes |
| React and Vue style root delegates | yes |
| invisible click-blocking overlays | with aggressive mode |

And what it cannot fix, because nothing can:

- text painted into a `<canvas>`, or shipped as an image. That is not text.
- text in CSS `::before` / `::after` `content`, which is unselectable by specification.
- cross-origin iframes, unless you unlock that site too.
- the browser's built-in PDF viewer and `chrome://` pages, which are closed to extensions.

## How it works, and why the permissions are what they are

Two levels, and the popup never blurs them.

**Unlock this page.** Clicking the toolbar button grants `activeTab` for that tab, which
is enough to inject the engine and the stylesheet. It applies instantly with no reload
and no prompt, and it lasts until you navigate away.

There is one thing a late unlock cannot do. A page that registered a capture-phase `copy`
listener on `window` before anything else wins on registration order, and there is no way
to reach back and remove a listener you never saw. That is a real limit, it is not
hand-waved, and the test suite asserts that it still fails.

**Always unlock this site.** Asks for permission for that one origin, then registers a
content script that runs at `document_start`, before any of the site's own code. Nothing
has registered a listener yet, so there is nothing left to lose to. This closes the case
above, and it is the only thing that can.

The install-time permissions are `activeTab`, `scripting` and `storage`. There are no
host permissions and no static content scripts, so a fresh install asks for nothing and
can read nothing. Host access is requested one origin at a time, only when you ask for it,
and `tools/build.mjs --check` fails the build if that ever stops being true.

### The stylesheet trick

Most extensions in this category inject `* { user-select: text !important }` as an
ordinary stylesheet. That is an author-origin rule, so any page that ships its own
`!important` declaration, or sets `element.style` from script, simply wins.

This one injects into the **user origin** instead, via `scripting.insertCSS`. The cascade
sorts by origin before anything else, and user `!important` outranks author `!important`
and inline styles both. The page cannot take selection back, and no observer is needed to
keep re-adding anything.

### Not breaking the sites that were fine

A `copy` listener is not automatically hostile. Rich text editors, code blocks with a copy
button, and password managers all register one for good reasons. Rather than dropping
listeners, the engine calls them with an event whose `preventDefault` does nothing, so
every side effect the page wanted still happens and only the cancelling stops. On top of
that, anything inside an `input`, `textarea`, `[contenteditable]`, CodeMirror, Monaco,
ProseMirror, Quill or Slate is passed through untouched.

The test suite includes an editor with a legitimate copy handler and asserts it keeps
working in every mode, because "breaks Google Docs" is the single most common complaint
about every other extension in this category.

## Install from source

```bash
npm run build
```

Chrome or Edge: go to the extensions page, turn on developer mode, choose "Load unpacked"
and pick `dist/chrome`.

Firefox: go to `about:debugging`, choose "This Firefox", then "Load Temporary Add-on" and
pick `dist/firefox/manifest.json`.

Neither store has a listing yet.

## Development

```bash
npm run build     # dist/chrome and dist/firefox
npm run check     # build, then the release gate
npm test          # unit tests
npm run e2e       # end to end, needs Edge or Chromium
npm run all       # everything, plus store zips
```

`npm run icons` re-renders the PNGs from the SVGs and needs ImageMagick. The PNGs are
committed, so a normal build never runs it.

### Tests

`test-pages/blockers.html` reproduces every blocking technique above as a numbered case.
The end-to-end suite drives a real browser and asserts against the **real clipboard**,
not a proxy like `defaultPrevented`, because every proxy can be satisfied while the user
still has nothing to paste.

It runs three phases. The first one is the important one:

- **baseline**, nothing injected. Every blocking case must still block. Without this a
  fixture case that quietly stopped blocking would make the other two phases pass for
  free.
- **late**, unlocked the way the toolbar button does. Everything must copy except the
  window-capture case, which must still fail.
- **early**, unlocked the way "always unlock" does. Everything must copy.

The harness drives **Edge or Chromium, never branded Chrome**. Chrome ignores
`--load-extension` and only logs a notice, so the suite would appear to run and prove
nothing. Firefox is verified by hand; its MV3 build shares all the logic and differs only
in the manifest.

## Privacy

Nothing is collected, nothing is transmitted, and there is no analytics of any kind. The
build gate fails if `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`
appears anywhere in shipped source, so this is enforced rather than promised. Your
settings live in `storage.sync`, which is your browser's own account sync. See
[PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
