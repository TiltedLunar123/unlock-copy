/**
 * Minimal Chrome DevTools Protocol client over Node's built-in WebSocket, plus
 * a static file server for the fixture. No dependencies, same as the rest of
 * the tooling.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Edge first, on purpose.
 *
 * Branded Google Chrome refuses --load-extension and --disable-extensions-except
 * ("--disable-extensions-except is not allowed in Google Chrome, ignoring." in
 * its own log) and then carries on without the extension, so the suite would
 * appear to run and prove nothing. Edge and Chromium are the same engine and
 * still honour the flags. Chrome stays last as a deliberate fallback.
 */
export const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Chromium/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`bad JSON from ${urlPath}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

export async function waitFor(label, fn, { timeout = 30000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * The fixture has to be served over http rather than opened from disk: the
 * clipboard API needs a secure context (127.0.0.1 counts), and the extension
 * itself refuses file:// URLs.
 */
export function serveDir(dir) {
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.join(dir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new CDP(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
      );
    }
    return result.result.value;
  }

  /**
   * Ctrl+C through the browser's real input pipeline.
   *
   * `commands: ['copy']` is what makes this reliable: it asks the browser to run
   * its own editing command rather than hoping a synthesised keystroke gets
   * translated into one, which is exactly what varies between headless and
   * headed runs. The keydown still dispatches to the page first, so a site's
   * keydown blocker is genuinely exercised.
   */
  async copyShortcut(sessionId) {
    await this.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        modifiers: 2,
        key: 'c',
        code: 'KeyC',
        windowsVirtualKeyCode: 67,
        nativeVirtualKeyCode: 67,
        commands: ['copy'],
      },
      sessionId
    );
    await this.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        modifiers: 2,
        key: 'c',
        code: 'KeyC',
        windowsVirtualKeyCode: 67,
        nativeVirtualKeyCode: 67,
      },
      sessionId
    );
  }
}

export async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No Chromium-based browser found.');
}

export async function launch({ port, headless = true, window = '1200,900' } = {}) {
  const binary = await findBrowser();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'unlock-copy-e2e-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    `--window-size=${window}`,
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(binary, args, { stdio: 'ignore' });
  await waitFor('devtools endpoint', () => httpJson(port, '/json/version'), { timeout: 25000 });
  return { child, profile, binary };
}

export async function shutdown(session) {
  try {
    session?.child.kill();
  } catch {
    /* already exited */
  }
  await sleep(300);
  if (session?.profile) {
    await fs.rm(session.profile, { recursive: true, force: true }).catch(() => {});
  }
}
