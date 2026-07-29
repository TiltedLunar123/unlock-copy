# Changelog

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
