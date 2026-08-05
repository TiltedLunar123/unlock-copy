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

  /**
   * Tabs unlocked for this session only, used to keep the badge cheap.
   *
   * Not the source of truth. A service worker is evicted whenever the browser
   * feels like it, taking this Set with it while the injected engine carries on
   * running in the page, so anything that reports state to the user asks the
   * page instead. See isEngineActive.
   */
  const sessionTabs = new Set();

  /**
   * Ask the page itself whether the engine is running there.
   *
   * This survives service worker eviction, which an in-memory flag does not,
   * and it cannot drift from reality the way a cached bit can.
   */
  async function isEngineActive(tabId) {
    try {
      const [frame] = await api.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => !!(window.__unlockCopyEngine && window.__unlockCopyEngine.policy.enabled),
      });
      return !!(frame && frame.result);
    } catch {
      // No access to this tab, or it is a page we cannot script. Either way the
      // engine is not running there.
      return false;
    }
  }

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
  /**
   * Insert the selection stylesheet exactly once per tab.
   *
   * The remove is not redundant. A tab collects several inserts over its life:
   * the toolbar unlock, then "always unlock" applying immediately, then every
   * feature toggle. If those stack, the single remove that `lock` performs
   * peels off one layer and leaves the rest, so relocking a page appears to do
   * nothing to selection until a reload. Removing first makes the insert
   * idempotent regardless of how the browser counts them.
   */
  async function applyCss(tabId) {
    const target = { tabId, allFrames: true };
    try {
      await api.scripting.removeCSS({ target, origin: 'USER', css: UC.policy.CSS });
    } catch {
      /* nothing inserted yet, which is the state we wanted */
    }
    await api.scripting.insertCSS({ target, origin: 'USER', css: UC.policy.CSS });
  }

  async function dropCss(tabId) {
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

  async function applyNow(tabId, page) {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (boot, live) => {
        window.__unlockCopyBoot = boot;
        // A frame that already has an engine keeps its own mode. The boot
        // payload is for the frames that do not, and telling a frame unlocked
        // at document_start that it started late trades the wrapping it was
        // built on for the blunt capture net, which drops the page's own copy
        // handlers instead of neutering them.
        if (window.__unlockCopyEngine) window.__unlockCopyEngine.configure(live);
      },
      args: [page, UC.policy.withoutMode(page)],
    });

    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['content/unlock.js'],
    });

    if (page.selection) {
      // USER origin outranks every author rule, including !important ones and
      // inline styles, so the page cannot take selection back.
      await applyCss(tabId);
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
    await dropCss(tabId);
  }

  /* ---------------------------------------------------------------- */
  /* Message handlers                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Whether the browser has granted this extension access to file URLs.
   *
   * Chrome exposes this as a toggle on the extension's own settings page and it
   * is off by default. Firefox has no equivalent, so the check simply reports
   * false there and local files stay refused with an accurate message.
   */
  let fileAccessCache = null;
  function fileAccess() {
    return fileAccessCache === true;
  }

  /**
   * Re-read rather than trusting the cache, on every path that classifies a URL
   * for the user.
   *
   * The setting lives on a browser page this extension never sees change. A
   * cache filled once at startup goes stale the moment the user turns it on,
   * and the visible symptom is the keyboard shortcut silently refusing to
   * unlock a local file that the popup would happily unlock a second later.
   */
  async function refreshFileAccess() {
    try {
      fileAccessCache = await api.extension.isAllowedFileSchemeAccess();
    } catch {
      fileAccessCache = false;
    }
    return fileAccess();
  }
  refreshFileAccess();

  async function getState(tab) {
    await refreshFileAccess();
    const info = UC.origins.classify(tab && tab.url, { fileAccess: fileAccess() });
    if (!info.ok) {
      return { ok: false, reason: info.reason, message: UC.origins.messageFor(info.reason) };
    }

    const entry = await UC.settings.siteEntry(info.origin);
    let granted = false;
    try {
      granted = info.local
        ? false
        : await api.permissions.contains({
            origins: [UC.origins.patternFor(info.origin)],
          });
    } catch {
      granted = false;
    }

    return {
      ok: true,
      origin: info.origin,
      host: info.host,
      // A local file has no origin a permission can be scoped to, so the popup
      // offers the one-click unlock and explains why the toggle is missing
      // rather than showing one whose request would be rejected.
      local: !!info.local,
      // "always" is only true when the grant actually exists. Reporting a site
      // as remembered while the permission is gone is the lie that makes users
      // think the extension is broken.
      always: entry.always && granted,
      pendingGrant: entry.always && !granted,
      sessionActive: await isEngineActive(tab.id),
      features: entry.resolved,
      defaults: entry.defaults,
    };
  }

  async function unlockOnce(tab) {
    await refreshFileAccess();
    const info = UC.origins.classify(tab && tab.url, { fileAccess: fileAccess() });
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
    await refreshFileAccess();
    const info = UC.origins.classify(tab && tab.url, { fileAccess: fileAccess() });
    if (!info.ok) return { ok: false, reason: info.reason };
    // A local file has no origin a permission can be scoped to. The popup
    // disables the toggle, but a disabled control is a UI convention rather
    // than a guarantee, and the pattern built from `file://` is not one the
    // browser accepts.
    if (info.local) return { ok: false, reason: 'local-file' };

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

  /**
   * Push a policy into one tab, both worlds, so a switch takes effect without a
   * reload. No `mode`: see UC.policy.forPage for why the caller must not guess
   * one for a page that is already running.
   */
  async function pushToTab(tabId, page) {
    try {
      await api.scripting.executeScript({
        target: { tabId, allFrames: true },
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
      await api.tabs.sendMessage(tabId, { type: 'unlock-copy/policy-changed', policy: page });
    } catch {
      /* no bridge in this tab */
    }
    // Whether the stylesheet belongs on this tab is a question about the tab,
    // not about the switch. Answering it from page.selection alone re-applied
    // the unlock CSS to every tab this reaches on any settings change, which
    // includes tabs the user had just relocked and tabs that were never
    // unlocked at all but still hold a live activeTab grant. Changing a switch
    // must not unlock anything.
    const running = await isEngineActive(tabId);
    if (running && page.selection) {
      try {
        await applyCss(tabId);
      } catch {
        /* no access to this tab right now */
      }
    } else {
      await dropCss(tabId);
    }
  }

  /**
   * Push the current policy to every tab we can reach.
   *
   * Aiming this at the active tab alone looks sufficient and is not, because
   * the options page opens in its own tab: changing a global default there
   * leaves the active tab as an extension page that classifies as unscriptable,
   * so the change reaches nothing at all and every unlocked tab keeps the old
   * switches until it is reloaded. Storage is read once and resolved per origin
   * here, so a site with its own overrides still gets its own answer.
   */
  async function broadcastPolicy() {
    // Same fresh read every other entry point does. classify() refuses a
    // file:// tab when this says false, and on a cold worker the cache is
    // still null, so a grant the user really holds read as absent.
    await refreshFileAccess();
    let tabs = [];
    try {
      tabs = await api.tabs.query({});
    } catch {
      return;
    }
    const { defaults, sites } = await UC.settings.readAll();
    const pushes = [];
    for (const target of tabs) {
      const info = UC.origins.classify(target.url, { fileAccess: fileAccess() });
      if (!info.ok) continue;
      const entry = sites[info.origin] || {};
      const page = UC.policy.forPage(UC.policy.resolve(defaults, entry.overrides));
      // In parallel, because the popup waits on this before it redraws and a
      // user with forty tabs open should not watch a switch hang. pushToTab
      // swallows its own failures, so none of these can reject the batch.
      pushes.push(pushToTab(target.id, page));
    }
    await Promise.all(pushes);
  }

  async function setFeature(tab, feature, value, scope) {
    if (UC.policy.FEATURES.indexOf(feature) === -1) return { ok: false, reason: 'unknown-feature' };
    await refreshFileAccess();

    if (scope === 'global') {
      await UC.settings.writeDefaults({ [feature]: !!value });
    } else {
      const info = UC.origins.classify(tab && tab.url, { fileAccess: fileAccess() });
      if (!info.ok) return { ok: false, reason: info.reason };
      const entry = await UC.settings.siteEntry(info.origin);
      const resolved = Object.assign({}, entry.resolved, { [feature]: !!value });
      await UC.settings.writeSite(info.origin, {
        overrides: UC.policy.diff(entry.defaults, resolved),
      });
    }

    await broadcastPolicy();
    return { ok: true };
  }

  /**
   * Drop a site from the always-unlock list, and give back its permission.
   *
   * Lives here rather than in the options page so that every storage mutation
   * happens in one context and the settings queue can serialise them.
   */
  async function forgetSite(origin) {
    if (!origin) return { ok: false, reason: 'no-origin' };
    await UC.settings.writeSite(origin, { always: false });
    try {
      await api.permissions.remove({ origins: [UC.origins.patternFor(origin)] });
    } catch {
      /* already revoked, which is the state we wanted anyway */
    }
    await UC.registry.reconcile();
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
      // Through applyCss rather than a bare insert, so this shares the
      // remove-then-insert that makes every other insertion path idempotent.
      // A lone insert was the one route left that could stack a second copy of
      // the stylesheet onto a tab, and a single remove only peels off one.
      await applyCss(sender.tab.id);
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
    // The bridge only exists on origins the user chose to always unlock, so it
    // reporting in is proof the engine is running here. Nothing else paints the
    // badge on this path, and onUpdated clears it on every load, so without
    // this the sites that are permanently unlocked are the ones whose badge is
    // permanently blank.
    if (sender && sender.tab && !sender.frameId) paintBadge(sender.tab.id, true);

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
    'unlock-copy/forget-site': (msg) => forgetSite(msg.origin),
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

  // A session unlock dies with the document it patched, and a reload makes a new
  // document even though the URL never changed. Gating this on changeInfo.url
  // being present misses exactly that case, which leaves the badge reading ON
  // over a page where copying is blocked again.
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
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
    pushToTab,
    broadcastPolicy,
  };

  const command = api.commands;
  if (command && command.onCommand) {
    command.onCommand.addListener(async (name) => {
      if (name !== 'toggle-unlock') return;
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      // Ask the page rather than the Set: after a worker eviction the Set is
      // empty while the page is still unlocked, and the shortcut would then
      // unlock an already unlocked page instead of relocking it.
      if (await isEngineActive(tab.id)) await lock(tab);
      else await unlockOnce(tab);
    });
  }
})();
