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
  assert.equal(classify('https://example.com/paper.PDF').reason, 'pdf');
  // A path that merely contains "pdf" is a normal page and must stay unlockable.
  assert.equal(classify('https://example.com/pdf-tips').ok, true);
});

test('a pdf named in the query string is still an ordinary html page', () => {
  // `?file=x.pdf` is how a viewer page names the document it is displaying, so
  // matching the query string refused exactly the pages that can be unlocked,
  // and swept up plain search results on the way.
  assert.equal(classify('https://example.com/viewer.html?file=paper.pdf').ok, true);
  assert.equal(classify('https://example.com/download?doc=report.pdf').ok, true);
  assert.equal(classify('https://example.com/search?q=cheatsheet.pdf').ok, true);
  assert.equal(classify('https://example.com/read#chapter.pdf').ok, true);
});

test('file and unsupported schemes are refused separately', () => {
  assert.equal(classify('file:///C:/notes.html').reason, 'file');
  assert.equal(classify('data:text/html,hi').reason, 'unsupported');
  assert.equal(classify('').reason, 'no-tab');
  assert.equal(classify(undefined).reason, 'no-tab');
});

test('a local file is unlockable once the browser has granted file access', () => {
  // Refusing every file URL even after the user turned the setting on would
  // leave the popup telling them to enable something already enabled.
  const info = classify('file:///C:/docs/notes.html', { fileAccess: true });
  assert.equal(info.ok, true);
  assert.equal(info.local, true);
  assert.equal(info.host, 'notes.html');
});

test('a local file is still refused when file access is off', () => {
  assert.equal(classify('file:///C:/notes.html', { fileAccess: false }).reason, 'file');
  assert.match(messageFor('file'), /Allow access to file URLs/);
});

test('file access does not make browser pages or the store unlockable', () => {
  // The option only relaxes the file scheme, never the hard blocks.
  assert.equal(classify('chrome://settings', { fileAccess: true }).ok, false);
  assert.equal(classify('https://chromewebstore.google.com/x', { fileAccess: true }).ok, false);
});

test('patterns stay origin scoped, so granting https never implies http', () => {
  assert.equal(patternFor('https://example.com'), 'https://example.com/*');
  assert.equal(patternFor('https://example.com/'), 'https://example.com/*');
  assert.notEqual(patternFor('https://example.com'), patternFor('http://example.com'));
});

test('a scheme-only origin still produces a valid match pattern', () => {
  // Trimming the trailing slashes off `file://` yields `file:/*`, which the
  // browser rejects; every permissions call built from it throws and the caller
  // reads the throw as "not granted".
  assert.equal(patternFor('file://'), 'file:///*');
  assert.equal(patternFor('file://'), classify('file:///c:/x.html', { fileAccess: true }).pattern);
});

test('script ids are stable, distinct per origin and safe as identifiers', () => {
  const a = scriptIdFor('https://example.com');
  assert.equal(a, scriptIdFor('https://example.com'));
  assert.notEqual(a, scriptIdFor('http://example.com'));
  assert.notEqual(scriptIdFor('https://a.example.com'), scriptIdFor('https://b.example.com'));
  // Origins that differ only in punctuation must not share an id. A dot and a
  // dash are both ordinary in a hostname, and merging them lost one whole site.
  assert.notEqual(scriptIdFor('https://a.example.com'), scriptIdFor('https://a-example.com'));
  // Underscore is safe in the middle. Chrome reserves it only as a first
  // character, and every id here starts with the fixed "uc-" prefix.
  assert.match(a, /^uc-[a-z0-9_]+$/);
});
