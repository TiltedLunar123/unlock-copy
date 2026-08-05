/**
 * End to end suite.
 *
 * Loads the real extension into a real browser, opens the torture fixture and
 * asserts against the real clipboard. The assertion is deliberately the
 * clipboard rather than a proxy like `defaultPrevented`, because every proxy
 * can be satisfied while the user still ends up with nothing to paste.
 *
 * Three phases, and the middle one is the point:
 *
 *   baseline  nothing injected. Every blocking case MUST block. Without this
 *             a fixture case that silently stopped blocking would make the
 *             other two phases pass for free.
 *   late      unlocked the way the toolbar button does it, after page script
 *             has run. Everything must copy except case 4, which must still
 *             fail, because that is the documented limit of a late unlock.
 *   early     unlocked the way "always unlock this site" does it, at
 *             document_start. Everything must copy, case 4 included.
 *
 * Runs against Edge or Chromium. Branded Chrome ignores --load-extension, so
 * tools/cdp.mjs deliberately prefers Edge; see the comment there.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CDP, httpJson, serveDir, shutdown, sleep, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;
const SENTINEL = 'CLIPBOARD-NOT-TOUCHED';

/**
 * Every case in test-pages/blockers.html.
 *
 * `select` runs in the page and must leave the intended text selected.
 * `drag` marks cases where a programmatic selection would be cheating: a pure
 * CSS `user-select: none` lock does not stop the Selection API, only the user,
 * so those have to be selected with real mouse input or the fixture proves
 * nothing.
 */
const CASES = [
  { id: '0', label: 'control', sel: '#t0', expect: 'UNLOCKCOPY-0-CONTROL', blocks: false },
  { id: '1', label: 'inline attributes', sel: '#t1', expect: 'UNLOCKCOPY-1-INLINE' },
  { id: '2', label: 'document bubble', sel: '#t2', expect: 'UNLOCKCOPY-2-DOCBUBBLE' },
  { id: '3', label: 'document capture', sel: '#t3', expect: 'UNLOCKCOPY-3-DOCCAPTURE' },
  {
    id: '4',
    label: 'window capture, registered first',
    sel: '#t4',
    expect: 'UNLOCKCOPY-4-WINCAPTURE',
    lateGap: true,
  },
  { id: '5', label: 'css user-select none', sel: '#t5', expect: 'UNLOCKCOPY-5-USERSELECT', drag: true },
  { id: '6', label: 'document.oncopy property', sel: '#t6', expect: 'UNLOCKCOPY-6-ONPROPERTY' },
  { id: '7', label: 'keydown interception', sel: '#t7', expect: 'UNLOCKCOPY-7-KEYDOWN' },
  { id: '8', label: 'selection watchdog', sel: '#t8', expect: 'UNLOCKCOPY-8-WATCHDOG', settle: 120 },
  { id: '9', label: 'clipboard hijack', sel: '#t9', expect: 'UNLOCKCOPY-9-HIJACK' },
  {
    id: '10',
    label: 'open shadow dom',
    expect: 'UNLOCKCOPY-10-SHADOW',
    selectExpr:
      "getSelection().selectAllChildren(document.getElementById('host10').shadowRoot.getElementById('t10'))",
  },
  { id: '11', label: 'observer re-arms attribute', sel: '#t11', expect: 'UNLOCKCOPY-11-REARM' },
  { id: '12', label: 'framework root delegate', sel: '#t12', expect: 'UNLOCKCOPY-12-DELEGATE' },
  {
    id: '13',
    label: 'user-select none important',
    sel: '#t13',
    expect: 'UNLOCKCOPY-13-IMPORTANT',
    drag: true,
  },
  {
    id: '14',
    label: 'same origin iframe',
    expect: 'UNLOCKCOPY-14-IFRAME',
    selectExpr:
      "(() => { const f = document.getElementById('frame14'); f.contentWindow.focus(); " +
      "f.contentWindow.getSelection().selectAllChildren(f.contentDocument.getElementById('t14')); })()",
    refocus: true,
  },
  { id: '15', label: 'cancels through Event.prototype', sel: '#t15', expect: 'UNLOCKCOPY-15-PROTOCANCEL' },
  { id: '16', label: 'async clipboard hijack', sel: '#t16', expect: 'UNLOCKCOPY-16-ASYNCHIJACK' },
  { id: '17', label: 'document.onkeydown property', sel: '#t17', expect: 'UNLOCKCOPY-17-ONKEYDOWN' },
  {
    id: '18',
    label: 'watchdog that collapses the selection',
    sel: '#t18',
    expect: 'UNLOCKCOPY-18-COLLAPSE',
    settle: 120,
  },
  {
    id: 'E',
    label: 'editor keeps its own copy handler',
    sel: '#tE',
    expect: 'UNLOCKCOPY-E-TRANSFORMED',
    blocks: false,
  },
  {
    id: 'F',
    label: 'editor still blocks its own copy',
    sel: '#tF',
    expect: 'UNLOCKCOPY-F-EDITORBLOCK',
    keepsBlocking: true,
  },
];

/* ------------------------------------------------------------------ */
/* Test build                                                          */
/* ------------------------------------------------------------------ */

function deriveExtensionId(der) {
  const digest = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/**
 * Copy the built Chrome extension and give it a fixed id plus host access.
 *
 * The shipping build has neither: host access is requested per origin at
 * runtime, and activeTab is granted only by a real toolbar click, which cannot
 * be synthesised. This throwaway variant stands in for the click. It is never
 * zipped and never released, and tools/build.mjs --check verifies the real
 * permission set on dist/chrome and dist/firefox.
 */
async function buildTestVariant() {
  const from = path.join(ROOT, 'dist', 'chrome');
  const to = path.join(ROOT, 'dist', 'e2e');
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });

  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });

  const manifestPath = path.join(to, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.name = 'Unlock Copy (E2E build - do not ship)';
  manifest.host_permissions = ['<all_urls>'];
  manifest.key = der.toString('base64');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { dir: to, extensionId: deriveExtensionId(der) };
}

/* ------------------------------------------------------------------ */
/* Driving one case                                                    */
/* ------------------------------------------------------------------ */

async function dragSelect(cdp, page, selector) {
  const rect = await cdp.evaluate(
    page,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       el.scrollIntoView({ block: 'center' });
       const r = el.getBoundingClientRect();
       return { x: r.left, y: r.top + r.height / 2, w: r.width };
     })()`
  );

  const from = { x: rect.x + 1, y: rect.y };
  const to = { x: rect.x + rect.w - 1, y: rect.y };

  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 },
    page
  );
  for (let i = 1; i <= 10; i++) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * i) / 10,
        y: to.y,
        button: 'left',
        buttons: 1,
      },
      page
    );
  }
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 },
    page
  );
}

async function runCase(cdp, page, testCase) {
  // Park a sentinel so a copy that never happens is distinguishable from a copy
  // that produced the right text.
  await cdp.evaluate(page, `navigator.clipboard.writeText(${JSON.stringify(SENTINEL)})`);

  if (testCase.drag) {
    await dragSelect(cdp, page, testCase.sel);
  } else if (testCase.selectExpr) {
    await cdp.evaluate(page, testCase.selectExpr);
  } else {
    await cdp.evaluate(
      page,
      `(() => {
         const el = document.querySelector(${JSON.stringify(testCase.sel)});
         el.scrollIntoView({ block: 'center' });
         getSelection().selectAllChildren(el);
       })()`
    );
  }

  // Case 8's watchdog needs a moment to fire, or the test races past the very
  // thing it is meant to prove.
  if (testCase.settle) await sleep(testCase.settle);

  await cdp.copyShortcut(page);
  await sleep(120);

  if (testCase.refocus) await cdp.evaluate(page, 'window.focus()');
  return cdp.evaluate(page, 'navigator.clipboard.readText()');
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

function judge(phase, testCase, got) {
  const want = testCase.expect;
  const matched = got === want;

  // Cases marked blocks:false are the controls: they must produce the right
  // text in every phase, including baseline. The editor case is one of them,
  // which is how "we never broke Google Docs" gets asserted rather than hoped.
  if (testCase.blocks === false) {
    return { pass: matched, detail: matched ? '' : `expected ${want}, got ${JSON.stringify(got)}` };
  }

  // The mirror of blocks:false. A page is allowed to cancel a copy inside its
  // own editor, and this extension is not supposed to have an opinion about
  // that, so the case must keep blocking in every phase including the two where
  // the engine is installed. Baseline proves the fixture blocks at all.
  if (testCase.keepsBlocking) {
    return {
      pass: !matched,
      detail: matched
        ? 'the engine overrode a copy an editor cancelled for itself'
        : '',
    };
  }

  if (phase === 'baseline') {
    return {
      pass: !matched,
      detail: matched ? 'fixture did not actually block; this case proves nothing' : '',
    };
  }

  if (phase === 'late' && testCase.lateGap) {
    return {
      pass: !matched,
      detail: matched
        ? 'late unlock beat a window capture listener registered first, which it should not be able to do'
        : '',
    };
  }

  return { pass: matched, detail: matched ? '' : `expected ${want}, got ${JSON.stringify(got)}` };
}

async function runPhase(cdp, page, phase, results) {
  for (const testCase of CASES) {
    let got;
    try {
      got = await runCase(cdp, page, testCase);
    } catch (err) {
      got = `<error: ${err.message}>`;
    }
    const { pass, detail } = judge(phase, testCase, got);
    results.push({ phase, id: testCase.id, label: testCase.label, pass, detail });
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  const { dir, extensionId } = await buildTestVariant();
  const { server, port: filePort } = await serveDir(path.join(ROOT, 'test-pages'));
  const origin = `http://127.0.0.1:${filePort}`;
  const fixture = `${origin}/blockers.html`;

  let session;
  const results = [];

  try {
    session = await launchWithExtension(dir);

    const { webSocketDebuggerUrl } = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(webSocketDebuggerUrl);

    await cdp.send('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });

    // The service worker is lazy. Attaching to it is what keeps it alive long
    // enough to drive the real background operations.
    const swTarget = await waitFor('extension service worker', async () => {
      const targets = await httpJson(PORT, '/json/list');
      return targets.find(
        (t) => t.type === 'service_worker' && t.url.includes(extensionId)
      );
    });
    const sw = await cdp.attach(swTarget.id);

    const { targetId } = await cdp.send('Target.createTarget', { url: fixture });
    const page = await cdp.attach(targetId);
    await cdp.send('Page.enable', {}, page);
    await cdp.send('Page.bringToFront', {}, page);
    await sleep(600);

    /* ---- baseline ---- */
    await runPhase(cdp, page, 'baseline', results);

    /* ---- late: exactly what the toolbar button does ---- */
    await cdp.evaluate(
      sw,
      `(async () => {
         const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(fixture)} });
         await UC.background.unlockOnce(tab);
         return true;
       })()`
    );
    await sleep(400);
    await runPhase(cdp, page, 'late', results);

    /* ---- early: exactly what "always unlock this site" does ---- */
    await cdp.evaluate(
      sw,
      `(async () => {
         await UC.settings.writeSite(${JSON.stringify(origin)}, { always: true });
         const decision = await UC.registry.reconcile();
         if (decision.register.length === 0 && decision.stale.length) {
           throw new Error('reconcile refused to register: ' + JSON.stringify(decision));
         }
         return decision;
       })()`
    );
    await cdp.send('Page.reload', { ignoreCache: true }, page);
    await sleep(1200);
    await cdp.send('Page.bringToFront', {}, page);
    await runPhase(cdp, page, 'early', results);
  } finally {
    server.close();
    await shutdown(session);
  }

  report(results);
}

async function launchWithExtension(dir) {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const { findBrowser } = await import('./cdp.mjs');
  const binary = await findBrowser();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'unlock-copy-e2e-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${dir}`,
      `--disable-extensions-except=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--window-size=1200,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  await waitFor('devtools endpoint', () => httpJson(PORT, '/json/version'), { timeout: 25000 });
  return { child, profile };
}

function report(results) {
  const phases = ['baseline', 'late', 'early'];
  let failed = 0;

  for (const phase of phases) {
    const rows = results.filter((r) => r.phase === phase);
    if (!rows.length) continue;
    const bad = rows.filter((r) => !r.pass);
    failed += bad.length;
    console.log(`\n${phase}  ${rows.length - bad.length}/${rows.length}`);
    for (const row of rows) {
      const mark = row.pass ? 'ok  ' : 'FAIL';
      console.log(`  ${mark} ${String(row.id).padStart(2)}  ${row.label}${row.detail ? '  <- ' + row.detail : ''}`);
    }
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll end to end checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
