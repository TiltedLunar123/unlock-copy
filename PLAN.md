# Unlock Copy - plan

A Chrome MV3 + Firefox MV3 extension that restores selection, copy, right-click, text
drag and keyboard shortcuts on sites that block them.

This plan was drafted twice, once by Claude and once by Grok, then merged. Where the two
drafts disagreed the disagreement is recorded, because the losing option is usually the
obvious one and the next person to touch this will otherwise reintroduce it.

Every version number below was checked against MDN browser-compat-data rather than
recalled. Anything still unverified is marked ASSUMED and must not be treated as fact.

## 1. Why the existing extensions are bad

The category leaders all fail the same three ways:

1. **They fight the page in the author CSS origin.** They inject
   `* { user-select: text !important }` as a normal stylesheet, so a page that ships its
   own `!important` rule later in the cascade, or sets `element.style.userSelect` from
   script, simply wins. The user sees the extension "not working" on exactly the sites
   that try hardest.
2. **They drop `copy` listeners instead of neutering them.** That kills the page's
   blocking handler and its legitimate one at the same time, so code blocks lose their
   copy buttons and rich text editors break. Reviews for every extension in this category
   are full of "breaks Google Docs".
3. **They demand `<all_urls>` at install.** One scary permission prompt for a utility the
   user wants on maybe five sites.

Everything in this design follows from fixing those three.

## 2. Permission model

Manifest permissions are `activeTab`, `scripting`, `storage`. There are no
`host_permissions` and no static `content_scripts`. `optional_host_permissions` is
declared as `*://*/*` but nothing is requested until the user asks for it.

Two tiers, and the UI must never blur them:

**Tier 1, "Unlock this page".** Clicking the toolbar action grants `activeTab` for that
tab, which is enough for `scripting.executeScript` and `scripting.insertCSS`. Applies
immediately with no reload and no prompt. Lost on navigation. This is the *late pass*:
page script has already run, so it cannot un-register listeners that already exist
(see 4.3 for what that costs).

**Tier 2, "Always unlock this site".** Calls `permissions.request({ origins: [...] })`
from the popup click handler, then `scripting.registerContentScripts` with
`world: "MAIN"`, `runAt: "document_start"`, `allFrames: true`,
`persistAcrossSessions: true` for that one origin. From the next load onward the unlock
runs *before any page script*, which is the only way to win completely. One per-site
prompt, no all-sites warning.

Tier 2 is not optional decoration. `registerContentScripts` requires the extension to
already hold host permissions for its `matches` (verified against the Chrome scripting
docs), so there is no way to get document_start coverage without a grant. An extension
that offers a "remember this site" checkbox and only writes a storage key is lying;
on the next load it has no way to run early. We do the real thing.

`storage.sync` holds the allowlist and per-site feature flags. On startup the background
reconciles three sources of truth: what storage says, what `permissions.getAll()`
actually grants, and what `scripting.getRegisteredContentScripts()` has registered. Any
of the three can drift (user revokes a permission from the browser UI, profile syncs to
a machine where the grant was never made) and the reconciler is what keeps the popup
honest.

## 3. Verified platform facts

From MDN browser-compat-data, `webextensions/*.json`, fetched 2026-07-29.

| Capability | Chrome | Firefox |
| --- | --- | --- |
| `content_scripts[].world` | 111 | 128 |
| `scripting.executeScript` `world: "MAIN"` | 95 | 128 |
| `scripting.RegisteredContentScript.world` | 102 | 128 |
| `scripting.registerContentScripts` | 96 | 102 |
| `persistAcrossSessions` | 96 | 102 |
| `scripting.insertCSS` `origin` (incl. `USER`) | 88 | 102 |
| `optional_host_permissions` | 102 | 128 |
| `permissions.Permissions.data_collection` | not supported | 140 |
| `userScripts` | 120 | 136 |

Floors that follow: **Chrome 111**, **Firefox 140**. Firefox is pushed past its own 128
floor by `data_collection_permissions`, which AMO requires on new submissions.
Firefox for Android gets 142 for the same reason.

`userScripts` is rejected. It is the more natural API for this job but it requires the
user to flip a browser-level toggle before the extension works at all, which fails the
"simple and it just works" requirement.

Firefox MV3 uses a non-persistent event page (`background.scripts`), not
`background.service_worker`. Grok's draft said Firefox supports service worker
backgrounds "now" and marked it UNSURE; it does not, and the shipped Fullshot manifest in
this same account uses `scripts` for Firefox. Corrected.

## 4. The unlock engine

### 4.1 CSS, and why USER origin is the whole ballgame

The CSS cascade sorts by origin before it sorts by specificity or source order. Order,
highest priority first:

```
user-agent !important  >  USER !important  >  author !important  >  author normal  >  USER normal
```

An author stylesheet cannot outrank a USER `!important` declaration. Neither can an
inline `style` attribute, and neither can `element.style.setProperty(..., 'important')`.
So `scripting.insertCSS({ origin: 'USER' })` is not merely a stronger version of what the
competition does, it is unbeatable by page CSS, and it removes the need for a
MutationObserver that re-appends a `<style>` node every time the page deletes it.

Grok's draft proposed an author-origin `html.unlocked *` stylesheet plus an observer to
keep re-adding it. That is the standard approach and it is the reason the standard
approach loses. Rejected.

The rules applied:

```css
*, *::before, *::after {
  user-select: text !important;
  -webkit-user-select: text !important;
  -webkit-touch-callout: default !important;
}
::selection { background-color: Highlight !important; color: HighlightText !important; }
```

CSS alone cannot reach into shadow roots, so 4.5 handles those separately.

### 4.2 Event blocking, early pass

At `document_start` in the MAIN world, before page script exists, patch
`EventTarget.prototype.addEventListener`. For a hostile event type the listener is not
dropped, it is **wrapped**.

The wrapper calls the page's listener, but first shadows three things as own properties
on that specific event instance:

- `preventDefault` becomes a no-op
- `stopPropagation` and `stopImmediatePropagation` become no-ops
- `returnValue` is pinned to `true` (assigning `false` is the legacy cancel path, and it
  is an accessor on `Event.prototype`, so it needs an own data property to shadow it)

and, when clean-copy is on, shadows `clipboardData` with a proxy whose `setData` and
`clearData` do nothing.

The properties are deleted again once the listener returns, so nothing leaks to other
listeners.

This is the central design decision and it is where the two drafts split. Grok's draft
concluded the wrapper "should not call the page listener at all when enabled", storing it
in a side table for restore. That is wrong for the same reason the incumbents are bad: a
code block's copy button, a rich-text editor and an analytics hook all register `copy`
listeners for entirely legitimate reasons. Not calling them breaks the page. Calling them
with an event they cannot cancel preserves every side effect they wanted while removing
the only capability being abused. Wrap, never drop.

Hostile types: `copy`, `cut`, `beforecopy`, `beforecut`, `selectstart`, `select`,
`dragstart` under the selection switch, `contextmenu` under its own, `keydown` /
`keypress` / `keyup` under the keyboard switch, and `mousedown` / `mouseup` / `paste` /
`beforepaste` only under aggressive mode. `paste` is never touched by default because
breaking paste inside an editor is far worse than the problem being solved.

**Whether to wrap and whether to neuter are separate questions.** Every type in that
whole list is wrapped on registration regardless of the current switches; the wrapper
decides at call time whether to actually neuter. Consulting the policy at registration
instead would mean a switch turned on after page load did nothing to listeners already
registered, so the user would see a switch that only works if they reload first.

**Editor exemption.** If the event target is inside `[contenteditable]`, `[role=textbox]`
or a known editor root (`.CodeMirror`, `.cm-editor`, `.monaco-editor`, `.ProseMirror`,
`.ql-editor`, `.ace_editor`, `[data-slate-editor]`), the wrapper calls through untouched.
Without this the extension is another "breaks Google Docs" one-star magnet. Both drafts
agreed on this; it is load-bearing.

A plain `input`, `textarea` or `select` is deliberately **not** exempt. Those have no
custom copy semantics worth preserving, and exempting them means a site with a blanket
copy ban still blocks copying out of its own comment box, which is one of the things
people install this to fix.

### 4.2a Inline attributes, which the wrapper cannot reach

An inline `oncopy="return false"` never goes through `addEventListener`, and it does not
cancel by calling `preventDefault` either: it cancels through its *return value*, which
the engine processes internally rather than through the JS-visible method. Shadowing
`preventDefault` therefore does nothing to it. The only counter is to remove the
attribute.

That becomes a race as soon as the page puts it back from its own `MutationObserver`, and
a race against a tight loop is not a fix. So `Element.prototype.setAttribute` is patched
to ignore writes of a hostile `on*` attribute outside editors. The page's observer fires,
calls `setAttribute`, and nothing happens. The initial parse-time attributes are still
removed by the sweep, and the observer stays as cover for `innerHTML` rewrites, which the
parser applies without going through `setAttribute`.

Also patched at document_start:

- The `on*` handler properties on `Document.prototype`, `HTMLElement.prototype` and
  `window`, so `document.oncopy = () => false` silently does nothing. Original
  descriptors are kept for restore.
- `Selection.prototype.removeAllRanges` and `Selection.prototype.empty`, so a
  `setInterval` that nukes the selection cannot. Gated behind its own switch, since menus
  and drag-drop UIs clear selection legitimately.
- `Element.prototype.attachShadow`, which stores every root it creates in a `WeakMap`,
  including closed ones. This is the only way to reach a closed root, and it only works
  for roots created after the patch. Roots created before it are unreachable, full stop.

### 4.2b Which mode am I in, and why the default is "early"

The engine has to pick a mode before anything can tell it which one it is in. A registered
content script runs at `document_start` and the bridge cannot answer until a message round
trip has completed, by which point the patches are already installed. The late path, by
contrast, always writes a boot payload immediately before injecting the file.

So "late" is the case that can always announce itself, and "early" is therefore the
correct default. Defaulting the other way is not a small mistake: every always-unlocked
site would install the blunt capture net instead of wrapping, silently dropping the
legitimate copy handlers that wrapping exists to preserve, and would skip the
`attachShadow` patch entirely. The end-to-end suite would still pass, because the net is
strictly more aggressive than wrapping. That combination, wrong in a way the tests cannot
see, is why it is written down here.

### 4.3 Event blocking, late pass, and its one real hole

On a Tier 1 unlock the page has already run. Listeners it registered cannot be
enumerated (`getEventListeners` is devtools-only) and cannot be removed without the
original function reference.

The counter is a capture-phase listener on `window` calling `stopImmediatePropagation()`.
Capture runs `window` -> `document` -> ... -> target, so stopping during window capture
means the event never reaches anything the page registered on `document`, `body`, a
container, or the target itself, in either phase. That covers the overwhelming majority
of real blockers, including React's root delegate and Vue's, because both attach below
`window`.

It loses in exactly one case: the page registered a capture listener **on `window`
itself** before we did, because same target plus same phase resolves by registration
order. That hole is why Tier 2 exists, and the popup says so in plain words rather than
pretending Tier 1 is complete.

For `contextmenu` we stop propagation but deliberately do **not** call
`preventDefault()`, because the default action is the native menu and we want it. Grok
flagged this as needing verification; the E2E asserts it on both engines.

### 4.4 Clipboard hijacking

A page can leave the copy uncancelled and instead overwrite the payload:

```js
document.addEventListener('copy', e => {
  e.clipboardData.setData('text/plain', sel + '\n\nRead more at example.com');
  e.preventDefault();
});
```

Both the neutered `preventDefault` and the neutered `clipboardData` are needed here, and
the ordering matters: if we only neutralised `preventDefault` the page's `setData` would
still land. Handled in the early pass by the shadowed `clipboardData`, and in the late
pass by stopping the event before the page sees it.

### 4.5 Shadow DOM, iframes, and what cannot be fixed

Open roots are walked and get their own `<style>` node plus their own observer, since a
light-DOM observer does not see inside them and CSS does not cross the boundary. Closed
roots are reachable only through the `attachShadow` WeakMap from 4.2, so only on Tier 2.

Same-origin iframes are covered by `allFrames: true`. Cross-origin iframes need a grant
for that frame's origin, which the user has not given, so they stay locked. The popup
says so when it detects cross-origin frames rather than silently doing nothing.

Not fixable, and the README says so instead of overpromising:

- text painted into `<canvas>`, or shipped as an image, or as a CSS `background-image`
- text in `::before` / `::after` `content`, which is not selectable by specification
- anti-debugger `debugger`-in-`setInterval` loops, which are a different product and a
  store-rejection risk to attack

### 4.6 Overlay shields

A transparent full-viewport div swallows the mouse so the text underneath cannot be
selected. Automatic detection is a heuristic and false positives break real UIs, so it
is off by default and lives behind aggressive mode: on `mousedown`, if the top element at
that point holds no text, is `position: fixed|absolute`, and covers most of the viewport,
it gets `pointer-events: none`.

The shield is disabled, not re-hit-tested. The `mousedown` that triggered it is already
spent, so the click that reveals a shield does nothing and the next one selects normally.
An earlier draft of this section claimed the hit test was retried; it never was. Retrying
would mean synthesising a second `mousedown`, which is a fair amount of machinery for one
frame of delay in a mode that is off by default and has no automated coverage at all.

## 5. UI

One primary control, one persistence control, four switches. Nothing else.

```
  example.com

  [ Unlock this page ]        <- primary button, becomes "Unlocked" + Undo

  Always unlock example.com   [ off ]
    Runs before the site's code. Asks for permission once.

  What gets unlocked
    Text selection and copy   [ on  ]
    Right-click menu          [ on  ]
    Keyboard shortcuts        [ on  ]
    Clean copy                [ on  ]

  Options
```

"Clean copy" is the label for the hijack defence: strips text the site appends to what
you copied.

Restricted-page states, shown in place of the primary button:

| Page | Message |
| --- | --- |
| `chrome://`, `edge://`, `about:` | Browser pages can't be unlocked. |
| Web Store / AMO listing pages | The extension store blocks extensions here. |
| Built-in PDF viewer | The built-in PDF viewer can't be unlocked. |
| `file://` without the file-URLs grant | Turn on "Allow access to file URLs" in extension settings. |
| No tab | No active tab. |

Once the file-URLs grant is on, local files are unlockable, but only per page: `file://`
has no origin for a permission to be scoped to, so the "always unlock" toggle is disabled
there with a reason rather than offered and then silently refused.

## 6. Tests

`test-pages/blockers.html` reproduces every technique in section 4 as numbered cases,
each with a unique copy target string, plus a control case with a legitimate editor whose
copy handler must keep working.

Unit tests cover the pure logic with no browser: policy resolution, editor detection,
origin-pattern construction, and the reconciler.

E2E drives a real browser over CDP. It must drive **Edge or Chromium, never branded
Chrome**, which ignores `--load-extension` and prints
"--disable-extensions-except is not allowed in Google Chrome, ignoring" instead of
failing, so the tests would appear to run and silently prove nothing.

The end-to-end assertion is the real clipboard: select the case's text, dispatch a real
Ctrl+C through `Input.dispatchKeyEvent`, read the clipboard back, compare. Weaker
assertions (`getComputedStyle().userSelect`, `defaultPrevented` on a dispatched
`contextmenu`) run alongside as diagnostics, because when the clipboard assertion fails
they say which layer broke.

## 7. Store risk

Positioning is user control over their own clipboard and context menu, an accessibility
and usability tool. Not "bypass protection", never "defeat paywall", never "disable DRM";
that language is what gets this category rejected as circumvention.

Concrete rules the build enforces so they cannot rot:

- no `host_permissions` and no static `content_scripts` in either manifest
- no permission outside `activeTab`, `scripting`, `storage`
- no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` anywhere in
  shipped source, so "nothing you copy leaves your machine" is gated, not promised
- no `eval`, `new Function` or `importScripts` in the background bundle
- every icon declared in the manifest exists and is actually that size

## 8. Review pass

The implementation was reviewed adversarially against this plan once it was working and
green. That found three defects the tests could not see, all now fixed and all recorded
above because each one is the kind that grows back:

- the mode default was `late`, so the always-unlock path installed the capture net and
  skipped `attachShadow`, inverting the wrap-never-drop rule in exactly the mode meant to
  honour it best (4.2b)
- session state was cleared only when `changeInfo.url` was present, which a reload does
  not set, so the badge read ON over a page where copying had been blocked again
- the overlay shield handler was registered after the capture net on the same target and
  phase, so under aggressive mode the net stopped `mousedown` first and the shield handler
  was dead code in precisely the configuration that needs it

Also fixed from the same pass: wrapping consulted the live policy at registration time,
storage and reconcile both had lost-update races under concurrent writes, the editor
exemption covered plain form fields, `Selection.removeAllRanges` was blocked even for
editors clearing their own selection, and local files were refused even with the grant on.

## 9. Open items

- ASSUMED, and still only assumed: `contextmenu` with `stopImmediatePropagation()` and no
  `preventDefault()` still shows the native menu on both engines. An earlier draft claimed
  the E2E asserted this. It does not, and nothing else does either: every assertion in the
  suite reads the clipboard, and a native context menu is not observable that way in
  headless. The whole `contextmenu` feature therefore has no automated coverage.
- ASSUMED: the `activeTab` grant survives same-document SPA navigation. The popup
  re-checks on open rather than caching.
- Neither store has been submitted to. Store listing copy is not written.
