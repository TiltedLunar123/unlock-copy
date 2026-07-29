# Privacy policy

Unlock Copy collects nothing.

## What is not collected

No analytics, no telemetry, no crash reporting, no unique identifier, no usage counts.
Nothing you select, copy, or visit is recorded, and nothing is sent anywhere. There is no
server to send it to.

This is checked rather than promised: `tools/build.mjs --check` fails the build if
`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` appears anywhere in
the shipped source. The gate runs on every release build.

## What is stored, and where

Two things, in your browser's own extension storage (`storage.sync`):

- your default switches, the ones on the options page
- the list of sites you turned "always unlock" on for, plus any per-site switch you
  changed from its default

`storage.sync` is your browser's own account sync. If you are signed in, your browser
syncs it between your devices the same way it syncs bookmarks. It does not pass through
anything belonging to this extension or its author. If you are not signed in, it stays on
that machine.

Uninstalling removes all of it.

## Site access

A fresh install has no access to any website. The manifest requests `activeTab`,
`scripting` and `storage`, and no host permissions.

- **Unlock this page** uses `activeTab`, which your click grants for that one tab and
  which expires when you navigate away.
- **Always unlock this site** asks your browser for permission to that one origin. Your
  browser shows the prompt and you can revoke it at any time from the extension's own
  settings page, which also turns the site off here.

Access is never requested for a site you did not ask for.

## Clipboard

The extension does not read your clipboard. When you copy, the browser performs the copy;
the extension's only role is stopping the page from cancelling it, and, if "Clean copy" is
on, stopping the page from overwriting what you copied with something else. The copied
text is never inspected, stored or transmitted.

## Contact

Open an issue at https://github.com/TiltedLunar123/unlock-copy/issues.

Last updated 2026-07-29.
