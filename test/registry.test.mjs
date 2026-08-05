import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLib, plain, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(
  ['lib/browser.js', 'lib/policy.js', 'lib/origins.js', 'lib/settings.js', 'lib/registry.js'],
  { chrome: STUB_CHROME }
);
const { plan, registrationsFor } = ctx.UC.registry;

const A = 'https://a.example';
const B = 'https://b.example';

/** The ids the registry will use, derived the same way it derives them. */
const idsOf = (origin) => plain(registrationsFor(origin)).map((r) => r.id);
const bothIds = (...origins) => origins.flatMap(idsOf);

test('a wanted and granted origin gets registered', () => {
  const decision = plan([A], [A], []);
  assert.deepEqual(plain(decision.register), [A]);
  assert.deepEqual(plain(decision.unregister), []);
  assert.deepEqual(plain(decision.stale), []);
});

test('a wanted but ungranted origin is reported stale, never registered', () => {
  // The synced-profile case: storage arrives on a new machine carrying origins
  // the user never granted there. Registering would throw, and pretending it
  // worked would make the popup lie.
  const decision = plan([A], [], []);
  assert.deepEqual(plain(decision.register), []);
  assert.deepEqual(plain(decision.stale), [A]);
});

test('a fully registered origin is left alone', () => {
  const decision = plan([A], [A], bothIds(A));
  assert.deepEqual(plain(decision.register), []);
  assert.deepEqual(plain(decision.unregister), []);
});

test('a half registered origin is re-registered', () => {
  // Only the MAIN world survived. That page would get patched but never learn
  // the user's switches, so treat it as not registered at all.
  const [mainId] = idsOf(A);
  const decision = plan([A], [A], [mainId]);
  assert.deepEqual(plain(decision.register), [A]);
});

test('a registration the user no longer wants is removed, both worlds', () => {
  const decision = plan([], [], bothIds(A));
  assert.deepEqual(plain(decision.unregister).sort(), idsOf(A).sort());
});

test('revoking the permission unregisters, because permissions win', () => {
  const decision = plan([A], [], bothIds(A));
  assert.deepEqual(plain(decision.unregister).sort(), idsOf(A).sort());
  assert.deepEqual(plain(decision.stale), [A]);
});

test('registrations belonging to something else are not touched', () => {
  const decision = plan([], [], ['some-other-extension-thing', 'ucx-not-ours']);
  assert.deepEqual(plain(decision.unregister), []);
});

test('a mixed state settles in one pass', () => {
  const decision = plan([A, B], [B], bothIds(A));
  assert.deepEqual(plain(decision.register), [B], 'B is granted but not yet registered');
  assert.deepEqual(plain(decision.unregister).sort(), idsOf(A).sort(), 'A lost its grant');
  assert.deepEqual(plain(decision.stale), [A]);
});

test('each origin registers both worlds at document_start, all frames, persistent', () => {
  const [main, bridge] = registrationsFor(A);

  assert.equal(main.world, 'MAIN');
  assert.deepEqual(plain(main.js), ['content/unlock.js']);

  assert.equal(bridge.world, 'ISOLATED');
  assert.deepEqual(plain(bridge.js), ['content/bridge.js']);

  for (const registration of [main, bridge]) {
    assert.equal(registration.runAt, 'document_start');
    assert.equal(registration.allFrames, true);
    assert.equal(registration.persistAcrossSessions, true);
    assert.deepEqual(plain(registration.matches), ['https://a.example/*']);
  }
});

test('ids never collide across origins, including adversarial ones', () => {
  // `https://a.example-bridge` is the case that breaks a suffix scheme: it
  // sanitises to the same string as `https://a.example` plus "-bridge".
  const origins = [A, B, 'https://a.example-bridge', 'http://a.example', 'https://a.example:8443'];
  const seen = new Map();
  for (const origin of origins) {
    for (const id of idsOf(origin)) {
      assert.equal(seen.has(id), false, `id ${id} used by both ${seen.get(id)} and ${origin}`);
      seen.set(id, origin);
    }
  }
});

test('two origins that differ only in punctuation get different ids', () => {
  // `https://docs.google.com` and `https://docs-google.com` are both ordinary
  // origins, and a sanitiser that collapses every run of punctuation to a dash
  // maps them onto one id. The second one to be turned on then looks fully
  // registered to plan(), never gets a content script, and the popup still
  // reports it as always unlocked.
  const dotted = 'https://docs.google.com';
  const dashed = 'https://docs-google.com';
  assert.notDeepEqual(idsOf(dotted), idsOf(dashed));

  const decision = plan([dotted, dashed], [dotted, dashed], bothIds(dotted));
  assert.deepEqual(plain(decision.register), [dashed], 'the second origin still needs registering');
});

test('an unreadable settings store unregisters nothing', async () => {
  // reconcile() removes every registration the wanted list does not mention.
  // Reading a storage failure as "the user wants none" therefore takes every
  // always-unlock site on the machine offline, and nothing re-runs on its own
  // to put them back.
  const unregistered = [];
  const chrome = {
    storage: { sync: { get: async () => { throw new Error('Extension context invalidated'); } } },
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => bothIds(A).map((id) => ({ id })),
      registerContentScripts: async () => {},
      unregisterContentScripts: async ({ ids }) => unregistered.push(...ids),
    },
  };
  const isolated = await loadLib(
    ['lib/browser.js', 'lib/policy.js', 'lib/origins.js', 'lib/settings.js', 'lib/registry.js'],
    { chrome }
  );

  const decision = await isolated.UC.registry.reconcile();
  assert.deepEqual(plain(unregistered), [], 'nothing may be unregistered on a failed read');
  assert.deepEqual(plain(decision.unregister), []);
});
