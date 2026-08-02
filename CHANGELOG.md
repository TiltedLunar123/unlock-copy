# Changelog

## 1.0.1 - 2026-08-02

Bug fixes, no new features.

Two of these let a determined page win against an always-unlocked site, which is
the mode that is supposed to win every time:

- A copy handler calling `Event.prototype.preventDefault.call(e)` cancelled the
  copy anyway. Neutering replaced the method on the event, and a call that goes
  straight to the prototype never looks at the event. The prototype methods are
  guarded now.
- A handler that let the copy through and then called
  `navigator.clipboard.writeText` still overwrote the clipboard with its own
  attribution text. Clipboard writes issued from inside a copy that "clean copy"
  is cleaning are refused. Writes from a page's own copy button are untouched.

The rest:

- Pages whose address merely mentions a PDF, such as `?file=report.pdf` or a
  search for `cheatsheet.pdf`, were refused as if they were the built-in PDF
  viewer. Only the path is considered now.
- Changing a global default on the options page did not reach any open tab,
  because the options page is itself the active tab. Settings changes now reach
  every tab, each resolved against its own per-site overrides.
- A settings write that happened while storage was unreadable saved a site list
  containing only the site being changed, silently dropping every other saved
  site. Writes now refuse rather than save a truncated list.
- Flipping a switch on a page unlocked from the toolbar could tell the engine it
  had started early when it had not, dropping the capture net that page depends
  on.
- The badge stayed blank on always-unlocked sites, which are the ones that are
  never not unlocked.
- Shadow roots were remembered forever. On a single page application that
  mounts and unmounts components, memory and the cost of every later pass grew
  for as long as the tab stayed open.
- The page was rescanned in full on any frame in which anything changed, which
  on a large site is most frames. Only what actually changed is rescanned now.
- The selection stylesheet could be inserted several times over a tab's life and
  removed only once, so relocking a page left it selectable.
- Relocking a page did not put back inline handlers that had been stripped.
- The keyboard shortcut refused to unlock a local file until the popup had been
  opened once, because the file access setting was read only at startup.
- Aggressive mode unblocked the paste event but still let a page block Ctrl+V
  from keydown, which is where most sites block it.

## 1.0.0 - 2026-07-29

First release.

- Restores selection, copy, right-click, text drag and keyboard shortcuts.
- Two levels: a one-click unlock for the current page under `activeTab`, and a
  per-site "always unlock" that runs at `document_start` and closes the
  window-capture case a late unlock cannot reach.
- Selection CSS is injected in the user origin, so page `!important` rules and
  inline styles cannot take it back.
- Page copy listeners are called with an event they cannot cancel, rather than
  dropped, so editors and copy buttons keep working.
- No host permissions at install. Site access is requested one origin at a time.
