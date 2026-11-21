# Configuration

The published reference is at https://screen-relay.dev/docs/configuration.

Precedence, highest first:

1. Flag.
2. `SCREEN_RELAY_*` environment variable.
3. Config file.
4. Default.

`screen-relay up` reads `--config FILE`, then `SCREEN_RELAY_CONFIG`, then `${XDG_CONFIG_HOME:-~/.config}/screen-relay/config.yaml` when it exists. `screen-relay install --config FILE` reads `backend` and `desktop` from that file. A missing explicitly selected file, an unknown key, an invalid type or an out-of-range value stops startup before any process starts. Every problem is reported at once.

| Key | Default | Range or meaning | Environment |
| --- | --- | --- | --- |
| `display.resolution` | `1280x720` | `WIDTHxHEIGHT`; even width `320..16384`, even height `240..16384` | `SCREEN_RELAY_RESOLUTION` |
| `display.compositor` | `auto` | `auto`, `on` or `off`, for the XFCE desktop screen-relay starts; `auto` turns the compositor off when `stream.fps` is above 60 | `SCREEN_RELAY_COMPOSITOR` |
| `stream.fps` | `60` | `10..240` | `SCREEN_RELAY_FPS` |
| `stream.encoder` | `auto` | `auto` probes for a hardware encoder, keeps it while it holds the frame budget set by `stream.fps`, and adapts back to x264 when it fails or falls behind; `x264` uses software; any other name pins that hardware encoder, such as `h264_videotoolbox`, and falls back to x264 only on error. Use letters, digits and `_`. | `SCREEN_RELAY_ENCODER` |
| `stream.bitrate.min` | `1M` | Bits per second, `250000..100000000`; a `k` or `M` suffix is 1000-based | `SCREEN_RELAY_BITRATE_MIN` |
| `stream.bitrate.start` | `8M` | As above | `SCREEN_RELAY_BITRATE_START` |
| `stream.bitrate.max` | `40M` | As above; require min <= start <= max | `SCREEN_RELAY_BITRATE_MAX` |
| `server.port` | `8080` | `1..65535` | `SCREEN_RELAY_PORT` |
| `server.bind` | `127.0.0.1` | Listen address | `SCREEN_RELAY_BIND` |
| `server.public` | none | HTTPS origin without a path, query or credentials | `SCREEN_RELAY_PUBLIC` |
| `server.allow_origin` | none | Up to 16 comma-separated exact origins for browser WebSocket connections. Use lowercase HTTPS origins or HTTP origins on `localhost` and `127.0.0.1`. Requires a token. | `SCREEN_RELAY_ALLOW_ORIGIN` |
| `server.tls_cert` | none | Certificate file; `server.tls_key` must be set too | `SCREEN_RELAY_TLS_CERT` |
| `server.tls_key` | none | Private key file | `SCREEN_RELAY_TLS_KEY` |
| `server.ice_servers` | none | Up to 8 STUN, TURN or TURNS server URLs for WebRTC viewers, as a YAML list | `SCREEN_RELAY_ICE_SERVERS`, whitespace-separated |
| `keyboard.layout` | `us` | Comma-separated XKB layout such as `fr,us` | `SCREEN_RELAY_KEYBOARD_LAYOUT` |
| `backend` | Linux: `x11` when the engine has it, else `wayland`. macOS: `macos`. Windows: `windows` | `x11`, `wayland`, `macos` or `windows`; `--backend` overrides it | `SCREEN_RELAY_BACKEND` |
| `desktop` | `xfce` (x11) or `foot` (wayland) | `xfce`, `none`, or a desktop command; defaults to `none` with `--display`; ignored on macOS and Windows, which start no desktop | `SCREEN_RELAY_DESKTOP` |

Example:

```yaml
display:
  resolution: 1600x900
stream:
  fps: 30
  bitrate:
    min: 1M
    start: 8M
    max: 40M
server:
  port: 8080
keyboard:
  layout: us
```

There is no live reload or resize. Run `screen-relay down`, edit the file, then run `screen-relay up -d`. With `--display`, `display.resolution` is ignored and `up` uses the existing display's size, with a warning. macOS ignores `display.resolution` the same way. Client commands use `SCREEN_RELAY_URL` and `SCREEN_RELAY_TOKEN_FILE` instead of the config file.
