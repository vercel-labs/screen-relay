# CLI reference

The published reference is at https://screen-relay.dev/docs/cli.

Run `screen-relay help` for root help, `screen-relay help <command>` for one command, and `screen-relay help --all --json` for every command's metadata. Help works offline.

## VM commands

Run these on the Linux, macOS or Windows machine that shows the desktop. `up`, `down` and `run` fail with `unsupported_platform` elsewhere.

```sh
screen-relay install [--backend x11|wayland|all|macos|windows] [--desktop xfce|none|COMMAND]
         [--config FILE] [--yes]
screen-relay up [-d] [--name NAME] [--config FILE] [--port PORT] [--desktop xfce|none|COMMAND]
         [--display DISPLAY] [--backend x11|wayland|macos|windows] [--output NAME|DISPLAY_ID]
         [--encoder ENCODER] [--public HTTPS_URL] [--allow-origin ORIGINS] [--ice-server URL]...
         [--tls-cert FILE --tls-key FILE] [--bind ADDRESS] [--timeout SECONDS] [--yes]
screen-relay down [--name NAME]
screen-relay logs [component] [--name NAME] [-f|--follow]
screen-relay run -- <app> [args]... [--name NAME] [--restart]
screen-relay doctor [--config FILE]
```

- `install` sets up the machine without starting a session. It installs the system packages for the backend and builds the engine. It is safe to repeat. When nothing is missing, it reports `unchanged`.
  - `--backend`: `x11`, `wayland` or `all` on Linux, `macos` on macOS, `windows` on Windows (the only value there). The default is `x11` on Linux and `macos` on macOS. The value also comes from `SCREEN_RELAY_BACKEND` and the config `backend` key. Adding a backend keeps the ones already set up.
  - `--desktop`: the same values as `up --desktop`. With `xfce` on x11, the XFCE packages are installed. With `none` or a command, they are skipped.
  - `--config FILE`: read `backend` and `desktop` from this file.
  - `--yes`, `-y`: install packages without asking. Required when there is no terminal.
  - JSON outcome: `installed` or `unchanged`, with the backends and the engine path under `install`.
- `up` starts a display (Xvfb on X11, or sway with XWayland on Wayland) or attaches to an existing one. On macOS it attaches to the logged-in user's display and starts no desktop. On Windows it attaches to the signed-in user's desktop and starts no virtual display or desktop. It then starts the desktop when enabled and the engine, waits until both are ready, and supervises the session. `--timeout` defaults to 30 seconds. The frame rate comes from `stream.fps`, 10 to 240, and defaults to 60.
  - Without `-d`, it runs in the foreground. The first Ctrl+C stops the session (exit 130). Piped, it prints only the viewer URL.
  - `--display DISPLAY`: attach to an X display (`:0`) or a Wayland socket (`wayland-1`). It keeps the caller's environment. A Wayland socket needs `XDG_RUNTIME_DIR`. macOS rejects it with `invalid_input`. Windows does not support it.
  - `--backend x11|wayland|macos|windows`: on Linux, defaults to `x11` when the engine has it, else `wayland`. A `--display` without a colon, such as `wayland-1`, selects `wayland` on its own. On macOS the only backend is `macos`, and on Windows it is `windows`. `x11` and `wayland` fail there with `invalid_input`, and `macos` fails on Linux the same way.
  - `--output NAME|DISPLAY_ID`: capture this Wayland output by name, a macOS display by its CGDirectDisplayID, or a Windows display such as `'\\.\DISPLAY2'`. `up` fails on x11.
  - `--encoder ENCODER`: `auto` probes for a hardware encoder, keeps it while it holds the frame budget set by `stream.fps`, and adapts back to `x264` when it fails or falls behind; `x264` uses software encoding only; any other name pins that encoder and falls back to `x264` only when it errors. Env: `SCREEN_RELAY_ENCODER`.
  - `--yes`: when setup is needed, set it up without asking. Without a terminal, `up` never prompts and fails with `missing_input` unless `--yes` is given.
  - `--public HTTPS_URL`: advertises an HTTPS origin without changing the listen address. Expects a TLS proxy unless `--tls-cert` is set. Browser pages must be served from this origin, a loopback page connecting to the same address, or an origin in `--allow-origin`.
  - `--allow-origin ORIGINS`: comma-separated exact origins whose browser pages may also connect: lowercase `https://HOST[:PORT]` for any host, or `http://localhost[:PORT]` and `http://127.0.0.1[:PORT]` for a page served on the machine itself. No wildcards. Creates a token. Env: `SCREEN_RELAY_ALLOW_ORIGIN`.
  - `--ice-server URL`: add a credential-free STUN, TURN, or TURNS server URL for WebRTC viewers; repeat up to 8 times. Set credential-bearing TURN URLs in `server.ice_servers` in `config.yaml` or `SCREEN_RELAY_ICE_SERVERS` (whitespace-separated).
  - `--bind ADDRESS`: listen address. Defaults to `127.0.0.1`, including with `--public`; another address generates a token.
  - Backend setup: [Wayland](wayland.md) and [macOS](macos.md).
- `down` stops the session and everything it started. On Windows, apps started with `run` keep running. It is safe to repeat. JSON outcome: `stopped` or `unchanged`.
- `logs` prints the last 200 lines of one component (`display`, `dbus`, `desktop`, `engine`, `apps`), or of every component log. `-f` follows; it cannot be combined with `--json`.
- `run` starts an app on the session desktop and returns its pid. The app shares the desktop's display, the available D-Bus session bus, runtime, config, cache and X authority settings, and it clears ambient capabilities. On Wayland it also sets `WAYLAND_DISPLAY`. On macOS it clears `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY`. `--restart` restarts the app until the session stops. Windows does not support `--restart`. App output goes to `screen-relay logs apps`.
- `doctor` checks the machine it runs on and prints a fix command for each problem. On macOS it checks `platform` (macOS 12.3 or later), `engine` and `permissions`. On Windows it checks the Windows version, MSYS2, the engine and whether it runs in a desktop session; the MSYS2 check fails when another account owns the installation or can write to it. Off Linux, macOS and Windows, the platform check fails. The backend comes from `SCREEN_RELAY_BACKEND`, then the config file's `backend` key (from `--config FILE` or the default config), then the engine's default. Use `SCREEN_RELAY_BACKEND=wayland screen-relay doctor` for a Wayland setup.

## Client commands

Run these on the VM, or on another machine with `--url` and a token file. Each one reaches the engine over HTTP.

```sh
screen-relay status [--name NAME] [--url URL] [--token-file FILE] [--timeout SECONDS] [--show-token]
screen-relay screenshot [file] [--url URL] [--token-file FILE] [--timeout SECONDS]
screen-relay click <x> <y> [--button left|middle|right]
screen-relay move <x> <y>
screen-relay scroll <x> <y> [--dx NUMBER] [--dy NUMBER]
screen-relay key <combo>...
screen-relay type <text>
screen-relay type --stdin
screen-relay input <json>
screen-relay input --stdin
screen-relay clipboard get
screen-relay clipboard set <text>
screen-relay clipboard set --stdin
```

- `status` with no URL reads the local session and exits 0 for any existing session. With `--url` (or `SCREEN_RELAY_URL`), it queries a remote engine. A missing session is `not_running`, exit 1.
- `status --json` puts the session under `session`. These fields name the display server:
  - `backend`: `x11`, `wayland`, `macos` or `windows`.
  - `waylandDisplay`: the Wayland socket, such as `wayland-1`. Wayland only.
  - `runtimeDir`: the runtime directory of the sway session. Wayland only, when screen-relay starts sway. `down` deletes it.
- `screenshot` writes `screen.png` by default. `-` writes PNG bytes to stdout (not with `--json`).
- `click` defaults to the left button. `move` only moves the pointer.
- `scroll` needs a nonzero `--dx` or `--dy`. `--dy` is vertical wheel notches, positive down. `--dx` is horizontal, positive right. Scrolling moves the pointer to the given point first.
- `key` presses each physical combo in order, for example `ctrl+l`, `Enter`, `alt+Tab` and `cmd+shift+t`.
- `type` sends text events. `--stdin` reads the text from standard input.
- `input` sends a JSON array of 1 to 256 SDK input events, for example `screen-relay input '[{"type":"keyDown","key":4},{"type":"keyUp","key":4}]'`.
- `clipboard get` prints the desktop's clipboard text exactly, with no newline added. `clipboard set` replaces it; `set ""` clears it. Text is UTF-8, up to 256 KiB. It works while another client owns input. `set` does not paste: press `ctrl+v` (`super+v` on macOS) afterward. A desktop without a usable clipboard returns `clipboard_unavailable`.

## Skills

```sh
screen-relay skills list
screen-relay skills get <name> [--full] [--json]
screen-relay skills path [name]
```

`list` is the default and leaves out hidden skills. `get` prints a skill workflow, including a hidden one asked for by name. `--full` appends its `references/` and `templates/`. `path` prints the skills directory or one skill's directory. An unknown skill is `not_found` (exit 1).

## Global options

At any position: `-h`/`--help`, `-v`/`--version` (prints only the version), `--json`, `--no-color`, `--name NAME`. `--` ends option parsing. Booleans accept `--no-<name>`. Short options are only `-h`, `-v`, `-f`, `-d` (`up -d`) and `-y` (`install -y`).

## Output

Queries print data on stdout. Mutations write receipts and next steps on stderr. Piped, `up` prints the viewer URL, `screenshot` prints the saved path, and input commands print nothing. Receipts use `✓`, `!` and `✗` on a TTY, and plain words otherwise.

With `--json`, success is one document on stdout, with a trailing newline, and stderr stays empty. It is pretty-printed with two spaces on a TTY and compact otherwise. Failure is one compact document on stderr, and stdout stays empty. A failure document's `next` is optional. `next[].command` is the full command line, and `next[].argv` is the same command split, starting with `screen-relay`. Success may also carry `warnings: [{reason, message}]` and `next`.

| Command | Shape |
| --- | --- |
| `screen-relay up -d --json` | `{"session":{...},"outcome":"started"}` |
| `screen-relay down --json` | `{"session":{...},"outcome":"stopped"}` or `"unchanged"` |
| `screen-relay install --json` | `{"install":{"backends":["x11"],"engine":"..."},"outcome":"installed"}` or `"unchanged"` |
| `screen-relay status --json` | `{"session":{...}}` |
| `screen-relay screenshot file.png --json` | `{"screenshot":{"path","width","height","bytes"},"outcome":"saved"}` |
| `screen-relay click`, `move`, `scroll`, `key`, `type`, `input` | `{"input":{"events":N},"outcome":"sent"}` |
| `screen-relay clipboard get --json` | `{"clipboard":{"text":"...","bytes":N}}` |
| `screen-relay clipboard set TEXT --json` | `{"clipboard":{"bytes":N},"outcome":"set"}` |
| `screen-relay run -- APP --json` | `{"app":{"pid":N,"command":["APP"]},"outcome":"started"}` |
| `screen-relay logs engine --json` | `{"logs":{"engine":"..."}}` |
| `screen-relay doctor --json` | `{"checks":[...],"summary":{"ok","passed","warnings","failed"}}` |
| `screen-relay skills list --json` | `{"skills":[{"name","description"}]}` |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, including `status` of any existing session. |
| 1 | Runtime, network, permission, config or missing-session failure. |
| 2 | Usage error, invalid value or missing input. |
| 130 | Interrupted with Ctrl+C. |
| 128+n | Terminated by signal n. |

## Client target

Client commands take `--url`, `--token-file` and `--timeout` (seconds, default 10). The target is `--url`, else `SCREEN_RELAY_URL`, else the ready local session named by `--name`, else `http://127.0.0.1:8080` when no session was explicitly selected. A URL is an origin only. Plain HTTP is allowed only for `localhost` and `127.0.0.1`. Remote hosts need HTTPS and a 64-character lowercase hex token. Redirects are refused.

Connection failures name the cause in the message: `Connection refused.`, `The host name did not resolve.`, `The request timed out.` or `The TLS certificate was rejected.`
