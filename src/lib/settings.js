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

  /**
   * `ok` is not decoration. The fallback for a failed read is an empty site
   * list, which is a fine answer for a reader (fall back to defaults) and a
   * catastrophic one for a writer: every mutation here is a read-modify-write
   * over the whole `sites` object, so merging a patch into `{}` and storing it
   * deletes every other origin the user had saved. Writers check this.
   */
  async function readAll() {
    try {
      const raw = await UC.api.storage.sync.get([KEY_DEFAULTS, KEY_SITES]);
      return {
        ok: true,
        defaults: Object.assign({}, UC.policy.DEFAULTS, raw[KEY_DEFAULTS] || {}),
        sites: raw[KEY_SITES] || {},
      };
    } catch {
      // A profile with sync disabled or over quota must still work locally.
      return { ok: false, defaults: Object.assign({}, UC.policy.DEFAULTS), sites: {} };
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
      const state = await readAll();
      // Refusing loudly beats writing a truncated list. The caller surfaces the
      // failure and the user retries; the alternative silently drops every
      // other saved site and the user finds out weeks later.
      if (!state.ok) throw new Error('settings unavailable');
      const { sites } = state;
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
      const state = await readAll();
      if (!state.ok) throw new Error('settings unavailable');
      const next = Object.assign({}, state.defaults, patch);
      await UC.api.storage.sync.set({ [KEY_DEFAULTS]: next });
      return next;
    });
  }

  /**
   * Origins the user asked to always unlock, or null when the store could not
   * be read.
   *
   * Null and empty are different answers and the caller acts on the difference.
   * The reconciler unregisters everything the user does not want, so an empty
   * list handed over because storage blinked means every always-unlock site on
   * the machine loses its content script, and nothing puts them back until the
   * user notices and toggles something. Same reasoning as the `ok` flag on a
   * write: degrading to defaults is fine for a reader and destructive for
   * anything that acts on the answer.
   */
  async function alwaysOrigins() {
    const state = await readAll();
    if (!state.ok) return null;
    const { sites } = state;
    return Object.keys(sites).filter((origin) => sites[origin] && sites[origin].always);
  }

  return { readAll, siteEntry, writeSite, writeDefaults, alwaysOrigins };
})();
