import {
  CLOSE_TAKEN, HID_KEYS, MAX_BYTES_IN_FLIGHT, encodeAck, encodeInput, h264Codec, isLoopback, parseMessage, socketTarget, validToken,
  type InputEvent, type Message,
} from '../src/protocol/index.js';

const keys = HID_KEYS;
const canvas = document.querySelector('#screen') as HTMLCanvasElement,
  ctx = canvas.getContext('2d')!,
  status = document.querySelector('#status')!;
const cursor = document.querySelector('#cursor') as HTMLCanvasElement, cursorContext = cursor.getContext('2d')!;
const clipboardSink = document.querySelector('#clipboard-sink') as HTMLTextAreaElement | null;
/** The credential the link carries: the session token, or a watch or control grant that only opens WebSockets. */
type Access = 'owner' | 'watch' | 'control';
let accessToken = '', access: Access = 'owner';
const trustedPage = location.protocol === 'https:' || isLoopback(location.hostname);
{
  const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
  const fragmentScope = new URLSearchParams(location.hash.slice(1)).get('scope');
  access = fragmentScope === 'watch' ? 'watch' : fragmentScope === 'control' ? 'control' : 'owner';
  if (fragmentToken !== null) {
    history.replaceState(null, '', location.pathname + location.search);
    if (validToken(fragmentToken) && trustedPage) accessToken = (document.querySelector('#access-token') as HTMLInputElement).value = fragmentToken;
  }
}
let cursorAvailable = false, cursorHotX = 0, cursorHotY = 0, pointerPosition: any;
function renderCursor() {
  canvas.style.cursor = cursorAvailable && ready ? 'none' : 'default';
  const r = canvas.getBoundingClientRect(), p = pointerPosition;
  cursor.hidden = !cursorAvailable || !ready || !p || p.pointerType === 'touch' ||
    p.clientX < r.left || p.clientX >= r.right || p.clientY < r.top || p.clientY >= r.bottom;
  if (cursor.hidden) return;
  const sx = r.width / canvas.width, sy = r.height / canvas.height;
  cursor.style.width = `${cursor.width * sx}px`;
  cursor.style.height = `${cursor.height * sy}px`;
  cursor.style.left = `${p.clientX - cursorHotX * sx}px`;
  cursor.style.top = `${p.clientY - cursorHotY * sy}px`;
}
function receiveCursor({ generation: gen, width, height, hotX, hotY, pixels }: Extract<Message, { type: 'cursor' }>) {
  if (!generation || gen !== generation) throw new Error('Invalid cursor envelope');
  cursorAvailable = width > 0;
  cursorHotX = hotX; cursorHotY = hotY;
  cursor.width = width || 1; cursor.height = height || 1;
  if (cursorAvailable) cursorContext.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  renderCursor();
}
const stats = ((window as any).nativeStats = {
  received: 0, drawn: 0, superseded: 0, holdMs: 0, bytes: 0, decodeerrors: 0, outstanding: 0, pendingBytes: 0, pendingHighWater: 0,
});
let reconnectMode: 'automatic' | 'grant-ended' = 'automatic';
let socket: WebSocket, decoder: VideoDecoder, retryTimer: any, deadline: any, frameHandle = 0, drawnThisFrame = false, transportBroken = false;
let generation = 0, sequence = 0, lastTimestamp = -1, ready = false, retry = 0, epoch = 0, takeRequested = false;
let backlogSince: number | null = null, lastCatchUp = -Infinity;
/** How far back the smallest arrival-minus-capture offset is searched, in ms. */
const CLOCK_WINDOW_MS = 5000;
/** How far back arrival delays are measured to size the hold, in ms. */
const JITTER_WINDOW_MS = 2000;
/** Share of recent arrivals the hold must cover. */
const JITTER_QUANTILE = 0.95;
/** Longest hold in ms; a longer hold smooths more but delays what the user sees after typing. */
const MAX_HOLD_MS = 100;
/** Milliseconds the hold shrinks per millisecond that passes. */
const HOLD_DECAY = 0.05;
/** Change in the offset, in ms, that restarts the clock. */
const CLOCK_JUMP_MS = 500;
type Sample = { time: number; offset: number; late: number };
let samples: Sample[] = [], lows: Sample[] = [], holdMs = 0;
let buttons = 0, modifiers = 0, x = 0, y = 0, viewOnly = access === 'watch', capsLock = false,
  metaAsCtrl = stored('relay.metaCtrl') === null ? macos() : stored('relay.metaCtrl') === '1';
const pending = new Map(), decoded: any[] = [], held = new Set<number>(), latched = new Map<number, Element>();
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function setStatus(message: string) {
  if (status.textContent !== message) status.textContent = message;
}
function macos(): boolean {
  const platform = (globalThis as any).navigator?.userAgentData?.platform || (globalThis as any).navigator?.platform || '';
  return platform === 'macOS' || platform === 'MacIntel';
}
const SWAP_META_CONTROL: Record<number, number> = { 224: 227, 227: 224, 228: 231, 231: 228 };
function mapKey(code: number): number {
  return metaAsCtrl ? SWAP_META_CONTROL[code] ?? code : code;
}

function setModifier(code: number, down: boolean) {
  if (code < 224 || code > 231) return;
  modifiers = down ? modifiers | 1 << (code - 224) : modifiers & ~(1 << (code - 224));
}
function syncCaps(event: KeyboardEvent) {
  if (viewOnly) return;
  const local = event.getModifierState('CapsLock');
  if (local === capsLock) return;
  if (sendInput({ type: 'keyDown', key: keys.CapsLock }) && sendInput({ type: 'keyUp', key: keys.CapsLock })) capsLock = local;
}
function clearLatched() {
  for (const button of latched.values()) button.setAttribute('aria-pressed', 'false');
  latched.clear();
}
function releaseLatched() {
  for (const code of latched.keys()) releaseKey(code);
  clearLatched();
}
const authHeaders = () => accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
type ClipboardSync =
  | { state: 'idle' }
  | { state: 'awaiting-copy'; generation: number; result: Promise<boolean>; resolve: (changed: boolean) => void; timer: ReturnType<typeof setTimeout> }
  | { state: 'pulling'; id: number; manual: boolean }
  | { state: 'remote-pending-local'; remoteText: string | null; blurredSince: boolean };
type PasteState =
  | { state: 'idle' }
  | { state: 'capturing'; id: number; key: number; buttons: number; modifiers: number; synthesizedMod: number | null; revision: number; queue: Uint8Array[]; timer: ReturnType<typeof setTimeout> }
  | { state: 'uploading'; id: number; key: number; buttons: number; modifiers: number; synthesizedMod: number | null; queue: Uint8Array[] };
type ActivePaste = Exclude<PasteState, { state: 'idle' }>;
type CapturingPaste = Extract<PasteState, { state: 'capturing' }>;
let paste: PasteState = { state: 'idle' }, clipboardAvailable = false;
let focusingSink = false, pasteId = 0;
const MAX_PASTE_INPUT = 256;
const COPY_OBSERVATION_MS = 500;
const PASTE_CAPTURE_MS = 80;
const READ_TEXT_TIMEOUT_MS = 1000;
let clipboard: ClipboardSync = { state: 'idle' };
let lastSyncedText: string | null = null;
let lastHostText: string | null = null;
let clipboardEpoch = 0, clipboardRevision = 0, clipboardPullId = 0;
let hostWriteChain: Promise<void> = Promise.resolve();
let hostWriteToken = 0, completedHostWriteToken = 0;
function settleAwaitingCopy(changed: boolean) {
  if (clipboard.state !== 'awaiting-copy') return;
  clearTimeout(clipboard.timer);
  clipboard.resolve(changed);
  clipboard = { state: 'idle' };
}
function shouldUploadLocalPaste(localText: string): boolean {
  if (!localText) return false;
  switch (clipboard.state) {
    case 'idle':
    case 'awaiting-copy':
      return true;
    case 'pulling':
      return false;
    case 'remote-pending-local':
      return clipboard.blurredSince || (lastHostText !== null && localText !== lastHostText);
  }
}
async function readRemoteClipboard(): Promise<string | null> {
  const response = await fetch('/clipboard', { cache: 'no-store', redirect: 'error', headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = response.ok ? await response.json() : null;
  return typeof data?.text === 'string' ? data.text : null;
}
async function writeRemoteClipboard(local: string): Promise<boolean> {
  const current = clipboardEpoch, previous = clipboard, pullId = clipboardPullId, revision = clipboardRevision;
  const text = local.replace(/\r\n/g, '\n');
  const response = await fetch('/clipboard', { method: 'POST', cache: 'no-store', redirect: 'error', headers: { ...authHeaders(), 'Content-Type': 'text/plain;charset=utf-8' }, body: text, signal: AbortSignal.timeout(5000) });
  if (!response.ok || current !== clipboardEpoch) return false;
  if (pullId === clipboardPullId && revision === clipboardRevision) {
    lastSyncedText = text;
    lastHostText = text;
    if (clipboard === previous && clipboard.state !== 'awaiting-copy') clipboard = { state: 'idle' };
  }
  return true;
}
function writeHostClipboard(text: string): Promise<void> {
  const token = ++hostWriteToken, currentEpoch = clipboardEpoch, pending = clipboard;
  const write = async () => {
    if (currentEpoch !== clipboardEpoch || clipboard !== pending) throw new Error('superseded');
    await navigator.clipboard.writeText(text);
  };
  const result = (token === completedHostWriteToken + 1 ? write() : hostWriteChain.then(write)).finally(() => {
    completedHostWriteToken = token;
  });
  hostWriteChain = result.catch(() => {});
  return result;
}
async function pullRemoteClipboard(manual = false): Promise<void> {
  settleAwaitingCopy(!manual);
  const pullId = ++clipboardPullId, currentEpoch = clipboardEpoch;
  clipboard = { state: 'pulling', id: pullId, manual };
  const isCurrent = () => currentEpoch === clipboardEpoch && clipboard.state === 'pulling' && clipboard.id === pullId;
  let text: string | null = null;
  try {
    text = await readRemoteClipboard();
    if (!isCurrent()) {
      if (manual) throw new Error('superseded');
      return;
    }
    if (!manual && !document.hasFocus()) {
      clipboard = { state: 'remote-pending-local', remoteText: text || null, blurredSince: true };
      return;
    }
    if (text === null) throw new Error('unavailable');
    if (!manual && (text === '' || text === lastSyncedText)) {
      clipboard = { state: 'idle' };
      return;
    }
    await writeHostClipboard(text);
    if (!isCurrent()) {
      if (manual) throw new Error('superseded');
      return;
    }
    lastSyncedText = lastHostText = text;
    clipboard = { state: 'idle' };
  } catch (error) {
    if (isCurrent()) clipboard = { state: 'remote-pending-local', remoteText: text || null, blurredSince: !document.hasFocus() };
    throw error;
  }
}
function remoteClipboardChanged(gen: number) {
  if (!generation || gen !== generation) return;
  clipboardRevision++;
  settleAwaitingCopy(true);
  if (document.hasFocus() && navigator.clipboard?.writeText) pullRemoteClipboard().catch(() => {});
  else clipboard = { state: 'remote-pending-local', remoteText: null, blurredSince: !document.hasFocus() };
}
function retryPendingRemoteCopy() {
  if (clipboard.state !== 'remote-pending-local' || clipboard.blurredSince || !clipboard.remoteText || !document.hasFocus() || !navigator.clipboard?.writeText) return;
  const pending = clipboard, text = clipboard.remoteText, currentEpoch = clipboardEpoch;
  writeHostClipboard(text).then(() => {
    if (currentEpoch !== clipboardEpoch || clipboard !== pending) return;
    lastSyncedText = lastHostText = text;
    clipboard = { state: 'idle' };
  }, () => {});
}
function expectRemoteCopy() {
  if (clipboard.state === 'awaiting-copy') {
    clearTimeout(clipboard.timer);
    const intent = clipboard, generation = ++intent.generation;
    intent.timer = setTimeout(() => {
      if (clipboard === intent && intent.generation === generation) settleAwaitingCopy(false);
    }, COPY_OBSERVATION_MS);
  } else if (clipboard.state === 'idle') {
    let resolve!: (changed: boolean) => void;
    const result = new Promise<boolean>((done) => { resolve = done; });
    clipboard = { state: 'awaiting-copy', generation: 1, result, resolve, timer: setTimeout(() => settleAwaitingCopy(false), COPY_OBSERVATION_MS) };
  }
}
function focusSink() {
  if (!clipboardSink) return;
  focusingSink = true;
  clipboardSink.value = '';
  clipboardSink.focus?.({ preventScroll: true });
  focusingSink = false;
}
function restoreCanvasFocus(focusCanvas = true) {
  if (!clipboardSink) return;
  clipboardSink.value = '';
  if (!focusCanvas || document.activeElement !== clipboardSink) return;
  focusingSink = true;
  canvas.focus?.({ preventScroll: true });
  focusingSink = false;
}
function finishPaste(current: ActivePaste, replay: boolean) {
  if (paste !== current) return;
  if (current.state === 'capturing') clearTimeout(current.timer);
  restoreCanvasFocus();
  paste = { state: 'idle' };
  if (!ready || socket?.readyState !== WebSocket.OPEN || viewOnly) return;
  if (replay) {
    const { key, buttons, modifiers, synthesizedMod } = current;
    const sendKey = (type: 'keyDown' | 'keyUp', key: number, mods = modifiers) => socket.send(encodeInput({ type, key, buttons, modifiers: mods }, generation, 0));
    if (synthesizedMod !== null) sendKey('keyDown', synthesizedMod);
    sendKey('keyDown', key);
    sendKey('keyUp', key);
    if (synthesizedMod !== null) sendKey('keyUp', synthesizedMod, modifiers & ~(1 << (synthesizedMod - 224)));
  }
  for (const input of current.queue) socket.send(input);
  if (!replay) setStatus('Could not send the clipboard');
}
function isPasteShortcut(e: KeyboardEvent): boolean {
  return e.code === 'KeyV' && !e.altKey && (e.ctrlKey || e.metaKey);
}
function pasteModifierFor(e: KeyboardEvent): number {
  return mapKey(e.metaKey ? keys.MetaLeft : keys.ControlLeft);
}
function holdBackPaste(e: KeyboardEvent, key: number): boolean {
  if (!ready || socket?.readyState !== WebSocket.OPEN || viewOnly || !clipboardAvailable || paste.state !== 'idle' || !isPasteShortcut(e)) return false;
  syncCaps(e);
  const modCode = pasteModifierFor(e);
  const modHeld = held.has(modCode) || held.has(modCode + 4) || latched.has(modCode) || latched.has(modCode + 4);
  const synthesizedMod = modHeld ? null : modCode;
  const pasteModifiers = synthesizedMod === null ? modifiers : modifiers | (1 << (synthesizedMod - 224));
  focusSink();
  const capturing: CapturingPaste = {
    state: 'capturing', id: ++pasteId, key, buttons, modifiers: pasteModifiers, synthesizedMod, revision: clipboardRevision, queue: [],
    timer: setTimeout(() => fallbackCapturePaste(capturing), PASTE_CAPTURE_MS),
  };
  paste = capturing;
  releaseLatched();
  return true;
}
function beginPasteUpload({ id, key, buttons, modifiers, synthesizedMod, queue }: CapturingPaste) {
  return paste = { state: 'uploading', id, key, buttons, modifiers, synthesizedMod, queue };
}
async function fallbackCapturePaste(current: CapturingPaste) {
  if (paste !== current) return;
  restoreCanvasFocus();
  if (typeof navigator.clipboard?.readText !== 'function') {
    commitCapturedPaste(current, '', current.revision);
    return;
  }
  const uploading = beginPasteUpload(current);
  let timer: ReturnType<typeof setTimeout> | undefined, text = '';
  try {
    text = await Promise.race([
      navigator.clipboard.readText(),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), READ_TEXT_TIMEOUT_MS); }),
    ]);
  } catch {
    text = '';
  } finally {
    clearTimeout(timer);
  }
  commitCapturedPaste(uploading, text || '', current.revision);
}
function commitCapturedPaste(current: ActivePaste, localText: string, revision: number) {
  if (paste !== current) return;
  const uploading = current.state === 'capturing' ? beginPasteUpload(current) : current;
  const intent = clipboard.state === 'awaiting-copy' ? clipboard : null;
  const proceed = () => {
    if (paste !== uploading) return;
    if (revision !== clipboardRevision || !shouldUploadLocalPaste(localText)) {
      finishPaste(uploading, true);
      return;
    }
    writeRemoteClipboard(localText).then((ok) => finishPaste(uploading, ok), () => finishPaste(uploading, false));
  };
  if (intent) intent.result.then((changed) => {
    if (paste !== uploading) return;
    if (changed) finishPaste(uploading, true);
    else proceed();
  });
  else proceed();
}
document.addEventListener('paste', (e) => {
  if (paste.state !== 'capturing') return;
  const current = paste;
  clearTimeout(current.timer);
  e.preventDefault();
  restoreCanvasFocus();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  commitCapturedPaste(current, text, current.revision);
});

function sendInput(event: InputEvent): boolean {
  if (!ready || socket?.readyState !== WebSocket.OPEN || (viewOnly && event.type !== 'releaseAll')) return false;
  const input = encodeInput({ ...event, buttons, modifiers }, generation, 0);
  if (paste.state === 'idle') socket.send(input);
  else if (paste.queue.length < MAX_PASTE_INPUT) paste.queue.push(input);
  else { release(); setStatus('Paste cancelled · too much input queued'); return false; }
  return true;
}
function holdKey(code: number): boolean {
  setModifier(code, true);
  if (sendInput({ type: 'keyDown', key: code })) return true;
  setModifier(code, false);
  return false;
}
function releaseKey(code: number) {
  setModifier(code, false);
  sendInput({ type: 'keyUp', key: code });
}
function dropLatch(code: number): boolean {
  const button = latched.get(code);
  if (!button) return false;
  latched.delete(code);
  button.setAttribute('aria-pressed', 'false');
  releaseKey(code);
  return true;
}
function release() {
  if (paste.state === 'capturing') clearTimeout(paste.timer);
  restoreCanvasFocus(false);
  clipboardEpoch++;
  lastSyncedText = null;
  settleAwaitingCopy(false);
  if (clipboard.state === 'pulling') clipboard = { state: 'remote-pending-local', remoteText: null, blurredSince: true };
  else if (clipboard.state === 'remote-pending-local') clipboard = { ...clipboard, blurredSince: true };
  paste = { state: 'idle' };
  buttons = modifiers = 0;
  if (ready) sendInput({ type: 'releaseAll' });
  held.clear();
  clearLatched();
}
function reset() {
  release();
  ready = false;
  cursorAvailable = false;
  cursor.width = cursor.height = 1;
  renderCursor();
  clearTimeout(deadline);
  cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  drawnThisFrame = false;
  backlogSince = null;
  lastCatchUp = -Infinity;
  samples = []; lows = []; holdMs = stats.holdMs = 0;
  pending.clear();
  for (const item of decoded) item.frame.close();
  decoded.length = 0;
  stats.outstanding = 0;
  stats.pendingBytes = 0;
  generation = 0;
  capsLock = false;
  sequence = 0;
  lastTimestamp = -1;
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = undefined as any;
}
function fail(message: string) {
  stats.decodeerrors++;
  setStatus(message);
  const old = socket;
  reset();
  if (old && old.readyState < WebSocket.CLOSING) old.close();
}
function watchPending(current: number) {
  clearTimeout(deadline);
  const oldest = pending.values().next().value as any;
  if (oldest) {
    deadline = setTimeout(() => {
      if (current === epoch) fail('Decoder timed out; reconnecting');
    }, Math.max(0, oldest.arrived + 5000 - performance.now()));
  }
}
/**
 * Returns the smallest recent arrival-minus-capture offset, the base the frame is timed against, and sets the hold
 * to a high percentile of how much later frames arrive, capped at MAX_HOLD_MS. An offset jump above CLOCK_JUMP_MS
 * (idle desktop or a long outage) restarts the clock and the hold.
 */
function observeArrival(timestamp: number, arrivedMs: number): number {
  const offset = arrivedMs - timestamp / 1000, last = samples.at(-1);
  if (last && Math.abs(offset - last.offset) > CLOCK_JUMP_MS) { samples = []; lows = []; holdMs = 0; }
  const previous = samples.at(-1)?.time ?? arrivedMs, sample = { time: arrivedMs, offset, late: 0 };
  samples.push(sample);
  while (lows.length && lows[lows.length - 1].offset >= offset) lows.pop();
  lows.push(sample);
  while (samples[0].time < arrivedMs - CLOCK_WINDOW_MS) {
    if (lows[0] === samples[0]) lows.shift();
    samples.shift();
  }
  const base = lows[0].offset, recent: number[] = [];
  sample.late = offset - base;
  for (let i = samples.length - 1; i >= 0 && samples[i].time >= arrivedMs - JITTER_WINDOW_MS; i--) recent.push(samples[i].late);
  recent.sort((a, b) => a - b);
  const target = Math.min(MAX_HOLD_MS, recent[Math.floor(JITTER_QUANTILE * (recent.length - 1))]);
  holdMs = target >= holdMs ? target : Math.max(target, holdMs - (arrivedMs - previous) * HOLD_DECAY);
  stats.holdMs = holdMs;
  return base;
}
/** A frame is due once its capture time on the clock it arrived under, plus the current hold, has passed; 1e-6 ms absorbs float rounding. */
function isDue(item: any, now: number): boolean {
  return item.timestamp / 1000 + item.base + holdMs <= now + 1e-6;
}
function dueCount(now: number): number {
  let count = 0;
  while (count < decoded.length && isDue(decoded[count], now)) count++;
  return count;
}
function schedulePresent() {
  if (!frameHandle) frameHandle = requestAnimationFrame(present);
}
function ackFrame(item: any): boolean {
  try {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('Connection closed before ACK');
    socket.send(encodeAck(item.gen, item.seq, performance.now() - item.arrived));
    return true;
  } catch (error: any) {
    fail(`ACK failed: ${error.message}`);
    return false;
  }
}
function retireDecoded() {
  if (transportBroken || socket?.readyState !== WebSocket.OPEN) return;
  for (const item of decoded) if (!ackFrame(item)) break;
}
function draw(item: any): boolean {
  try {
    if (item.gen !== generation) throw new Error('Stale decoded frame');
    ctx.drawImage(item.frame, 0, 0, canvas.width, canvas.height);
  } catch (error: any) {
    item.frame.close();
    fail(`Draw failed: ${error.message}`);
    return false;
  }
  item.frame.close();
  stats.drawn++;
  const wasReady = ready;
  ready = true;
  if (!wasReady) renderCursor();
  retry = 0;
  setStatus(viewOnly ? 'Live · view only' : 'Live · you have control');
  drawnThisFrame = true;
  return ackFrame(item);
}
type Phase = 'idle' | 'backlog' | 'catchUp' | 'overrun';
/**
 * Decides what the presenter does this refresh: nothing, wait out a backlog, drop one frame, or drop down to two.
 * `draws` is 1 when this refresh will draw a frame, so a queue of three that the draw brings to two is idle.
 */
function presenterPhase(due: number, draws: number, backlogMs: number, sinceCatchUpMs: number, headOverstayMs: number): Phase {
  if (due <= 2) return 'idle';
  if (due > 12 || headOverstayMs > 200) return 'overrun';
  if (due - draws <= 2) return 'idle';
  return backlogMs < 500 || sinceCatchUpMs < 250 ? 'backlog' : 'catchUp';
}
function trimDecoded(now: number, draws = 0): boolean {
  let due = dueCount(now);
  const phase = presenterPhase(
    due, draws, now - (backlogSince ?? now), now - lastCatchUp, decoded.length ? now - decoded[0].arrived - holdMs : 0,
  );
  if (phase === 'idle') {
    backlogSince = null;
    return true;
  }
  backlogSince ??= now;
  if (phase === 'backlog') return true;
  do {
    const dropped = decoded.shift();
    dropped.frame.close();
    stats.superseded++;
    due--;
    if (!ackFrame(dropped)) return false;
  } while (phase === 'overrun' && due > 2);
  if (due <= 2) backlogSince = null;
  if (phase === 'catchUp') lastCatchUp = now;
  return true;
}
function presentDecoded(item: any): boolean {
  const now = performance.now(), immediate = !decoded.length && !drawnThisFrame;
  decoded.push(item);
  if (!trimDecoded(now)) return false;
  if (immediate && isDue(decoded[0], now) && !draw(decoded.shift())) return false;
  schedulePresent();
  return true;
}
function present() {
  frameHandle = 0;
  drawnThisFrame = false;
  const now = performance.now();
  if (!trimDecoded(now, 1)) return;
  let drew = false;
  if (decoded.length && isDue(decoded[0], now)) {
    if (!draw(decoded.shift())) return;
    drew = true;
  }
  if (drew || decoded.length) schedulePresent();
}
function connect() {
  if (reconnectMode === 'grant-ended') return;
  reconnectMode = 'automatic';
  clearTimeout(retryTimer);
  epoch++;
  const current = epoch;
  if (socket && socket.readyState < WebSocket.CLOSING) {
    release();
    retireDecoded();
    socket.close();
  }
  reset();
  setStatus('Connecting…');
  if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
    setStatus('WebCodecs unavailable in this browser');
    return;
  }
  const sync = access === 'owner';
  const path = viewOnly ? '/stream?view=1'
    : takeRequested ? (sync ? '/stream?take=1&clipboard=1' : '/stream?take=1')
    : sync ? '/stream?clipboard=1' : '/stream';
  takeRequested = false;
  const target = socketTarget(new URL(`${location.protocol}//${location.host}`), path, accessToken);
  socket = new WebSocket(target.url, target.protocols);
  transportBroken = false;
  loadCapabilities();
  const ws = socket;
  ws.binaryType = 'arraybuffer';
  let opened = false;
  ws.onopen = () => {
    opened = true;
    if (current === epoch) {
      setStatus('Waiting for frame…');
      deadline = setTimeout(() => {
        if (current === epoch) fail('First frame timed out; reconnecting');
      }, 5000);
    }
  };
  ws.onmessage = (e: MessageEvent) => {
    if (current !== epoch || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (!(e.data instanceof ArrayBuffer)) throw new Error('Invalid frame length');
      const message = parseMessage(e.data);
      if (message.type === 'cursor') { receiveCursor(message); return; }
      if (message.type === 'clipboard') { remoteClipboardChanged(message.generation); return; }
      if (message.type !== 'frame') throw new Error('Invalid frame header');
      const { generation: gen, sequence: seq, keyframe, width, height, timestamp, data } = message;
      if (generation && gen < generation) throw new Error('Stale generation');
      if (gen !== generation) {
        reset();
        generation = gen;
        if (!keyframe || seq !== 1) {
          throw new Error('Generation must start with a keyframe');
        }
      }
      if (
        seq !== sequence + 1 || timestamp <= lastTimestamp ||
        pending.size >= 360 || stats.pendingBytes + data.byteLength > MAX_BYTES_IN_FLIGHT
      ) throw new Error('Unexpected frame sequence or queue limit');
      sequence = seq;
      lastTimestamp = timestamp;
      stats.received++;
      stats.bytes += data.byteLength;
      const arrived = performance.now();
      pending.set(timestamp, { gen, seq, bytes: data.byteLength, arrived, timestamp, base: observeArrival(timestamp, arrived) });
      stats.outstanding = pending.size;
      stats.pendingBytes += data.byteLength;
      stats.pendingHighWater = Math.max(stats.pendingHighWater, pending.size);
      watchPending(current);
      if (!decoder) {
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width; canvas.height = height;
          canvas.style.setProperty('--w', String(width)); canvas.style.setProperty('--h', String(height));
          syncSize();
        }
        const config = { codec: h264Codec(data), codedWidth: width, codedHeight: height, optimizeForLatency: true };
        const instance = new VideoDecoder({
          output(frame: VideoFrame) {
            let retained = false;
            try {
              if (current !== epoch || decoder !== instance) return;
              const item = pending.get(frame.timestamp);
              if (!item || item.gen !== generation) {
                throw new Error('Unexpected decoded frame');
              }
              retained = true;
              pending.delete(frame.timestamp);
              stats.pendingBytes -= item.bytes;
              stats.outstanding = pending.size;
              item.frame = frame;
              if (!presentDecoded(item)) return;
              watchPending(current);
            } catch (error: any) {
              fail(`Draw failed: ${error.message}`);
            } finally {
              if (!retained) frame.close();
            }
          },
          error(error: Error) {
            if (current === epoch && decoder === instance) fail(`Decode failed: ${error.message}`);
          },
        } as any);
        decoder = instance;
        decoder.configure(config);
      }
      decoder.decode(
        new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp, data }),
      );
    } catch (error: any) {
      if (current === epoch) fail(error.message);
    }
  };
  ws.onerror = () => {
    if (current !== epoch || !(opened || ready)) return;
    transportBroken = true;
    setStatus('Connection error');
  };
  ws.onclose = (e: CloseEvent) => {
    if (current !== epoch) return;
    reset();
    if (access !== 'owner' && e.code === 1008 && e.reason === 'grant ended') {
      reconnectMode = 'grant-ended';
      setStatus('Viewer link expired or was revoked');
      return;
    }
    if (e.code === CLOSE_TAKEN) retry = 0;
    if ((!opened || e.code === CLOSE_TAKEN) && !viewOnly) {
      viewOnly = true;
      applyControl();
    }
    if (document.hidden) {
      setStatus('Paused while hidden');
      return;
    }
    if (retry >= 5) {
      setStatus(status.textContent + ' · reconnect manually');
      return;
    }
    const delay = Math.min(1000 * 2 ** retry++, 8000);
    if (e.code === CLOSE_TAKEN) setStatus('Control changed · reconnecting view-only');
    setStatus(status.textContent + ` · retrying in ${delay / 1000}s`);
    retryTimer = setTimeout(connect, delay);
    checkAccess(current);
  };
}
function position(e: MouseEvent) {
  pointerPosition = { clientX: e.clientX, clientY: e.clientY, pointerType: (e as PointerEvent).pointerType };
  renderCursor();
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  const px = clamp(Math.floor((e.clientX - r.left) * canvas.width / r.width), 0, canvas.width - 1);
  const py = clamp(Math.floor((e.clientY - r.top) * canvas.height / r.height), 0, canvas.height - 1);
  x = px / (canvas.width - 1);
  y = py / (canvas.height - 1);
}
function handleKeyDown(e: KeyboardEvent) {
  if (!isPasteShortcut(e)) retryPendingRemoteCopy();
  const code = mapKey(keys[e.code]);
  if (!code) return;
  if (paste.state !== 'idle' && e.repeat && e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return; }
  if (!e.repeat && holdBackPaste(e, code)) return;
  e.preventDefault();
  syncCaps(e);
  if (e.code === 'CapsLock') return;
  if (e.repeat || held.has(code)) return;
  if (!holdKey(code)) return;
  if (clipboardAvailable && !e.altKey && (e.ctrlKey || e.metaKey) && (e.code === 'KeyC' || e.code === 'KeyX')) {
    expectRemoteCopy();
  }
  held.add(code);
  if (code < 224) releaseLatched();
}
function handleKeyUp(e: KeyboardEvent) {
  const code = mapKey(keys[e.code]);
  if (!code) return;
  e.preventDefault();
  syncCaps(e);
  if (e.code === 'CapsLock') return;
  if (!held.delete(code)) return;
  if (!dropLatch(code)) releaseKey(code);
}
canvas.addEventListener('keydown', handleKeyDown);
canvas.addEventListener('keyup', handleKeyUp);
if (clipboardSink) {
  clipboardSink.addEventListener('keydown', handleKeyDown);
  clipboardSink.addEventListener('keyup', handleKeyUp);
  clipboardSink.addEventListener('blur', (e) => {
    if (focusingSink || document.activeElement === canvas || e.relatedTarget === canvas) return;
    release();
  });
}
canvas.addEventListener('pointermove', (e) => {
  position(e);
  sendInput({ type: 'pointerMove', x, y });
});
canvas.addEventListener('pointerleave', () => { pointerPosition = null; renderCursor(); });
new ResizeObserver(renderCursor).observe(canvas);
window.addEventListener('scroll', renderCursor, { passive: true });
const buttonMap: Record<number, 1 | 2 | 3> = { 0: 1, 1: 2, 2: 3 };
canvas.addEventListener('pointerdown', (e) => {
  const button = buttonMap[e.button];
  if (!button) return;
  e.preventDefault();
  canvas.focus();
  retryPendingRemoteCopy();
  position(e);
  buttons |= 1 << (button - 1);
  canvas.setPointerCapture(e.pointerId);
  sendInput({ type: 'buttonDown', button, x, y });
});
canvas.addEventListener('pointerup', (e) => {
  const button = buttonMap[e.button];
  if (!button) return;
  e.preventDefault();
  position(e);
  buttons &= ~(1 << (button - 1));
  sendInput({ type: 'buttonUp', button, x, y });
  if (!buttons && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
});
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', () => {
  if (buttons) release();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const WHEEL_LINES_PER_NOTCH = 3;
const WHEEL_PIXELS_PER_NOTCH = 100;
const wheelRemainder = [0, 0];
/** Wheel notches in one event. WebKit and Blink report 120 per notch in wheelDelta however many pixels the platform gives a notch (about 4 on macOS), so that value wins; Firefox reports only deltas, in lines, pages or pixels. */
function wheelNotches(e: WheelEvent, axis: 0 | 1): number {
  const legacy = axis ? (e as WheelEvent & { wheelDeltaX?: number }).wheelDeltaX : (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof legacy === 'number' && legacy !== 0) return -legacy / 120;
  const delta = axis ? e.deltaX : e.deltaY;
  if (e.deltaMode === 1) return delta / WHEEL_LINES_PER_NOTCH;
  if (e.deltaMode === 2) return delta;
  return delta / WHEEL_PIXELS_PER_NOTCH;
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  position(e);
  for (const axis of [0, 1] as const) {
    if (!(axis ? e.deltaX : e.deltaY)) continue;
    const notches = wheelNotches(e, axis);
    if (Math.sign(notches) !== Math.sign(wheelRemainder[axis])) wheelRemainder[axis] = 0;
    wheelRemainder[axis] += notches;
    const whole = Math.trunc(wheelRemainder[axis]);
    if (!whole) continue;
    wheelRemainder[axis] -= whole;
    sendInput({ type: 'wheel', axis: axis ? 'horizontal' : 'vertical', delta: clamp(whole * 120, -1200, 1200), x, y });
  }
}, { passive: false });
canvas.addEventListener('blur', () => {
  if (focusingSink || (clipboardSink && document.activeElement === clipboardSink)) return;
  release();
});
window.addEventListener('blur', () => { release(); pointerPosition = null; renderCursor(); });
const METRICS_UNAVAILABLE = 'Cgroup CPU (one core): unavailable · Cgroup RAM: unavailable';
let hudTimer: any, metricsRequest: AbortController | null, configuredFps = 0;
function hudText(fps: number, mbps: number, metrics: string) {
  const stream = `Stream ${canvas.width}x${canvas.height}${configuredFps ? ` @ ${configuredFps} fps` : ''}`;
  return `${stream} · Drawn FPS: ${fps.toFixed(1)} · Stream Mbps: ${mbps.toFixed(2)} · ${metrics}`;
}
function loadCapabilities() {
  if (access !== 'owner') return;
  fetch('/capabilities', { cache: 'no-store', redirect: 'error', headers: authHeaders() })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (Number.isFinite(data?.fps) && data.fps > 0) configuredFps = data.fps;
      clipboardAvailable = data?.clipboard === true;
      applyControl();
    })
    .catch(() => {});
}
function startHud() {
  let previousTime = performance.now(),
    previousDrawn = stats.drawn,
    previousBytes = stats.bytes,
    previousCpu: number | undefined,
    previousCpuTime = 0,
    metrics = METRICS_UNAVAILABLE;
  hudTimer = setInterval(() => {
    const now = performance.now(), seconds = (now - previousTime) / 1000;
    const fps = (stats.drawn - previousDrawn) / seconds;
    const mbps = (stats.bytes - previousBytes) * 8 / seconds / 1_000_000;
    document.querySelector('#hud')!.textContent = hudText(fps, mbps, metrics);
    previousTime = now;
    previousDrawn = stats.drawn;
    previousBytes = stats.bytes;
    if (access === 'owner' && !metricsRequest && !document.querySelector('#stats')!.hidden) {
      const controller = metricsRequest = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      fetch('/metrics', { cache: 'no-store', signal: controller.signal, redirect: 'error', headers: authHeaders() })
        .then((response) => {
          if (!response.ok) throw new Error('Metrics unavailable');
          return response.json();
        })
        .then((data) => {
          const time = performance.now();
          if (![data.usage_usec, data.memory_current, data.inactive_file].every((n) => Number.isFinite(n) && n >= 0)) {
            throw new Error('Invalid metrics');
          }
          const cpu = previousCpu !== undefined && data.usage_usec >= previousCpu && time > previousCpuTime
            ? `${((data.usage_usec - previousCpu) / ((time - previousCpuTime) * 1000) * 100).toFixed(1)}%`
            : 'unavailable';
          const ram = (Math.max(0, data.memory_current - data.inactive_file) / 1048576).toFixed(1);
          metrics = `Cgroup CPU (one core): ${cpu} · Cgroup RAM: ${ram} MiB`;
          previousCpu = data.usage_usec;
          previousCpuTime = time;
        })
        .catch(() => {
          metrics = METRICS_UNAVAILABLE;
          previousCpu = undefined;
        })
        .finally(() => {
          clearTimeout(timer);
          if (metricsRequest === controller) metricsRequest = null;
        });
    }
  }, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(hudTimer);
    metricsRequest?.abort();
    metricsRequest = null;
    document.querySelector('#hud')!.textContent = hudText(0, 0, METRICS_UNAVAILABLE);
    release();
    epoch++;
    retireDecoded();
    if (socket) socket.close();
    reset();
    clearTimeout(retryTimer);
    if (reconnectMode === 'automatic') setStatus('Paused while hidden');
  } else {
    startHud();
    retry = 0;
    connect();
  }
});
function checkAccess(current: number) {
  if (access !== 'owner') return;
  fetch('/capabilities', { cache: 'no-store', redirect: 'error', headers: authHeaders() })
    .then((response) => {
      if (response.status !== 401 || current !== epoch) return;
      clearTimeout(retryTimer);
      setStatus(accessToken ? 'Access token rejected' : 'Access token required');
      setExpanded(true);
      showPanel('connection', true);
      (document.querySelector('#access-token') as HTMLInputElement).focus();
    })
    .catch(() => {});
}
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {}
}
const scaleButtons: Record<string, Element> = {
  fit: document.querySelector('[data-scale="fit"]')!,
  actual: document.querySelector('[data-scale="actual"]')!,
  sharp: document.querySelector('[data-scale="sharp"]')!,
};
let scaleMode = stored('relay.scale') === 'actual' ? 'actual' : 'fit', sharpPixels = stored('relay.sharp') === '1', dprQuery: MediaQueryList | undefined;
function syncSize() {
  if (scaleMode !== 'actual') {
    canvas.style.width = canvas.style.height = '';
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${canvas.width / ratio}px`;
  canvas.style.height = `${canvas.height / ratio}px`;
}
function applyScale() {
  document.body.classList.toggle('actual', scaleMode === 'actual');
  canvas.style.imageRendering = sharpPixels ? 'pixelated' : '';
  scaleButtons.fit.setAttribute('aria-pressed', String(scaleMode === 'fit'));
  scaleButtons.actual.setAttribute('aria-pressed', String(scaleMode === 'actual'));
  scaleButtons.sharp.setAttribute('aria-pressed', String(sharpPixels));
  syncSize();
  renderCursor();
}
function setScale(mode: string) {
  scaleMode = mode === 'actual' ? 'actual' : 'fit';
  store('relay.scale', scaleMode);
  applyScale();
}
function toggleSharp() {
  sharpPixels = !sharpPixels;
  store('relay.sharp', sharpPixels ? '1' : '0');
  applyScale();
}
function watchDpr() {
  syncSize();
  dprQuery?.removeEventListener?.('change', watchDpr);
  dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery?.addEventListener?.('change', watchDpr);
}
window.addEventListener('resize', watchDpr);
const metaButton = document.querySelector('#meta-ctrl')!;
function applyMeta() {
  metaButton.setAttribute('aria-pressed', String(metaAsCtrl));
}
function toggleMeta() {
  release();
  metaAsCtrl = !metaAsCtrl;
  store('relay.metaCtrl', metaAsCtrl ? '1' : '0');
  applyMeta();
}
const toolbar = document.querySelector('#toolbar')!,
  toggle = document.querySelector('#toolbar-toggle')!,
  actions = document.querySelector('#toolbar-actions')!,
  dot = document.querySelector('#dot')!,
  panels: Record<string, HTMLElement> = { keys: document.querySelector('#keys-panel')!, connection: document.querySelector('#connection-panel') as HTMLElement };
panels.scale = document.querySelector('#scale-panel') as HTMLElement;
panels.clipboard = document.querySelector('#clipboard-panel') as HTMLElement;
function showPanel(name: string | null, open = panels[name!]?.hidden) {
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = !(key === name && open);
    toolbar.querySelector(`[data-action="${key}"]`)!.setAttribute('aria-expanded', String(!panel.hidden));
  }
}
function setExpanded(open: boolean) {
  actions.hidden = !open;
  toolbar.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (!open) showPanel(null);
}
function applyControl() {
  const button = actions.querySelector('[data-action="control"]') as HTMLElement;
  button.hidden = access === 'watch';
  const label = viewOnly ? 'Take control' : 'Release control';
  button.setAttribute('aria-pressed', String(!viewOnly));
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  const clipboard = actions.querySelector('[data-action="clipboard"]') as HTMLElement;
  clipboard.hidden = viewOnly || !clipboardAvailable || !navigator.clipboard;
  if (clipboard.hidden && !panels.clipboard.hidden) showPanel(null);
}
function setViewOnly(next: boolean) {
  if (reconnectMode === 'grant-ended' || viewOnly === next || (access === 'watch' && !next)) return;
  release();
  viewOnly = next;
  takeRequested = !next;
  applyControl();
  connect();
}
function syncStatus() {
  const text = status.textContent ?? '';
  dot.className = 'dot' + (text.startsWith('Live') ? ' live' : /^(Connecting|Waiting|Paused)/.test(text) ? '' : ' error');
  toggle.setAttribute('title', text);
  toggle.setAttribute('aria-label', `Viewer controls: ${text}`);
}
new MutationObserver(syncStatus).observe(status, { childList: true, characterData: true, subtree: true });
syncStatus();
toggle.addEventListener('click', () => setExpanded(actions.hidden));
canvas.addEventListener('pointerdown', () => showPanel(null));
const toolbarActions: Record<string, (button: Element) => void> = {
  fullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
    .catch(() => {}),
  scale: () => showPanel('scale'),
  clipboard: () => showPanel('clipboard'),
  keys: () => showPanel('keys'),
  connection: () => showPanel('connection'),
  screenshot: () => canvas.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `desktop-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png'),
  control: () => setViewOnly(!viewOnly),
  stats: (button) => {
    const panel = document.querySelector('#stats')!;
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-pressed', String(!panel.hidden));
  },
};
actions.addEventListener('click', (e) => {
  const button = (e.target as Element).closest('[data-action]');
  if (button) toolbarActions[(button as HTMLElement).dataset.action!](button);
});
document.addEventListener('fullscreenchange', () => {
  toolbar.querySelector('[data-action="fullscreen"]')!.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
});
panels.clipboard.addEventListener('click', (e) => {
  const button = (e.target as Element).closest('[data-clipboard]') as HTMLElement | null;
  if (!button) return;
  const pull = button.dataset.clipboard === 'pull';
  const current = clipboardEpoch;
  if (!pull) settleAwaitingCopy(false);
  const done = pull ? pullRemoteClipboard(true) : navigator.clipboard.readText().then(async (text) => {
    if (current === clipboardEpoch && !await writeRemoteClipboard(text)) throw new Error('rejected');
  });
  done.then(
    () => { if (current === clipboardEpoch) showPanel(null); },
    () => { if (current === clipboardEpoch) setStatus(pull ? 'Could not copy the remote clipboard' : 'Could not send the clipboard'); },
  );
  canvas.focus();
});
panels.scale.addEventListener('click', (e) => {
  const button = (e.target as Element).closest('[data-scale]');
  if (!button) return;
  if ((button as HTMLElement).dataset.scale === 'sharp') toggleSharp();
  else setScale((button as HTMLElement).dataset.scale!);
});
function keepCanvasFocus(e: Event) {
  if ((e.target as Element).closest('[data-hold]') || (e.target as Element).closest('[data-keys]') || (e.target as Element).closest('#meta-ctrl')) e.preventDefault();
}
panels.keys.addEventListener('pointerdown', keepCanvasFocus);
panels.keys.addEventListener('mousedown', keepCanvasFocus);
panels.keys.addEventListener('click', (e) => {
  if ((e.target as Element).closest('#meta-ctrl')) {
    toggleMeta();
    canvas.focus();
    return;
  }
  const hold = (e.target as Element).closest('[data-hold]');
  if (hold) {
    const code = keys[(hold as HTMLElement).dataset.hold!];
    if (!dropLatch(code) && holdKey(code)) {
      latched.set(code, hold);
      hold.setAttribute('aria-pressed', 'true');
    }
    canvas.focus();
    return;
  }
  const button = (e.target as Element).closest('[data-keys]');
  if (!button) return;
  const codes = (button as HTMLElement).dataset.keys!.split('+').map((name) => keys[name]);
  const pressed: number[] = [];
  for (const code of codes) if (!latched.has(code) && holdKey(code)) pressed.push(code);
  for (const code of pressed.reverse()) releaseKey(code);
  if (codes.some((code) => code < 224)) releaseLatched();
  showPanel(null);
  canvas.focus();
});
function replaceAccess(value: string, next: Access) {
  clipboardAvailable = false;
  accessToken = value;
  access = next;
  viewOnly = next === 'watch';
  takeRequested = false;
  reconnectMode = 'automatic';
  retry = 0;
  applyControl();
  connect();
}
panels.connection.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = (document.querySelector('#access-token') as HTMLInputElement).value.trim();
  if (value && (!validToken(value) || !trustedPage)) {
    setStatus('Use a 64-character token over HTTPS or a localhost tunnel');
    return;
  }
  replaceAccess(value, 'owner');
});
if (!document.hidden) startHud();
applyScale();
applyMeta();
applyControl();
watchDpr();
connect();

export { socket, capsLock, connect, reset, setScale, setViewOnly, toggleSharp, watchDpr, toggleMeta, replaceAccess };
