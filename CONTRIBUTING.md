# Contributing to screen-relay

This guide is for contributors changing screen-relay's source. For installing and using screen-relay, read the [documentation](https://screen-relay.dev/docs). The wire format is documented there too, under "API and protocol".

For the wire format, see [screen-relay wire protocol](PROTOCOL.md).

## Source layout

| Path | Contents |
| --- | --- |
| `src/engine/core/` | Backend-neutral pipeline: `CaptureSource`, the input controller and input backend interface, encoder, color conversion, flow control, and the platform `wait` that blocks the capture loop |
| `src/engine/server/` | `main.cpp` (entry point), `config` (arguments, token and origin policy), `wire` (NSL1 encoding), `server` (session, writes, libwebsockets callback, HTTP routes), `metrics` (cgroup parsing), `screenshot` |
| `src/engine/backends/linux/x11/` | X11 capture (XDamage, MIT-SHM, XFixes cursor) and XTest input primitives |
| `src/engine/backends/linux/wayland/` | Wayland capture (wlr-screencopy), virtual keyboard and pointer input, Unicode keymap |
| `src/engine/backends/windows/` | Windows capture (Desktop Duplication, shared per display, mipmap downscaling) and SendInput input primitives |
| `src/engine/backends/macos/` | macOS capture (ScreenCaptureKit, shared per display), CGEvent input primitives, and display and permission checks |
| `src/protocol/` | Runtime-neutral wire constants, input encoding, server message parsing, socket targets, HID key table, key-combo and text parsing, origin and token rules. Built without Node imports and exported as `screen-relay/protocol`. |
| `src/sdk/` | Node client library on top of the protocol |
| `src/cli/` | The `screen-relay` CLI: argument parsing, output, client commands on the SDK, host commands that supervise the display, desktop, and engine |
| `viewer/` | Browser viewer source: `index.html` and `main.ts`; the build bundles it into `dist/viewer/viewer.js` |
| `tests/` | Unit tests and `tests/smoke.sh`; see [tests/README.md](tests/README.md) |

## Pipeline

```text
X11 display (Xvfb) or Wayland compositor (headless sway or attached)
  -> CaptureSource (X11: MIT-SHM, XDamage, XFixes cursor; Wayland: wlr-screencopy)
  -> CaptureEncoder (BGRA/ARGB to NV12, x264)
  -> flow control (ACK credit)
  -> WebSocket /stream
  -> browser VideoDecoder -> canvas

browser input over /stream
agent or CLI/SDK input over /input (HTTP) or /control (WebSocket)
  -> InputController -> InputBackend (X11: XTest; Wayland: virtual keyboard + virtual pointer v2)
  -> selected display
```

Only one of the viewer, `/control`, and `/input` owns input at a time.

`connectionPlan` in `src/engine/server/wire.cpp` is the connection state machine: it decides whether a new `/stream` or `/control` socket opens and which open socket it closes, and `server-test` checks every row of its table.

## Interfaces

- `CaptureSource` (`src/engine/core/capture-source.hpp`): `fd()`, `dimensions()`, `drainDamage()`, `pixelFormat()`, `capture()`. A frame is a non-owning CPU view (BGRA or ARGB), valid until the next capture. Optional `cursorSupported()` and `cursor(force)`.
- `InputBackend` (`src/engine/core/input.hpp`): platform primitives only: `nativeKey(usage)`, `pressKey`, `releaseKey`, `typeText(codepoint)`, `pressButton`, `releaseButton`, `move`, `scroll`, `resetLocks`, `fence(mark)`, `pending`, `cancel`, `flush`, `dimensions`, `name`. A backend may queue its work on its own thread. `pending` counts the events still queued, and the service thread refuses a batch that would take the queue past 1024 events. `fence` completes a caller's `InputFence` after everything posted before it. `cancel` drops queued text and moves as not applied while keeping key and button releases, and reports how many records were dropped.
- `InputController` (`src/engine/core/input.hpp`): owns one `InputBackend`, validates each `InputEvent`, maps normalized pointer coordinates to pixels, dedupes held keys and buttons by native key id, and releases everything on `releaseAll`. `resetLocks` turns Caps Lock off when a new input session starts. It forwards `fence` and `cancel` to the backend and returns `InputStatus`: `invalid` for a rejected event, `unsupported` when the backend has no native key for a usage or cannot type a codepoint.
- `InputQueue` (`src/engine/core/input.hpp`): the backend work queue. It counts one protocol record as one queued unit however many platform jobs that record posts, so admission, `pending`, and cancelled-record counts share one unit. `cancel` drops queued text and moves and leaves each fence it covered in worker order, so the worker completes it as not applied after the backend's fence.
- `ClipboardBackend` (`src/engine/core/clipboard.hpp`): `read` and `write` UTF-8 text with LF line endings, each returning within about two seconds. The factory takes a `ClipboardChanged` callback that the backend calls on its own thread after every clipboard change, and returns null when the desktop has no usable clipboard. The server runs requests on one worker (`ClipboardWorker`), so a slow clipboard owner never blocks the service thread. X11 and Wayland use their own connection and thread; Windows uses a message-only window on its own thread; macOS polls the pasteboard change count every 250 ms.
- `CaptureEncoder` takes a `CaptureSourceFactory`, so tests can inject a source with no X11. When `CaptureSource::resized()` turns true, the worker builds a new source from the factory, reopens x264 at the new size, deactivates the session, and calls the `Resized` callback. The server then starts a new generation on the same connection, which begins with a keyframe at the new size.
- The worker requires a valid fd. Core enforces the source size limits once, in the capture worker and on the input backend's dimensions at startup: width 320 to 16384 and height 240 to 16384, both even, which is the largest frame libx264 accepts. The image stride must be between width x 4 and width x 8 bytes.

## Threads and ownership

- The service thread owns libwebsockets, the `InputController`, flow-control state, and all socket writes. On Linux it sets `TCP_NODELAY` and `TCP_NOTSENT_LOWAT` on the stream socket.
- On Linux, input work runs on a thread that owns the backend connection. The service thread only queues events, so it never waits for a slow character. The `/input` and `/control` replies follow a backend fence (XSync on X11 and a Wayland roundtrip on Wayland), which gives clients backpressure and keeps `applied` true.
- On macOS, the input worker thread posts CGEvents from a private event source. Its fence completes after the events queued before it are posted, and it reports `applied` as false when the process lacks event posting permission.
- Shutdown destroys the input controller and joins its thread before the libwebsockets context is destroyed. The thread wakes the service thread through a shared context holder that is cleared first.
- The capture worker owns its `CaptureSource`, a reusable YUV frame, and the x264 encoder. It publishes owning `EncodedFrame` vectors to a bounded queue and wakes the service thread with `lws_cancel_service`.
- A separate screenshot worker owns its own `CaptureSource`. On macOS, the video and screenshot sources read one shared ScreenCaptureKit stream.
- Each X11 backend object owns its own X connection. Xlib threading is initialized once by `initializeNativeBackend()`.
- Workers finish before the resources they use are destroyed.
- A full queue fails the generation. It never drops an encoded reference frame.
- Held keys and buttons are released on blur, disconnect, timeout, and generation change.

## Flow control

| Rule | Value |
| --- | --- |
| Initial credit | 1 frame |
| Window after first ACK | Without TCP statistics: `ceil(peak capture-to-ACK time in seconds x frame rate) + 2`, where the peak covers the last 10 s. With TCP statistics: `ceil((2 x min RTT + viewer wait) in seconds x frame rate) + 2`, or 250 ms of frames before the first RTT sample. The viewer wait is the longest one reported in the last 10 s, counted up to 100 ms. Clamped to 2 through 3 s of frames. |
| ACK RTT | EWMA, `0.875 * old + 0.125 * sample` |
| In flight | At most 3 seconds of frames at the configured frame rate, and 8 MiB |
| Admission pause | With TCP statistics: oldest outstanding capture reaches 2 x min RTT + 2 frame intervals + the same viewer wait, capped at 3 s, or 250 ms before an RTT is known. Without: the standing queue, measured above the base capture-to-ACK time (the shortest network delay in the last 10 s plus the same viewer wait), reaches the pause queue (base time + 2 frame intervals), or 250 ms before the first ACK. `admission_age_ms` in `/metrics` reports the oldest-frame age at which this happens. |
| Generation closed | No ACK progress for 3 s, or oldest capture 3 s old (checked every 100 ms) |
| x264 | ultrafast, zerolatency, CRF 10, no B frames, no lookahead, no scheduled IDRs (IDR only at session start and recovery), 1 thread |
| Bitrate target | Starts at `--bitrate-start` (default 8 Mbps), clamped by `--bitrate-min` and `--bitrate-max` (default 1 to 40 Mbps). The VBV buffer holds about 1/15 s at the target rate. |
| Decrease | Without TCP statistics: target x 0.75 (and at most 90% of measured goodput) when 2+ frames and enough bytes are outstanding, the standing network queue is at least half the pause queue, and 500 ms since the last decrease. The floor is the configured minimum. |
| Increase | Without TCP statistics: target x 1.10 after a busy 1 s sample, the standing network queue is below a quarter of the pause queue, 1 s since last increase, 2 s since last decrease. |

Engine flags: `--fps` takes 10 to 120. `--bitrate-min`, `--bitrate-start`, and `--bitrate-max` take bits per second with `250000 <= min <= start <= max <= 100000000`. `relay-engine --help` lists them with their defaults.

Each ACK carries the time the frame spent in the viewer, from arrival until it was drawn or superseded. The engine subtracts that wait from the capture-to-ACK time to estimate how much of the delay is in the network.

Quality recovery: when the picture is unchanged for 150 ms, the capture worker re-encodes the full picture as a P frame. If the transport queue is empty it keeps refining at up to the configured frame rate, using a VBV buffer twice the motion size at the current target bitrate. Forced IDR frames at session start and recovery use that same larger buffer. Refinement stops when:

- x264 reports an effective CRF within 1 of the target and the frame is small enough to transfer in two frame intervals at the target rate,
- a refinement frame is at most one eighth the size of the cascade's first refinement frame,
- 8 refinement frames have been sent, or
- changed pixels arrive.

The worker restores the motion VBV before encoding the next changed frame. Refinement starts only when no frames are in flight, although an already published refinement frame can delay later damage.

Failure handling: a capture or encode failure keeps pending work and forces an IDR in the same generation. The first two consecutive failures reopen the encoder after 1 s. The third, or a failed reopen, is fatal and the server exits.

Color: little-endian BGRA and big-endian ARGB convert to NV12 with limited-range BT.709 in `src/engine/core/color.cpp` (NEON on AArch64, SSE2 on x86, scalar elsewhere), with chroma signaled as center-sited.

`GET /metrics` exposes the flow counters.

## Adding a backend

1. Create `src/engine/backends/<os>/<name>/`, or `src/engine/backends/<os>/` when the OS has one backend, with the four functions in `namespace relay::<name>`, using the signatures declared in `src/engine/server/backend.cpp`:

   ```cpp
   bool initializeNativeBackend(const std::string& output);
   std::unique_ptr<CaptureSource> makeCaptureSource();
   std::unique_ptr<InputBackend> makeInputBackend();
   std::unique_ptr<ClipboardBackend> makeClipboard(ClipboardChanged changed);
   ```

   Backend sources can be `.mm` files, compiled as Objective-C++ with ARC.

2. Add the backend name to `AVAILABLE_BACKENDS`, then add `BACKEND_DIR_<name>` and `BACKEND_PKGS_<name>` to the `Makefile`. The current values are `x11`, `wayland`, `windows`, and `macos`. Put system libraries that have no pkg-config file in `BACKEND_LIBS_<name>`.
3. Add a guarded entry to the `backends` array in `src/engine/server/backend.cpp`. The `Makefile` adds `-DRELAY_BACKEND_<name>` for each selected backend. The first compiled entry is the default, so keep X11 first when both backends are built.
4. Build with `make BACKENDS=<name>`. The default is `x11`; quote a space-separated list to build multiple backends, such as `make BACKENDS="x11 wayland"`.
5. For Wayland protocols, vendor their XML under `src/engine/backends/linux/wayland/protocols/` and add each protocol name to `WAYLAND_PROTOCOLS` in the `Makefile`. The Wayland build uses `wayland-scanner` to generate client headers and private protocol code under `build/protocols/`.
6. Implement capture, the input primitives, and the clipboard only: map a HID usage to a native key, press and release a native key or button, type a Unicode codepoint, move, scroll, reset locks, flush, `dimensions`, and `name`. Core owns protocol validation, coordinate mapping, held input, and the size limits. `src/engine/core/` and `src/engine/server/` must not include backend headers.

## How install works

`npm install -g screen-relay` installs the package, which ships `dist/`, `skills/`, `packages.tsv`, `Makefile`, and `src/engine/`. Installing the package runs no install script.

`screen-relay install` reads `packages.tsv` to pick the system packages for the machine's package manager. It then builds the engine with the package's `Makefile`, the same one a checkout uses, and stores the result in `~/.local/share/screen-relay/engine/<version>/`. `$XDG_DATA_HOME` is honored. The first `screen-relay up` on a machine runs the same setup.

`make deps` checks that the compiler and every library the engine links are present. `install` uses it to decide whether it has to install packages or can build right away. The CLI looks for `relay-engine` beside itself first, then in that data directory, then on `PATH`.

To try a local change end to end, build and pack the package, install the tarball globally, then set up and start a session:

```sh
npm run build
npm pack
npm install -g ./screen-relay-<version>.tgz
screen-relay install
screen-relay up -d
```

A global install is a copy of the package, so repeat these steps after each change.

## Build and test

The engine is C++17. Its shared pkg-config dependencies are `x264`, `libwebsockets` with TLS, and `zlib`. X11 adds `x11`, `xext`, `xdamage`, `xfixes`, and `xtst`; Wayland adds `wayland-client`, `xkbcommon`, and `wayland-scanner`. The engine does not link FFmpeg. `screen-relay install --backend` selects the compiled backends and installs matching packages; it accepts `x11`, `wayland`, or `all` and defaults to `x11`. `screen-relay install` and `screen-relay doctor` read the package names for each family from `packages.tsv`.

```sh
make                 # builds relay-engine
npm ci && npm run build   # dist/cli/relay.mjs, dist/sdk/, dist/viewer/ (Node 22 or newer)
make test            # native unit tests: color, flow, input, server, backend
npm test             # TypeScript unit tests
```

On Windows, build with [MSYS2](https://www.msys2.org/) in the UCRT64 environment, where `make` selects the `windows` backend:

```sh
pacman -S make diffutils mingw-w64-ucrt-x86_64-{gcc,pkgconf,libwebsockets,x264,ffmpeg}
make                 # builds relay-engine.exe
make test            # native unit tests: color, flow, input, server, backend
```

Desktop Duplication works only in the signed-in user's desktop session. Start `relay-engine.exe` from that session, not from an SSH or service session.

On macOS, install the packages with Homebrew. The `macos` backend builds by default:

```sh
brew install pkgconf x264 libwebsockets ffmpeg
make                 # builds relay-engine with the macos backend
make test
```

ffmpeg is only needed for `make test-backend`.

The build targets macOS 12.3, the first release with ScreenCaptureKit, and fails on a newer API that has no availability check. Grant **Screen Recording** and **Accessibility** under **Privacy & Security** to the app that starts the engine, such as your terminal. The engine must run in a logged-in user session.

`make test-backend` also needs the FFmpeg 7 development libraries (`libavcodec` ABI 61, `libavutil`, `libswscale`; no FFmpeg 8-only APIs) to decode the encoder output.

`make install` puts the engine and built viewer in `<prefix>/lib/relay/` and links `<prefix>/bin/relay-engine`.

[tests/README.md](tests/README.md) describes every test layer, including the smoke test and the viewer end-to-end test.

## Releasing

To cut a release, follow the "Releasing" section of [AGENTS.md](AGENTS.md).

## Conventions

- Write no code comments. A short docstring on a function, method, type, or module is the only exception.
- Never name other remote-desktop or streaming products in code, docs, commits, or PRs.
- Commit messages and PR descriptions say what changed and why, in plain words.
