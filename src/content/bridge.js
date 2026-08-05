/**
 * Unlock Copy - isolated world bridge.
 *
 * Only registered alongside the MAIN world engine on sites the user has chosen
 * to always unlock. The engine cannot read extension storage from the page's
 * world, and this cannot patch the page's prototypes from here, so each does
 * the half it can and they meet over a CustomEvent on document.
 *
 * The engine defaults to everything on, which is the right default given the
 * user explicitly enabled this origin, so a bridge that never answers degrades
 * to "works, ignores your switches" rather than "does nothing".
 */
(() => {
  'use strict';

  const CHANNEL_POLICY = '__unlock-copy-policy';
  const CHANNEL_READY = '__unlock-copy-ready';
  const api = typeof browser !== 'undefined' ? browser : chrome;

  let latest = null;

  /**
   * Hand an object across the world boundary in a form page script can read.
   *
   * On Firefox a content script gets its own compartment, and an object built
   * here reaches page code wrapped in a security membrane that makes its
   * properties unreadable. cloneInto is the documented way across, and it only
   * exists there, so Chromium keeps passing the object straight through.
   *
   * Note this is unverified against a real Firefox build; the end to end suite
   * drives Chromium only. It is written so that being wrong about the platform
   * costs nothing: the clone is skipped where the function does not exist, and
   * a clone that fails falls back to the object that was being sent anyway.
   */
  function shareable(value) {
    if (typeof cloneInto !== 'function') return value;
    try {
      return cloneInto(value, document.defaultView);
    } catch {
      return value;
    }
  }

  function send(policy) {
    if (!policy) return;
    latest = policy;
    try {
      document.dispatchEvent(new CustomEvent(CHANNEL_POLICY, { detail: shareable(policy) }));
    } catch {
      /* page tore down document; nothing to deliver to */
    }
  }

  // The engine announces itself once it is up. It may beat us here or trail us,
  // so answer the announcement and also broadcast unprompted below.
  document.addEventListener(CHANNEL_READY, () => {
    if (latest) send(latest);
  });

  api.runtime
    .sendMessage({ type: 'unlock-copy/policy-for-frame' })
    .then((policy) => {
      // The registration itself is the enable signal for this origin: the
      // background only registers scripts for origins the user turned on.
      send(Object.assign({ enabled: true, mode: 'early' }, policy || {}));

      // A registered content script cannot inject USER origin CSS: that origin
      // is only reachable through scripting.insertCSS, which lives in the
      // background. Without this the page engine handles every listener based
      // block and a plain `user-select: none` still wins, which is the exact
      // half-working behaviour this extension exists to fix.
      //
      // Only the top frame asks, and the background covers all frames in one
      // call, so nested frames do not each trigger their own insert.
      if (policy && policy.selection && window.top === window) {
        api.runtime.sendMessage({ type: 'unlock-copy/ensure-css' }).catch(() => {});
      }
    })
    .catch(() => {
      // Background asleep or mid-update. Defaults already cover this.
    });

  // Site-level changes made in the popup while the tab is open.
  api.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'unlock-copy/policy-changed') return;
    send(Object.assign({ mode: 'early' }, message.policy || {}));
  });
})();
