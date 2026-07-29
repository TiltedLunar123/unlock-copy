/**
 * Keeps three independent sources of truth agreeing with each other:
 *
 *   1. storage.sync   - which origins the user asked to always unlock
 *   2. permissions    - which origins the browser actually granted
 *   3. registrations  - which content scripts are currently registered
 *
 * All three drift in normal use. The user can revoke a host permission from the
 * browser's own extension UI without telling us. A synced profile arrives on a
 * second machine carrying origins that were never granted there. An update can
 * clear dynamic registrations. Whenever they disagree, permissions win: they are
 * the only one the user controls directly and the only one that can fail.
 *
 * The pure decision is separated from the effects so it can be unit tested,
 * because a reconciler that silently does the wrong thing produces a popup that
 * claims a site is unlocked when it is not.
 */
UC.registry = (function () {
  'use strict';

  const SCRIPTS = [
    { file: 'content/unlock.js', world: 'MAIN' },
    { file: 'content/bridge.js', world: 'ISOLATED' },
  ];

  /**
   * Registration ids for one origin.
   *
   * The two ids differ by prefix rather than by suffix. A suffix collides: an
   * origin literally named `https://a.example-bridge` sanitises to the same
   * string as `https://a.example` plus a `-bridge` suffix, and the second
   * registration would then silently overwrite the first. A prefix cannot
   * collide, because a sanitised origin always begins with its scheme.
   */
  function idsFor(origin) {
    const slug = UC.origins.scriptIdFor(origin).slice(3);
    return { main: 'uc-' + slug, bridge: 'ucb-' + slug };
  }

  /** True for ids this extension owns, in either world. */
  function isOurs(id) {
    return id.startsWith('uc-') || id.startsWith('ucb-');
  }

  /**
   * Decide what to register and unregister.
   *
   * @param {string[]} wanted origins the user asked for
   * @param {string[]} granted origins the browser has granted
   * @param {string[]} registeredIds script ids currently registered
   * @returns {{register: string[], unregister: string[], stale: string[]}}
   *   `stale` is origins the user wants but has not granted, which the popup
   *   must show as off rather than pretending they are on.
   */
  function plan(wanted, granted, registeredIds) {
    const grantedSet = new Set(granted);
    const registered = new Set(registeredIds);

    const active = wanted.filter((origin) => grantedSet.has(origin));
    const stale = wanted.filter((origin) => !grantedSet.has(origin));

    const wantedIds = new Set();
    for (const origin of active) {
      const ids = idsFor(origin);
      wantedIds.add(ids.main);
      wantedIds.add(ids.bridge);
    }

    // An origin counts as registered only when both worlds are present. A
    // half-registered origin means the page gets patched but never learns the
    // user's switches, so it is cheaper to re-register than to detect and
    // repair the half.
    const register = active.filter((origin) => {
      const ids = idsFor(origin);
      return !registered.has(ids.main) || !registered.has(ids.bridge);
    });

    const unregister = [...registered].filter((id) => isOurs(id) && !wantedIds.has(id));

    return { register, unregister, stale };
  }

  /** The registration objects for one origin, one per world. */
  function registrationsFor(origin) {
    const pattern = UC.origins.patternFor(origin);
    const ids = idsFor(origin);
    return SCRIPTS.map((script, index) => ({
      id: index === 0 ? ids.main : ids.bridge,
      matches: [pattern],
      js: [script.file],
      world: script.world,
      // document_start is the entire reason this path exists. Any later and
      // page script has already registered the listeners we mean to wrap.
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    }));
  }

  async function grantedOrigins(wanted) {
    const out = [];
    for (const origin of wanted) {
      try {
        const has = await UC.api.permissions.contains({
          origins: [UC.origins.patternFor(origin)],
        });
        if (has) out.push(origin);
      } catch {
        /* treat an unanswerable check as not granted; failing closed is honest */
      }
    }
    return out;
  }

  async function currentIds() {
    try {
      const scripts = await UC.api.scripting.getRegisteredContentScripts();
      return scripts.map((s) => s.id);
    } catch {
      return [];
    }
  }

  /** Bring registrations in line with storage and permissions. */
  async function reconcile() {
    const wanted = await UC.settings.alwaysOrigins();
    const granted = await grantedOrigins(wanted);
    const ids = await currentIds();
    const decision = plan(wanted, granted, ids);

    if (decision.unregister.length) {
      try {
        await UC.api.scripting.unregisterContentScripts({ ids: decision.unregister });
      } catch {
        /* an id that vanished under us is already in the desired state */
      }
    }

    for (const origin of decision.register) {
      // A half-registered origin has to be cleared first: registering an id
      // that already exists rejects the whole call, which would leave the
      // origin stuck in the broken half forever.
      const own = idsFor(origin);
      const leftovers = ids.filter((id) => id === own.main || id === own.bridge);
      if (leftovers.length) {
        try {
          await UC.api.scripting.unregisterContentScripts({ ids: leftovers });
        } catch {
          /* nothing there after all */
        }
      }
      try {
        await UC.api.scripting.registerContentScripts(registrationsFor(origin));
      } catch {
        // Registration requires the host permission to already be held. If it
        // is not, this origin simply stays off and the popup reports it.
      }
    }

    return decision;
  }

  return { plan, registrationsFor, reconcile, SCRIPTS };
})();
