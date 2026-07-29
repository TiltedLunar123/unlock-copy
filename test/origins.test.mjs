import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLib, plain, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/origins.js'], { chrome: STUB_CHROME });
const { classify, patternFor, scriptIdFor, messageFor } = ctx.UC.origins;

test('ordinary pages are unlockable', () => {
  const info = classify('https://example.com/article?id=1#top');
  assert.equal(info.ok, true);
  assert.equal(info.origin, 'https://example.com');
  assert.equal(info.host, 'example.com');
  assert.equal(info.pattern, 'https://example.com/*');
});

test('a port is part of the origin', () => {
  // Getting this wrong produces a match pattern the user cannot be prompted
  // for, which surfaces as "always unlock does nothing" on localhost.
  const info = classify('http://127.0.0.1:8080/page.html');
  assert.equal(info.origin, 'http://127.0.0.1:8080');
  assert.equal(info.pattern, 'http://127.0.0.1:8080/*');
});

test('browser pages are refused with their own message', () => {
  for (const url of ['chrome://settings', 'edge://flags', 'about:config', 'devtools://devtools/x']) {
    const info = classify(url);
    assert.equal(info.ok, false, url);
    assert.equal(info.reason, 'browser-page', url);
  }
  assert.match(messageFor('browser-page'), /Browser pages/);
});

test('both web stores are refused', () => {
  for (const url of [
    'https://chromewebstore.google.com/detail/abc',
    'https://chrome.google.com/webstore/detail/abc',
    'https://addons.mozilla.org/en-US/firefox/addon/x/',
  ]) {
    assert.equal(classify(url).reason, 'web-store', url);
  }
});

test('pdf urls are refused, because the viewer is not a document we can touch', () => {
  assert.equal(classify('https://example.com/paper.pdf').reason, 'pdf');
  assert.equal(classify('https://example.com/paper.pdf?download=1').reason, 'pdf');
  // A path that merely contains "pdf" is a normal page and must stay unlockable.
  assert.equal(classify('https://example.com/pdf-tips').ok, true);
});

test('file and unsupported schemes are refused separately', () => {
  assert.equal(classify('file:///C:/notes.html').reason, 'file');
  assert.equal(classify('data:text/html,hi').reason, 'unsupported');
  assert.equal(classify('').reason, 'no-tab');
  assert.equal(classify(undefined).reason, 'no-tab');
});

test('patterns stay origin scoped, so granting https never implies http', () => {
  assert.equal(patternFor('https://example.com'), 'https://example.com/*');
  assert.equal(patternFor('https://example.com/'), 'https://example.com/*');
  assert.notEqual(patternFor('https://example.com'), patternFor('http://example.com'));
});

test('script ids are stable, distinct per origin and safe as identifiers', () => {
  const a = scriptIdFor('https://example.com');
  assert.equal(a, scriptIdFor('https://example.com'));
  assert.notEqual(a, scriptIdFor('http://example.com'));
  assert.notEqual(scriptIdFor('https://a.example.com'), scriptIdFor('https://b.example.com'));
  assert.match(a, /^uc-[a-z0-9-]+$/);
});
