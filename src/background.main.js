/**
 * Unlock Copy - background.
 *
 * Owns two jobs: apply the one-shot unlock to the active tab under activeTab,
 * and manage the per-origin permission plus content script registration that
 * makes an unlock survive reloads.
 */
(() => {
  'use strict';

  const api = UC.api;

  /* ---------------------------------------------------------------- */
  /* Badge                                                             */
  /* ---------------------------------------------------------------- */

  /** Tabs unlocked for this session only. Cleared when the tab navigates. */
  const sessionTabs = new Set();

  async function paintBadge(tabId, on) {
    try {
      await api.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
      if (on) {
        await api.action.setBadgeBackgroundColor({ tabId, color: '#1f8b4c' });
      }
    } catch {
      /* the tab closed between the decision and the paint */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Applying the unlock                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Inject the engine into a tab right now, using whatever access we have.
   *
   * The boot payload goes in first as a separate injection so the engine sees
   * its policy on the very first statement it runs, rather than starting on
   * defaults and being corrected a round trip later.
   */
  async function applyNow(tabId, page) {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (policy) => {
        window.__unlockCopyBoot = policy;
        if (window.__unlockCopyEngine) window.__unlockCopyEngine.configure(policy);
      },
      args: [page],
    });

    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['content/unlock.js'],
    });

    if (page.selection) {
      // USER origin outranks every author rule, including !important ones and
      // inline styles, so the page cannot take selection back.
      await api.scripting.insertCSS({
        target: { tabId, allFrames: true },
        origin: 'USER',
        css: UC.policy.CSS,
      });
    }
  }

  async function removeNow(tabId) {
    try {
      await api.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: () => {
          if (window.__unlockCopyEngine) window.__unlockCopyEngine.disable();
        },
      });
    } catch {
      /* nothing injected there in the first place */
    }
    try {
      await api.scripting.removeCSS({
        target: { tabId, allFrames: true },
        origin: 'USER',
        css: UC.policy.CSS,
      });
    } catch {
      /* the stylesheet was never inserted */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Message handlers                                                  */
  /* ---------------------------------------------------------------- */

  async function getState(tab) {
    const info = UC.origins.classify(tab && tab.url);
    if (!info.ok) {
      return { ok: false, reason: info.reason, message: UC.origins.messageFor(info.reason) };
    }

    const entry = await UC.settings.siteEntry(info.origin);
    let granted = false;
    try {
      granted = await api.permissions.contains({
        origins: [UC.origins.patternFor(info.origin)],
      });
    } catch {
      granted = false;
    }

    return {
      ok: true,
      origin: info.origin,
      host: info.host,
      // "always" is only true when the grant actually exists. Reporting a site
      // as remembered while the permission is gone is the lie that makes users
      // think the extension is broken.
      always: entry.always && granted,
      pendingGrant: entry.always && !granted,
      sessionActive: sessionTabs.has(tab.id),
      features: entry.resolved,
      defaults: entry.defaults,
    };
  }

  async function unlockOnce(tab) {
    const info = UC.origins.classify(tab && tab.url);
    if (!info.ok) return { ok: false, reason: info.reason };

    const entry = await UC.settings.siteEntry(info.origin);
    await applyNow(tab.id, UC.policy.forPage(entry.resolved, 'late'));
    sessionTabs.add(tab.id);
    await paintBadge(tab.id, true);
    return { ok: true };
  }

  async function lock(tab) {
    await removeNow(tab.id);
    sessionTabs.delete(tab.id);
    await paintBadge(tab.id, false);
    return { ok: true };
  }

  /**
   * Turn "always unlock" on for an origin.
   *
   * The permission request has to originate from the popup's click handler in
   * Firefox, so the popup asks first and only calls this once it holds the
   * grant. This function verifies rather than trusting.
   */
  async function setAlways(tab, always) {
    const info = UC.origins.classify(tab && tab.url);
    if (!info.ok) return { ok: false, reason: info.reason };

    const pattern = UC.origins.patternFor(info.origin);

    if (!always) {
      await UC.settings.writeSite(info.origin, { always: false });
      try {
        await api.permissions.remove({ origins: [pattern] });
      } catch {
        /* already revoked */
      }
      await UC.registry.reconcile();
      return { ok: true, always: false };
    }

    let granted = false;
    try {
      granted = await api.permissions.contains({ origins: [pattern] });
    } catch {
      granted = false;
    }
    if (!granted) return { ok: false, reason: 'permission-denied' };

    await UC.settings.writeSite(info.origin, { always: true });
    await UC.registry.reconcile();

    // The registration only takes effect on the next load, so unlock the page
    // in front of the user right now as well.
    await unlockOnce(tab);
    return { ok: true, always: true };
  }

  async function setFeature(tab, feature, value, scope) {
    if (UC.policy.FEATURES.indexOf(feature) === -1) return { ok: false, reason: 'unknown-feature' };

    if (scope === 'global') {
      await UC.settings.writeDefaults({ [feature]: !!value });
    } else {
      const info = UC.origins.classify(tab && tab.url);
      if (!info.ok) return { ok: false, reason: info.reason };
      const entry = await UC.settings.siteEntry(info.origin);
      const resolved = Object.assign({}, entry.resolved, { [feature]: !!value });
      await UC.settings.writeSite(info.origin, {
        overrides: UC.policy.diff(entry.defaults, resolved),
      });
    }

    // Push the change to a tab that is already unlocked, both worlds, so the
    // switch takes effect without a reload.
    const info = UC.origins.classify(tab && tab.url);
    if (info.ok) {
      const entry = await UC.settings.siteEntry(info.origin);
      const page = UC.policy.forPage(entry.resolved, entry.always ? 'early' : 'late');
      try {
        await api.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: 'MAIN',
          func: (policy) => {
            if (window.__unlockCopyEngine) window.__unlockCopyEngine.configure(policy);
          },
          args: [page],
        });
      } catch {
        /* tab was never unlocked; the next unlock picks the new value up */
      }
      try {
        await api.tabs.sendMessage(tab.id, { type: 'unlock-copy/policy-changed', policy: page });
      } catch {
        /* no bridge in this tab */
      }
      if (page.selection) {
        try {
          await api.scripting.insertCSS({
            target: { tabId: tab.id, allFrames: true },
            origin: 'USER',
            css: UC.policy.CSS,
          });
        } catch {
          /* no access to this tab right now */
        }
      } else {
        try {
          await api.scripting.removeCSS({
            target: { tabId: tab.id, allFrames: true },
            origin: 'USER',
            css: UC.policy.CSS,
          });
        } catch {
          /* nothing to remove */
        }
      }
    }

    return { ok: true };
  }

  /**
   * Apply the USER origin stylesheet for a tab that got its engine from a
   * registered content script rather than from the toolbar button.
   *
   * Registered content scripts can only carry author origin CSS, and author CSS
   * loses to the page's own !important rules and to inline styles. USER origin
   * outranks all of them, and it is only reachable from here.
   */
  async function ensureCss(sender) {
    if (!sender || !sender.tab) return { ok: false, reason: 'no-tab' };
    try {
      await api.scripting.insertCSS({
        target: { tabId: sender.tab.id, allFrames: true },
        origin: 'USER',
        css: UC.policy.CSS,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'insert-failed', message: String(error && error.message) };
    }
  }

  /**
   * Answers the bridge running on an always-unlocked site. The bridge has no
   * tab id of its own, so the origin comes from the sender.
   */
  async function policyForFrame(sender) {
    let origin = '';
    try {
      origin = new URL(sender.url || (sender.tab && sender.tab.url) || '').origin;
    } catch {
      return UC.policy.forPage(UC.policy.DEFAULTS, 'early');
    }
    const entry = await UC.settings.siteEntry(origin);
    return UC.policy.forPage(entry.resolved, 'early');
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  const HANDLERS = {
    'unlock-copy/state': (msg, sender, tab) => getState(tab),
    'unlock-copy/unlock': (msg, sender, tab) => unlockOnce(tab),
    'unlock-copy/lock': (msg, sender, tab) => lock(tab),
    'unlock-copy/set-always': (msg, sender, tab) => setAlways(tab, msg.value),
    'unlock-copy/set-feature': (msg, sender, tab) =>
      setFeature(tab, msg.feature, msg.value, msg.scope),
    'unlock-copy/policy-for-frame': (msg, sender) => policyForFrame(sender),
    'unlock-copy/ensure-css': (msg, sender) => ensureCss(sender),
    'unlock-copy/reconcile': () => UC.registry.reconcile(),
  };

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = message && HANDLERS[message.type];
    if (!handler) return false;

    (async () => {
      let tab = sender.tab;
      if (!tab) {
        // Popup messages carry no tab, so resolve the active one.
        const [active] = await api.tabs.query({ active: true, currentWindow: true });
        tab = active;
      }
      try {
        sendResponse(await handler(message, sender, tab));
      } catch (error) {
        sendResponse({ ok: false, reason: 'error', message: String(error && error.message) });
      }
    })();

    return true;
  });

  // A session unlock dies with the document it patched.
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && changeInfo.url !== undefined) {
      sessionTabs.delete(tabId);
      paintBadge(tabId, false);
    }
  });
  api.tabs.onRemoved.addListener((tabId) => sessionTabs.delete(tabId));

  // Revoking a host permission from the browser's own UI has to turn the site
  // off here too, otherwise the popup keeps claiming it is on.
  if (api.permissions.onRemoved) {
    api.permissions.onRemoved.addListener(() => UC.registry.reconcile());
  }
  if (api.permissions.onAdded) {
    api.permissions.onAdded.addListener(() => UC.registry.reconcile());
  }

  api.runtime.onInstalled.addListener(() => UC.registry.reconcile());
  api.runtime.onStartup.addListener(() => UC.registry.reconcile());

  // Exposed for the same reason every other module hangs off UC: so the end to
  // end harness drives the real operations rather than a reimplementation of
  // them that can quietly drift out of step with this file.
  UC.background = {
    applyNow,
    removeNow,
    getState,
    unlockOnce,
    lock,
    setAlways,
    setFeature,
    policyForFrame,
  };

  const command = api.commands;
  if (command && command.onCommand) {
    command.onCommand.addListener(async (name) => {
      if (name !== 'toggle-unlock') return;
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      if (sessionTabs.has(tab.id)) await lock(tab);
      else await unlockOnce(tab);
    });
  }
})();
