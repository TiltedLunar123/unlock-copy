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
    //
    // The boot payload the injector just wrote is dead on this path: it was
    // already delivered through configure(). Clearing it keeps the extension
    // from leaving its settings sitting on the page as a readable global for
    // the rest of the document's life.
    try {
      delete window.__unlockCopyBoot;
    } catch {
      /* not deletable here; harmless, it is only ever read once */
    }
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
  /**
   * Only under aggressive mode. Pages use mousedown and mouseup for real UI far
   * more often than for blocking, and unblocking paste is worth having (sites
   * that forbid pasting into a password or confirmation field are a common
   * complaint) but is the fastest way to break an editor if applied by default.
   */
  const POINTER_EVENTS = ['mousedown', 'mouseup', 'paste', 'beforepaste'];

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
  /**
   * Stripped only under aggressive mode.
   *
   * onpaste and onbeforepaste belong here because aggressive mode is what
   * unblocks pasting, and it was unblocking the paste event and the keydown
   * route into it while leaving `onpaste="return false"` on the field itself
   * untouched, which is the one spelling a confirmation box usually uses.
   */
  const AGGRESSIVE_ATTRS = [
    'onmousedown',
    'onmouseup',
    'onkeydown',
    'onkeypress',
    'onpaste',
    'onbeforepaste',
  ];

  /**
   * Editor roots that own their copy handling for good reasons. Calling through
   * to these untouched is what keeps this extension from being another
   * "breaks Google Docs" one-star magnet.
   */
  const EDITOR_SELECTOR = [
    // Matched by value, not by presence. `contenteditable="false"` is the
    // spelling for "explicitly not editable" and it is ordinary markup: rich
    // text editors use it to mark non-editable islands, and a page can wrap its
    // article in one. Matching the bare attribute read every one of those as an
    // editor and handed it the exemption, so the content people installed this
    // for stayed locked. isContentEditable, checked first in isEditor, already
    // answers this correctly; only the selector was wrong.
    '[contenteditable]:not([contenteditable="false" i])',
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
    /**
     * Defaults to early, and that direction matters.
     *
     * A registered content script has no way to be told which mode it is in
     * before it has to decide: it runs at document_start and the bridge cannot
     * answer until after a message round trip, by which point the patches are
     * already installed. The late path, by contrast, always sets a boot payload
     * immediately before injecting this file, so "late" is the case that can
     * always announce itself and "early" is the correct default for the case
     * that cannot.
     *
     * Getting this backwards is not a small mistake. It makes every
     * always-unlocked site install the blunt capture net instead of wrapping,
     * which silently drops the legitimate copy handlers that wrapping exists to
     * preserve, and skips the attachShadow patch entirely.
     */
    mode: 'early',
  };

  /** Undo stack, so disabling actually restores the page rather than reloading it. */
  const undo = [];
  /** Shadow roots we have reached, including closed ones caught at creation. */
  const shadowRoots = new Set();
  /** Roots seen since the last pass, so a scoped pass need not revisit the rest. */
  const freshRoots = [];
  /**
   * Inline handlers removed from the page, so relocking puts them back.
   *
   * The undo stack restores the patches; it cannot restore a DOM edit it has no
   * record of, and without this list "lock" left a page that blocked copying
   * purely through `oncopy="return false"` permanently unblocked. Capped
   * because these are strong element references: real pages carry a handful,
   * but a page that rebuilds hostile markup in a loop would otherwise turn the
   * fix into a leak, and an incomplete relock is the better failure.
   */
  const stripped = [];
  const STRIPPED_CAP = 2000;

  function noteStripped(el, attr, value) {
    if (typeof value !== 'string' || stripped.length >= STRIPPED_CAP) return;
    stripped.push({ el, attr, value });
  }

  /**
   * Inline styles the aggressive shield overwrote, so relocking puts them back.
   *
   * Same reasoning as `stripped`, and the same failure without it: the undo
   * stack restores patches, not DOM edits it has no record of, so a shielded
   * overlay stayed click-through for the rest of the document's life and the
   * site's own UI stayed broken until a reload. Capped for the same reason too.
   */
  const shielded = [];

  function noteShielded(el) {
    if (shielded.length >= STRIPPED_CAP) return false;
    // Only the first shot per element is worth keeping. Recording every
    // mousedown would restore the value this patch already wrote.
    for (const entry of shielded) {
      if (entry.el === el) return false;
    }
    shielded.push({
      el,
      value: el.style.getPropertyValue('pointer-events'),
      priority: el.style.getPropertyPriority('pointer-events'),
    });
    return true;
  }

  function restoreShielded() {
    while (shielded.length) {
      const { el, value, priority } = shielded.pop();
      try {
        if (value) el.style.setProperty('pointer-events', value, priority);
        else el.style.removeProperty('pointer-events');
      } catch {
        /* the element is gone, which is as restored as it needs to be */
      }
    }
  }

  function restoreStripped() {
    // Runs after the undo stack has unwound, so setAttribute is the browser's
    // again and will not refuse these as hostile writes.
    while (stripped.length) {
      const { el, attr, value } = stripped.pop();
      try {
        if (!el.hasAttribute(attr)) el.setAttribute(attr, value);
      } catch {
        /* the element is gone, which is as restored as it needs to be */
      }
    }
  }

  const rawAdd = EventTarget.prototype.addEventListener;
  const rawRemove = EventTarget.prototype.removeEventListener;
  const wrappers = new WeakMap();
  /** How many wrapped listener calls are currently neutering a given event. */
  const neuterDepth = new WeakMap();

  let observer = null;
  let netInstalled = false;
  let installed = false;
  /** Set by disable(). Once torn down, this engine stays down. */
  let torn = false;
  /** How many neutered copy or cut dispatches are currently on the stack. */
  let cleanCopyDepth = 0;

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Every type that could ever need neutering, regardless of the current
   * policy.
   *
   * Wrapping is decided once, when the page registers a listener; whether to
   * actually neuter is decided later, when the event fires. Those have to be
   * different questions. If registration consulted the policy, a switch turned
   * on after page load would do nothing to the listeners already registered
   * under the old policy, and the user would see a switch that only works if
   * they reload first.
   */
  const WRAPPABLE = SELECTION_EVENTS.concat(MENU_EVENTS, KEY_EVENTS, POINTER_EVENTS);

  function typeIsHostile(type) {
    if (policy.selection && SELECTION_EVENTS.indexOf(type) !== -1) return true;
    if (policy.contextmenu && MENU_EVENTS.indexOf(type) !== -1) return true;
    if (policy.keyboard && KEY_EVENTS.indexOf(type) !== -1) return true;
    if (policy.aggressive && POINTER_EVENTS.indexOf(type) !== -1) return true;
    return false;
  }

  /**
   * Walk up through shadow boundaries looking for a rich editing context. Plain
   * parentElement stops at a shadow root, so hop to the host and keep going.
   *
   * Deliberately does NOT treat a plain input, textarea or select as an editor.
   * The exemption exists for editors that own their copy handling for real
   * reasons, and a bare form field does not: its copy is the browser's ordinary
   * one. Exempting them would mean a site with a blanket copy ban still blocks
   * copying out of its own comment box, which is precisely the complaint people
   * install this to fix.
   */
  function isEditor(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    let hops = 0;
    while (el && hops++ < 200) {
      try {
        if (el.isContentEditable) return true;
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
    // Paste rides with the pointer group: both are unblocked only under
    // aggressive, for the same reason. Leaving it out here left that mode half
    // wired, because a site that blocks pasting into a confirmation field
    // usually does it from keydown rather than from the paste event, and those
    // keystrokes were being waved through while the paste event was neutered.
    if (k === 'v') return !!policy.aggressive;
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
    // One event can reach several wrapped listeners, and a listener can invoke
    // another one on the same event before returning. Restoring on the first
    // return would hand the outer listener a working preventDefault halfway
    // through, so the shadows are reference counted and only lifted by the
    // outermost call.
    const depth = (neuterDepth.get(e) || 0) + 1;
    neuterDepth.set(e, depth);
    if (depth > 1) return () => neuterDepth.set(e, neuterDepth.get(e) - 1);

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

    // returnValue is the legacy cancel path: assigning false to it calls
    // preventDefault through the accessor on Event.prototype. An accessor that
    // reads back true and ignores writes is closer to the truth than a writable
    // data property, which would let a page assign false, read false back, and
    // believe it had cancelled something it had not.
    try {
      Object.defineProperty(e, 'returnValue', {
        configurable: true,
        get: () => true,
        set: () => {},
      });
      shadowed.push('returnValue');
    } catch {
      /* leave the native accessor in place; preventDefault is already a no-op */
    }

    // A page that does not cancel the copy can still overwrite what lands on
    // the clipboard. Both holes have to be closed, and closing only one of
    // them looks like it works while the attribution text still gets through.
    let cleaning = false;
    if (policy.cleanCopy && (e.type === 'copy' || e.type === 'cut')) {
      let real = null;
      try {
        real = e.clipboardData;
      } catch {
        real = null;
      }
      put('clipboardData', makeInertClipboard(real));
      cleanCopyDepth++;
      cleaning = true;
    }

    return () => {
      const remaining = (neuterDepth.get(e) || 1) - 1;
      neuterDepth.set(e, remaining);
      if (remaining > 0) return;
      if (cleaning) {
        cleaning = false;
        cleanCopyDepth--;
      }
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
      if (WRAPPABLE.indexOf(type) !== -1) {
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
  /* Patch: Event.prototype                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Close the gap underneath the per-event shadows.
   *
   * neuter() replaces preventDefault and friends with own properties on the
   * event, which beats every ordinary `e.preventDefault()`. It does not beat
   * `Event.prototype.preventDefault.call(e)`, which never consults the instance
   * at all, and one line of that in a page's copy handler is enough to make the
   * extension look installed while the copy stays blocked. Guarding the
   * prototype method has no such underside.
   *
   * The guard is the same reference count the shadows use, so this refuses only
   * while a wrapped hostile listener is on the stack. Every other event on the
   * page behaves exactly as before and pays one WeakMap lookup.
   */
  function patchEventProto() {
    if (typeof Event !== 'function') return;

    for (const name of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']) {
      const desc = Object.getOwnPropertyDescriptor(Event.prototype, name);
      if (!desc || !desc.configurable || typeof desc.value !== 'function') continue;
      const original = desc.value;
      Event.prototype[name] = function () {
        if (neuterDepth.get(this) > 0) return undefined;
        return original.apply(this, arguments);
      };
      undo.push(() => Object.defineProperty(Event.prototype, name, desc));
    }

    // returnValue = false is preventDefault under another name, and reaching it
    // through the prototype setter is the same bypass again.
    const desc = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');
    if (!desc || !desc.configurable || !desc.get || !desc.set) return;
    const read = desc.get;
    const write = desc.set;
    try {
      Object.defineProperty(Event.prototype, 'returnValue', {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          if (neuterDepth.get(this) > 0) return true;
          return read.call(this);
        },
        set(value) {
          if (neuterDepth.get(this) > 0) return;
          write.call(this, value);
        },
      });
      undo.push(() => Object.defineProperty(Event.prototype, 'returnValue', desc));
    } catch {
      /* the three methods above are the load-bearing half */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Patch: async clipboard                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Refuse a clipboard write issued from inside a copy we are cleaning.
   *
   * Making event.clipboardData inert stops setData, which is how attribution
   * text was appended for years. It does nothing about a handler that lets the
   * real copy through untouched and then calls navigator.clipboard.writeText
   * with its own string, which lands a moment later and wins.
   *
   * The window is deliberately just the dispatch. A page's own "Copy" button
   * calls writeText too, and breaking those would be a worse bug than the one
   * this closes, so the test is whether a neutered copy is on the stack rather
   * than anything about the text. A handler that defers its write past the
   * dispatch still gets through; catching that would need a timer, and a timer
   * would catch the copy buttons.
   */
  function patchAsyncClipboard() {
    if (typeof Clipboard !== 'function') return;
    for (const name of ['writeText', 'write']) {
      const desc = Object.getOwnPropertyDescriptor(Clipboard.prototype, name);
      if (!desc || !desc.configurable || typeof desc.value !== 'function') continue;
      const original = desc.value;
      Clipboard.prototype[name] = function () {
        if (policy.enabled && policy.cleanCopy && cleanCopyDepth > 0) {
          // Resolving rather than rejecting: a page that awaits this and shows
          // the user a failure would be a worse outcome than one that believes
          // it wrote.
          return Promise.resolve();
        }
        return original.apply(this, arguments);
      };
      undo.push(() => Object.defineProperty(Clipboard.prototype, name, desc));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Patch: on* handler properties                                     */
  /* ---------------------------------------------------------------- */

  /**
   * `document.oncopy = () => false` never goes through addEventListener, so it
   * needs its own guard. Rather than swallowing the assignment we accept it and
   * register the handler through the wrapping path, which keeps the page's
   * intent intact minus the cancelling.
   *
   * The list is the wrapper's own vocabulary, not a second one kept by hand.
   * Every time this has been spelled out separately it has drifted: first it
   * covered oncopy and oncontextmenu but never the keyboard group, so
   * `document.onkeydown = ...` went on eating Ctrl+C on an always-unlocked site
   * while the addEventListener spelling of the same block was handled. Then it
   * covered the keyboard group but still not the pointer group, so
   * `field.onpaste = () => false` survived the one mode that exists to unblock
   * pasting, while `addEventListener('paste', ...)` and `onpaste="..."` were
   * both already handled.
   *
   * Excluding the pointer group was justified by those handlers being load
   * bearing on ordinary pages, and that argument does not survive contact with
   * the code: whether a handler is neutered is decided at dispatch by
   * typeIsHostile, which only says yes to this group under aggressive mode, and
   * the wrapper puts `return false` back whenever it is not neutering. So
   * wrapping an ordinary onmousedown changes nothing about it. That is exactly
   * why WRAPPABLE itself has never excluded them.
   */
  const HANDLER_EVENTS = WRAPPABLE;

  function patchHandlerProps() {
    const protos = [Document.prototype, HTMLElement.prototype];
    // Window handler properties live on Window.prototype in some engines and
    // only on the instance in others. patchHandlerProp skips whatever is not
    // there, so listing a property a prototype does not own costs nothing.
    if (typeof Window === 'function') protos.push(Window.prototype);

    for (const proto of protos) {
      for (const type of HANDLER_EVENTS) {
        patchHandlerProp(proto, 'on' + type, type);
      }
    }
  }

  /**
   * Wrapper for a handler assigned to an on* property.
   *
   * Differs from the addEventListener wrapper in one way, and it is the whole
   * reason this exists separately: an on* handler cancels by returning false,
   * and the engine processes that return value internally rather than by
   * calling anything neuter() can shadow. Registering the handler through
   * addEventListener is what defeats it, which is exactly what a hostile
   * `document.oncopy = () => false` deserves.
   *
   * It is not what a legitimate one deserves. The same route silently drops
   * every `return false` on the page, including on events this extension is
   * switched off for and inside editors it promises never to touch, so the
   * contract is put back by hand whenever the event is one we are leaving
   * alone.
   */
  const handlerWrappers = new WeakMap();

  function wrapHandler(listener) {
    const existing = handlerWrappers.get(listener);
    if (existing) return existing;

    const wrapper = function (event) {
      if (!policy.enabled || !typeIsHostile(event.type) || isExempt(event)) {
        const result = listener.call(this, event);
        if (result === false) event.preventDefault();
        return result;
      }
      const restore = neuter(event);
      try {
        return listener.call(this, event);
      } finally {
        restore();
      }
    };

    handlerWrappers.set(listener, wrapper);
    return wrapper;
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
    /**
     * Every object that has been given a handler through this property.
     *
     * Weak, because this patch covers HTMLElement.prototype and a page that
     * assigns `el.oncopy` in a list would otherwise be held alive by the fix.
     * Capped for the same reason `stripped` is: past the cap the remaining
     * targets keep their wrapper until the document goes away, which is a
     * better failure than an unbounded list.
     */
    const targets = [];
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
            const wrapped = wrapHandler(fn);
            store.set(this, { fn, wrapped });
            rawAdd.call(this, type, wrapped, false);
            // Already tracked if it had one before, so this cannot grow on a
            // page that reassigns the same handler property in a loop.
            if (!previous && targets.length < STRIPPED_CAP) targets.push(new WeakRef(this));
          }
        },
      });
      undo.push(() => {
        // The descriptor goes back first, so the assignment below lands in the
        // browser's own handler slot rather than in this patch again.
        Object.defineProperty(proto, name, desc);
        // Handing the handler back is the whole job. The page assigned it to a
        // property this patch was answering for, so the native slot was never
        // filled: without this the wrapper stays registered on the target with
        // nothing left to remove it, `document.oncopy` reads null so the page
        // cannot clear its own handler, and a later re-install registers a
        // second wrapper over the same function and fires it twice.
        for (const ref of targets) {
          const target = ref.deref();
          if (!target) continue;
          const entry = store.get(target);
          if (!entry) continue;
          store.delete(target);
          try {
            rawRemove.call(target, type, entry.wrapped, false);
          } catch {
            /* the target is gone; nothing left to unregister */
          }
          try {
            target[name] = entry.fn;
          } catch {
            /* refuses the handler back; it is at least no longer wrapped */
          }
        }
        targets.length = 0;
      });
    } catch {
      /* frozen prototype; the capture net still covers this case */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Patch: selection nuking                                           */
  /* ---------------------------------------------------------------- */

  /**
   * The node a Selection call is about, when it names one.
   *
   * `collapse(node, offset)` and `removeRange(range)` say what they are acting
   * on; the rest only act on whatever is selected right now. That difference
   * matters because a page placing a caret in its own editor calls collapse
   * while nothing is selected yet, so there is no anchor node to judge it by
   * and judging by the anchor alone would refuse it.
   */
  function subjectOf(arg) {
    if (!arg || typeof arg !== 'object') return null;
    try {
      if (arg.nodeType) return arg;
      if (arg.startContainer) return arg.startContainer;
    } catch {
      /* an exotic argument tells us nothing; fall back to the anchor */
    }
    return null;
  }

  /**
   * Defeats `setInterval(() => getSelection().removeAllRanges(), 50)`.
   *
   * removeAllRanges is the textbook watchdog and it is not the only spelling.
   * Collapsing the selection empties it just as effectively, so a patch that
   * only knew the textbook name let a page win by renaming one call.
   */
  function patchSelection() {
    if (typeof Selection !== 'function') return;
    const names = [
      'removeAllRanges',
      'empty',
      'removeRange',
      'collapse',
      'collapseToStart',
      'collapseToEnd',
    ];
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(Selection.prototype, name);
      if (!desc || !desc.configurable || typeof desc.value !== 'function') continue;
      const original = desc.value;
      Selection.prototype[name] = function () {
        // Blocked only for a selection sitting in ordinary page content, which
        // is the case people complain about. An editor clearing its own
        // selection after an operation is legitimate and has to keep working.
        if (policy.enabled && policy.selection) {
          let anchor = null;
          try {
            anchor = this.anchorNode;
          } catch {
            anchor = null;
          }
          const subject = subjectOf(arguments[0]) || anchor;
          if (!subject || !isEditor(subject)) return undefined;
        }
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
        noteShadowRoot(root);
        styleShadowRoot(root);
      } catch {
        /* never let our bookkeeping break the page's component */
      }
      return root;
    };
    undo.push(() => Object.defineProperty(Element.prototype, 'attachShadow', desc));
  }

  /* ---------------------------------------------------------------- */
  /* Patch: setAttribute                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Refuse to re-apply a hostile inline handler.
   *
   * An inline `oncopy="return false"` cannot be neutralised the way a
   * registered listener can. It cancels through its *return value*, and the
   * engine processes that internally rather than by calling the preventDefault
   * that gets shadowed, so the only counter is to remove the attribute. That
   * turns into a race the moment the page keeps putting it back from a
   * MutationObserver, and a race against a tight loop is not a fix.
   *
   * Blocking the write instead is deterministic: the page's observer fires,
   * calls setAttribute, and nothing happens.
   */
  /** Whether this element must be refused this attribute name. */
  function isHostileAttrWrite(el, name) {
    if (!policy.enabled || typeof name !== 'string') return false;
    if (attrList().indexOf(name.toLowerCase()) === -1) return false;
    return !isEditor(el);
  }

  function patchSetAttribute() {
    /**
     * setAttribute is the spelling a re-arming observer reaches for, and it is
     * not the only one that lands a working inline handler. setAttributeNS with
     * a null namespace and setAttributeNode both produce exactly the same
     * `oncopy` content attribute, so guarding setAttribute alone moves the race
     * one method along rather than ending it.
     *
     * A namespaced attribute is never an event handler content attribute, so
     * those are left alone: refusing them would block ordinary SVG and XML
     * markup for nothing.
     */
    const guards = [
      { name: 'setAttribute', nameOf: (args) => args[0] },
      // (namespace, qualifiedName, value)
      { name: 'setAttributeNS', nameOf: (args) => (args[0] ? null : args[1]) },
      { name: 'setAttributeNode', nameOf: (args) => attrName(args[0]) },
      { name: 'setAttributeNodeNS', nameOf: (args) => attrName(args[0]) },
    ];

    for (const guard of guards) {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, guard.name);
      if (!desc || !desc.configurable || typeof desc.value !== 'function') continue;
      const original = desc.value;
      Element.prototype[guard.name] = function () {
        try {
          if (isHostileAttrWrite(this, guard.nameOf(arguments))) return undefined;
        } catch {
          /* fall through and behave normally */
        }
        return original.apply(this, arguments);
      };
      undo.push(() => Object.defineProperty(Element.prototype, guard.name, desc));
    }
  }

  function attrName(node) {
    try {
      return node && !node.namespaceURI ? node.name : null;
    } catch {
      return null;
    }
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

  /**
   * Inline handlers worth removing right now, under the switches as they stand.
   *
   * Which feature owns an attribute is the same question typeIsHostile already
   * answers for the event of that name, and asking it twice is how the two
   * disagreed: this returned the whole list whenever the extension was enabled
   * at all, so a user who turned selection off still had `oncopy` and
   * `onselectstart` torn out of every page, and a switch they had moved did
   * nothing. The aggressive group stays gated on aggressive alone, because
   * stripping onmousedown or onkeydown destroys a handler rather than merely
   * declawing it, and that is only worth doing when explicitly asked for.
   */
  function attrList() {
    const out = [];
    for (const attr of HOSTILE_ATTRS) {
      if (typeIsHostile(attr.slice(2))) out.push(attr);
    }
    if (policy.aggressive) out.push(...AGGRESSIVE_ATTRS);
    return out;
  }

  function stripOne(el, attrs) {
    // An editor with an inline copy handler is rare, but stripping it would
    // break the editor for the same reason dropping its listener would. The
    // walk is cheap here because the selector already narrowed this to the
    // handful of nodes that carry one of these attributes at all.
    if (isEditor(el)) return;
    for (const attr of attrs) {
      if (!el.hasAttribute(attr)) continue;
      // Recorded before the removal rather than after: the reflection assignment
      // below can throw on some elements, and a record made after it would miss
      // an attribute that really was removed. Restoring checks the attribute is
      // still absent, so a record for a removal that did not happen is inert.
      noteStripped(el, attr, el.getAttribute(attr));
      try {
        el.removeAttribute(attr);
        el[attr] = null;
      } catch {
        /* readonly reflection on some elements; the attribute is gone regardless */
      }
    }
  }

  function stripAttrs(root) {
    if (!policy.enabled || !root) return;
    const attrs = attrList();
    // Every switch that owns an attribute is off, so there is nothing to strip.
    // Worth returning early rather than falling through: an empty list builds an
    // empty selector, and querySelectorAll('') throws.
    if (!attrs.length) return;
    const selector = attrs.map((a) => `[${a}]`).join(',');

    // querySelectorAll never returns the node it was called on, and a node the
    // observer hands us is exactly the one most likely to be carrying the
    // attribute, so the root is matched separately.
    if (root.nodeType === 1 && root.matches) {
      try {
        if (root.matches(selector)) stripOne(root, attrs);
      } catch {
        /* a custom element with a hostile matches(); descendants still run */
      }
    }

    if (!root.querySelectorAll) return;
    let nodes;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      return;
    }
    for (const el of nodes) stripOne(el, attrs);
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
    if (!root) return;
    try {
      const existing = root.querySelector('style[data-unlock-copy]');
      // Turning selection back off has to take these out again. The light DOM
      // sheet is the background's to remove and it does; leaving the shadow
      // copies behind left the switch half applied, so the page relocked
      // everywhere except inside its own components.
      if (!policy.enabled || !policy.selection) {
        if (existing) existing.remove();
        return;
      }
      if (existing) return;
      const style = document.createElement('style');
      style.setAttribute('data-unlock-copy', '');
      style.textContent = SHADOW_CSS;
      root.appendChild(style);
    } catch {
      /* a root that refuses children is not worth failing the whole pass over */
    }
  }

  /**
   * Register a root, and say whether it was new.
   *
   * Callers use the answer to skip re-walking a subtree that was already
   * covered, which is what keeps repeat passes proportional to what changed.
   */
  function noteShadowRoot(root) {
    if (!root || shadowRoots.has(root)) return false;
    shadowRoots.add(root);
    freshRoots.push(root);
    return true;
  }

  /**
   * Forget roots whose host has left the document.
   *
   * Without this the Set is a leak with a second symptom: a single page
   * application that mounts and unmounts components adds a root per mount and
   * never drops one, so both memory and the cost of every later pass climb for
   * as long as the tab is open.
   */
  function pruneShadowRoots() {
    for (const root of shadowRoots) {
      let alive = false;
      try {
        alive = !!(root.host && root.host.isConnected);
      } catch {
        alive = false;
      }
      if (!alive) shadowRoots.delete(root);
    }
  }

  function collectOpenShadowRoots(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.shadowRoot && noteShadowRoot(root.shadowRoot)) {
      collectOpenShadowRoots(root.shadowRoot);
    }
    if (!root.querySelectorAll) return;
    let nodes;
    try {
      nodes = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of nodes) {
      if (el.shadowRoot && noteShadowRoot(el.shadowRoot)) {
        collectOpenShadowRoots(el.shadowRoot);
      }
    }
  }

  /** Full pass. Worth its cost at install and on re-injection, not per frame. */
  function sweep() {
    stripAttrs(document);
    collectOpenShadowRoots(document);
    pruneShadowRoots();
    freshRoots.length = 0;
    for (const root of shadowRoots) {
      styleShadowRoot(root);
      stripAttrs(root);
    }
  }

  /**
   * Scoped pass over what the observer actually reported.
   *
   * The full pass walks every element in the document and every shadow root
   * under it. Running that from the observer meant walking the whole page on
   * any frame in which anything changed, which on a large single page
   * application is most frames, and it made this extension a measurable source
   * of jank on exactly the sites people install it for. Mutation records
   * already name the nodes that changed, so only those need looking at.
   */
  function sweepNodes(nodes) {
    for (const node of nodes) {
      stripAttrs(node);
      collectOpenShadowRoots(node);
    }
    pruneShadowRoots();
    if (!freshRoots.length) return;
    const roots = freshRoots.splice(0, freshRoots.length);
    for (const root of roots) {
      if (!shadowRoots.has(root)) continue;
      styleShadowRoot(root);
      stripAttrs(root);
    }
  }

  function startObserver() {
    if (observer || typeof MutationObserver !== 'function') return;
    let queued = false;
    /**
     * Nodes reported since the last pass, and a flag for giving up on tracking
     * them individually.
     *
     * The cap is not tidiness. A background tab does not run
     * requestAnimationFrame at all, so an uncapped list would hold a strong
     * reference to every node a busy page created for as long as the user left
     * the tab alone. Past the cap the list is dropped and the next pass is a
     * full one, which costs more for one frame and holds nothing.
     */
    const CAP = 2000;
    let pending = [];
    let full = false;

    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (full) break;
        if (record.type === 'attributes') {
          pending.push(record.target);
        } else {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) pending.push(node);
          }
        }
        if (pending.length > CAP) {
          full = true;
          pending = [];
        }
      }
      if (queued || (!pending.length && !full)) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const nodes = pending;
        const wasFull = full;
        pending = [];
        full = false;
        try {
          if (wasFull) sweep();
          else sweepNodes(nodes);
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
    // Recorded before the write, so relocking can put the page's own value back.
    noteShielded(el);
    el.style.setProperty('pointer-events', 'none', 'important');
  }

  function installShields() {
    rawAdd.call(window, 'mousedown', shieldHandler, true);
    undo.push(() => {
      rawRemove.call(window, 'mousedown', shieldHandler, true);
      restoreShielded();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Install or remove the capture net to match the current mode.
   *
   * Separate from install() because the mode can still change afterwards: the
   * popup pushes a fresh policy into an already running engine when a switch is
   * flipped, and that payload carries the mode with it.
   */
  function syncNet() {
    if (policy.mode === 'late') installNet();
  }

  function install() {
    patchEventTarget();
    // Before the handler props: both rely on the wrapping path, and this is
    // what stops a wrapped listener reaching around the shadows to the real
    // preventDefault underneath.
    patchEventProto();
    patchAsyncClipboard();
    patchHandlerProps();
    patchSelection();
    // Harmless in late mode and useful in both: single page apps keep building
    // shadow roots long after load, and this is the only moment a closed one is
    // ever reachable.
    patchAttachShadow();
    patchSetAttribute();

    // Shields must be registered before the net. Both listen on window capture,
    // ties there are broken by registration order, and under aggressive mode the
    // net stops mousedown outright, so registering it first would make the
    // overlay handler dead code in exactly the configuration that needs it.
    installShields();
    // Late mode cannot un-register what already exists, so it needs the net.
    syncNet();

    installed = true;

    const start = () => {
      // Relocking before the document element exists is rare and reachable: the
      // shortcut works from the moment the tab starts loading. Without this the
      // pending listener still fired, swept a page the user had just relocked,
      // and started a MutationObserver that nothing was left to disconnect.
      if (torn) return;
      sweep();
      startObserver();
    };
    if (document.documentElement) start();
    else {
      rawAdd.call(document, 'DOMContentLoaded', start, { once: true });
      undo.push(() => rawRemove.call(document, 'DOMContentLoaded', start, { once: true }));
    }
  }

  function refresh() {
    try {
      sweep();
    } catch {
      /* best effort; the patches are what matter */
    }
  }

  function configure(next) {
    // A torn down engine has no patches left to configure, and letting one be
    // talked back into life is worse than ignoring the message: it would flip
    // policy.enabled on a page whose handle is already gone.
    if (torn || !next || typeof next !== 'object') return;
    for (const key of Object.keys(policy)) {
      if (key in next) policy[key] = next[key];
    }
    // Learning the mode after install() has run is normal on the late path,
    // where the boot payload arrives first but the popup can also push an
    // update later.
    if (installed) syncNet();
    if (policy.enabled) refresh();
  }

  function disable() {
    torn = true;
    policy.enabled = false;
    while (undo.length) {
      const step = undo.pop();
      try {
        step();
      } catch {
        /* keep unwinding: a stuck step must not strand the rest patched */
      }
    }
    restoreStripped();
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
  const onPolicy = (e) => {
    try {
      configure(e.detail);
    } catch {
      /* malformed payload; keep running on the previous policy */
    }
  };
  rawAdd.call(document, CHANNEL_POLICY, onPolicy);
  // Registered through the undo stack like every other patch here. Left outside
  // it, this listener outlived disable(): the next policy push found a torn
  // down engine, switched it back on, reinstalled the capture net and swept a
  // page the user had just relocked, with the handle already deleted so nothing
  // could turn it off a second time.
  undo.push(() => rawRemove.call(document, CHANNEL_POLICY, onPolicy));

  install();

  try {
    document.dispatchEvent(new CustomEvent(CHANNEL_READY));
  } catch {
    /* the bridge broadcasts unprompted as well, so this is only an optimisation */
  }
})();
