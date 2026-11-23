---
name: core
description: Control a screen-relay desktop from an agent using screenshots and input commands.
allowed-tools: Bash(screen-relay:*)
---

# screen-relay core workflow

screen-relay streams a desktop to a browser viewer and gives you CLI control. Run it on the Linux, macOS or Windows machine that shows the desktop. Node 22 or newer is required.

## Set up

```sh
npm install -g screen-relay
screen-relay install --yes
screen-relay up -d
```

- `npm install -g screen-relay` installs the CLI, the Node SDK, the viewer, the agent skills and the engine source. It runs no install script and installs no system packages. Client commands work at once with `--url` and a token file.
- `screen-relay install --yes` installs the system packages and builds the engine. On a fresh machine it can take several minutes. Run it with a long command timeout or in the background, and wait for it to exit before `up`. It is safe to repeat. With `--json` it prints nothing until it finishes. A failed step returns one JSON error with the command and the end of its output.
- `up` runs setup when the machine is not set up. You have no terminal, so pass `--yes`.
- `install --backend wayland --yes` sets up sway, XWayland and foot. `--desktop none` skips the XFCE packages on x11. `up -d --yes` runs setup and starts the session in one command.
- After an upgrade, the next `up` rebuilds the engine. That needs no `sudo`.
- Linux: automatic setup supports Debian, Ubuntu, Fedora, Arch Linux and Alpine on x64 and arm64. It needs root or passwordless `sudo`. On another distribution, install the build tools and libraries yourself, then run `screen-relay install`.
- macOS: setup needs Homebrew and the Xcode Command Line Tools. See [macOS](references/macos.md).
- Windows: setup needs Windows 10 or later on x64. When `C:\msys64` is absent, setup creates the folder with its access rules and installs MSYS2 with winget. It uses an existing folder only when the owner and write rules of every file and directory in it pass its check. It does not change the access rules of an existing installation, only adds packages with pacman; if the check fails, delete `C:\msys64` without running any program from it, including its uninstaller, and run `screen-relay install` again. Without winget, install App Installer; a manual MSYS2 installation must already have the access rules. Run the commands in a terminal on the signed-in user's desktop. `up` over SSH or from a service session fails with `No display is attached to this session` or `Desktop Duplication is unavailable`. See [Windows](https://screen-relay.dev/docs/windows).

## Pick a backend

| Platform | Backend | Start |
| --- | --- | --- |
| macOS | `macos`: streams the logged-in user's display. Starts no virtual display or desktop. | `screen-relay up -d` |
| Windows | `windows`: streams the signed-in user's desktop. Starts no virtual display or desktop. | `screen-relay up -d` |
| Linux | `x11`: a virtual display with XFCE. | `screen-relay up -d` |
| Linux | `wayland`: a headless sway desktop with foot. | `screen-relay up -d --backend wayland` |
| Linux | Attach to a compositor you already run. | `screen-relay up -d --backend wayland --display "$WAYLAND_DISPLAY"` |

- On Linux, `up` uses `x11` when the engine has it, else `wayland`.
- Precedence: `--backend`, then `SCREEN_RELAY_BACKEND`, then the config `backend` key, then the default above.
- Set up a backend before you use it, for example `screen-relay install --backend wayland --yes`.
- To switch backends, run `screen-relay down` first. While a session with that name runs, `up` fails with `already_running`.
- To attach, run the command from a terminal inside that session. `--display` takes an X display such as `:0` on x11, or a Wayland socket such as `wayland-1` on wayland. A `--display` without a colon selects wayland. Attach mode uses the display's size and starts no desktop. Compositor setup and limits: [Wayland](references/wayland.md).

## Where commands run

- VM commands (`install`, `up`, `down`, `logs`, `run`, `doctor`) run on the Linux, macOS or Windows machine that shows the desktop. `up`, `down` and `run` fail with `unsupported_platform` elsewhere.
- Client commands (`status`, `screenshot`, `click`, `move`, `scroll`, `key`, `type`, `input`) reach the engine through the local session, or from another machine with `--url` and a token file (`--token-file` or `SCREEN_RELAY_TOKEN_FILE`). See [Client target](references/cli.md#client-target).
- `skills` and `help` work anywhere and never contact an engine.
- A script can use the Node SDK instead of the CLI. See [Node SDK](references/sdk.md).

## Start a session

```sh
screen-relay up -d
screen-relay status --json
```

- `up -d` returns when the display, desktop and engine are ready. Piped, it prints the viewer URL, with the `#token=` fragment when the session has a token. Treat that URL as a secret.
- `status --json` prints `{"session": {...}}`. Read `session.state` (`starting`, `ready`, `stopped`, `failed`), `session.running`, `session.url` and `session.display`.
- An existing session exits 0 in any state. A missing session exits 1 with `not_running`.

## Control loop

Take a screenshot, decide from the image, act, then take another screenshot to verify. This run opens a terminal, types, and checks the result. On Wayland, use `foot` in place of `xfce4-terminal`. On macOS, use `screen-relay run -- open -a Terminal`.

```sh
screen-relay up -d
screen-relay run -- xfce4-terminal
sleep 1
screen-relay screenshot /tmp/relay.png
screen-relay click 0.5 0.5
screen-relay type "echo hello"
screen-relay key Enter
screen-relay screenshot /tmp/relay-after.png
```

- `run` returns the app's pid at once. The window appears a moment later, so poll `screenshot` until you see it. Read app output with `screen-relay logs apps`. `screen-relay down` stops apps.
- A saved screenshot means the engine captured the frame. Applied input means the engine applied the events. Neither means the app reacted, so check the next screenshot.
- Click a window before you type into it. A click also moves the pointer.
- Read values by looking at the screenshot. `--json` reports geometry and sizes, not text:

```json
{"screenshot":{"path":"/tmp/relay.png","width":1920,"height":1080,"bytes":48213},"outcome":"saved"}
```

Scroll with `screen-relay scroll 0.5 0.5 --dy 5`, then take a screenshot. For `--dx` and `--dy`, see [CLI](references/cli.md#client-commands).

## Coordinates

Coordinates are fractions from `0` to `1`, measured from the top-left.

```text
x = pixel_x / image_width
y = pixel_y / image_height
```

For a 1920x1080 screenshot, pixel `480,810` is `screen-relay click 0.25 0.75`, and the center is `screen-relay click 0.5 0.5`. Get the image size from `screen-relay screenshot file.png --json`, or from the image.

## type versus key

- `screen-relay type <text>` sends layout-neutral text events, one per Unicode scalar value. The remote keyboard layout decides each character, so accents, symbols and non-US layouts work. Use it for text.
- `screen-relay key <combo>...` sends physical key combinations, in order, such as `ctrl+l`, `alt+Tab`, `cmd+shift+t` and `Enter`. Use it for shortcuts, arrows, function keys and Escape. Modifiers are `ctrl`, `shift`, `alt` and `super`. `cmd`, `meta` and `win` alias `super`.
- To enter a long text, or text the layout cannot type, put it on the clipboard and paste it: `screen-relay clipboard set --stdin < file.txt`, then `screen-relay key ctrl+v` (`super+v` on macOS). To read text an app copied, run `screen-relay clipboard get`.
- A long `type` is sent in batches of at most 256 events. On failure, `data.applied` is the number of events the engine confirmed.
  - If the engine answered (`busy`, `invalid_input`, `unsupported_input`), resend only the rest of the text.
  - If the reply was lost (`timeout`, `unreachable`, `disconnected`), the last batch may already be on screen. Take a screenshot before you resend anything.

## JSON

Add `--json` to any command. Success writes one document to stdout and leaves stderr empty. Output shapes: [CLI output](references/cli.md#output).

On failure, stdout is empty and stderr has one compact document:

```json
{"status":"error","reason":"busy","message":"Another controller holds control of the desktop.","data":{"httpStatus":409}}
{"status":"action_required","reason":"invalid_input","message":"Invalid x: '2'.","next":[{"command":"screen-relay help click","argv":["screen-relay","help","click"]}]}
```

- `status` is `action_required` when the command stopped before any effect and input would let it run. Otherwise it is `error`.
- Match `reason`, not `message`. `reason` is a stable snake_case code.
- When `next` is present, run `next[0].command`.
- `data` holds context: `component` and `logs` after a component failure, `applied` after a partial input batch, `httpStatus` from the engine.

Exit codes: [CLI exit codes](references/cli.md#exit-codes).

## Reasons and recovery

| Reason | Meaning | Recovery |
| --- | --- | --- |
| `busy` | Another controller holds input, or a screenshot is already running. | See [One controller](#one-controller). Screenshots still work. |
| `unauthorized` | Missing or wrong token. | Pass `--token-file FILE` or set `SCREEN_RELAY_TOKEN_FILE`. Or open the `#token=` viewer link. |
| `forbidden` | The engine rejected `Host` or `Origin`. | Use the `--public` URL or a loopback page whose origin matches the address it connects to. For a browser page on another origin, restart with `--allow-origin`. |
| `unreachable` | Cannot connect: `Connection refused.`, `The host name did not resolve.` or `The TLS certificate was rejected.` | Check the address, then `screen-relay status --url <URL>`. |
| `timeout` | No reply within `--timeout`, or `up` was not ready in time. | Raise `--timeout`. For `up`, read the component log. |
| `not_running` | No session or logs with that name. | `screen-relay up -d`. |
| `not_found` | No running session for `run` or a skill, or an unknown engine endpoint. | Start the session, or run `screen-relay skills list`. |
| `already_running` | A session with that name is running. | `screen-relay down --name N`, or pick another name and port. |
| `component_failed` | The display, desktop, engine, supervisor or an app exited. `data.component` and `data.logs` are set. | `screen-relay logs <component>`. |
| `missing_dependency` | A host program or the engine binary is missing. | `screen-relay install --yes`, with `--backend wayland` for Wayland. Or `screen-relay doctor`. |
| `missing_input` | `up` needs setup and has no terminal to ask (exit 2). | `screen-relay install --yes`, then `screen-relay up -d`. Or `screen-relay up -d --yes`. |
| `missing_command` | `run` was given no app (exit 2). | `screen-relay run -- APP`. |
| `spawn_failed` | `run` could not start the app. | Check the app name and `screen-relay logs apps`. |
| `unsupported_input` | The backend cannot produce a character or apply the input. | Use `screen-relay type` for layout-neutral text. |
| `clipboard_unavailable` | The desktop has no clipboard the engine can use, or the app that owns it did not answer. | Use `screen-relay type` instead. `status --json` shows `capabilities.clipboard`. |
| `unsupported_platform` | `up`, `down` or `run` ran on a platform other than Linux, macOS or Windows. | Run host commands on the Linux, macOS or Windows machine that shows the desktop. |
| `invalid_config` | A config key or value is invalid. The message names the file and key. | Fix the file and start again. |
| `invalid_input`, `invalid_option`, `unknown_command` | Usage error (exit 2). | Read the `next` command, usually `screen-relay help <command>`. |
| `internal` | A bug in screen-relay. | Report it with the command you ran. |

## One controller

Only one controller sends input at a time. A viewer claims idle input when it opens. If you hold an SDK control session, the viewer opens view-only. Choose **Release control** in a viewer that owns input before sending input with the CLI. A second controller gets `busy` with the message `Another controller holds control of the desktop.`, and nothing is applied. Screenshots, `status` and `capabilities` keep working. Do not retry in a loop. Wait for the other controller to release control or close, then retry once.

A person can open the viewer while you hold an SDK control session, and choose **Take control** at any time. Pending and future input and future `session.screenshot()` calls fail with `control_taken`. `session.capabilities()` and `session.status()` still use HTTP. Connect again only after the person releases control.

## Config

Keys, defaults, file location and precedence: [config](references/config.md).

## Troubleshooting

- Run `screen-relay doctor` first. It prints a fix command for each failing check. For Wayland, run `SCREEN_RELAY_BACKEND=wayland screen-relay doctor`.
- `screen-relay logs` prints the last 200 lines of every component log. `screen-relay logs <component>` selects one: `display`, `dbus`, `desktop`, `engine` or `apps`. Add `-f` to follow.
- For symptoms and fixes, see [troubleshooting](references/troubleshooting.md).

## References

- `references/cli.md`: commands, options, output and exit codes.
- `references/config.md`: config keys, defaults and precedence.
- `references/sdk.md`: the Node SDK for scripts.
- `references/wayland.md`: Wayland compositors, attach mode and limits.
- `references/macos.md`: macOS install, permissions, display choice and limits.
- `references/troubleshooting.md`: symptoms and fixes.
- `screen-relay skills get vercel-sandbox`: run screen-relay in a Vercel Sandbox.
- https://screen-relay.dev/docs: the published documentation.
