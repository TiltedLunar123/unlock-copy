import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLib, plain, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/policy.js'], { chrome: STUB_CHROME });
const { DEFAULTS, FEATURES, resolve, diff, forPage, withoutMode, CSS } = ctx.UC.policy;

test('a fresh install has everything on except aggressive mode', () => {
  const resolved = resolve(null, null);
  assert.equal(resolved.selection, true);
  assert.equal(resolved.contextmenu, true);
  assert.equal(resolved.keyboard, true);
  assert.equal(resolved.cleanCopy, true);
  assert.equal(resolved.aggressive, false);
});

test('site overrides beat globals, and only where they are set', () => {
  const globals = { ...DEFAULTS, keyboard: false };
  const resolved = resolve(globals, { selection: false });
  assert.equal(resolved.selection, false, 'override applies');
  assert.equal(resolved.keyboard, false, 'global still applies where no override');
  assert.equal(resolved.contextmenu, true);
});

test('resolve always returns every feature, never a sparse object', () => {
  const resolved = resolve({}, {});
  assert.deepEqual(Object.keys(resolved).sort(), [...FEATURES].sort());
});

test('diff stores only what differs, so changing a default still propagates', () => {
  const globals = { ...DEFAULTS };
  const resolved = resolve(globals, null);

  assert.deepEqual(plain(diff(globals, resolved)), {}, 'matching the default stores nothing');

  const changed = { ...resolved, contextmenu: false };
  assert.deepEqual(plain(diff(globals, changed)), { contextmenu: false });
});

test('diff is relative to the current globals, not to the shipped defaults', () => {
  // A user who turned keyboard off globally and then on for one site must end
  // up with an override, or the site switch silently does nothing.
  const globals = { ...DEFAULTS, keyboard: false };
  const resolved = { ...resolve(globals, null), keyboard: true };
  assert.deepEqual(plain(diff(globals, resolved)), { keyboard: true });
});

test('the page payload is booleans plus a known mode', () => {
  const page = forPage({ selection: 1, contextmenu: 0 }, 'early');
  assert.equal(page.enabled, true);
  assert.equal(page.selection, true, 'truthy is normalised to a boolean');
  assert.equal(page.contextmenu, false);
  assert.equal(page.mode, 'early');
});

test('an unrecognised mode falls back to late, never to early', () => {
  // Early means "we got here before page script". Guessing that wrongly would
  // skip the capture net and quietly stop working on the hard cases.
  assert.equal(forPage(DEFAULTS, 'nonsense').mode, 'late');
  assert.equal(forPage(DEFAULTS, 'EARLY').mode, 'late');
});

test('an omitted mode is left out entirely, so a push cannot overwrite one', () => {
  // Only the code doing the injecting knows how a page was reached. A later
  // push updating a switch does not, and the stored "always unlock" flag is not
  // that answer either: it says what the next load will do, not how the page in
  // front of the user was patched. Sending a guess is how a page unlocked late
  // gets told it is early and drops the capture net it depends on.
  const page = forPage(DEFAULTS);
  assert.equal('mode' in page, false);
  assert.equal(forPage(DEFAULTS, null).mode, undefined);
  assert.equal(page.enabled, true, 'the rest of the payload is unaffected');
});

test('the stylesheet forces selection back on with !important', () => {
  assert.match(CSS, /user-select:text !important/);
  assert.match(CSS, /-webkit-user-select:text !important/);
  assert.match(CSS, /::selection/);
});

test('a push to a running engine carries no mode at all', () => {
  // Absent means "you already know yours, keep it". Only the injector knows how
  // a page was reached, and stamping a guess onto a frame that is already
  // unlocked at document_start swaps its wrapping for the capture net, which
  // drops the page's own copy handlers instead of neutering them.
  const page = forPage(DEFAULTS, 'late');
  assert.equal(page.mode, 'late');

  const live = withoutMode(page);
  assert.equal('mode' in live, false);
  // Everything else has to survive, or a switch push stops carrying switches.
  for (const key of FEATURES) assert.equal(live[key], page[key]);
  assert.equal(live.enabled, true);
  // And the payload it was derived from is untouched, because the same object
  // is handed to the frames that do need a mode.
  assert.equal(page.mode, 'late');
});
