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

  /**
   * Every mutation is a read-modify-write over the whole `sites` object, so two
   * of them in flight at once means the second overwrites the first's change
   * rather than merging with it. Flipping two switches quickly, or having the
   * popup and the options page both open, is enough to trigger it.
   *
   * Chaining them costs nothing at this volume and removes the race entirely,
   * provided every write goes through here. That is why the options page sends
   * messages to the background instead of writing storage itself.
   */
  let queue = Promise.resolve();

  function serialize(work) {
    const run = queue.then(work, work);
    // Keep the chain alive even when one link rejects, or a single failed write
    // would wedge every write after it.
    queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

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

  function writeSite(origin, patch) {
    return serialize(async () => {
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
    });
  }

  function writeDefaults(patch) {
    return serialize(async () => {
      const { defaults } = await readAll();
      const next = Object.assign({}, defaults, patch);
      await UC.api.storage.sync.set({ [KEY_DEFAULTS]: next });
      return next;
    });
  }

  async function alwaysOrigins() {
    const { sites } = await readAll();
    return Object.keys(sites).filter((origin) => sites[origin] && sites[origin].always);
  }

  return { readAll, siteEntry, writeSite, writeDefaults, alwaysOrigins };
})();
