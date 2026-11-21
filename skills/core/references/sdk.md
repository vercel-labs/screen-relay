# Node SDK

A script needs the package as a local dependency in its project. The global install (`npm install -g screen-relay`) provides only the CLI.

```sh
npm install screen-relay
```

```js
import { createClient, connect, RelayError } from 'screen-relay';
```

## Options

`createClient(options)` and `connect(options)` take the same options.

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | `http://127.0.0.1:8080` | Engine origin. |
| `token` | none | The 64-character session token. Required for a remote host. Read it with `screen-relay status --show-token --json`. |
| `timeout` | `10000` | Milliseconds. The CLI's `--timeout` is in seconds (default 10), so `--timeout 10` is `timeout: 10000`. |

## createClient

`createClient(options)` returns a client. Each call sends its own request. Coordinates are fractions of the screen from 0 to 1, the same as the CLI.

```ts
status(): Promise<Status>                          // engine metrics, not the CLI's session record
capabilities(): Promise<Capabilities>
screenshot(): Promise<Uint8Array>                  // PNG bytes
click(x, y, { button?: 'left' | 'middle' | 'right' })
move(x, y)
scroll(x, y, { dx?, dy? })
key(...combos)
type(text)
input(events)                                      // raw SDK input events
clipboard(): Promise<string>                       // clipboard text, '' when it holds no text
setClipboard(text): Promise<void>                  // UTF-8, up to 256 KiB; '' clears it
```

`Capabilities` includes `encoder` (the active encoder's name), `hardware_encoder`, `encoder_state`, `rtc` (whether WebRTC is available), `ice_servers` (how many are configured), and `transfer_tier` (`zero_copy`, `dirty_upload`, `full_upload`, or `software`). `auto` keeps a hardware encoder while it holds the frame budget and adapts back to `x264` when it fails or falls behind, so `encoder` can change during a session.

## connect

`connect(options)` opens a control session that owns input until `close()`.

```ts
surface: { width, height }
capabilities(): Promise<Capabilities>
status(): Promise<Status>
screenshot(path?): Promise<Uint8Array>             // writes a file when path is set
input(event): Promise<void>                        // one raw SDK input event
close(): void
```

Only one controller sends input at a time. A control session can run while a viewer watches. A viewer that chooses **Take control** ends the session. Pending and future input and future `session.screenshot()` calls fail with `control_taken`. `session.capabilities()` and `session.status()` still make independent HTTP requests. See [One controller](../SKILL.md#one-controller).

## Errors

Failures throw `RelayError`. Its `reason` is one of the reasons the CLI reports. See [Reasons and recovery](../SKILL.md#reasons-and-recovery).

## Example

```js
import { writeFile } from 'node:fs/promises';
import { createClient } from 'screen-relay';

const client = createClient();
await writeFile('screen.png', await client.screenshot());
await client.click(0.5, 0.5);
await client.type('echo hello');
await client.key('Enter');
```
