/**
 * Loads the shipped lib files into a sandbox so the pure logic can be tested in
 * plain node.
 *
 * The libraries are classic scripts that hang themselves off a `UC` global,
 * which is what lets the same files run in a service worker, an event page, the
 * popup and the options page without a bundler. Running them under node:vm
 * tests the exact bytes that ship rather than a parallel copy that can drift.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string[]} files paths under src/, in dependency order
 * @param {object} extras extra globals, e.g. a fake `chrome`
 */
export async function loadLib(files, extras = {}) {
  const context = vm.createContext({ URL, console, ...extras });
  for (const rel of files) {
    const code = await fs.readFile(path.join(ROOT, 'src', rel), 'utf8');
    vm.runInContext(code, context, { filename: rel });
  }
  return context;
}

/**
 * Strip a value of its sandbox realm.
 *
 * Objects built inside node:vm carry that realm's Array and Object prototypes,
 * so deepStrictEqual rejects them as "same structure but not reference-equal"
 * even when the contents match. Round-tripping through JSON rebuilds them with
 * the host's intrinsics, which is what the assertions actually mean to compare.
 */
export const plain = (value) => JSON.parse(JSON.stringify(value));

/** browser.js insists on a namespace object existing, so give it a stub. */
export const STUB_CHROME = {
  storage: { sync: { get: async () => ({}), set: async () => {} } },
  permissions: { contains: async () => false },
  scripting: {
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async () => {},
    unregisterContentScripts: async () => {},
  },
};
