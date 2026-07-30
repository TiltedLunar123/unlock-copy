/**
 * Chrome Web Store listing assets.
 *
 * Produces the store icon, five screenshots, and both promo tiles at the exact
 * sizes and colour depths the dashboard accepts.
 *
 * The before and after shots are real captures, not mockups: the script loads
 * store/demo.html (a page locked the ordinary way, with a CSS lock it reasserts
 * plus handlers in script), drag-selects across a paragraph and screenshots the
 * result, then runs the extension's own unlock path and drag-selects again. If
 * the extension stopped working, these images would show it.
 *
 *   node tools/store-assets.mjs
 *
 * Needs ImageMagick, same as tools/icons.mjs, and Edge or Chromium. Output goes
 * to the directory named by OUT below.
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { CDP, findBrowser, httpJson, serveDir, shutdown, sleep, waitFor } from './cdp.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(os.homedir(), 'Downloads', 'unlock-copy-store-assets');
const WORK = path.join(ROOT, 'dist', 'store-work');
const PORT = 9555;

/* ------------------------------------------------------------------ */
/* Slide markup                                                        */
/* ------------------------------------------------------------------ */

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Shared chrome for every generated page, sized to the exact canvas. */
function page(width, height, body, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${width}px;height:${height}px;overflow:hidden}
body{font:16px/1.5 ${FONT};background:#eef1ef;color:#14161a;-webkit-font-smoothing:antialiased}
.green{background:linear-gradient(135deg,#2fb96d 0%,#12703c 100%);color:#fff}
.wrap{width:${width}px;height:${height}px;display:flex;flex-direction:column}
h1{font-size:52px;line-height:1.08;letter-spacing:-0.025em;font-weight:700}
h2{font-size:38px;line-height:1.15;letter-spacing:-0.02em;font-weight:700}
.sub{font-size:21px;line-height:1.45;opacity:.9;font-weight:400}
.shot{border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.22);display:block}
.label{font-size:14px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
${extraCss}</style></head><body>${body}</body></html>`;
}

/** A screenshot sitting in a minimal browser window, so it reads as a web page. */
function browserFrame(src, w, h, caption) {
  return `<div style="width:${w}px">
    <div style="background:#dfe1e4;border-radius:12px 12px 0 0;padding:9px 12px;display:flex;gap:6px;align-items:center">
      <span style="width:10px;height:10px;border-radius:50%;background:#c6c8cc"></span>
      <span style="width:10px;height:10px;border-radius:50%;background:#c6c8cc"></span>
      <span style="width:10px;height:10px;border-radius:50%;background:#c6c8cc"></span>
    </div>
    <img class="shot" style="border-radius:0 0 12px 12px;width:${w}px;height:${h}px;object-fit:cover;object-position:top" src="${src}">
    ${caption ? `<p style="margin-top:14px;font-size:17px;color:#4a4d54">${caption}</p>` : ''}
  </div>`;
}

function slides() {
  return {
    /* 1. What it is, with the real popup. */
    's1-hero': page(
      1280,
      800,
      `<div class="wrap green" style="flex-direction:row;align-items:center;padding:0 78px;gap:56px">
        <div style="flex:1">
          <h1>Copy from sites<br>that stop you.</h1>
          <p class="sub" style="margin-top:24px;max-width:520px">
            Text selection, right-click and Ctrl+C, put back on pages that switch them off.
            One click. No account.
          </p>
          <p style="margin-top:30px;font-size:17px;opacity:.82">
            No access to any site until you ask for it.
          </p>
        </div>
        <img class="shot" style="width:340px" src="popup-locked.png">
      </div>`
    ),

    /* 2. The genuine before and after. */
    's2-before-after': page(
      1280,
      800,
      `<div class="wrap" style="padding:0 60px;justify-content:center">
        <h2>The same page, before and after.</h2>
        <p class="sub" style="margin-top:12px;color:#4a4d54;font-size:19px">
          Dragging across this article selects nothing. It does after.
        </p>
        <div style="display:flex;gap:36px;margin-top:34px">
          <div>
            <p class="label" style="color:#9a5b5b;margin-bottom:10px">Blocked</p>
            ${browserFrame('demo-before.png', 560, 450, '')}
          </div>
          <div>
            <p class="label" style="color:#1f8b4c;margin-bottom:10px">Unlocked</p>
            ${browserFrame('demo-after.png', 560, 450, '')}
          </div>
        </div>
      </div>`
    ),

    /* 3. The part that is genuinely different. */
    's3-always': page(
      1280,
      800,
      `<div class="wrap" style="flex-direction:row;align-items:center;padding:0 78px;gap:64px">
        <div style="flex:1">
          <h2>Remembering a site<br>does something real.</h2>
          <p class="sub" style="margin-top:22px;color:#4a4d54;font-size:19px;max-width:540px">
            Switch it on and the extension runs before the site's own code on your next visit.
          </p>
          <p style="margin-top:22px;font-size:18px;line-height:1.6;color:#4a4d54;max-width:540px">
            That ordering is the whole game. When a page installs its blocker before anything
            else runs, nothing arriving later can undo it. Going first is the only answer.
          </p>
          <p style="margin-top:22px;font-size:17px;color:#1f8b4c;font-weight:600">
            Your browser asks once, about that one site.
          </p>
        </div>
        <img class="shot" style="width:340px" src="popup-always.png">
      </div>`
    ),

    /* 4. Honest limits. Nobody else in the category prints these. */
    's4-limits': page(
      1280,
      800,
      `<div class="wrap" style="padding:0 78px;justify-content:center">
        <h2>It leaves working sites alone.</h2>
        <p class="sub" style="margin-top:14px;color:#4a4d54;font-size:19px;max-width:840px">
          A page listening for the copy event isn't automatically doing something hostile.
          Code blocks with a copy button, editors and password managers all listen for it too.
          Those keep working.
        </p>
        <div style="display:flex;gap:26px;margin-top:40px">
          <div style="flex:1;background:#fff;border-radius:14px;padding:28px 30px">
            <p class="label" style="color:#1f8b4c">Handled</p>
            <ul style="margin-top:14px;list-style:none;font-size:17px;line-height:2.15;color:#33353b">
              <li>CSS locks, including !important</li>
              <li>Blocked copy, cut and right-click</li>
              <li>Swallowed keyboard shortcuts</li>
              <li>Selection cleared as you drag</li>
              <li>Text swapped on copy</li>
              <li>Shadow DOM and same-site frames</li>
            </ul>
          </div>
          <div style="flex:1;background:#fff;border-radius:14px;padding:28px 30px">
            <p class="label" style="color:#8a8d93">Cannot be done, by anyone</p>
            <ul style="margin-top:14px;list-style:none;font-size:17px;line-height:2.15;color:#5c5f66">
              <li>Text painted into a canvas</li>
              <li>Text shipped as an image</li>
              <li>CSS pseudo-element content</li>
              <li>Frames from another site</li>
              <li>The built-in PDF viewer</li>
              <li>Browser settings pages</li>
            </ul>
          </div>
        </div>
      </div>`
    ),

    /* 5. The permission story, which is the reason to pick this one. */
    's5-privacy': page(
      1280,
      800,
      `<div class="wrap green" style="justify-content:center;padding:0 92px">
        <h2 style="font-size:44px">A fresh install can't read<br>a single website.</h2>
        <p class="sub" style="margin-top:24px;max-width:720px;font-size:20px">
          It asks for three things: the tab you're looking at when you click the button,
          permission to inject its own code, and somewhere to keep your settings.
        </p>
        <div style="display:flex;gap:52px;margin-top:46px">
          <div><p style="font-size:30px;font-weight:700">Nothing collected</p>
            <p style="opacity:.85;margin-top:6px;font-size:17px">No analytics, no identifier</p></div>
          <div><p style="font-size:30px;font-weight:700">Nothing sent</p>
            <p style="opacity:.85;margin-top:6px;font-size:17px">The build fails if any code can</p></div>
          <div><p style="font-size:30px;font-weight:700">Open source</p>
            <p style="opacity:.85;margin-top:6px;font-size:17px">MIT, read it yourself</p></div>
        </div>
      </div>`
    ),

    /* Promo tiles. Small one has room for a mark and four words, no more. */
    'tile-small': page(
      440,
      280,
      `<div class="wrap green" style="align-items:center;justify-content:center;gap:14px">
        <img src="icon-128.png" style="width:74px;height:74px">
        <p style="font-size:27px;font-weight:700;letter-spacing:-0.01em">Unlock Copy</p>
        <p style="font-size:14.5px;opacity:.9;text-align:center;line-height:1.45;max-width:330px">
          Selection, right-click and Ctrl+C,<br>back on sites that block them
        </p>
      </div>`
    ),

    'tile-marquee': page(
      1400,
      560,
      `<div class="wrap green" style="flex-direction:row;align-items:center;padding:0 88px;gap:60px">
        <img src="icon-128.png" style="width:150px;height:150px;flex:none">
        <div style="flex:1">
          <p style="font-size:60px;font-weight:700;letter-spacing:-0.025em;line-height:1.06">
            Copy from sites that stop you.
          </p>
          <p style="font-size:24px;opacity:.9;margin-top:18px">
            One click. No account. No access to any site until you ask.
          </p>
        </div>
      </div>`
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Popup rendering                                                     */
/* ------------------------------------------------------------------ */

/**
 * The real popup markup, script and stylesheet, driven with a stubbed extension
 * API so a chosen state can be shown.
 *
 * The popup cannot simply be opened as a tab: it resolves the active tab to
 * decide what to display, and as a tab it would resolve to itself and render
 * the "can't run here" state.
 */
async function popupVariant(name, state) {
  const html = await fs.readFile(path.join(ROOT, 'dist', 'chrome', 'popup', 'popup.html'), 'utf8');
  const stub = `<script>
    window.__STATE = ${JSON.stringify(state)};
    window.chrome = {
      runtime: { sendMessage: async (m) => (m.type === 'unlock-copy/state' ? window.__STATE : { ok: true }),
                 openOptionsPage() {} },
      permissions: { request: async () => true, contains: async () => true },
    };
  </script>`;
  const patched = html
    .replace('<script src="../lib/browser.js"></script>', stub + '<script src="lib/browser.js"></script>')
    .replace('<script src="../lib/policy.js"></script>', '<script src="lib/policy.js"></script>')
    .replace('<script src="../lib/origins.js"></script>', '<script src="lib/origins.js"></script>');
  await fs.writeFile(path.join(WORK, `${name}.html`), patched);
}

/* ------------------------------------------------------------------ */
/* Browser plumbing                                                    */
/* ------------------------------------------------------------------ */

function extensionId(der) {
  const digest = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/** Same throwaway variant the e2e suite uses: a fixed id plus host access. */
async function buildTestVariant() {
  const to = path.join(ROOT, 'dist', 'store-e2e');
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(path.join(ROOT, 'dist', 'chrome'), to, { recursive: true });
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const mp = path.join(to, 'manifest.json');
  const m = JSON.parse(await fs.readFile(mp, 'utf8'));
  m.host_permissions = ['<all_urls>'];
  m.key = der.toString('base64');
  await fs.writeFile(mp, JSON.stringify(m, null, 2));
  return { dir: to, id: extensionId(der) };
}

async function launch(dir) {
  const binary = await findBrowser();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'unlock-copy-store-'));
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
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  await waitFor('devtools', () => httpJson(PORT, '/json/version'), { timeout: 25000 });
  return { child, profile };
}

/** Drag across an element with real input, which is what a CSS lock stops. */
async function dragAcross(cdp, session, selector) {
  const r = await cdp.evaluate(
    session,
    `(() => { const e = document.querySelector(${JSON.stringify(selector)});
       const b = e.getBoundingClientRect();
       return { x1: b.left + 4, y1: b.top + 12, x2: b.right - 8, y2: b.bottom - 10 }; })()`
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: r.x1, y: r.y1, button: 'left', buttons: 1, clickCount: 1 },
    session
  );
  for (let i = 1; i <= 14; i++) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseMoved',
        x: r.x1 + ((r.x2 - r.x1) * i) / 14,
        y: r.y1 + ((r.y2 - r.y1) * i) / 14,
        button: 'left',
        buttons: 1,
      },
      session
    );
  }
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: r.x2, y: r.y2, button: 'left', buttons: 0, clickCount: 1 },
    session
  );
  await sleep(150);
  return cdp.evaluate(session, 'String(getSelection())');
}

async function shoot(cdp, session, url, file, width, height) {
  await cdp.send('Page.navigate', { url }, session);
  await sleep(900);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: false },
    session
  );
  await sleep(400);
  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', clip: { x: 0, y: 0, width, height, scale: 2 } },
    session
  );
  await fs.writeFile(file, Buffer.from(data, 'base64'));
}

/* ------------------------------------------------------------------ */
/* Output conversion                                                   */
/* ------------------------------------------------------------------ */

/**
 * The dashboard rejects anything with an alpha channel on screenshots and promo
 * tiles, so those are flattened onto white and written as PNG colour type 2,
 * which is 24 bit truecolour with no alpha. The store icon keeps its alpha.
 */
async function flatten(from, to, w, h) {
  await run('magick', [
    from,
    '-resize', `${w}x${h}!`,
    '-background', 'white',
    '-alpha', 'remove',
    '-alpha', 'off',
    '-strip',
    '-define', 'png:color-type=2',
    to,
  ]);
}

/* ------------------------------------------------------------------ */

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await fs.mkdir(OUT, { recursive: true });

  const dist = path.join(ROOT, 'dist', 'chrome');
  await fs.cp(path.join(dist, 'popup'), WORK, { recursive: true });
  await fs.cp(path.join(dist, 'lib'), path.join(WORK, 'lib'), { recursive: true });
  await fs.copyFile(path.join(dist, 'icons', 'icon-256.png'), path.join(WORK, 'icon-128.png'));
  await fs.copyFile(path.join(ROOT, 'store', 'demo.html'), path.join(WORK, 'demo.html'));

  const features = { selection: true, contextmenu: true, keyboard: true, cleanCopy: true, aggressive: false };
  await popupVariant('popup-locked', {
    ok: true, origin: 'https://milfordreview.example', host: 'milfordreview.example',
    always: false, pendingGrant: false, sessionActive: false, local: false, features,
  });
  await popupVariant('popup-always', {
    ok: true, origin: 'https://milfordreview.example', host: 'milfordreview.example',
    always: true, pendingGrant: false, sessionActive: true, local: false, features,
  });

  const { dir, id } = await buildTestVariant();
  const { server, port } = await serveDir(WORK);
  const base = `http://127.0.0.1:${port}`;
  let session;

  try {
    session = await launch(dir);
    const { webSocketDebuggerUrl } = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(webSocketDebuggerUrl);

    const sw = await cdp.attach(
      (
        await waitFor('service worker', async () =>
          (await httpJson(PORT, '/json/list')).find(
            (t) => t.type === 'service_worker' && t.url.includes(id)
          )
        )
      ).id
    );

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page1 = await cdp.attach(targetId);
    await cdp.send('Page.enable', {}, page1);
    await cdp.send('Page.bringToFront', {}, page1);

    /* ---- the real before and after ---- */
    await cdp.send('Page.navigate', { url: `${base}/demo.html` }, page1);
    await sleep(1000);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1120, height: 900, deviceScaleFactor: 2, mobile: false },
      page1
    );
    await sleep(300);

    const before = await dragAcross(cdp, page1, '#p1');
    let shot = await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', clip: { x: 0, y: 0, width: 1120, height: 900, scale: 2 } },
      page1
    );
    await fs.writeFile(path.join(WORK, 'demo-before.png'), Buffer.from(shot.data, 'base64'));

    await cdp.evaluate(
      sw,
      `(async () => { const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(base + '/demo.html')} });
         await UC.background.unlockOnce(tab); return true; })()`
    );
    await sleep(700);

    const after = await dragAcross(cdp, page1, '#p1');
    shot = await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', clip: { x: 0, y: 0, width: 1120, height: 900, scale: 2 } },
      page1
    );
    await fs.writeFile(path.join(WORK, 'demo-after.png'), Buffer.from(shot.data, 'base64'));

    // If these two are not different, the screenshots would be a lie.
    console.log(`  before drag selected ${before.length} chars`);
    console.log(`  after  drag selected ${after.length} chars`);
    if (before.length !== 0 || after.length < 40) {
      throw new Error(
        `demo capture is not showing a real difference (before=${before.length}, after=${after.length})`
      );
    }

    /* ---- popups ---- */
    for (const name of ['popup-locked', 'popup-always']) {
      await cdp.send('Page.navigate', { url: `${base}/${name}.html` }, page1);
      await sleep(700);
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 300, height: 460, deviceScaleFactor: 3, mobile: false },
        page1
      );
      await cdp.send(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
        page1
      );
      await sleep(500);
      const h = await cdp.evaluate(page1, 'document.getElementById("app").getBoundingClientRect().height');
      const s = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: 300, height: Math.ceil(h) + 10, scale: 3 } },
        page1
      );
      await fs.writeFile(path.join(WORK, `${name}.png`), Buffer.from(s.data, 'base64'));
    }

    /* ---- slides ---- */
    const all = slides();
    for (const [name, html] of Object.entries(all)) {
      await fs.writeFile(path.join(WORK, `${name}.html`), html);
    }
    const sizes = {
      's1-hero': [1280, 800], 's2-before-after': [1280, 800], 's3-always': [1280, 800],
      's4-limits': [1280, 800], 's5-privacy': [1280, 800],
      'tile-small': [440, 280], 'tile-marquee': [1400, 560],
    };
    for (const [name, [w, h]] of Object.entries(sizes)) {
      await shoot(cdp, page1, `${base}/${name}.html`, path.join(WORK, `${name}-raw.png`), w, h);
      await flatten(path.join(WORK, `${name}-raw.png`), path.join(OUT, `${name}.png`), w, h);
      console.log(`  ${name}.png  ${w}x${h}`);
    }

    /* ---- store icon, the one asset that keeps its alpha ---- */
    await run('magick', [
      '-background', 'none',
      path.join(ROOT, 'src', 'icons', 'icon.svg'),
      '-resize', '128x128',
      '-depth', '8',
      '-define', 'png:color-type=6',
      '-strip',
      path.join(OUT, 'store-icon-128.png'),
    ]);
    console.log('  store-icon-128.png  128x128');
  } finally {
    server.close();
    await shutdown(session);
  }

  console.log(`\nWrote store assets to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
