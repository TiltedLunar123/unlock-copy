import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLib, plain } from './helper.mjs';

/**
 * A storage stub that can be told to fail, because the interesting behaviour is
 * what a write does when the read underneath it did not work.
 */
function makeChrome(initial) {
  const state = {
    data: structuredClone(initial),
    failGet: false,
    sets: 0,
  };
  const chrome = {
    storage: {
      sync: {
        async get(keys) {
          if (state.failGet) throw new Error('Extension context invalidated');
          const out = {};
          for (const key of keys) if (key in state.data) out[key] = state.data[key];
          return out;
        },
        async set(patch) {
          state.sets++;
          Object.assign(state.data, structuredClone(patch));
        },
      },
    },
  };
  return { chrome, state };
}

async function load(initial) {
  const { chrome, state } = makeChrome(initial);
  const ctx = await loadLib(['lib/browser.js', 'lib/policy.js', 'lib/settings.js'], {
    chrome,
    structuredClone,
  });
  return { settings: ctx.UC.settings, state };
}

const TWO_SITES = {
  sites: {
    'https://a.example': { always: true },
    'https://b.example': { always: true, overrides: { keyboard: false } },
  },
};

test('a write merges into the existing site list rather than replacing it', async () => {
  const { settings, state } = await load(TWO_SITES);
  await settings.writeSite('https://c.example', { always: true });
  assert.deepEqual(Object.keys(state.data.sites).sort(), [
    'https://a.example',
    'https://b.example',
    'https://c.example',
  ]);
});

test('a write refuses when the read under it failed, instead of wiping the list', async () => {
  // readAll falls back to an empty site list, which is the right answer for a
  // reader and a destructive one for a writer: every mutation is a
  // read-modify-write over the whole object, so merging one patch into `{}` and
  // storing it deletes every other origin the user had saved.
  const { settings, state } = await load(TWO_SITES);
  state.failGet = true;

  await assert.rejects(() => settings.writeSite('https://c.example', { always: true }));
  await assert.rejects(() => settings.writeDefaults({ keyboard: false }));

  assert.equal(state.sets, 0, 'nothing was written at all');
  assert.deepEqual(Object.keys(state.data.sites).sort(), [
    'https://a.example',
    'https://b.example',
  ]);
});

test('a failed write does not wedge the writes queued behind it', async () => {
  const { settings, state } = await load(TWO_SITES);
  state.failGet = true;
  await assert.rejects(() => settings.writeSite('https://c.example', { always: true }));

  state.failGet = false;
  await settings.writeSite('https://c.example', { always: true });
  assert.equal(state.data.sites['https://c.example'].always, true);
});

test('reads still degrade to defaults when storage is unavailable', async () => {
  const { settings, state } = await load(TWO_SITES);
  state.failGet = true;

  const all = await settings.readAll();
  assert.equal(all.ok, false);
  assert.deepEqual(plain(all.sites), {});
  assert.equal(all.defaults.selection, true, 'the defaults are still usable');
  assert.deepEqual(plain(await settings.alwaysOrigins()), []);
});

test('a successful read is marked as one', async () => {
  const { settings } = await load(TWO_SITES);
  const all = await settings.readAll();
  assert.equal(all.ok, true);
  assert.deepEqual(plain(await settings.alwaysOrigins()).sort(), [
    'https://a.example',
    'https://b.example',
  ]);
});

test('an entry carrying no information is dropped rather than accumulated', async () => {
  const { settings, state } = await load(TWO_SITES);
  await settings.writeSite('https://a.example', { always: false });
  assert.equal('https://a.example' in state.data.sites, false);
  // b keeps its overrides, so it is still worth storing.
  assert.equal('https://b.example' in state.data.sites, true);
});
