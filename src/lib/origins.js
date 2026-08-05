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
   *
   * @param {string} url
   * @param {{fileAccess?: boolean}} [options] whether the browser has granted
   *   this extension access to file URLs. Refusing every file:// page even when
   *   the user has turned that on would be wrong, and the popup would keep
   *   telling them to enable a setting they already enabled.
   * @returns {{ok: boolean, reason?: string, origin?: string, host?: string,
   *   pattern?: string, local?: boolean}}
   */
  /**
   * A readable name for a local file, whatever it is called.
   *
   * A file name may contain a bare percent sign, the URL parser leaves it in
   * the path, and decodeURIComponent throws URIError on it. That throw escaped
   * classify and took its caller with it: the popup showed the user a raw "URI
   * malformed", and a policy broadcast gave up partway through its tab list, so
   * one oddly named local file left every other open tab on the old settings.
   */
  function fileLabel(pathname) {
    const raw = String(pathname || '')
      .split('/')
      .pop();
    try {
      return decodeURIComponent(raw) || 'Local file';
    } catch {
      return raw || 'Local file';
    }
  }

  function classify(url, options) {
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
      if (!options || !options.fileAccess) return { ok: false, reason: 'file' };
      // Local files have no origin to scope a permission to, so they get the
      // one-click unlock only. `local` tells the popup to say that rather than
      // offering a toggle whose request would be rejected.
      return {
        ok: true,
        local: true,
        origin: 'file://',
        host: fileLabel(parsed.pathname),
        pattern: 'file:///*',
      };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'unsupported' };
    }
    // The built-in PDF viewer is a native plugin, not a document we can touch.
    //
    // Only the path decides. Testing the query string too looks harmless and is
    // not: `?file=report.pdf` is the standard way an ordinary HTML viewer page
    // names the document it is displaying, so including the search refused
    // exactly the pages that can be unlocked, and it caught plain search results
    // like `?q=cheatsheet.pdf` as well.
    if (/\.pdf$/i.test(parsed.pathname)) {
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
    // A scheme-only origin has no host to trim back to. `file://` is the one
    // that reaches here, and stripping its slashes yields `file:/*`, which is
    // not a valid match pattern: every permissions call built from it throws
    // and the caller reads the throw as "not granted".
    if (/^[a-z][a-z0-9+.-]*:\/\/$/i.test(origin)) return origin + '/*';
    return origin.replace(/\/+$/, '') + '/*';
  }

  /**
   * Content script registration ids: stable, filesystem-safe, and distinct for
   * distinct origins.
   *
   * Collapsing every run of punctuation into one dash reads better and is not
   * injective. `https://docs.google.com` and `https://docs-google.com` are both
   * ordinary origins and both sanitise to `https-docs-google-com`, so the two
   * share one pair of ids: the reconciler sees the second as already registered,
   * never registers it, and the popup goes on reporting it as always unlocked
   * while no content script ever runs there.
   *
   * Encoding each character it cannot keep, rather than merging runs of them,
   * makes the mapping reversible, and a reversible mapping cannot collide.
   */
  function scriptIdFor(origin) {
    return (
      'uc-' +
      String(origin).replace(/[^a-z0-9]/g, (c) => '_' + c.charCodeAt(0).toString(36) + '_')
    );
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
