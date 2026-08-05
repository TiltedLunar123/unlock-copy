/**
 * Unlock Copy options.
 *
 * The site list shows the permission truth, not the stored intent. An origin
 * that is stored as always-unlocked but has no host grant on this device is
 * listed as needing permission rather than quietly presented as working, which
 * is the state a synced profile lands in on a second machine.
 */
(() => {
  'use strict';

  const api = UC.api;
  const sitesEl = document.getElementById('sites');

  async function loadDefaults() {
    const { defaults } = await UC.settings.readAll();
    for (const input of document.querySelectorAll('[data-feature]')) {
      input.checked = !!defaults[input.dataset.feature];
    }
  }

  /**
   * Which run of loadSites owns the list.
   *
   * Every row waits on its own permissions.contains, which is long enough for a
   * second run to start and overtake this one. Both runs used to clear the list
   * and then append across those awaits, so the older one put back rows the
   * newer one had already removed and a site reappeared after being deleted.
   * Gathering first and rendering in one synchronous pass leaves no window.
   */
  let generation = 0;

  async function loadSites() {
    const mine = ++generation;
    const { sites } = await UC.settings.readAll();
    const origins = Object.keys(sites)
      .filter((origin) => sites[origin] && sites[origin].always)
      .sort();

    const rows = [];
    for (const origin of origins) {
      let granted = false;
      try {
        granted = await api.permissions.contains({ origins: [UC.origins.patternFor(origin)] });
      } catch {
        granted = false;
      }
      rows.push({ origin, granted });
    }

    if (mine !== generation) return;

    sitesEl.textContent = '';

    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'None yet. Use "Always unlock this site" in the popup.';
      sitesEl.appendChild(li);
      return;
    }

    for (const { origin, granted } of rows) {
      const li = document.createElement('li');

      const label = document.createElement('span');
      label.className = 'site-origin';
      label.textContent = origin;
      li.appendChild(label);

      if (!granted) {
        const warn = document.createElement('span');
        warn.className = 'site-warn';
        warn.textContent = 'needs permission';
        li.appendChild(warn);
      }

      const button = document.createElement('button');
      button.className = 'remove';
      button.type = 'button';
      button.textContent = 'Remove';
      button.addEventListener('click', async () => {
        // Routed through the background rather than writing storage from here.
        // Every mutation happening in one context is what lets the settings
        // queue actually serialise them; a second writer in this page would
        // reintroduce the lost-update race it exists to prevent.
        await api.runtime.sendMessage({ type: 'unlock-copy/forget-site', origin });
        await loadSites();
        // The list is rebuilt from scratch, so the button that was focused is
        // gone and focus falls back to the document. Without this a keyboard
        // user is returned to the top of the page after every removal.
        const next = sitesEl.querySelector('button.remove');
        (next || sitesEl).focus();
      });
      li.appendChild(button);

      sitesEl.appendChild(li);
    }
  }

  for (const input of document.querySelectorAll('[data-feature]')) {
    input.addEventListener('change', async (event) => {
      await api.runtime.sendMessage({
        type: 'unlock-copy/set-feature',
        feature: event.target.dataset.feature,
        value: event.target.checked,
        scope: 'global',
      });
    });
  }

  loadDefaults();
  loadSites();
})();
