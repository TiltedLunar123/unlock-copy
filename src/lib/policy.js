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

  /**
   * Payload handed to the page engine.
   *
   * `mode` is omitted unless the caller genuinely knows it, and the engine only
   * assigns the keys it is given. Only the code doing the injecting knows how a
   * page was reached; a later push updating a switch does not, and stamping a
   * guess onto it is how a late unlock loses the capture net it depends on. The
   * stored "always unlock this site" flag is not that answer either: it says
   * what the next load will do, not how the page in front of the user was
   * already patched.
   */
  function forPage(resolved, mode) {
    const out = {
      enabled: true,
      selection: !!resolved.selection,
      contextmenu: !!resolved.contextmenu,
      keyboard: !!resolved.keyboard,
      cleanCopy: !!resolved.cleanCopy,
      aggressive: !!resolved.aggressive,
    };
    // Absent and wrong are different answers. Absent means "you already know
    // yours, keep it". Wrong means a caller believed it was saying something,
    // so it falls back to late: early claims we beat page script, and claiming
    // that falsely skips the capture net and quietly stops working on the hard
    // cases.
    if (mode !== undefined && mode !== null) out.mode = mode === 'early' ? 'early' : 'late';
    return out;
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

  /**
   * The same payload, for an engine that is already running.
   *
   * An engine knows how its own page was reached better than any later caller
   * does, so a push that is only meant to update switches must not carry a mode
   * at all. Injecting into a tab does both jobs at once, and the mode that is
   * right for a frame with no engine yet is wrong for the frame beside it that
   * already has one.
   */
  function withoutMode(page) {
    const out = Object.assign({}, page);
    delete out.mode;
    return out;
  }

  return { DEFAULTS, FEATURES, resolve, diff, forPage, withoutMode, CSS };
})();
