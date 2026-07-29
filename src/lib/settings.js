/**
 * storage.sync wrapper.
 *
 * Shape:
 *   defaults  - global feature switches
 *   sites     - { [origin]: { always: boolean, overrides: {...} } }
 *
 * Only origins the user has actually touched appear, so a fresh profile syncs
 * nothing and the quota stays far away.
 */
UC.settings = (function () {
  'use strict';

  const KEY_DEFAULTS = 'defaults';
  const KEY_SITES = 'sites';

  async function readAll() {
    try {
      const raw = await UC.api.storage.sync.get([KEY_DEFAULTS, KEY_SITES]);
      return {
        defaults: Object.assign({}, UC.policy.DEFAULTS, raw[KEY_DEFAULTS] || {}),
        sites: raw[KEY_SITES] || {},
      };
    } catch {
      // A profile with sync disabled or over quota must still work locally.
      return { defaults: Object.assign({}, UC.policy.DEFAULTS), sites: {} };
    }
  }

  async function siteEntry(origin) {
    const { defaults, sites } = await readAll();
    const entry = sites[origin] || {};
    return {
      defaults,
      always: !!entry.always,
      overrides: entry.overrides || {},
      resolved: UC.policy.resolve(defaults, entry.overrides),
    };
  }

  async function writeSite(origin, patch) {
    const { sites } = await readAll();
    const next = Object.assign({}, sites[origin] || {}, patch);
    // Drop entries that carry no information rather than accumulating them.
    if (!next.always && (!next.overrides || Object.keys(next.overrides).length === 0)) {
      delete sites[origin];
    } else {
      sites[origin] = next;
    }
    await UC.api.storage.sync.set({ [KEY_SITES]: sites });
    return sites;
  }

  async function writeDefaults(patch) {
    const { defaults } = await readAll();
    const next = Object.assign({}, defaults, patch);
    await UC.api.storage.sync.set({ [KEY_DEFAULTS]: next });
    return next;
  }

  async function alwaysOrigins() {
    const { sites } = await readAll();
    return Object.keys(sites).filter((origin) => sites[origin] && sites[origin].always);
  }

  return { readAll, siteEntry, writeSite, writeDefaults, alwaysOrigins };
})();
