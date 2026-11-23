import {
  CLOSE_TAKEN, HEADER_SIZE, HID_KEYS, MAGIC, MAX_BYTES_IN_FLIGHT, MESSAGE_TYPES, VERSION, encodeAck, encodeInput, encodeInputRecord, h264Codec,
  isLoopback, parseMessage, socketTarget, validToken, type InputEvent, type Message,
} from '../src/protocol/index.js';

const keys = HID_KEYS;
const canvas = document.querySelector('#screen') as HTMLCanvasElement,
  ctx = canvas.getContext('2d')!,
  status = document.querySelector('#status')!;
const cursor = document.querySelector('#cursor') as HTMLCanvasElement, cursorContext = cursor.getContext('2d')!;
const video = document.querySelector('#video') as HTMLVideoElement;
/** How the link asked the viewer to connect: WebSocket first with a WebRTC upgrade when offered, the plain WebSocket stream, WebRTC with a fallback, or WebRTC only. */
type TransportMode = 'auto' | 'ws' | 'rtc' | 'rtc-only';
/** Progress of the background WebRTC upgrade that runs beside a live WebSocket stream. */
type RtcProbe = 'idle' | 'probing' | 'unavailable';
/** Where the connection stands, including the reason WebRTC handed the stream over to WebSocket. */
type TransportState =
  | { state: 'ws-connecting' }
  | { state: 'ws-live'; rtcProbe: RtcProbe }
  | { state: 'rtc-connecting'; fallback: boolean }
  | { state: 'rtc-live'; fallback: boolean }
  | { state: 'rtc-fallback-ws'; reason: string }
  | { state: 'rtc-failed'; reason: string };
/** Reads the transport the link asked for; anything missing or unknown means WebSocket first with a WebRTC upgrade. */
function parseTransport(value: string | null): TransportMode {
  return value === 'ws' || value === 'rtc' || value === 'rtc-only' ? value : 'auto';
}
const transportParam = new URLSearchParams(location.hash.slice(1)).get('transport');
const transportMode: TransportMode = parseTransport(transportParam);
/** True when the link is allowed WebRTC and a WebSocket fallback behind it. */
const rtcFallback = transportMode === 'rtc';
let transport: TransportState = { state: 'ws-connecting' };
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
/** Projects the remote cursor onto whichever surface shows the stream, so it lands on the same spot over WebRTC and on the canvas. */
function renderCursor() {
  canvas.style.cursor = cursorAvailable && ready ? 'none' : 'default';
  const [r, w, h] = isRtcActive() ? videoRect() : [canvas.getBoundingClientRect(), canvas.width, canvas.height];
  const p = pointerPosition;
  cursor.hidden = !cursorAvailable || !ready || !p || p.pointerType === 'touch' || !(w > 0) || !(h > 0) ||
    p.clientX < r.left || p.clientX >= r.left + r.width || p.clientY < r.top || p.clientY >= r.top + r.height;
  if (cursor.hidden) return;
  const sx = r.width / w, sy = r.height / h;
  cursor.style.width = `${cursor.width * sx}px`;
  cursor.style.height = `${cursor.height * sy}px`;
  cursor.style.left = `${p.clientX - cursorHotX * sx}px`;
  cursor.style.top = `${p.clientY - cursorHotY * sy}px`;
}
function receiveCursor({ generation: gen, width, height, hotX, hotY, pixels }: Extract<Message, { type: 'cursor' }>) {
  if (!gen || gen !== currentGeneration()) throw new Error('Invalid cursor envelope');
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
type ClipboardState = { state: 'local'; copy?: boolean } | { state: 'copy-pending'; result: Promise<boolean>; resolve: (changed: boolean) => void; generation: number }
  | { state: 'remote-pending'; copy: boolean } | { state: 'remote-unavailable' };
type PasteState = { state: 'idle' } | {
  state: 'waiting' | 'sending'; key: number; buttons: number; modifiers: number;
  source: 'local' | 'remote'; revision: number; queue: InputEvent[];
};
let paste: PasteState = { state: 'idle' }, clipboardAvailable = false;
const MAX_PASTE_INPUT = 256;
const COPY_OBSERVATION_MS = 500;
let clipboard: ClipboardState = { state: 'local' };
let syncedText: string | null = null, clipboardEpoch = 0, clipboardRevision = 0;
async function readRemoteClipboard(): Promise<string | null> {
  const response = await fetch('/clipboard', { cache: 'no-store', redirect: 'error', headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = response.ok ? await response.json() : null;
  return typeof data?.text === 'string' ? data.text : null;
}
async function writeRemoteClipboard(local: string): Promise<boolean> {
  const current = clipboardEpoch, previous = clipboard;
  const text = local.replace(/\r\n/g, '\n');
  const response = await fetch('/clipboard', { method: 'POST', cache: 'no-store', redirect: 'error', headers: { ...authHeaders(), 'Content-Type': 'text/plain;charset=utf-8' }, body: text, signal: AbortSignal.timeout(5000) });
  if (!response.ok || current !== clipboardEpoch) return false;
  if (clipboard === previous) { syncedText = text; clipboard = { state: 'local' }; }
  return true;
}
async function copyRemoteClipboard(always = false, copy = false): Promise<void> {
  const current = clipboardEpoch, pending: ClipboardState = { state: 'remote-pending', copy };
  clipboard = pending;
  try {
    const text = await readRemoteClipboard();
    if (current !== clipboardEpoch || clipboard !== pending || !document.hasFocus()) return;
    if (text === null) throw new Error('unavailable');
    if (!always && !copy && text === syncedText) { clipboard = { state: 'local' }; return; }
    if (!always && !text) { clipboard = { state: 'remote-unavailable' }; return; }
    await navigator.clipboard.writeText(text);
    if (current === clipboardEpoch && clipboard === pending) { syncedText = text; clipboard = { state: 'local' }; }
  } catch (error) {
    if (current === clipboardEpoch && clipboard === pending) clipboard = { state: 'remote-unavailable' };
    throw error;
  }
}
function remoteClipboardChanged() {
  clipboardRevision++;
  const intent = clipboard.state === 'copy-pending' ? clipboard : null;
  const copy = Boolean(intent) || ((clipboard.state === 'local' || clipboard.state === 'remote-pending') && Boolean(clipboard.copy));
  if (document.hasFocus() && navigator.clipboard) copyRemoteClipboard(false, copy).catch(() => {});
  else clipboard = { state: 'remote-unavailable' };
  intent?.resolve(true);
}
function expectRemoteCopy() {
  if (paste.state !== 'idle' || (clipboard.state !== 'local' && clipboard.state !== 'copy-pending')) return;
  if (clipboard.state === 'local') {
    let resolve!: (changed: boolean) => void;
    const result = new Promise<boolean>((done) => { resolve = done; });
    clipboard = { state: 'copy-pending', result, resolve, generation: 0 };
  }
  const intent = clipboard, generation = ++intent.generation;
  setTimeout(() => {
    if (clipboard !== intent || intent.generation !== generation) return;
    clipboard = { state: 'local', copy: true };
    intent.resolve(false);
  }, COPY_OBSERVATION_MS);
}
function finishPaste(current: Exclude<PasteState, { state: 'idle' }>, replay: boolean) {
  if (paste !== current) return;
  paste = { state: 'idle' };
  if (!inputOpen() || viewOnly) return;
  if (replay) {
    const { key, buttons, modifiers } = current;
    transmit({ type: 'keyDown', key, buttons, modifiers });
    transmit({ type: 'keyUp', key, buttons, modifiers });
  }
  for (const record of current.queue) transmit(record);
  if (!replay) setStatus('Could not send the clipboard');
}
function holdBackPaste(e: KeyboardEvent, key: number): boolean {
  if (viewOnly || !clipboardAvailable || paste.state !== 'idle' || e.code !== 'KeyV' || e.altKey || !(e.ctrlKey || e.metaKey)) return false;
  const waiting = { state: 'waiting' as const, key, buttons, modifiers, revision: clipboardRevision, source: clipboard.state === 'local' || clipboard.state === 'copy-pending' ? 'local' as const : 'remote' as const, queue: [] };
  paste = waiting;
  setTimeout(() => finishPaste(waiting, true), 0);
  return true;
}
document.addEventListener('paste', (e) => {
  if (paste.state !== 'waiting') return;
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain');
  if (!text || paste.source === 'remote' || paste.revision !== clipboardRevision || (clipboard.state !== 'local' && clipboard.state !== 'copy-pending')) { finishPaste(paste, true); return; }
  const sending = { ...paste, state: 'sending' as const }, intent = clipboard.state === 'copy-pending' ? clipboard : null;
  paste = sending;
  const send = () => {
    if (paste !== sending) return;
    if (clipboard.state !== 'local') { finishPaste(sending, true); return; }
    writeRemoteClipboard(text).then(
      (ok) => finishPaste(sending, ok),
      () => finishPaste(sending, false),
    );
  };
  if (intent) intent.result.then((changed) => changed ? finishPaste(sending, true) : send());
  else send();
});

/** True while the transport carrying the stream can take input. */
function inputOpen(): boolean {
  return isRtcActive() ? channel?.readyState === 'open' : ready && socket?.readyState === WebSocket.OPEN;
}
/** Sends one input record, with its button and modifier masks set, on the transport carrying the stream. */
function transmit(record: InputEvent) {
  if (isRtcActive()) channel!.send(encodeInputRecord(record) as Uint8Array<ArrayBuffer>);
  else socket.send(encodeInput(record, generation, 0));
}
function sendInput(event: InputEvent): boolean {
  if (!inputOpen() || (viewOnly && event.type !== 'releaseAll')) return false;
  const record: InputEvent = { ...event, buttons, modifiers };
  if (paste.state === 'idle') transmit(record);
  else if (paste.queue.length < MAX_PASTE_INPUT) paste.queue.push(record);
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
  clipboardEpoch++;
  syncedText = null;
  if (clipboard.state === 'copy-pending') { clipboard.resolve(false); clipboard = { state: 'local' }; }
  else if (clipboard.state !== 'local') clipboard = { state: 'remote-unavailable' };
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
/** Fields `__relayRtcStats` copies from the inbound-rtp video report. */
const RTC_STAT_FIELDS = ['framesDecoded', 'framesDropped', 'framesReceived', 'packetsLost', 'nackCount', 'pliCount', 'jitter', 'totalDecodeTime',
  'frameWidth', 'frameHeight', 'framesPerSecond', 'jitterBufferDelay', 'jitterBufferEmittedCount'];
/** How long a live WebRTC link may stay disconnected before the viewer gives up on it, in ms. */
const RTC_GRACE_MS = 4000;
let pc: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined, eventsChannel: RTCDataChannel | undefined,
  rtcSession: string | undefined, rtcGraceTimer: any;
/** What the engine reports about WebRTC: whether it is available, and the STUN and TURN servers it wants used. */
type RtcConfig = { enabled: boolean; iceServers?: RTCIceServer[] };
/** How long the background WebRTC upgrade may take before the viewer keeps the WebSocket stream, in ms. */
const RTC_PROBE_TIMEOUT_MS = 8000;
/** How often a frame is acknowledged on an events channel that cannot wait for a presented video frame, in ms. */
const RTC_ACK_INTERVAL_MS = 16;
/** The latest frame the engine reported on an RTC events channel, waiting for an acknowledgement. */
type FrameMark = { generation: number; sequence: number; arrived: number };
/** One WebRTC events channel: the frame marks, cursor images, and clipboard notices the engine pushes beside the media. */
type RtcEvents = {
  channel: RTCDataChannel; live: boolean; generation: number; cursor?: Extract<Message, { type: 'cursor' }>;
  clipboard: boolean; mark?: FrameMark; scheduled: boolean;
};
/** A background WebRTC attempt that runs beside the WebSocket stream until its video is ready to take over. */
type RtcProbeSession = {
  pc?: RTCPeerConnection; input?: RTCDataChannel; events?: RtcEvents; session?: string; timer: any;
  connected: boolean; presenting: boolean; attached: boolean; done: boolean;
};
let liveEvents: RtcEvents | undefined, probe: RtcProbeSession | undefined;
/** Set once the page tried the background upgrade, so a flaky engine is not probed again on every reconnect. */
let probeAttempted = false;
/** True once the engine's capabilities say it serves WebRTC. */
let rtcOffered = false;
/** Set once WebRTC handed the stream to WebSocket, so later reconnects never try WebRTC again. */
let fellBackToWs = false;
let fellBackToReason = '';
/** Why the last background upgrade ended, for the transport snapshot. */
let probeNote = '';

/** True while the browser draws and sends input over WebRTC rather than the WebSocket stream. */
function isRtcActive(): boolean {
  return transport.state === 'rtc-connecting' || transport.state === 'rtc-live';
}
/** The stream generation in use, which belongs to the RTC session once WebRTC carries the stream and to the WebSocket stream before that. */
function currentGeneration(): number {
  return isRtcActive() && liveEvents ? liveEvents.generation : generation;
}
/** Reads the engine's WebRTC settings, or null when it does not serve them. */
async function rtcConfig(): Promise<RtcConfig | null> {
  const response = await fetch('/rtc/config', {
    cache: 'no-store', redirect: 'error', headers: authHeaders(), signal: AbortSignal.timeout(5000),
  });
  return response.ok ? await response.json() : null;
}
/** Reads the 20-byte frame metadata the engine sends on the events channel, which carries no frame payload. */
function parseFrameMark(data: ArrayBuffer): { generation: number; sequence: number } | null {
  if (data.byteLength !== HEADER_SIZE) return null;
  const view = new DataView(data);
  const generation = view.getUint32(8), sequence = view.getUint32(12);
  if (view.getUint32(0) !== MAGIC || view.getUint8(4) !== VERSION || view.getUint8(5) !== MESSAGE_TYPES.frame ||
      view.getUint32(16) !== 0 || !generation || !sequence) return null;
  return { generation, sequence };
}
/** Sends the pending frame acknowledgement on its events channel, with how long the viewer held the frame. */
function flushRtcAck(events: RtcEvents) {
  const mark = events.mark;
  if (!mark || events.channel.readyState !== 'open') return;
  try {
    events.channel.send(encodeAck(mark.generation, mark.sequence, performance.now() - mark.arrived) as Uint8Array<ArrayBuffer>);
  } catch (error) {}
}
/** Schedules one acknowledgement per presented frame, or one every RTC_ACK_INTERVAL_MS while the video cannot report presented frames. */
function scheduleRtcAck(events: RtcEvents) {
  if (events.scheduled) return;
  events.scheduled = true;
  if (events.live && !video.hidden && typeof (video as any).requestVideoFrameCallback === 'function') {
    (video as any).requestVideoFrameCallback(() => { events.scheduled = false; flushRtcAck(events); });
    return;
  }
  setTimeout(() => { events.scheduled = false; flushRtcAck(events); }, RTC_ACK_INTERVAL_MS);
}
/** Reads one message from an events channel, holding cursor and clipboard notices back until the session carries the stream. */
function receiveEvents(events: RtcEvents, data: ArrayBuffer) {
  const mark = parseFrameMark(data);
  if (mark) {
    events.generation = mark.generation;
    events.mark = { ...mark, arrived: performance.now() };
    scheduleRtcAck(events);
    return;
  }
  let message: Message;
  try { message = parseMessage(data); } catch (error) { return; }
  if (message.type === 'cursor') {
    if (!events.live) { events.cursor = message; return; }
    try { receiveCursor(message); } catch (error) {}
    return;
  }
  if (message.type !== 'clipboard') return;
  if (!events.live) { events.clipboard = true; return; }
  remoteClipboardChanged();
}
/** Builds a receive-only video peer connection with the engine's ICE servers and its channels for input and events. */
function createPeer(config: RtcConfig, live: boolean): { peer: RTCPeerConnection; input: RTCDataChannel; events: RtcEvents } {
  const peer = new RTCPeerConnection({ iceServers: config.iceServers ?? [] });
  const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
  if (codecs && transceiver.setCodecPreferences) {
    const rank = (codec: RTCRtpCodec) => codec.mimeType.toLowerCase() !== 'video/h264' || !/packetization-mode=1/.test(codec.sdpFmtpLine ?? '') ? 2
      : /profile-level-id=42e01f/i.test(codec.sdpFmtpLine ?? '') ? 0 : 1;
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  }
  const receiver = transceiver.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
  if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
  const input = peer.createDataChannel('input', { ordered: true });
  input.binaryType = 'arraybuffer';
  const events: RtcEvents = { channel: peer.createDataChannel('events', { ordered: true }), live, generation: 0, clipboard: false, scheduled: false };
  events.channel.binaryType = 'arraybuffer';
  events.channel.onmessage = (e: MessageEvent) => { if (e.data instanceof ArrayBuffer) receiveEvents(events, e.data); };
  return { peer, input, events };
}
/** Exchanges one non-trickle offer for the engine's answer and returns the URL of the session it created. */
async function negotiate(peer: RTCPeerConnection): Promise<string> {
  await peer.setLocalDescription(await peer.createOffer());
  await new Promise<void>((done) => {
    if (peer.iceGatheringState === 'complete') { done(); return; }
    const timer = setTimeout(done, 2000);
    peer.addEventListener('icegatheringstatechange', () => {
      if (peer.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      done();
    });
  });
  const answer = await fetch('/rtc', {
    method: 'POST', cache: 'no-store', redirect: 'error', body: peer.localDescription!.sdp,
    headers: { 'content-type': 'application/sdp', ...authHeaders() }, signal: AbortSignal.timeout(10000),
  });
  if (!answer.ok) throw new Error((await answer.json().catch(() => null))?.error ?? `HTTP ${answer.status}`);
  const locationHeader = answer.headers.get('location');
  const session = locationHeader ? new URL(locationHeader, location.href).href : '/rtc/session';
  await peer.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
  return session;
}
/** Watches the active peer connection, keeping the transport state honest and ending the session when it drops. */
function bindRtcSession(peer: RTCPeerConnection, fallback: boolean, owner: number) {
  peer.onconnectionstatechange = () => {
    if (owner !== epoch || pc !== peer) return;
    const state = peer.connectionState;
    if (state === 'connected') {
      clearTimeout(rtcGraceTimer);
      transport = { state: 'rtc-live', fallback };
      return;
    }
    if (state === 'failed') { failRtc(`connection ${state}`, fallback); return; }
    if (state !== 'disconnected') return;
    if (!ready) { failRtc(`connection ${state}`, fallback); return; }
    clearTimeout(rtcGraceTimer);
    rtcGraceTimer = setTimeout(() => {
      if (owner === epoch && pc === peer && peer.connectionState !== 'connected') failRtc(`connection ${peer.connectionState}`, fallback);
    }, RTC_GRACE_MS);
  };
}
/** Returns the displayed video content box inside its letterbox, with the stream width and height. */
function videoRect(): [{ left: number; top: number; width: number; height: number }, number, number] {
  const box = video.getBoundingClientRect(), w = video.videoWidth, h = video.videoHeight;
  const scale = w && h ? Math.min(box.width / w, box.height / h) : 0;
  return [{ left: box.left + (box.width - w * scale) / 2, top: box.top + (box.height - h * scale) / 2, width: w * scale, height: h * scale }, w, h];
}
/** Ends the session on the engine so it stops encoding for a peer connection the viewer has dropped. */
function deleteRtc(session: string) {
  fetch(session, { method: 'DELETE', cache: 'no-store', redirect: 'error', keepalive: true, headers: authHeaders() }).catch(() => {});
}
/** Closes the peer connection, detaches the video element, and ends the session on the engine. */
function endRtc() {
  clearTimeout(rtcGraceTimer);
  const peer = pc;
  pc = undefined;
  channel = undefined;
  eventsChannel = undefined;
  liveEvents = undefined;
  peer?.close();
  if (rtcSession) deleteRtc(rtcSession);
  rtcSession = undefined;
  video.srcObject = null;
}
/** Continues the stream over WebSocket after WebRTC failed, recording the reason in the transport state. */
function fallbackToWs(reason: string) {
  if (fellBackToWs) return;
  fellBackToWs = true;
  fellBackToReason = reason;
  epoch++;
  transport = { state: 'rtc-fallback-ws', reason };
  reset();
  connectWs();
}
/** Reports a WebRTC failure: hands over to WebSocket when the session allows it, otherwise shows the reason. */
function failRtc(reason: string, fallback = rtcFallback) {
  if (fallback) {
    fallbackToWs(reason);
    return;
  }
  epoch++;
  endRtc();
  video.hidden = true;
  canvas.hidden = false;
  transport = { state: 'rtc-failed', reason };
  setStatus(`WebRTC failed: ${reason}`);
}
/** Opens the WebRTC path: the engine's ICE servers, a non-trickle offer, and input over the `input` data channel. */
async function connectRtc() {
  if (reconnectMode === 'grant-ended') return;
  clearTimeout(retryTimer);
  abandonProbe('the viewer connected WebRTC directly');
  epoch++;
  const current = epoch;
  endRtc();
  reset();
  canvas.hidden = true;
  video.hidden = false;
  transport = { state: 'rtc-connecting', fallback: rtcFallback };
  setStatus('Connecting… · WebRTC');
  loadCapabilities();
  try {
    const config = await rtcConfig();
    if (current !== epoch) return;
    if (!config?.enabled) throw new Error('the engine does not offer WebRTC');
    const { peer, input, events } = createPeer(config, true);
    pc = peer;
    channel = input;
    eventsChannel = events.channel;
    liveEvents = events;
    peer.ontrack = (e) => { if (current === epoch) video.srcObject = e.streams[0] ?? new MediaStream([e.track]); };
    bindRtcSession(peer, rtcFallback, current);
    const session = await negotiate(peer);
    if (current !== epoch) { deleteRtc(session); return; }
    rtcSession = session;
  } catch (error: any) {
    if (current !== epoch) return;
    failRtc(error.message);
  }
}
/** True when this page could still upgrade its live WebSocket stream to WebRTC. */
function canProbeRtc(): boolean {
  return transportMode === 'auto' && !probeAttempted && !fellBackToWs;
}
function maybeProbeRtc() {
  if (!canProbeRtc() || !rtcOffered || probe) return;
  if (transport.state !== 'ws-live' || transport.rtcProbe !== 'idle') return;
  probeRtcUpgrade();
}
/** Closes a background probe and leaves the live WebSocket stream exactly as it was. */
function abandonProbe(reason: string) {
  const attempt = probe;
  if (!attempt) return;
  probe = undefined;
  attempt.done = true;
  probeNote = reason;
  clearTimeout(attempt.timer);
  if (attempt.pc) {
    attempt.pc.onconnectionstatechange = null;
    attempt.pc.close();
  }
  if (attempt.session) deleteRtc(attempt.session);
  if (attempt.attached && !pc) video.srcObject = null;
  if (transport.state === 'ws-live') transport = { state: 'ws-live', rtcProbe: 'unavailable' };
}
/** Takes the stream over to WebRTC once the probe is connected and its video is actually playing, leaving the canvas untouched until then. */
function tryCutOver(attempt: RtcProbeSession) {
  const events = attempt.events;
  if (probe !== attempt || attempt.done || !attempt.connected || !attempt.presenting || !attempt.pc || !events || !attempt.session) return;
  attempt.done = true;
  probe = undefined;
  probeNote = '';
  clearTimeout(attempt.timer);
  retireDecoded();
  reset();
  epoch++;
  clearTimeout(retryTimer);
  const ws = socket;
  socket = undefined as any;
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  pc = attempt.pc;
  channel = attempt.input;
  eventsChannel = events.channel;
  liveEvents = events;
  events.live = true;
  rtcSession = attempt.session;
  generation = events.generation;
  ready = true;
  video.hidden = false;
  canvas.hidden = true;
  transport = { state: 'rtc-live', fallback: true };
  bindRtcSession(attempt.pc, true, epoch);
  setStatus(`${viewOnly ? 'Live · view only' : 'Live · you have control'} · WebRTC`);
  if (events.cursor) {
    try { receiveCursor(events.cursor); } catch (error) { renderCursor(); }
  } else {
    renderCursor();
  }
  if (events.clipboard) remoteClipboardChanged();
}
/** Attempts a WebRTC session beside the live WebSocket stream, taking over only once its video plays. */
async function probeRtcUpgrade() {
  if (!canProbeRtc() || probe || !rtcOffered) return;
  if (transport.state !== 'ws-live' || transport.rtcProbe !== 'idle') return;
  probeAttempted = true;
  transport = { state: 'ws-live', rtcProbe: 'probing' };
  const current = epoch;
  const attempt: RtcProbeSession = { timer: undefined, connected: false, presenting: false, attached: false, done: false };
  probe = attempt;
  attempt.timer = setTimeout(() => { if (probe === attempt) abandonProbe('timed out'); }, RTC_PROBE_TIMEOUT_MS);
  try {
    const config = await rtcConfig();
    if (probe !== attempt) return;
    if (current !== epoch) { abandonProbe('the stream reconnected'); return; }
    if (!config?.enabled) { abandonProbe('the engine does not offer WebRTC'); return; }
    const { peer, input, events } = createPeer(config, false);
    attempt.pc = peer;
    attempt.input = input;
    attempt.events = events;
    peer.ontrack = (e) => {
      if (probe !== attempt) return;
      attempt.attached = true;
      video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };
    peer.onconnectionstatechange = () => {
      if (probe !== attempt) return;
      if (peer.connectionState === 'connected') attempt.connected = true;
      if (peer.connectionState === 'failed') { abandonProbe(`connection ${peer.connectionState}`); return; }
      tryCutOver(attempt);
    };
    const session = await negotiate(peer);
    if (probe !== attempt) { deleteRtc(session); return; }
    attempt.session = session;
    tryCutOver(attempt);
  } catch (error: any) {
    if (probe === attempt) abandonProbe(error.message);
  }
}
video.addEventListener('playing', () => {
  const attempt = probe;
  if (attempt) {
    attempt.presenting = true;
    tryCutOver(attempt);
    return;
  }
  if (!isRtcActive()) return;
  ready = true;
  transport = { state: 'rtc-live', fallback: rtcFallback };
  setStatus(`${viewOnly ? 'Live · view only' : 'Live · you have control'} · WebRTC`);
});
window.addEventListener('pagehide', () => {
  abandonProbe('the page went away');
  endRtc();
});
/** Snapshot of the peer connection, its video stats, and the selected candidate pair, for seeing which transport carries the stream. */
async function rtcStatsSnapshot() {
  const result: Record<string, unknown> = { connectionState: pc?.connectionState ?? 'closed', transportState: transport.state, transportMode, transport, probe: probeNote || null };
  const reports = await pc?.getStats();
  reports?.forEach((report: any) => {
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      for (const field of RTC_STAT_FIELDS) result[field] = report[field];
      result.mimeType = reports.get(report.codecId)?.mimeType;
    }
    if (report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) {
      result.currentRoundTripTime = report.currentRoundTripTime;
      result.localCandidateType = reports.get(report.localCandidateId)?.candidateType;
      result.remoteCandidateType = reports.get(report.remoteCandidateId)?.candidateType;
    }
  });
  return result;
}
(window as any).__relayRtcStats = rtcStatsSnapshot;
/** Connects with the transport the link asked for, opening the WebSocket stream at once in auto mode. */
function connect() {
  if ((transportMode === 'rtc' || transportMode === 'rtc-only') && !fellBackToWs) {
    connectRtc();
    return;
  }
  connectWs();
}
function connectWs() {
  endRtc();
  video.hidden = true;
  canvas.hidden = false;
  if (reconnectMode === 'grant-ended') return;
  reconnectMode = 'automatic';
  clearTimeout(retryTimer);
  abandonProbe('the WebSocket stream restarted');
  epoch++;
  const current = epoch;
  if (socket && socket.readyState < WebSocket.CLOSING) {
    release();
    retireDecoded();
    socket.close();
  }
  reset();
  transport = fellBackToWs ? { state: 'rtc-fallback-ws', reason: fellBackToReason } : { state: 'ws-connecting' };
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
    if (current !== epoch) return;
    if (!fellBackToWs) {
      transport = { state: 'ws-live', rtcProbe: canProbeRtc() ? 'idle' : 'unavailable' };
      maybeProbeRtc();
    }
    setStatus('Waiting for frame…');
    deadline = setTimeout(() => {
      if (current === epoch) fail('First frame timed out; reconnecting');
    }, 5000);
  };
  ws.onmessage = (e: MessageEvent) => {
    if (current !== epoch || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (!(e.data instanceof ArrayBuffer)) throw new Error('Invalid frame length');
      const message = parseMessage(e.data);
      if (message.type === 'cursor') { receiveCursor(message); return; }
      if (message.type === 'clipboard') { remoteClipboardChanged(); return; }
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
  const [r, w, h] = isRtcActive() ? videoRect() : [canvas.getBoundingClientRect(), canvas.width, canvas.height];
  if (r.width <= 0 || r.height <= 0) return;
  const px = clamp(Math.floor((e.clientX - r.left) * w / r.width), 0, w - 1);
  const py = clamp(Math.floor((e.clientY - r.top) * h / r.height), 0, h - 1);
  x = px / (w - 1);
  y = py / (h - 1);
}
const buttonMap: Record<number, 1 | 2 | 3> = { 0: 1, 1: 2, 2: 3 };
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
/** Focuses whichever surface currently shows the stream, so keyboard input keeps reaching the desktop. */
function focusSurface() {
  (isRtcActive() ? video : canvas).focus();
}
/** Binds pointer, keyboard, wheel, focus, and blur input on one surface, so the canvas and the video both drive the desktop. */
function bindSurface(surface: HTMLElement) {
  surface.addEventListener('keydown', (e) => {
    const code = mapKey(keys[e.code]);
    if (!code) return;
    if (paste.state !== 'idle' && e.code === 'KeyV') { e.preventDefault(); return; }
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
  });
  surface.addEventListener('keyup', (e) => {
    const code = mapKey(keys[e.code]);
    if (!code) return;
    e.preventDefault();
    syncCaps(e);
    if (e.code === 'CapsLock') return;
    if (!held.delete(code)) return;
    if (!dropLatch(code)) releaseKey(code);
  });
  surface.addEventListener('pointermove', (e) => {
    position(e);
    sendInput({ type: 'pointerMove', x, y });
  });
  surface.addEventListener('pointerleave', () => { pointerPosition = null; renderCursor(); });
  surface.addEventListener('pointerdown', (e) => {
    const button = buttonMap[e.button];
    if (!button) return;
    e.preventDefault();
    showPanel(null);
    surface.focus();
    position(e);
    buttons |= 1 << (button - 1);
    surface.setPointerCapture(e.pointerId);
    sendInput({ type: 'buttonDown', button, x, y });
  });
  surface.addEventListener('pointerup', (e) => {
    const button = buttonMap[e.button];
    if (!button) return;
    e.preventDefault();
    position(e);
    buttons &= ~(1 << (button - 1));
    sendInput({ type: 'buttonUp', button, x, y });
    if (!buttons && surface.hasPointerCapture(e.pointerId)) {
      surface.releasePointerCapture(e.pointerId);
    }
  });
  surface.addEventListener('pointercancel', release);
  surface.addEventListener('lostpointercapture', () => {
    if (buttons) release();
  });
  surface.addEventListener('contextmenu', (e) => e.preventDefault());
  surface.addEventListener('wheel', (e) => {
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
  surface.addEventListener('blur', release);
  surface.addEventListener('focus', renderCursor);
}
bindSurface(canvas);
bindSurface(video);
new ResizeObserver(renderCursor).observe(canvas);
window.addEventListener('scroll', renderCursor, { passive: true });
window.addEventListener('blur', () => { release(); pointerPosition = null; renderCursor(); });
const METRICS_UNAVAILABLE = 'Cgroup CPU (one core): unavailable · Cgroup RAM: unavailable';
let hudTimer: any, metricsRequest: AbortController | null, configuredFps = 0, activeEncoder = '', activeTransferTier: string | number | null = null;
/** Names the transport carrying the stream, so the HUD shows when the background upgrade took over. */
function transportLabel(): string {
  return isRtcActive() ? 'WebRTC' : 'WS';
}
function hudText(fps: number, mbps: number, metrics: string) {
  const live = isRtcActive();
  const width = live && video.videoWidth ? video.videoWidth : canvas.width;
  const height = live && video.videoHeight ? video.videoHeight : canvas.height;
  const encoder = [activeEncoder, activeTransferTier === null ? '' : `tier ${activeTransferTier}`].filter(Boolean).join(' · ');
  const stream = `Stream ${width}x${height}${configuredFps ? ` @ ${configuredFps} fps` : ''}${encoder ? ` · ${encoder}` : ''} · ${transportLabel()}`;
  return `${stream} · Drawn FPS: ${fps.toFixed(1)} · Stream Mbps: ${mbps.toFixed(2)} · ${metrics}`;
}
function loadCapabilities() {
  if (access !== 'owner') return;
  fetch('/capabilities', { cache: 'no-store', redirect: 'error', headers: authHeaders() })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (Number.isFinite(data?.fps) && data.fps > 0) configuredFps = data.fps;
      if (typeof data?.encoder === 'string') activeEncoder = data.encoder;
      if (typeof data?.transfer_tier === 'string' || typeof data?.transfer_tier === 'number') activeTransferTier = data.transfer_tier;
      clipboardAvailable = data?.clipboard === true;
      rtcOffered = data?.rtc === true;
      applyControl();
      maybeProbeRtc();
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
    abandonProbe('the page was hidden');
    endRtc();
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
/** Downloads a canvas as a PNG named with the local time. */
function saveScreenshot(source: HTMLCanvasElement) {
  source.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `desktop-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
}
/** Saves a screenshot of the WebRTC stream, which never lands on the screen canvas. */
function saveRtcScreenshot() {
  const frame = document.createElement('canvas');
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  frame.getContext('2d')!.drawImage(video, 0, 0);
  saveScreenshot(frame);
}
const toolbarActions: Record<string, (button: Element) => void> = {
  fullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
    .catch(() => {}),
  scale: () => showPanel('scale'),
  clipboard: () => showPanel('clipboard'),
  keys: () => showPanel('keys'),
  connection: () => showPanel('connection'),
  screenshot: () => (isRtcActive() && video.videoWidth ? saveRtcScreenshot() : saveScreenshot(canvas)),
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
  const done = pull ? copyRemoteClipboard(true) : navigator.clipboard.readText().then(async (text) => {
    if (current === clipboardEpoch && !await writeRemoteClipboard(text)) throw new Error('rejected');
  });
  done.then(
    () => { if (current === clipboardEpoch) showPanel(null); },
    () => { if (current === clipboardEpoch) setStatus(pull ? 'Could not copy the remote clipboard' : 'Could not send the clipboard'); },
  );
  focusSurface();
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
    focusSurface();
    return;
  }
  const hold = (e.target as Element).closest('[data-hold]');
  if (hold) {
    const code = keys[(hold as HTMLElement).dataset.hold!];
    if (!dropLatch(code) && holdKey(code)) {
      latched.set(code, hold);
      hold.setAttribute('aria-pressed', 'true');
    }
    focusSurface();
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
  focusSurface();
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
