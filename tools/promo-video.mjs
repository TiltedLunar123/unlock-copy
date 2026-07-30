/**
 * Promo video for the store listing and YouTube.
 *
 * 1920x1080, 30fps, narration from tools/promo-vo.py.
 *
 * The drag footage is real. The script loads store/demo.html in a browser with
 * the extension loaded, drags across a paragraph one step at a time and
 * screenshots each step, then runs the extension's own unlock path and repeats.
 * Both sequences play in the finished video, so what you see is the extension
 * working rather than an animation of it working. The run fails if the two
 * sequences do not actually differ.
 *
 * Frames are rendered by seeking a deterministic clock, never by letting CSS
 * animations run. A CSS transition advances on wall-clock time, so a screenshot
 * loop would sample it at whatever moment the round trip happened to land on
 * and the motion would judder. Everything here is a pure function of t.
 *
 *   node tools/promo-video.mjs            full render
 *   node tools/promo-video.mjs --quick    every 6th frame, for checking layout
 *
 * Needs ffmpeg, Edge or Chromium, and dist/promo/vo.wav from promo-vo.py.
 */

import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { CDP, findBrowser, httpJson, serveDir, shutdown, sleep, waitFor } from './cdp.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMO = path.join(ROOT, 'dist', 'promo');
const WORK = path.join(PROMO, 'work');
const FRAMES = path.join(PROMO, 'frames');
const OUT = path.join(os.homedir(), 'Downloads', 'unlock-copy-store-assets');
const PORT = 9577;

const W = 1920;
const H = 1080;
const FPS = 30;
const DRAG_STEPS = 22;
const quick = process.argv.includes('--quick');

/* ------------------------------------------------------------------ */
/* Stage                                                               */
/* ------------------------------------------------------------------ */

/**
 * The whole video as one page with a `seek(t)` entry point.
 *
 * Every visual property is computed from t. There is not a single CSS
 * transition or keyframe in here, on purpose: see the header comment.
 */
function stage(timeline, dragPath) {
  const scenes = [];
  for (const line of timeline.lines) {
    const last = scenes[scenes.length - 1];
    if (!last || last.name !== line.scene) scenes.push({ name: line.scene, start: line.start, end: line.end });
    else last.end = line.end;
  }
  // Each scene runs until the next one starts, so there is never a gap.
  for (let i = 0; i < scenes.length - 1; i++) scenes[i].end = scenes[i + 1].start;
  scenes[scenes.length - 1].end = timeline.total;

  const data = JSON.stringify({ timeline, scenes, dragPath, steps: DRAG_STEPS });

  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#0d1512}
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
#stage{position:relative;width:${W}px;height:${H}px;overflow:hidden}
.scene{position:absolute;inset:0;opacity:0}
.bg-green{background:linear-gradient(135deg,#2fb96d 0%,#0f6335 100%)}
.bg-light{background:#eef1ef}
h1{font-size:78px;line-height:1.05;letter-spacing:-0.03em;font-weight:700;color:#fff}
h2{font-size:60px;line-height:1.08;letter-spacing:-0.025em;font-weight:700}
.sub{font-size:30px;line-height:1.4;font-weight:400}
.frame{position:absolute;border-radius:16px;overflow:hidden;box-shadow:0 40px 90px rgba(0,0,0,.34);background:#fff}
.frame .bar{height:38px;background:#dfe1e4;display:flex;align-items:center;gap:8px;padding:0 16px}
.frame .dot{width:11px;height:11px;border-radius:50%;background:#c3c5ca}
.frame img{display:block;width:100%}
.pop{position:absolute;width:390px;border-radius:14px;overflow:hidden;box-shadow:0 30px 70px rgba(0,0,0,.4)}
.pop img{display:block;width:100%}
/* Both overlays sit above every scene. The scenes carry an explicit z-index so
   the active one paints over the outgoing one during a cross-fade, and that
   also puts them above anything left on the default layer. Without these the
   cursor and the captions are rendered and then covered. */
#cursor{position:absolute;width:34px;height:52px;pointer-events:none;z-index:5;
  filter:drop-shadow(0 3px 5px rgba(0,0,0,.45))}
#cap{position:absolute;left:0;right:0;bottom:56px;text-align:center;z-index:6}
#cap span{display:inline-block;background:rgba(9,18,14,.82);color:#fff;font-size:33px;line-height:1.35;
  padding:13px 30px;border-radius:11px;max-width:1400px}
.card{background:#fff;border-radius:18px;padding:34px 38px}
.lbl{font-size:19px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
li{list-style:none;font-size:25px;line-height:2.05;color:#33353b}
</style></head><body><div id="stage">

<div class="scene" id="s-problem" style="background:#eef1ef">
  <div class="frame" id="pf" style="left:150px;top:170px;width:1180px"></div>
  <div style="position:absolute;left:1400px;top:330px;width:400px">
    <h2 style="color:#14161a">You can't<br>copy this.</h2>
    <p class="sub" style="color:#5a5d64;margin-top:20px">The page is stopping you on purpose.</p>
  </div>
</div>

<div class="scene" id="s-fix" style="background:#eef1ef">
  <div class="frame" id="ff" style="left:150px;top:170px;width:1180px"></div>
  <div class="pop" id="fpop" style="left:1420px;top:180px"><img id="fpopimg"></div>
</div>

<div class="scene bg-light" id="s-always">
  <div style="position:absolute;left:130px;top:300px;width:900px">
    <h2 style="color:#14161a">It runs before<br>the site's code.</h2>
    <p class="sub" style="color:#5a5d64;margin-top:26px;max-width:780px">
      Switch on Always unlock and your browser asks once, about that one site.
    </p>
  </div>
  <div class="pop" id="apop" style="left:1180px;top:230px;width:430px"><img id="apopimg"></div>
</div>

<div class="scene bg-light" id="s-gentle">
  <div style="position:absolute;left:130px;top:150px;width:1660px">
    <h2 style="color:#14161a">It leaves working sites alone.</h2>
    <p class="sub" style="color:#5a5d64;margin-top:18px">
      A page listening for the copy event isn't automatically doing something hostile.
    </p>
    <div style="display:flex;gap:34px;margin-top:52px">
      <div class="card" style="flex:1">
        <p class="lbl" style="color:#1f8b4c">Keeps working</p>
        <ul style="margin-top:16px">
          <li>Copy buttons on code blocks</li><li>Rich text editors</li><li>Password managers</li>
        </ul>
      </div>
      <div class="card" style="flex:1">
        <p class="lbl" style="color:#1f8b4c">Comes back</p>
        <ul style="margin-top:16px">
          <li>Selection and copy</li><li>The right-click menu</li><li>Keyboard shortcuts</li>
        </ul>
      </div>
    </div>
  </div>
</div>

<div class="scene bg-green" id="s-perms">
  <div style="position:absolute;left:130px;top:330px;width:1660px">
    <h2 style="color:#fff">A fresh install can't read<br>a single website.</h2>
    <p class="sub" style="color:rgba(255,255,255,.92);margin-top:28px;max-width:1100px">
      One site at a time, only when you ask. Nothing is collected and nothing is sent.
    </p>
  </div>
</div>

<div class="scene bg-green" id="s-outro">
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
    <img id="outicon" style="width:168px;height:168px">
    <p style="font-size:74px;font-weight:700;color:#fff;letter-spacing:-0.02em;margin-top:26px">Unlock Copy</p>
    <p class="sub" style="color:rgba(255,255,255,.9);margin-top:12px">Free and open source. No tracking.</p>
    <p style="font-size:24px;color:rgba(255,255,255,.75);margin-top:34px">github.com/TiltedLunar123/unlock-copy</p>
  </div>
</div>

<svg id="cursor" viewBox="0 0 34 52"><path d="M2 2 L2 40 L11 31 L17 47 L24 44 L18 28 L31 27 Z"
  fill="#fff" stroke="#16211c" stroke-width="2.5" stroke-linejoin="round"/></svg>

<div id="cap"><span id="captext"></span></div>
</div>
<script>
const D = ${data};
const $ = (id) => document.getElementById(id);

/* Preload both drag sequences so a frame never lands mid-decode. */
function seq(prefix, host) {
  const imgs = [];
  for (let i = 0; i < D.steps; i++) {
    const img = new Image();
    img.src = prefix + String(i).padStart(2, '0') + '.jpg';
    img.style.display = 'none';
    host.appendChild(img);
    imgs.push(img);
  }
  return imgs;
}
function makeFrame(host) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML = '<i class="dot"></i><i class="dot"></i><i class="dot"></i>';
  host.appendChild(bar);
  const holder = document.createElement('div');
  host.appendChild(holder);
  return holder;
}
const lockedHost = makeFrame($('pf'));
const unlockedHost = makeFrame($('ff'));
const locked = seq('locked-', lockedHost);
const unlocked = seq('unlocked-', unlockedHost);
$('fpopimg').src = 'popup-locked.png';
$('apopimg').src = 'popup-always.png';
$('outicon').src = 'icon.png';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function showOnly(list, index) {
  for (let i = 0; i < list.length; i++) list[i].style.display = i === index ? 'block' : 'none';
}

/**
 * Position the pointer over a frame using the drag path recorded at capture
 * time, scaled from the captured page size to the on-screen frame size.
 * Headless screenshots do not include the OS cursor, so without this the drag
 * reads as text highlighting itself.
 */
function placeCursor(step, frameLeft, frameTop, frameWidth) {
  const pts = D.dragPath.points;
  const p = pts[clamp(step, 0, pts.length - 1)];
  const scale = frameWidth / D.dragPath.pageWidth;
  $('cursor').style.left = frameLeft + p.x * scale + 'px';
  $('cursor').style.top = frameTop + 38 + p.y * scale + 'px';
  $('cursor').style.opacity = '1';
}

window.seek = function (t) {
  for (const s of D.scenes) {
    const el = $('s-' + s.name);
    const active = t >= s.start && t < s.end;
    // Cross-fade only at the seam, so most frames are a clean single scene.
    let o = 0;
    if (active) o = clamp((t - s.start) / 0.45, 0, 1);
    else if (t >= s.end && t < s.end + 0.45) o = 1 - clamp((t - s.end) / 0.45, 0, 1);
    el.style.opacity = String(o);
    el.style.zIndex = active ? '2' : '1';
  }

  $('cursor').style.opacity = '0';
  const scene = D.scenes.find((s) => t >= s.start && t < s.end) || D.scenes[D.scenes.length - 1];
  const p = clamp((t - scene.start) / (scene.end - scene.start), 0, 1);

  if (scene.name === 'problem') {
    // Drag the whole scene through, looping back so it never sits still.
    const cycle = (p * 1.35) % 1;
    const step = Math.floor(ease(clamp(cycle, 0, 1)) * (D.steps - 1));
    showOnly(locked, step);
    placeCursor(step, 150, 170, 1180);
  } else if (scene.name === 'fix') {
    // Popup slides in, then the same drag runs again, this time selecting.
    const slide = clamp(p / 0.22, 0, 1);
    $('fpop').style.transform = 'translateX(' + (1 - ease(slide)) * 420 + 'px)';
    $('fpopimg').src = p < 0.34 ? 'popup-locked.png' : 'popup-unlocked.png';
    if (p < 0.38) {
      showOnly(unlocked, 0);
    } else {
      const step = Math.floor(ease(clamp((p - 0.38) / 0.52, 0, 1)) * (D.steps - 1));
      showOnly(unlocked, step);
      placeCursor(step, 150, 170, 1180);
    }
  } else if (scene.name === 'always') {
    $('apop').style.transform = 'translateY(' + (1 - ease(clamp(p / 0.3, 0, 1))) * 40 + 'px)';
  }

  const line = D.timeline.lines.find((l) => t >= l.start && t <= l.end + 0.18);
  $('captext').textContent = line ? line.text : '';
  $('cap').style.opacity = line ? '1' : '0';
};
window.seek(0);
</script></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
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

async function buildTestVariant() {
  const to = path.join(ROOT, 'dist', 'promo-e2e');
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
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'unlock-copy-promo-'));
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
      `--window-size=${W},${H}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  await waitFor('devtools', () => httpJson(PORT, '/json/version'), { timeout: 25000 });
  return { child, profile };
}

const PAGE_W = 1180;
const PAGE_H = 740;

/** Drag across a paragraph one step at a time, saving a frame after each. */
async function captureDrag(cdp, session, prefix) {
  const box = await cdp.evaluate(
    session,
    `(() => { const b = document.getElementById('p1').getBoundingClientRect();
       return { x1: b.left + 4, y1: b.top + 13, x2: b.right - 10, y2: b.bottom - 11 }; })()`
  );
  const at = (i) => ({
    x: box.x1 + ((box.x2 - box.x1) * i) / (DRAG_STEPS - 1),
    y: box.y1 + ((box.y2 - box.y1) * i) / (DRAG_STEPS - 1),
  });

  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', ...at(0), button: 'left', buttons: 1, clickCount: 1 },
    session
  );

  const pathPoints = [];
  for (let i = 0; i < DRAG_STEPS; i++) {
    const pt = at(i);
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'left', buttons: 1 },
      session
    );
    await sleep(28);
    const { data } = await cdp.send(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 94, clip: { x: 0, y: 0, width: PAGE_W, height: PAGE_H, scale: 1.5 } },
      session
    );
    await fs.writeFile(path.join(WORK, `${prefix}-${String(i).padStart(2, '0')}.jpg`), Buffer.from(data, 'base64'));
    pathPoints.push({ x: Math.round(pt.x), y: Math.round(pt.y) });
  }

  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', ...at(DRAG_STEPS - 1), button: 'left', buttons: 0, clickCount: 1 },
    session
  );
  const selected = await cdp.evaluate(session, 'String(getSelection())');
  return { pathPoints, selected };
}

async function popupVariant(name, state) {
  const html = await fs.readFile(path.join(ROOT, 'dist', 'chrome', 'popup', 'popup.html'), 'utf8');
  const stub = `<script>window.__S=${JSON.stringify(state)};window.chrome={
    runtime:{sendMessage:async(m)=>(m.type==='unlock-copy/state'?window.__S:{ok:true}),openOptionsPage(){}},
    permissions:{request:async()=>true,contains:async()=>true}};</script>`;
  await fs.writeFile(
    path.join(WORK, `${name}.html`),
    html
      .replace('<script src="../lib/browser.js"></script>', stub + '<script src="lib/browser.js"></script>')
      .replace('<script src="../lib/policy.js"></script>', '<script src="lib/policy.js"></script>')
      .replace('<script src="../lib/origins.js"></script>', '<script src="lib/origins.js"></script>')
  );
}

/* ------------------------------------------------------------------ */

async function main() {
  const timeline = JSON.parse(await fs.readFile(path.join(PROMO, 'timeline.json'), 'utf8'));
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.rm(FRAMES, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await fs.mkdir(FRAMES, { recursive: true });
  await fs.mkdir(OUT, { recursive: true });

  const dist = path.join(ROOT, 'dist', 'chrome');
  await fs.cp(path.join(dist, 'popup'), WORK, { recursive: true });
  await fs.cp(path.join(dist, 'lib'), path.join(WORK, 'lib'), { recursive: true });
  await fs.copyFile(path.join(dist, 'icons', 'icon-256.png'), path.join(WORK, 'icon.png'));
  await fs.copyFile(path.join(ROOT, 'store', 'demo.html'), path.join(WORK, 'demo.html'));

  const feats = { selection: true, contextmenu: true, keyboard: true, cleanCopy: true, aggressive: false };
  const site = { origin: 'https://milfordreview.example', host: 'milfordreview.example', local: false, features: feats };
  await popupVariant('popup-locked', { ok: true, ...site, always: false, pendingGrant: false, sessionActive: false });
  await popupVariant('popup-unlocked', { ok: true, ...site, always: false, pendingGrant: false, sessionActive: true });
  await popupVariant('popup-always', { ok: true, ...site, always: true, pendingGrant: false, sessionActive: true });

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
          (await httpJson(PORT, '/json/list')).find((t) => t.type === 'service_worker' && t.url.includes(id))
        )
      ).id
    );

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page = await cdp.attach(targetId);
    await cdp.send('Page.enable', {}, page);
    await cdp.send('Page.bringToFront', {}, page);

    /* ---- real footage ---- */
    console.log('capturing footage');
    await cdp.send('Page.navigate', { url: `${base}/demo.html` }, page);
    await sleep(1100);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: PAGE_W, height: PAGE_H, deviceScaleFactor: 1.5, mobile: false },
      page
    );
    await sleep(350);

    const lockedRun = await captureDrag(cdp, page, 'locked');
    await cdp.evaluate(
      sw,
      `(async () => { const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(base + '/demo.html')} });
         await UC.background.unlockOnce(tab); return true; })()`
    );
    await sleep(800);
    const unlockedRun = await captureDrag(cdp, page, 'unlocked');

    console.log(`  locked drag selected ${lockedRun.selected.length} chars`);
    console.log(`  unlocked drag selected ${unlockedRun.selected.length} chars`);
    if (lockedRun.selected.length !== 0 || unlockedRun.selected.length < 40) {
      throw new Error('footage does not show a real difference; refusing to build a misleading video');
    }

    /* ---- popups ---- */
    for (const name of ['popup-locked', 'popup-unlocked', 'popup-always']) {
      await cdp.send('Page.navigate', { url: `${base}/${name}.html` }, page);
      await sleep(650);
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 300, height: 470, deviceScaleFactor: 3, mobile: false },
        page
      );
      await cdp.send(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
        page
      );
      await sleep(450);
      const h = await cdp.evaluate(page, 'document.getElementById("app").getBoundingClientRect().height');
      const s = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: 300, height: Math.ceil(h) + 8, scale: 3 } },
        page
      );
      await fs.writeFile(path.join(WORK, `${name}.png`), Buffer.from(s.data, 'base64'));
    }

    /* ---- render ---- */
    // An object rather than an array with an extra property: JSON.stringify
    // serialises arrays as arrays and silently drops anything hung off them,
    // which would leave the stage dividing by an undefined page width.
    const dragPath = { points: lockedRun.pathPoints, pageWidth: PAGE_W };
    await fs.writeFile(path.join(WORK, 'stage.html'), stage(timeline, dragPath));

    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, page);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 1, mobile: false },
      page
    );
    await cdp.send('Page.navigate', { url: `${base}/stage.html` }, page);
    await sleep(1600);

    const total = Math.ceil(timeline.total * FPS);
    const step = quick ? 6 : 1;
    console.log(`rendering ${Math.ceil(total / step)} frames of ${total}`);

    for (let i = 0; i < total; i += step) {
      await cdp.evaluate(page, `window.seek(${(i / FPS).toFixed(4)})`);
      const { data } = await cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 93, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } },
        page
      );
      await fs.writeFile(path.join(FRAMES, `f-${String(i).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
      if (i % (FPS * 5) === 0) console.log(`  ${(i / FPS).toFixed(1)}s / ${timeline.total.toFixed(1)}s`);
    }
  } finally {
    server.close();
    await shutdown(session);
  }

  if (quick) {
    console.log('\nquick pass done, no encode');
    return;
  }

  /* ---- encode ---- */
  const out = path.join(OUT, 'unlock-copy-promo-1080p.mp4');
  console.log('encoding');
  await run('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAMES, 'f-%05d.jpg'),
    '-i', path.join(PROMO, 'vo.wav'),
    // loudnorm to roughly what YouTube normalises to, so the video is not
    // quieter than everything else in the sidebar.
    //
    // The explicit rate and channel count matter: loudnorm resamples to 192 kHz
    // internally and will happily emit that, which produced a 96 kHz mono AAC
    // track the first time. 48 kHz stereo is the delivery format every platform
    // expects.
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-ar', '48000',
    '-ac', '2',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    out,
  ]);

  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=width,height,codec_name',
    '-of', 'default=noprint_wrappers=1',
    out,
  ]);
  console.log(`\n${out}\n${stdout.trim()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
