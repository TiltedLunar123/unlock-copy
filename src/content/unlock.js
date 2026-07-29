/**
 * Unlock Copy - page engine.
 *
 * Runs in the MAIN world, either at document_start as a registered content
 * script (the "early" mode) or injected on demand via scripting.executeScript
 * (the "late" mode). The two modes are genuinely different, not a fast path and
 * a slow path:
 *
 *   early - we are the first script on the page, so nothing hostile has
 *           registered yet. We patch addEventListener and wrap every listener
 *           the page later registers. The page's handlers still run, they just
 *           cannot cancel anything. Side effects survive; only the abuse stops.
 *
 *   late  - page script already ran. Its listeners cannot be enumerated, let
 *           alone removed, so wrapping alone would miss them. We additionally
 *           run a capture-phase net on window that stops the event before it
 *           reaches anything the page registered lower down. That is blunter,
 *           and it is why "Always unlock" exists.
 *
 * Nothing here reaches the network and nothing here is stored.
 */
(() => {
  'use strict';

  const KEY = '__unlockCopyEngine';
  const CHANNEL_POLICY = '__unlock-copy-policy';
  const CHANNEL_READY = '__unlock-copy-ready';

  if (window[KEY]) {
    // Already installed. A second injection means the popup was used again, so
    // re-apply the DOM level work and leave the prototype patches alone.
    try {
      window[KEY].refresh();
    } catch {
      /* a broken re-entry must never take the first install down with it */
    }
    return;
  }

  /* ---------------------------------------------------------------- */
  /* Event vocabulary                                                  */
  /* ---------------------------------------------------------------- */

  /** Cancelling any of these is how a page stops you selecting or copying. */
  const SELECTION_EVENTS = [
    'copy',
    'cut',
    'beforecopy',
    'beforecut',
    'selectstart',
    'select',
    'dragstart',
  ];
  const MENU_EVENTS = ['contextmenu'];
  const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];
  /** Only under aggressive mode: pages use these for real UI far more often. */
  const POINTER_EVENTS = ['mousedown', 'mouseup'];

  /**
   * Inline attributes worth stripping. Deliberately excludes onmousedown and
   * onkeydown, which are load-bearing on ordinary sites; those are only touched
   * in aggressive mode.
   */
  const HOSTILE_ATTRS = [
    'oncontextmenu',
    'oncopy',
    'oncut',
    'onbeforecopy',
    'onbeforecut',
    'onselectstart',
    'onselect',
    'ondragstart',
  ];
  const AGGRESSIVE_ATTRS = ['onmousedown', 'onmouseup', 'onkeydown', 'onkeypress'];

  /**
   * Editor roots that own their copy handling for good reasons. Calling through
   * to these untouched is what keeps this extension from being another
   * "breaks Google Docs" one-star magnet.
   */
  const EDITOR_SELECTOR = [
    '[contenteditable]',
    '[role="textbox"]',
    '.CodeMirror',
    '.cm-editor',
    '.monaco-editor',
    '.ProseMirror',
    '.ql-editor',
    '.ace_editor',
    '[data-slate-editor]',
    '.kix-appview',
    '.docs-texteventtarget-iframe',
  ].join(',');

  const NOOP = function () {};

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  const policy = {
    enabled: true,
    selection: true,
    contextmenu: true,
    keyboard: true,
    cleanCopy: true,
    aggressive: false,
    mode: 'late',
  };

  /** Undo stack, so disabling actually restores the page rather than reloading it. */
  const undo = [];
  /** Shadow roots we have reached, including closed ones caught at creation. */
  const shadowRoots = new Set();

  const rawAdd = EventTarget.prototype.addEventListener;
  const rawRemove = EventTarget.prototype.removeEventListener;
  const wrappers = new WeakMap();

  let observer = null;
  let netInstalled = false;

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function typeIsHostile(type) {
    if (policy.selection && SELECTION_EVENTS.indexOf(type) !== -1) return true;
    if (policy.contextmenu && MENU_EVENTS.indexOf(type) !== -1) return true;
    if (policy.keyboard && KEY_EVENTS.indexOf(type) !== -1) return true;
    if (policy.aggressive && POINTER_EVENTS.indexOf(type) !== -1) return true;
    return false;
  }

  /**
   * Walk up through shadow boundaries looking for an editing context. Plain
   * parentElement stops at a shadow root, so hop to the host and keep going.
   */
  function isEditor(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    let hops = 0;
    while (el && hops++ < 200) {
      try {
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.matches && el.matches(EDITOR_SELECTOR)) return true;
      } catch {
        /* a custom element with a hostile matches() must not stop the walk */
      }
      if (el.parentElement) {
        el = el.parentElement;
        continue;
      }
      const root = el.getRootNode ? el.getRootNode() : null;
      el = root && root.host ? root.host : null;
    }
    return false;
  }

  /** True for the shortcuts a page has no business eating. */
  function isUnlockCombo(e) {
    if (e.key === 'F12') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return false;
    const k = String(e.key || '').toLowerCase();
    if (e.shiftKey) return k === 'i' || k === 'j' || k === 'c';
    return k === 'c' || k === 'x' || k === 'a' || k === 's' || k === 'u' || k === 'p';
  }

  /** Should this event be left completely alone? */
  function isExempt(e) {
    if (!policy.enabled) return true;
    let target;
    try {
      target = e.target;
    } catch {
      return true;
    }
    if (KEY_EVENTS.indexOf(e.type) !== -1 && !isUnlockCombo(e)) return true;
    return isEditor(target);
  }

  /**
   * Strip an event of its ability to cancel, for the duration of one listener
   * call. The properties are own-property shadows over Event.prototype, so
   * deleting them afterwards restores normal behaviour for every other
   * listener in the chain.
   *
   * returnValue needs a data property rather than a no-op function: it is an
   * accessor whose setter is the legacy cancel path, so assigning false to it
   * is equivalent to preventDefault().
   */
  function neuter(e) {
    const shadowed = [];
    const put = (name, value) => {
      try {
        Object.defineProperty(e, name, { value, writable: true, configurable: true });
        shadowed.push(name);
      } catch {
        /* non-configurable on some exotic event subclass; skip it */
      }
    };

    put('preventDefault', NOOP);
    put('stopPropagation', NOOP);
    put('stopImmediatePropagation', NOOP);
    put('returnValue', true);

    // A page that does not cancel the copy can still overwrite what lands on
    // the clipboard. Both holes have to be closed, and closing only one of
    // them looks like it works while the attribution text still gets through.
    if (policy.cleanCopy && (e.type === 'copy' || e.type === 'cut')) {
      let real = null;
      try {
        real = e.clipboardData;
      } catch {
        real = null;
      }
      put('clipboardData', makeInertClipboard(real));
    }

    return () => {
      for (const name of shadowed) {
        try {
          delete e[name];
        } catch {
          /* nothing useful to do; the event is about to be discarded anyway */
        }
      }
    };
  }

  /** Reads pass through, writes go nowhere. */
  function makeInertClipboard(real) {
    return {
      setData: NOOP,
      clearData: NOOP,
      setDragImage: NOOP,
      getData(type) {
        try {
          return real ? real.getData(type) : '';
        } catch {
          return '';
        }
      },
      get types() {
        try {
          return real ? real.types : [];
        } catch {
          return [];
        }
      },
      get items() {
        try {
          return real ? real.items : undefined;
        } catch {
          return undefined;
        }
      },
      get files() {
        try {
          return real ? real.files : undefined;
        } catch {
          return undefined;
        }
      },
      get dropEffect() {
        return 'none';
      },
      set dropEffect(_v) {},
      get effectAllowed() {
        return 'none';
      },
      set effectAllowed(_v) {},
    };
  }

  /**
   * Wrap a page listener so it runs but cannot cancel. Identity is cached so
   * removeEventListener can find the same wrapper again.
   */
  function wrapListener(listener) {
    if (!listener) return listener;
    const existing = wrappers.get(listener);
    if (existing) return existing;

    const isObject = typeof listener === 'object' && typeof listener.handleEvent === 'function';
    if (typeof listener !== 'function' && !isObject) return listener;

    const wrapper = function (event) {
      const call = () =>
        isObject ? listener.handleEvent.call(listener, event) : listener.call(this, event);

      if (!policy.enabled || !typeIsHostile(event.type) || isExempt(event)) {
        return call();
      }
      const restore = neuter(event);
      try {
        return call();
      } finally {
        restore();
      }
    };

    wrappers.set(listener, wrapper);
    return wrapper;
  }

  /* ---------------------------------------------------------------- */
  /* Patch: addEventListener                                           */
  /* ---------------------------------------------------------------- */

  function patchEventTarget() {
    const proto = EventTarget.prototype;
    const addDesc = Object.getOwnPropertyDescriptor(proto, 'addEventListener');
    const removeDesc = Object.getOwnPropertyDescriptor(proto, 'removeEventListener');
    if (!addDesc || !addDesc.configurable) return;

    proto.addEventListener = function (type, listener, options) {
      if (typeIsHostile(type)) {
        return rawAdd.call(this, type, wrapListener(listener), options);
      }
      return rawAdd.call(this, type, listener, options);
    };

    proto.removeEventListener = function (type, listener, options) {
      const wrapper = listener && wrappers.get(listener);
      if (wrapper) rawRemove.call(this, type, wrapper, options);
      return rawRemove.call(this, type, listener, options);
    };

    undo.push(() => {
      Object.defineProperty(proto, 'addEventListener', addDesc);
      if (removeDesc) Object.defineProperty(proto, 'removeEventListener', removeDesc);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Patch: on* handler properties                                     */
  /* ---------------------------------------------------------------- */

  /**
   * `document.oncopy = () => false` never goes through addEventListener, so it
   * needs its own guard. Rather than swallowing the assignment we accept it and
   * register the handler through the wrapping path, which keeps the page's
   * intent intact minus the cancelling.
   */
  function patchHandlerProps() {
    const targets = [
      [Document.prototype, ['oncontextmenu', 'oncopy', 'oncut', 'onselectstart', 'ondragstart']],
      [
        HTMLElement.prototype,
        ['oncontextmenu', 'oncopy', 'oncut', 'onselectstart', 'onselect', 'ondragstart'],
      ],
    ];
    // Window handler properties live on the instance in some engines and on
    // Window.prototype in others, so try both and take whichever exists.
    const winProto = typeof Window === 'function' ? Window.prototype : null;
    if (winProto) targets.push([winProto, ['oncontextmenu', 'oncopy', 'oncut']]);

    for (const [proto, names] of targets) {
      for (const name of names) {
        patchHandlerProp(proto, name, name.slice(2));
      }
    }
  }

  function patchHandlerProp(proto, name, type) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(proto, name);
    } catch {
      return;
    }
    if (!desc || !desc.configurable || !desc.set) return;

    const store = new WeakMap();
    try {
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          const entry = store.get(this);
          return entry ? entry.fn : null;
        },
        set(fn) {
          const previous = store.get(this);
          if (previous) {
            rawRemove.call(this, type, previous.wrapped, false);
            store.delete(this);
          }
          if (typeof fn === 'function') {
            const wrapped = wrapListener(fn);
            store.set(this, { fn, wrapped });
            rawAdd.call(this, type, wrapped, false);
          }
        },
      });
      undo.push(() => Object.defineProperty(proto, name, desc));
    } catch {
      /* frozen prototype; the capture net still covers this case */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Patch: selection nuking                                           */
  /* ---------------------------------------------------------------- */

  /** Defeats `setInterval(() => getSelection().removeAllRanges(), 50)`. */
  function patchSelection() {
    if (typeof Selection !== 'function') return;
    for (const name of ['removeAllRanges', 'empty']) {
      const desc = Object.getOwnPropertyDescriptor(Selection.prototype, name);
      if (!desc || !desc.configurable || typeof desc.value !== 'function') continue;
      const original = desc.value;
      Selection.prototype[name] = function () {
        // Our own popup and the browser's internals never call this, so a page
        // clearing the selection while the user is trying to copy is always the
        // behaviour being complained about.
        if (policy.enabled && policy.selection) return undefined;
        return original.apply(this, arguments);
      };
      undo.push(() => Object.defineProperty(Selection.prototype, name, desc));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Patch: attachShadow                                               */
  /* ---------------------------------------------------------------- */

  /**
   * A closed shadow root cannot be reached from outside once it exists. The one
   * moment it is reachable is the instant it is created, so keep a reference.
   * Only works in early mode; roots built before we arrive stay unreachable.
   */
  function patchAttachShadow() {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
    if (!desc || !desc.configurable || typeof desc.value !== 'function') return;
    const original = desc.value;
    Element.prototype.attachShadow = function (init) {
      const root = original.apply(this, arguments);
      try {
        shadowRoots.add(root);
        styleShadowRoot(root);
      } catch {
        /* never let our bookkeeping break the page's component */
      }
      return root;
    };
    undo.push(() => Object.defineProperty(Element.prototype, 'attachShadow', desc));
  }

  /* ---------------------------------------------------------------- */
  /* Capture net (late mode only)                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Stops the event during window capture, before it can reach anything the
   * page registered on document, body, a container or the target. This is the
   * only thing that works against listeners that already existed when we
   * arrived, and it is blunter than wrapping because those listeners do not run
   * at all. It loses only to a capture listener registered on window itself
   * before ours, which is exactly the gap "Always unlock" closes.
   *
   * Note there is no preventDefault here on purpose: for contextmenu the
   * default action is the native menu, which is the thing being restored.
   */
  function netHandler(e) {
    if (!policy.enabled) return;
    if (!typeIsHostile(e.type)) return;
    if (isExempt(e)) return;
    e.stopImmediatePropagation();
  }

  function installNet() {
    if (netInstalled) return;
    netInstalled = true;
    const types = SELECTION_EVENTS.concat(MENU_EVENTS, KEY_EVENTS, POINTER_EVENTS);
    for (const type of types) {
      rawAdd.call(window, type, netHandler, true);
    }
    undo.push(() => {
      for (const type of types) rawRemove.call(window, type, netHandler, true);
      netInstalled = false;
    });
  }

  /* ---------------------------------------------------------------- */
  /* DOM level work                                                    */
  /* ---------------------------------------------------------------- */

  function attrList() {
    return policy.aggressive ? HOSTILE_ATTRS.concat(AGGRESSIVE_ATTRS) : HOSTILE_ATTRS;
  }

  function stripAttrs(root) {
    if (!policy.enabled || !root || !root.querySelectorAll) return;
    const attrs = attrList();
    const selector = attrs.map((a) => `[${a}]`).join(',');
    let nodes;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      return;
    }
    for (const el of nodes) {
      for (const attr of attrs) {
        if (el.hasAttribute(attr)) {
          try {
            el.removeAttribute(attr);
            el[attr] = null;
          } catch {
            /* readonly reflection on some elements; the attribute is gone regardless */
          }
        }
      }
    }
  }

  /**
   * Shadow roots do not inherit the USER origin stylesheet the background
   * injects, and CSS does not cross the boundary, so each open root gets its
   * own copy.
   */
  const SHADOW_CSS =
    '*,*::before,*::after{user-select:text !important;-webkit-user-select:text !important;' +
    '-webkit-touch-callout:default !important}' +
    '::selection{background-color:Highlight !important;color:HighlightText !important}';

  function styleShadowRoot(root) {
    if (!policy.enabled || !policy.selection || !root) return;
    try {
      if (root.querySelector('style[data-unlock-copy]')) return;
      const style = document.createElement('style');
      style.setAttribute('data-unlock-copy', '');
      style.textContent = SHADOW_CSS;
      root.appendChild(style);
    } catch {
      /* a root that refuses children is not worth failing the whole pass over */
    }
  }

  function collectOpenShadowRoots(root) {
    let nodes;
    try {
      nodes = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of nodes) {
      if (el.shadowRoot) {
        shadowRoots.add(el.shadowRoot);
        collectOpenShadowRoots(el.shadowRoot);
      }
    }
  }

  function sweep() {
    stripAttrs(document);
    collectOpenShadowRoots(document);
    for (const root of shadowRoots) {
      styleShadowRoot(root);
      stripAttrs(root);
    }
  }

  function startObserver() {
    if (observer || typeof MutationObserver !== 'function') return;
    let queued = false;
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        try {
          sweep();
        } catch {
          /* a single bad pass must not tear down the observer */
        }
      });
    });
    try {
      observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: HOSTILE_ATTRS.concat(AGGRESSIVE_ATTRS),
      });
      undo.push(() => {
        observer.disconnect();
        observer = null;
      });
    } catch {
      observer = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Overlay shields (aggressive only)                                 */
  /* ---------------------------------------------------------------- */

  /**
   * A transparent full-viewport div swallows the mouse so the text underneath
   * cannot be selected. Detection is a heuristic and a false positive breaks
   * real UI, so this is opt-in rather than on by default.
   */
  function shieldHandler(e) {
    if (!policy.enabled || !policy.aggressive) return;
    let el;
    try {
      el = document.elementFromPoint(e.clientX, e.clientY);
    } catch {
      return;
    }
    if (!el || el === document.body || el === document.documentElement) return;
    if ((el.textContent || '').trim().length > 0) return;
    let style;
    try {
      style = getComputedStyle(el);
    } catch {
      return;
    }
    if (style.position !== 'fixed' && style.position !== 'absolute') return;
    const rect = el.getBoundingClientRect();
    const coverage = (rect.width * rect.height) / (innerWidth * innerHeight || 1);
    if (coverage < 0.5) return;
    el.style.setProperty('pointer-events', 'none', 'important');
  }

  function installShields() {
    rawAdd.call(window, 'mousedown', shieldHandler, true);
    undo.push(() => rawRemove.call(window, 'mousedown', shieldHandler, true));
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  function install() {
    patchEventTarget();
    patchHandlerProps();
    patchSelection();
    if (policy.mode === 'early') {
      patchAttachShadow();
    } else {
      // Late mode cannot un-register what already exists, so it needs the net.
      installNet();
    }
    installShields();

    const start = () => {
      sweep();
      startObserver();
    };
    if (document.documentElement) start();
    else rawAdd.call(document, 'DOMContentLoaded', start, { once: true });
  }

  function refresh() {
    try {
      sweep();
    } catch {
      /* best effort; the patches are what matter */
    }
  }

  function configure(next) {
    if (!next || typeof next !== 'object') return;
    for (const key of Object.keys(policy)) {
      if (key in next) policy[key] = next[key];
    }
    if (policy.enabled) refresh();
  }

  function disable() {
    policy.enabled = false;
    while (undo.length) {
      const step = undo.pop();
      try {
        step();
      } catch {
        /* keep unwinding: a stuck step must not strand the rest patched */
      }
    }
    for (const root of shadowRoots) {
      try {
        const style = root.querySelector('style[data-unlock-copy]');
        if (style) style.remove();
      } catch {
        /* the root may be gone already */
      }
    }
    shadowRoots.clear();
    try {
      delete window[KEY];
    } catch {
      /* leaving the handle behind is harmless once everything is unwound */
    }
  }

  const api = { configure, refresh, disable, policy };

  try {
    Object.defineProperty(window, KEY, {
      value: api,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    window[KEY] = api;
  }

  // A boot payload set by the injector immediately before this file, used by
  // the late path where there is no isolated-world bridge to talk to.
  try {
    if (window.__unlockCopyBoot) {
      configure(window.__unlockCopyBoot);
      delete window.__unlockCopyBoot;
    }
  } catch {
    /* fall through to defaults */
  }

  // Early mode talks to the isolated-world bridge instead. Announce first, then
  // listen, so a bridge that is already up answers immediately and one that is
  // not can still deliver later.
  rawAdd.call(document, CHANNEL_POLICY, (e) => {
    try {
      configure(e.detail);
    } catch {
      /* malformed payload; keep running on the previous policy */
    }
  });

  install();

  try {
    document.dispatchEvent(new CustomEvent(CHANNEL_READY));
  } catch {
    /* the bridge broadcasts unprompted as well, so this is only an optimisation */
  }
})();
