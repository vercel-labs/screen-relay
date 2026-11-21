import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

function viewer({ devicePixelRatio = 1, storage, decode = true, deferDecode = false, fetch = async () => ({ ok: false, status: 401 }), navigator, hash = '' } = {}) {
  const listeners = {}, windowListeners = {}, elements = {}, sockets = [], trace = [], animationFrames = new Map(), timers = [];
  const decodeQueue = [];
  let now = 0, nextAnimationFrame = 1;
  const element = () => {
    const children = {};
    return {
      style: { setProperty(name, value) { this[name] = value; } }, classList: { toggle() {} }, hidden: false, width: 1280, height: 720,
      value: '', attributes: {}, handlers: {}, text: '', textWrites: 0,
      get textContent() { return this.text; },
      set textContent(value) { this.text = value; this.textWrites++; },
      getContext: () => ({ drawImage(frame) { trace.push(['draw', frame.timestamp]); } }),
      addEventListener(name, callback) {
        const previous = this.handlers[name];
        this.handlers[name] = previous ? (event) => { previous(event); callback(event); } : callback;
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      focus() {
        const previous = document.activeElement;
        if (previous === this) return;
        document.activeElement = document.body;
        previous?.handlers.blur?.({ relatedTarget: this });
        document.activeElement = this;
      },
      setPointerCapture() {},
      querySelector: (selector) => children[selector] ||= element(),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }),
    };
  };
  class Socket {
    static OPEN = 1;
    static CLOSING = 2;
    constructor(url, protocols) { this.url = String(url); this.protocols = [...protocols]; this.readyState = Socket.OPEN; this.events = []; this.inputs = []; this.waits = []; sockets.push(this); }
    send(data) {
      const offset = data instanceof ArrayBuffer ? 0 : data.byteOffset;
      const length = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
      const view = new DataView(data instanceof ArrayBuffer ? data : data.buffer, offset, length), type = view.getUint8(5);
      if (type === 2 && this.failAck === view.getUint32(12)) throw new Error('send failed');
      this.events.push([type, view.getUint32(12)]);
      if (type === 2) { trace.push(['ack', view.getUint32(12)]); this.waits.push(length > 20 ? view.getUint32(20) : 0); }
      if (type === 3) {
        const event = view.getUint8(20);
        this.inputs.push(event === 6 ? { event, axis: view.getUint16(22), delta: view.getInt32(24) } : { event, code: view.getUint16(22), modifiers: view.getUint16(34) });
      }
    }
    close() { this.events.push('close'); this.readyState = Socket.CLOSING; }
  }
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'configured'; }
    configure() {}
    decode(chunk) {
      if (!decode) return;
      const output = () => this.callbacks.output({ timestamp: chunk.timestamp, close() { trace.push(['close', chunk.timestamp]); } });
      if (deferDecode) decodeQueue.push(output);
      else output();
    }
    close() { this.state = 'closed'; }
  }
  const document = {
    hidden: false, body: element(), documentElement: element(), focused: true,
    hasFocus() { return this.focused; },
    querySelector: (selector) => elements[selector] ||= element(),
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  document.activeElement = document.body;
  const context = createContext({
    document, window: { devicePixelRatio, VideoDecoder: Decoder, EncodedVideoChunk: true, addEventListener: (name, callback) => { windowListeners[name] = callback; } },
    location: { protocol: 'http:', hostname: 'localhost', host: 'localhost', hash, pathname: '/', search: '' },
    history: { replaceState() {} },
    URL, URLSearchParams, AbortSignal, WebSocket: Socket, VideoDecoder: Decoder,
    EncodedVideoChunk: class { constructor(options) { Object.assign(this, options); } },
    MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} },
    performance: { now: () => now }, setInterval: () => 1, clearInterval() {},
    setTimeout: (callback) => timers.push(callback) - 1,
    clearTimeout(id) { delete timers[id]; }, navigator,
    requestAnimationFrame(callback) { const id = nextAnimationFrame++; animationFrames.set(id, callback); return id; },
    cancelAnimationFrame(id) { animationFrames.delete(id); },
    fetch, localStorage: storage,
  });
  runInContext(readFileSync('dist/viewer/viewer.js', 'utf8'), context);
  const frame = (seq, width = 1280, height = 720, payloadLength = 8, stamp = seq, generation = 1) => runInContext(`(() => {
    const data = new ArrayBuffer(${32 + payloadLength}), view = new DataView(data);
    view.setUint32(0, 0x4e534c31); view.setUint8(4, 1); view.setUint8(5, 1);
    view.setUint16(6, ${seq === 1 ? 1 : 0}); view.setUint32(8, ${generation}); view.setUint32(12, ${seq});
    view.setUint32(16, ${12 + payloadLength}); view.setUint16(20, ${width}); view.setUint16(22, ${height});
    view.setBigUint64(24, ${stamp}n); new Uint8Array(data, 32).set([0, 0, 1, 103, 66, 0, 30, 0]);
    relayViewer.socket.onmessage({ data });
  })()`, context);
  const tick = (time) => {
    now = time;
    assert.equal(animationFrames.size, 1);
    const [id, callback] = animationFrames.entries().next().value;
    animationFrames.delete(id);
    callback(now);
  };
  const refresh = (time) => {
    now = time;
    const entry = animationFrames.entries().next().value;
    if (!entry) return;
    animationFrames.delete(entry[0]);
    entry[1](now);
  };
  const runTimer = (index) => {
    const callback = timers[index];
    delete timers[index];
    callback?.();
  };
  const timersAfter = (mark) => { const end = timers.length; for (let index = mark; index < end; index++) runTimer(index); };
  return { context, document, listeners, windowListeners, sockets, trace, frame, tick, refresh, timerCount: () => timers.length, timersAfter, runTimer, setTime: (time) => { now = time; }, decodeAll: () => { while (decodeQueue.length) decodeQueue.shift()(); } };
}

const traced = (app, type) => app.trace.filter((event) => event[0] === type).map((event) => event[1]);

test('a deferred decoder accepts and presents a burst larger than eight frames', () => {
  const app = viewer({ deferDecode: true });
  for (let sequence = 1; sequence <= 9; sequence++) app.frame(sequence);
  assert.equal(app.context.window.nativeStats.decodeerrors, 0);
  assert.equal(app.context.window.nativeStats.outstanding, 9);
  assert.equal(app.context.window.nativeStats.pendingHighWater, 9);
  app.decodeAll();
  for (let sequence = 2; sequence <= 9; sequence++) app.tick(sequence * 16);
  assert.equal(app.context.window.nativeStats.outstanding, 0);
  assert.equal(app.context.window.nativeStats.decodeerrors, 0);
  assert.deepEqual(traced(app, 'ack'), Array.from({ length: 9 }, (_, index) => index + 1));
});

test('the deferred decoder count guard matches the sender maximum', () => {
  const app = viewer({ deferDecode: true });
  for (let sequence = 1; sequence <= 360; sequence++) app.frame(sequence);
  assert.equal(app.context.window.nativeStats.outstanding, 360);
  assert.equal(app.context.window.nativeStats.decodeerrors, 0);
  app.frame(361);
  assert.equal(app.context.window.nativeStats.decodeerrors, 1);
  assert.equal(app.context.window.nativeStats.outstanding, 0);
  assert.equal(app.context.window.nativeStats.pendingBytes, 0);
  assert.equal(app.sockets[0].events.at(-1), 'close');
});

test('the pending byte guard still rejects an oversized deferred backlog', () => {
  const app = viewer({ deferDecode: true });
  app.frame(1, 1280, 720, 8388608);
  assert.equal(app.context.window.nativeStats.pendingBytes, 8388608);
  app.frame(2);
  assert.equal(app.context.window.nativeStats.decodeerrors, 1);
});

test('the sequence guard still rejects a gap', () => {
  const app = viewer({ deferDecode: true });
  app.frame(1);
  app.frame(3);
  assert.equal(app.context.window.nativeStats.decodeerrors, 1);
});

test('a burst of six frames draws in order across six animation frames', () => {
  const app = viewer();
  app.frame(1);
  for (let sequence = 2; sequence <= 7; sequence++) app.frame(sequence);
  assert.deepEqual(app.trace, [['draw', 1], ['close', 1], ['ack', 1]]);
  for (let sequence = 2; sequence <= 7; sequence++) {
    app.tick((sequence - 1) * 16);
    assert.deepEqual(app.trace.slice(-3), [['draw', sequence], ['close', sequence], ['ack', sequence]]);
  }
  assert.equal(app.context.window.nativeStats.superseded, 0);
  app.tick(112);
  app.frame(8);
  assert.deepEqual(app.trace.slice(-3), [['draw', 8], ['close', 8], ['ack', 8]]);
  app.frame(9);
  assert.deepEqual(traced(app, 'draw'), [1, 2, 3, 4, 5, 6, 7, 8]);
  app.tick(128);
  assert.deepEqual(app.trace.slice(-3), [['draw', 9], ['close', 9], ['ack', 9]]);
});

test('sustained backlog skips at most once every 250 ms after 500 ms', () => {
  const app = viewer();
  let sequence = 1;
  for (; sequence <= 8; sequence++) app.frame(sequence);
  const step = (time) => { app.tick(time); app.frame(sequence++); };
  for (let time = 20; time <= 480; time += 20) step(time);
  step(499);
  assert.equal(app.context.window.nativeStats.superseded, 0);
  step(500);
  assert.equal(app.context.window.nativeStats.superseded, 1);
  for (let time = 520; time <= 740; time += 20) step(time);
  step(749);
  assert.equal(app.context.window.nativeStats.superseded, 1);
  step(750);
  assert.equal(app.context.window.nativeStats.superseded, 2);
  const drawn = traced(app, 'draw'), closed = traced(app, 'close'), acked = traced(app, 'ack');
  assert.equal(closed.filter((frame) => !drawn.includes(frame)).length, 2);
  assert.deepEqual(acked, Array.from({ length: acked.length }, (_, index) => index + 1));
  assert.deepEqual(closed, acked);
});

test('the catch-up timer restarts when the queue falls to two frames', () => {
  const app = viewer();
  let sequence = 1;
  for (; sequence <= 6; sequence++) app.frame(sequence);
  const step = (time) => { app.tick(time); app.frame(sequence++); };
  for (let time = 20; time <= 480; time += 20) step(time);
  app.tick(490); app.tick(491); app.tick(492);
  app.frame(sequence++); app.frame(sequence++); app.frame(sequence++);
  for (let time = 500; time <= 980; time += 20) step(time);
  step(991);
  assert.equal(app.context.window.nativeStats.superseded, 0);
  step(992);
  assert.equal(app.context.window.nativeStats.superseded, 1);
});

test('more than 12 queued frames skips down to two and ACKs in order', () => {
  const app = viewer();
  for (let sequence = 1; sequence <= 13; sequence++) app.frame(sequence);
  assert.equal(app.context.window.nativeStats.superseded, 0);
  app.frame(14);
  assert.equal(app.context.window.nativeStats.superseded, 11);
  assert.deepEqual(traced(app, 'draw'), [1]);
  assert.deepEqual(traced(app, 'close'), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.deepEqual(traced(app, 'ack'), traced(app, 'close'));
  app.tick(16); app.tick(32);
  assert.deepEqual(traced(app, 'draw'), [1, 13, 14]);
  assert.deepEqual(traced(app, 'ack'), Array.from({ length: 14 }, (_, index) => index + 1));
});

test('a frame older than 200 ms skips the backlog down to two', () => {
  const app = viewer();
  for (let sequence = 1; sequence <= 6; sequence++) app.frame(sequence);
  app.setTime(200); app.frame(7);
  assert.equal(app.context.window.nativeStats.superseded, 0);
  app.tick(201);
  assert.equal(app.context.window.nativeStats.superseded, 4);
  assert.deepEqual(traced(app, 'draw'), [1, 6]);
  assert.deepEqual(traced(app, 'close'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(traced(app, 'ack'), [1, 2, 3, 4, 5, 6]);
  app.tick(217);
  assert.deepEqual(traced(app, 'draw'), [1, 6, 7]);
  assert.deepEqual(traced(app, 'ack'), [1, 2, 3, 4, 5, 6, 7]);
});

test('an arriving frame also triggers the age bound without an animation frame', () => {
  const app = viewer();
  for (let sequence = 1; sequence <= 4; sequence++) app.frame(sequence);
  app.setTime(201); app.frame(5);
  assert.equal(app.context.window.nativeStats.superseded, 2);
  assert.deepEqual(traced(app, 'draw'), [1]);
  assert.deepEqual(traced(app, 'close'), [1, 2, 3]);
  assert.deepEqual(traced(app, 'ack'), [1, 2, 3]);
  app.tick(202); app.tick(218);
  assert.deepEqual(traced(app, 'draw'), [1, 4, 5]);
  assert.deepEqual(traced(app, 'ack'), [1, 2, 3, 4, 5]);
});

test('a failed skipped-frame ACK closes the remaining queue and connection', () => {
  const app = viewer();
  for (let sequence = 1; sequence <= 13; sequence++) app.frame(sequence);
  app.sockets[0].failAck = 2;
  app.frame(14);
  assert.equal(app.context.window.nativeStats.decodeerrors, 1);
  assert.deepEqual(traced(app, 'ack'), [1]);
  assert.deepEqual(traced(app, 'close'), Array.from({ length: 14 }, (_, index) => index + 1));
  assert.equal(app.sockets[0].events.at(-1), 'close');
});

test('drawing updates status only when its text changes', () => {
  const app = viewer();
  const status = app.document.querySelector('#status');
  app.frame(1);
  const liveWrites = status.textWrites;
  app.frame(2); app.tick(16);
  assert.equal(status.textWrites, liveWrites);
  app.sockets[0].onerror();
  assert.equal(status.textContent, 'Connection error');
  app.frame(3); app.tick(32);
  assert.equal(status.textContent, 'Live · you have control');
  assert.equal(status.textWrites, liveWrites + 2);
});

test('the first viewer claims idle input; a refused viewer watches and can choose Take control', () => {
  const first = viewer();
  assert.equal(first.sockets[0].url, 'ws://localhost/stream?clipboard=1');
  first.sockets[0].onopen();
  first.frame(1);
  assert.equal(first.document.querySelector('#status').textContent, 'Live · you have control');

  const app = viewer();
  const control = () => app.document.querySelector('#toolbar-actions').querySelector('[data-action="control"]');
  app.sockets[0].onclose({ code: 1006 });
  runInContext('relayViewer.connect()', app.context);
  app.frame(1);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?view=1');
  assert.equal(control().attributes['aria-pressed'], 'false');
  assert.equal(control().attributes['title'], 'Take control');
  key(app, 'keydown', 'KeyA');
  assert.deepEqual(app.sockets.at(-1).inputs, []);
  runInContext('relayViewer.setViewOnly(false)', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?take=1&clipboard=1');
  app.frame(1);
  assert.equal(app.document.querySelector('#status').textContent, 'Live · you have control');
  assert.equal(control().attributes['aria-pressed'], 'true');
  assert.equal(control().attributes['title'], 'Release control');
  key(app, 'keydown', 'KeyA');
  assert.deepEqual(app.sockets.at(-1).inputs.map(({ event, code }) => [event, code]), [[1, 4]]);
  runInContext('relayViewer.setViewOnly(true)', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?view=1');
  const released = app.sockets.at(-2).inputs.map(({ event, code }) => [event, code]);
  assert.deepEqual(released[0], [1, 4]);
  assert.ok(released.slice(1).every(([event]) => event === 7), `release did not follow the held key: ${JSON.stringify(released)}`);
  key(app, 'keydown', 'KeyB');
  assert.deepEqual(app.sockets.at(-1).inputs, []);
});

test('voluntary reconnect and hiding ACK queued frames on the old socket', () => {
  const app = viewer();
  app.frame(1); app.frame(2); app.frame(3);
  runInContext('relayViewer.connect()', app.context);
  assert.deepEqual(app.sockets[0].events.filter((event) => event === 'close' || event[0] === 2),
    [[2, 1], [2, 2], [2, 3], 'close']);
  assert.deepEqual(app.sockets[1].events, []);
  app.frame(1); app.frame(2);
  app.document.hidden = true; app.listeners.visibilitychange();
  assert.deepEqual(app.sockets[1].events.filter((event) => event === 'close' || event[0] === 2),
    [[2, 1], [2, 2], 'close']);
});

test('broken sockets do not receive or replay queued ACKs', () => {
  const app = viewer();
  app.frame(1); app.frame(2);
  app.sockets[0].onerror();
  runInContext('relayViewer.connect()', app.context);
  assert.deepEqual(app.sockets[0].events.filter((event) => event === 'close' || event[0] === 2),
    [[2, 1], 'close']);
  assert.deepEqual(app.sockets[1].events, []);
});

test('frames larger than 1920x1080 are drawn and size the canvas', () => {
  const app = viewer();
  app.frame(1, 3840, 2160);
  const canvas = app.document.querySelector('#screen');
  assert.deepEqual([app.context.window.nativeStats.drawn, canvas.width, canvas.height], [1, 3840, 2160]);
});

test('actual size is one stream pixel per device pixel and follows density changes', () => {
  const app = viewer({ devicePixelRatio: 2 });
  const canvas = app.document.querySelector('#screen');
  runInContext('relayViewer.setScale("actual")', app.context);
  assert.deepEqual([canvas.style.width, canvas.style.height], ['640px', '360px']);
  app.context.window.devicePixelRatio = 1;
  runInContext('relayViewer.watchDpr()', app.context);
  assert.deepEqual([canvas.style.width, canvas.style.height], ['1280px', '720px']);
});

test('scale mode and sharp pixels survive a reload; blocked storage still works', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const first = viewer({ devicePixelRatio: 2, storage });
  runInContext('relayViewer.setScale("actual"); relayViewer.toggleSharp()', first.context);
  const reloaded = viewer({ devicePixelRatio: 2, storage });
  const canvas = reloaded.document.querySelector('#screen');
  assert.deepEqual([canvas.style.width, canvas.style.height, canvas.style.imageRendering], ['640px', '360px', 'pixelated']);
  assert.equal(reloaded.document.querySelector('[data-scale="actual"]').attributes['aria-pressed'], 'true');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const fallback = viewer({ devicePixelRatio: 2, storage: blocked });
  runInContext('relayViewer.setScale("actual")', fallback.context);
  assert.equal(fallback.document.querySelector('#screen').style.width, '640px');
});

function key(app, type, code, capsLock = false) {
  app.document.querySelector('#screen').handlers[type]({
    code, repeat: false, preventDefault() {},
    getModifierState: (name) => name === 'CapsLock' ? capsLock : false,
  });
}

const inputBytes = (app) => app.sockets.at(-1).inputs.map(({ event, code }) => [event, code]);
const wheelSteps = (app) => app.sockets.at(-1).inputs.filter(({ event }) => event === 6).map(({ axis, delta }) => [axis, delta]);
function takeControl(app) {
  runInContext('relayViewer.setViewOnly(false)', app.context);
  app.frame(1);
}

function wheel(app, event) {
  app.document.querySelector('#screen').handlers.wheel({ deltaX: 0, clientX: 640, clientY: 360, deltaMode: 0, preventDefault() {}, ...event });
}

test('a mouse notch is one notch even when the platform reports it as a few pixels', () => {
  const app = viewer();
  takeControl(app);
  wheel(app, { deltaY: 4, wheelDeltaY: -120 });
  assert.deepEqual(wheelSteps(app), [[0, 120]]);
  wheel(app, { deltaY: -4, wheelDeltaY: 120 });
  assert.deepEqual(wheelSteps(app), [[0, 120], [0, -120]]);
});

test('pixel deltas that carry no notch still gather into whole notches', () => {
  const app = viewer();
  takeControl(app);
  wheel(app, { deltaY: 50 });
  assert.deepEqual(wheelSteps(app), []);
  wheel(app, { deltaY: 50 });
  assert.deepEqual(wheelSteps(app), [[0, 120]]);
});

test('line and page deltas from Firefox become notches', () => {
  const app = viewer();
  takeControl(app);
  wheel(app, { deltaY: 3, deltaMode: 1 });
  assert.deepEqual(wheelSteps(app), [[0, 120]]);
  wheel(app, { deltaY: 2, deltaMode: 2 });
  assert.deepEqual(wheelSteps(app), [[0, 120], [0, 240]]);
});

test('a latched modifier stays down through a matching shortcut', () => {
  const app = viewer();
  takeControl(app);
  const panel = app.document.querySelector('#keys-panel');
  const hold = { dataset: { hold: 'AltLeft' }, setAttribute(name, value) { this[name] = value; } };
  panel.handlers.click({ target: { closest: (selector) => selector === '[data-hold]' ? hold : null } });
  const shortcut = { dataset: { keys: 'AltLeft+Tab' } };
  panel.handlers.click({ target: { closest: (selector) => selector === '[data-keys]' ? shortcut : null } });
  assert.deepEqual(inputBytes(app), [[1, 226], [1, 43], [2, 43], [2, 226]]);
  assert.equal(app.sockets.at(-1).inputs[1].modifiers, 4);
  assert.equal(hold['aria-pressed'], 'false');
});

test('toolbar keys bypass the physical keyboard mapping', () => {
  const app = viewer();
  takeControl(app);
  runInContext('relayViewer.toggleMeta()', app.context);
  const panel = app.document.querySelector('#keys-panel');
  const press = (kind, name) => {
    const button = { dataset: { [kind]: name }, setAttribute() {} };
    panel.handlers.click({ target: { closest: (selector) => selector === `[data-${kind}]` ? button : null } });
  };
  press('hold', 'ControlLeft');
  press('hold', 'ControlLeft');
  press('hold', 'AltLeft');
  press('hold', 'AltLeft');
  press('hold', 'MetaLeft');
  press('keys', 'MetaLeft');
  press('hold', 'MetaLeft');
  press('keys', 'ControlLeft+KeyC');
  press('keys', 'ControlLeft+AltLeft+Delete');
  press('keys', 'MetaLeft+KeyD');
  key(app, 'keydown', 'MetaLeft');
  key(app, 'keyup', 'MetaLeft');
  assert.deepEqual(inputBytes(app), [
    [7, 0], [1, 224], [2, 224], [1, 226], [2, 226], [1, 227], [2, 227],
    [1, 224], [1, 6], [2, 6], [2, 224],
    [1, 224], [1, 226], [1, 76], [2, 76], [2, 226], [2, 224],
    [1, 227], [1, 7], [2, 7], [2, 227], [1, 224], [2, 224],
  ]);
});

test('macOS Caps Lock keydown and keyup each toggle the remote once', () => {
  const app = viewer();
  takeControl(app);
  key(app, 'keydown', 'CapsLock', true);
  key(app, 'keyup', 'CapsLock', false);
  key(app, 'keydown', 'CapsLock', true);
  key(app, 'keyup', 'CapsLock', false);
  assert.deepEqual(inputBytes(app), [[1, 57], [2, 57], [1, 57], [2, 57], [1, 57], [2, 57], [1, 57], [2, 57]]);
});

test('Windows Caps Lock keydown and keyup per press produce one tap', () => {
  const app = viewer();
  takeControl(app);
  key(app, 'keydown', 'CapsLock', true);
  key(app, 'keyup', 'CapsLock', true);
  key(app, 'keydown', 'CapsLock', false);
  key(app, 'keyup', 'CapsLock', false);
  assert.deepEqual(inputBytes(app), [[1, 57], [2, 57], [1, 57], [2, 57]]);
});

test('a letter typed with Caps Lock already on sends the tap before the letter', () => {
  const app = viewer();
  takeControl(app);
  key(app, 'keydown', 'KeyA', true);
  assert.deepEqual(inputBytes(app), [[1, 57], [2, 57], [1, 4]]);
});

test('a held modifier toggle wraps exactly the next key and then releases', () => {
  const app = viewer();
  takeControl(app);
  const panel = app.document.querySelector('#keys-panel');
  const button = { dataset: { hold: 'MetaLeft' }, setAttribute(name, value) { this[name] = value; } };
  const toggle = () => panel.handlers.click({ target: { closest: (selector) => selector === '[data-hold]' ? button : null } });
  toggle();
  assert.equal(button['aria-pressed'], 'true');
  key(app, 'keydown', 'KeyL');
  key(app, 'keyup', 'KeyL');
  assert.deepEqual(inputBytes(app), [[1, 227], [1, 15], [2, 227], [2, 15]]);
  assert.equal(button['aria-pressed'], 'false');
  key(app, 'keydown', 'KeyM');
  key(app, 'keyup', 'KeyM');
  assert.deepEqual(inputBytes(app).slice(4), [[1, 16], [2, 16]]);
  toggle();
  assert.equal(button['aria-pressed'], 'true');
  toggle();
  assert.equal(button['aria-pressed'], 'false');
  assert.deepEqual(inputBytes(app).slice(6), [[1, 227], [2, 227]]);
});

test('Caps Lock tracking resets with the generation', () => {
  const app = viewer();
  takeControl(app);
  key(app, 'keydown', 'CapsLock', true);
  runInContext('relayViewer.reset()', app.context);
  app.frame(1);
  key(app, 'keydown', 'KeyA', true);
  assert.deepEqual(inputBytes(app), [[1, 57], [2, 57], [7, 0], [1, 57], [2, 57], [1, 4]]);
});

test('a Caps Lock tap dropped while not ready is retried by the next key', () => {
  const app = viewer();
  runInContext('relayViewer.setViewOnly(false)', app.context);
  key(app, 'keydown', 'KeyA', true);
  assert.deepEqual(inputBytes(app), []);
  assert.equal(runInContext('relayViewer.capsLock', app.context), false);
  app.frame(1);
  key(app, 'keydown', 'KeyB', true);
  assert.deepEqual(inputBytes(app), [[1, 57], [2, 57], [1, 5]]);
  assert.equal(runInContext('relayViewer.capsLock', app.context), true);
});

test('keys-panel buttons keep the canvas focus so hold latches survive clicks', () => {
  const app = viewer();
  takeControl(app);
  const panel = app.document.querySelector('#keys-panel');
  const canvas = app.document.querySelector('#screen');
  const blocked = (type, button) => {
    let prevented = false;
    panel.handlers[type]({ target: button, preventDefault() { prevented = true; } });
    if (!prevented) canvas.handlers.blur();
    assert.equal(prevented, true, `${type} on a keys-panel button did not keep the canvas focus`);
  };
  const press = (kind, name) => {
    const button = {
      dataset: { [kind]: name }, setAttribute(name, value) { this[name] = value; },
      closest: (selector) => selector === `[data-${kind}]` ? button : null,
    };
    blocked('pointerdown', button);
    blocked('mousedown', button);
    panel.handlers.click({ target: button });
    return button;
  };
  press('hold', 'ControlLeft');
  press('hold', 'ShiftLeft');
  assert.deepEqual(inputBytes(app), [[1, 224], [1, 225]]);
  key(app, 'keydown', 'KeyA');
  assert.deepEqual(inputBytes(app), [[1, 224], [1, 225], [1, 4], [2, 224], [2, 225]]);
  assert.equal(app.sockets.at(-1).inputs[2].modifiers, 3);
  press('hold', 'ControlLeft');
  press('hold', 'ControlLeft');
  assert.deepEqual(inputBytes(app).slice(5), [[1, 224], [2, 224]]);
  press('hold', 'ControlLeft');
  press('keys', 'Escape');
  assert.deepEqual(inputBytes(app).slice(7), [[1, 224], [1, 41], [2, 41], [2, 224]]);
});

test('pending decoder frames allow 360 entries before reconnecting', () => {
  const app = viewer({ decode: false });
  for (let seq = 1; seq <= 360; seq++) app.frame(seq);
  assert.equal(app.context.window.nativeStats.outstanding, 360);
  assert.equal(app.context.window.nativeStats.decodeerrors, 0);
  app.frame(361);
  assert.equal(app.context.window.nativeStats.decodeerrors, 1);
  assert.equal(app.document.querySelector('#status').textContent, 'Unexpected frame sequence or queue limit');
  assert.equal(app.sockets[0].events.at(-1), 'close');
});

test('an ACK reports how long the frame sat in the viewer, in microseconds', () => {
  const app = viewer({ deferDecode: true });
  app.frame(1);
  app.setTime(40);
  app.decodeAll();
  assert.deepEqual(app.trace.filter((event) => event[0] === 'ack'), [['ack', 1]]);
  assert.deepEqual(app.sockets[0].waits, [40000]);
});

function playout({ seconds, stall = () => 0, idleAt = -1, idleJump = 0, rate = 60 }) {
  const app = viewer(), interval = 1000 / rate, base = 50, drawnAt = [], arrivals = [];
  let sequence = 0, lastDrawn = 0;
  for (let capture = 0; capture < seconds * 1000; capture += interval) {
    const jump = capture >= idleAt && idleAt >= 0 ? idleJump : 0;
    arrivals.push({ at: capture + base + stall(capture), stamp: Math.round((capture + jump) * 1000) + 1 });
  }
  let next = 0, lastArrival = 0;
  for (let time = 0, refreshAt = 0; time < seconds * 1000 + 500; time++) {
    while (next < arrivals.length && arrivals[next].at <= time) {
      app.setTime(Math.max(time, lastArrival));
      app.frame(++sequence, 1280, 720, 8, arrivals[next].stamp);
      lastArrival = time;
      next++;
    }
    if (time >= refreshAt) { app.refresh(time); refreshAt += 1000 / 60; }
    const drawn = traced(app, 'draw').length;
    if (drawn !== lastDrawn) { drawnAt.push(time); lastDrawn = drawn; }
  }
  return { app, drawnAt, frames: arrivals.length };
}
const stalled = (capture) => { const phase = capture % 500; return phase < 60 ? 60 - phase : 0; };
const maxGap = (times, from) => Math.max(...times.filter((t) => t >= from).map((t, i, all) => (i ? t - all[i - 1] : 0)));

test('a 60 ms stall every 500 ms is smoothed without dropping frames once the hold adapts', () => {
  const { app, drawnAt, frames } = playout({ seconds: 10, stall: stalled });
  const stats = app.context.window.nativeStats;
  assert.equal(stats.superseded, 0);
  assert.equal(stats.drawn, frames);
  assert.ok(maxGap(drawnAt, 3000) <= 2 * 16.667 + 1, `max gap ${maxGap(drawnAt, 3000)}`);
});

test('on a clean link the hold stays under one refresh', () => {
  const { app } = playout({ seconds: 5 });
  assert.ok(app.context.window.nativeStats.holdMs < 16.667);
});

test('a timestamp jump after idle neither delays the next frame nor inflates the hold', () => {
  for (const jump of [5000, 0]) {
    const app = viewer();
    for (let k = 1; k <= 60; k++) { app.setTime(k * 16.667); app.frame(k, 1280, 720, 8, Math.round(k * 16667) + 1); app.refresh(k * 16.667 + 1); }
    app.refresh(1100);
    const before = traced(app, 'draw').length;
    app.setTime(3000);
    app.frame(61, 1280, 720, 8, Math.round(61 * 16667 + jump * 1000) + 1);
    assert.equal(traced(app, 'draw').length, before + 1);
    assert.ok(app.context.window.nativeStats.holdMs < 1);
  }
});

test('the hold shrinks back within 4 s after the stalls stop', () => {
  const stopsAt = 4000;
  const { app, drawnAt } = playout({ seconds: 9, stall: (capture) => (capture < stopsAt ? stalled(capture) : 0) });
  assert.ok(drawnAt.length > 0);
  assert.ok(app.context.window.nativeStats.holdMs < 16.667);
});

test('every frame is acknowledged once and in order under stalls', () => {
  const { app, frames } = playout({ seconds: 5, stall: stalled });
  const acked = traced(app, 'ack');
  assert.deepEqual(acked, Array.from({ length: acked.length }, (_, index) => index + 1));
  assert.ok(acked.length >= frames - 8);
  const closed = traced(app, 'close').slice(0, acked.length);
  assert.deepEqual(closed, [...closed].sort((a, b) => a - b));
});

const FRAME_MS = 16.667;
const feed = (app, k, at) => { app.setTime(at); app.frame(k, 1280, 720, 8, Math.round(k * FRAME_MS * 1000) + 1); };
const withHold = () => {
  const app = viewer();
  for (let k = 1; k <= 20; k++) { feed(app, k, k * FRAME_MS); app.refresh(k * FRAME_MS + 0.5); }
  for (let k = 21; k <= 23; k++) { feed(app, k, k * FRAME_MS + 60); app.refresh(k * FRAME_MS + 60.5); }
  assert.ok(app.context.window.nativeStats.holdMs > 50);
  return app;
};

test('a clock jump while frames are queued does not stall them', () => {
  const app = withHold();
  for (let k = 24; k <= 27; k++) feed(app, k, k * FRAME_MS + 60);
  assert.equal(traced(app, 'draw').length, 24);
  const jumpAt = 28 * FRAME_MS + 5060;
  feed(app, 28, jumpAt);
  for (let time = jumpAt + 1, refreshes = 0; traced(app, 'ack').length < 28 && refreshes < 6; time += FRAME_MS, refreshes++) app.refresh(time);
  assert.equal(traced(app, 'draw').at(-1), Math.round(28 * FRAME_MS * 1000) + 1);
  assert.deepEqual(traced(app, 'ack'), Array.from({ length: 28 }, (_, index) => index + 1));
});

test('a new generation does not inherit the clock or the hold', () => {
  const app = withHold();
  runInContext('relayViewer.reset()', app.context);
  assert.equal(app.context.window.nativeStats.holdMs, 0);
  const before = traced(app, 'draw').length;
  feed(app, 1, 5000);
  assert.equal(traced(app, 'draw').length, before + 1);
  assert.equal(app.context.window.nativeStats.holdMs, 0);
});

test('under a hold, frames wait for their due time and a trimmed frame is acknowledged with its wait', () => {
  const app = withHold();
  const start = 460;
  app.setTime(start);
  for (let k = 24; k <= 37; k++) app.frame(k, 1280, 720, 8, Math.round(k * FRAME_MS * 1000) + 1);
  const hold = app.context.window.nativeStats.holdMs;
  assert.ok(hold > 50);
  app.refresh(start + 1);
  const drawn = traced(app, 'draw').length, acked = traced(app, 'ack').length;
  assert.equal(drawn, 24);
  assert.equal(app.context.window.nativeStats.superseded, 0);
  app.refresh(start + hold + 1);
  assert.equal(app.context.window.nativeStats.superseded, 11);
  assert.equal(traced(app, 'draw').length, drawn + 1);
  const waits = app.sockets[0].waits.slice(acked);
  assert.equal(waits.length, 12);
  for (const wait of waits) assert.ok(Math.abs(wait - (hold + 1) * 1000) < 1);
  const all = traced(app, 'ack');
  assert.deepEqual(all, Array.from({ length: all.length }, (_, index) => index + 1));
});

test('a refused handshake does not flash a connection error', () => {
  const app = viewer();
  const status = app.document.querySelector('#status');
  assert.equal(new URL(app.sockets[0].url).pathname, '/stream');
  app.sockets[0].onerror();
  assert.notEqual(status.textContent, 'Connection error');
  app.sockets[0].onclose({ code: 1006 });
  assert.equal(status.textContent, 'Connecting… · retrying in 1s');
  runInContext('relayViewer.connect()', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?view=1');
});

test('a token submitted in the connection form starts a fresh control-capable connection', () => {
  const app = viewer();
  app.sockets[0].onclose({ code: 1006 });
  const token = app.document.querySelector('#access-token');
  token.value = 'a'.repeat(64);
  app.document.querySelector('#connection-panel').handlers.submit({ preventDefault() {} });
  const target = new URL(app.sockets.at(-1).url);
  assert.equal(target.pathname, '/stream');
  assert.equal(target.searchParams.has('view'), false);
  assert.equal(target.searchParams.has('take'), false);
  assert.equal(app.document.querySelector('#toolbar-actions').querySelector('[data-action="control"]').attributes['aria-label'], 'Release control');
});

test('an automatic reconnect claims idle input without taking it from another owner', () => {
  const app = viewer();
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?clipboard=1');
  app.sockets.at(-1).onopen();
  app.frame(1);
  app.sockets.at(-1).onclose({ code: 1006 });
  runInContext('relayViewer.connect()', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?clipboard=1');
  app.sockets.at(-1).onclose({ code: 1006 });
  runInContext('relayViewer.connect()', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?view=1');
});

function clipboardViewer(remoteText = '', upload, { read, write, localRead, ready = true } = {}) {
  const posted = [], written = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const app = viewer({
    fetch: async (path, options = {}) => {
      if (path === '/capabilities') return json({ fps: 60, clipboard: true });
      if (path === '/clipboard' && options.method === 'POST') { posted.push(options.body); return upload ? upload(options.body) : json({ length: options.body.length }); }
      if (path === '/clipboard') return read ? read() : json({ text: remoteText });
      return { ok: false, status: 404 };
    },
    navigator: { clipboard: { readText: localRead, writeText: async (text) => { if (write) await write(text); written.push(text); } } },
  });
  runInContext('relayViewer.setViewOnly(false)', app.context);
  const canvas = app.document.querySelector('#screen'), sink = app.document.querySelector('#clipboard-sink');
  canvas.focus();
  if (ready) app.frame(1);
  return { app, canvas, sink, posted, written, setRemote: (text) => { remoteText = text; } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function chord(app, type, code, modifiers = {}) {
  let prevented = false;
  app.document.activeElement.handlers[type]({
    code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers,
    preventDefault() { prevented = true; }, getModifierState: () => false,
  });
  return prevented;
}
function clipboardNotice(app, generation = 1) {
  runInContext(`(() => {
    const data = new ArrayBuffer(20), view = new DataView(data);
    view.setUint32(0, 0x4e534c31); view.setUint8(4, 1); view.setUint8(5, 7); view.setUint32(8, ${generation});
    relayViewer.socket.onmessage({ data });
  })()`, app.context);
}
function clipboardAction(app, action) {
  const panel = app.document.querySelector('#clipboard-panel');
  panel.hidden = false;
  panel.handlers.click({ target: { closest: () => ({ dataset: { clipboard: action } }) } });
  return panel;
}
const controlPaste = [[1, 224], [1, 25], [2, 25], [2, 224]];

test('native paste uses the sink without releasing input, then restores focus and uploads before replay', async () => {
  const { app, canvas, sink, posted } = clipboardViewer();
  await settle();
  chord(app, 'keydown', 'ControlLeft', { ctrlKey: true });
  sink.value = 'old';
  assert.equal(chord(app, 'keydown', 'KeyV', { ctrlKey: true }), false);
  assert.equal(app.document.activeElement, sink);
  assert.equal(sink.value, '');
  chord(app, 'keyup', 'ControlLeft');
  assert.deepEqual(inputBytes(app), [[1, 224]]);
  sink.value = 'captured';
  let prevented = false;
  app.listeners.paste({ preventDefault() { prevented = true; }, clipboardData: { getData: () => 'local ✓\r\nline' } });
  assert.equal(prevented, true);
  assert.equal(app.document.activeElement, canvas);
  assert.equal(sink.value, '');
  await settle();
  assert.deepEqual(posted, ['local ✓\nline']);
  assert.deepEqual(inputBytes(app), controlPaste);
  chord(app, 'keyup', 'KeyV');
  assert.equal(inputBytes(app).length, 4);
  pasteText(app, 'local ✓\r\nline');
  await settle();
  assert.deepEqual(posted, ['local ✓\nline', 'local ✓\nline']);
});

test('plain v typed during a paste upload follows the paste and modifier release in order', async () => {
  let complete;
  const { app } = clipboardViewer('', () => new Promise((resolve) => { complete = resolve; }));
  await settle();
  chord(app, 'keydown', 'ControlLeft', { ctrlKey: true });
  pasteText(app, 'local');
  chord(app, 'keydown', 'KeyV', { ctrlKey: true, repeat: true });
  chord(app, 'keyup', 'KeyV', { ctrlKey: true });
  chord(app, 'keyup', 'ControlLeft');
  chord(app, 'keydown', 'KeyV');
  chord(app, 'keyup', 'KeyV');
  assert.deepEqual(inputBytes(app), [[1, 224]]);
  complete({ ok: true });
  await settle();
  assert.deepEqual(inputBytes(app), [...controlPaste, [1, 25], [2, 25]]);
  assert.equal(app.sockets.at(-1).inputs.at(-2).modifiers, 0);
});

test('a latched Shift wraps the paste but not the next queued key', async () => {
  const { app } = clipboardViewer();
  await settle();
  const hold = { dataset: { hold: 'ShiftLeft' }, setAttribute(name, value) { this[name] = value; } };
  app.document.querySelector('#keys-panel').handlers.click({ target: { closest: (selector) => selector === '[data-hold]' ? hold : null } });
  pasteText(app, 'local');
  chord(app, 'keydown', 'KeyA');
  await settle();
  assert.deepEqual(inputBytes(app), [[1, 225], ...controlPaste, [2, 225], [1, 4]]);
  const inputs = app.sockets.at(-1).inputs;
  assert.equal(inputs[2].modifiers, 3);
  assert.equal(inputs.at(-1).modifiers, 0);
  assert.equal(hold['aria-pressed'], 'false');
});

test('a paste shortcut without local text pastes what the remote clipboard holds', async () => {
  const { app, canvas, posted } = clipboardViewer();
  await settle();
  chord(app, 'keydown', 'ControlLeft', { ctrlKey: true });
  const mark = app.timerCount();
  chord(app, 'keydown', 'KeyV', { ctrlKey: true });
  app.timersAfter(mark);
  assert.equal(app.document.activeElement, canvas);
  assert.deepEqual(posted, []);
  assert.deepEqual(inputBytes(app), [[1, 224], [1, 25], [2, 25]]);
});

test('without a native paste event, readText uploads and replays Cmd+V with a missing modifier', async () => {
  const { app, canvas, sink, posted } = clipboardViewer('', undefined, { localRead: async () => 'fallback' });
  await settle();
  const mark = app.timerCount();
  assert.equal(chord(app, 'keydown', 'KeyV', { metaKey: true }), false);
  assert.equal(app.document.activeElement, sink);
  app.runTimer(mark);
  assert.equal(app.document.activeElement, canvas);
  assert.deepEqual(inputBytes(app), []);
  await settle();
  assert.deepEqual(posted, ['fallback']);
  assert.deepEqual(app.sockets.at(-1).inputs, [
    { event: 1, code: 227, modifiers: 8 }, { event: 1, code: 25, modifiers: 8 },
    { event: 2, code: 25, modifiers: 8 }, { event: 2, code: 227, modifiers: 0 },
  ]);
});

test('an unresolved readText falls back to the remote clipboard and ignores a late result', async () => {
  let complete;
  const { app, posted } = clipboardViewer('', undefined, { localRead: () => new Promise((resolve) => { complete = resolve; }) });
  await settle();
  const mark = app.timerCount();
  chord(app, 'keydown', 'KeyV', { ctrlKey: true });
  app.runTimer(mark);
  assert.deepEqual(inputBytes(app), []);
  app.runTimer(mark + 1);
  await settle();
  assert.deepEqual(inputBytes(app), controlPaste);
  complete('late');
  await settle();
  assert.deepEqual(posted, []);
});

test('a shortcut before the stream is ready cannot capture or upload a paste', async () => {
  const { app, canvas, posted } = clipboardViewer('', undefined, { ready: false });
  await settle();
  pasteText(app, 'local');
  assert.equal(app.document.activeElement, canvas);
  assert.deepEqual(inputBytes(app), []);
  assert.deepEqual(posted, []);
});

test('a remote copy reaches the host, but the viewer\'s own paste and empty text are not copied back', async () => {
  const { app, posted, written, setRemote } = clipboardViewer('remote text');
  await settle();
  clipboardNotice(app);
  await settle();
  assert.deepEqual(written, ['remote text']);
  chord(app, 'keydown', 'KeyV', { ctrlKey: true });
  app.listeners.paste({ preventDefault() {}, clipboardData: { getData: () => 'pasted' } });
  await settle();
  setRemote('pasted');
  clipboardNotice(app);
  await settle();
  setRemote('');
  clipboardNotice(app);
  await settle();
  assert.deepEqual(written, ['remote text']);
  pasteText(app, 'after empty');
  await settle();
  assert.deepEqual(posted, ['pasted', 'after empty']);
});

test('a stale-generation clipboard notice cannot take precedence over a local paste', async () => {
  const { app, posted, written } = clipboardViewer('remote');
  await settle();
  app.frame(1, undefined, undefined, undefined, undefined, 2);
  chord(app, 'keydown', 'KeyV', { ctrlKey: true });
  clipboardNotice(app, 1);
  app.listeners.paste({ preventDefault() {}, clipboardData: { getData: () => 'local' } });
  await settle();
  assert.deepEqual(posted, ['local']);
  assert.deepEqual(written, []);
});

function pasteText(app, text) {
  chord(app, 'keydown', 'KeyV', { ctrlKey: true });
  app.listeners.paste({ preventDefault() {}, clipboardData: { getData: () => text } });
}

test('a paste after a copy shortcut waits for a remote clipboard notice', async () => {
  const { app, posted } = clipboardViewer('remote');
  await settle();
  chord(app, 'keydown', 'ControlLeft', { ctrlKey: true });
  chord(app, 'keydown', 'KeyC', { ctrlKey: true });
  chord(app, 'keyup', 'KeyC', { ctrlKey: true });
  pasteText(app, 'stale');
  await settle();
  assert.deepEqual(posted, []);
  assert.deepEqual(inputBytes(app).slice(-2), [[1, 6], [2, 6]]);
  clipboardNotice(app);
  await settle();
  assert.deepEqual(posted, []);
  assert.deepEqual(inputBytes(app).slice(-2), [[1, 25], [2, 25]]);
});

for (const code of ['KeyC', 'KeyX']) {
  test(`a no-op ${code} shortcut does not block a local paste`, async () => {
    const { app, posted } = clipboardViewer('remote');
    await settle();
    chord(app, 'keydown', 'ControlLeft', { ctrlKey: true });
    const mark = app.timerCount();
    chord(app, 'keydown', code, { ctrlKey: true });
    chord(app, 'keyup', code, { ctrlKey: true });
    pasteText(app, 'local');
    assert.deepEqual(posted, []);
    app.timersAfter(mark);
    await settle();
    assert.deepEqual(posted, ['local']);
    assert.deepEqual(inputBytes(app).slice(-2), [[1, 25], [2, 25]]);
  });
}

test('successive copy shortcuts keep the observation open until the latest window ends', async () => {
  const { app, posted } = clipboardViewer();
  await settle();
  const mark = app.timerCount();
  chord(app, 'keydown', 'KeyC', { ctrlKey: true });
  chord(app, 'keyup', 'KeyC', { ctrlKey: true });
  chord(app, 'keydown', 'KeyX', { ctrlKey: true });
  chord(app, 'keyup', 'KeyX', { ctrlKey: true });
  pasteText(app, 'local');
  app.runTimer(mark);
  await settle();
  assert.deepEqual(posted, []);
  app.timersAfter(mark);
  await settle();
  assert.deepEqual(posted, ['local']);
});

test('a timed-out copy does not force a later notice to write previously synced text', async () => {
  const reads = [];
  const { app, posted, written } = clipboardViewer('', undefined, { read: () => new Promise((resolve) => reads.push(resolve)) });
  await settle();
  pasteText(app, 'same');
  await settle();
  const mark = app.timerCount();
  chord(app, 'keydown', 'KeyC', { ctrlKey: true });
  chord(app, 'keyup', 'KeyC', { ctrlKey: true });
  app.timersAfter(mark);
  clipboardNotice(app);
  clipboardNotice(app);
  pasteText(app, 'stale');
  reads[1]({ ok: true, json: async () => ({ text: 'same' }) });
  reads[0]({ ok: true, json: async () => ({ text: 'superseded' }) });
  await settle();
  assert.deepEqual(posted, ['same']);
  assert.deepEqual(written, []);
});

test('a remote notice between the paste shortcut and paste event keeps remote precedence', async () => {
  const { app, posted } = clipboardViewer('remote');
  await settle();
  chord(app, 'keydown', 'KeyV', { ctrlKey: true });
  clipboardNotice(app);
  await settle();
  app.listeners.paste({ preventDefault() {}, clipboardData: { getData: () => 'stale' } });
  await settle();
  assert.deepEqual(posted, []);
  assert.deepEqual(inputBytes(app), controlPaste);
});

test('a paste during a pending remote copy does not upload stale local text', async () => {
  let complete;
  const { app, posted, written } = clipboardViewer('', undefined, { read: () => new Promise((resolve) => { complete = resolve; }) });
  await settle();
  clipboardNotice(app);
  pasteText(app, 'stale');
  assert.deepEqual(posted, []);
  assert.deepEqual(inputBytes(app), controlPaste);
  complete({ ok: true, json: async () => ({ text: 'remote' }) });
  await settle();
  assert.deepEqual(written, ['remote']);
});

test('a paste while a remote copy is being written locally does not upload stale text', async () => {
  let complete;
  const { app, posted, written } = clipboardViewer('remote', undefined, { write: () => new Promise((resolve) => { complete = resolve; }) });
  await settle();
  clipboardNotice(app);
  await settle();
  pasteText(app, 'stale');
  assert.deepEqual(posted, []);
  complete();
  await settle();
  assert.deepEqual(written, ['remote']);
});

for (const recovery of ['fresh host text', 'blur and refocus']) {
  test(`a failed host write preserves the remote clipboard until ${recovery}`, async () => {
    const { app, posted, written } = clipboardViewer('remote', undefined, { write: async () => { throw new Error('denied'); } });
    await settle();
    pasteText(app, 'host');
    await settle();
    clipboardNotice(app);
    await settle();
    pasteText(app, 'host');
    await settle();
    assert.deepEqual(posted, ['host']);
    assert.deepEqual(inputBytes(app).slice(-4), controlPaste);
    if (recovery === 'blur and refocus') {
      app.document.focused = false;
      app.windowListeners.blur();
      clipboardNotice(app);
      app.document.focused = true;
    }
    const text = recovery === 'fresh host text' ? 'new' : 'host';
    pasteText(app, text);
    await settle();
    assert.deepEqual(posted, ['host', text]);
    assert.deepEqual(written, []);
  });
}

for (const gesture of ['keydown', 'pointerdown']) {
  test(`a ${gesture} gesture can retry a denied remote-to-host clipboard write`, async () => {
    let gestureActive = false;
    const { app, canvas, written } = clipboardViewer('remote', undefined, { write: async () => {
      if (!gestureActive) throw new Error('activation required');
    } });
    await settle();
    clipboardNotice(app);
    await settle();
    assert.deepEqual(written, []);
    gestureActive = true;
    if (gesture === 'keydown') chord(app, 'keydown', 'KeyA');
    else canvas.handlers.pointerdown({ button: 0, clientX: 10, clientY: 10, preventDefault() {} });
    gestureActive = false;
    await settle();
    assert.deepEqual(written, ['remote']);
  });
}

test('a copy queued behind an upload protects the following paste', async () => {
  let complete;
  const { app, posted, written } = clipboardViewer('remote', () => new Promise((resolve) => { complete = resolve; }));
  await settle();
  chord(app, 'keydown', 'ControlLeft', { ctrlKey: true });
  pasteText(app, 'first');
  chord(app, 'keydown', 'KeyC', { ctrlKey: true });
  chord(app, 'keyup', 'KeyC', { ctrlKey: true });
  assert.deepEqual(inputBytes(app), [[1, 224]]);
  complete({ ok: true });
  await settle();
  assert.deepEqual(inputBytes(app).slice(-2), [[1, 6], [2, 6]]);
  pasteText(app, 'stale');
  assert.deepEqual(posted, ['first']);
  clipboardNotice(app);
  await settle();
  assert.deepEqual(posted, ['first']);
  assert.deepEqual(written, ['remote']);
  assert.deepEqual(inputBytes(app).slice(-2), [[1, 25], [2, 25]]);
});

test('manual Push settles a waiting paste without waiting for the copy timer', async () => {
  const { app, posted } = clipboardViewer('', undefined, { localRead: async () => 'host' });
  await settle();
  chord(app, 'keydown', 'ControlLeft', { ctrlKey: true });
  chord(app, 'keydown', 'KeyC', { ctrlKey: true });
  chord(app, 'keyup', 'KeyC', { ctrlKey: true });
  pasteText(app, 'host');
  assert.deepEqual(posted, []);
  const panel = clipboardAction(app, 'push');
  await settle();
  assert.deepEqual(posted, ['host', 'host']);
  assert.deepEqual(inputBytes(app).slice(-2), [[1, 25], [2, 25]]);
  assert.equal(panel.hidden, true);
});

test('a notice supersedes manual Pull without closing its panel and queues the newest host write', async () => {
  let complete;
  const started = [];
  const { app, setRemote, written } = clipboardViewer('old', undefined, { write: async (text) => {
    started.push(text);
    if (text === 'old') await new Promise((resolve) => { complete = resolve; });
  } });
  await settle();
  const panel = clipboardAction(app, 'pull');
  await settle();
  setRemote('new');
  clipboardNotice(app);
  await settle();
  assert.deepEqual(started, ['old']);
  complete();
  await settle();
  assert.deepEqual(written, ['old', 'new']);
  assert.equal(panel.hidden, false);
  assert.equal(app.document.querySelector('#status').textContent, 'Could not copy the remote clipboard');
});

test('a paste upload started before blur cannot replay a newer paste', async () => {
  const uploads = [];
  const { app, posted } = clipboardViewer('', () => new Promise((resolve) => uploads.push(resolve)));
  await settle();
  pasteText(app, 'old');
  app.windowListeners.blur();
  pasteText(app, 'new');
  assert.deepEqual(posted, ['old', 'new']);
  uploads[0]({ ok: true });
  await settle();
  assert.deepEqual(inputBytes(app).filter(([, key]) => key === 25), []);
  uploads[1]({ ok: true });
  await settle();
  assert.deepEqual(inputBytes(app).filter(([, key]) => key === 25), [[1, 25], [2, 25]]);
});

test('a rejected clipboard upload drops the paste instead of inserting old remote text', async () => {
  const { app, posted } = clipboardViewer('old', async () => ({ ok: false, status: 413 }));
  await settle();
  const text = 'x'.repeat(256 * 1024 + 1);
  pasteText(app, text);
  await settle();
  assert.deepEqual(posted, [text]);
  assert.deepEqual(inputBytes(app), []);
});

test('a copy after window blur can sync the same remote text again', async () => {
  const { app, written } = clipboardViewer('remote text');
  await settle();
  clipboardNotice(app);
  await settle();
  app.windowListeners.blur();
  clipboardNotice(app);
  await settle();
  assert.deepEqual(written, ['remote text', 'remote text']);
});

test('a viewer that loses input to a takeover reconnects view-only', () => {
  const app = viewer();
  app.sockets[0].onopen();
  app.frame(1);
  app.sockets[0].onclose({ code: 4001 });
  runInContext('relayViewer.connect()', app.context);
  app.frame(1);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?view=1');
  assert.equal(app.document.querySelector('#status').textContent, 'Live · view only');
});

function linkedViewer(fragment) {
  const requests = [];
  const app = viewer({ hash: `#token=${'a'.repeat(64)}${fragment}`, fetch: async (path, options) => { requests.push([path, options.headers.Authorization]); return { ok: false, status: 401 }; } });
  const action = (name) => app.document.querySelector('#toolbar-actions').querySelector(`[data-action="${name}"]`);
  return { app, requests, action };
}

test('a token link without a scope opens the owner stream and reads capabilities with the token', () => {
  const { app, requests, action } = linkedViewer('');
  assert.equal(app.sockets[0].url, 'ws://localhost/stream?clipboard=1');
  assert.deepEqual(app.sockets[0].protocols, ['nsl1', `bearer.${'a'.repeat(64)}`]);
  assert.deepEqual(requests, [['/capabilities', `Bearer ${'a'.repeat(64)}`]]);
  assert.equal(action('control').hidden, false);
});

test('a watch link only opens the view-only stream, sends no HTTP request, and cannot take control', () => {
  const { app, requests, action } = linkedViewer('&scope=watch');
  assert.equal(app.sockets[0].url, 'ws://localhost/stream?view=1');
  assert.deepEqual(app.sockets[0].protocols, ['nsl1', `bearer.${'a'.repeat(64)}`]);
  assert.equal(action('control').hidden, true);
  runInContext('relayViewer.setViewOnly(false)', app.context);
  assert.equal(app.sockets.length, 1);
  app.sockets[0].onopen();
  app.frame(1);
  key(app, 'keydown', 'KeyA');
  assert.deepEqual(app.sockets[0].inputs, []);
  app.sockets[0].onclose({ code: 1006 });
  runInContext('relayViewer.connect()', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?view=1');
  assert.deepEqual(requests, []);
});

test('a control link claims, releases, and takes input without clipboard paths or HTTP requests', () => {
  const { app, requests, action } = linkedViewer('&scope=control');
  assert.equal(app.sockets[0].url, 'ws://localhost/stream');
  assert.deepEqual(app.sockets[0].protocols, ['nsl1', `bearer.${'a'.repeat(64)}`]);
  assert.equal(action('control').hidden, false);
  app.sockets[0].onopen();
  app.frame(1);
  runInContext('relayViewer.setViewOnly(true)', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?view=1');
  runInContext('relayViewer.setViewOnly(false)', app.context);
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?take=1');
  app.sockets.at(-1).onclose({ code: 1006 });
  assert.deepEqual(requests, []);
});


test('an ended grant stays disconnected until a new credential is supplied', () => {
  const { app, action } = linkedViewer('&scope=watch');
  const stream = app.sockets[0];
  stream.onopen();
  app.frame(1);
  stream.onclose({ code: 1008, reason: 'grant ended' });
  const status = app.document.querySelector('#status');
  assert.equal(status.textContent, 'Viewer link expired or was revoked');
  app.document.hidden = true;
  app.listeners.visibilitychange();
  app.document.hidden = false;
  app.listeners.visibilitychange();
  runInContext('relayViewer.connect()', app.context);
  assert.equal(app.sockets.length, 1);
  assert.equal(status.textContent, 'Viewer link expired or was revoked');
  app.document.querySelector('#access-token').value = 'b'.repeat(64);
  app.document.querySelector('#connection-panel').handlers.submit({ preventDefault() {} });
  assert.equal(app.sockets.at(-1).url, 'ws://localhost/stream?clipboard=1');
  assert.equal(action('control').hidden, false);
});
