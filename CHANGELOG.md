# Changelog

## 1.0.3 - 2026-08-07

Bug fixes, no new features.

Sites that were still winning:

- A page that wraps its content in a block marked as not editable stayed
  locked. That marking is ordinary and common, and this extension was
  reading it as "this is an editor, leave it alone", which is the
  opposite of what it means.
- Blocks re-applied through the less common spellings of the same
  operation got through. The usual one was already refused.
- Aggressive mode did not unblock pasting on a site that blocks it by
  assigning the handler directly to the field. The other two ways of
  writing that block were already covered.
- An always-unlocked site shown inside another site's page never got the
  part of the unlock that beats a plain CSS lock, so it stayed locked for
  the whole visit.

Things this extension was doing that it should not:

- A site's own "copy this snippet" button copied whatever you had
  selected before instead of the snippet. The guard that stops a site
  clearing your selection on a timer was also refusing the ordinary case
  of a page selecting its own content for you.
- Turning "Text selection and copy" off still stripped copy handlers out
  of the page. A switch you had moved went on acting.
- Relocking did not fully put things back. In aggressive mode an overlay
  could stay clicked-through for good, and a handler the page had
  installed was left running with no way for the page to remove it.
- Relocking sometimes left the page selectable anyway, if the unlock had
  been applied twice at once.

Settings:

- If the browser could not read this extension's settings at the moment
  you changed a switch, every open tab was reset to the factory switches
  and stayed that way until reloaded. It now leaves your pages alone.
- The settings page could show a switch it had not managed to save, so it
  disagreed with every page you visited and said nothing about it. It
  also reported "None yet" when it simply could not read your saved
  sites, which invited you to add them all over again.
- Turning on "Always unlock this site" while the tab moved underneath you
  could grant access to one site and remember a different one. Permission
  the extension asks for and then cannot use is handed straight back.

## 1.0.2 - 2026-08-05

Bug fixes, no new features.

Three of these could stop "always unlock" working on a site while the
popup went on saying it was on:

- Two sites whose addresses differ only in punctuation, such as
  `docs.google.com` and `docs-google.com`, shared one slot internally.
  Turning both on meant the second one never actually ran.
- If the browser could not read this extension's settings even once,
  every site on the always-unlock list was quietly switched off, and
  nothing turned them back on until you opened the popup and changed
  something.
- On Firefox, the settings for an always-unlocked site never reached the
  page, so per-site switches were ignored there.

Sites that were still winning:

- A site that blocks Ctrl+C by assigning `document.onkeydown` kept
  working. The same block written the other common way was already
  handled, which is what made this hard to spot.
- A site that clears your selection on a timer can do it with `collapse`
  instead of `removeAllRanges`. Only the second was covered.

Things this extension was doing that it should not:

- An editor that deliberately cancels its own copy had that cancellation
  overridden. Returning false from a handler is a real way to cancel,
  and the fix for sites abusing it was defeating every honest use too,
  including on features you had switched off.
- Relocking a page did not stick. Changing any setting afterwards
  switched the page back on, and nothing could turn it off again short
  of a reload.
- Changing a setting re-applied the unlock to every tab it could reach,
  including tabs you had just relocked and tabs you never unlocked.
- Turning "Text selection and copy" off relocked the page everywhere
  except inside components built with shadow DOM.
- Unlocking from the toolbar on a site that was already set to always
  unlock switched it to the blunter method, which stops the page's own
  copy buttons and editors from running at all.

The rest:

- The popup said "Unlocked, on every time you visit this site" over a
  page the keyboard shortcut had just relocked, and the only button it
  offered then forgot the site entirely instead of unlocking the page.
- A local file with a percent sign in its name, such as
  `holiday%zz.html`, made the popup show a raw error, and left every
  other open tab on the previous settings.
- Aggressive mode unblocks pasting, but left `onpaste="return false"` on
  the field itself alone, which is how most sites write it.
- Removing a site on the options page could bring back a site removed a
  moment earlier, and moved keyboard focus to the top of the page.

Under the hood, three checks were not checking:

- The release gate said every shipped file must parse and only looked
  for stray control characters. Nothing else covers the popup or the
  options page, so a syntax error in either would have shipped.
- It also wrote the store zips before running, so a failing gate still
  left finished-looking files next to its own error message.
- The end to end suite scored a crashed test as a pass, which mattered
  most for the run that exists to prove the test page still blocks
  anything at all. It caught two real harness failures within an hour of
  being fixed.

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
