/**
 * URL classification and match-pattern construction.
 *
 * Kept free of any extension API so the logic can be unit tested in plain node,
 * which matters because getting a match pattern subtly wrong shows up as a
 * permission prompt the user cannot grant rather than as an exception.
 */
UC.origins = (function () {
  'use strict';

  /**
   * Pages no extension can script. Each one needs its own message in the popup,
   * because "it didn't work" with no explanation is the single most common
   * complaint about every extension in this category.
   */
  const BLOCKED = [
    { test: /^chrome:\/\//i, reason: 'browser-page' },
    { test: /^edge:\/\//i, reason: 'browser-page' },
    { test: /^about:/i, reason: 'browser-page' },
    { test: /^moz-extension:\/\//i, reason: 'browser-page' },
    { test: /^chrome-extension:\/\//i, reason: 'browser-page' },
    { test: /^devtools:\/\//i, reason: 'browser-page' },
    { test: /^view-source:/i, reason: 'browser-page' },
    { test: /^https?:\/\/chromewebstore\.google\.com/i, reason: 'web-store' },
    { test: /^https?:\/\/chrome\.google\.com\/webstore/i, reason: 'web-store' },
    { test: /^https?:\/\/addons\.mozilla\.org/i, reason: 'web-store' },
    { test: /^https?:\/\/microsoftedge\.microsoft\.com\/addons/i, reason: 'web-store' },
  ];

  /**
   * Classify a tab URL.
   * @returns {{ok: boolean, reason?: string, origin?: string, host?: string, pattern?: string}}
   */
  function classify(url) {
    if (!url) return { ok: false, reason: 'no-tab' };

    for (const entry of BLOCKED) {
      if (entry.test.test(url)) return { ok: false, reason: entry.reason };
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'unsupported' };
    }

    if (parsed.protocol === 'file:') {
      return { ok: false, reason: 'file' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'unsupported' };
    }
    // The built-in PDF viewer is a native plugin, not a document we can touch.
    if (/\.pdf($|\?|#)/i.test(parsed.pathname + parsed.search)) {
      return { ok: false, reason: 'pdf' };
    }

    return {
      ok: true,
      origin: parsed.origin,
      host: parsed.hostname,
      pattern: parsed.origin + '/*',
    };
  }

  /**
   * Match pattern for an origin. Deliberately origin-scoped rather than
   * host-scoped: granting https://example.com/* must not silently also grant
   * http://example.com/*.
   */
  function patternFor(origin) {
    return origin.replace(/\/+$/, '') + '/*';
  }

  /** Content script registration ids have to be stable and filesystem-safe. */
  function scriptIdFor(origin) {
    return 'uc-' + origin.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }

  const MESSAGES = {
    'browser-page': "Browser pages can't be unlocked.",
    'web-store': 'The extension store blocks extensions here.',
    pdf: "The built-in PDF viewer can't be unlocked.",
    file: 'Turn on "Allow access to file URLs" in this extension\'s settings.',
    'no-tab': 'No active tab.',
    unsupported: "This page can't be unlocked.",
  };

  function messageFor(reason) {
    return MESSAGES[reason] || MESSAGES.unsupported;
  }

  return { classify, patternFor, scriptIdFor, messageFor, BLOCKED };
})();
