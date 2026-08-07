import assert from 'node:assert/strict';
import test from 'node:test';

import { blankCommentsAndStrings } from '../tools/build.mjs';

/**
 * The release gate promises that no shipped source reaches the network. It
 * proves that by blanking comments and string literals and then scanning what is
 * left for fetch, XMLHttpRequest and friends, so a call has to be real code to
 * count. Everything below is about what that blanker can and cannot see.
 */

const netCall = /\bfetch\s*\(/;

test('a regex literal does not blind the scanner for the rest of the line', () => {
  // The escaped slashes in a pattern like this end in the sequence `//`, and
  // the scanner read that as the start of a line comment and blanked to the end
  // of the line. Anything sharing the line was then invisible, so the one gate
  // standing between this extension and a privacy claim it makes on the store
  // listing could be stepped around by putting a call after a URL pattern.
  // This is the shape src/lib/origins.js actually ships: the pattern ends
  // immediately after an escaped slash, so its last two characters really are
  // `//`. Put a call after one and the gate could not see it.
  const source = String.raw`{ test: /^https?:\/\//i, reason: 'x' }; fetch(url);`;
  assert.match(blankCommentsAndStrings(source), netCall);
});

test('a regex containing a quote does not swallow the line', () => {
  // The blanker treats a quote as opening a string. Inside a character class it
  // is just a character, and reading it as a string start blanked past it.
  const source = String.raw`const quoted = /['"]/g; fetch(url);`;
  assert.match(blankCommentsAndStrings(source), netCall);
});

test('a regex after return is still a regex', () => {
  const source = String.raw`function f() { return /a\/b/.test(x); } fetch(url);`;
  assert.match(blankCommentsAndStrings(source), netCall);
});

test('a division is not mistaken for a regex', () => {
  // The mirror of the above. Reading `a / b` as a regex would blank forward to
  // the next slash and hide whatever sat in between.
  const source = 'const ratio = width / height; fetch(url);';
  assert.match(blankCommentsAndStrings(source), netCall);
});

test('a call inside a line comment is still ignored', () => {
  const source = '// fetch(url) is deliberately not called here\nconst x = 1;';
  assert.doesNotMatch(blankCommentsAndStrings(source), netCall);
});

test('a call inside a block comment is still ignored', () => {
  const source = '/* nothing here calls fetch(url) */\nconst x = 1;';
  assert.doesNotMatch(blankCommentsAndStrings(source), netCall);
});

test('a call inside a string is still ignored', () => {
  const source = 'const note = "we never call fetch(url)";';
  assert.doesNotMatch(blankCommentsAndStrings(source), netCall);
});

test('blanking preserves offsets so reported line numbers stay right', () => {
  // The gate reports a hit by counting newlines up to the match offset, so the
  // blanked copy has to be the same length and keep its line breaks.
  const source = 'const a = 1;\n// comment\nconst b = "text";\nfetch(url);';
  const blanked = blankCommentsAndStrings(source);
  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split('\n').length, source.split('\n').length);
  assert.equal(blanked.slice(0, blanked.search(netCall)).split('\n').length, 4);
});
