/**
 * Unlock Copy popup.
 *
 * The one rule this file exists to enforce: the UI never claims a state the
 * browser has not actually granted. "Always unlock" only reads as on when the
 * host permission really exists, because a checkbox that stays ticked after the
 * user revoked the permission elsewhere is how an extension earns a reputation
 * for not working.
 */
(() => {
  'use strict';

  const api = UC.api;

  const el = {
    host: document.getElementById('host'),
    live: document.getElementById('live'),
    blocked: document.getElementById('blocked'),
    blockedMessage: document.getElementById('blocked-message'),
    primary: document.getElementById('primary'),
    primaryLabel: document.getElementById('primary-label'),
    primaryNote: document.getElementById('primary-note'),
    always: document.getElementById('always'),
    alwaysSub: document.getElementById('always-sub'),
    options: document.getElementById('options'),
  };

  let state = null;
  let busy = false;

  function send(message) {
    return api.runtime.sendMessage(message);
  }

  function render() {
    if (!state) return;

    if (!state.ok) {
      el.live.hidden = true;
      el.blocked.hidden = false;
      el.blockedMessage.textContent = state.message;
      el.host.textContent = state.host || '';
      return;
    }

    el.blocked.hidden = true;
    el.live.hidden = false;
    el.host.textContent = state.host;

    const on = state.always || state.sessionActive;
    el.primary.dataset.on = String(on);
    el.primary.setAttribute('aria-pressed', String(on));

    if (state.always) {
      el.primaryLabel.textContent = 'Unlocked';
      el.primaryNote.textContent = 'On every time you visit this site.';
    } else if (state.sessionActive) {
      el.primaryLabel.textContent = 'Unlocked';
      el.primaryNote.textContent = 'Until you reload or leave this page.';
    } else {
      el.primaryLabel.textContent = 'Unlock this page';
      el.primaryNote.textContent = '';
    }

    // A local file has no origin to scope a permission to, so there is nothing
    // to remember. Saying so beats a toggle that silently refuses.
    el.always.checked = !!state.always;
    el.always.disabled = !!state.local;
    el.always.closest('.row').setAttribute('aria-disabled', String(!!state.local));

    if (state.local) {
      el.alwaysSub.textContent = "Local files can't be remembered, only unlocked per page.";
    } else if (state.pendingGrant) {
      el.alwaysSub.textContent = 'Needs permission on this device. Turn on to grant it.';
    } else {
      el.alwaysSub.textContent = "Runs before the site's code. Asks once.";
    }

    for (const input of document.querySelectorAll('[data-feature]')) {
      input.checked = !!state.features[input.dataset.feature];
    }
  }

  async function refresh() {
    state = await send({ type: 'unlock-copy/state' });
    render();
  }

  async function guard(work) {
    if (busy) return;
    busy = true;
    try {
      await work();
    } catch {
      // Nothing actionable to show in 300px. Re-reading the real state is more
      // useful than an error string, because it shows what did land.
    } finally {
      busy = false;
      await refresh();
    }
  }

  el.primary.addEventListener('click', () =>
    guard(async () => {
      if (state.always) {
        // The site is remembered, so the button's job is to undo that entirely
        // rather than leave a permission granted for a site now showing as off.
        await send({ type: 'unlock-copy/set-always', value: false });
        await send({ type: 'unlock-copy/lock' });
        return;
      }
      if (state.sessionActive) {
        await send({ type: 'unlock-copy/lock' });
        return;
      }
      await send({ type: 'unlock-copy/unlock' });
    })
  );

  el.always.addEventListener('change', (event) => {
    const wanted = event.target.checked;
    // Do not let the checkbox show the new state before it is real.
    event.target.checked = !!state.always;

    guard(async () => {
      if (!wanted) {
        await send({ type: 'unlock-copy/set-always', value: false });
        return;
      }

      // permissions.request has to be called from inside the click that caused
      // it, which is why this lives in the popup rather than the background.
      let granted = false;
      try {
        granted = await api.permissions.request({
          origins: [UC.origins.patternFor(state.origin)],
        });
      } catch {
        granted = false;
      }
      if (!granted) return;

      await send({ type: 'unlock-copy/set-always', value: true });
    });
  });

  for (const input of document.querySelectorAll('[data-feature]')) {
    input.addEventListener('change', (event) =>
      guard(() =>
        send({
          type: 'unlock-copy/set-feature',
          feature: event.target.dataset.feature,
          value: event.target.checked,
          scope: 'site',
        })
      )
    );
  }

  el.options.addEventListener('click', (event) => {
    event.preventDefault();
    api.runtime.openOptionsPage();
    window.close();
  });

  refresh();
})();
