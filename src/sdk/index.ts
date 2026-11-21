import { writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { plan, type Plan } from './transport.js';
import {
  RelayError, networkError, responseError, baseUrl, integer, encodeInput, encodeInputBatch, comboEvents, textEvents,
  batches, parseMessage, socketTarget, CLOSE_TAKEN, CLOSE_BUSY, MAX_CLIPBOARD_BYTES, MAX_INPUT_BATCH, MAX_INPUT_PENDING,
  type InputEvent,
} from '../protocol/index.js';

export { RelayError, ERROR_REASONS } from '../protocol/index.js';
export type { ErrorClass, ErrorReason, ErrorOptions, NextCommand } from '../protocol/index.js';
export type { InputEvent };
export type Input = InputEvent;
/** Connection settings. `url` is the engine origin (default `http://127.0.0.1:8080`), `token` is the 64-character session token that remote hosts require, and `timeout` is in milliseconds (default 10000). `ca` trusts a CA bundle and still checks the URL host name; `certificate` pins one exact server certificate and skips the host name check. */
export interface ClientOptions { url?: string; token?: string; timeout?: number; ca?: string; certificate?: string; connect?: string; signal?: AbortSignal }
export type Options = ClientOptions;
export interface InputResult { events: number }
export type Status = Record<string, unknown>;
export interface Capabilities {
  version: number; backend: string; width: number; height: number; fps: number;
  input: { keyboard: boolean; pointer: boolean; buttons: boolean; wheel: boolean };
  screenshot: string; control: string; wayland: boolean; max_input_pending: number;
  input_endpoint: string; max_input_batch: number;
  cursor: boolean; audio: boolean; clipboard: boolean; resize: boolean; ime: boolean;
  encoder?: string; hardware_encoder?: boolean; encoder_state?: string; rtc?: boolean; ice_servers?: number; transfer_tier?: string;
  clipboard_endpoint?: string; max_clipboard_bytes?: number;
}
/** Sends each call as its own request. Coordinates are fractions of the screen from 0 to 1, and `screenshot` resolves to PNG bytes. */
export interface Client {
  status(): Promise<Status>;
  capabilities(): Promise<Capabilities>;
  screenshot(): Promise<Uint8Array>;
  click(x: number, y: number, options?: { button?: 'left' | 'middle' | 'right' }): Promise<InputResult>;
  move(x: number, y: number): Promise<InputResult>;
  scroll(x: number, y: number, options?: { dx?: number; dy?: number }): Promise<InputResult>;
  key(...combos: string[]): Promise<InputResult>;
  type(text: string): Promise<InputResult>;
  input(events: InputEvent[]): Promise<InputResult>;
  /** Reads the desktop clipboard as text; an empty string when it holds no text. */
  clipboard(): Promise<string>;
  /** Replaces the desktop clipboard with text of up to 256 KiB of UTF-8; an empty string clears it. */
  setClipboard(text: string): Promise<void>;
}
/** A control connection that owns input until `close()`, or until a viewer takes control, which rejects with `control_taken`. `input` sends one raw event. */
export interface Session {
  surface: { width: number; height: number };
  capabilities(): Promise<Capabilities>;
  status(): Promise<Status>;
  screenshot(path?: string): Promise<Uint8Array>;
  input(event: InputEvent): Promise<void>;
  close(): void;
}

function target({ url = 'http://127.0.0.1:8080', timeout = 10000, token, ca, certificate, connect, signal }: ClientOptions) {
  if (ca && certificate) throw new RelayError('invalid_option', 'Pass ca or certificate, not both.');
  return {
    base: baseUrl(url, token), timeout: integer(timeout, 1, 2147483647, 'timeout'), token, ca, certificate, connect, signal,
    transport: undefined as Plan | undefined,
  };
}

type Server = ReturnType<typeof target>;

function transportPlan(server: Server): Plan {
  server.transport ??= plan({ url: server.base, ca: server.ca, certificate: server.certificate, connect: server.connect, timeout: server.timeout, signal: server.signal });
  return server.transport;
}

function headers(server: Server, body?: Uint8Array): Record<string, string> {
  const result: Record<string, string> = server.token ? { Authorization: `Bearer ${server.token}` } : {};
  if (body !== undefined) result['Content-Type'] = 'application/octet-stream';
  return result;
}

function decode<Result>(data: Buffer, binary: boolean): Result {
  if (binary) return data as Result;
  try { return JSON.parse(data.toString('utf8')) as Result; }
  catch { throw new RelayError('protocol_error', 'Invalid JSON response'); }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function disconnectedResponse(): RelayError {
  return new RelayError('disconnected', 'The connection closed before the response completed.');
}

/** Reads a fetch response body while keeping it under the shared size cap. */
async function readResponseBody(response: Awaited<ReturnType<typeof fetch>>): Promise<Buffer> {
  const stream = response.body;
  if (!stream) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RelayError('protocol_error', 'Response exceeds 8 MiB');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function nodeRequest<Result>(server: Server, where: Extract<Plan, { kind: 'node' }>, path: string, binary: boolean, body?: Uint8Array): Promise<Result> {
  const base = server.base;
  const requestHeaders = headers(server, body);
  if (body !== undefined) requestHeaders['Content-Length'] = String(body.length);
  if (server.connect) requestHeaders.Host = base.host;
  const options: RequestOptions = {
    protocol: base.protocol,
    hostname: where.dial,
    port: Number(base.port || (base.protocol === 'https:' ? 443 : 80)),
    path: `${base.pathname === '/' ? '' : base.pathname}${path}`,
    method: body === undefined ? 'GET' : 'POST',
    headers: requestHeaders,
    timeout: server.timeout,
    signal: server.signal,
    agent: where.agent,
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      run();
    };
    const fail = (error: unknown) => settle(() => {
      if (server.signal?.aborted) reject(new RelayError('canceled', 'Request canceled.'));
      else if (error instanceof RelayError) reject(error);
      else reject(networkError(error));
    });
    const incomplete = () => fail(disconnectedResponse());
    const transport = base.protocol === 'https:' ? httpsRequest : httpRequest;
    const sent = transport(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          settle(() => reject(new RelayError('protocol_error', 'Response exceeds 8 MiB')));
          sent.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', incomplete);
      response.once('aborted', incomplete);
      response.once('close', () => { if (!response.complete) incomplete(); });
      response.once('end', () => settle(() => {
        const status = response.statusCode ?? 0;
        const data = Buffer.concat(chunks, size);
        if (status >= 400) {
          let detail: { error?: string; index?: number } | null = null;
          try { detail = JSON.parse(data.toString('utf8')); } catch {}
          reject(responseError(status, detail));
          return;
        }
        if (status >= 300) {
          reject(new RelayError('component_failed', 'Server answered with a redirect; refusing to follow it'));
          return;
        }
        try { resolve(decode<Result>(data, binary)); } catch (error) { reject(error); }
      }));
    });
    const timeout = () => {
      fail(new RelayError('timeout', 'The request timed out.'));
      sent.destroy();
    };
    timer = setTimeout(timeout, server.timeout);
    sent.once('timeout', timeout);
    sent.once('error', fail);
    if (body !== undefined) sent.write(Buffer.from(body));
    sent.end();
  });
}

async function request<Result>(
  server: Server, path: string, binary = false, body?: Uint8Array,
): Promise<Result> {
  if (server.signal?.aborted) throw new RelayError('canceled', 'Request canceled.');
  const transport = transportPlan(server);
  if (transport.kind === 'node') return nodeRequest<Result>(server, transport, path, binary, body);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new RelayError('timeout', 'The request timed out.')); }, server.timeout);
  });
  const fail = (error: unknown, fallback: (error: unknown) => RelayError): never => {
    if (server.signal?.aborted) throw new RelayError('canceled', 'Request canceled.');
    if (controller.signal.aborted) throw new RelayError('timeout', 'The request timed out.');
    if (error instanceof RelayError) throw error;
    throw fallback(error);
  };
  const operation = (async () => {
    const response = await fetch(new URL(path, server.base), {
      signal: server.signal ? AbortSignal.any([controller.signal, server.signal]) : controller.signal,
      redirect: 'error', headers: headers(server, body),
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : Buffer.from(body),
    }).catch(error => fail(error, networkError));
    if (response.ok && binary && !response.body) throw new RelayError('protocol_error', 'Missing screenshot body');
    const data = await readResponseBody(response).catch(error => fail(error, disconnectedResponse));
    if (!response.ok) {
      let detail: { error?: string; index?: number } | null = null;
      try { detail = JSON.parse(data.toString('utf8')); } catch {}
      throw responseError(response.status, detail);
    }
    return decode<Result>(data, binary);
  })();
  try { return await Promise.race([operation, deadline]); } finally { clearTimeout(timer); }
}

export async function capabilities(options: ClientOptions = {}): Promise<Capabilities> {
  return request(target(options), '/capabilities');
}

export async function status(options: ClientOptions = {}): Promise<Status> {
  return request(target(options), '/metrics');
}

export async function screenshot(options: ClientOptions = {}, path?: string): Promise<Uint8Array> {
  const bytes = await request<Uint8Array>(target(options), '/screenshot.png', true);
  if (path !== undefined) {
    try { await writeFile(path, bytes); }
    catch (error) { throw new RelayError('io_error', `Screenshot write failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return bytes;
}

export function createClient(options: ClientOptions = {}): Client {
  const server = target(options);
  const send = async (groups: InputEvent[][]): Promise<InputResult> => {
    if (!groups.length) return { events: 0 };
    const capabilities = await request<Capabilities>(server, '/capabilities');
    const limit = integer(capabilities.max_input_batch, 1, MAX_INPUT_BATCH, 'max_input_batch');
    const payloads = batches(groups, limit).map(events => ({ count: events.length, body: encodeInputBatch(events) }));
    let events = 0;
    for (const payload of payloads) {
      let result: { applied: number };
      try { result = await request<{ applied: number }>(server, '/input', false, payload.body); }
      catch (error) {
        if (error instanceof RelayError) {
          const partial = Math.min(payload.count, typeof error.data?.applied === 'number'
            ? error.data.applied
            : typeof error.data?.index === 'number' ? error.data.index : 0);
          const applied = events + partial;
          Object.assign(error, { applied, data: { ...error.data, applied } });
        }
        throw error;
      }
      if (!result || result.applied !== payload.count) throw new RelayError('protocol_error', 'Invalid input result');
      events += result.applied;
    }
    return { events };
  };
  return {
    capabilities: () => request(server, '/capabilities'),
    status: () => request(server, '/metrics'),
    screenshot: () => request(server, '/screenshot.png', true),
    async click(x, y, { button = 'left' } = {}) {
      const buttons = { left: 1, middle: 2, right: 3 } as const;
      if (!Object.hasOwn(buttons, button)) throw new RelayError('invalid_input', 'Invalid button');
      const code = buttons[button];
      return send([[{ type: 'buttonDown', button: code, x, y }, { type: 'buttonUp', button: code, x, y }]]);
    },
    async move(x, y) { return send([[{ type: 'pointerMove', x, y }]]); },
    async scroll(x, y, { dx = 0, dy = 0 } = {}) {
      integer(dx, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'dx');
      integer(dy, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'dy');
      if (!dx && !dy) throw new RelayError('invalid_input', 'Nothing to scroll');
      integer(1 + Math.ceil(Math.abs(dx) / 10) + Math.ceil(Math.abs(dy) / 10), 1, MAX_INPUT_BATCH, 'scroll event count');
      const events: InputEvent[] = [{ type: 'pointerMove', x, y }];
      for (const [axis, notches] of [['vertical', dy], ['horizontal', dx]] as const) {
        let remaining = notches;
        while (remaining) {
          const step = Math.max(-10, Math.min(10, remaining));
          events.push({ type: 'wheel', axis, delta: step * 120, x, y });
          remaining -= step;
        }
      }
      return send([events]);
    },
    async key(...combos) {
      if (!combos.length) throw new RelayError('invalid_input', 'At least one key combo is required');
      return send(combos.map(comboEvents));
    },
    async type(text) { return send(textEvents(text).map(event => [event])); },
    async input(events) {
      if (!Array.isArray(events) || !events.length) throw new RelayError('invalid_input', 'Input must be a nonempty array');
      return send(events.map(event => [event]));
    },
    async clipboard() {
      const result = await request<{ text: unknown }>(server, '/clipboard');
      if (typeof result?.text !== 'string') throw new RelayError('protocol_error', 'Invalid clipboard result');
      return result.text;
    },
    async setClipboard(text) {
      if (typeof text !== 'string' || text.includes('\0')) throw new RelayError('invalid_input', 'Clipboard text must be a string without NUL characters');
      const body = new TextEncoder().encode(text);
      if (body.length > MAX_CLIPBOARD_BYTES) throw new RelayError('invalid_input', `Clipboard text exceeds ${MAX_CLIPBOARD_BYTES / 1024} KiB`);
      const result = await request<{ length: unknown }>(server, '/clipboard', false, body);
      if (result?.length !== body.length) throw new RelayError('protocol_error', 'Invalid clipboard result');
    },
  };
}

export async function connect(options: ClientOptions = {}): Promise<Session> {
  const server = target(options);
  if (server.ca || server.certificate || server.connect) throw new RelayError('invalid_option', 'Control connections do not support ca, certificate, or connect options.');
  if (server.signal?.aborted) throw new RelayError('canceled', 'Control connection canceled.');
  if (typeof WebSocket === 'undefined') throw new RelayError('unsupported_platform', 'Control sessions require Node 22 or newer');
  const { url, protocols } = socketTarget(server.base, '/control', server.token);
  const socket = new WebSocket(url, protocols);
  socket.binaryType = 'arraybuffer';
  let generation = 0, sequence = 0, closed = false, ready = false, ended: RelayError | undefined;
  const pending = new Map<number, { resolve: () => void; reject: (error: RelayError) => void; timer: ReturnType<typeof setTimeout> }>();
  let resolveReady!: (surface: Session['surface']) => void;
  let rejectReady!: (error: RelayError) => void;
  const initial = new Promise<Session['surface']>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finish = (error: RelayError) => {
    if (closed) return;
    closed = true;
    ended = error;
    server.signal?.removeEventListener('abort', cancel);
    if (!ready) rejectReady(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  };
  const cancel = () => finish(new RelayError('canceled', 'Control connection canceled.'));
  server.signal?.addEventListener('abort', cancel, { once: true });
  socket.addEventListener('error', () => finish(new RelayError('unreachable', 'The connection failed.')));
  socket.addEventListener('close', ({ code }) => finish(code === CLOSE_TAKEN
    ? new RelayError('control_taken', 'A viewer took control of the desktop.', { hint: 'Wait for the viewer to release control, then connect again.' })
    : code === CLOSE_BUSY
      ? new RelayError('busy', 'Another controller holds control of the desktop.', { hint: 'Wait for it to release control, then connect again.' })
      : new RelayError('disconnected', 'Control connection closed')));
  socket.addEventListener('message', ({ data }) => {
    try {
      if (!(data instanceof ArrayBuffer)) throw new Error('Non-binary message');
      const message = parseMessage(data);
      if (!ready) {
        if (message.type !== 'controlReady') throw new Error('Invalid ready message');
        generation = message.generation;
        ready = true;
        resolveReady({ width: message.width, height: message.height });
        return;
      }
      if (message.type !== 'inputResponse' || message.generation !== generation || !pending.has(message.sequence)) throw new Error('Invalid input response');
      const item = pending.get(message.sequence)!;
      pending.delete(message.sequence);
      clearTimeout(item.timer);
      if (message.status) item.reject(new RelayError(message.status === 1 ? 'invalid_input' : 'unsupported_input', 'Input rejected by server'));
      else item.resolve();
    } catch (error) { finish(new RelayError('protocol_error', error instanceof Error ? error.message : String(error))); }
  });
  const timer = setTimeout(() => finish(new RelayError('timeout', 'Control connection timed out')), server.timeout);
  let surface: Session['surface'];
  try { surface = await initial; } finally { clearTimeout(timer); }
  return {
    surface,
    capabilities: () => request(server, '/capabilities'),
    status: () => request(server, '/metrics'),
    async screenshot(path) {
      if (closed) throw ended!;
      return screenshot({ ...options, url: server.base.href, timeout: server.timeout, token: server.token }, path);
    },
    input(event) {
      if (closed) return Promise.reject(ended!);
      if (pending.size >= MAX_INPUT_PENDING) return Promise.reject(new RelayError('busy', 'Too many pending input requests'));
      if (sequence === 0xffffffff) return Promise.reject(new RelayError('protocol_error', 'Input sequence exhausted; reconnect'));
      let message: Uint8Array;
      try { message = encodeInput(event, generation, sequence + 1); } catch (error) { return Promise.reject(error); }
      sequence++;
      return new Promise<void>((resolve, reject) => {
        const requestSequence = sequence;
        const timer = setTimeout(() => {
          pending.delete(requestSequence);
          reject(new RelayError('timeout', 'Input acknowledgement timed out'));
          finish(new RelayError('disconnected', 'Control connection timed out'));
        }, server.timeout);
        pending.set(requestSequence, { resolve, reject, timer });
        try { socket.send(Buffer.from(message)); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(requestSequence);
          reject(networkError(error));
          finish(new RelayError('disconnected', 'Control connection failed'));
        }
      });
    },
    close() { finish(new RelayError('disconnected', 'Control connection closed')); },
  };
}
