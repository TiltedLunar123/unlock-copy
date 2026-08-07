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
    id: '19',
    label: 'shadow dom locked by css alone',
    expect: 'UNLOCKCOPY-19-SHADOWCSS',
    // Case 10 carries a copy listener as well as a user-select lock, and that
    // listener decides case 10 on its own, so nothing asserted that shadow
    // content locked purely by CSS becomes selectable. This root has no
    // listener at all. Dragged rather than selected through the API, because
    // the Selection API ignores user-select.
    //
    // Measured while adding it, Edge and Chromium 2026-08-05: this still passes
    // with the per shadow root stylesheet the engine injects emptied out, so
    // what actually unlocks it is the USER origin sheet the background inserts
    // for the document, which does reach into open shadow roots. The engine's
    // own copies are belt and braces on Chromium. Not probed on Firefox, which
    // is why they stay.
    drag: true,
    rectExpr: "document.getElementById('host19').shadowRoot.getElementById('t19')",
  },
  {
    id: '21',
    label: 'the page swaps the selection to its own content',
    expect: 'UNLOCKCOPY-21-SWAP',
    // Something else is selected first, so the swap has a previous selection to
    // clear. With nothing selected the clear is a no-op and the bug hides.
    selectExpr:
      "(() => { getSelection().selectAllChildren(document.getElementById('t0')); window.__swap21(); })()",
    blocks: false,
  },
  {
    id: '20',
    label: 'blocked content inside contenteditable=false',
    sel: '#t20',
    expect: 'UNLOCKCOPY-20-CEFALSE',
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
/**
 * Build, so that what gets loaded is what src currently says.
 *
 * This suite drives dist rather than src on purpose: the concatenated bundle is
 * what a user actually runs. It was copying whatever dist happened to be holding
 * though, so running `npm run e2e` straight after editing src tested the
 * previous build and reported green on code that no longer existed. `npm run
 * all` builds first, which is the only reason that never showed up.
 */
async function buildDist() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'tools', 'build.mjs')]);
}

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

async function dragSelect(cdp, page, testCase) {
  // A case inside a shadow root cannot be reached with a plain selector, so it
  // supplies its own expression for finding the element.
  const finder = testCase.rectExpr || `document.querySelector(${JSON.stringify(testCase.sel)})`;
  const rect = await cdp.evaluate(
    page,
    `(() => {
       const el = ${finder};
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
    await dragSelect(cdp, page, testCase);
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
    let threw = false;
    try {
      got = await runCase(cdp, page, testCase);
    } catch (err) {
      got = `<error: ${err.message}>`;
      threw = true;
    }
    // A harness error is never a pass. Every negative assertion here scores by
    // "the clipboard does not hold the expected text", and a case that blew up
    // satisfies that trivially, so a broken harness reported the baseline phase
    // green while no case had actually run. Baseline is the phase that exists
    // to prove the fixture still blocks, so that failure mode hides everything.
    const { pass, detail } = threw
      ? { pass: false, detail: `harness error: ${got}` }
      : judge(phase, testCase, got);
    results.push({ phase, id: testCase.id, label: testCase.label, pass, detail });
  }
}

/* ------------------------------------------------------------------ */
/* Engine checks                                                       */
/* ------------------------------------------------------------------ */

/**
 * Assertions about the engine itself rather than about the clipboard.
 *
 * The three clipboard phases only ever ask "can the user copy this now", which
 * is the right question for the blocking cases and cannot see anything about
 * what happens when the engine is switched back off. Relocking is supposed to
 * hand the page back exactly as it was found, and every one of the checks below
 * covers something that used to survive a relock or never applied in the first
 * place.
 *
 * Runs on its own fixture and its own tab, after the early phase has turned this
 * origin into an always-unlock site, so the page arrives already patched at
 * document_start. That ordering is load bearing rather than incidental: in late
 * mode the capture net stops these events before any page listener runs, so a
 * check that a page handler cannot cancel passes on a broken engine too. The
 * paste check in particular is worthless in late mode. Anything that depends on
 * a page listener actually running has to be asserted here, in early mode.
 */
async function engineChecks(cdp, sw, origin, results) {
  const fixture = `${origin}/teardown.html`;
  const record = (id, label, pass, detail) =>
    results.push({ phase: 'engine', id, label, pass, detail: pass ? '' : detail });

  const onTab = (body) =>
    cdp.evaluate(
      sw,
      `(async () => {
         const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(fixture)} });
         if (!tab) throw new Error('engine fixture tab not found');
         ${body}
       })()`
    );

  /**
   * Through setFeature rather than straight into storage.
   *
   * setFeature is what the options page calls, and it broadcasts as well as
   * writing. Writing storage directly leaves the isolated-world bridge holding
   * the policy it fetched at document_start, and the bridge replays that cached
   * copy every time an engine announces itself, so the next unlock came up on
   * the old switches and the check below failed against correct code.
   */
  const setDefaults = async (patch) => {
    for (const [feature, value] of Object.entries(patch)) {
      // A global scope change never looks at the tab, so this runs before the
      // fixture tab exists as happily as after it.
      await cdp.evaluate(
        sw,
        `UC.background.setFeature(null, ${JSON.stringify(feature)}, ${JSON.stringify(
          value
        )}, 'global')`
      );
    }
  };
  const unlock = () => onTab('return UC.background.unlockOnce(tab);');
  const lock = () => onTab('return UC.background.lock(tab);');

  // Written before the page loads. The registered bridge reads the policy once,
  // at document_start, so a switch flipped afterwards would not reach this load.
  await setDefaults({
    selection: true,
    contextmenu: true,
    keyboard: true,
    cleanCopy: true,
    aggressive: true,
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: fixture });
  const page = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Page.bringToFront', {}, page);
  // The bridge fetches the policy over a message round trip after load, and the
  // aggressive checks below are meaningless until that has landed.
  await sleep(900);

  try {
    await runEngineChecks();
  } finally {
    await setDefaults({
      selection: true,
      contextmenu: true,
      keyboard: true,
      cleanCopy: true,
      aggressive: false,
    });
    await cdp.send('Target.closeTarget', { targetId });
  }

  async function runEngineChecks() {
  // Aggressive mode exists to unblock pasting. addEventListener('paste') and
  // the onpaste content attribute were both covered; the property assignment,
  // which is how a confirmation field usually spells it, was not. Asserted in
  // early mode on purpose: in late mode the capture net stops the event before
  // the field's own handler runs, so this passes without the property patch.
  const paste = await cdp.evaluate(
    page,
    `(() => {
       const field = document.getElementById('pastefield');
       field.onpaste = () => false;
       const event = new Event('paste', { cancelable: true, bubbles: true });
       field.dispatchEvent(event);
       return event.defaultPrevented;
     })()`
  );
  record('PP', 'an onpaste property cannot cancel under aggressive', paste === false, 'the paste was cancelled');

  // The shield writes an inline pointer-events onto the page's own overlay. The
  // undo stack restores patches, not DOM edits it has no record of, so without
  // a record the overlay stayed click-through for the rest of the document.
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: 600, y: 450, button: 'left', buttons: 1, clickCount: 1 },
    page
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: 600, y: 450, button: 'left', buttons: 0, clickCount: 1 },
    page
  );
  await sleep(150);
  const shielded = await cdp.evaluate(
    page,
    "document.getElementById('overlay').style.getPropertyValue('pointer-events')"
  );
  record('SH1', 'the shield actually fires on a full page overlay', shielded === 'none', `pointer-events is ${JSON.stringify(shielded)}; the restore check below proves nothing without this`);

  // setAttribute is guarded, and it was the only spelling that was. The same
  // inline handler arrives just as intact through the namespaced call and
  // through an Attr node, so a page re-arming with either kept winning.
  const ns = await cdp.evaluate(
    page,
    `(() => {
       const el = document.getElementById('target');
       el.removeAttribute('oncopy');
       try { el.setAttributeNS(null, 'oncopy', 'return false'); } catch (e) { return 'threw: ' + e.message; }
       return el.getAttribute('oncopy');
     })()`
  );
  record('NS', 'setAttributeNS cannot re-arm a hostile handler', ns === null, `attribute is ${JSON.stringify(ns)}`);

  const node = await cdp.evaluate(
    page,
    `(() => {
       const el = document.getElementById('target');
       el.removeAttribute('oncontextmenu');
       try {
         const attr = document.createAttribute('oncontextmenu');
         attr.value = 'return false';
         el.setAttributeNode(attr);
       } catch (e) { return 'threw: ' + e.message; }
       return el.getAttribute('oncontextmenu');
     })()`
  );
  record('AN', 'setAttributeNode cannot re-arm a hostile handler', node === null, `attribute is ${JSON.stringify(node)}`);

  // A switch that is off must not still be acting. Selection owns oncopy, so
  // with selection on the write is refused and with it off the page keeps it.
  const guardedOn = await cdp.evaluate(
    page,
    `(() => {
       const el = document.getElementById('target');
       el.removeAttribute('oncopy');
       el.setAttribute('oncopy', 'return false');
       return el.getAttribute('oncopy');
     })()`
  );
  record('SW1', 'selection on refuses an oncopy write', guardedOn === null, `attribute is ${JSON.stringify(guardedOn)}`);

  // The page assigns a handler through the property this patch answers for, and
  // it has to get it back when the engine leaves. Without that the wrapper stays
  // registered with nothing able to remove it, and the page's own `oncopy = null`
  // silently fails.
  await cdp.evaluate(
    page,
    `(() => {
       window.__ucHits = 0;
       document.oncopy = function () { window.__ucHits++; };
     })()`
  );
  // One relock, then everything that has to survive it. Both of the checks
  // below used to outlive disable(): the overlay kept the inline pointer-events
  // the shield wrote, and the handler kept a wrapper the page had no way to
  // reach, so `document.oncopy = null` silently did nothing.
  await lock();
  await sleep(250);

  const restored = await cdp.evaluate(
    page,
    "document.getElementById('overlay').style.getPropertyValue('pointer-events')"
  );
  record('SH2', 'relocking gives the overlay its pointer-events back', restored === '', `pointer-events is still ${JSON.stringify(restored)}`);

  const handback = await cdp.evaluate(
    page,
    `(() => {
       const handedBack = typeof document.oncopy === 'function';
       document.oncopy = null;
       document.dispatchEvent(new Event('copy', { cancelable: true, bubbles: true }));
       return { handedBack, hits: window.__ucHits };
     })()`
  );
  record(
    'HB',
    'relocking hands an on* handler back to the page',
    handback.handedBack === true && handback.hits === 0,
    `handedBack=${handback.handedBack}, handler still fired ${handback.hits} time(s) after the page cleared it`
  );

  /* ---- a switch the user turned off has to stop acting ---- */
  await setDefaults({ selection: false });
  await unlock();
  await sleep(300);
  const guardedOff = await cdp.evaluate(
    page,
    `(() => {
       const el = document.getElementById('target');
       el.removeAttribute('oncopy');
       el.setAttribute('oncopy', 'return false');
       return el.getAttribute('oncopy');
     })()`
  );
  record(
    'SW2',
    'selection off leaves an oncopy write alone',
    guardedOff === 'return false',
    `attribute is ${JSON.stringify(guardedOff)}, so a switch the user turned off is still acting`
  );
  await lock();
  }
}

/* ------------------------------------------------------------------ */

/**
 * Refuse to run when something is already serving devtools on our port.
 *
 * A run that dies partway leaves its browser behind holding the port, and the
 * next run then attaches to that one: an older build, a different profile, and
 * a service worker whose id will never match, so the whole suite fails on a
 * timeout that says nothing about the code. Saying so up front is worth more
 * than the twenty minutes of reading a result that describes another build.
 */
async function assertPortFree() {
  // Polled for a few seconds rather than sampled once. A browser from the run
  // before can still be on its way out, and refusing to start because of that
  // is a false alarm that costs exactly as much attention as the real thing.
  // One genuinely left running is still there when this gives up.
  const deadline = Date.now() + 8000;
  let existing;
  for (;;) {
    try {
      existing = await httpJson(PORT, '/json/version');
    } catch {
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  }
  throw new Error(
    `port ${PORT} is already serving devtools (${existing.Browser || 'unknown browser'}). ` +
      'A previous run left its browser running. Kill it and try again, or this suite ' +
      'attaches to that browser and tests whatever build it was launched with.'
  );
}

async function main() {
  await assertPortFree();
  await buildDist();
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
    // So shutdown can ask the browser to close itself, which is the only thing
    // that reliably ends it.
    session.cdp = cdp;

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

    /* ---- engine: teardown and switch behaviour, on its own tab ---- */
    // After the early phase on purpose. That phase is what makes this origin an
    // always-unlock site, and these checks need the engine to arrive at
    // document_start: in late mode the capture net answers for the page's own
    // listeners, so half of them would pass on a broken engine.
    try {
      await engineChecks(cdp, sw, origin, results);
    } catch (err) {
      results.push({
        phase: 'engine',
        id: '!',
        label: 'engine checks',
        pass: false,
        detail: `harness error: ${err.message}`,
      });
    }
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
  // The port travels with the session so shutdown can wait on the thing that
  // actually blocks the next run, rather than on the process it spawned.
  return { child, profile, port: PORT };
}

function report(results) {
  const phases = ['baseline', 'late', 'engine', 'early'];
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
