import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLib, plain } from './helper.mjs';

/**
 * The background is a classic script like the libraries, so it loads into the
 * same sandbox. It registers its listeners at load time and hangs the operations
 * off UC.background for the end to end harness, which is the same handle the
 * tests below drive.
 */

const noListener = () => ({ addListener() {} });

/**
 * A browser stub that records what the background did to the page.
 *
 * `failGet` is the interesting switch: several of these paths read settings and
 * then act on the answer, and what they do when the read failed is not something
 * any other gate in this repo covers.
 */
function makeChrome(options = {}) {
  const state = {
    failGet: false,
    tabs: options.tabs || [{ id: 7, url: 'https://example.com/a' }],
    engineActive: options.engineActive !== false,
    pushes: [],
    css: [],
    stored: options.stored || {},
  };

  const chrome = {
    runtime: {
      onMessage: noListener(),
      onInstalled: noListener(),
      onStartup: noListener(),
    },
    tabs: {
      onUpdated: noListener(),
      onRemoved: noListener(),
      async query() {
        return state.tabs;
      },
      async sendMessage(tabId, message) {
        state.pushes.push({ via: 'message', tabId, policy: message.policy });
      },
    },
    scripting: {
      async executeScript(opts) {
        // The policy pushes carry args; the engine probe does not.
        if (opts.args) {
          state.pushes.push({ via: 'script', tabId: opts.target.tabId, policy: opts.args[0] });
          return [{ result: undefined }];
        }
        return [{ result: state.engineActive }];
      },
      async insertCSS() {
        state.css.push('insert');
      },
      async removeCSS() {
        state.css.push('remove');
      },
      async getRegisteredContentScripts() {
        return [];
      },
      async registerContentScripts() {},
      async unregisterContentScripts() {},
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
    },
    permissions: {
      async contains() {
        return true;
      },
      async remove() {},
      onRemoved: noListener(),
      onAdded: noListener(),
    },
    extension: {
      async isAllowedFileSchemeAccess() {
        return false;
      },
    },
    commands: { onCommand: noListener() },
    storage: {
      sync: {
        async get(keys) {
          if (state.failGet) throw new Error('Extension context invalidated');
          const out = {};
          for (const key of keys) if (key in state.stored) out[key] = state.stored[key];
          return out;
        },
        async set(patch) {
          Object.assign(state.stored, structuredClone(patch));
        },
      },
    },
  };

  return { chrome, state };
}

async function load(options) {
  const { chrome, state } = makeChrome(options);
  const ctx = await loadLib(
    [
      'lib/browser.js',
      'lib/policy.js',
      'lib/origins.js',
      'lib/settings.js',
      'lib/registry.js',
      'background.main.js',
    ],
    { chrome, structuredClone }
  );
  return { background: ctx.UC.background, state };
}

/** Everything the user could switch off, switched off. */
const ALL_OFF = {
  selection: false,
  contextmenu: false,
  keyboard: false,
  cleanCopy: false,
  aggressive: false,
};

test('a settings read that failed does not broadcast anything', async () => {
  // readAll() degrades to the factory defaults when storage cannot be read, and
  // that is the right answer for a reader. It is the wrong answer to push into
  // a page: the defaults are everything on, so one blink of storage while the
  // user flips a switch re-enables every feature they had turned off, in every
  // open tab at once, and re-inserts the selection stylesheet on tabs they had
  // relocked. The switches then disagree with the pages until a reload.
  const { background, state } = await load({ stored: { defaults: ALL_OFF, sites: {} } });
  state.failGet = true;

  await background.broadcastPolicy();

  assert.deepEqual(plain(state.pushes), [], 'pushed a policy it could not know');
  assert.deepEqual(plain(state.css), [], 'touched the stylesheet on a guess');
});

test('a settings read that worked broadcasts what the user actually chose', async () => {
  // The other half of the same contract: refusing to broadcast on a failed read
  // is only correct if a good read still gets through, so this pins the case the
  // fix must not break.
  const { background, state } = await load({ stored: { defaults: ALL_OFF, sites: {} } });

  await background.broadcastPolicy();

  assert.equal(state.pushes.length > 0, true, 'a readable store broadcast nothing');
  for (const push of state.pushes) {
    assert.equal(push.policy.selection, false);
    assert.equal(push.policy.contextmenu, false);
    assert.equal(push.policy.keyboard, false);
  }
  // Selection is off, so the stylesheet must come off rather than go on.
  assert.equal(state.css.includes('insert'), false, 'inserted CSS for a disabled feature');
});
