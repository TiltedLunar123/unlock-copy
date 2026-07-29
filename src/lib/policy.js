/**
 * Feature flags and how they resolve per site.
 *
 * Pure functions only, no storage and no extension API, so the resolution rules
 * are unit testable. The rules are small but they are the thing that decides
 * whether a switch the user flipped actually reaches the page.
 */
UC.policy = (function () {
  'use strict';

  /** Everything on. A user who installed this wants it to work, not to configure it. */
  const DEFAULTS = Object.freeze({
    selection: true,
    contextmenu: true,
    keyboard: true,
    cleanCopy: true,
    aggressive: false,
  });

  const FEATURES = Object.keys(DEFAULTS);

  /**
   * Merge global defaults with any per-site overrides.
   * @param {object} globals user's default switches
   * @param {object} siteOverrides sparse, only keys the user changed for this site
   */
  function resolve(globals, siteOverrides) {
    const out = {};
    for (const key of FEATURES) {
      if (siteOverrides && key in siteOverrides) out[key] = !!siteOverrides[key];
      else if (globals && key in globals) out[key] = !!globals[key];
      else out[key] = DEFAULTS[key];
    }
    return out;
  }

  /** Only store what differs from the global default, so changing a default later still propagates. */
  function diff(globals, resolved) {
    const base = resolve(globals, null);
    const out = {};
    for (const key of FEATURES) {
      if (resolved[key] !== base[key]) out[key] = resolved[key];
    }
    return out;
  }

  /** Payload handed to the page engine. */
  function forPage(resolved, mode) {
    return {
      enabled: true,
      selection: !!resolved.selection,
      contextmenu: !!resolved.contextmenu,
      keyboard: !!resolved.keyboard,
      cleanCopy: !!resolved.cleanCopy,
      aggressive: !!resolved.aggressive,
      mode: mode === 'early' ? 'early' : 'late',
    };
  }

  /**
   * CSS is only worth injecting when selection is unlocked. It is applied in the
   * USER origin, which outranks every author rule including !important ones and
   * inline styles, so the page cannot win it back and no observer is needed.
   */
  const CSS = [
    '*,*::before,*::after{',
    'user-select:text !important;',
    '-webkit-user-select:text !important;',
    '-webkit-touch-callout:default !important;',
    '}',
    '::selection{background-color:Highlight !important;color:HighlightText !important;}',
  ].join('');

  return { DEFAULTS, FEATURES, resolve, diff, forPage, CSS };
})();
